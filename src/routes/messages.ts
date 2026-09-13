import { Router } from 'express';
import { query } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { MessageRow } from '../types';
import { asyncHandler, HttpError, validMessageType } from '../utils';
import { requireParticipant } from '../helpers/conversations';
import { emitConversationUpdateToRoom, emitMessageDeleted, emitMessageUpdated, emitNewMessage } from '../socket';

const router = Router();
router.use(requireAuth);

interface MessageWithSender extends MessageRow {
  sender_name: string;
  sender_avatar: string | null;
}

// GET /api/conversations/:id/messages?limit=50&before=<uuid|iso>
router.get(
  '/conversations/:id/messages',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const conversation = await requireParticipant(String(req.params.id), userId);

    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 200);
    let before = req.query.before ? String(req.query.before) : null;

    // `before` may be a message id (uuid) or an ISO timestamp -> resolve to a timestamp
    if (before && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(before)) {
      const { rows: beforeRow } = await query<{ created_at: string }>(
        'SELECT created_at FROM messages WHERE id = $1',
        [before],
      );
      before = beforeRow.length ? beforeRow[0].created_at : before;
    }

    // fetch one extra row to know whether there are more older messages
    const { rows } = await query<MessageWithSender>(
      `SELECT m.*,
              u.display_name AS sender_name,
              u.avatar_url   AS sender_avatar
         FROM messages m
         JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
        AND ($2::text IS NULL OR m.created_at < $2::timestamptz)
        ORDER BY m.created_at DESC
        LIMIT $3::int`,
      [conversation.id, before, limit + 1],
    );

    const hasMore = rows.length > limit;
    const messages = (hasMore ? rows.slice(0, limit) : rows).reverse();
    res.json({ messages, has_more: hasMore });
  }),
);

// POST /api/conversations/:id/messages { content, message_type?, reply_to_id? }
router.post(
  '/conversations/:id/messages',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const conversation = await requireParticipant(String(req.params.id), userId);

    const content = String(req.body?.content ?? '').trim();
    if (!content) throw new HttpError(400, 'Message content is required');
    if (content.length > 4000) throw new HttpError(400, 'Message too long (max 4000 chars)');

    const messageType = validMessageType(req.body?.message_type) ? req.body.message_type : 'text';
    const replyToId = String(req.body?.reply_to_id ?? '') || null;

    if (replyToId) {
      const reply = await query('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [
        replyToId,
        conversation.id,
      ]);
      if (reply.rows.length === 0) throw new HttpError(400, 'reply_to_id does not belong to this conversation');
    }

    const { rows } = await query<MessageWithSender>(
      `INSERT INTO messages (conversation_id, sender_id, message_type, content, reply_to_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [conversation.id, userId, messageType, content, replyToId],
    );

    const message = rows[0];
    const { rows: sender } = await query<{ display_name: string; avatar_url: string | null }>(
      'SELECT display_name, avatar_url FROM users WHERE id = $1',
      [userId],
    );
    message.sender_name = sender[0].display_name;
    message.sender_avatar = sender[0].avatar_url;

    emitNewMessage(message);
    emitConversationUpdateToRoom(conversation.id);
    res.status(201).json({ message });
  }),
);

// PATCH /api/messages/:id -> edit your own message
router.patch(
  '/messages/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const { rows } = await query<MessageRow & { caller_role?: string }>(
      `SELECT m.*, cp.role AS caller_role
         FROM messages m
         LEFT JOIN conversation_participants cp
           ON cp.conversation_id = m.conversation_id AND cp.user_id = $2
        WHERE m.id = $1`,
      [String(req.params.id), userId],
    );

    const message = rows[0];
    if (!message) throw new HttpError(404, 'Message not found');
    if (message.sender_id !== userId) throw new HttpError(403, 'You can only edit your own messages');

    const content = String(req.body?.content ?? '').trim();
    if (!content) throw new HttpError(400, 'Message content is required');
    if (content.length > 4000) throw new HttpError(400, 'Message too long (max 4000 chars)');

    const { rows: updated } = await query<MessageWithSender>(
      `UPDATE messages SET content = $1, edited_at = now() WHERE id = $2 RETURNING *`,
      [content, message.id],
    );
    const edited = updated[0];
    const { rows: sender } = await query<{ display_name: string; avatar_url: string | null }>(
      'SELECT display_name, avatar_url FROM users WHERE id = $1',
      [userId],
    );
    edited.sender_name = sender[0].display_name;
    edited.sender_avatar = sender[0].avatar_url;

    emitMessageUpdated(edited);
    emitConversationUpdateToRoom(edited.conversation_id);
    res.json({ message: edited });
  }),
);

// DELETE /api/messages/:id -> own message, or any message if admin of the group
router.delete(
  '/messages/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const { rows } = await query<MessageRow & { caller_role?: string }>(
      `SELECT m.*, cp.role AS caller_role
         FROM messages m
         LEFT JOIN conversation_participants cp
           ON cp.conversation_id = m.conversation_id AND cp.user_id = $2
        WHERE m.id = $1`,
      [String(req.params.id), userId],
    );

    const message = rows[0];
    if (!message) throw new HttpError(404, 'Message not found');
    if (message.sender_id !== userId && message.caller_role !== 'admin')
      throw new HttpError(403, 'You can only delete your own messages');

    await query('DELETE FROM messages WHERE id = $1', [message.id]);
    emitMessageDeleted(message.conversation_id, message.id);
    emitConversationUpdateToRoom(message.conversation_id);
    res.json({ deleted: message.id });
  }),
);

export default router;