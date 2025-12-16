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
const TARGET_VIDEO_COUNT = 200; 
const USER_DATA_DIR = path.join(process.cwd(), 'tikwm-profile'); 

// GIẢ LẬP TRÌNH DUYỆT WINDOWS 10
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json());

// --- TRẠNG THÁI TOÀN CỤC ---
let browserContext = null;
let mainPage = null;
let isBrowserReady = false; 

// --- Helper Functions: Utils ---

const parseViewCount = (str) => {
    if (!str) return 0;
    if (typeof str === 'number') return str;
    const s = str.toString().toUpperCase().trim();
    if (s.includes('M')) return parseFloat(s.replace('M', '')) * 1000000;
    if (s.includes('K')) return parseFloat(s.replace('K', '')) * 1000;
    return parseInt(s.replace(/,/g, ''), 10) || 0;
};

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

// --- LOGIC XỬ LÝ CLOUDFLARE ---

async function solveCloudflare(page) {
    console.log('>>> [Solver] Đang tìm cách vượt Cloudflare...');
    await sleep(3000);

    try {
        const frames = page.frames();
        const challengeFrame = frames.find(f => f.url().includes('challenge-platform'));

        if (challengeFrame) {
            console.log('>>> [Solver] Đã tìm thấy khung bảo mật (Iframe).');
            
            // Cách 1: Tìm nút checkbox
            const checkbox = await challengeFrame.waitForSelector('input[type="checkbox"], .ctp-checkbox-label', { timeout: 3000 }).catch(() => null);
            if (checkbox) {
                console.log('>>> [Solver] Click vào Checkbox...');
                await checkbox.click({ force: true });
            } else {
                // Cách 2: Click vào giữa iframe (tọa độ)
                console.log('>>> [Solver] Không thấy nút, click vào giữa khung...');
                const box = await challengeFrame.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                }
            }
            
            await sleep(5000); // Chờ reload
            return true;
        } else {
            console.log('>>> [Solver] Không tìm thấy Iframe. Có thể đã qua hoặc bị chặn kiểu khác.');
        }
    } catch (e) {
        console.log(`>>> [Solver] Lỗi: ${e.message}`);
    }
}

// --- KHỞI TẠO TRÌNH DUYỆT ---

async function initBrowser() {
    if (browserContext) return;

    console.log('[System] Khởi tạo trình duyệt ẩn danh (Stealth Mode)...');
    isBrowserReady = false;
    
    if (!fs.existsSync(USER_DATA_DIR)) {
        try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }); } catch (e) {}
    }

    try {
        browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: true, // BẮT BUỘC TRÊN RAILWAY
            viewport: { width: 1366, height: 768 },
            userAgent: USER_AGENT,
            locale: 'en-US',
            timezoneId: 'Asia/Ho_Chi_Minh',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled', // Quan trọng: Giấu việc đang dùng bot
            ],
            ignoreDefaultArgs: ['--enable-automation']
        });

        const pages = browserContext.pages();
        mainPage = pages.length > 0 ? pages[0] : await browserContext.newPage();

        // --- XỬ LÝ COOKIE TỪ BIẾN MÔI TRƯỜNG ---
        if (process.env.TIKWM_COOKIE) {
            console.log('[System] Đang nạp Cookie từ biến môi trường...');
            
            // 1. Làm sạch chuỗi cookie (xóa dấu nháy thừa nếu có)
            let cookieString = process.env.TIKWM_COOKIE.trim();
            if ((cookieString.startsWith('"') && cookieString.endsWith('"')) || 
                (cookieString.startsWith("'") && cookieString.endsWith("'"))) {
                cookieString = cookieString.slice(1, -1);
            }

            // 2. Chuyển đổi thành mảng object
            const cookies = cookieString.split(';').map(pair => {
                const parts = pair.trim().split('=');
                if (parts.length < 2) return null;
                const name = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                return { name, value, domain: '.tikwm.com', path: '/' };
            }).filter(c => c !== null);

            // 3. Kiểm tra xem có cf_clearance không
            const hasClearance = cookies.some(c => c.name === 'cf_clearance');
            if (!hasClearance) {
                console.warn('\n⚠️  CẢNH BÁO QUAN TRỌNG: Cookie bạn nhập THIẾU "cf_clearance"!');
                console.warn('⚠️  Cloudflare thường yêu cầu cookie này để xác minh bạn là người.');
                console.warn('⚠️  Hãy lấy lại cookie từ trình duyệt (Tab Network -> Headers).\n');
            } else {
                console.log('✅  Đã tìm thấy "cf_clearance". Hy vọng sẽ qua được Cloudflare.');
            }

            await browserContext.addCookies(cookies);
        }

        console.log('[System] Truy cập TikWM...');
        await mainPage.goto('https://www.tikwm.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // --- KIỂM TRA & GIẢI QUYẾT CLOUDFLARE ---
        let attempts = 0;
        while (attempts < 3) {
            const title = await mainPage.title();
            console.log(`[System] Kiểm tra lần ${attempts + 1}: Tiêu đề trang là "${title}"`);

            if (title.includes("Just a moment") || title.includes("Security") || title.includes("Cloudflare")) {
                await solveCloudflare(mainPage);
                await sleep(3000); 
            } else {
                console.log('[System] ✅ Đã vào được trang chính TikWM.');
                isBrowserReady = true;
                return;
            }
            attempts++;
            // Thử reload lại trang để cookie ăn vào
            await mainPage.reload({ waitUntil: 'domcontentloaded' });
            await sleep(5000);
        }

        console.error('[System] ❌ Không thể vượt Cloudflare sau 3 lần thử.');
        console.error('[System] GỢI Ý: Hãy cập nhật lại TIKWM_COOKIE mới nhất (nhớ lấy cả cf_clearance).');
        isBrowserReady = false; 

    } catch (e) {
        console.error('[System] Lỗi khởi tạo trình duyệt:', e);
        browserContext = null;
    }
}

// --- LOGIC CÀO DỮ LIỆU ---

async function fetchVideosFromTikWM(username) {
    // Nếu chưa sẵn sàng, thử khởi động lại
    if (!isBrowserReady) {
        if (!browserContext) await initBrowser();
        if (!isBrowserReady) {
             const title = await mainPage?.title() || "";
             if (!title.includes("Just a moment")) isBrowserReady = true;
             else throw new Error("Hệ thống đang bận vượt Cloudflare. Vui lòng thử lại sau 30s.");
        }
    }

    let allVideos = [];
    let cursor = 0;
    let hasMore = true;
    let loops = 0;
    const MAX_LOOPS = 10;

    console.log(`[Scraper] Đang lấy dữ liệu cho @${username}...`);

    try {
        while (allVideos.length < TARGET_VIDEO_COUNT && hasMore && loops < MAX_LOOPS) {
            loops++;
            const apiUrl = `https://www.tikwm.com/api/user/posts?unique_id=${username}&count=33&cursor=${cursor}`;
            
            const json = await mainPage.evaluate(async (url) => {
                try {
                    // Delay ngẫu nhiên để giống người thật
                    await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
                    
                    const res = await fetch(url, {
                        headers: {
                            'Referer': 'https://www.tikwm.com/',
                            'User-Agent': navigator.userAgent,
                            'X-Requested-With': 'XMLHttpRequest' // Quan trọng cho API
                        }
                    });
                    
                    // Nếu trả về HTML -> Bị chặn
                    const contentType = res.headers.get('content-type');
                    if (contentType && contentType.includes('text/html')) {
                        return { code: -999, msg: "CLOUDFLARE_BLOCK" };
                    }
                    return await res.json();
                } catch (err) {
                    return null;
                }
            }, apiUrl);

            if (!json) {
                console.warn('[Scraper] Lỗi mạng nội bộ trình duyệt.');
                break;
            }

            if (json.code === -999) {
                 isBrowserReady = false;
                 throw new Error("Phiên làm việc hết hạn. Cần cập nhật Cookie mới.");
            }

            if (json.code !== 0) {
                if (loops === 1) throw new Error("Không tìm thấy user hoặc tài khoản Private");
                break;
            }

            const data = json.data;
            const videos = data.videos || [];
            if (videos.length === 0) {
                hasMore = false;
                break;
            }

            allVideos = allVideos.concat(videos);
            if (data.hasMore && data.cursor) {
                cursor = data.cursor;
                await sleep(1500 + Math.random() * 1000); 
            } else {
                hasMore = false;
            }
        }

    } catch (e) {
        console.error(`[Scraper] Lỗi: ${e.message}`);
        if (e.message.includes("Phiên làm việc") || e.message.includes("Cloudflare")) {
            isBrowserReady = false; // Đánh dấu để lần sau init lại
            setTimeout(() => initBrowser(), 1000); // Thử kết nối lại ngầm
        }
        throw e;
    }

    // Chuẩn hóa dữ liệu
    const normalized = allVideos.map(v => {
        const playCount = v.play_count || 0;
        return {
            id: v.video_id || v.id,
            url: `https://www.tiktok.com/@${username}/video/${v.video_id}`,
            cover: v.cover || v.origin_cover,
            views: formatViewCount(playCount),
            numericViews: playCount
        };
    });

    // Lọc trùng
    const uniqueVideos = [];
    const seen = new Set();
    for (const v of normalized) {
        if (!seen.has(v.id)) {
            seen.add(v.id);
            uniqueVideos.push(v);
        }
    }

    return uniqueVideos.slice(0, TARGET_VIDEO_COUNT);
}

// --- API ROUTES ---

async function performScrape(username) {
    try {
        const cleanUser = username.replace('@', '');
        const videos = await fetchVideosFromTikWM(cleanUser);
        return { videos, userId: cleanUser };
    } catch (e) {
        return { error: e.message, videos: [] };
    }
}

cron.schedule('0 7 * * *', async () => {
    console.log('[CRON] Cập nhật dữ liệu buổi sáng...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    const globalHistory = loadJson(HISTORY_FILE);

    for (const user of users) {
        await sleep(Math.random() * 5000 + 2000);
        const result = await performScrape(user);
        if (result.videos.length > 0) {
            const newHistoryMap = {};
            result.videos.forEach(v => { newHistoryMap[v.id] = v.numericViews; });
            globalHistory[user] = newHistoryMap;
        }
    }
    saveJson(HISTORY_FILE, globalHistory);
}, { scheduled: true, timezone: "Asia/Ho_Chi_Minh" });

cron.schedule('*/30 * * * *', async () => {
    console.log('[CRON] Giữ server hoạt động (30p)...');
    loadJson(WATCHED_USERS_FILE);
});

app.get('/health', async (req, res) => {
    const title = mainPage ? await mainPage.title() : "No Browser";
    res.json({ 
        status: 'ok', 
        browserReady: isBrowserReady, 
        currentTitle: title 
    });
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
        const status = result.error.includes("Không tìm thấy") ? 404 : 500;
        return res.status(status).json({ error: result.error });
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
    console.log(`Backend chạy trên cổng ${PORT} | Headless: TRUE | Stealth: BẬT`);
    await initBrowser();
});
