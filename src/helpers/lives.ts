import { query } from '../db';
import { LiveRow } from '../types';

// Who should see a live broadcast posted by `userId`:
// the broadcaster themselves (their other devices) + everyone they share a conversation with.
export async function liveRecipients(userId: string): Promise<string[]> {
  const { rows } = await query<{ user_id: string }>(
    `SELECT DISTINCT cp_other.user_id
       FROM conversation_participants cp_me
       JOIN conversation_participants cp_other
         ON cp_other.conversation_id = cp_me.conversation_id
      WHERE cp_me.user_id = $1`,
    [userId],
  );
  return [userId, ...rows.map((r) => r.user_id)];
}

export interface LivePayload {
  id: string;
  host_id: string;
  title: string;
  started_at: string;
  host: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
  viewer_count: number;
  likes: number;
}

export async function serializeLive(
  live: LiveRow,
  viewerCount: number,
  likes = 0,
): Promise<LivePayload> {
  const { rows } = await query<{
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  }>('SELECT id, username, display_name, avatar_url FROM users WHERE id = $1', [live.host_id]);
  const host = rows[0];
  return {
    id: live.id,
    host_id: live.host_id,
    title: live.title,
    started_at: live.started_at.toISOString(),
    host: {
      id: host?.id ?? live.host_id,
      username: host?.username ?? 'unknown',
      display_name: host?.display_name ?? 'Unknown',
      avatar_url: host?.avatar_url ?? null,
    },
    viewer_count: viewerCount,
    likes,
  };
}