import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withMarketCapRisk } from './marketCapRisk.js'
const catalog = { periodEnd:'2026-06-30',sourceUrl:'https://portal.amfiindia.com/reference.xlsx', records:[{isin:'INE000000001',nse:'LARGE',category:'Large Cap',rank:1,averageMarketCapCr:100000},{isin:'INE000000002',nse:'SMALL',category:'Small Cap',rank:300,averageMarketCapCr:15000}] }
test('existing sessions receive value-weighted AMFI exposure with unknown value retained', () => {
 const data={summary:{coveredValue:100},positions:[{key:'L',isin:'INE000000001',symbol:'RENAMED',exchange:'NSE',currentValue:60},{key:'S',symbol:'SMALL-BE',exchange:'NSE',currentValue:30},{key:'U',symbol:'ETF',exchange:'NSE',currentValue:10}]}
 const out=withMarketCapRisk(data,catalog)
 assert.equal(out.positions[0].marketCapCategory,'Large Cap')
 assert.equal(out.positions[1].marketCapCategory,'Small Cap')
 assert.equal(out.positions[2].marketCapCategory,'Unknown')
 assert.equal(out.marketCapitalization.classificationCoveragePct,90)
 assert.equal(out.marketCapitalization.midSmallWeightPct,30)
 assert.equal(out.marketCapitalization.groups.reduce((sum,g)=>sum+g.weightPct,0),100)
 assert.equal(out.marketCapitalization.groups[3].weightPct,10)
 assert.equal(data.positions[0].marketCapCategory,undefined)
})
test('a mismatched ISIN is never assigned another security with the same ticker', () => {
 const out=withMarketCapRisk({summary:{coveredValue:100},positions:[{isin:'INF123456789',symbol:'LARGE',exchange:'NSE',currentValue:100}]},catalog)
 assert.equal(out.positions[0].marketCapCategory,'Unknown')
})
test('server-provided classifications are preferred; missing reference keeps existing analysis intact', () => {
 const data={positions:[],marketCapitalization:{status:'available'}}
 assert.equal(withMarketCapRisk(data,catalog),data)
 const old={positions:[]}
 assert.equal(withMarketCapRisk(old,null),old)
})
test('empty portfolios never invent classification coverage', () => {
 const out=withMarketCapRisk({summary:{coveredValue:0},positions:[]},catalog)
 assert.equal(out.marketCapitalization.classificationCoveragePct,0)
 assert.equal(out.marketCapitalization.groups.reduce((sum,g)=>sum+g.weightPct,0),0)
})
