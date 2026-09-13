import { query } from '../db';
import { ConversationRow, ParticipantRow } from '../types';
import { HttpError } from '../utils';

export async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return rows.length > 0;
}

export async function requireParticipant(
  conversationId: string,
  userId: string,
): Promise<ConversationRow> {
  const { rows } = await query<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [
    conversationId,
  ]);
  if (rows.length === 0) throw new HttpError(404, 'Conversation not found');
  if (!(await isParticipant(conversationId, userId)))
    throw new HttpError(403, 'You are not a participant of this conversation');
  return rows[0];
}

export async function getParticipantRole(
  conversationId: string,
): Promise<(ParticipantRow & { display_name?: string })[]> {
  const { rows } = await query<ParticipantRow & { display_name?: string }>(
    `SELECT cp.*, u.display_name
       FROM conversation_participants cp
       JOIN users u ON u.id = cp.user_id
      WHERE cp.conversation_id = $1
      ORDER BY cp.joined_at`,
    [conversationId],
  );
  return rows;
}

export async function getParticipantById(
  conversationId: string,
  userId: string,
): Promise<ParticipantRow | null> {
  const { rows } = await query<ParticipantRow>(
    `SELECT * FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return rows[0] ?? null;
}