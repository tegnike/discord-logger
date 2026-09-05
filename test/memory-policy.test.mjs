import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMemoryPolicy } from '../dist/memory-policy.js';
const contract={version:1,guildId:'1',discordChannels:['2'],twitterArchiveApproved:true,allowLegacyDiscordAuthor:true,
 runtimeModes:{'discord-public':'shadow','x-public':'shadow'},routes:{'discord-public':{'discord:channel:2':['discord:channel:2','twitter:public']},'x-public':{'twitter:public':['discord:channel:2','twitter:public']}}};
test('failed or private Discord permission removes its source and destination',()=>{
 const p=deriveMemoryPolicy(contract,new Set(),0);
 assert.equal(p.scopes['discord:channel:2'],undefined);
 assert.deepEqual(p.runtimes['discord-public'].destinations,{});
 assert.deepEqual(p.runtimes['x-public'].destinations['twitter:public'],['twitter:public']);
});
test('approved readable channels receive a bounded lease',()=>{
 const p=deriveMemoryPolicy(contract,new Set(['2']),0);
 assert.equal(Date.parse(p.scopes['discord:channel:2'].expires_at),540000);
 assert.equal(p.runtimes['discord-public'].mode,'shadow');
 assert.equal(p.scopes['discord:channel:3'],undefined);
});


test("permission changes during refresh trigger a serialized fresh publication", async () => {
  const { createPolicyRefresher } = await import("../dist/memory-policy.js");
  let release;
  let active = 0, maximum = 0, calls = 0;
  const first = new Promise(resolve => { release = resolve; });
  const refresh = createPolicyRefresher(async () => {
    active++; maximum = Math.max(maximum, active); calls++;
    if (calls === 1) await first;
    active--;
  });
  const pending = refresh();
  refresh(); refresh();
  release(); await pending;
  assert.equal(maximum, 1); assert.equal(calls, 2);
});
