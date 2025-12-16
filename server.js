import express from 'express';
import cors from 'cors';
import fs from 'fs';
import cron from 'node-cron';
import dotenv from 'dotenv';
import fetch from 'node-fetch'; // Standard fetch, no browser required

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONSTANTS ---
const HISTORY_FILE = 'tiktok_view_history.json';
const WATCHED_USERS_FILE = 'watched_users.json';
const TARGET_VIDEO_COUNT = 200; 

// Fake User Agent to look like a real browser request
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json());

// --- Helper Functions: Utils ---

const parseViewCount = (str) => {
    if (!str) return 0;
    if (typeof str === 'number') return str;
    return parseInt(str.toString().replace(/,/g, ''), 10) || 0;
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

// --- SCRAPING LOGIC (API BASED - NO BROWSER) ---
// We switch from scraping HTML to using the Countik API which is friendlier to server IPs.

async function fetchVideosFromApi(username) {
    let allVideos = [];
    let cursor = 0; // Countik uses numeric cursor (offset) usually, or ID based
    let hasMore = true;
    let loops = 0;
    const MAX_LOOPS = 10;
    
    console.log(`[API] Starting fetch for @${username}...`);

    try {
        // STEP 1: Get User ID
        // URL: https://countik.com/api/exist/{username}
        const userRes = await fetch(`https://countik.com/api/exist/${username}`, {
            headers: { 'User-Agent': USER_AGENT }
        });
        
        if (!userRes.ok) throw new Error(`Failed to resolve user: ${userRes.status}`);
        const userData = await userRes.json();
        
        if (!userData.id) {
            throw new Error("User not found or ID missing");
        }

        const userId = userData.id;
        console.log(`[API] Resolved @${username} to ID: ${userId}`);

        // STEP 2: Fetch Videos Loop
        // URL: https://countik.com/api/user/posts/{user_id}?cursor={cursor}
        
        while (allVideos.length < TARGET_VIDEO_COUNT && hasMore && loops < MAX_LOOPS) {
            loops++;
            const vidUrl = `https://countik.com/api/user/posts/${userId}?cursor=${cursor}`;
            
            const vidRes = await fetch(vidUrl, {
                headers: { 'User-Agent': USER_AGENT }
            });

            if (!vidRes.ok) {
                console.error(`[API] Error fetching videos: ${vidRes.status}`);
                break;
            }

            const vidJson = await vidRes.json();
            const videos = vidJson.videos || [];

            if (videos.length === 0) {
                hasMore = false;
                break;
            }

            allVideos = allVideos.concat(videos);
            console.log(`[API] Loop ${loops}: Got ${videos.length} videos. Total: ${allVideos.length}`);

            if (vidJson.cursor) {
                cursor = vidJson.cursor; // Update cursor for next page
                await sleep(500); // Be polite
            } else {
                hasMore = false;
            }
        }
        
        // --- NORMALIZE DATA ---
        // Countik data structure -> App structure
        const normalized = allVideos.map(v => {
            const playCount = v.playCount || 0;
            return {
                id: v.id,
                url: `https://www.tiktok.com/@${username}/video/${v.id}`,
                cover: v.cover, // Countik provides a proxy-friendly cover URL usually
                views: formatViewCount(playCount),
                numericViews: playCount
            };
        });

        // Deduplicate
        const uniqueVideos = [];
        const seen = new Set();
        for (const v of normalized) {
            if (!seen.has(v.id)) {
                seen.add(v.id);
                uniqueVideos.push(v);
            }
        }

        return uniqueVideos.slice(0, TARGET_VIDEO_COUNT);

    } catch (e) {
        console.error(`[API] Exception:`, e.message);
        throw e;
    }
}

// --- MAIN SCRAPE HANDLER ---

async function performScrape(username) {
    try {
        const cleanUser = username.replace('@', '');
        const videos = await fetchVideosFromApi(cleanUser);
        return { videos, userId: cleanUser };
    } catch (e) {
        console.error(`[Scraper] Exception: ${e.message}`);
        return { error: e.message, videos: [] };
    }
}

// --- CRON JOBS ---

// Cron Job 1: 7:00 AM Reset (Vietnam Time)
// Logic: At 7:00 AM, we fetch the current views and save them as the "Baseline".
// Any subsequent view calculation will be (Current - Baseline).
// This effectively resets the "Growth" counter for the new day.
cron.schedule('0 7 * * *', async () => {
    console.log('\n[CRON] Starting Daily Morning Update (7:00 AM VN)...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    const globalHistory = loadJson(HISTORY_FILE);

    for (const user of users) {
        console.log(`[CRON-Mid] Updating baseline for: ${user}`);
        await sleep(2000); // Small delay
        
        const result = await performScrape(user);
        if (result.videos.length > 0) {
            const newHistoryMap = {};
            // Set new baseline
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
    // Note: We don't necessarily need to scrape here unless we want to cache data.
    // The frontend triggers scrapes on demand, or we could auto-scrape here.
    // For now, we just log activity.
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

    if (result.error) {
         // Fallback or error state
        if (result.error.includes("User not found")) {
            return res.status(404).json({ error: "User not found" });
        }
        return res.status(500).json({ error: "Failed to fetch data from API" });
    }
    
    let finalVideos = result.videos;
    const isFirstTime = Object.keys(userHistory).length === 0;
    const newHistoryMap = isFirstTime ? {} : null;

    // Process Change
    finalVideos = finalVideos.map(video => {
        const previousViews = userHistory[video.id];
        let change = 0;
        let changePercent = 0;

        // If previousViews exists, it means we have a baseline from 7:00 AM (or whenever user was first added)
        if (previousViews !== undefined) {
            change = video.numericViews - previousViews;
            if (previousViews > 0) changePercent = (change / previousViews) * 100;
            else if (change > 0) changePercent = 100;
        }

        // If this is the first time tracking this user, we build the initial history map
        if (isFirstTime && newHistoryMap) {
            newHistoryMap[video.id] = video.numericViews;
        }

        return { 
            ...video, 
            change: change,
            changePercent: parseFloat(changePercent.toFixed(2))
        };
    });

    // If first time, save the baseline immediately so next view shows 0 change until actual growth happens
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

app.listen(PORT, () => {
    console.log(`Backend Server running on http://localhost:${PORT}`);
    console.log(`Mode: Light API (Countik) - Railway Friendly`);
});
