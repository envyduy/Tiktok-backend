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

// User Agent mới nhất
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
            '--disable-blink-features=AutomationControlled',
        ]
    });
    return browser;
}

// --- SCRAPER LOGIC ---

async function fetchVideosFromCountik(username) {
    const browserInstance = await getBrowser();
    const context = await browserInstance.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1366, height: 768 }, // Viewport laptop phổ thông
        locale: 'en-US',
        deviceScaleFactor: 1,
    });
    
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();
    const collectedVideos = new Map();

    try {
        console.log(`[Scraper] Truy cập Countik cho @${username}...`);

        // Lắng nghe API response
        page.on('response', async (response) => {
            const url = response.url();
            // Bắt tất cả các endpoint có khả năng chứa dữ liệu video
            if (response.status() === 200 && (url.includes('/api/user/posts') || url.includes('/api/user/videos') || url.includes('countik.com/api/') || url.includes('tiktok-analytics'))) {
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
                            console.log(`[Scraper] +${newCount} video (Tổng: ${collectedVideos.size})`);
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        });

        // 1. Vào trang
        await page.goto('https://countik.com/tiktok-analytics', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 2. Tìm kiếm
        const inputSelector = 'input[placeholder*="username" i], input[placeholder*="Enter TikTok" i]';
        try {
            await page.waitForSelector(inputSelector, { timeout: 10000 });
            await page.fill(inputSelector, username);
            await sleep(1000);
            await page.keyboard.press('Enter');
        } catch (inputError) {
            await page.goto(`https://countik.com/tiktok-analytics/user/${username}`, { waitUntil: 'domcontentloaded' });
        }

        // 3. Chờ mẻ dữ liệu đầu tiên
        let attempts = 0;
        while (collectedVideos.size === 0 && attempts < 15) {
            await sleep(1000);
            attempts++;
        }

        if (collectedVideos.size === 0) throw new Error("Không có dữ liệu ban đầu.");

        // 4. LOGIC CUỘN THÔNG MINH (SMART SCROLL)
        console.log(`[Scraper] Bắt đầu cuộn sâu để lấy ${MAX_VIDEOS_TO_SCRAPE} video...`);
        
        let consecutiveNoLoad = 0;
        const maxScrolls = 40; // Tăng số lần thử

        for (let i = 0; i < maxScrolls; i++) {
            if (collectedVideos.size >= MAX_VIDEOS_TO_SCRAPE) break;

            const previousSize = collectedVideos.size;

            // Kỹ thuật 1: Smooth Scroll xuống đáy (Giả lập người dùng vuốt chuột)
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 100; // Khoảng cách mỗi lần cuộn
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;

                        if(totalHeight >= scrollHeight){
                            clearInterval(timer);
                            resolve();
                        }
                    }, 50); // Tốc độ cuộn: 50ms/lần
                });
            });

            // Chờ tải sau khi cuộn
            await sleep(3000);

            // Kỹ thuật 2: Nếu chưa có video mới, thử bấm nút "Load More" nếu tồn tại
            if (collectedVideos.size === previousSize) {
                // Thử tìm nút bấm (Tiếng Anh hoặc class thường gặp)
                const loadMoreBtn = await page.$('button:has-text("Load more"), button:has-text("Show more"), .load-more-btn');
                if (loadMoreBtn && await loadMoreBtn.isVisible()) {
                    console.log('[Scraper] Tìm thấy nút Load More, đang click...');
                    await loadMoreBtn.click();
                    await sleep(3000);
                } else {
                    // Kỹ thuật 3: "Jiggle" - Cuộn lên một chút rồi cuộn xuống lại để kích hoạt event
                    await page.mouse.wheel(0, -500);
                    await sleep(500);
                    await page.keyboard.press('End');
                    await sleep(2000);
                }
            }

            if (collectedVideos.size === previousSize) {
                consecutiveNoLoad++;
                console.log(`[Scraper] Không có video mới... (${consecutiveNoLoad}/5)`);
            } else {
                consecutiveNoLoad = 0; // Reset counter
            }

            if (consecutiveNoLoad >= 5) {
                console.log('[Scraper] Dừng cuộn do không tải thêm được dữ liệu.');
                break;
            }
        }

    } catch (e) {
        console.error(`[Scraper] Lỗi: ${e.message}`);
    } finally {
        await context.close();
    }

    if (collectedVideos.size === 0) throw new Error("Không lấy được dữ liệu.");

    const videos = Array.from(collectedVideos.values()).map(v => {
        const playCount = v.play_count || v.plays || 0;
        return {
            id: v.id || v.video_id,
            url: `https://www.tiktok.com/@${username}/video/${v.id || v.video_id}`,
            cover: v.cover || v.origin_cover || v.thumbnail_url,
            views: formatViewCount(playCount),
            numericViews: playCount,
            createTime: v.create_time || 0 
        };
    });

    videos.sort((a, b) => b.createTime - a.createTime);
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

cron.schedule('0 */2 * * *', async () => {
    console.log('[CRON] Starting update...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    const globalHistory = loadJson(HISTORY_FILE);

    for (const user of users) {
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
    res.json({ status: 'ok', engine: 'Playwright + Countik (SmartScroll)' });
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
             console.log("[Fallback] Returning cached data");
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
