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
const USER_DATA_DIR = path.join(process.cwd(), 'user_data_v2'); 
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

const addToWatchedUsers = (username) => {
    const users = loadJson(WATCHED_USERS_FILE);
    if (!Array.isArray(users.list)) users.list = [];
    if (!users.list.includes(username)) {
        console.log(`[Watchlist] Adding ${username} to daily tracker.`);
        users.list.push(username);
        saveJson(WATCHED_USERS_FILE, users);
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- BROWSER MANAGEMENT ---
let globalContext = null;
let isCurrentHeadless = true; 

async function getBrowserContext(forceHeadful = false) {
    if (globalContext && forceHeadful && isCurrentHeadless) {
        console.log("🔄 Chuyển đổi sang chế độ có giao diện (Headful) để vượt CAPTCHA...");
        await globalContext.close();
        globalContext = null;
    }

    if (!globalContext) {
        const headlessMode = forceHeadful ? false : true;
        isCurrentHeadless = headlessMode;

        console.log(`[Browser] Launching Chromium (Headless: ${headlessMode})...`);
        
        globalContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: headlessMode,
            viewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--start-maximized'
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        globalContext.on('page', async (page) => {
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
        });
    }
    return globalContext;
}

// --- HELPER: CHECK PAGE STATUS ---
async function checkPageStatus(page) {
    try {
        await page.waitForTimeout(1000);
        const title = await page.title();
        
        // 1. Kiểm tra nếu nội dung là JSON (API success)
        const bodyText = await page.innerText('body');
        if (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('[')) {
             return 'OK_JSON';
        }

        // 2. Cloudflare
        if (title.includes("Just a moment") || title.includes("Cloudflare") || title.includes("Web server is down")) {
            return 'CLOUDFLARE_DETECTED';
        }

        return 'UNKNOWN';

    } catch (e) {
        return 'ERROR';
    }
}

async function solveCloudflare(page) {
    console.log("⚡ [Solver] Bắt đầu quy trình giả lập Tab + Space...");
    // Click vào vùng trống để focus window
    await page.mouse.click(50, 50).catch(() => {});
    await sleep(1000);

    for (let i = 1; i <= 3; i++) {
        console.log(`   👉 [Thử lần ${i}] Gửi Tab + Space...`);
        await page.keyboard.press('Tab');
        await sleep(300);
        await page.keyboard.press('Space');
        
        try {
            await sleep(3000);
            
            const status = await checkPageStatus(page);
            if (status === 'OK_JSON') {
                 console.log("✅ [Solver] Đã vượt qua Cloudflare! (Thấy JSON)");
                 return true;
            }
        } catch (e) {
            console.log("   ...Chưa qua...");
        }
    }
    return false;
}

// --- MAIN SCRAPING FUNCTION ---
async function fetchVideosViaBrowser(inputUsername, retryWithHeadful = false) {
    const context = await getBrowserContext(retryWithHeadful);
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    try {
        const targetId = inputUsername;
        
        // --- HÀM ĐIỀU HƯỚNG AN TOÀN TỚI API ---
        const safeApiNavigate = async (url) => {
            console.log(`🌐 Navigating directly to API: ${url}`);
            
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            
            let apiStatus = await checkPageStatus(page);
            
            if (apiStatus === 'CLOUDFLARE_DETECTED') {
                console.log("⚠️ Cloudflare chặn link API! Đang xử lý...");
                if (isCurrentHeadless) {
                     throw new Error("Cloudflare on API (Headless)");
                }
                const solved = await solveCloudflare(page);
                if (!solved) {
                    console.log("⏳ Vui lòng verify Cloudflare thủ công trên trình duyệt...");
                    await page.waitForFunction(() => !document.title.includes("Just a moment"), { timeout: 60000 });
                }
                console.log("🔄 Reloading API page...");
                await page.reload({ waitUntil: 'domcontentloaded' });
            }

            const content = await page.innerText('body');
            try {
                return JSON.parse(content);
            } catch (e) {
                try {
                     const pre = await page.innerText('pre');
                     return JSON.parse(pre);
                } catch(ex) {
                    console.error("❌ Không thể parse JSON:", content.substring(0, 100));
                    return { code: -1, msg: "Invalid JSON response" };
                }
            }
        };

        console.log(`Fetching Posts for ${targetId}...`);
        
        let allVideos = [];
        let cursor = 0;
        let hasMore = true;

        while (hasMore && allVideos.length < TARGET_VIDEO_COUNT) {
            // URL chuẩn giống code cũ: count=33, không có web=1/hd=1
            const postsUrl = `https://www.tikwm.com/api/user/posts?unique_id=${targetId}&count=33&cursor=${cursor}`;
            
            const postData = await safeApiNavigate(postsUrl);

            if (!postData || postData.code !== 0) {
                 const msg = postData ? postData.msg : "No Data";
                 if (allVideos.length === 0) return { error: `API Error: ${msg}` };
                 break;
            }
            
            const vids = postData.data.videos;
            if (!vids || vids.length === 0) break;

            allVideos = allVideos.concat(vids);
            cursor = postData.data.cursor;
            hasMore = postData.data.hasMore;
            
            console.log(`   -> Got ${vids.length} videos (Total: ${allVideos.length})`);
            
            if (!hasMore) break;
            await sleep(1000);
        }
        
        const collectedVideos = [];
        const seen = new Set();
        
        for (const v of allVideos) {
            if (seen.has(v.video_id)) continue;
            seen.add(v.video_id);

            collectedVideos.push({
                id: v.video_id,
                url: `https://www.tiktok.com/@${targetId}/video/${v.video_id}`,
                // Ưu tiên cover, fallback sang origin_cover như code cũ
                cover: v.cover || v.origin_cover, 
                views: formatViewCount(v.play_count),
                numericViews: v.play_count,
                createTime: v.create_time
            });
        }

        return { videos: collectedVideos.slice(0, TARGET_VIDEO_COUNT), userId: targetId };

    } catch (e) {
        if (e.message.includes("Cloudflare on API (Headless)") && !retryWithHeadful) {
            console.log("⚠️ Chuyển sang chế độ Headful để vượt Cloudflare...");
            await page.close();
            return await fetchVideosViaBrowser(inputUsername, true);
        }
        throw e;
    }
}

// --- API ROUTES ---

async function performScrape(username) {
    try {
        const cleanUser = username.replace('@', '').trim();
        const result = await fetchVideosViaBrowser(cleanUser);
        return result;
    } catch (e) {
        return { error: e.message, videos: [] };
    }
}

// --- CRON JOBS (Giống code cũ) ---

// Cron Job 1: 7:00 AM Reset (Vietnam Time)
cron.schedule('0 7 * * *', async () => {
    console.log('\n[CRON] Starting Daily Morning Update (7:00 AM VN)...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    const globalHistory = loadJson(HISTORY_FILE);

    for (const user of users) {
        console.log(`[CRON-Mid] Updating baseline for: ${user}`);
        await sleep(Math.random() * 5000 + 2000);
        
        const result = await performScrape(user);
        if (result.videos.length > 0) {
            const newHistoryMap = {};
            // Reset dữ liệu ngày mới
            result.videos.forEach(v => { newHistoryMap[v.id] = v.numericViews; });
            globalHistory[user] = newHistoryMap;
        }
    }
    saveJson(HISTORY_FILE, globalHistory);
    console.log('[CRON] Daily update complete (Baseline Reset).');
}, { scheduled: true, timezone: "Asia/Ho_Chi_Minh" });

// Cron Job 2: Cập nhật mỗi 30 phút
cron.schedule('*/30 * * * *', async () => {
    console.log('\n[CRON] Starting 30-Minute Data Refresh...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    const globalHistory = loadJson(HISTORY_FILE);

    for (const user of users) {
        await sleep(5000); 
        const result = await performScrape(user);
        if (result.videos.length > 0) {
             // Cập nhật mà không reset (logic này có thể mở rộng sau nếu muốn lưu lịch sử chi tiết)
             // Hiện tại chỉ log lại là đã chạy
             console.log(`[CRON-30m] Refreshed ${user}: ${result.videos.length} videos.`);
             // Lưu state mới nhất vào history để tính toán real-time nếu cần
             const updatedMap = globalHistory[user] || {};
             result.videos.forEach(v => { updatedMap[v.id] = v.numericViews; });
             globalHistory[user] = updatedMap;
        }
    }
    saveJson(HISTORY_FILE, globalHistory);
}, { scheduled: true, timezone: "Asia/Ho_Chi_Minh" });

app.get('/health', (req, res) => {
    res.json({ status: 'ok', engine: 'Playwright Direct API (Captcha Aware)' });
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
        return res.json({ success: true, message: `Removed ${username}` });
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
        // Fallback: Nếu lỗi (do captcha chưa qua hoặc mạng), trả về cache cũ nếu có
        if (Object.keys(userHistory).length > 0) {
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
                isCached: true,
                error: result.error
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

    if (isFirstTime) {
        globalHistory[targetUsername] = newHistoryMap;
    } else {
        // Cập nhật lại view mới nhất vào db để lần tới so sánh (hoặc giữ nguyên mốc 7h sáng tùy logic)
        // Logic ở đây: giữ userHistory làm mốc (baseline), chỉ update nếu cần thiết. 
        // Tuy nhiên code cũ có vẻ update liên tục? 
        // Để đảm bảo tính năng "Change since 7AM", ta KHÔNG update globalHistory ở đây nếu đã có baseline.
        // Chỉ update vào lúc 7h sáng.
    }
    
    // Lưu ý: Code cũ saveJson mỗi lần request, nhưng logic change view sẽ bị reset về 0 nếu update liên tục.
    // Giữ nguyên logic: chỉ update baseline vào 7h sáng (trong cron) hoặc lần đầu tiên quét.
    if (isFirstTime) saveJson(HISTORY_FILE, globalHistory);

    res.json({
        user: targetUsername,
        totalVideos: finalVideos.length,
        scrapedAt: new Date().toISOString(),
        videos: finalVideos
    });
});

app.listen(PORT, async () => {
    console.log(`Backend running on port ${PORT} (Direct API + Playwright Captcha Solver)`);
});
