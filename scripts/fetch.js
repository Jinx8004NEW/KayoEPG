// scripts/fetch.js
// Scheduled collector - runs every 4 hours from .github/workflows/fetch-schedule.yml
//
// Two Kayo sources, because neither one alone is enough:
//
//   Livetvschedule  12 linear channels, full schedules with descriptions, but
//                   only Now/Next/Later from this instant - no date parameter,
//                   no history, no programme IDs, no 4K flags. Unauthenticated.
//   epgWithDatesRange  fixtures only, but carries 4K flags and accepts a date
//                   range. Geo-restricted, so it uses the proxy.
//
// The linear half ACCUMULATES: a run only ever sees forward, so day files are
// merged rather than overwritten. Overwrite and the 20:00 run would wipe what
// aired at 09:00. See mergeIntoDayFile().
//
// Date bucketing: IST (Asia/Kolkata) throughout. The frontend re-buckets into
// the viewer's timezone at render time, so a day file can span two local dates.

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ── Optional proxy, used for the 4K (epgWithDatesRange) calls only ────────────
// The Livetvschedule endpoint is not geo-restricted and never uses it.
function buildDaznProxyAgent() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  if (!host || !port) return null; // no proxy configured, falls back to direct
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  const auth = (user && pass) ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return new HttpsProxyAgent(`http://${auth}${host}:${port}`);
}
const DAZN_PROXY_AGENT = buildDaznProxyAgent();

// ── Linear channels ───────────────────────────────────────────────────────────
// Keyed by Kayo's channel AssetId, which is stable - the display Title is not.
// Tags match the FoxtelEPG repo so both guides share one data format.
const LINEAR_CHANNELS = [
  { assetId: '1ns8p240ac6bz1ovcbxx538enp', tag: 'FSN', name: 'Fox Sports News', number: '500' },
  { assetId: 'jo74ryszmcvd1pzmbzp50q84a',  tag: 'FS1', name: 'Fox Cricket',     number: '501' },
  { assetId: '1tc0mhfzkbbti165v1rsuewtek', tag: 'SP2', name: 'Fox League',      number: '502' },
  { assetId: 'xjauo23ins1b1hnss5covnvxw',  tag: 'FS3', name: 'Fox Sports 503',  number: '503' },
  { assetId: '1l47a9ir5hj0o1wi5j0pkm5fpb', tag: 'FAF', name: 'Fox Footy',       number: '504' },
  { assetId: '12555dnxvg0f319t9w1tgjdvid', tag: 'FSP', name: 'Fox Sports 505',  number: '505' },
  { assetId: '231pfo674jx615m2uo32ahsex',  tag: 'SPS', name: 'Fox Sports 506',  number: '506' },
  { assetId: '17eyitoe96uwb1qbwz8r6dplok', tag: 'FSS', name: 'Fox Sports 507',  number: '507' },
  { assetId: 'lbod12u9fiwx17r3cpnjxagrb',  tag: 'ESP', name: 'ESPN',            number: '508' },
  { assetId: '7n14fwhpjix71fdn6iyz6jabd',  tag: 'ES2', name: 'ESPN2',           number: '509' },
  { assetId: '5nfomyujg3z610ssm0szjoef4',  tag: 'UFC', name: 'Mainevent UFC',   number: '523' },
  { assetId: 'e5okck7f0rny12j9xv1kc9w12',  tag: 'RTV', name: 'Racing.com',      number: '529' },
];

// Fallback for a channel whose AssetId changes - matched on display title.
const TITLE_TO_TAG = {};
for (const c of LINEAR_CHANNELS) TITLE_TO_TAG[c.name.toLowerCase()] = c.tag;

// ── 4K channels - epgWithDatesRange ───────────────────────────────────────────
const CHANNELS_4K = [
  { tag: '4KL',  name: 'Fox League 4K'  },
  { tag: '4KF1', name: 'Fox F1 4K'      },
  { tag: '4KF',  name: 'Fox Footy 4K'   },
  { tag: '4KF2', name: 'Fox Footy 2 4K' },
  { tag: '4KN',  name: 'Fox Netball 4K' },
];

const PROVIDER_TO_4K = {
  'fsa501': '4KL',
  'fsa502': '4KL',
  'fsa506': '4KF1',
  'fsa504': '4KF',
  'fsa503': '4KF2',
  'fsa505': '4KN',
};

// Competitions broadcast in 4K without exception, so the API flag can be skipped.
// Cricket is not here: only Australia men's home matches go out in 4K, and fsa501
// routes all cricket to Fox League 4K, so it needs the explicit is4k flag or the
// guide fills with 4K fixtures that were never broadcast that way.
const GUARANTEED_4K_COMPS = new Set(['AFL', 'Formula 1', 'Suncorp Super Netball']);

const DURATION_FALLBACK = {
  'Australian Rules Football': 130,
  'Netball':                    90,
  'Formula 1':                 180,
  'Rugby League':              100,
  'Cricket':                   480,
};
const DEFAULT_DURATION = 120;

// Retention window in cleanup.js (21 days) plus today and the furthest day
// fetched ahead. The 4K feed reaches +6; the linear feed about +2. Keep in sync
// with MAX_DAYS in cleanup.js.
const MAX_INDEX_DATES = 28;

// ── Shared helpers ────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

function getKayoHeaders() {
  return {
    'User-Agent':      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin':          'https://kayosports.com.au',
    'Referer':         'https://kayosports.com.au/',
    'x-brand':         'kayo',
    'Sec-Fetch-Dest':  'empty',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Site':  'cross-site',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Day boundaries in IST. Returns the date string plus the epoch-ms bounds of that
// day - file naming, index entries and cleanup arithmetic all key off this.
function getISTDay(offset = 0) {
  const base = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
  base.setDate(base.getDate() + offset);
  const date    = base.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const startMs = new Date(date + 'T00:00:00+05:30').getTime();
  const endMs   = new Date(date + 'T23:59:59+05:30').getTime();
  return { date, startMs, endMs };
}

function msToISTDate(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function parseUtcMs(s) {
  if (!s) return null;
  const d = new Date(s.endsWith('Z') ? s : s + 'Z');
  return isNaN(d.getTime()) ? null : d.getTime();
}

function fetchJson(url, customHeaders, agent) {
  return new Promise((resolve, reject) => {
    const opts = { headers: customHeaders || getKayoHeaders(), timeout: 30000 };
    if (agent) opts.agent = agent;
    const req = https.get(url, opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchJson(res.headers.location, customHeaders, agent).then(resolve).catch(reject);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')         stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Linear backoff - 4s, then 8s. Upstream failures are usually transient.
async function fetchWithRetry(url, max = 3, customHeaders, agent) {
  for (let i = 1; i <= max; i++) {
    try { return await fetchJson(url, customHeaders, agent); }
    catch (e) {
      console.log(`  Attempt ${i}/${max} failed: ${e.message}`);
      if (i < max) await sleep(i * 4000); else throw e;
    }
  }
}

// The frontend can't list a directory over the raw CDN, so available dates are
// published explicitly in data/index.json.
function updateIndex(tag, date) {
  const indexPath = path.join('data', 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
  if (!index[tag]) index[tag] = [];
  if (!index[tag].includes(date)) {
    index[tag].push(date);
    index[tag].sort((a, b) => b.localeCompare(a));
    index[tag] = index[tag].slice(0, MAX_INDEX_DATES);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

function ensureGitkeep() {
  for (const ch of CHANNELS_4K) {
    const dir = path.join('data', ch.tag);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  DAY FILE MERGE
//
//  The linear feed has no programme IDs, so scheduledDate is the key. It is a
//  good one: start times are exact to the second and two programmes cannot
//  begin at the same instant on one channel.
//
//  On collision the incoming entry wins. Schedules get revised when a fixture
//  is abandoned and the slot is refilled, and the newer fetch is the truer one.
// ═════════════════════════════════════════════════════════════════════════════

function mergeIntoDayFile(tag, date, incoming, todayIST) {
  const dir      = path.join('data', tag);
  const filePath = path.join(dir, `${date}.json`);

  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf8')).events || [];
  } catch { /* first write for this day */ }

  const byStart = new Map();
  for (const ev of existing) byStart.set(ev.scheduledDate, ev);
  let added = 0, updated = 0;
  for (const ev of incoming) {
    if (byStart.has(ev.scheduledDate)) updated++; else added++;
    byStart.set(ev.scheduledDate, ev);
  }

  const events = Array.from(byStart.values()).sort((a, b) => a.scheduledDate - b.scheduledDate);

  const payload = {
    channel:      tag,
    date,
    source:       'kayo',
    fetchedAt:    Date.now(),
    fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    events,
  };

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  if (date === todayIST)
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));

  updateIndex(tag, date);
  return { total: events.length, added, updated };
}

// ═════════════════════════════════════════════════════════════════════════════
//  LINEAR SECTION - Livetvschedule
// ═════════════════════════════════════════════════════════════════════════════

const RAIL_URL = 'https://rail-router.discovery.indazn.com/eu/v10/Rail'
               + '?platform=web&id=Livetvschedule&country=au&brand=kayo&languageCode=en';

// Linear entries carry image IDs but the CDN has no asset behind them - every
// request comes back as the Kayo logo placeholder. Left empty; the frontend
// already renders events without an image.
function mapLinearEvent(entry) {
  const startMs = parseUtcMs(entry.Start);
  const endMs   = parseUtcMs(entry.End);
  if (!startMs) return null;

  const duration = (endMs && endMs > startMs)
    ? Math.round((endMs - startMs) / 60000)
    : DEFAULT_DURATION;

  const genre = Array.isArray(entry.Genre)
    ? entry.Genre.map(g => g && g.name).filter(Boolean).join(', ')
    : '';

  return {
    programTitle:   entry.Title || '',
    episodeTitle:   entry.EpisodeTitle || '',
    description:    entry.Description || '',
    scheduledDate:  startMs,
    duration,
    parentalRating: entry.TvRating || '',
    programType:    entry.ProgramType || '',
    genre,
    imageUrl:       '',
  };
}

async function fetchLinearSection(todayIST) {
  const data  = await fetchWithRetry(RAIL_URL, 3, getKayoHeaders(), null);
  const tiles = (data && data.Tiles) || [];
  console.log(`  Got ${tiles.length} channel tiles`);

  let failed = 0;

  for (const ch of LINEAR_CHANNELS) {
    let tile = tiles.find(t => t.AssetId === ch.assetId);
    if (!tile) {
      // AssetId churn - fall back to the display title before giving up
      tile = tiles.find(t => TITLE_TO_TAG[String(t.Title || '').toLowerCase()] === ch.tag);
      if (tile) console.log(`  [${ch.tag}] matched by title, AssetId may have changed`);
    }
    if (!tile) {
      console.log(`  [${ch.tag}] not present in response`);
      failed++;
      continue;
    }

    const ls  = tile.LinearSchedule || {};
    const raw = [];
    if (ls.Now)  raw.push(ls.Now);
    if (ls.Next) raw.push(ls.Next);
    for (const e of (ls.Later || [])) raw.push(e);

    const mapped = raw.map(mapLinearEvent).filter(Boolean);
    if (!mapped.length) {
      console.log(`  [${ch.tag}] no events`);
      failed++;
      continue;
    }

    // One channel's entries can span three IST days; group before writing.
    const byDate = new Map();
    for (const ev of mapped) {
      const d = msToISTDate(ev.scheduledDate);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(ev);
    }

    const parts = [];
    for (const [date, events] of Array.from(byDate).sort()) {
      const r = mergeIntoDayFile(ch.tag, date, events, todayIST);
      parts.push(`${date}: ${r.total} (+${r.added})`);
    }
    console.log(`  [${ch.tag}] ${ch.name} - ${parts.join(', ')}`);
  }

  return failed;
}

// ═════════════════════════════════════════════════════════════════════════════
//  4K SECTION - epgWithDatesRange
//
//  4K events = explicitly flagged by API (is4k:true) OR guaranteed competition.
//  Unlike the linear half this feed accepts a date range and returns whole days,
//  so files are written outright rather than merged.
// ═════════════════════════════════════════════════════════════════════════════

function buildImageUrl4K(imageField) {
  const BASE = 'https://image.discovery.indazn.com/jp/v3/jp/none';
  if (imageField && typeof imageField === 'object') {
    const id = imageField.Id || '';
    if (id) return `${BASE}/${id}/fill/none/top/none/80/1920/1080/webp/image?brand=kayo`;
  }
  if (typeof imageField === 'string' && imageField.startsWith('http')) return imageField;
  return '';
}

async function fetchDaznRaw(startDate, endDate) {
  const params = new URLSearchParams({
    country:        'au',
    languageCode:   'en',
    openBrowse:     'true',
    timeZoneOffset: '570',
    startDate,
    endDate,
    brand:          'kayo',
  });
  const url  = `https://epg.discovery.indazn.com/eu/v5/epgWithDatesRange?${params}`;
  const data = await fetchWithRetry(url, 3, getKayoHeaders(), DAZN_PROXY_AGENT);
  const days = Array.isArray(data) ? data : [data];
  const raw  = [];
  for (const day of days) {
    for (const event of (day.Tiles || [])) raw.push(event);
  }
  return raw;
}

function process4KEvents(rawEvents) {
  const durById = new Map();
  for (const ev of rawEvents) {
    const eid     = String(ev.EventId || ev.Id || '');
    const startMs = parseUtcMs(ev.EventStartTime || ev.Start || '');
    const endMs   = parseUtcMs(ev.EventEndTime   || ev.End   || '');
    if (eid && startMs && endMs) {
      const dur = Math.round((endMs - startMs) / 60000);
      if (dur > 0) durById.set(eid, dur);
    }
  }

  const processed = [];
  const seen      = new Set();

  for (const ev of rawEvents) {
    const epgCode = PROVIDER_TO_4K[ev.LinearProvider || ''];
    if (!epgCode) continue;

    const he         = ev.HeEventTypeConfig || {};
    const explicit4k = he.is4k === true || he.is4kUpscaled === true;
    const comp       = ev.Competition || {};
    const compTitle  = (typeof comp === 'object' ? comp.Title : '') || '';
    if (!explicit4k && !GUARANTEED_4K_COMPS.has(compTitle)) continue;

    const startMs = parseUtcMs(ev.EventStartTime || ev.Start || '');
    if (!startMs) continue;
    const eid = String(ev.EventId || ev.Id || '');
    if (!eid) continue;

    // The past and future range calls overlap at today, so the same event arrives twice
    const dedupKey = `${epgCode}:${eid}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const sport      = ev.Sport || {};
    const sportTitle = (typeof sport === 'object' ? sport.Title : '') || '';

    processed.push({
      epgCode,
      istDate:          msToISTDate(startMs),
      eventId:          eid,
      programTitle:     ev.Title || '',
      scheduledDate:    startMs,
      duration:         durById.get(eid) || DURATION_FALLBACK[sportTitle] || DEFAULT_DURATION,
      imageUrl:         buildImageUrl4K(ev.ImageUrl || ev.ImageURL || ev.Image || ev.Thumbnail || {}),
      competitionTitle: compTitle,
      sport:            sportTitle,
    });
  }

  return processed;
}

function write4KFiles(processed, todayIST) {
  const groups = new Map();
  for (const ev of processed) {
    const key = `${ev.epgCode}::${ev.istDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  let written = 0;

  for (const [key, events] of groups) {
    const [tag, date] = key.split('::');
    events.sort((a, b) => a.scheduledDate - b.scheduledDate);

    const payload = {
      channel:      tag,
      date,
      source:       'kayo-4k',
      fetchedAt:    Date.now(),
      fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      events:       events.map(({ epgCode, istDate, ...rest }) => rest),
    };

    const dir = path.join('data', tag);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(payload, null, 2));
    if (date === todayIST)
      fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2));

    updateIndex(tag, date);
    console.log(`  [${tag}] ${date}: ${payload.events.length} events`);
    written++;
  }

  return written;
}

async function fetch4KSection(todayIST) {
  const pastStr   = getISTDay(-6).date;
  const futureStr = getISTDay(6).date;
  let allRaw = [];

  console.log(`  Call 1 (past):   ${pastStr} -> ${todayIST}`);
  try {
    const raw1 = await fetchDaznRaw(pastStr, todayIST);
    console.log(`  Got ${raw1.length} raw events`);
    allRaw = allRaw.concat(raw1);
  } catch (e) {
    console.log(`  Past call failed: ${e.message}`);
  }

  await sleep(2000);

  console.log(`  Call 2 (future): ${todayIST} -> ${futureStr}`);
  try {
    const raw2 = await fetchDaznRaw(todayIST, futureStr);
    console.log(`  Got ${raw2.length} raw events`);
    allRaw = allRaw.concat(raw2);
  } catch (e) {
    console.log(`  Future call failed: ${e.message}`);
  }

  console.log(`  Total raw: ${allRaw.length}`);

  const processed = process4KEvents(allRaw);
  const byCh = {};
  for (const ev of processed) byCh[ev.epgCode] = (byCh[ev.epgCode] || 0) + 1;
  for (const ch of CHANNELS_4K)
    console.log(`  ${ch.name} (${ch.tag}): ${byCh[ch.tag] || 0} events`);

  const written = write4KFiles(processed, todayIST);
  console.log(`  ${written} files written`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════

(async () => {
  const todayIST = getISTDay(0).date;
  console.log(`Kayo EPG collector - ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  console.log(`Today (IST): ${todayIST}\n`);

  if (!fs.existsSync('data')) fs.mkdirSync('data');
  ensureGitkeep();

  let linearFailed = 0;

  console.log('== LINEAR CHANNELS (Livetvschedule) =====================');
  try {
    linearFailed = await fetchLinearSection(todayIST);
  } catch (e) {
    console.error(`Linear section failed: ${e.message}`);
    linearFailed = LINEAR_CHANNELS.length;
  }

  console.log('\n== 4K CHANNELS (epgWithDatesRange) ======================');
  console.log(DAZN_PROXY_AGENT
    ? `  Using proxy: ${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`
    : '  No proxy configured (direct connection)');
  try {
    await fetch4KSection(todayIST);
  } catch (e) {
    console.error(`4K section failed: ${e.message}`);
  }

  // Only the linear half is fatal. The 4K feed is geo-restricted and expected to
  // fail intermittently; a red run for that would train you to ignore red runs.
  if (linearFailed === LINEAR_CHANNELS.length) {
    console.error('\nAll linear channels failed.');
    process.exit(1);
  }
  console.log(`\nDone. ${LINEAR_CHANNELS.length - linearFailed}/${LINEAR_CHANNELS.length} linear channels collected.`);
})();
