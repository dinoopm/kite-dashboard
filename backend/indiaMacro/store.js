const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SERIES } = require('./model');

const BUCKET = 'india-macro-releases';
// Public economic releases only. Broker/session data never enters this store.
// Immutable checkpoints also retain same-day revisions and failed check logs.
function createStore({ supabase = null, directory = path.join(__dirname, '../data/india-macro') } = {}) {
  let bucketReady = false;
  async function ensureBucket() {
    if (bucketReady) return;
    const { data, error } = await supabase.storage.getBucket(BUCKET);
    if (error && error.statusCode !== '404' && error.statusCode !== 404 && !/not found/i.test(error.message)) throw error;
    if (!data) {
      const created = await supabase.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 5 * 1024 * 1024, allowedMimeTypes: ['application/json'] });
      if (created.error && !/already exists/i.test(created.error.message)) throw created.error;
    }
    bucketReady = true;
  }
  async function readLocal(key) {
    try { return JSON.parse(await fs.readFile(path.join(directory, `${key}.json`), 'utf8')); }
    catch(e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function localWrite(key, state) {
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, `${key}.json`), temp = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temp, filename);
  }
  async function read(key) {
    if (!SERIES[key]) throw new Error('Unknown macro series');
    const local = await readLocal(key);
    if (!supabase) return { state: local, storage: 'local', warning: 'Shared storage is not configured; updates run only while this backend is running.' };
    try {
      await ensureBucket();
      const { data, error } = await supabase.storage.from(BUCKET).list(key, { limit: 1, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw error;
      if (!data?.length) return local?.persistenceError ? { state: local, storage: 'local', warning: `Shared persistence is awaiting retry: ${local.persistenceError}` } : { state: local, storage: 'shared', warning: null };
      const download = await supabase.storage.from(BUCKET).download(`${key}/${data[0].name}`);
      if (download.error) throw download.error;
      const remote = JSON.parse(await download.data.text());
      // A local check can be newer after an earlier shared-storage failure.
      const state = local?.lastCheckedAt > remote.lastCheckedAt ? local : remote;
      await localWrite(key, state);
      return state?.persistenceError ? { state, storage: 'local', warning: `Shared persistence is awaiting retry: ${state.persistenceError}` } : { state, storage: 'shared', warning: null };
    } catch(e) { return { state: local, storage: 'local', warning: `Shared storage unavailable; using local releases: ${e.message}` }; }
  }
  async function write(key, state) {
    if (!SERIES[key]) throw new Error('Unknown macro series');
    await localWrite(key, state);
    if (!supabase) return { storage: 'local', warning: 'Shared storage is not configured; updates run only while this backend is running.' };
    try {
      await ensureBucket();
      // Inverted timestamp sorts newest first without relying on object created_at.
      const stamp = String(9999999999999 - Date.parse(state.lastCheckedAt)).padStart(13, '0');
      const filename = `${key}/${stamp}-${randomUUID()}.json`;
      const { error } = await supabase.storage.from(BUCKET).upload(filename, JSON.stringify(state), { contentType: 'application/json', upsert: false, cacheControl: '0' });
      if (error) throw error;
      return { storage: 'shared', warning: null };
    } catch(e) {
      await localWrite(key, { ...state, persistenceError: e.message });
      return { storage: 'local', warning: `Shared persistence failed; saved locally: ${e.message}` };
    }
  }
  return { read, write };
}
module.exports = { BUCKET, createStore };
