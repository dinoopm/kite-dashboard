// US macro calendar seed — run ~annually (or whenever): node macro_events.js
//
// FOMC meetings, CPI releases, monthly employment reports and GDP estimates
// are published up to a year ahead and never move, so this seeds them once
// into `macro_events` instead of polling a feed. Source is the calendar
// rendered at feargreedmeter.com/events (server-side HTML, easy to parse —
// the official BLS pages block non-browser clients); every parsed FOMC date
// is then CROSS-CHECKED against federalreserve.gov's official calendar and
// the script aborts on any mismatch, so a silently wrong third-party date
// can't get seeded. Idempotent upsert on (event_date, title).

const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const MONTH_NAMES = { January: 'Jan', February: 'Feb', March: 'Mar', April: 'Apr', May: 'May', June: 'Jun', July: 'Jul', August: 'Aug', September: 'Sep', October: 'Oct', November: 'Nov', December: 'Dec' };

async function fetchCalendar() {
  const r = await axios.get('https://feargreedmeter.com/events', { headers: { 'User-Agent': UA }, timeout: 20000 });
  // Rendered pattern: 📅 <!-- -->Tue · Jul 14, 2026</div></div><div ...>CPI (Inflation) Report</div><div ...>08:30 AM Eastern Time...
  const re = /📅 <!-- -->[A-Za-z]{3} · ([A-Za-z]{3}) (\d{1,2}), (\d{4})<\/div><\/div><div[^>]*>([^<]+)<\/div><div[^>]*>([^<]+)<\/div>/g;
  const rows = [];
  let m;
  while ((m = re.exec(r.data)) !== null) {
    const [, mon, dd, yyyy, title, detail] = m;
    if (!MONTHS[mon]) continue;
    rows.push({
      event_date: `${yyyy}-${MONTHS[mon]}-${String(dd).padStart(2, '0')}`,
      title: title.trim(),
      detail: detail.trim(),
    });
  }
  if (rows.length < 10) throw new Error(`Only parsed ${rows.length} events — the page markup probably changed; fix the regex before seeding.`);
  return rows;
}

// Official guard: every parsed "Fed Meeting (Day 1)" must appear on the Fed's
// own calendar page as "<Month> ... <day-range starting with that day>".
// ─── BEA: Personal Income and Outlays ────────────────────────────────────────
//
// This is where core PCE lands — the heaviest-weighted input on the Macro
// Decision Monitor — and the calendar had never carried it. Without it the
// panel could not name its own most important catalyst, and fell back to
// naming a GDP estimate that feeds nothing it scores.
//
// bea.gov/news/schedule serves plain server-side HTML to a normal client, so
// unlike the BLS pages this comes straight from the source rather than a
// third party. The rows look like:
//
//   <div class="release-date">August 26</div><small ...>8:30 AM</small>
//   ... <td class="release-title ...">Personal Income and Outlays, July 2026</td>
//
// The release date carries no year. Rather than assume the current one — which
// breaks every December, when January's release belongs to the next year — the
// year is derived from the REFERENCE month in the title: a report for month M
// publishes in M+1.
const BEA_SCHEDULE = 'https://www.bea.gov/news/schedule';

const MONTH_NUM = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

async function fetchBeaPersonalIncome() {
  const r = await axios.get(BEA_SCHEDULE, { headers: { 'User-Agent': UA }, timeout: 20000 });
  const html = String(r.data);
  const rowRe = /<div class="release-date">([A-Za-z]+)\s+(\d{1,2})<\/div>\s*<small[^>]*>([^<]*)<\/small>[\s\S]{0,600}?<td class="release-title[^"]*"[^>]*>([^<]+)<\/td>/g;

  const rows = [];
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const [, relMonth, relDay, time, rawTitle] = m;
    const title = rawTitle.trim();
    if (!/^Personal Income and Outlays/i.test(title)) continue;

    const ref = title.match(/,\s*([A-Za-z]+)\s+(\d{4})/);
    if (!ref || !MONTH_NUM[relMonth] || !MONTH_NUM[ref[1]]) continue;

    // A report for month M publishes in M+1, so the release year rolls over
    // with it. December's report is a January release of the following year.
    const refMonth = MONTH_NUM[ref[1]];
    const refYear = Number(ref[2]);
    const relYear = MONTH_NUM[relMonth] < refMonth ? refYear + 1 : refYear;

    rows.push({
      event_date: `${relYear}-${String(MONTH_NUM[relMonth]).padStart(2, '0')}-${String(relDay).padStart(2, '0')}`,
      title: 'Personal Income and Outlays (core PCE)',
      detail: `${(time || '8:30 AM').trim()} Eastern Time. Report for ${ref[1]} ${refYear}.`,
    });
  }

  // Same guard as the main calendar: a markup change must fail loudly rather
  // than silently seed nothing and leave the panel pointing at GDP again.
  // BEA publishes roughly six months ahead, and the window shortens as the
  // year runs out, so the floor is 4 rather than a number that would fail
  // every December. It still catches a markup change, which yields zero.
  if (rows.length < 4) {
    throw new Error(`Only parsed ${rows.length} BEA Personal Income releases — bea.gov markup probably changed; fix the regex before seeding.`);
  }
  return rows;
}

async function verifyFomc(rows) {
  const r = await axios.get('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { headers: { 'User-Agent': UA }, timeout: 20000 });
  const official = r.data.replace(/\s+/g, ' ');
  const day1s = rows.filter(e => /Fed Meeting .*Day 1/.test(e.title));
  const failures = [];
  for (const e of day1s) {
    const [yyyy, mm, dd] = e.event_date.split('-');
    const monthName = Object.keys(MONTH_NAMES).find(k => MONTHS[MONTH_NAMES[k]] === mm);
    // Fed markup: <strong>July</strong> ... >28-29< — require the month and a
    // date-range starting with our day within the same meeting row.
    const pattern = new RegExp(`<strong>${monthName}(?:/[A-Za-z]+)?</strong>[^<]*</div>\\s*<div[^>]*>\\s*${Number(dd)}-`);
    if (!pattern.test(official)) failures.push(`${e.event_date} (${monthName} ${Number(dd)}-…)`);
  }
  if (failures.length) throw new Error(`FOMC cross-check failed for: ${failures.join(', ')} — not seeding. Compare feargreedmeter against federalreserve.gov manually.`);
  return day1s.length;
}

async function run() {
  console.log('Fetching calendar…');
  let rows = await fetchCalendar();
  console.log(`Parsed ${rows.length} events (${rows[0].event_date} → ${rows[rows.length - 1].event_date}).`);

  console.log('Cross-checking FOMC dates against federalreserve.gov…');
  const checked = await verifyFomc(rows);
  console.log(`✓ all ${checked} FOMC meetings match the official Fed calendar.`);

  // BEA's own schedule, merged in. PPI is deliberately absent: bls.gov returns
  // 403 to non-browser clients, the third-party feed does not carry it, and it
  // feeds no scored component here — so there is no honest source for it and
  // nothing on the panel would use it.
  let beaRows = [];
  try {
    beaRows = await fetchBeaPersonalIncome();
    console.log(`[macro-events] BEA Personal Income and Outlays: ${beaRows.length} releases (next ${beaRows.map(r => r.event_date).sort().find(d => d >= new Date().toISOString().slice(0, 10))})`);
  } catch (e) {
    console.error('[macro-events] BEA schedule failed:', e.message);
  }
  rows = [...rows, ...beaRows];

  const { error } = await supabase.from('macro_events').upsert(rows, { onConflict: 'event_date,title' });
  if (error) throw new Error(error.message);
  console.log(`✅ Seeded ${rows.length} macro events. Re-run this script around January for the new year's schedule.`);
}

run().catch(err => { console.error('❌', err.message); process.exit(1); });
