import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculatePositionTrim } from './positionTrim.js'
const base={currentValue:30000,coveredValue:100000,quantity:300,limit:20}
test('cash trims account for the falling covered-equity denominator',()=>{
 const result=calculatePositionTrim(base)
 assert.equal(result.quantityToSell,125)
 assert.equal(result.estimatedProceeds,12500)
 assert.equal(result.remainingEquityValue,87500)
 assert.equal(result.remainingWeightPct,20)
})
test('reinvestment requires only the excess above the existing target allocation',()=>{
 const result=calculatePositionTrim({...base,proceeds:'reinvest'})
 assert.equal(result.quantityToSell,100)
 assert.equal(result.remainingEquityValue,100000)
 assert.equal(result.remainingWeightPct,20)
})
test('whole-share rounding reaches the limit while selling one fewer share would not',()=>{
 const input={currentValue:846950,coveredValue:3214742,quantity:1000,limit:20}
 for(const proceeds of ['cash','reinvest']){
 const result=calculatePositionTrim({...input,proceeds})
 assert.ok(result.remainingWeightPct<=20)
 const priorSale=(result.quantityToSell-1)*result.referencePrice
 const priorWeight=(input.currentValue-priorSale)/(input.coveredValue-(proceeds==='cash'?priorSale:0))*100
 assert.ok(priorWeight>20)
 }
})
test('unset, met, impossible and unvalued positions have no sell recommendation',()=>{
 for(const input of [{limit:''},{limit:100},{currentValue:20000},{quantity:0},{coveredValue:0},{currentValue:null},{currentValue:200000}]) assert.equal(calculatePositionTrim({...base,...input}),null)
})
test('zero target liquidates the holding; a single-position cash portfolio may require full exit',()=>{
 assert.equal(calculatePositionTrim({...base,limit:0}).quantityToSell,300)
 const all=calculatePositionTrim({...base,currentValue:100000,quantity:1000})
 assert.equal(all.quantityToSell,1000)
 assert.equal(all.remainingEquityValue,0)
 assert.equal(all.remainingWeightPct,0)
})
