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
    if (error.code === '23505') return;
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
}

export async function saveMessage(input: SaveMessageInput): Promise<void> {
  const { error } = await getDb()
    .from('discord_messages')
    .upsert(
      {
        message_id: input.messageId,
        channel_id: input.channelId,
        user_id: input.userId,
        reply_to_message_id: input.replyToMessageId,
        content: input.content,
        attachments: input.attachments,
        message_at: input.messageAt.toISOString(),
      },
      { onConflict: 'message_id' }
    );

  if (error) {
    // UNIQUE制約違反は無視（重複メッセージ）
    if (error.code === '23505') return;
    throw new Error(`saveMessage failed: ${error.message}`);
  }
}
