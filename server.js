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
            
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            
            let data = await getJsonFromPage(page);

            if (!data) {
                if (!forceHeadful) {
                    console.log("⚠️ [BỊ CHẶN] Cần giải CAPTCHA...");
                    await context.close();
                    return await fetchVideosViaBrowser(inputUsername, true); 
                } else {
                    console.log("🧩 [CAPTCHA] Đang đợi bạn giải...");
                    await page.waitForFunction(() => document.body.innerText.includes('"code":0'), { timeout: 120000 });
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
                await sleep(1500); 
            } else {
                break;
            }
        }
    } catch (e) {
        console.error("❌ Lỗi quét:", e.message);
    } finally {
        if (context) await context.close();
    }

    return { rawVideos: allVideos, userId: targetId };
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
    
    // 1. Quản lý danh sách theo dõi
    const watched = loadJson(WATCHED_USERS_FILE);
    if (!Array.isArray(watched.list)) watched.list = [];
    if (!watched.list.includes(target)) {
        watched.list.push(target);
        saveJson(WATCHED_USERS_FILE, watched);
    }

    // 2. Tải Cache
    const globalHistory = loadJson(HISTORY_FILE);
    // Cấu trúc mới: { views: number, cover: string, lastUpdated: string }
    const userCache = globalHistory[target] || {}; 
    
    try {
        // 3. Quét dữ liệu mới
        const { rawVideos } = await fetchVideosViaBrowser(target);
        
        // 4. Cập nhật Cache với dữ liệu mới
        rawVideos.forEach(v => {
            userCache[v.video_id] = {
                views: v.play_count,
                cover: v.cover || v.origin_cover,
                lastUpdated: new Date().toISOString()
            };
        });

        // 5. Tổng hợp dữ liệu để gửi về Frontend
        // Lấy tất cả video từ cache, sắp xếp theo thời gian hoặc ID (để video mới lên đầu)
        // Chúng ta map ngược lại từ cache để đảm bảo kể cả khi scraper lỗi, ta vẫn có data cũ.
        let finalVideos = Object.entries(userCache).map(([id, info]) => {
            const videoId = id;
            const numericViews = info.views;
            
            // Tính toán thay đổi (nếu có dữ liệu cũ trong RAM trước khi cập nhật - logic này cần tinh tế hơn)
            // Ở đây ta so sánh với chính nó nhưng là dữ liệu "trước khi scan" nếu muốn
            // Để đơn giản, ta sẽ chỉ trả về danh sách đã merge.
            
            return {
                id: videoId,
                url: `https://www.tiktok.com/@${target}/video/${videoId}`,
                cover: info.cover,
                views: formatViewCount(numericViews),
                numericViews: numericViews,
                // Change logic will be handled by comparing current vs previous in a real app
                // For now, let's keep the existing change logic if possible
            };
        });

        // Sắp xếp video mới nhất lên đầu (Dựa trên ID hoặc bạn có thể lưu timestamp)
        finalVideos.sort((a, b) => b.id.localeCompare(a.id));

        // Lưu lại cache đã cập nhật
        globalHistory[target] = userCache;
        saveJson(HISTORY_FILE, globalHistory);

        res.json({ 
            user: target, 
            totalVideos: finalVideos.length, 
            scrapedAt: new Date().toISOString(), 
            videos: finalVideos.slice(0, TARGET_VIDEO_COUNT) 
        });

    } catch (err) {
        console.error(err);
        // Nếu lỗi hoàn toàn, trả về toàn bộ cache cũ
        if (Object.keys(userCache).length > 0) {
            const fallback = Object.entries(userCache).map(([id, info]) => ({
                id, 
                url: `https://www.tiktok.com/@${target}/video/${id}`,
                cover: info.cover, 
                views: formatViewCount(info.views), 
                numericViews: info.views
            })).sort((a, b) => b.id.localeCompare(a.id));
            
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
            const { rawVideos } = await fetchVideosViaBrowser(user);
            const userCache = globalHistory[user] || {};
            rawVideos.forEach(v => {
                userCache[v.video_id] = {
                    views: v.play_count,
                    cover: v.cover || v.origin_cover,
                    lastUpdated: new Date().toISOString()
                };
            });
            globalHistory[user] = userCache;
            saveJson(HISTORY_FILE, globalHistory);
        } catch (e) {}
        await sleep(5000);
    }
});
