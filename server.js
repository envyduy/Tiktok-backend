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
const USER_DATA_DIR = path.join(process.cwd(), 'browser-profile'); 

// GIẢ LẬP TRÌNH DUYỆT
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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
        headless: true, // "new" headless mode
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
        ]
    });
    return browser;
}

// --- SCRAPER LOGIC (Countik Intercept Strategy) ---

async function fetchVideosFromCountik(username) {
    const browserInstance = await getBrowser();
    const context = await browserInstance.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1366, height: 768 },
        locale: 'en-US'
    });
    const page = await context.newPage();
    
    // Biến chứa dữ liệu tìm thấy
    let foundData = null;

    try {
        console.log(`[Scraper] Truy cập Countik cho @${username}...`);

        // Lắng nghe các response mạng
        page.on('response', async (response) => {
            const url = response.url();
            // Countik API thường có dạng /api/user/posts
            if (url.includes('/api/user/posts') && response.status() === 200) {
                try {
                    const json = await response.json();
                    if (json && (json.posts || json.list)) {
                        console.log('[Scraper] Đã bắt được gói tin API chứa video!');
                        foundData = json.posts || json.list;
                    }
                } catch (e) {
                    // Ignore json parse errors for non-json responses
                }
            }
        });

        // Truy cập trang Analytics của Countik
        await page.goto(`https://countik.com/tiktok-analytics/user/${username}`, { 
            waitUntil: 'networkidle',
            timeout: 30000 
        });

        // Chờ thêm một chút nếu dữ liệu chưa về
        if (!foundData) {
            console.log('[Scraper] Đang chờ dữ liệu API...');
            await sleep(3000); 
        }

        // Nếu vẫn không có dữ liệu, thử click nút "Check" nếu có (đôi khi cần kích hoạt)
        if (!foundData) {
            const checkBtn = await page.$('button#check-btn');
            if (checkBtn) {
                await checkBtn.click();
                await sleep(3000);
            }
        }

    } catch (e) {
        console.error(`[Scraper] Lỗi khi tải trang: ${e.message}`);
    } finally {
        await context.close();
    }

    if (!foundData || foundData.length === 0) {
        throw new Error("Không tìm thấy dữ liệu. User có thể không tồn tại hoặc hệ thống đang bận.");
    }

    // Chuẩn hóa dữ liệu từ Countik
    const videos = foundData.map(v => {
        const playCount = v.play_count || v.plays || 0;
        return {
            id: v.id || v.video_id,
            url: `https://www.tiktok.com/@${username}/video/${v.id || v.video_id}`,
            cover: v.cover || v.origin_cover || v.thumbnail_url,
            views: formatViewCount(playCount),
            numericViews: playCount
        };
    });

    // Loại bỏ trùng lặp và null
    return videos.filter(v => v.id);
}

// --- API ROUTES ---

async function performScrape(username) {
    try {
        const cleanUser = username.replace('@', '');
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
        // Nghỉ 10s giữa mỗi user để tránh bị chặn
        await sleep(10000);
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
    res.json({ status: 'ok', engine: 'Playwright + Countik' });
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

    if (isFirstTime) {
        globalHistory[targetUsername] = newHistoryMap;
        saveJson(HISTORY_FILE, globalHistory);
    }

    res.json({
        user: targetUsername,
        totalVideos: finalVideos.length,
        scrapedAt: new Date().toISOString(),
        videos: finalVideos
    });
});

app.listen(PORT, async () => {
    console.log(`Backend chạy trên cổng ${PORT}`);
    // Warm up browser
    getBrowser();
});
