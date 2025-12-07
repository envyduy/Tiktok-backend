import express from 'express';
import { chromium } from 'playwright';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

const app = express();
const PORT = 3001;
const SESSION_FILE = 'tiktok_session.json';
const CACHE_FILE = 'tiktok_data_cache.json'; // Stores Covers AND Latest Video Data
const HISTORY_FILE = 'tiktok_view_history.json'; // Stores Baseline for Midnight Reset
const WATCHED_USERS_FILE = 'watched_users.json'; // List of users
const TARGET_VIDEO_COUNT = 200;

app.use(cors());

// --- Helper Functions ---

const parseViewCount = (str) => {
  if (!str) return 0;
  if (typeof str === 'number') return str; 
  const s = str.toString().toUpperCase();
  const multiplier = s.endsWith('M') ? 1000000 : 
                     s.endsWith('K') ? 1000 : 1;
  const num = parseFloat(s.replace(/[^\d.]/g, ''));
  return Math.floor(num * multiplier);
};

// Load/Save JSON helpers
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

/**
 * Core scraping logic function
 */
const performScrape = async (username, isHeadless) => {
    console.log(`[Scraper] Launching browser (Headless: ${isHeadless})...`);
    
    let browser = null;
    let videos = [];
    let sessionData = null;

    try {
        browser = await chromium.launch({
            headless: isHeadless,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-infobars',
                '--window-size=1280,800',
                isHeadless ? '' : '--start-maximized'
            ].filter(Boolean)
        });

        const contextOptions = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            permissions: ['geolocation'],
            javaScriptEnabled: true,
        };

        if (fs.existsSync(SESSION_FILE)) {
            try {
                const savedSession = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
                contextOptions.storageState = savedSession;
            } catch(e) {}
        }

        const context = await browser.newContext(contextOptions);
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const page = await context.newPage();
        const url = `https://www.tiktok.com/@${username}`;
        
        try {
            const timeout = isHeadless ? 30000 : 60000;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout });
        } catch (e) {
            console.log('[Scraper] Navigation timeout or interrupt.');
        }

        // Improved Scroll Logic
        let noNewVideosCount = 0;
        let previousVideoCount = 0;

        for (let i = 0; i < 50; i++) { // Slightly reduced loops for speed
            const currentCount = await page.locator('[data-e2e="user-post-item"]').count();
            if (currentCount >= TARGET_VIDEO_COUNT) break;

            if (currentCount === previousVideoCount && currentCount > 0) {
                noNewVideosCount++;
                await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
                await page.waitForTimeout(1500);
                if (noNewVideosCount >= 5) break;
            } else {
                noNewVideosCount = 0;
                await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                await page.waitForTimeout(800); 
            }
            previousVideoCount = currentCount;
        }
        
        // Final Jiggle
        await page.evaluate(() => window.scrollBy(0, -600)); 
        await page.waitForTimeout(500); 
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000); 

        // Extract
        const domVideos = await page.$$eval('[data-e2e="user-post-item"]', (elements) => {
            return elements.map(el => {
                const linkEl = el.querySelector('a');
                const viewEl = el.querySelector('[data-e2e="video-views"]');
                const imgEl = el.querySelector('img'); 
                
                let id = '';
                if (linkEl && linkEl.href) {
                    const match = linkEl.href.match(/video\/(\d+)/);
                    if (match) id = match[1];
                }

                let coverSrc = '';
                if (imgEl) {
                    coverSrc = imgEl.src;
                    if ((!coverSrc || coverSrc.length < 50) && imgEl.srcset) coverSrc = imgEl.srcset.split(',')[0].split(' ')[0];
                }
                
                return {
                    id: id,
                    url: linkEl ? linkEl.href : '',
                    cover: coverSrc,
                    views: viewEl ? viewEl.innerText : '0'
                };
            });
        });

        if (domVideos.length > 0) {
            videos = domVideos.slice(0, TARGET_VIDEO_COUNT).map((v, i) => ({
                id: v.id || `vid_${i}`,
                url: v.url,
                cover: v.cover,
                views: v.views,
                numericViews: parseViewCount(v.views)
            }));
            sessionData = await context.storageState();
        }

    } catch (e) {
        console.error(`[Scraper] Error:`, e.message);
    } finally {
        if (browser) await browser.close();
    }

    return { videos, sessionData };
};

// --- Cron Job 1: Midnight Reset (00:00) ---
cron.schedule('0 0 * * *', async () => {
    console.log('\n[CRON] Starting Daily Midnight Update...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    if (users.length === 0) return;

    const globalHistory = loadJson(HISTORY_FILE);

    for (const user of users) {
        console.log(`[CRON-Mid] Updating baseline for: ${user}`);
        try {
            const result = await performScrape(user, true);
            if (result.videos.length > 0) {
                const newHistoryMap = {};
                result.videos.forEach(v => { newHistoryMap[v.id] = v.numericViews; });
                globalHistory[user] = newHistoryMap;
            }
        } catch (e) { console.error(`[CRON-Mid] Error ${user}`, e); }
    }
    saveJson(HISTORY_FILE, globalHistory);
    console.log('[CRON] Daily update complete.');
});

// --- Cron Job 2: Every 30 Minutes Update (*/30 * * * *) ---
cron.schedule('*/30 * * * *', async () => {
    console.log('\n[CRON] Starting 30-Minute Data Refresh...');
    const watched = loadJson(WATCHED_USERS_FILE);
    const users = watched.list || [];
    if (users.length === 0) return;

    const globalCache = loadJson(CACHE_FILE);

    for (const user of users) {
        console.log(`[CRON-30m] Refreshing data for: ${user}`);
        try {
            const result = await performScrape(user, true);
            if (result.videos.length > 0) {
                // We update the CACHE so when users visit, it's fast (optional) or just to keep data fresh
                // In this architecture, we primarily use the cache for covers, but let's store latest videos too
                // Note: The /views endpoint usually does a fresh scrape, but we can optimize later.
                // For now, this ensures the server is active and cookies stay fresh.
                
                // Update Cache with covers
                const userCache = globalCache[user] || {};
                result.videos.forEach(v => {
                    if (v.cover && v.cover.length > 50) userCache[v.id] = v.cover;
                });
                globalCache[user] = userCache;
                console.log(`[CRON-30m] Refreshed ${user}.`);
            }
        } catch (e) { console.error(`[CRON-30m] Error ${user}`, e); }
    }
    saveJson(CACHE_FILE, globalCache);
    console.log('[CRON] 30-Minute refresh complete.');
});

// --- Routes ---

app.get('/watched', (req, res) => {
    const data = loadJson(WATCHED_USERS_FILE);
    res.json(data.list || []);
});

app.get('/views', async (req, res) => {
  const { user } = req.query;
  if (!user) return res.status(400).json({ error: 'Username required' });

  const targetUsername = user.toString().replace('@', '').trim();
  console.log(`\n[Scraper] === Processing: ${targetUsername} ===`);

  addToWatchedUsers(targetUsername);

  const globalCache = loadJson(CACHE_FILE);
  const globalHistory = loadJson(HISTORY_FILE);
  const userCache = globalCache[targetUsername] || {}; 
  const userHistory = globalHistory[targetUsername] || {}; 

  let finalVideos = [];
  
  // Try headless scrape first
  const result = await performScrape(targetUsername, true); 
  finalVideos = result.videos;
  if (result.sessionData) fs.writeFileSync(SESSION_FILE, JSON.stringify(result.sessionData, null, 2));

  // If failed, try visible (rarely needed if cron keeps cookies fresh)
  if (finalVideos.length === 0) {
      console.log('[Scraper] Retry visible...');
      const resVis = await performScrape(targetUsername, false); 
      finalVideos = resVis.videos;
  }

  if (finalVideos.length > 0) {
      let isFirstTime = Object.keys(userHistory).length === 0;
      const newHistoryMap = isFirstTime ? {} : null;

      finalVideos = finalVideos.map(video => {
          // Cache logic
          let effectiveCover = video.cover;
          if ((!effectiveCover || effectiveCover.length < 50) && userCache[video.id]) {
              effectiveCover = userCache[video.id];
          } else if (effectiveCover && effectiveCover.length > 50) {
              userCache[video.id] = effectiveCover;
          }

          // History Logic
          const previousViews = userHistory[video.id];
          let change = 0;
          let changePercent = 0;

          if (previousViews !== undefined) {
              change = video.numericViews - previousViews;
              if (previousViews > 0) changePercent = (change / previousViews) * 100;
              else if (change > 0) changePercent = 100; 
          }

          if (isFirstTime && newHistoryMap) newHistoryMap[video.id] = video.numericViews;

          return { 
              ...video, 
              cover: effectiveCover,
              change: change,
              changePercent: parseFloat(changePercent.toFixed(2))
          };
      });

      globalCache[targetUsername] = userCache;
      saveJson(CACHE_FILE, globalCache);

      if (isFirstTime) {
          globalHistory[targetUsername] = newHistoryMap;
          saveJson(HISTORY_FILE, globalHistory);
      }
  }

  if (finalVideos.length === 0) {
      return res.status(500).json({ error: 'Failed to scrape. Try again.' });
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
});