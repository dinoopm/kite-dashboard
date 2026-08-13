const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDefiance, parseFirstTrust, parseGlobalXCsv, splitCsvLine, cleanSymbol, ISSUER_SOURCES,
} = require('./etfHoldings');

// Fixtures are trimmed real responses, captured 2026-08-13. The parsers are
// pure, so they are tested here rather than by hitting five fund websites —
// but every shape below (the stray non-holdings table, the quoted thousands
// separators, the Bloomberg country codes) is one the live pages actually
// contain, not an invented edge case.

const DEFIANCE_QTUM = `
<table><tr><th>Ticker</th><th>Name</th></tr>
  <tr><td>ARQQ</td><td >Arqit Quantum Inc</td><td>G0454E113</td><td >2.31%</td><td>1,204,996</td></tr>
  <tr><td>IONQ</td><td >Ionq Inc</td><td>46222L108</td><td >0.89%</td><td>1,138,941</td></tr>
  <tr><td>RGTI</td><td >Rigetti Computing Inc</td><td>76655K102</td><td >0.72%</td><td>2,004,111</td></tr>
</table>
<table><tr><td>Fund inception</td><td>September 2018</td><td>not a holding</td></tr></table>`;

const FIRST_TRUST_CIBR = `
<table>
  <tr><td>Palo Alto Networks, Inc.</td><td>PANW</td><td>697435105</td><td>Software</td><td align="right">4,016,403</td></tr>
  <tr><td>CrowdStrike Holdings, Inc.</td><td>CRWD</td><td>22788C105</td><td>Software</td><td align="right">1,200,000</td></tr>
</table>`;

const GLOBALX_URA_CSV = [
  'Global X Uranium ETF',
  'Fund Holdings Data as of 08/12/2026',
  '% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)',
  '22.32,CCO CN,CAMECO CORP,2175672,99.09,"14,000,000.00","1,387,260,000.00"',
  '6.19,OKLO,OKLO INC,BMD78K7,45.13,"8,679,272.00","391,695,545.36"',
  '3.35,EFR CN,ENERGY FUELS INC,2310624,11.20,"1,000,000.00","11,200,000.00"',
  '1.80,YCA LN,YELLOW CAKE PLC,BF50RG4,8.10,"500,000.00","4,050,000.00"',
  '0.14,MGA CN,MEGA URANIUM LTD,2817833,0.438108234155149,"20,013,978.00","8,768,288.56"',
  ',,CASH,,,,',
  '',
].join('\n');

describe('parseDefiance', () => {
  const rows = parseDefiance(DEFIANCE_QTUM);

  test('reads ticker and name in issuer column order', () => {
    assert.deepEqual(rows[0], { symbol: 'ARQQ', name: 'Arqit Quantum Inc' });
  });

  // The whole reason this parser exists: StockAnalysis's free tier caps at the
  // top 25 by weight, and QTUM is near equal-weight, so the three names anyone
  // opens a quantum fund to see were below the cut.
  test('reaches the small positions the capped source omits', () => {
    for (const s of ['IONQ', 'RGTI']) {
      assert.ok(rows.some(r => r.symbol === s), `${s} missing`);
    }
  });

  test('ignores tables that are not holdings', () => {
    assert.equal(rows.length, 3);
    assert.ok(!rows.some(r => r.name.includes('inception')));
  });
});

describe('parseFirstTrust', () => {
  test('reads the opposite column order without confusing name for ticker', () => {
    const rows = parseFirstTrust(FIRST_TRUST_CIBR);
    assert.deepEqual(rows[0], { symbol: 'PANW', name: 'Palo Alto Networks, Inc.' });
    assert.equal(rows.length, 2);
  });
});

describe('splitCsvLine', () => {
  // Global X quotes only the fields containing commas, so a naive split shifts
  // every column after the first thousands-separated number.
  test('keeps quoted commas inside their field', () => {
    assert.deepEqual(
      splitCsvLine('22.32,CCO CN,CAMECO CORP,2175672,99.09,"14,000,000.00"'),
      ['22.32', 'CCO CN', 'CAMECO CORP', '2175672', '99.09', '14,000,000.00'],
    );
  });
});

describe('parseGlobalXCsv', () => {
  const rows = parseGlobalXCsv(GLOBALX_URA_CSV);

  test('skips the title preamble and finds the header row', () => {
    assert.ok(rows.length > 0);
    assert.ok(!rows.some(r => r.name.includes('Fund Holdings Data')));
  });

  test('maps a confirmed dual listing to its US ticker', () => {
    // Cameco is 22.3% of URA and was dropped by both sources before this.
    const ccj = rows.find(r => r.symbol === 'CCJ');
    assert.ok(ccj, 'Cameco missing');
    assert.equal(ccj.name, 'CAMECO CORP');
    assert.ok(rows.some(r => r.symbol === 'UUUU'), 'Energy Fuels missing');
  });

  test('drops foreign lines with no US listing rather than inventing one', () => {
    // "MGA CN" must not become "MGA" (Magna International) and "YCA LN" must
    // not become "YCA". A generated ticker that prices while naming the wrong
    // company is worse than a missing row.
    for (const s of ['MGA', 'YCA', 'CCO']) {
      assert.ok(!rows.some(r => r.symbol === s), `invented ${s}`);
    }
  });

  test('drops the cash row', () => {
    assert.ok(!rows.some(r => /cash/i.test(r.name)));
  });

  test('returns nothing rather than guessing when the header is absent', () => {
    assert.deepEqual(parseGlobalXCsv('no header here\njust,some,text'), []);
  });
});

describe('cleanSymbol', () => {
  test('resolves mapped foreign tickers and rejects unmapped ones', () => {
    assert.equal(cleanSymbol('CCO CN'), 'CCJ');
    assert.equal(cleanSymbol('7203 JP'), 'TM');
    assert.equal(cleanSymbol('U-U CN'), null);   // explicitly dropped
    assert.equal(cleanSymbol('336260 KS'), null); // unmapped, has a space
    assert.equal(cleanSymbol('BRK.B'), 'BRK.B');
  });
});

describe('ISSUER_SOURCES', () => {
  // Measured, not assumed: the first version of this change routed UFO to
  // Procure's fund page, which publishes only a top-10 table — 10 names against
  // StockAnalysis's 24. The only full Procure lists are semi-annual
  // Schedule-of-Investments files, four months stale. An issuer source is only
  // worth having when it beats what it replaces.
  test('does not route UFO to its issuer', () => {
    assert.equal(ISSUER_SOURCES.UFO, undefined);
  });

  test('covers the funds whose issuers do serve a full current list', () => {
    assert.deepEqual(Object.keys(ISSUER_SOURCES).sort(), ['CIBR', 'HYDR', 'QTUM', 'URA']);
  });

  test('every source declares a URL and a parser', () => {
    for (const [sym, src] of Object.entries(ISSUER_SOURCES)) {
      assert.match(src.url, /^https:\/\//, `${sym} url`);
      assert.equal(typeof src.parse, 'function', `${sym} parser`);
    }
  });
});
