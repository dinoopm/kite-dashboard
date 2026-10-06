const { SERIES, validateObservation, mergeObservations, presentSeries } = require('./model');

const DAY = 86400000;
function nextDelay(failures) { return failures ? Math.min(6 * 3600000, 15 * 60000 * 2 ** Math.min(failures - 1, 5)) : DAY; }
function createIndiaMacroService({ store, sources, now = () => new Date() }) {
  let cache = null, readAt = 0, inflight = null, readInflight = null;
  async function load() {
    if (cache && now().getTime() - readAt < 5 * 60000) return cache;
    if (!readInflight) readInflight = (async () => {
      const entries = await Promise.all(Object.keys(SERIES).map(async key => [key, await store.read(key)]));
      cache = Object.fromEntries(entries); readAt = now().getTime(); return cache;
    })().finally(() => { readInflight = null; });
    return readInflight;
  }
  function payload(entries) {
    return { generatedAt: now().toISOString(), syncFrequency: 'Daily; retries after failed checks', series: Object.fromEntries(Object.keys(SERIES).map(key => [key, { ...presentSeries(key, entries[key]?.state, now()), storage: entries[key]?.storage || 'unavailable', storageWarning: entries[key]?.warning || null }])) };
  }
  async function get() { return payload(await load()); }
  async function sync({ force = false } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      const entries = await load();
      const queue = Object.keys(SERIES);
      const results = [];
      async function worker() {
        for (;;) {
          const key = queue.shift(); if (!key) break;
          const prior = entries[key]?.state;
          const checked = prior?.lastCheckedAt ? Date.parse(prior.lastCheckedAt) : 0;
          if (checked && now().getTime() - checked < (force ? 60000 : nextDelay(prior.failures || (prior.persistenceError ? 1 : 0)))) { results.push({ key, skipped: true }); continue; }
          let observations, error = null;
          try {
            const raw = await sources[key]();
            if (!Array.isArray(raw) || !raw.length) throw new Error('No validated observations returned');
            observations = raw.map(o => validateObservation(key, o, now()));
          } catch(e) { error = e.message; }
          // Re-read shared state after fetching so an external sync's revisions
          // are carried forward. Every checkpoint remains immutable regardless.
          const fresh = await store.read(key);
          const previous = fresh.state || prior || { observations: [], failures: 0 };
          const at = now().toISOString();
          const state = {
            version: 1, key, observations: mergeObservations(previous.observations, observations || [], at),
            lastCheckedAt: at, lastSuccessfulCheckAt: error ? previous.lastSuccessfulCheckAt || null : at,
            error, failures: error ? (previous.failures || 0) + 1 : 0,
          };
          const written = await store.write(key, state);
          entries[key] = { state: written.storage === 'local' && written.warning ? { ...state, persistenceError: written.warning } : state, ...written };
          results.push({ key, error, persistence: written.storage, added: state.observations.length - (previous.observations?.length || 0) });
        }
      }
      await Promise.all([worker(), worker(), worker()]);
      cache = entries; readAt = now().getTime();
      return { ...payload(entries), results };
    })().finally(() => { inflight = null; });
    return inflight;
  }
  function startSchedule({ firstDelayMs = 10000, tickMs = 15 * 60000 } = {}) {
    const run = () => sync().then(r => {
      const attempted = r.results.filter(x => !x.skipped);
      if (attempted.length) console.log(`[india-macro] checked ${attempted.length} series; ${attempted.filter(x => x.error).length} source failures`);
    }).catch(e => console.warn('[india-macro]', e.message));
    const first = setTimeout(run, firstDelayMs), interval = setInterval(run, tickMs);
    first.unref?.(); interval.unref?.();
    return () => { clearTimeout(first); clearInterval(interval); };
  }
  return { get, sync, startSchedule };
}
module.exports = { createIndiaMacroService, nextDelay };
