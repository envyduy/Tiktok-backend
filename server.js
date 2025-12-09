import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONSTANTS ---
const HISTORY_FILE = 'tiktok_view_history.json';
const WATCHED_USERS_FILE = 'watched_users.json';
const TARGET_VIDEO_COUNT = 200; 

app.use(cors());
app.use(express.json());

// --- Helper Functions: Utils ---

const parseViewCount = (str) => {
    if (!str) return 0;
    // Handle raw numbers (TikWM returns raw numbers mostly)
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

// --- SCRAPING LOGIC (TIKWM AGGREGATOR) ---
// Docs Reference: Public endpoints from TikWM/TikMate usually follow /api/user/posts

async function fetchVideosFromTikWM(username) {
    let allVideos = [];
    let cursor = 0;
    let hasMore = true;
    let loops = 0;
    const MAX_LOOPS = 10; // Prevent infinite loops

    console.log(`[TikWM] Fetching videos for @${username} (Target: ${TARGET_VIDEO_COUNT})...`);

    while (allVideos.length < TARGET_VIDEO_COUNT && hasMore && loops < MAX_LOOPS) {
        loops++;
        // Endpoint: https://www.tikwm.com/api/user/posts?unique_id={username}&count={count}&cursor={cursor}
        const url = `https://www.tikwm.com/api/user/posts?unique_id=${username}&count=33&cursor=${cursor}`;
        
        try {
            const response = await fetch(url);
            const contentType = response.headers.get("content-type");
            
            if (!response.ok) {
                console.error(`[TikWM] Error status: ${response.status}`);
                break;
            }

            if (!contentType || !contentType.includes("application/json")) {
                console.error(`[TikWM] Invalid content type. Probably rate limited.`);
                break;
            }

            const json = await response.json();

            if (json.code !== 0) {
                // Code 0 usually means success
                console.warn(`[TikWM] API returned code ${json.code}: ${json.msg}`);
                // If user not found or private
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
            console.log(`[TikWM] Loop ${loops}: Got ${videos.length} videos. Total: ${allVideos.length}`);

            if (data.hasMore && data.cursor) {
                cursor = data.cursor;
                // Important: Sleep to avoid rate limiting from the aggregator
                await sleep(1000); 
            } else {
                hasMore = false;
            }

        } catch (e) {
            console.error(`[TikWM] Exception:`, e.message);
            if (loops === 1) throw e;
            break;
        }
    }

    // --- NORMALIZE DATA ---
    // Map TikWM format to our App format
    const normalized = allVideos.map(v => {
        const playCount = v.play_count || 0;
        return {
            id: v.video_id || v.id, // TikWM usually uses video_id
            url: `https://www.tiktok.com/@${username}/video/${v.video_id}`,
            cover: v.cover || v.origin_cover, // Web compatible URL
            views: formatViewCount(playCount),
            numericViews: playCount
        };
    });

    // Deduplicate based on ID just in case
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
        // Remove '@' if present
        const cleanUser = username.replace('@', '');
        const videos = await fetchVideosFromTikWM(cleanUser);
        
        return { videos, userId: cleanUser };
    } catch (e) {
        console.error(`[Scraper] Exception: ${e.message}`);
        // Return friendly error
        return { error: e.message, videos: [] };
    }
}

// --- CRON JOBS ---

// Cron Job 1: 7:00 AM Reset (Vietnam Time)
// Configured with timezone "Asia/Ho_Chi_Minh" to ensure correct daily reset.
cron.schedule('0 7 * * *', async () => {
    console.log('\n[CRON] Starting Daily Morning Update (7:00 AM VN)...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    const globalHistory = loadJson(HISTORY_FILE);

    for (const user of users) {
        console.log(`[CRON-Mid] Updating baseline for: ${user}`);
        // Add random delay to prevent rate limits
        await sleep(Math.random() * 5000 + 2000);
        
        const result = await performScrape(user);
        if (result.videos.length > 0) {
            const newHistoryMap = {};
            // This REPLACES the old history with current views.
            // effectively "resetting" the counter for the new day.
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

// Cron Job 2: Every 30 Minutes
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

    // CALL API
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

    // Process Change (Compare against history)
    finalVideos = finalVideos.map(video => {
        const previousViews = userHistory[video.id];
        let change = 0;
        let changePercent = 0;

        // Calculate change based on the baseline set at midnight (or first load)
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
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend Server running on port ${PORT}`);
    console.log(`Mode: TikWM API Aggregator (Bypasses Railway CAPTCHA)`);
});
