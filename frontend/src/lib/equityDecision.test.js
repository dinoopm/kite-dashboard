import { test } from 'node:test'
import assert from 'node:assert/strict'
import { equityDecision } from './equityDecision.js'
const signal = (id, value, change, extra = {}) => ({ id, title: id === 'sp500' ? 'S&P 500 trend' : id === 'nasdaq100' ? 'Nasdaq 100 trend' : id, value, change3m: { value: change }, status: 'available', stale: false, ...extra })
const fixture = () => [signal('nfci', -.4, -.1), signal('credit', 3, -20), signal('realYield', 2, -10), signal('sp500', 6000, 5, { distanceFromAveragePct: 5 }), signal('nasdaq100', 21000, 3, { distanceFromAveragePct: 3 })]
test('all four agreeing inputs produce provisionally supportive assessment', () => {
 const d = equityDecision(fixture()); assert.equal(d.state, 'supportive'); assert.equal(d.supports.length, 4); assert.equal(d.cautions.length, 0)
})
test('rising credit spreads with a strong price trend produce caution', () => {
 const s=fixture();s[1].change3m.value=40;assert.equal(equityDecision(s).state,'caution')
})
test('weak trend plus widening spreads produces defensive assessment', () => {
 const s=fixture();s[1].change3m.value=40;s[3].distanceFromAveragePct=-3;assert.equal(equityDecision(s).state,'defensive')
})
test('weak trend plus tight financial conditions is defensive even with narrowing spreads', () => {
 const s=fixture();s[0].value=.1;s[3].distanceFromAveragePct=-3;assert.equal(equityDecision(s).state,'defensive')
})
test('weak trend without financing stress stays caution', () => {
 const s=fixture();s[3].distanceFromAveragePct=-3;assert.equal(equityDecision(s).state,'caution')
})
test('missing, stale and partial inputs cannot produce an actionable classification', () => {
 assert.equal(equityDecision([]).state,'incomplete');
 for(const status of ['stale','partial','unavailable']) {const s=fixture();s[1].status=status;assert.equal(equityDecision(s).state,'incomplete')}
 const s=fixture();s[0].stale=true;assert.equal(equityDecision(s).state,'incomplete')
})
test('absent comparison or trend average never counts as zero', () => {
 const s=fixture();s[2].change3m=null;assert.equal(equityDecision(s).state,'incomplete');
 const t=fixture();t[3].distanceFromAveragePct=null;assert.equal(equityDecision(t).state,'incomplete')
})
test('index selector uses the selected trend independently', () => {
 const s=fixture();s[1].change3m.value=40;s[4].distanceFromAveragePct=-5;
 assert.equal(equityDecision(s,'sp500').state,'caution');assert.equal(equityDecision(s,'nasdaq100').state,'defensive')
})
test('zero credit and real-yield changes are stable; zero NFCI is not loose', () => {
 const s=fixture();s[1].change3m.value=0;s[2].change3m.value=0;assert.equal(equityDecision(s).state,'supportive');
 s[0].value=0;assert.equal(equityDecision(s).state,'caution')
})
