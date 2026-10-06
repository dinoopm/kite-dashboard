const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CAP_GROUPS, validateCaps, parseConstituents, createCapUniverse } = require('./capUniverse');
const csv = (count, prefix = 'STOCK') => 'Company Name,Industry,Symbol,Series,ISIN Code\n' + Array.from({ length: count }, (_, i) => `Company ${i},Test,${prefix}${i},EQ,INE${String(i).padStart(9, '0')}`).join('\n');

test('validates selectable caps and refuses empty, duplicated and unknown scopes', () => {
  for (const caps of [['small'], ['mid'], ['large'], ['large', 'mid', 'small']]) assert.doesNotThrow(() => validateCaps(caps));
  for (const caps of [null, [], ['nano'], ['mid', 'mid']]) assert.throws(() => validateCaps(caps));
});

test('parses official membership headers and rejects incomplete or malformed CSV', () => {
  assert.equal(parseConstituents(csv(50), CAP_GROUPS[0]).list.length, 50);
  for (const data of ['<html>Denied</html>', csv(2), csv(50).replace('Symbol', 'Ticker'), csv(50).replace('STOCK0', 'invalid symbol')]) assert.throws(() => parseConstituents(data, CAP_GROUPS[0]));
});

test('selected groups are deduplicated, cached for 24 hours and lookups coalesce', async () => {
  let reads = 0, time = 1_000;
  const service = createCapUniverse({ now: () => time, fetchCsv: async url => { reads++; return csv(url.includes('smallcap') ? 250 : url.includes('midcap') ? 100 : 50); } });
  const [a, b] = await Promise.all([service.resolve(['large', 'mid', 'small']), service.resolve(['large', 'mid', 'small'])]);
  assert.equal(reads, 3);
  assert.equal(a.list.length, 250);
  assert.deepEqual(a.list[0].capGroups, ['large', 'mid', 'small']);
  assert.deepEqual(a, b);
  assert.equal(a.sources.length, 3);
  await service.resolve(['small']); assert.equal(reads, 3);
  time += 24 * 60 * 60 * 1000;
  await service.resolve(['small']); assert.equal(reads, 4);
});

test('upstream errors fail the universe visibly and can retry without serving a partial group', async () => {
  let fail = true;
  const service = createCapUniverse({ fetchCsv: async url => {
    if (url.includes('smallcap') && fail) throw new Error('HTTP 429');
    return csv(url.includes('smallcap') ? 250 : 50);
  } });
  await assert.rejects(service.resolve(['large', 'small']), /429/);
  fail = false;
  assert.equal((await service.resolve(['large', 'small'])).list.length, 250);
});

test('trade-to-trade equities use their BE symbol; REITs and dummy index placeholders are explicitly excluded', () => {
  const data = csv(50) + '\nTrade stock,Test,TRADE,BE,INE123456789\nREIT,Test,REIT,RR,INE123456788\nDummy HEG,Test,DUMMYHEG,EQ,DUM545A01024';
  const result = parseConstituents(data, CAP_GROUPS[0]);
  assert.ok(result.list.some(row => row.symbol === 'TRADE-BE'));
  assert.equal(result.excluded.length, 2);
});
