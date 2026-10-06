// Official MoSPI API routes/filters verified against nso-india/mospi-esankhyiki.
// Parsers deliberately reject unknown layouts instead of recycling old figures.
const cheerio = require('cheerio');
const axios = require('axios');
const https = require('node:https');
const { constants } = require('node:crypto');
const { MONTHS, numeric, dateFromText, monthEnd, quarterEnd } = require('./model');
const MOSPI = 'https://api.mospi.gov.in';
const RBI = 'https://www.rbi.org.in';
const CGA = 'https://cga.nic.in';
const HEADERS = { 'User-Agent': 'kite-dashboard/1.0 (India macro releases)', Accept: 'application/json,text/html' };
// MoSPI's TLS terminator requires legacy initial-server negotiation on Node
// OpenSSL. Scope compatibility to this host; certificate verification stays on.
const mospiAgent = new https.Agent({ secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT });
async function officialFetch(url, options) {
  if (new URL(url).hostname !== 'api.mospi.gov.in') return fetch(url, options);
  const r = await axios.get(url, { headers: options.headers, signal: options.signal, httpsAgent: mospiAgent, responseType: 'text', transformResponse: [x => x], validateStatus: () => true, maxContentLength: 5 * 1024 * 1024, maxRedirects: 0 });
  return new Response(r.data, { status: r.status, headers: r.headers });
}
async function request(url, { fetchImpl = officialFetch, attempts = 3, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
      if (!r.ok) { const e = new Error(`Source HTTP ${r.status}`); e.retryable = r.status === 429 || r.status >= 500; e.retryAfter = Math.min(10000, Math.max(0, Number(r.headers.get('Retry-After')) * 1000 || 0)); throw e; }
      return await r.text();
    } catch (e) {
      last = e;
      if (e.retryable === false || i === attempts - 1) throw e;
      await wait(Math.max(e.retryAfter || 0, 500 * 2 ** i));
    }
  }
  throw last;
}
function page(html) { const $ = cheerio.load(html); $('script,style').remove(); return $; }
function clean(text) { return text.replace(/\s+/g, ' ').trim(); }
function rows($) { return $('tr').toArray().map(tr => $(tr).children('td,th').toArray().map(td => clean($(td).text()))); }
function publicationDate($) { return dateFromText(clean($.root().text()).match(/Date\s*:\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/)?.[1]); }
function dataRows(text) { const j = JSON.parse(text); if (j.statusCode === false || !Array.isArray(j.data) || !j.data.length) throw new Error('Official API returned no usable observations'); if (j.meta_data?.totalPages > 1) throw new Error('Official API response truncated'); return j.data; }
function parseCpi(text, sourceUrl) {
  return dataRows(text).filter(r => r.state === 'All India' && r.sector === 'Combined' && ['CPI (General)', 'General'].includes(r.division) && !r.group && !r.item).map(r => {
    const month = MONTHS.indexOf(r.month) + 1;
    if (!month) throw new Error('Unrecognised CPI month');
    return { value: numeric(r.inflation), periodEnd: monthEnd(r.year, month), referencePeriod: `${r.month} ${r.year}`, releaseDate: r.release_date || null, status: 'provisional', source: 'MoSPI CPI', sourceUrl, baseYear: r.base_year, note: 'All India, combined; year-on-year inflation. Latest month is provisional; publication date is absent from this API when not supplied.' };
  });
}
function parseGdp(text, sourceUrl) {
  return dataRows(text).filter(r => r.indicator === 'GDP Growth Rate' && r.frequency === 'Quarterly').map(r => {
    const q = Number(r.quarter?.replace('Q', ''));
    return { value: numeric(r.constant_price), periodEnd: quarterEnd(r.year, q), referencePeriod: `${r.quarter} FY ${r.year}`, releaseDate: r.release_date || null, status: 'estimate', source: 'MoSPI National Accounts', sourceUrl, baseYear: r.base_year, note: `Constant prices; published quarterly estimate${r.revision ? ` (${r.revision})` : ''}. Historical revisions are retained; publication date is absent from this API when not supplied.` };
  });
}
function parseForex(html, sourceUrl) {
  const $ = page(html), text = clean($.root().text());
  const periodEnd = dateFromText(text.match(/As on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i)?.[1]);
  const row = rows($).find(r => r.some(x => /^(?:1\s+)?Total Reserves$/i.test(x)));
  if (!row || !text.includes('US$ Mn.')) throw new Error('RBI reserves table layout changed');
  const idx = row.findIndex(x => /^(?:1\s+)?Total Reserves$/i.test(x));
  return [{ value: numeric(row[idx + 2]) / 1000, periodEnd, referencePeriod: `Week ended ${periodEnd}`, releaseDate: publicationDate($), status: 'provisional', source: 'RBI Weekly Statistical Supplement', sourceUrl, note: 'Total reserves, US$ million converted to billion; valuation movements are included.' }];
}
function parseCurrentAccount(html, sourceUrl) {
  const $ = page(html), text = clean($.root().text());
  const match = text.match(/current account (deficit|surplus)[\s\S]{0,160}?\(([\d.]+)\s*per cent of GDP\)\s*in\s*Q([1-4]):(\d{4}-\d{2})/i);
  if (!match) throw new Error('RBI current-account release layout changed');
  return [{ value: numeric(match[2]) * (match[1].toLowerCase() === 'deficit' ? -1 : 1), periodEnd: quarterEnd(match[4], Number(match[3])), referencePeriod: `Q${match[3]} FY ${match[4]}`, releaseDate: publicationDate($), status: 'provisional', source: 'RBI Balance of Payments', sourceUrl, note: 'Balance as a share of GDP; negative indicates deficit, positive indicates surplus.' }];
}
function parsePolicy(html, sourceUrl) {
  const $ = page(html), text = clean($.root().text());
  const rate = text.match(/policy repo rate[\s\S]{0,120}?(?:at|to)\s+([\d.]+)\s*per cent/i);
  if (!rate) throw new Error('RBI MPC rate not found');
  const date = publicationDate($);
  const stance = text.match(/\b(neutral|accommodative|withdrawal of accommodation)\s+stance\b/i)?.[1] || text.match(/stance[\s\S]{0,60}?\b(neutral|accommodative|withdrawal of accommodation)\b/i)?.[1] || null;
  return { value: numeric(rate[1]), periodEnd: date, referencePeriod: `MPC decision ${date}`, releaseDate: date, status: 'actual', source: 'RBI MPC statement', sourceUrl, stance, note: 'Policy rate announced in the official MPC statement.' };
}
function parseRepo(html, sourceUrl, now) {
  const $ = page(html), row = rows($).find(r => /^Policy Repo Rate$/i.test(r[0]));
  if (!row) throw new Error('RBI current-rates layout changed');
  const today = now.toISOString().slice(0, 10);
  const extra = name => { const r = rows($).find(x => x[0] === name); return r ? numeric(r[1].replace(/[:%\s]/g, '')) : null; };
  return { value: numeric(row[1].replace(/[:%\s]/g, '')), periodEnd: today, referencePeriod: `Current rate checked ${today}`, releaseDate: null, status: 'actual', source: 'RBI Current Rates', sourceUrl, crr: extra('CRR'), slr: extra('SLR'), note: 'Current published rate; the homepage does not specify its effective date.' };
}
function parseFiscal(html, sourceUrl) {
  const $ = page(html), text = clean($.root().text());
  const date = text.match(/AS AT THE END OF\s+([A-Za-z]+)\s+(\d{4})/i);
  const fy = text.match(/Budget Estimates\s+(\d{4})-(\d{4})/i);
  if (!date || !fy || !/Rs\.?\s*\.?\s*in Crore/i.test(text)) throw new Error('CGA reference period or units missing');
  const row = rows($).find(r => r.some(x => /^Fiscal Deficit\s*\(12-7\)$/i.test(x)))?.filter(Boolean);
  const idx = row?.findIndex(x => /^Fiscal Deficit/i.test(x));
  if (!row || idx < 0) throw new Error('CGA fiscal-deficit row missing');
  const actual = numeric(row[idx + 2]), budget = numeric(row[idx + 1]);
  if (budget <= 0) throw new Error('Invalid CGA budget estimate');
  const month = MONTHS.findIndex(m => m.toLowerCase() === date[1].toLowerCase()) + 1;
  if (!month) throw new Error('Unknown CGA reference month');
  const percentOfBudget = numeric(row[idx + 3].replace('%', ''));
  if (Math.abs(actual / budget * 100 - percentOfBudget) > 0.2) throw new Error('CGA actual/budget columns failed validation');
  return [{ value: actual, periodEnd: monthEnd(date[2], month), referencePeriod: `April–${MONTHS[month - 1]} ${date[2]} · FY ${fy[1]}-${fy[2].slice(2)}`, releaseDate: null, status: 'provisional', source: 'CGA Union Government Accounts', sourceUrl, budgetEstimate: budget, percentOfBudget, note: 'Unaudited cumulative fiscal actuals in rupees; not a full-year deficit-to-GDP ratio. CGA does not provide a publication date in this table.' }];
}
function officialLink(base, href) {
  const url = new URL(href, base);
  if (url.protocol !== 'https:' || url.hostname.replace(/^www\./, '') !== new URL(base).hostname.replace(/^www\./, '')) throw new Error('Unexpected official document host');
  return url.href;
}
function createSources({ fetchImpl = officialFetch, now = () => new Date(), wait } = {}) {
  const get = url => request(url, { fetchImpl, wait });
  return {
    cpi: async () => {
      const meta = JSON.parse(await get(`${MOSPI}/api/cpi/getCpiBaseYear`));
      const base = meta.data?.base_year?.map(x => Number(x.base_year)).sort((a,b) => b-a)[0];
      if (!base) throw new Error('CPI base-year discovery failed');
      const filters = JSON.parse(await get(`${MOSPI}/api/cpi/getCpiFilterByLevelAndBaseYear?base_year=${base}&level=Group&series=Current`)).data?.[0];
      const allIndia = filters?.state?.find(x => x.state_name === 'All India')?.state_code;
      const combined = filters?.sector?.find(x => x.sector_name === 'Combined')?.sector_code;
      const general = filters?.division?.find(x => x.division_name === 'CPI (General)')?.division_code;
      const year = Math.max(...(filters?.year || []).filter(x => x.series === 'Current').map(x => Number(x.year)));
      if (allIndia == null || combined == null || general == null || !Number.isFinite(year)) throw new Error('CPI filters changed');
      const url = `${MOSPI}/api/cpi/getCPIData?base_year=${base}&year=${year}&series=Current&level=Group&state_code=${allIndia}&sector_code=${combined}&division_code=${general}&limit=100`;
      return parseCpi(await get(url), url);
    },
    gdp: async () => {
      const meta = JSON.parse(await get(`${MOSPI}/api/nas/getNasIndicatorList?account_code=1`)).data;
      const base = meta?.base_year?.map(x => x.base_year).sort().at(-1);
      const indicator = meta?.quarter_indicator?.find(x => x.description === 'GDP Growth Rate')?.indicator_code;
      if (!base || !indicator) throw new Error('GDP indicator discovery failed');
      const url = `${MOSPI}/api/nas/getNASData?indicator_code=${indicator}&base_year=${base}&frequency_code=2&account_code=1&series=Current&limit=100`;
      return parseGdp(await get(url), url);
    },
    repo: async () => {
      const current = parseRepo(await get(`${RBI}/`), `${RBI}/`, now());
      // A missing decision history must not hide an otherwise usable current rate.
      try {
        const $ = page(await get(`${RBI}/scripts/Annualpolicy.aspx`));
        const links = $('a').toArray().filter(a => /Governor[’']s Statement:/i.test($(a).text())).slice(0, 4);
        const decisions = [];
        for (const link of links) {
          const url = officialLink(RBI, $(link).attr('href'));
          decisions.push(parsePolicy(await get(url), url));
        }
        const latest = decisions.sort((a,b) => b.periodEnd.localeCompare(a.periodEnd))[0];
        current.decisions = decisions.map(d => ({ date: d.periodEnd, rate: d.value, stance: d.stance, sourceUrl: d.sourceUrl }));
        current.stance = latest?.stance || null;
        current.effectiveDate = latest?.value === current.value ? latest.periodEnd : null;
        current.historyIncomplete = !latest || latest.value !== current.value;
      } catch (e) { current.historyIncomplete = true; current.historyError = e.message; }
      return [current];
    },
    forex: async () => { const url = `${RBI}/Scripts/BS_NSDPDisplay.aspx?param=2`; return parseForex(await get(url), url); },
    currentAccount: async () => {
      const $ = page(await get(`${RBI}/Scripts/BS_NSDPDisplay.aspx`));
      const link = $('a').toArray().find(a => /^Balance of Payments \(2\)$/i.test(clean($(a).text())));
      if (!link) throw new Error('RBI latest quarterly BoP link missing');
      const url = officialLink(RBI, $(link).attr('href'));
      return parseCurrentAccount(await get(url), url);
    },
    fiscal: async () => {
      const year = now().getUTCFullYear() - (now().getUTCMonth() < 3 ? 1 : 0);
      let last;
      for (const start of [year, year-1]) {
        try {
          const $ = page(await get(`${CGA}/MonthlyReport/Published/6/${start}-${start+1}.aspx`));
          const links = $('a').toArray().map(a => ({ text: clean($(a).text()), href: $(a).attr('href') })).filter(a => new RegExp(`^(${MONTHS.join('|')}),${start}-${start+1}$`).test(a.text));
          links.sort((a,b) => {
            const order = s => (MONTHS.indexOf(s.split(',')[0]) + 9) % 12;
            return order(b.text) - order(a.text);
          });
          if (!links.length) throw new Error('CGA published months unavailable');
          const reportUrl = officialLink(CGA, links[0].href);
          const report = page(await get(reportUrl));
          const frame = report('iframe').attr('src');
          if (!frame) throw new Error('CGA monthly accounts document missing');
          const url = officialLink(CGA, frame).split('?')[0];
          return parseFiscal(await get(url), url);
        } catch(e) { last=e; }
      }
      throw last;
    },
  };
}
module.exports = { request, parseCpi, parseGdp, parseForex, parseCurrentAccount, parseRepo, parsePolicy, parseFiscal, createSources };
