// scripts/cleanup.js
// Retention. Runs after every fetch and drops day files past the window, then
// resyncs data/index.json against what is actually on disk. latest.json is
// never touched.

const fs   = require('fs');
const path = require('path');

const MAX_DAYS = 21;

const CHANNELS = [
  'FSN','FS1','SP2','FS3','FAF','FSP','SPS','FSS','ESP','ES2','UFC','RTV',
  '4KL','4KF1','4KF','4KF2','4KN',
];

// Must match the bucketing in fetch.js - filenames are IST dates
function getISTDay(offset = 0) {
  const base = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30');
  base.setDate(base.getDate() + offset);
  return base.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Always exempt, whatever the date arithmetic says
const KEEP  = new Set([getISTDay(0), getISTDay(1), getISTDay(2)]);
const today = getISTDay(0);

function daysOld(date) {
  return Math.floor((new Date(today + 'T00:00:00Z') - new Date(date + 'T00:00:00Z')) / 86400000);
}

let deleted = 0;

for (const tag of CHANNELS) {
  const dir = path.join('data', tag);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const date = m[1];
    if (KEEP.has(date)) continue;
    if (daysOld(date) > MAX_DAYS) {
      fs.unlinkSync(path.join(dir, file));
      console.log(`  deleted ${tag}/${file}`);
      deleted++;
    }
  }
}

// Drop index entries whose files no longer exist
const indexPath = path.join('data', 'index.json');
try {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  for (const tag of Object.keys(index)) {
    index[tag] = index[tag].filter(d => fs.existsSync(path.join('data', tag, `${d}.json`)));
    if (!index[tag].length) delete index[tag];
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log('  index resynced');
} catch {
  console.log('  no index to resync');
}

console.log(`Cleanup done. ${deleted} files deleted, retention ${MAX_DAYS} days.`);
