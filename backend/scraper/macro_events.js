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
  const rows = await fetchCalendar();
  console.log(`Parsed ${rows.length} events (${rows[0].event_date} → ${rows[rows.length - 1].event_date}).`);

  console.log('Cross-checking FOMC dates against federalreserve.gov…');
  const checked = await verifyFomc(rows);
  console.log(`✓ all ${checked} FOMC meetings match the official Fed calendar.`);

  const { error } = await supabase.from('macro_events').upsert(rows, { onConflict: 'event_date,title' });
  if (error) throw new Error(error.message);
  console.log(`✅ Seeded ${rows.length} macro events. Re-run this script around January for the new year's schedule.`);
}

run().catch(err => { console.error('❌', err.message); process.exit(1); });
