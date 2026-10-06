const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('./store');
test('local persistence survives restart and leaves no partial files',async(t)=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'india-macro-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createStore({directory});const state={observations:[{value:4.82}],lastCheckedAt:'2026-10-03T12:00:00Z'};
  assert.equal((await store.read('cpi')).state,null);await store.write('cpi',state);
  assert.deepEqual((await createStore({directory}).read('cpi')).state,state);assert.deepEqual(await fs.readdir(directory),['cpi.json']);
});
test('shared writes use private immutable checkpoints; outages retain local state',async(t)=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'india-macro-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let fail=false;const files=new Map();
  const supabase={storage:{getBucket:async()=>({data:{}}),from:()=>({list:async()=>({data:[...files.keys()].sort().slice(0,1).map(p=>({name:p.split('/')[1]}))}),download:async p=>({data:new Blob([files.get(p)])}),upload:async(p,body,opts)=>{assert.equal(opts.upsert,false);if(fail)return {error:new Error('offline')};files.set(p,body);return {}}})}};
  const store=createStore({directory,supabase});const state={observations:[{value:4.82}],lastCheckedAt:'2026-10-03T12:00:00Z'};
  assert.equal((await store.write('cpi',state)).storage,'shared');await store.write('cpi',{...state,lastCheckedAt:'2026-10-03T12:02:00Z'});assert.equal(files.size,2);
  assert.equal((await store.read('cpi')).state.lastCheckedAt,'2026-10-03T12:02:00Z');
  fail=true;const failed=await store.write('cpi',{...state,lastCheckedAt:'2026-10-03T12:04:00Z'});assert.equal(failed.storage,'local');assert.match(failed.warning,/offline/);assert.equal((await store.read('cpi')).state.lastCheckedAt,'2026-10-03T12:04:00Z');
});
