import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArchiveOutbox } from '../dist/archive-outbox.js';
test('failed save remains durable across process restart', async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'archive-test-'));try{
  const q=new ArchiveOutbox(dir,async()=>{throw Error('offline');});await q.enqueue({id:'1',editedAt:'time'});
  await assert.rejects(q.drain(),/offline/);assert.equal((await readdir(dir)).length,1);
  const saved=[];await new ArchiveOutbox(dir,async x=>{saved.push(x);}).drain();
  assert.equal(saved[0].editedAt,'time');assert.equal((await readdir(dir)).length,0);
 }finally{await rm(dir,{recursive:true});}
});
test('concurrent drains save each queued event once',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'archive-test-'));try{
  const seen=[];const q=new ArchiveOutbox(dir,async x=>{seen.push(x.id);});
  await q.enqueue({id:'1'});await q.enqueue({id:'2'});await Promise.all([q.drain(),q.drain()]);
  assert.deepEqual(seen.sort(),['1','2']);
 }finally{await rm(dir,{recursive:true});}
});
test('corrupt entry is retained and never treated as saved',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'archive-test-'));try{
  await writeFile(path.join(dir,'100-aaaa.json'),'{');let saves=0;
  await assert.rejects(new ArchiveOutbox(dir,async()=>{saves++;}).drain());
  assert.equal(saves,0);assert.equal((await readdir(dir)).length,1);
 }finally{await rm(dir,{recursive:true});}
});
