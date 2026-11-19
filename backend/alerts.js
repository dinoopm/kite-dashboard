// ─── Tell someone when something breaks ──────────────────────────────────────
//
// The status page and banner (systemStatus.js) only help if the app is open.
// The failures they exist for — a scraper dying at 21:00, a scorecard timing
// out — happen when nobody is looking, and NSE serves most feeds for the
// latest session only, so a day noticed late is a day lost. This turns status
// checks into notifications.
//
// What is sent, and when (planAlerts, pure and tested):
//   · a check ENTERS `fail`            → "broken: …"
//   · it is still failing 24 h later   → one reminder a day, not one per tick
//   · a check that was failing recovers → "recovered: …"
// Warnings never notify, for the same reason they never raise the banner.
//
// Where it goes:
//   · macOS Notification Centre, via osascript — local, no account, no data
//     leaving the machine. On by default; NOTIFY_DESKTOP=0 turns it off.
//   · NOTIFY_WEBHOOK_URL, if set in .env: the message is POSTed there as plain
//     text, which is what ntfy.sh topics and most chat webhooks accept. Off
//     unless you set it; what is sent is the check's label and one-line summary
//     (table names, error messages), never data rows or credentials.
//
// State (what is already known to be failing) lives in the health log, so a
// gateway restart does not re-announce a failure everyone already knows about.

const { execFile } = require('child_process');
const { readOne, noteRecord } = require('./healthLog');

const REMIND_MS = 24 * 3600 * 1000;
const STATE = 'alerts-state';

/**
 * Pure. `prev` is { failing: { [checkId]: { label, since, notifiedAt } } }.
 * Returns { messages: [{ kind, id, title, body }], next }.
 */
function planAlerts(prev, checks, now = Date.now()) {
  const was = prev?.failing || {};
  const failingNow = (checks || []).filter(c => c.state === 'fail');
  const next = { failing: {} };
  const messages = [];
  for (const c of failingNow) {
    const p = was[c.id];
    if (!p) {
      messages.push({ kind: 'broken', id: c.id, title: `Broken: ${c.label}`, body: c.summary });
      next.failing[c.id] = { label: c.label, since: new Date(now).toISOString(), notifiedAt: new Date(now).toISOString() };
    } else if (now - Date.parse(p.notifiedAt) >= REMIND_MS) {
      messages.push({ kind: 'still', id: c.id, title: `Still broken: ${c.label}`, body: `Since ${p.since.slice(0, 16).replace('T', ' ')} UTC. ${c.summary}` });
      next.failing[c.id] = { ...p, notifiedAt: new Date(now).toISOString() };
    } else {
      next.failing[c.id] = p;
    }
  }
  const nowIds = new Set(failingNow.map(c => c.id));
  for (const [id, p] of Object.entries(was)) {
    // A check that vanished (renamed, or its source not reachable this time)
    // is not a recovery — only one that is present and no longer failing.
    const c = (checks || []).find(x => x.id === id);
    if (!nowIds.has(id) && c && c.state !== 'fail') {
      messages.push({ kind: 'recovered', id, title: `Recovered: ${p.label}`, body: c.summary });
    } else if (!nowIds.has(id) && !c) {
      next.failing[id] = p;
    }
  }
  return { messages, next };
}

/** Notification Centre. Arguments go to AppleScript as argv, never into the script text. */
function sendDesktop({ title, body }, { exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title "Kite dashboard" subtitle (item 1 of argv)', '-e', 'end run', title, String(body).slice(0, 240)],
      { timeout: 5000 }, (err) => resolve(!err));
  });
}

async function sendWebhook(url, { title, body }, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title.slice(0, 120) }, body: `${title}\n${body}`, signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

/**
 * One pass: evaluate status, send what planAlerts says, remember what was
 * sent. `status` is an evaluate() result. Never throws.
 */
async function notifyFromStatus(status, { now = Date.now(), env = process.env, desktop = sendDesktop, webhook = sendWebhook } = {}) {
  try {
    const prev = readOne(STATE) || { failing: {} };
    const { messages, next } = planAlerts(prev, status.checks, now);
    const sent = [];
    for (const m of messages) {
      const via = [];
      if (env.NOTIFY_DESKTOP !== '0' && process.platform === 'darwin' && await desktop(m)) via.push('desktop');
      if (env.NOTIFY_WEBHOOK_URL && await webhook(env.NOTIFY_WEBHOOK_URL, m)) via.push('webhook');
      sent.push({ ...m, via });
    }
    noteRecord(STATE, { failing: next.failing, lastPassAt: new Date(now).toISOString(), lastSent: sent.slice(-5) });
    return { sent, failing: Object.keys(next.failing) };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { planAlerts, notifyFromStatus, sendDesktop, sendWebhook, REMIND_MS };
