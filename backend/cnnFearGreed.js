const axios = require('axios');
const fs = require('fs');
const path = require('path');
const savedReading = require('./cnnFearGreed.snapshot.json');
const SOURCE_URL = 'https://www.cnn.com/markets/fear-and-greed';
const FEED_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const RATINGS = ['extreme fear', 'fear', 'neutral', 'greed', 'extreme greed'];
const score = value => Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
function parseCnn(payload) {
  const item = payload?.fear_and_greed;
  const value = score(item?.score);
  const rating = String(item?.rating || '').toLowerCase();
  const timestamp = new Date(item?.timestamp ?? NaN);
  if (value == null || !RATINGS.includes(rating) || !Number.isFinite(+timestamp)) throw new Error('Invalid CNN index data');
  return { score: value, rating, asOf: timestamp.toISOString(), previousClose: score(item.previous_close), oneWeekAgo: score(item.previous_1_week), oneMonthAgo: score(item.previous_1_month), oneYearAgo: score(item.previous_1_year), sourceUrl: SOURCE_URL };
}
// A reading older than this is flagged stale. Four days, not one: CNN does not
// publish over a weekend, so Friday's reading is still the latest on Monday
// morning, and a Monday holiday stretches that to Tuesday.
const STALE_AFTER_HOURS = 96;

const usable = (r) => r && Number.isFinite(r.score) && typeof r.asOf === 'string' && Number.isFinite(Date.parse(r.asOf));
const newer = (a, b) => (!usable(a) ? (usable(b) ? b : null) : !usable(b) ? a : (a.asOf >= b.asOf ? a : b));

/**
 * Where the last LIVE reading is kept between restarts.
 *
 * The fallback used to be only cnnFearGreed.snapshot.json, a file committed to
 * the repo. With the feed refused (CNN answers 418 to this client), every
 * restart reverted the page to that file's Oct 26 reading and it went on aging
 * indefinitely. Best-effort: a write that fails costs nothing but freshness.
 */
function fileStore(file) {
  return {
    read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
    write(reading) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(reading)); } catch { /* freshness only */ }
    },
  };
}

function createCnnService({ fetchData = async () => (await axios.get(FEED_URL, { timeout: 12_000, headers: { Accept: 'application/json', 'User-Agent': 'kite-dashboard/1.0' } })).data, now = () => new Date(), saved = savedReading, store = null } = {}) {
  // The newer of the committed reading and the last stored live one — a stored
  // reading older than the committed file, or a corrupt one, never wins.
  let cache = null, at = 0, pending = null, last = newer(saved, store?.read?.());
  const withAge = (r) => {
    const hours = (+now() - Date.parse(r.asOf)) / 36e5;
    // Age in the payload, so the page can say "8 days old" instead of hoping
    // the reader compares a timestamp with the calendar.
    return { ...r, ageDays: Math.max(0, Math.round(hours / 24)), stale: hours > STALE_AFTER_HOURS };
  };
  return async function getCnn() {
    if (cache && +now() - at < 5 * 60_000) return cache;
    if (pending) return pending;
    pending = (async () => {
      let result;
      try {
        result = parseCnn(await fetchData());
        if (Date.parse(result.asOf) > +now() + 60_000) throw new Error('Future CNN reading');
        if (last && result.asOf < last.asOf) throw new Error('Older CNN reading');
        last = result;
        store?.write?.(result);
        result = { ...result, mode: 'feed', notice: null };
      } catch {
        if (!last) throw new Error('CNN Fear & Greed is unavailable');
        result = { ...last, mode: 'saved', notice: 'CNN’s automatic feed is unavailable. Showing a saved CNN reading with its original timestamp.' };
      }
      cache = { ...withAge(result), fetchedAt: now().toISOString() }; at = +now(); return cache;
    })().finally(() => { pending = null; });
    return pending;
  };
}
const getCnnFearGreed = createCnnService({ store: fileStore(path.join(__dirname, 'data', 'cnn-fear-greed', 'last.json')) });
module.exports = { parseCnn, createCnnService, getCnnFearGreed, fileStore, STALE_AFTER_HOURS };
