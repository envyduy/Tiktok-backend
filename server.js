import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import dotenv from 'dotenv';

// --- STEALTH SETUP ---
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

// Kích hoạt chế độ tàng hình
chromium.use(stealthPlugin());

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONSTANTS ---
const HISTORY_FILE = 'tiktok_view_history.json';
const WATCHED_USERS_FILE = 'watched_users.json';
const MAX_VIDEOS_TO_SCRAPE = 200; // MỤC TIÊU: 200 VIDEO

// User Agent mới nhất để tránh bị phát hiện cũ
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json());

// --- UTILS ---
const formatViewCount = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
};

const loadJson = (filename) => {
    if (fs.existsSync(filename)) {
        try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (e) { return {}; }
    }
    return {};
};

const saveJson = (filename, data) => {
    try { fs.writeFileSync(filename, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
};

const addToWatchedUsers = (username) => {
    const users = loadJson(WATCHED_USERS_FILE);
    if (!Array.isArray(users.list)) users.list = [];
    if (!users.list.includes(username)) {
        users.list.push(username);
        saveJson(WATCHED_USERS_FILE, users);
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- BROWSER MANAGER ---
let browser = null;

async function getBrowser() {
    if (browser) return browser;
    console.log('[System] Khởi động Browser...');
    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled', // Che giấu bot tốt hơn
        ]
    });
    return browser;
}

// --- SCRAPER LOGIC (Advanced Search Flow with Scrolling) ---

async function fetchVideosFromCountik(username) {
    const browserInstance = await getBrowser();
    const context = await browserInstance.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        deviceScaleFactor: 1,
    });
    
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    
    // Sử dụng Map để tự động loại bỏ video trùng lặp dựa trên ID
    const collectedVideos = new Map();

    try {
        console.log(`[Scraper] Truy cập Countik (Search Mode) cho @${username}...`);

        // Lắng nghe response mạng
        page.on('response', async (response) => {
            const url = response.url();
            // Lọc rộng hơn để bắt dính API
            if (response.status() === 200 && (url.includes('/api/user/posts') || url.includes('/api/user/videos') || url.includes('countik.com/api/'))) {
                try {
                    const json = await response.json();
                    const list = json.posts || json.list || json.videos || json.data?.posts;
                    
                    if (Array.isArray(list) && list.length > 0) {
                        let newCount = 0;
                        list.forEach(v => {
                            const id = v.id || v.video_id;
                            if (id && !collectedVideos.has(id)) {
                                collectedVideos.set(id, v);
                                newCount++;
                            }
                        });
                        if (newCount > 0) {
                            console.log(`[Scraper] +${newCount} video mới (Tổng: ${collectedVideos.size})`);
                        }
                    }
                } catch (e) { /* ignore non-json */ }
            }
        });

        // 1. Vào trang chủ
        await page.goto('https://countik.com/tiktok-analytics', { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        // 2. Tìm ô input và nhập username
        const inputSelector = 'input[placeholder*="username" i], input[placeholder*="Enter TikTok" i]';
        try {
            await page.waitForSelector(inputSelector, { timeout: 10000 });
            await page.fill(inputSelector, username);
            await sleep(1000);
            await page.keyboard.press('Enter');
        } catch (inputError) {
            console.log('[Scraper] Không tìm thấy ô search, thử vào thẳng link...');
            await page.goto(`https://countik.com/tiktok-analytics/user/${username}`, { waitUntil: 'domcontentloaded' });
        }

        // 3. Chờ dữ liệu ban đầu
        let attempts = 0;
        while (collectedVideos.size === 0 && attempts < 15) {
            await sleep(1000);
            attempts++;
            if (attempts % 5 === 0) console.log(`[Scraper] Đang chờ dữ liệu ban đầu... ${attempts}s`);
        }

        if (collectedVideos.size === 0) {
            throw new Error("Không tìm thấy dữ liệu ban đầu.");
        }

        // 4. SCROLL LOOP - Cuộn để lấy thêm video
        console.log(`[Scraper] Bắt đầu cuộn để lấy đủ ${MAX_VIDEOS_TO_SCRAPE} video...`);
        let noChangeCount = 0;
        let lastSize = 0;
        const maxScrollAttempts = 30; // Giới hạn số lần cuộn để tránh vô tận

        for (let i = 0; i < maxScrollAttempts; i++) {
            if (collectedVideos.size >= MAX_VIDEOS_TO_SCRAPE) {
                console.log('[Scraper] Đã đạt đủ số lượng video yêu cầu.');
                break;
            }

            // Cuộn xuống cuối trang
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            
            // Chờ load dữ liệu (2 giây)
            await sleep(2000);

            // Kiểm tra xem có video mới không
            if (collectedVideos.size === lastSize) {
                noChangeCount++;
                // Thử cuộn lên một chút rồi cuộn xuống lại để kích hoạt event
                await page.mouse.wheel(0, -500);
                await sleep(500);
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            } else {
                noChangeCount = 0; // Reset nếu có dữ liệu mới
                lastSize = collectedVideos.size;
            }

            // Nếu 4 lần liên tiếp không có video mới -> Đã hết video
            if (noChangeCount >= 4) {
                console.log('[Scraper] Không tìm thấy thêm video mới sau nhiều lần cuộn.');
                break;
            }
        }

    } catch (e) {
        console.error(`[Scraper] Lỗi khi xử lý: ${e.message}`);
    } finally {
        await context.close();
    }

    if (collectedVideos.size === 0) {
        throw new Error("Không lấy được dữ liệu. Server bận hoặc chặn IP.");
    }

    // Chuẩn hóa dữ liệu
    const videos = Array.from(collectedVideos.values()).map(v => {
        const playCount = v.play_count || v.plays || 0;
        return {
            id: v.id || v.video_id,
            url: `https://www.tiktok.com/@${username}/video/${v.id || v.video_id}`,
            cover: v.cover || v.origin_cover || v.thumbnail_url,
            views: formatViewCount(playCount),
            numericViews: playCount,
            // Thêm timestamp để sort nếu có
            createTime: v.create_time || 0 
        };
    });

    // Sắp xếp theo thời gian mới nhất (nếu API trả về có create_time, thường là có)
    // Nếu không có create_time, danh sách thường đã theo thứ tự rồi.
    videos.sort((a, b) => b.createTime - a.createTime);

    // Cắt đúng 200 video (hoặc ít hơn nếu không đủ)
    return videos.slice(0, MAX_VIDEOS_TO_SCRAPE);
}

// --- API ROUTES ---

async function performScrape(username) {
    try {
        const cleanUser = username.replace('@', '').trim();
        const videos = await fetchVideosFromCountik(cleanUser);
        return { videos, userId: cleanUser };
    } catch (e) {
        console.error(e);
        return { error: e.message, videos: [] };
    }
}

// Cronjob: Cập nhật mỗi 2 giờ
cron.schedule('0 */2 * * *', async () => {
    console.log('[CRON] Bắt đầu cập nhật dữ liệu...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    const globalHistory = loadJson(HISTORY_FILE);

    for (const user of users) {
        await sleep(10000); // Nghỉ giữa các user
        const result = await performScrape(user);
        if (result.videos.length > 0) {
            const newHistoryMap = {};
            result.videos.forEach(v => { newHistoryMap[v.id] = v.numericViews; });
            globalHistory[user] = newHistoryMap;
        }
    }
    saveJson(HISTORY_FILE, globalHistory);
}, { scheduled: true, timezone: "Asia/Ho_Chi_Minh" });

app.get('/health', (req, res) => {
    res.json({ status: 'ok', engine: 'Playwright + Countik (DeepScroll)' });
});

app.get('/watched', (req, res) => {
    const data = loadJson(WATCHED_USERS_FILE);
    res.json(data.list || []);
});

app.delete('/watched/:username', (req, res) => {
    const { username } = req.params;
    const data = loadJson(WATCHED_USERS_FILE);
    if (data.list) {
        data.list = data.list.filter(u => u !== username);
        saveJson(WATCHED_USERS_FILE, data);
        return res.json({ success: true });
    }
    res.status(404).json({ error: "Empty" });
});

app.get('/views', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ error: 'Username required' });

    const targetUsername = user.toString().replace('@', '').trim();
    
    addToWatchedUsers(targetUsername);

    const globalHistory = loadJson(HISTORY_FILE);
    const userHistory = globalHistory[targetUsername] || {}; 

    const result = await performScrape(targetUsername);

    if (result.error) {
        if (Object.keys(userHistory).length > 0) {
             console.log("[Fallback] Trả về dữ liệu cũ do lỗi scrape");
             const fallbackVideos = Object.entries(userHistory).map(([id, views]) => ({
                 id,
                 url: `https://www.tiktok.com/@${targetUsername}/video/${id}`,
                 cover: '', 
                 views: formatViewCount(views),
                 numericViews: views,
                 change: 0,
                 changePercent: 0
             }));
             return res.json({
                user: targetUsername,
                totalVideos: fallbackVideos.length,
                scrapedAt: new Date().toISOString(),
                videos: fallbackVideos,
                isCached: true
            });
        }
        return res.status(500).json({ error: result.error });
    }

    let finalVideos = result.videos;
    const isFirstTime = Object.keys(userHistory).length === 0;
    const newHistoryMap = isFirstTime ? {} : null;

    finalVideos = finalVideos.map(video => {
        const previousViews = userHistory[video.id];
        let change = 0;
        let changePercent = 0;

        if (previousViews !== undefined) {
            change = video.numericViews - previousViews;
            if (previousViews > 0) changePercent = (change / previousViews) * 100;
            else if (change > 0) changePercent = 100;
        }

        if (isFirstTime && newHistoryMap) newHistoryMap[video.id] = video.numericViews;
        
        return { ...video, change, changePercent: parseFloat(changePercent.toFixed(2)) };
    });

    const updatedHistoryMap = {};
    finalVideos.forEach(v => { updatedHistoryMap[v.id] = v.numericViews; });
    globalHistory[targetUsername] = updatedHistoryMap;
    saveJson(HISTORY_FILE, globalHistory);

    res.json({
        user: targetUsername,
        totalVideos: finalVideos.length,
        scrapedAt: new Date().toISOString(),
        videos: finalVideos
    });
});

app.listen(PORT, async () => {
    console.log(`Backend chạy trên cổng ${PORT}`);
    getBrowser();
});
