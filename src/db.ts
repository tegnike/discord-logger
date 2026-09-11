import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient;

export function initDb(url: string, serviceRoleKey: string): SupabaseClient {
  supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabase;
}

export function getDb(): SupabaseClient {
  if (!supabase) throw new Error('Database not initialized. Call initDb() first.');
  return supabase;
}

// --- User ---

interface RpcUserResponse {
  id: string;
  name: string;
  platform: string;
  platform_user_id: string;
  username: string | null;
  display_name: string | null;
  guild_nickname: string | null;
  created_at: string;
  updated_at: string;
}

export async function saveUser(
  platformUserId: string,
  displayName: string,
  username: string | null,
  guildNickname: string | null
): Promise<string> {
  const { data, error } = await getDb().rpc('get_or_create_user_with_platform', {
    p_platform: 'discord',
    p_platform_user_id: platformUserId,
    p_display_name: displayName,
    p_username: username,
    p_guild_nickname: guildNickname,
  });

  if (error) throw new Error(`saveUser failed: ${error.message}`);
  if (!data) throw new Error('saveUser: RPC returned null');

  return (data as RpcUserResponse).id;
}

// --- Channel ---

export async function saveChannel(
  channelId: string,
  guildId: string,
  name: string
): Promise<void> {
  const { error } = await getDb()
    .from('discord_channels')
    .upsert(
      { channel_id: channelId, guild_id: guildId, name },
      { onConflict: 'channel_id' }
    );

  if (error) {
    throw new Error(`saveChannel failed: ${error.message}`);
  }
}

// --- Message ---

export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
  filename: string;
}

export interface SaveMessageInput {
  messageId: string;
  channelId: string;
  userId: string;
  replyToMessageId: string | null;
  content: string | null;
  attachments: Attachment[];
  messageAt: Date;
  nativeAuthorId: string;
  editedAt: Date | null;
}

export async function saveMessage(input: SaveMessageInput): Promise<void> {
  const row = {
    message_id: input.messageId, channel_id: input.channelId, user_id: input.userId,
    reply_to_message_id: input.replyToMessageId, content: input.content,
    attachments: input.attachments, message_at: input.messageAt.toISOString(),
  };
  // Enabled only after the RPC migration passes deployment acceptance.
  const result = process.env.DISCORD_CHARACTER_MEMORY_INGEST === 'true'
    ? await getDb().rpc('memory_ingest_discord_message_v1', {
      p_message: row, p_native_author: input.nativeAuthorId,
      p_edited_at: input.editedAt?.toISOString() ?? null,
    })
    : await getDb().from('discord_messages').upsert(row, { onConflict: 'message_id' });
  if (result.error) throw new Error(`saveMessage failed: ${result.error.code}`);
}

export function replaceAttachmentUrl(
  attachments: Attachment[], filename: string, sourceUrl: string, archivedUrl: string
): { attachments: Attachment[]; changed: boolean } {
  let changed = false;
  const next = attachments.map((attachment) => {
    if (attachment.filename !== filename || attachment.url !== sourceUrl) return attachment;
    changed = true;
    return { ...attachment, url: archivedUrl };
  });
  return { attachments: next, changed };
}

export async function saveRetriedAttachment(input: {
  messageId: string; filename: string; sourceUrl: string; archivedUrl: string;
}): Promise<void> {
  const { data, error } = await getDb().from('discord_messages')
    .select('attachments').eq('message_id', input.messageId).maybeSingle();
  if (error) throw new Error(`loadMessageAttachments failed: ${error.code}`);
  // The retry can race the initial message write. Retain the durable job until
  // a later drain can observe the saved message.
  if (!data) throw new Error('loadMessageAttachments failed: message_not_found');
  const current = Array.isArray(data.attachments) ? data.attachments as Attachment[] : [];
  const replacement = replaceAttachmentUrl(current, input.filename, input.sourceUrl, input.archivedUrl);
  if (!replacement.changed) return;
  const result = process.env.DISCORD_CHARACTER_MEMORY_INGEST === 'true'
    ? await getDb().rpc('memory_update_discord_attachments_v1', {
      p_message_id: input.messageId, p_attachments: replacement.attachments,
    })
    : await getDb().from('discord_messages').update({ attachments: replacement.attachments }).eq('message_id', input.messageId);
  if (result.error) throw new Error(`saveRetriedAttachment failed: ${result.error.code}`);
}
