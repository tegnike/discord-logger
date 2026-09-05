import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, saveMessage } from '../dist/db.js';
const input={messageId:'123',channelId:'4',userId:'user',nativeAuthorId:'5',replyToMessageId:null,content:'fixture',attachments:[],messageAt:new Date('2026-09-06T00:00:00Z'),editedAt:new Date('2026-09-06T01:00:00Z')};
test('memory ingestion transmits native author and edit timestamp in one RPC',async()=>{
 const original=globalThis.fetch;const prior=process.env.DISCORD_CHARACTER_MEMORY_INGEST;
 try{
  process.env.DISCORD_CHARACTER_MEMORY_INGEST='true';
  globalThis.fetch=async(url,init)=>{
   assert.match(String(url),/rpc\/memory_ingest_discord_message_v1$/);
   const body=JSON.parse(init.body);assert.equal(body.p_native_author,'5');assert.equal(body.p_edited_at,'2026-09-06T01:00:00.000Z');
   return new Response(JSON.stringify('source'),{status:200});
  };
  initDb('https://fixture.invalid','fixture-key');await saveMessage(input);
 }finally{globalThis.fetch=original;if(prior===undefined)delete process.env.DISCORD_CHARACTER_MEMORY_INGEST;else process.env.DISCORD_CHARACTER_MEMORY_INGEST=prior;}
});
test('database errors cannot falsely acknowledge a queued message',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response(JSON.stringify({code:'23505',message:'conflict'}),{status:409});
  initDb('https://fixture.invalid','fixture-key');await assert.rejects(saveMessage(input),/23505/);
 }finally{globalThis.fetch=original;}
});
