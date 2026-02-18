-- Migration: Create tables for Discord message logger
-- Tables: users, platform_accounts, discord_channels, discord_messages
-- RPC: get_or_create_user_with_platform

-- =============================================================================
-- users: ユーザーマスタ
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,              -- 正式名称（初期値=Discord display_name、AIが後で更新可）
  nickname VARCHAR(100),                    -- ニックネーム（初期は空、AIが判断して追加）
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- platform_accounts: プラットフォームアカウント紐付け
-- =============================================================================
CREATE TABLE IF NOT EXISTS platform_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL,
  platform_user_id VARCHAR(100) NOT NULL,
  username VARCHAR(100),                    -- Discord username (例: tanaka_taro)
  display_name VARCHAR(100),                -- Discord global display name (例: 田中太郎)
  guild_nickname VARCHAR(100),              -- サーバーごとのニックネーム
  UNIQUE(platform, platform_user_id)
);

-- =============================================================================
-- discord_channels: Discordチャンネル情報
-- =============================================================================
CREATE TABLE IF NOT EXISTS discord_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR(100) NOT NULL UNIQUE,
  guild_id VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL
);

-- =============================================================================
-- discord_messages: Discordメッセージ保存
-- =============================================================================
CREATE TABLE IF NOT EXISTS discord_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id VARCHAR(100) NOT NULL UNIQUE,    -- Discord message ID
  channel_id VARCHAR(100) NOT NULL,            -- discord_channels.channel_id と一致
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reply_to_message_id VARCHAR(100),
  content TEXT,
  attachments JSONB DEFAULT '[]'::jsonb,
  message_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_messages_channel_at ON discord_messages(channel_id, message_at);

-- =============================================================================
-- get_or_create_user_with_platform RPC
-- Atomically create or get user with platform account
-- =============================================================================
CREATE OR REPLACE FUNCTION get_or_create_user_with_platform(
  p_platform VARCHAR(20),
  p_platform_user_id VARCHAR(100),
  p_display_name VARCHAR(100),
  p_username VARCHAR(100) DEFAULT NULL,
  p_guild_nickname VARCHAR(100) DEFAULT NULL
) RETURNS JSON AS $$
DECLARE
  v_user_id UUID;
  v_result JSON;
BEGIN
  -- Check if user already exists with this platform account
  SELECT u.id INTO v_user_id
  FROM users u
  JOIN platform_accounts pa ON u.id = pa.user_id
  WHERE pa.platform = p_platform AND pa.platform_user_id = p_platform_user_id;

  IF v_user_id IS NULL THEN
    -- Create new user (name = display_name as initial value)
    INSERT INTO users (name) VALUES (p_display_name)
    RETURNING id INTO v_user_id;

    -- Create platform account
    INSERT INTO platform_accounts (user_id, platform, platform_user_id, username, display_name, guild_nickname)
    VALUES (v_user_id, p_platform, p_platform_user_id, p_username, p_display_name, p_guild_nickname);
  ELSE
    -- Update platform account with latest info
    UPDATE platform_accounts
    SET username = COALESCE(p_username, username),
        display_name = COALESCE(p_display_name, display_name),
        guild_nickname = COALESCE(p_guild_nickname, guild_nickname)
    WHERE platform = p_platform AND platform_user_id = p_platform_user_id;
  END IF;

  -- Return complete user with platform account info
  SELECT json_build_object(
    'id', u.id,
    'name', u.name,
    'platform', pa.platform,
    'platform_user_id', pa.platform_user_id,
    'username', pa.username,
    'display_name', pa.display_name,
    'guild_nickname', pa.guild_nickname,
    'created_at', u.created_at,
    'updated_at', u.updated_at
  ) INTO v_result
  FROM users u
  JOIN platform_accounts pa ON u.id = pa.user_id
  WHERE u.id = v_user_id AND pa.platform = p_platform;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;
