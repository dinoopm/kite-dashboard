const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs/promises');
const { fork } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const COOKIE = 'kite_session';
const token = () => crypto.randomBytes(32).toString('base64url');
function cookieToken(header = '') {
  return header.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
function createWorkerFactory({ root = path.join(__dirname, '../data/kite-sessions') } = {}) {
  const callbackPorts = new Set();
  async function allocateCallbackPort() {
    let port;
    do {
      const socket = net.createServer();
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
      port = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
    } while (callbackPorts.has(port));
    callbackPorts.add(port);
    return port;
  }
  return async () => {
    const secret = token();
    const directory = path.join(root, token());
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const callbackPort = await allocateCallbackPort();
    const child = fork(path.join(__dirname, '../server.js'), [], {
      env: { ...process.env, KITE_SESSION_WORKER: '1', KITE_WORKER_SECRET: secret, PORT: '0', MCP_REMOTE_CONFIG_DIR: directory, MCP_CALLBACK_PORT: String(callbackPort) },
      // Do not copy MCP authorization URLs or credentials into public logs.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32',
    });
    let dead = false;
    let stopped = false;
    child.once('exit', () => { dead = true; });
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      if (!dead) {
        child.kill('SIGTERM');
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 2500);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      // The entire group belongs to this one session. Never kill by process name.
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already closed */ }
      } else if (!dead) child.kill('SIGKILL');
      callbackPorts.delete(callbackPort);
      await fs.rm(directory, { recursive: true, force: true });
    };
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Kite session could not start. Try again.')), 30000);
        const fail = () => { clearTimeout(timer); reject(new Error('Kite session could not start. Try again.')); };
        child.once('error', fail);
        child.once('exit', fail);
        child.on('message', message => {
          if (message?.type === 'ready' && Number.isInteger(message.port)) { clearTimeout(timer); resolve(message.port); }
        });
      });
      return { port, callbackPort, directory, secret, stop, isAlive: () => !dead };
    } catch (error) { await stop(); throw error; }
  };
}

function createGateway({ workerFactory = createWorkerFactory(), now = Date.now,
  idleMs = 2 * 60 * 60 * 1000, maxMs = 12 * 60 * 60 * 1000, pendingMs = 30 * 60 * 1000,
  maxSessions = 20, allowedOrigins = [], secureCookies = false, frontendRoot = path.join(__dirname, '../../frontend/dist'),
} = {}) {
  const app = express();
  const sessions = new Map();
  let creating = 0;
  const setCookie = (res, value, age = 12 * 60 * 60) => res.append('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secureCookies ? '; Secure' : ''}`);
  const expired = session => !session.worker.isAlive() || now() - session.createdAt > (session.identity ? maxMs : pendingMs) || now() - session.lastUsedAt > idleMs;
  async function remove(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    await session.worker.stop();
  }
  async function sweep() {
    await Promise.allSettled([...sessions].filter(([, session]) => expired(session)).map(([id]) => remove(id)));
  }
  const timer = setInterval(() => { sweep().catch(() => {}); }, 60000);
  timer.unref();
  async function close() { clearInterval(timer); await Promise.allSettled([...sessions.keys()].map(remove)); }

  // Hosting health checks must not create a broker session or require a login.
  app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Cookie');
    // SameSite protects the cookie; Origin additionally blocks cross-site login
    // and state changes. The dev Vite proxy carries localhost:5173 as Origin.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('Origin');
      let sameHost = false;
      try { sameHost = new URL(origin).host === req.get('Host'); } catch { /* missing origin */ }
      const crossSite = req.get('Sec-Fetch-Site') === 'cross-site';
      if (crossSite || (origin && !sameHost && !allowedOrigins.includes(origin))) return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
    next();
  });
  app.use('/api', async (req, res) => {
    // req.originalUrl includes /api; request bodies are streamed to the worker.
    const route = req.originalUrl.split('?')[0];
    let id = cookieToken(req.get('Cookie'));
    let session = sessions.get(id);
    if (session && expired(session)) { await remove(id); session = null; }
    if (route === '/api/disconnect' && req.method === 'POST') {
      await remove(id);
      setCookie(res, '', 0);
      return res.json({ success: true, message: 'Signed out of this Kite session.' });
    }
    try {
      if (route === '/api/login' && req.method === 'POST') {
        if (session?.identity) { await remove(id); session = null; }
        if (!session) {
          if (sessions.size + creating >= maxSessions) return res.status(503).json({ error: 'Session capacity reached. Try again shortly.' });
          creating++;
          let worker;
          try { worker = await workerFactory(); } finally { creating--; }
          id = token();
          session = { worker, createdAt: now(), lastUsedAt: now(), identity: null };
          sessions.set(id, session);
          setCookie(res, id);
        }
      } else if (!session || (!session.identity && route !== '/api/profile')) {
        return res.status(401).json({ error: 'Sign in with Kite to continue.' });
      }
      session.lastUsedAt = now();
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value && !['host', 'cookie', 'connection', 'content-length', 'x-kite-worker-secret'].includes(key)) headers.set(key, value);
      }
      headers.set('x-kite-worker-secret', session.worker.secret);
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', abort);
      const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
      let upstream;
      try {
        upstream = await fetch(`http://127.0.0.1:${session.worker.port}${req.originalUrl}`, {
          method: req.method, headers, signal: controller.signal, redirect: 'manual',
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: req, duplex: 'half' }),
        });
        if (route === '/api/profile') {
          const data = await upstream.json();
          if (upstream.ok && data.identity?.appUserId && data.identity?.kiteUserId && !data.isError && !data.error) {
            if (session.identity && session.identity.appUserId !== data.identity.appUserId) {
              await remove(id); setCookie(res, '', 0);
              return res.status(401).json({ error: 'Kite account changed. Sign in again.' });
            }
            if (!session.identity) {
              // Rotate the pending cookie only after server-side profile verification.
              // Do not revive a session removed by a concurrent logout.
              if (sessions.get(id) !== session) return res.status(401).json({ error: 'Kite session ended.' });
              sessions.delete(id); id = token(); sessions.set(id, session); setCookie(res, id);
            }
            session.identity = data.identity;
          } else if (session.identity && (upstream.status === 401 || data.isError)) {
            await remove(id); setCookie(res, '', 0);
            return res.status(401).json({ error: 'Kite authorization expired. Sign in again.' });
          }
          if (upstream.headers.has('retry-after')) res.set('Retry-After', upstream.headers.get('retry-after'));
          return res.status(upstream.status).json(data);
        }
        res.status(upstream.status);
        for (const key of ['content-type', 'retry-after', 'content-disposition']) if (upstream.headers.has(key)) res.set(key, upstream.headers.get(key));
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
        else res.end();
      } finally { clearTimeout(timeout); res.off('close', abort); }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: error.message === 'Kite session could not start. Try again.' ? error.message : 'Kite session is unavailable. Please retry or sign in again.' });
    }
  });
  app.use(express.static(frontendRoot));
  app.get(/^.*$/, (req, res) => res.sendFile('index.html', { root: frontendRoot }, error => {
    if (error && !res.headersSent) res.status(404).send('Frontend build not found. Run npm --prefix frontend run build.');
  }));
  return { app, close, sweep, sessions };
}

function startGateway() {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
  const publicOrigin = process.env.APP_ORIGIN;
  const allowedOrigins = publicOrigin ? [new URL(publicOrigin).origin] : ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const secureCookies = publicOrigin?.startsWith('https:') || process.env.NODE_ENV === 'production';
  const gateway = createGateway({ allowedOrigins, secureCookies });
  const listener = gateway.app.listen(process.env.PORT || 3001, () => console.log('Kite dashboard gateway started; sign in with your own Kite account.'));
  // Public market data jobs run once here, never once per account worker.
  require('../alpaca').checkFeedAgreement().catch(() => {});
  const { checkDataHealth, logDataHealth } = require('../dataHealth');
  checkDataHealth().then(logDataHealth).catch(() => {});
  const stopJobs = require('../dailyJobs').startDailyJobs();
  const { createClient } = require('./database');
  const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
    }) : null;
  const macro = require('../indiaMacro/service').createIndiaMacroService({
    store: require('../indiaMacro/store').createStore({ supabase: db }), sources: require('../indiaMacro/sources').createSources(),
  });
  const stopMacro = macro.startSchedule();
  const stop = async () => { listener.close(); stopJobs(); stopMacro(); await gateway.close(); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return gateway;
}
module.exports = { createGateway, createWorkerFactory, cookieToken, startGateway };
