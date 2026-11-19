// ─── System status: is everything that should be running, running? ───────────
//
// GET /api/system-status. One answer to the questions that kept being asked by
// hand: did last night's jobs run, did the scrapers work, is a scorecard
// broken, is my change live, why are there 25 backend processes.
//
// Every check ends in one of four states:
//   ok       nothing to do
//   warn     worth knowing; nothing is being lost (a restart is pending, a
//            source could not be reached to check)
//   fail     something is broken or has stopped, and data or a feature is
//            affected now — these, and only these, raise the app-wide banner
//   unknown  never run yet, so there is nothing to judge
// A banner that fires for warnings gets ignored, and then the next real
// failure is ignored with it — the lesson ACKNOWLEDGED_GAPS already encodes.
//
// evaluate() is pure, so the thresholds are tested; gather() is the thin part
// that reads the outcome log, the process table, git, and GitHub.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readAll, readOne } = require('./healthLog');

const REPO_ROOT = path.join(__dirname, '..');
const HOUR = 3600 * 1000;

// Daily jobs, by the key runDailyJobs reports them under. `quietHours` is how
// long without a successful run means the job has stopped, rather than merely
// having nothing to do: every pass of a healthy job counts as a success,
// including "skipped: not due". The gateway ticks every 30 minutes.
const JOBS = {
  picks:          { label: 'Indian picks snapshot',       quietHours: 6 },
  emissions:      { label: 'Indian signal recording',     quietHours: 6 },
  macro:          { label: 'US macro regime',             quietHours: 6 },
  usPicks:        { label: 'US picks snapshot',           quietHours: 6 },
  usRiskSeverity: { label: 'US risk severity recording',  quietHours: 6 },
  riskRegime:     { label: 'Money Flow recording',        quietHours: 30 },
  rrgRotation:    { label: 'RRG entry recording',         quietHours: 30 },
};
const SCORECARDS = {
  'scorecard-india-signals': 'Indian signal scorecard',
  'scorecard-india-picks': 'Indian picks scorecard',
  'scorecard-us-picks': 'US picks scorecard',
  'scorecard-rrg': 'RRG rotation scorecard',
  'scorecard-data-health': 'Feed health check',
};

const ago = (iso, now) => {
  if (!iso) return 'never';
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

function jobCheck(key, spec, rec, tick, now) {
  const base = { id: `job-${key}`, group: 'Daily jobs', label: spec.label };
  if (!rec) return { ...base, state: 'unknown', summary: 'Has not run under this version yet.' };
  if (rec.lastOk === false) {
    return { ...base, state: 'fail', summary: `Failed ${ago(rec.lastErrorAt, now)}${rec.consecutiveFailures > 1 ? ` (${rec.consecutiveFailures} runs in a row)` : ''}: ${rec.lastError}`, since: rec.lastErrorAt, action: 'It retries every 30 minutes. If this persists, the backend log has the full error.' };
  }
  // A tick newer than this job's last success means the job stopped being run
  // at all — a code path that returns early, not an error.
  const quiet = rec.lastOkAt && now - Date.parse(rec.lastOkAt) > spec.quietHours * HOUR && tick && Date.parse(tick.ranAt) > Date.parse(rec.lastOkAt);
  if (quiet) return { ...base, state: 'fail', summary: `No successful run for ${ago(rec.lastOkAt, now).replace(' ago', '')}, though the scheduler is ticking.`, since: rec.lastOkAt };
  return { ...base, state: 'ok', summary: `${rec.lastDetail || 'ran'} — ${ago(rec.lastRunAt, now)}` };
}

function scorecardCheck(name, label, rec, now) {
  const base = { id: name, group: 'Scorecards', label };
  if (!rec) return { ...base, state: 'unknown', summary: 'Not built since this logging was added. Opening the page that uses it builds it.' };
  if (rec.lastOk === false) {
    const okAfter = rec.lastOkAt && rec.lastOkAt > rec.lastErrorAt;
    if (!okAfter) return { ...base, state: 'fail', summary: `Failed ${ago(rec.lastErrorAt, now)}: ${rec.lastError}`, since: rec.lastErrorAt, action: 'Badges that read this scorecard hide themselves while it fails, so pages look normal. Fix before trusting them.' };
  }
  return { ...base, state: 'ok', summary: `${rec.lastDetail ? `${rec.lastDetail} — ` : ''}built ${ago(rec.lastOkAt, now)}` };
}

/**
 * Pure. `inputs` is what gather() collected; `now` a millisecond timestamp.
 * Returns { checks, counts, ok, generatedAt }.
 */
function evaluate(inputs, now = Date.now()) {
  const { outcomes = {}, tick = null, scheduled = null, gateway = null, worker = null, newestSource = null,
    processes = null, feeds = null, workflows = null } = inputs;
  const checks = [];

  // ── Scheduler heartbeat ─────────────────────────────────────────────────
  {
    const base = { id: 'scheduler', group: 'Daily jobs', label: 'Scheduler (gateway)' };
    const tickMs = scheduled?.tickMs || 30 * 60 * 1000;
    if (!tick && !scheduled) checks.push({ ...base, state: 'unknown', summary: 'No record yet. It appears after the gateway is restarted with this version.' });
    else if (!tick) checks.push({ ...base, state: Date.parse(scheduled.startedAt) < now - 3 * tickMs ? 'fail' : 'unknown', summary: `Scheduled ${ago(scheduled.startedAt, now)} but no pass has finished.` });
    else if (now - Date.parse(tick.finishedAt || tick.ranAt) > 2.5 * tickMs) {
      checks.push({ ...base, state: 'fail', summary: `Last pass ${ago(tick.finishedAt || tick.ranAt, now)}; it should run every ${tickMs / 60000} minutes.`, since: tick.finishedAt, action: 'The gateway may be down or stuck. Restart the backend (npm start).' });
    } else checks.push({ ...base, state: 'ok', summary: `Last pass ${ago(tick.finishedAt || tick.ranAt, now)}` });
  }

  for (const [key, spec] of Object.entries(JOBS)) checks.push(jobCheck(key, spec, outcomes[`job-${key}`], tick, now));
  for (const [name, label] of Object.entries(SCORECARDS)) checks.push(scorecardCheck(name, label, outcomes[name], now));

  // ── Data feeds (dataHealth.js) ──────────────────────────────────────────
  if (feeds?.error) {
    checks.push({ id: 'feeds', group: 'Data feeds', label: 'Feed check', state: 'warn', summary: `Could not run: ${feeds.error}` });
  } else if (feeds?.feeds) {
    for (const f of feeds.feeds) {
      const base = { id: `feed-${f.table}`, group: 'Data feeds', label: f.label };
      if (f.error) checks.push({ ...base, state: 'warn', summary: `Could not be checked: ${f.error}` });
      else if (f.stale) checks.push({ ...base, state: 'fail', summary: `${f.sessionsBehind} trading session(s) behind NIFTY — last ${f.last}.`, action: 'Check the Market Data Sync workflow. NSE serves most of these for the latest session only.' });
      else if (f.gaps?.length) checks.push({ ...base, state: 'fail', summary: `Missing ${f.gaps.length} traded session(s): ${f.gaps.slice(0, 6).join(', ')}${f.gaps.length > 6 ? '…' : ''}` });
      else checks.push({ ...base, state: 'ok', summary: `Current — last ${f.last}` });
    }
  }

  // ── Scrapers on GitHub Actions ──────────────────────────────────────────
  if (workflows?.error) {
    checks.push({ id: 'workflows', group: 'Scrapers (GitHub Actions)', label: 'Workflow runs', state: 'warn', summary: `Could not reach GitHub: ${workflows.error}` });
  } else if (workflows?.runs) {
    for (const w of workflows.runs) {
      const base = { id: `wf-${w.path}`, group: 'Scrapers (GitHub Actions)', label: w.name };
      if (w.conclusion === 'failure' || w.conclusion === 'timed_out') {
        checks.push({ ...base, state: 'fail', summary: `Last run ${w.conclusion} ${ago(w.at, now)}${w.failedSteps?.length ? ` — ${w.failedSteps.join(', ')}` : ''}.`, since: w.at, action: w.url ? `Run log: ${w.url}` : undefined });
      } else checks.push({ ...base, state: w.conclusion === 'success' ? 'ok' : 'unknown', summary: `${w.conclusion || w.status} ${ago(w.at, now)}` });
    }
  }

  // ── Is the running code the code on disk? ───────────────────────────────
  const stale = (startedAt) => newestSource && startedAt && Date.parse(newestSource.mtime) > Date.parse(startedAt);
  if (gateway) {
    const base = { id: 'code-gateway', group: 'Running code', label: 'Gateway (daily jobs, scheduler)' };
    checks.push(stale(gateway.startedAt)
      ? { ...base, state: 'warn', summary: `Started ${ago(gateway.startedAt, now)}; backend files changed since (latest: ${newestSource.file}).`, action: 'Restart the backend (npm start) to load them. That signs everyone out.' }
      : { ...base, state: 'ok', summary: `Started ${ago(gateway.startedAt, now)}; up to date with the files on disk.` });
  }
  if (worker) {
    const base = { id: 'code-worker', group: 'Running code', label: 'Your session' };
    checks.push(stale(worker.startedAt)
      ? { ...base, state: 'warn', summary: `Started ${ago(worker.startedAt, now)}; backend files changed since (latest: ${newestSource.file}).`, action: 'Sign out and sign back in to load them.' }
      : { ...base, state: 'ok', summary: `Started ${ago(worker.startedAt, now)}; up to date.` });
  }

  // ── Orphaned workers ────────────────────────────────────────────────────
  if (processes?.error) {
    checks.push({ id: 'orphans', group: 'Running code', label: 'Backend processes', state: 'unknown', summary: `Could not list processes: ${processes.error}` });
  } else if (processes) {
    const base = { id: 'orphans', group: 'Running code', label: 'Backend processes' };
    const o = processes.orphans || [];
    checks.push(o.length
      ? { ...base, state: 'warn', summary: `${o.length} session worker(s) outlived their gateway (oldest started ${o[0].started}). Each still runs old code and its own job timer.`, action: `Stop them with: kill ${o.map(p => p.pid).join(' ')}`, pids: o.map(p => p.pid) }
      : { ...base, state: 'ok', summary: `${processes.workers} session worker(s), all owned by the running gateway.` });
  }

  const order = { fail: 0, warn: 1, unknown: 2, ok: 3 };
  const counts = { fail: 0, warn: 0, unknown: 0, ok: 0 };
  for (const c of checks) counts[c.state]++;
  return { checks: checks.sort((a, b) => order[a.state] - order[b.state]), counts, ok: counts.fail === 0, generatedAt: new Date(now).toISOString() };
}

// ── Gathering ─────────────────────────────────────────────────────────────

/** Newest modification time among backend source files: "has anything changed since this process started?" */
function newestBackendSource(root = path.join(REPO_ROOT, 'backend')) {
  let best = null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|ts|json)$/.test(e.name) && !/\.test\.js$/.test(e.name) && e.name !== 'package-lock.json') {
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.ms) best = { ms: m, file: path.relative(REPO_ROOT, p) };
      }
    }
  };
  try { walk(root); } catch { return null; }
  return best && { file: best.file, mtime: new Date(best.ms).toISOString() };
}

/**
 * Session workers whose gateway is gone. A worker is a `node …/backend/
 * server.js` process; one whose parent is pid 1 has been re-parented to init,
 * which only happens when its gateway exited. Never kills anything — killing
 * is the user's call, and the command is in the check's action.
 */
function listProcesses() {
  try {
    const outText = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8', timeout: 5000 });
    const rows = outText.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
      return m && { pid: +m[1], ppid: +m[2], started: new Date(m[3]).toISOString().slice(0, 10), command: m[4] };
    }).filter(Boolean);
    const workers = rows.filter(r => /node\s+\S*backend\/server\.js\b/.test(r.command));
    const orphans = workers.filter(r => r.ppid === 1).sort((a, b) => a.started.localeCompare(b.started));
    return { workers: workers.length - orphans.length, orphans: orphans.map(({ pid, started }) => ({ pid, started })) };
  } catch (e) {
    return { error: e.message };
  }
}

/** owner/repo from the git remote, or null. Read from .git/config, no shell. */
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const cfg = fs.readFileSync(path.join(REPO_ROOT, '.git', 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*\S*github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s/);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * The latest run of each scheduled workflow. Public repository, so the
 * unauthenticated API works; it allows 60 requests an hour, hence the cache in
 * the route. Failed step names come from the jobs endpoint, only for failures.
 */
async function fetchWorkflows(slug, { fetchImpl = fetch } = {}) {
  if (!slug) return { error: 'no GitHub remote configured' };
  const get = async (p) => {
    const r = await fetchImpl(`https://api.github.com/repos/${slug}${p}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kite-dashboard-status' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.json();
  };
  try {
    const { workflow_runs: runs = [] } = await get('/actions/runs?per_page=40&event=schedule');
    const latest = new Map();
    for (const r of runs) if (!latest.has(r.path) && r.status === 'completed') latest.set(r.path, r);
    const out = [];
    for (const r of latest.values()) {
      let failedSteps = [];
      if (r.conclusion === 'failure') {
        try {
          const { jobs = [] } = await get(`/actions/runs/${r.id}/jobs`);
          failedSteps = jobs.flatMap(j => (j.steps || []).filter(s => s.conclusion === 'failure').map(s => s.name));
        } catch { /* the conclusion alone still stands */ }
      }
      out.push({ name: r.name, path: r.path, conclusion: r.conclusion, status: r.status, at: r.created_at, url: r.html_url, failedSteps });
    }
    return { runs: out.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (e) {
    return { error: e.message };
  }
}

const WORKER_STARTED = new Date(Date.now() - process.uptime() * 1000).toISOString();

async function gather({ checkDataHealth = require('./dataHealth').checkDataHealth, workflows } = {}) {
  const outcomes = readAll('');
  let feeds;
  try { feeds = await checkDataHealth(); } catch (e) { feeds = { error: e.message }; }
  return {
    outcomes,
    tick: readOne('tick-daily-jobs'),
    scheduled: readOne('tick-daily-jobs-scheduled'),
    gateway: readOne('process-gateway'),
    worker: process.env.KITE_SESSION_WORKER === '1' ? { startedAt: WORKER_STARTED } : null,
    newestSource: newestBackendSource(),
    processes: listProcesses(),
    feeds,
    workflows: workflows || await fetchWorkflows(repoSlug()),
  };
}

async function systemStatus(opts = {}) {
  return evaluate(await gather(opts));
}

module.exports = { systemStatus, evaluate, gather, listProcesses, newestBackendSource, repoSlug, fetchWorkflows, JOBS, SCORECARDS };
