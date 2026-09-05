import 'dotenv/config';
import path from 'node:path';
import { ArchiveOutbox } from './archive-outbox.js';
import { refreshMemoryPolicy } from './memory-policy.js';
import { Client, GatewayIntentBits, Message, Partials } from 'discord.js';
import { initDb, saveUser, saveChannel, saveMessage, type Attachment } from './db.js';
import { initR2, uploadAttachment, getAttachmentType } from './r2.js';

// --- Environment validation ---

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const DISCORD_BOT_TOKEN = requireEnv('DISCORD_BOT_TOKEN');
const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const R2_ACCOUNT_ID = requireEnv('R2_ACCOUNT_ID');
const R2_ACCESS_KEY_ID = requireEnv('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = requireEnv('R2_SECRET_ACCESS_KEY');
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? 'discord-archive';
const R2_PUBLIC_URL = requireEnv('R2_PUBLIC_URL');
const ARCHIVED_BOT_IDS = new Set(
  (process.env.DISCORD_ARCHIVED_BOT_IDS ?? '1454145423315828736')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

// --- Init ---

initDb(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
initR2({
  accountId: R2_ACCOUNT_ID,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  bucketName: R2_BUCKET_NAME,
  publicUrl: R2_PUBLIC_URL,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// --- Message handler ---

interface ArchivedMessage {
  messageId: string; channelId: string; channelName: string | null; guildId: string | null;
  nativeAuthorId: string; displayName: string; username: string; guildNickname: string | null;
  replyToMessageId: string | null; content: string | null; messageAt: string; editedAt: string | null;
  attachments: Array<{ url: string; name: string; contentType: string }>;
}
async function persistArchived(message: ArchivedMessage): Promise<void> {
  if (message.guildId && message.channelName) await saveChannel(message.channelId, message.guildId, message.channelName);
  const userId = await saveUser(message.nativeAuthorId, message.displayName, message.username, message.guildNickname);
  const attachments: Attachment[] = [];
  for (const att of message.attachments) {
    let url = att.url;
    try { url = await uploadAttachment(att.url, message.channelId, message.messageId, att.name); }
    catch { console.error('[R2] Attachment upload failed; retaining CDN reference'); }
    attachments.push({ type: getAttachmentType(att.contentType, att.name), url, filename: att.name });
  }
  await saveMessage({ ...message, userId, attachments,
    messageAt: new Date(message.messageAt), editedAt: message.editedAt ? new Date(message.editedAt) : null });
}
const outbox = new ArchiveOutbox<ArchivedMessage>(path.resolve(process.env.DISCORD_ARCHIVE_OUTBOX_DIR ?? '.state/archive-outbox'), persistArchived);
async function drainArchive(): Promise<void> {
  try { await outbox.drain(); }
  catch { console.error('[ARCHIVE] Save failed; durable batch retained for retry'); }
}
async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot && !ARCHIVED_BOT_IDS.has(message.author.id)) return;
  try {
    await outbox.enqueue({ messageId: message.id, channelId: message.channelId,
      channelName: 'name' in message.channel ? message.channel.name : null, guildId: message.guildId,
      nativeAuthorId: message.author.id, displayName: message.author.displayName, username: message.author.username,
      guildNickname: message.member?.nickname ?? null, replyToMessageId: message.reference?.messageId ?? null,
      content: message.content || null, messageAt: message.createdAt.toISOString(), editedAt: message.editedAt?.toISOString() ?? null,
      attachments: [...message.attachments.values()].map(a => ({ url: a.url, name: a.name ?? 'unknown', contentType: a.contentType ?? '' })),
    });
    await drainArchive();
  } catch { console.error(`[ARCHIVE] Could not durably queue message ${message.id}`); }
}
const retryTimer = setInterval(() => { void drainArchive(); }, 30_000);
void drainArchive();

// --- Event listeners ---

let policyTimer: ReturnType<typeof setInterval> | null = null;
client.once('ready', (c) => {
  const contractPath = process.env.DISCORD_CHARACTER_MEMORY_POLICY_FILE;
  if (contractPath) {
    const refresh = async () => {
      try { await refreshMemoryPolicy(client, contractPath); }
      catch { console.error('[MEMORY] Policy refresh failed; existing leases will expire'); }
    };
    void refresh(); policyTimer = setInterval(() => { void refresh(); }, 5 * 60_000);
  }
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Watching ${c.guilds.cache.size} guild(s)`);
});

client.on('messageCreate', handleMessage);

// Discord Bot replies are initially sent as a short progress message and then
// edited into the final response. Re-run the idempotent upsert on edits so the
// archive stores the final visible text instead of the pre-edit placeholder.
client.on('messageUpdate', async (_oldMessage, newMessage) => {
  try {
    const resolved = newMessage.partial ? await newMessage.fetch() : newMessage;
    await handleMessage(resolved);
  } catch (err) {
    console.error(`[ERROR] Failed to process updated message ${newMessage.id}:`, err);
  }
});

// --- Graceful shutdown ---

function shutdown(): void {
  console.log('Shutting down...');
  clearInterval(retryTimer);
  if (policyTimer) clearInterval(policyTimer);
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---

client.login(DISCORD_BOT_TOKEN);
