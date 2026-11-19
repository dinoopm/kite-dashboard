// ─── Nothing personal or secret in tracked files ─────────────────────────────
//
// This repository is public. On 2026-11-19 a personal email address was found
// in backend/alpaca.js, where it had sat in a User-Agent string since July —
// published with every push for four months. It now comes from .env
// (SEC_USER_AGENT). This test is the guard: it reads every file git tracks and
// fails on anything shaped like a personal address or a credential, so the
// next one is caught before it is pushed rather than months after.
//
// The patterns are shapes, not values — the test must not itself contain the
// thing it guards against.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Addresses that are meant to be public: commit trailers and placeholders.
const ALLOWED_EMAILS = [/^noreply@anthropic\.com$/i, /@example\.(com|org)$/i, /@users\.noreply\.github\.com$/i, /^you@/i, /^user@/i, /^name@/i];

const CHECKS = [
  { what: 'personal email address', re: /\b[A-Za-z0-9._%+-]+@(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|proton|protonmail|aol)\.[a-z.]{2,6}\b/gi },
  { what: 'email address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, onlyIn: /\.(js|jsx|ts|json|yml|yaml)$/, allow: ALLOWED_EMAILS },
  { what: 'JWT (e.g. a Supabase service key)', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { what: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/g },
  { what: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { what: 'Anthropic / OpenAI style API key', re: /\bsk-(ant-)?[A-Za-z0-9_-]{24,}\b/g },
  { what: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
];

// Generated or vendored files that legitimately hold address-shaped strings
// (package metadata, lockfiles) and are not written by hand.
const SKIP = /(^|\/)(package-lock\.json|node_modules\/|dist\/)|\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|pdf|xlsx|zip)$/i;

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(f => f && !SKIP.test(f));
}

test('no tracked file holds a personal address or a credential', () => {
  const found = [];
  for (const f of trackedFiles()) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (text.length > 2_000_000) continue; // data dumps, not source
    for (const c of CHECKS) {
      if (c.onlyIn && !c.onlyIn.test(f)) continue;
      for (const m of text.matchAll(c.re)) {
        if (c.allow?.some(a => a.test(m[0]))) continue;
        const line = text.slice(0, m.index).split('\n').length;
        // Report where, never what: the match itself is the leak.
        found.push(`${f}:${line} — ${c.what}`);
      }
    }
  }
  assert.deepEqual(found, [], `Remove these before committing (move values to .env):\n${found.join('\n')}`);
});

// The values themselves live in .env, so .env must never be tracked.
// `git check-ignore -q` exits 0 when the path is ignored and 1 when it is not.
test('.env files are ignored by git and none is tracked', () => {
  for (const f of ['.env', 'backend/.env', 'frontend/.env']) {
    assert.doesNotThrow(() => execFileSync('git', ['check-ignore', '-q', f], { cwd: ROOT, stdio: 'ignore' }), `${f} is not ignored`);
  }
  const tracked = trackedFiles().filter(f => /(^|\/)\.env(\.|$)/.test(f) && !/\.env\.example$/.test(f));
  assert.deepEqual(tracked, []);
});

// The guard has to actually catch things, or it is decoration.
test('the patterns catch what they are meant to', () => {
  const hits = (text) => CHECKS.filter(c => !c.onlyIn).flatMap(c => [...text.matchAll(c.re)].map(() => c.what));
  const at = String.fromCharCode(64);
  assert.ok(hits(`ua = 'app/1.0 someone${at}gmail.com'`).includes('personal email address'));
  // Assembled at runtime so this file's own text never matches the scan above.
  const jwt = ['ey', 'JhbGciOiJIUzI1NiJ9', '.ey', 'Jyb2xlIjoic2VydmljZV9yb2xlIn0', '.abcdefghijklmnop'].join('');
  assert.ok(hits(`key = "${jwt}"`).includes('JWT (e.g. a Supabase service key)'));
  assert.ok(hits(['-----BEGIN', 'PRIVATE KEY-----'].join(' ')).length);
  assert.deepEqual(hits('Co-Authored-By: Claude <noreply' + at + 'anthropic.com>'), []);
});
