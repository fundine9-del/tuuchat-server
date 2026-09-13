import { Router } from 'express';
import pool, { query } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { ConversationRow, ParticipantRow, UserRow } from '../types';
import { asyncHandler, HttpError, trimString } from '../utils';
import {
  getParticipantById,
  getParticipantRole,
  isParticipant,
  requireParticipant,
} from '../helpers/conversations';
import { emitConversationUpdate, emitConversationUpdateToRoom, emitTyping, joinUsersToConversation } from '../socket';

const router = Router();
router.use(requireAuth);

interface ConversationListItem extends ConversationRow {
  participant_count: number;
  last_message_id: string | null;
  last_message_content: string | null;
  last_message_type: string | null;
  last_message_sender_id: string | null;
  last_message_sender_name: string | null;
  last_message_at: string | null;
}

// GET /api/conversations  -> all conversations of the current user
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;

    const { rows } = await query<ConversationListItem>(
      `SELECT c.*,
              lm.last_message_id,
              lm.last_message_content,
              lm.last_message_type,
              lm.last_message_sender_id,
              lm.last_message_sender_name,
              lm.last_message_at::text,
              (SELECT count(*)::int FROM conversation_participants cp
                WHERE cp.conversation_id = c.id) AS participant_count
         FROM conversations c
         JOIN conversation_participants cp_me ON cp_me.conversation_id = c.id AND cp_me.user_id = $1
         LEFT JOIN LATERAL (
            SELECT m.id AS last_message_id, m.content AS last_message_content,
                   m.message_type AS last_message_type, m.sender_id AS last_message_sender_id,
                   m.created_at AS last_message_at,
                   u.display_name AS last_message_sender_name
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = c.id
            ORDER BY m.created_at DESC
            LIMIT 1
         ) lm ON true
        ORDER BY COALESCE(lm.last_message_at, c.created_at) DESC`,
      [userId],
    );

    if (rows.length === 0) return res.json({ conversations: [] });

    const ids = rows.map((r) => r.id);
    const members = await query<ParticipantRow & { display_name: string; avatar_url: string | null; status: string }>(
      `SELECT cp.*, u.display_name, u.avatar_url, u.status
         FROM conversation_participants cp
         JOIN users u ON u.id = cp.user_id
        WHERE cp.conversation_id = ANY($1::uuid[])`,
      [ids],
    );

    // build a preview name/avatar for direct chats = the other participant
    const conversations = rows.map((c) => {
      const people = members.rows.filter((m) => m.conversation_id === c.id);
      const peer = c.type === 'direct' ? people.find((p) => p.user_id !== userId) : null;
      return {
        ...c,
        name: c.name ?? peer?.display_name ?? 'Direct chat',
        avatar_url: c.avatar_url ?? (peer ? peer.avatar_url : null),
        participants: people.map((p) => ({
          id: p.user_id,
          display_name: p.display_name,
          avatar_url: p.avatar_url,
          role: p.role,
          status: p.status,
          online: p.status === 'online',
        })),
        last_message: c.last_message_id
          ? {
              id: c.last_message_id,
              sender_id: c.last_message_sender_id,
              message_type: c.last_message_type,
              content: c.last_message_content,
              created_at: c.last_message_at,
              sender_name: c.last_message_sender_name,
            }
          : null,
      };
    });

    res.json({ conversations });
  }),
);

// POST /api/conversations  -> create direct chat or group
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const { type = 'direct', user_ids = [], name } = req.body as {
      type?: 'direct' | 'group';
      user_ids?: string[];
      name?: string;
    };
    const user = (req as AuthenticatedRequest).user;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let conversation: ConversationRow;
      let participantIds: string[] = [];

      if (type === 'direct') {
        const peerId = String(user_ids?.[0] ?? '');
        if (!peerId) throw new HttpError(400, 'user_ids[0] is required for a direct chat');
        if (peerId === userId) throw new HttpError(400, 'Cannot chat with yourself');

        // reuse an existing direct conversation if present
        const existing = await client.query(
          `SELECT cp.conversation_id
             FROM conversation_participants cp
             JOIN conversation_participants cp2 ON cp2.conversation_id = cp.conversation_id
             JOIN conversations c ON c.id = cp.conversation_id
            WHERE c.type = 'direct' AND cp.user_id = $1 AND cp2.user_id = $2
            LIMIT 1`,
          [userId, peerId],
        );
        if (existing.rows.length > 0) {
          const { rows } = await client.query<ConversationRow>(
            'SELECT * FROM conversations WHERE id = $1',
            [existing.rows[0].conversation_id],
          );
          await client.query('COMMIT');
          return res.json({ conversation: rows[0], duplicate: true });
        }

        const { rows } = await client.query<ConversationRow>(
          `INSERT INTO conversations (type, created_by) VALUES ('direct', $1) RETURNING *`,
          [userId],
        );
        conversation = rows[0];
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
          [conversation.id, userId, peerId],
        );
        participantIds = [userId, peerId];
      } else {
        const cleanIds = Array.from(new Set(user_ids.filter((id): id is string => Boolean(id))));
        if (!name || !trimString(name, 100)) throw new HttpError(400, 'Group name is required');

        const { rows } = await client.query<ConversationRow>(
          `INSERT INTO conversations (type, name, created_by) VALUES ('group', $1, $2) RETURNING *`,
          [trimString(name, 100), userId],
        );
        conversation = rows[0];

        const allIds = Array.from(new Set([userId, ...cleanIds]));
        for (const id of allIds) {
          await client.query(
            `INSERT INTO conversation_participants (conversation_id, user_id, role)
             VALUES ($1, $2, 'member')`,
            [conversation.id, id],
          );
        }
        await client.query(
          `UPDATE conversation_participants SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2`,
          [conversation.id, userId],
        );
        participantIds = allIds;
      }

      await client.query('COMMIT');
      joinUsersToConversation(conversation.id, participantIds);
      emitConversationUpdate(conversation.id, participantIds);
      res.status(201).json({ conversation });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// GET /api/conversations/:id -> details + full participant list with presence
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const conversation = await requireParticipant(String(req.params.id), userId);
    const participants = (await getParticipantRole(conversation.id)).map((p) => ({
      ...p,
      display_name: p.display_name,
    }));

    const userIds = participants.map((p) => p.user_id);
    const users = userIds.length
      ? await query<UserRow>(`SELECT * FROM users WHERE id = ANY($1::uuid[])`, [userIds])
      : null;

    res.json({
      conversation,
      participants: participants.map((p) => {
        const u = users?.rows.find((x) => x.id === p.user_id);
        return {
          id: p.user_id,
          display_name: p.display_name,
          avatar_url: u?.avatar_url ?? null,
          role: p.role,
          status: u?.status ?? 'offline',
          online: u?.status === 'online',
        };
      }),
    });
  }),
);

// PATCH /api/conversations/:id -> update group name / avatar
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const conversation = await requireParticipant(String(req.params.id), userId);
    if (conversation.type !== 'group') throw new HttpError(400, 'Only group chats can be edited');
    const me = await getParticipantById(conversation.id, userId);
    if (!me || me.role !== 'admin') throw new HttpError(403, 'Only admins can edit the group');

    const name = req.body?.name !== undefined ? trimString(req.body.name, 100) : conversation.name;
    const avatar_url =
      req.body?.avatar_url !== undefined ? trimString(req.body.avatar_url, 500) : conversation.avatar_url;

    const { rows } = await query<ConversationRow>(
      `UPDATE conversations SET name = $1, avatar_url = $2 WHERE id = $3 RETURNING *`,
      [name, avatar_url, conversation.id],
    );
    emitConversationUpdateToRoom(conversation.id);
    res.json({ conversation: rows[0] });
  }),
);

// POST /api/conversations/:id/participants -> add members (group)
router.post(
  '/:id/participants',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const conversation = await requireParticipant(String(req.params.id), userId);
    if (conversation.type !== 'group') throw new HttpError(400, 'Only group chats can have members added');
    const me = await getParticipantById(conversation.id, userId);
    if (!me || me.role !== 'admin') throw new HttpError(403, 'Only admins can add members');

    const { user_ids = [] } = req.body as { user_ids?: string[] };
    const ok: string[] = [];
    for (const id of user_ids) {
      if (!id) continue;
      if (await isParticipant(conversation.id, id)) continue;
      await query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)`,
        [conversation.id, id],
      );
      ok.push(id);
    }
    if (ok.length > 0) {
      joinUsersToConversation(conversation.id, ok);
      const members = await getParticipantRole(conversation.id);
      emitConversationUpdate(conversation.id, members.map((m) => m.user_id));
    }
    res.status(201).json({ added: ok });
  }),
);

// DELETE /api/conversations/:id/participants/:userId -> leave, or remove (admin)
router.delete(
  '/:id/participants/:participantId',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const conversation = await requireParticipant(String(req.params.id), userId);
    const target = String(req.params.participantId);

    const me = await getParticipantById(conversation.id, userId);
    const them = await getParticipantById(conversation.id, target);

    const isSelfLeave = target === userId;
    const isAdmin = me?.role === 'admin';

    if (!isSelfLeave && !isAdmin)
      throw new HttpError(403, 'Only admins can remove other members');
    if (!them) throw new HttpError(404, 'Participant not found');

    await query(
      `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, target],
    );
    const remaining = await getParticipantRole(conversation.id);
    emitConversationUpdate(conversation.id, [...remaining.map((m) => m.user_id), target]);
    res.json({ removed: target });
  }),
);

// POST /api/conversations/:id/typing -> REST fallback to broadcast typing state
router.post(
  '/:id/typing',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    await requireParticipant(String(req.params.id), userId);
    emitTyping(String(req.params.id), userId, Boolean(req.body?.is_typing));
    res.json({ ok: true });
  }),
);

export default router;