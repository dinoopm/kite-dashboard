const axios = require('axios');
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
function createCnnService({ fetchData = async () => (await axios.get(FEED_URL, { timeout: 12_000, headers: { Accept: 'application/json', 'User-Agent': 'kite-dashboard/1.0' } })).data, now = () => new Date(), saved = savedReading } = {}) {
  let cache = null, at = 0, pending = null, last = saved;
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
        result = { ...result, mode: 'feed', notice: null };
      } catch {
        if (!last) throw new Error('CNN Fear & Greed is unavailable');
        result = { ...last, mode: 'saved', notice: 'CNN’s automatic feed is unavailable. Showing a saved CNN reading with its original timestamp.' };
      }
      cache = { ...result, fetchedAt: now().toISOString() }; at = +now(); return cache;
    })().finally(() => { pending = null; });
    return pending;
  };
}
const getCnnFearGreed = createCnnService();
module.exports = { parseCnn, createCnnService, getCnnFearGreed };
