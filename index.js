const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const targetUrl = 'https://www.doubao.com/thread/wd309c3f94053d863';
const baseDir = '/Users/wolffy/Desktop/personal/doubaoimage/images';

// !!! 重要：请在此处填入您的 Cookie !!!
// 1. 在浏览器登录 Doubao 并打开该页面
// 2. 按 F12 打开开发者工具 -> 网络(Network)
// 3. 刷新页面，点击第一个请求
// 4. 复制 "Request Headers" 中的 "cookie" 值粘贴到下面
const COOKIE = ''; 

// 获取当前日期 YYYY-MM-DD
function getTodayDate() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 下载函数
async function downloadImage(url, filepath) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode === 200) {
                const fileStream = fs.createWriteStream(filepath);
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve(filepath);
                });
                fileStream.on('error', (err) => {
                    fs.unlink(filepath, () => {}); // 删除未完成的文件
                    reject(err);
                });
            } else {
                res.resume();
                reject(new Error(`Request Failed With a Status Code: ${res.statusCode}`));
            }
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// 保存 Base64 图片
function saveBase64Image(base64Str, filepath) {
    const matches = base64Str.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
        return false;
    }
    const buffer = Buffer.from(matches[2], 'base64');
    fs.writeFileSync(filepath, buffer);
    return true;
}

(async () => {
    // 确保目录存在
    const today = getTodayDate();
    const saveDir = path.join(baseDir, today);
    if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
    }

    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    // 设置视口大小
    await page.setViewport({ width: 1280, height: 1024 });

    // 设置 Cookie 和 User-Agent
    if (COOKIE) {
        const cookieList = COOKIE.split(';').map(c => {
            const [name, ...v] = c.trim().split('=');
            return { name, value: v.join('='), domain: '.doubao.com' };
        });
        await page.setCookie(...cookieList);
        console.log(`Set ${cookieList.length} cookies.`);
    }

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log(`Navigating to ${targetUrl}...`);
    try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
        console.error('Navigation timeout or error:', e.message);
    }

    // 自动滚动以加载图片
    console.log('Scrolling page...');
    await autoScroll(page);

    // 等待一会儿确保最后的懒加载完成
    await new Promise(r => setTimeout(r, 2000));

    // 提取所有图片 src
    const imageUrls = await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('img'));
        return images.map(img => ({
            src: img.src,
            width: img.naturalWidth,
            height: img.naturalHeight,
            alt: img.alt
        }));
    });

    console.log(`Found ${imageUrls.length} potential images.`);

    // 过滤和去重
    const uniqueUrls = new Set();
    const downloadTasks = [];

    let count = 0;
    for (const img of imageUrls) {
        const url = img.src;
        if (!url || uniqueUrls.has(url)) continue;

        // 简单的过滤逻辑：
        // 1. 忽略极小的图标 (例如小于 50x50)
        if (img.width > 0 && img.width < 50 && img.height > 0 && img.height < 50) continue;
        
        uniqueUrls.add(url);

        const isBase64 = url.startsWith('data:image');
        let ext = '.jpg';
        
        if (isBase64) {
             const match = url.match(/^data:image\/(\w+);base64,/);
             if (match) ext = `.${match[1]}`;
        } else {
            try {
                const urlObj = new URL(url);
                const pathname = urlObj.pathname;
                const urlExt = path.extname(pathname);
                if (urlExt) ext = urlExt;
            } catch (e) {}
        }

        // 规范化扩展名
        if (ext === '.jpeg') ext = '.jpg';
        // 如果扩展名太长或非法，重置为 .jpg
        if (ext.length > 5 || /[^a-z0-9.]/i.test(ext)) ext = '.jpg';

        const filename = `img_${Date.now()}_${count}${ext}`;
        const filepath = path.join(saveDir, filename);

        if (isBase64) {
            console.log(`Saving Base64 image (${count + 1})...`);
            saveBase64Image(url, filepath);
            count++;
        } else if (url.startsWith('http')) {
            console.log(`Downloading (${count + 1}): ${url}`);
            // 串行下载避免并发过高被封，或者可以使用 Promise.all 并发下载
            try {
                await downloadImage(url, filepath);
                count++;
            } catch (err) {
                console.error(`Failed to download ${url}: ${err.message}`);
            }
        }
    }

    console.log(`Success! Saved ${count} images to ${saveDir}`);

    await browser.close();
})();

async function autoScroll(page){
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            var totalHeight = 0;
            var distance = 100;
            var maxScrolls = 200; // 防止死循环，限制滚动次数
            var scrolls = 0;

            var timer = setInterval(() => {
                var scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                scrolls++;

                if((totalHeight >= scrollHeight - window.innerHeight) || scrolls >= maxScrolls){
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}
