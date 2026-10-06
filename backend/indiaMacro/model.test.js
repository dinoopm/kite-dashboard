const { test } = require('node:test');
const assert = require('node:assert/strict');
const { numeric, quarterEnd, validateObservation, mergeObservations, latestObservation, presentSeries } = require('./model');
const now = new Date('2026-10-03T12:00:00Z');
const observation = value => ({ value, periodEnd: '2026-08-31', referencePeriod: 'August 2026', status: 'provisional', releaseDate: '2026-09-14', source: 'MoSPI', sourceUrl: 'https://api.mospi.gov.in/api/cpi/getCPIData', note: 'Fixture' });
test('numeric normalization preserves zero and rejects absent, non-finite and boolean inputs', () => {
  assert.equal(numeric('1,234.50'),1234.5); assert.equal(numeric('0'),0); assert.equal(numeric('-0.5'),-0.5);
  for (const value of [null, '', true, 'NaN', 'Infinity', '4.82%']) assert.throws(() => numeric(value));
});
test('fiscal quarters handle the calendar-year boundary', () => {
  assert.equal(quarterEnd('2026-27',1),'2026-06-30'); assert.equal(quarterEnd('2026-27',4),'2027-03-31'); assert.throws(() => quarterEnd('2026-27',5));
});
test('validation rejects future dates, implausible values, nonofficial URLs and missing classification', () => {
  assert.equal(validateObservation('cpi', observation('4.82'),now).value,4.82);
  for(const change of [{periodEnd:'2026-12-31'},{periodEnd:'2026-02-30'},{releaseDate:'2026-10-05'},{releaseDate:'2026-08-01'},{value:300},{sourceUrl:'https://example.com/'},{status:null}]) assert.throws(() => validateObservation('cpi',{...observation(4.82),...change},now));
});
test('unchanged fetches do not invent revisions; changed and reverted values retain first-seen provenance', () => {
  const a=validateObservation('cpi',observation(4.82),now), b=validateObservation('cpi',observation(4.83),now);
  let history=mergeObservations([], [a], '2026-10-01T12:00:00Z');
  history=mergeObservations(history,[a], '2026-10-02T12:00:00Z'); assert.equal(history.length,1);
  history=mergeObservations(history,[b], '2026-10-02T12:00:00Z');
  history=mergeObservations(history,[a], '2026-10-03T12:00:00Z');
  assert.equal(history.length,3); assert.equal(latestObservation(history).value,4.82); assert.equal(history[0].firstSeenAt,'2026-10-01T12:00:00Z');
});
test('older upstream responses never roll the current reference period backward', () => {
  const a=validateObservation('cpi',observation(4.82),now);
  const older=validateObservation('cpi',{...observation(4.45),periodEnd:'2026-07-31',referencePeriod:'July 2026'},now);
  assert.equal(latestObservation(mergeObservations([{...a,firstSeenAt:'2026-10-01'}],[older],'2026-10-03')).value,4.82);
});
test('freshness distinguishes missing data, failed checks, overdue data and stale checks', () => {
  assert.equal(presentSeries('cpi',null,now).availability,'unavailable');
  const state={observations:mergeObservations([],[validateObservation('cpi',observation(4.82),now)],now.toISOString()),lastCheckedAt:now.toISOString()};
  assert.equal(presentSeries('cpi',state,now).availability,'available');
  assert.equal(presentSeries('cpi',{...state,error:'timeout'},now).availability,'stale');
  assert.equal(presentSeries('cpi',state,new Date('2026-12-01')).overdue,true);
  assert.equal(presentSeries('cpi',state,new Date('2026-10-06')).checkOverdue,true);
});
test('nested decision changes and estimate-status revisions change the fingerprint', () => {
  const a=validateObservation('cpi',{...observation(4.82),decisions:[{date:'2026-08-05',rate:5.25}]},now);
  const b=validateObservation('cpi',{...observation(4.82),decisions:[{date:'2026-08-05',rate:5.5}]},now);
  assert.notEqual(a.hash,b.hash); assert.notEqual(a.hash,validateObservation('cpi',{...observation(4.82),status:'actual'},now).hash);
});
