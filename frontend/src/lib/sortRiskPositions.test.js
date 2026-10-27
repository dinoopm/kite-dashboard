import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortRiskPositions } from './sortRiskPositions.js'
const rows = [
 { key:'A',symbol:'ALPHA',sector:'Energy',marketCapCategory:'Small Cap',averageMarketCapCr:9000,quantity:100,currentValue:1000,weightPct:10 },
 { key:'B',symbol:'BETA',sector:'Finance',marketCapCategory:'Large Cap',averageMarketCapCr:100000,quantity:20,currentValue:3000,weightPct:30 },
 { key:'U',symbol:'ETF',sector:'Unknown',marketCapCategory:'Unknown',averageMarketCapCr:null,quantity:5,currentValue:6000,weightPct:60 },
]
test('default sorting uses numeric allocation descending and preserves the input', () => {
 assert.deepEqual(sortRiskPositions(rows).map(r=>r.key),['U','B','A'])
 assert.deepEqual(rows.map(r=>r.key),['A','B','U'])
})
test('numeric columns toggle in both directions without lexicographic ordering', () => {
 for(const key of ['quantity','currentValue','weightPct']) {
 const asc=sortRiskPositions(rows,key,'asc');const desc=sortRiskPositions(rows,key,'desc')
 assert.deepEqual(asc.map(r=>r[key]),rows.map(r=>r[key]).sort((a,b)=>a-b))
 assert.deepEqual(desc.map(r=>r[key]),rows.map(r=>r[key]).sort((a,b)=>b-a))
 }
})
test('missing market caps always stay last in either direction', () => {
 assert.deepEqual(sortRiskPositions(rows,'averageMarketCapCr','asc').map(r=>r.key),['A','B','U'])
 assert.deepEqual(sortRiskPositions(rows,'averageMarketCapCr','desc').map(r=>r.key),['B','A','U'])
})
test('market-cap category sorts by company size, with unknown last', () => {
 assert.deepEqual(sortRiskPositions(rows,'marketCapCategory','asc').map(r=>r.key),['B','A','U'])
 assert.deepEqual(sortRiskPositions(rows,'marketCapCategory','desc').map(r=>r.key),['A','B','U'])
})
test('text columns toggle and status follows the current stock limit', () => {
 assert.deepEqual(sortRiskPositions(rows,'symbol','asc').map(r=>r.key),['A','B','U'])
 assert.deepEqual(sortRiskPositions(rows,'symbol','desc').map(r=>r.key),['U','B','A'])
 assert.equal(sortRiskPositions(rows,'status','desc',40)[0].key,'U')
 assert.equal(sortRiskPositions(rows,'status','asc',40).at(-1).key,'U')
 assert.deepEqual(sortRiskPositions(rows,'sector','desc').map(r=>r.sector),['Unknown','Finance','Energy'])
})
