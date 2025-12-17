import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import dotenv from 'dotenv';
import { chromium } from 'playwright';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONSTANTS ---
const HISTORY_FILE = 'tiktok_view_history.json';
const WATCHED_USERS_FILE = 'watched_users.json';
const USER_DATA_DIR = path.resolve(process.cwd(), 'user_data_v2'); 
const TARGET_VIDEO_COUNT = 200;

app.use(cors());
app.use(express.json());

// --- UTILS ---
const formatViewCount = (num) => {
    if (num === undefined || num === null) return "0";
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- BROWSER MANAGEMENT ---

async function launchBrowser(isHeadless) {
    console.log(`[Browser] Khởi động... (Chế độ ẩn: ${isHeadless})`);
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: isHeadless,
        viewport: { width: 1280, height: 720 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation']
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    return context;
}

async function getJsonFromPage(page) {
    try {
        const content = await page.innerText('body');
        if (content.includes('"code":0') && content.includes('"data":')) {
            return JSON.parse(content);
        }
    } catch (e) {}
    return null;
}

async function fetchVideosViaBrowser(inputUsername, forceHeadful = false) {
    let allVideos = [];
    let cursor = 0;
    let hasMore = true;
    const targetId = inputUsername;

    let context = await launchBrowser(!forceHeadful);
    let page = context.pages()[0] || await context.newPage();

    try {
        console.log(`[Scraper] Bắt đầu quét: @${targetId}`);

        while (hasMore && allVideos.length < TARGET_VIDEO_COUNT) {
            const url = `https://www.tikwm.com/api/user/posts?unique_id=${targetId}&count=33&cursor=${cursor}`;
            console.log(`🌐 Truy cập: ${url}`);
            
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            let data = await getJsonFromPage(page);

            // Nếu không có data (có thể bị CAPTCHA)
            if (!data) {
                if (!forceHeadful) {
                    console.log("⚠️ [BỊ CHẶN] Cần giải CAPTCHA. Đang chuyển sang chế độ hiện...");
                    await context.close();
                    return await fetchVideosViaBrowser(inputUsername, true); // Gọi lại chính nó ở chế độ hiện
                } else {
                    console.log("🧩 [CAPTCHA] Đang đợi bạn giải CAPTCHA...");
                    // Đợi đến khi JSON xuất hiện
                    await page.waitForFunction(() => {
                        return document.body.innerText.includes('"code":0');
                    }, { timeout: 120000 });
                    data = await getJsonFromPage(page);
                }
            }

            if (data && data.code === 0) {
                const vids = data.data.videos || [];
                allVideos = allVideos.concat(vids);
                cursor = data.data.cursor;
                hasMore = data.data.hasMore;
                console.log(`   -> Lấy được ${vids.length} videos (Tổng: ${allVideos.length})`);
                
                if (!hasMore || allVideos.length >= TARGET_VIDEO_COUNT) break;
                
                // Nghỉ ngắn giữa các lần chuyển trang để tránh bị phát hiện spam
                await sleep(2000); 
            } else {
                console.log("⚠️ API không trả về dữ liệu hợp lệ.");
                break;
            }
        }

    } catch (e) {
        console.error("❌ Lỗi quét:", e.message);
    } finally {
        if (context) {
            console.log("✅ Hoàn tất. Đóng trình duyệt.");
            await context.close();
        }
    }

    if (allVideos.length === 0) throw new Error("Không lấy được dữ liệu video.");

    const processed = allVideos.map(v => ({
        id: v.video_id,
        url: `https://www.tiktok.com/@${targetId}/video/${v.video_id}`,
        cover: v.cover || v.origin_cover, 
        views: formatViewCount(v.play_count),
        numericViews: v.play_count,
        createTime: v.create_time
    }));

    return { videos: processed.slice(0, TARGET_VIDEO_COUNT), userId: targetId };
}

// --- API ROUTES ---

app.get('/watched', (req, res) => res.json(loadJson(WATCHED_USERS_FILE).list || []));

app.delete('/watched/:username', (req, res) => {
    const data = loadJson(WATCHED_USERS_FILE);
    data.list = (data.list || []).filter(u => u !== req.params.username);
    saveJson(WATCHED_USERS_FILE, data);
    res.json({ success: true });
});

app.get('/views', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ error: 'Username required' });
    const target = user.toString().replace('@', '').trim();
    
    const watched = loadJson(WATCHED_USERS_FILE);
    if (!Array.isArray(watched.list)) watched.list = [];
    if (!watched.list.includes(target)) {
        watched.list.push(target);
        saveJson(WATCHED_USERS_FILE, watched);
    }

    const globalHistory = loadJson(HISTORY_FILE);
    const userHistory = globalHistory[target] || {}; 
    
    try {
        const result = await fetchVideosViaBrowser(target);
        const isFirstTime = Object.keys(userHistory).length === 0;
        
        const finalVideos = result.videos.map(video => {
            const prev = userHistory[video.id];
            let change = 0, changePercent = 0;
            if (prev !== undefined) {
                change = video.numericViews - prev;
                if (prev > 0) changePercent = (change / prev) * 100;
            }
            if (isFirstTime) userHistory[video.id] = video.numericViews;
            return { ...video, change, changePercent: parseFloat(changePercent.toFixed(2)) };
        });

        if (isFirstTime) {
            globalHistory[target] = userHistory;
            saveJson(HISTORY_FILE, globalHistory);
        }

        res.json({ user: target, totalVideos: finalVideos.length, scrapedAt: new Date().toISOString(), videos: finalVideos });
    } catch (err) {
        if (Object.keys(userHistory).length > 0) {
            const fallback = Object.entries(userHistory).map(([id, views]) => ({
                id, url: `https://www.tiktok.com/@${target}/video/${id}`,
                cover: '', views: formatViewCount(views), numericViews: views, change: 0
            }));
            return res.json({ user: target, videos: fallback, isCached: true, error: err.message });
        }
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

cron.schedule('*/30 * * * *', async () => {
    const watched = loadJson(WATCHED_USERS_FILE);
    const globalHistory = loadJson(HISTORY_FILE);
    for (const user of (watched.list || [])) {
        try {
            const result = await fetchVideosViaBrowser(user);
            const map = globalHistory[user] || {};
            result.videos.forEach(v => { map[v.id] = v.numericViews; });
            globalHistory[user] = map;
            saveJson(HISTORY_FILE, globalHistory);
        } catch (e) {}
        await sleep(5000);
    }
});
