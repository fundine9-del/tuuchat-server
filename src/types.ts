export type UserStatus = 'online' | 'offline' | 'away' | 'busy';
export type ConversationType = 'direct' | 'group';
export type MessageType = 'text' | 'image' | 'file';
export type ParticipantRole = 'member' | 'admin';

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  status: UserStatus;
  last_seen: Date;
  created_at: Date;
}

export interface SafeUser {
  id: string;
  username: string;
  email: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  status: UserStatus;
  last_seen: string;
  online: boolean;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  type: ConversationType;
  name: string | null;
  avatar_url: string | null;
  created_by: string | null;
  created_at: Date;
}

export interface ParticipantRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: ParticipantRole;
  joined_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  message_type: MessageType;
  content: string;
  reply_to_id: string | null;
  created_at: Date;
  edited_at: Date | null;
}

export interface StatusRow {
  id: string;
  user_id: string;
  content: string;
  created_at: Date;
  expires_at: Date;
}

export interface JwtPayload {
  sub: string;
  username: string;
}