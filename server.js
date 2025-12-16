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
const TARGET_VIDEO_COUNT = 200; 
const USER_DATA_DIR = path.join(process.cwd(), 'tikwm-profile'); // Persistent Profile Directory

app.use(cors());
app.use(express.json());

// --- Helper Functions: Utils ---

const parseViewCount = (str) => {
    if (!str) return 0;
    if (typeof str === 'number') return str;
    
    const s = str.toString().toUpperCase().trim();
    if (s.includes('M')) {
        return parseFloat(s.replace('M', '')) * 1000000;
    }
    if (s.includes('K')) {
        return parseFloat(s.replace('K', '')) * 1000;
    }
    return parseInt(s.replace(/,/g, ''), 10) || 0;
};

const formatViewCount = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
};

const loadJson = (filename) => {
    if (fs.existsSync(filename)) {
        try {
            return JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch (e) {
            console.error(`[Data] Error reading ${filename}, resetting.`);
            return {};
        }
    }
    return {};
};

const saveJson = (filename, data) => {
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[Data] Error saving ${filename}:`, e);
    }
};

const addToWatchedUsers = (username) => {
    const users = loadJson(WATCHED_USERS_FILE);
    if (!Array.isArray(users.list)) {
        users.list = [];
    }
    if (!users.list.includes(username)) {
        console.log(`[Watchlist] Adding ${username} to daily tracker.`);
        users.list.push(username);
        saveJson(WATCHED_USERS_FILE, users);
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- GLOBAL PERSISTENT BROWSER ---
// This ensures we only have ONE browser instance running at all times.
let browserContext = null;
let mainPage = null;

async function initBrowser() {
    if (browserContext) return;

    console.log('[System] Initializing Persistent Browser Session...');
    
    // Ensure directory exists
    if (!fs.existsSync(USER_DATA_DIR)) {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    try {
        // Launch persistent context. This saves cookies/storage to disk.
        browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: false, // Must be visible for initial manual verification
            viewport: null,  // Let the window resize naturally
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-position=0,0'
            ]
        });

        const pages = browserContext.pages();
        mainPage = pages.length > 0 ? pages[0] : await browserContext.newPage();

        console.log('[System] Navigating to TikWM home...');
        // We stay on this page forever to maintain the session
        await mainPage.goto('https://www.tikwm.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Initial Safety Check
        const title = await mainPage.title();
        if (title.includes("Just a moment") || title.includes("Security") || title.includes("Cloudflare")) {
            console.log('\n==================================================');
            console.log('⚠️  CLOUDFLARE DETECTED');
            console.log('👉 Please manually complete the CAPTCHA in the opened browser window.');
            console.log('👉 Once completed, the system will automatically be ready for requests.');
            console.log('👉 DO NOT CLOSE THE BROWSER WINDOW.');
            console.log('==================================================\n');
        } else {
            console.log('[System] Browser Ready & Unblocked.');
        }

    } catch (e) {
        console.error('[System] Browser Launch Failed:', e);
        process.exit(1); // Exit if we can't start the browser
    }
}

// --- SCRAPING LOGIC ---

async function fetchVideosFromTikWM(username) {
    // Ensure browser is ready
    if (!mainPage || mainPage.isClosed()) {
        console.log('[Scraper] Page was closed. Re-initializing...');
        browserContext = null;
        await initBrowser();
    }

    let allVideos = [];
    let cursor = 0;
    let hasMore = true;
    let loops = 0;
    const MAX_LOOPS = 10;

    console.log(`[Scraper] Fetching for @${username}...`);

    try {
        // Check if we are blocked before starting
        const title = await mainPage.title();
        if (title.includes("Just a moment") || title.includes("Security") || title.includes("Cloudflare")) {
             throw new Error("SYSTEM_BUSY: Cloudflare Challenge Active. Please verify in the server window.");
        }

        // Use page.evaluate to fetch data without navigating away
        // This keeps the session alive and robust
        while (allVideos.length < TARGET_VIDEO_COUNT && hasMore && loops < MAX_LOOPS) {
            loops++;
            const apiUrl = `https://www.tikwm.com/api/user/posts?unique_id=${username}&count=33&cursor=${cursor}`;
            
            const json = await mainPage.evaluate(async (url) => {
                try {
                    const res = await fetch(url);
                    return await res.json();
                } catch (err) {
                    return null;
                }
            }, apiUrl);

            if (!json) {
                console.warn('[Scraper] Network error inside browser');
                break;
            }

            if (json.code !== 0) {
                console.warn(`[Scraper] API Code ${json.code}: ${json.msg}`);
                // If blocked during fetch
                if (json.msg && (json.msg.includes("Human") || json.msg.includes("Verify"))) {
                     throw new Error("CAPTCHA_TRIGGERED: Please solve Captcha in browser.");
                }
                if (loops === 1) throw new Error("User not found or Private");
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
                // Small delay to be polite to the API
                await sleep(1000 + Math.random() * 500); 
            } else {
                hasMore = false;
            }
        }

    } catch (e) {
        console.error(`[Scraper] Error: ${e.message}`);
        throw e;
    }

    // --- NORMALIZE DATA ---
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

// --- MAIN SCRAPE HANDLER ---

async function performScrape(username) {
    try {
        const cleanUser = username.replace('@', '');
        const videos = await fetchVideosFromTikWM(cleanUser);
        
        return { videos, userId: cleanUser };
    } catch (e) {
        return { error: e.message, videos: [] };
    }
}

// --- CRON JOBS ---

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
            result.videos.forEach(v => { newHistoryMap[v.id] = v.numericViews; });
            globalHistory[user] = newHistoryMap;
        }
    }
    saveJson(HISTORY_FILE, globalHistory);
    console.log('[CRON] Daily update complete (Baseline Reset).');
}, {
    scheduled: true,
    timezone: "Asia/Ho_Chi_Minh"
});

cron.schedule('*/30 * * * *', async () => {
    console.log('\n[CRON] Starting 30-Minute Data Refresh...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    console.log(`[CRON-30m] Active users: ${users.length}.`);
});

// --- ROUTES ---

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
    res.status(404).json({ error: "List empty" });
});

app.get('/views', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ error: 'Username required' });

    const targetUsername = user.toString().replace('@', '').trim();
    addToWatchedUsers(targetUsername);

    const globalHistory = loadJson(HISTORY_FILE);
    const userHistory = globalHistory[targetUsername] || {}; 

    const result = await performScrape(targetUsername);

    if (result.error && (result.error.includes("User not found") || result.error.includes("Private"))) {
        return res.status(404).json({ error: "User not found or Account is Private" });
    }
    
    if (result.videos.length === 0 && result.error) {
        return res.status(500).json({ error: result.error || "Failed to fetch from TikTok" });
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

        if (isFirstTime && newHistoryMap) {
            newHistoryMap[video.id] = video.numericViews;
        }

        return { 
            ...video, 
            change: change,
            changePercent: parseFloat(changePercent.toFixed(2))
        };
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

// Start Server and then Initialize Browser
app.listen(PORT, async () => {
    console.log(`Backend Server running on http://localhost:${PORT}`);
    console.log(`Mode: PERSISTENT SESSION (Single Browser Instance).`);
    // Launch the browser once when server starts
    await initBrowser();
});
