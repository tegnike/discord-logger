import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PermissionFlagsBits, type Client } from 'discord.js';
import { getDb } from './db.js';

type Contract = {
  version: number; guildId: string; discordChannels: string[]; twitterArchiveApproved: boolean;
  discordPublicAudienceRoleIds?: string[]; allowLegacyDiscordAuthor: boolean; runtimeModes: Record<string, 'shadow' | 'live'>;
  routes: Record<string, Record<string, string[]>>;
};
type DiscordAudience = 'public' | 'restricted';
export function deriveMemoryPolicy(contract: Contract, readable: Map<string, DiscordAudience>, now = Date.now()) {
  if (contract.version !== 1 || !Array.isArray(contract.discordChannels)) throw Error('Invalid memory contract');
  const expires_at = new Date(now + 9 * 60_000).toISOString();
  const scopes: Record<string, unknown> = {};
  for (const channel of contract.discordChannels) {
    const audience = readable.get(channel);
    if (audience) scopes[`discord:channel:${channel}`] = {
      audience, expires_at, allow_legacy_author: contract.allowLegacyDiscordAuthor === true,
    };
  }
  if (contract.twitterArchiveApproved === true) scopes['twitter:public'] = { audience: 'public', expires_at, allow_legacy_author: false };
  const runtimes: Record<string, unknown> = {};
  for (const [runtime, routes] of Object.entries(contract.routes)) {
    const mode = contract.runtimeModes[runtime];
    if (!['shadow', 'live'].includes(mode)) throw Error('Invalid memory mode');
    const destinations: Record<string, string[]> = {};
    for (const [destination, sources] of Object.entries(routes)) {
      if ((scopes[destination] as { audience?: string } | undefined)?.audience !== 'public') continue;
      if (!Array.isArray(sources)) throw Error('Invalid memory route');
      destinations[destination] = sources.filter(source =>
        (scopes[source] as { audience?: string } | undefined)?.audience === 'public');
    }
    runtimes[runtime] = { mode, destinations };
  }
  return { core_config_hash: createHash('sha256').update(JSON.stringify(contract)).digest('hex'), scopes, runtimes };
}
export async function refreshMemoryPolicy(client: Client, contractPath: string): Promise<void> {
  const contract = JSON.parse(await readFile(contractPath, 'utf8')) as Contract;
  const readable = new Map<string, DiscordAudience>();
  try {
    const guild = await client.guilds.fetch(contract.guildId);
    await guild.roles.fetch();
    await guild.members.fetchMe({ force: true });
    const channels = await guild.channels.fetch();
    for (const id of contract.discordChannels) {
      const channel = channels.get(id) ?? await client.channels.fetch(id).catch(() => null);
      if (!channel || !client.user || !('permissionsFor' in channel)) continue;
      // Only the core contract can nominate the ordinary community audience.
      // Never infer public approval from an arbitrary role that happens to read.
      const audienceIds = contract.discordPublicAudienceRoleIds ?? [guild.id];
      const audienceReadable = audienceIds.length > 0 && audienceIds.every(roleId => {
        const role = guild.roles.cache.get(roleId);
        return role && !role.permissions.has(PermissionFlagsBits.Administrator) &&
          channel.permissionsFor(role)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
      });
      const bot = channel.permissionsFor(client.user);
      if (bot?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        readable.set(id, audienceReadable ? 'public' : 'restricted');
      }
    }
  } catch {
    // Failure shrinks to independently approved X archive only. Never renew
    // a Discord lease based on cached permissions after a failed check.
  }
  const { error } = await getDb().rpc('memory_publish_policy_v1', { p_policy: deriveMemoryPolicy(contract, readable) });
  if (error) throw Error(`Memory policy refresh failed: ${error.code}`);
}

// Coalesce bursts, serialize publications, and recheck if permissions changed
// during an in-flight fetch. An older request must not finish after a newer one.
export function createPolicyRefresher(refresh: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let dirty = false;
  return () => {
    dirty = true;
    if (running) return running;
    running = (async () => {
      try { while (dirty) { dirty = false; await refresh(); } }
      finally { running = null; }
    })();
    return running;
  };
}
