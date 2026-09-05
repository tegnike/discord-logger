import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PermissionFlagsBits, type Client } from 'discord.js';
import { getDb } from './db.js';

type Contract = {
  version: number; guildId: string; discordChannels: string[]; twitterArchiveApproved: boolean;
  allowLegacyDiscordAuthor: boolean; runtimeModes: Record<string, 'shadow' | 'live'>;
  routes: Record<string, Record<string, string[]>>;
};
export function deriveMemoryPolicy(contract: Contract, readable: Set<string>, now = Date.now()) {
  if (contract.version !== 1 || !Array.isArray(contract.discordChannels)) throw Error('Invalid memory contract');
  const expires_at = new Date(now + 9 * 60_000).toISOString();
  const scopes: Record<string, unknown> = {};
  for (const channel of contract.discordChannels) if (readable.has(channel)) scopes[`discord:channel:${channel}`] = {
    audience: 'public', expires_at, allow_legacy_author: contract.allowLegacyDiscordAuthor === true,
  };
  if (contract.twitterArchiveApproved === true) scopes['twitter:public'] = { audience: 'public', expires_at, allow_legacy_author: false };
  const runtimes: Record<string, unknown> = {};
  for (const [runtime, routes] of Object.entries(contract.routes)) {
    const mode = contract.runtimeModes[runtime];
    if (!['shadow', 'live'].includes(mode)) throw Error('Invalid memory mode');
    const destinations: Record<string, string[]> = {};
    for (const [destination, sources] of Object.entries(routes)) {
      if (!scopes[destination]) continue;
      if (!Array.isArray(sources)) throw Error('Invalid memory route');
      destinations[destination] = sources.filter(source => Boolean(scopes[source]));
    }
    runtimes[runtime] = { mode, destinations };
  }
  return { core_config_hash: createHash('sha256').update(JSON.stringify(contract)).digest('hex'), scopes, runtimes };
}
export async function refreshMemoryPolicy(client: Client, contractPath: string): Promise<void> {
  const contract = JSON.parse(await readFile(contractPath, 'utf8')) as Contract;
  const readable = new Set<string>();
  try {
    const guild = await client.guilds.fetch(contract.guildId);
    await guild.roles.fetch();
    await guild.members.fetchMe({ force: true });
    const channels = await guild.channels.fetch();
    for (const id of contract.discordChannels) {
      const channel = channels.get(id);
      if (!channel || !client.user || !('permissionsFor' in channel)) continue;
      const audience = channel.permissionsFor(guild.roles.everyone);
      const bot = channel.permissionsFor(client.user);
      if (audience?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) && bot?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) readable.add(id);
    }
  } catch {
    // Failure shrinks to independently approved X archive only. Never renew
    // a Discord lease based on cached permissions after a failed check.
  }
  const { error } = await getDb().rpc('memory_publish_policy_v1', { p_policy: deriveMemoryPolicy(contract, readable) });
  if (error) throw Error(`Memory policy refresh failed: ${error.code}`);
}
