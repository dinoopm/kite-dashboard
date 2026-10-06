const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SERIES } = require('./model');
const { createIndiaMacroService, nextDelay } = require('./service');
function fixture() {
  let date=new Date('2026-10-03T12:00:00Z'), value=4.82, fail=false, calls=0, active=0, peak=0;
  const states={};
  const store={read:async key=>({state:states[key],storage:'shared'}),write:async(key,state)=>{states[key]=structuredClone(state);return {storage:'shared'}}};
  const sources=Object.fromEntries(Object.keys(SERIES).map(key=>[key,async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;if(fail&&key==='cpi')throw new Error('timeout');return [{value:key==='forex'?747.557:key==='fiscal'?710249:value,periodEnd:'2026-08-31',referencePeriod:'Fixture period',status:'provisional',source:'Official fixture',sourceUrl:'https://api.mospi.gov.in/'}]}]));
  return {service:createIndiaMacroService({store,sources,now:()=>date}),states,store,sources,now:()=>date,advance:ms=>date=new Date(+date+ms),setValue:v=>value=v,setFail:()=>fail=true,stats:()=>({calls,peak})};
}
test('coalesces concurrent syncs and bounds source concurrency to three', async()=>{
  const f=fixture(); await Promise.all([f.service.sync(),f.service.sync()]); assert.equal(f.stats().calls,6); assert.equal(f.stats().peak,3); assert.equal(f.states.cpi.observations.length,1);
});
test('daily checks skip fresh series; retries follow persisted exponential backoff',async()=>{
  const f=fixture();await f.service.sync();await f.service.sync();assert.equal(f.stats().calls,6);
  f.advance(86400000);f.setFail();await f.service.sync();assert.equal(f.states.cpi.error,'timeout');
  f.advance(14*60000);await f.service.sync();assert.equal(f.stats().calls,12);
  f.advance(60000);await f.service.sync();assert.equal(f.stats().calls,13);assert.equal(f.states.cpi.failures,2);
  assert.equal(nextDelay(100),6*3600000);
});
test('failed refresh retains last successful value and timestamps', async()=>{
  const f=fixture();await f.service.sync();const good=f.states.cpi.lastSuccessfulCheckAt;f.advance(120000);f.setFail();const r=await f.service.sync({force:true});
  assert.equal(r.series.cpi.latest.value,4.82);assert.equal(r.series.cpi.lastSuccessfulCheckAt,good);assert.notEqual(r.series.cpi.lastCheckedAt,good);assert.equal(r.series.cpi.availability,'stale');
});
test('restart reads durable revisions; unchanged checks do not add data and changes do',async()=>{
  const f=fixture();await f.service.sync();f.advance(120000);await f.service.sync({force:true});assert.equal(f.states.cpi.observations.length,1);
  f.setValue(4.83);f.advance(120000);await f.service.sync({force:true});
  const restarted=createIndiaMacroService({store:f.store,sources:f.sources,now:f.now});const r=await restarted.get();assert.equal(r.series.cpi.latest.value,4.83);assert.equal(r.series.cpi.revisionCount,1);
});
test('invalid data cannot overwrite existing releases; manual refresh observes the cooldown',async()=>{
  const f=fixture();await f.service.sync();f.setValue(Infinity);await f.service.sync({force:true});assert.equal(f.stats().calls,6);
  f.advance(120000);const r=await f.service.sync({force:true});assert.equal(r.series.cpi.latest.value,4.82);assert.match(r.series.cpi.error,/invalid/);
});
