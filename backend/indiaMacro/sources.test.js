const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCpi, parseGdp, parseForex, parseFiscal, parseRepo, parsePolicy, parseCurrentAccount, request, createSources } = require('./sources');
const api = data => JSON.stringify({ data, meta_data: { totalPages: 1 } });
test('CPI selects national combined general inflation, not index or state inflation', () => {
  const row={base_year:'2024',year:'2026',month:'August',state:'All India',sector:'Combined',division:'CPI (General)',inflation:'4.82',index:'108.74'};
  const out=parseCpi(api([row,{...row,sector:'Rural',inflation:'5.23'},{...row,state:'Delhi'},{...row,division:'Food and beverages'}]),'https://api.mospi.gov.in/');
  assert.equal(out.length,1); assert.equal(out[0].value,4.82); assert.equal(out[0].releaseDate,null); assert.equal(out[0].periodEnd,'2026-08-31');
});
test('GDP uses constant-price YoY growth and its actual fiscal quarter', () => {
  const out=parseGdp(api([{indicator:'GDP Growth Rate',frequency:'Quarterly',base_year:'2022-23',year:'2026-27',quarter:'Q1',constant_price:'7.8',current_price:'10.3'}]),'https://api.mospi.gov.in/');
  assert.equal(out[0].value,7.8); assert.equal(out[0].status,'estimate'); assert.equal(out[0].periodEnd,'2026-06-30');
});
test('RBI reserves uses latest US-dollar level, not rupee level or change', () => {
  const html='<p>Date : Oct 02, 2026</p><p>As on September 25, 2026 · US$ Mn.</p><table><tr><td>1 Total Reserves</td><td>7164287</td><td>747557</td><td>-178698</td><td>-18343</td></tr></table>';
  const o=parseForex(html,'https://www.rbi.org.in/')[0]; assert.equal(o.value,747.557); assert.equal(o.releaseDate,'2026-10-02'); assert.equal(o.periodEnd,'2026-09-25');
});
test('CGA separates YTD actual, full-year budget and percent of budget, tolerating empty spacer cells', () => {
  const html='<h1>AS AT THE END OF AUGUST 2026</h1><p>Rs. in Crore · Budget Estimates 2026-2027</p><table><tr><td>13</td><td>Fiscal Deficit (12-7)</td><td></td><td>1695768</td><td>710249</td><td>41.9%</td><td>(38.1%)</td></tr></table>';
  const o=parseFiscal(html,'https://cga.nic.in/')[0]; assert.equal(o.value,710249); assert.equal(o.budgetEstimate,1695768); assert.equal(o.percentOfBudget,41.9); assert.equal(o.releaseDate,null);
});
test('RBI current rate has a check-date reference, separately dated MPC decision', () => {
  const o=parseRepo('<table><tr><th>Policy Repo Rate</th><td>: 5.25%</td></tr></table>','https://www.rbi.org.in/',new Date('2026-10-03'));
  assert.equal(o.releaseDate,null); assert.equal(o.value,5.25);
  const d=parsePolicy('<p>Date : Aug 05, 2026</p><p>policy repo rate unchanged at 5.25 per cent; monetary policy stance as neutral</p>','https://www.rbi.org.in/');
  assert.equal(d.periodEnd,'2026-08-05'); assert.equal(d.stance,'neutral');
});
test('current account preserves the sign convention for deficit and surplus', () => {
  const html='<p>Date : Sep 01, 2026</p><p>current account deficit stood at US$ 4.2 billion (0.5 per cent of GDP) in Q1:2026-27</p>';
  assert.equal(parseCurrentAccount(html,'https://www.rbi.org.in/')[0].value,-0.5);
  assert.equal(parseCurrentAccount(html.replace('deficit','surplus'),'https://www.rbi.org.in/')[0].value,0.5);
});
test('malformed and truncated responses fail closed', () => {
  for(const text of ['not JSON',JSON.stringify({data:[]}),JSON.stringify({data:[{}],meta_data:{totalPages:2}})]) assert.throws(() => parseCpi(text,'https://api.mospi.gov.in/'));
  assert.throws(() => parseForex('<p>new layout</p>','https://www.rbi.org.in/'));
  assert.throws(() => parseFiscal('<p>new layout</p>','https://cga.nic.in/'));
  assert.throws(() => parseRepo('<p>new layout</p>','https://www.rbi.org.in/',new Date()));
});
test('HTTP rate limits and server failures retry with bounded backoff; 404 fails immediately', async () => {
  const delays=[]; let calls=0;
  const result=await request('https://api.mospi.gov.in/', {fetchImpl:async()=>{calls++;return new Response(calls===3?'ok':'', {status:calls===1?429:calls===2?503:200,headers:{'Retry-After':'2'}})},wait:async ms=>delays.push(ms)});
  assert.equal(result,'ok'); assert.deepEqual(delays,[2000,2000]);
  calls=0; await assert.rejects(request('https://api.mospi.gov.in/',{fetchImpl:async()=>{calls++;return new Response('',{status:404})},wait:async()=>{}})); assert.equal(calls,1);
});
test('empty CPI after filtering is reported by the service, never substituted with another region', () => {
  assert.deepEqual(parseCpi(api([{state:'Delhi',sector:'Combined',division:'CPI (General)'}]),'https://api.mospi.gov.in/'),[]);
});
test('current policy rate remains usable when MPC history fails', async () => {
  const sources=createSources({fetchImpl:async url=>url==='https://www.rbi.org.in/'?new Response('<table><tr><td>Policy Repo Rate</td><td>5.25%</td></tr></table>'):new Response('',{status:404}),wait:async()=>{}});
  const [o]=await sources.repo(); assert.equal(o.value,5.25); assert.equal(o.historyIncomplete,true);
});
