const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// 读取配置文件
const configPath = path.join(__dirname, 'config.json');
let config = {
    targetUrls: [],
    history: [],
    cookie: ''
};

if (fs.existsSync(configPath)) {
    try {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        const userConfig = JSON.parse(fileContent);
        config = { ...config, ...userConfig };
        console.log('Loaded config from config.json');
    } catch (e) {
        console.error('Failed to parse config.json:', e.message);
    }
}

if (!config.targetUrls || config.targetUrls.length === 0) {
    console.log('No target URLs found in config.json');
    process.exit(0);
}

const targetUrl = config.targetUrls[0];
const COOKIE = config.cookie;
const baseDir = '/Users/wolffy/Desktop/personal/doubaoimage/images';

// 获取 targetUrl 的最后一项作为目录名
function getUrlSlug(url) {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        // 移除末尾的斜杠（如果有）
        const cleanPath = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
        // 获取最后一部分
        const slug = cleanPath.split('/').pop();
        return slug || 'unknown';
    } catch (e) {
        return 'unknown';
    }
}

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
    const slug = getUrlSlug(targetUrl);
    console.log(`Saving images to directory: ${slug}`);
    const saveDir = path.join(baseDir, slug);
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

    // 提取指定容器内的图片 src
    const imageUrls = await page.evaluate(() => {
        // 根据用户指示，查找 data-testid="send_message" 下的图片
        const containers = Array.from(document.querySelectorAll('[data-testid="send_message"]'));
        // 同时也尝试查找包含 message 的 data-testid，以防万一
        // const containers = Array.from(document.querySelectorAll('[data-testid*="message"]')); 
        
        console.log(`Found ${containers.length} containers with data-testid="send_message"`);
        
        const images = [];
        containers.forEach(container => {
            const imgs = Array.from(container.querySelectorAll('img'));
            images.push(...imgs);
        });

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

    // 更新配置文件
    if (config.targetUrls && config.targetUrls.length > 0) {
        const processedUrl = config.targetUrls.shift();
        if (!config.history) config.history = [];
        config.history.push({
            url: processedUrl,
            timestamp: new Date().toISOString()
        });

        try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
            console.log('Updated config.json: moved URL to history.');
        } catch (e) {
            console.error('Failed to update config.json:', e.message);
        }
    }
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
