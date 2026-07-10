import 'dotenv/config';
import { Client, GatewayIntentBits, Message } from 'discord.js';
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
});

// --- Message handler ---

async function handleMessage(message: Message): Promise<void> {
  // Keep third-party bot noise out of the archive, but retain AI Nikechan's
  // own replies so Discord history search has both sides of the conversation.
  if (message.author.bot && !ARCHIVED_BOT_IDS.has(message.author.id)) return;

  const channelId = message.channel.id;
  const channelName = 'name' in message.channel ? (message.channel.name ?? null) : null;
  const guildId = message.guildId;

  try {
    // 1. Save channel
    if (guildId && channelName) {
      await saveChannel(channelId, guildId, channelName);
    }

    // 2. Save user
    const userId = await saveUser(
      message.author.id,
      message.author.displayName,
      message.author.username,
      message.member?.nickname ?? null
    );

    // 3. Upload attachments to R2
    const attachments: Attachment[] = [];
    for (const [, att] of message.attachments) {
      try {
        const r2Url = await uploadAttachment(
          att.url,
          channelId,
          message.id,
          att.name ?? 'unknown'
        );
        const type = getAttachmentType(att.contentType ?? '', att.name ?? '');
        attachments.push({ type, url: r2Url, filename: att.name ?? 'unknown' });
      } catch (err) {
        console.error(`[R2] Failed to upload ${att.name}:`, err);
        // Fallback: save Discord CDN URL
        const type = getAttachmentType(att.contentType ?? '', att.name ?? '');
        attachments.push({ type, url: att.url, filename: att.name ?? 'unknown' });
      }
    }

    // 4. Save message to DB
    await saveMessage({
      messageId: message.id,
      channelId,
      userId,
      replyToMessageId: message.reference?.messageId ?? null,
      content: message.content || null,
      attachments,
      messageAt: message.createdAt,
    });
  } catch (err) {
    console.error(`[ERROR] Failed to process message ${message.id}:`, err);
  }
}

// --- Event listeners ---

client.once('ready', (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Watching ${c.guilds.cache.size} guild(s)`);
});

client.on('messageCreate', handleMessage);

// --- Graceful shutdown ---

function shutdown(): void {
  console.log('Shutting down...');
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---

client.login(DISCORD_BOT_TOKEN);
