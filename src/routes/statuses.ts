import { Router } from 'express';
import { query } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { StatusRow } from '../types';
import { asyncHandler, HttpError, trimString } from '../utils';
import { emitToUsers } from '../socket';

const router = Router();
router.use(requireAuth);

interface StatusWithUser extends StatusRow {
  username: string;
  display_name: string;
  avatar_url: string | null;
  presence_status: string;
}

// The people who should see a status posted by `userId`:
// the author themselves (their other devices) + everyone they share a conversation with.
async function statusRecipients(userId: string): Promise<string[]> {
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

// GET /api/statuses -> own statuses + statuses posted by co-conversants (not expired)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;

    const { rows } = await query<StatusWithUser>(
      `SELECT s.*, u.username, u.display_name, u.avatar_url, u.status AS presence_status
         FROM statuses s
         JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > now()
          AND (
                s.user_id = $1
             OR s.user_id IN (
                  SELECT DISTINCT cp_other.user_id
                    FROM conversation_participants cp_me
                    JOIN conversation_participants cp_other
                      ON cp_other.conversation_id = cp_me.conversation_id
                   WHERE cp_me.user_id = $1
                )
              )
        ORDER BY s.created_at DESC`,
      [userId],
    );

    res.json({
      statuses: rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        content: r.content,
        created_at: r.created_at.toISOString(),
        expires_at: r.expires_at.toISOString(),
        user: {
          id: r.user_id,
          username: r.username,
          display_name: r.display_name,
          avatar_url: r.avatar_url,
          status: r.presence_status,
        },
      })),
    });
  }),
);

// POST /api/statuses { content } -> create a status (author-only)
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const content = trimString(req.body?.content, 280);
    if (!content) throw new HttpError(400, 'Status content is required');

    const { rows } = await query<StatusWithUser>(
      `INSERT INTO statuses (user_id, content) VALUES ($1, $2) RETURNING *`,
      [userId, content],
    );
    const status = rows[0];

    const { rows: author } = await query<{ username: string; display_name: string; avatar_url: string | null; status: string }>(
      'SELECT username, display_name, avatar_url, status FROM users WHERE id = $1',
      [userId],
    );

    const payload = {
      id: status.id,
      user_id: status.user_id,
      content: status.content,
      created_at: status.created_at.toISOString(),
      expires_at: status.expires_at.toISOString(),
      user: {
        id: userId,
        username: author[0].username,
        display_name: author[0].display_name,
        avatar_url: author[0].avatar_url,
        status: author[0].status,
      },
    };

    const recipients = await statusRecipients(userId);
    emitToUsers('status:new', payload, recipients);
    res.status(201).json({ status: payload });
  }),
);

// DELETE /api/statuses/:id -> delete your own status
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const { rows } = await query<StatusRow>('SELECT * FROM statuses WHERE id = $1', [
      String(req.params.id),
    ]);
    const status = rows[0];
    if (!status) throw new HttpError(404, 'Status not found');
    if (status.user_id !== userId) throw new HttpError(403, 'You can only delete your own statuses');

    await query('DELETE FROM statuses WHERE id = $1', [status.id]);
    const recipients = await statusRecipients(userId);
    emitToUsers('status:delete', { statusId: status.id, userId }, recipients);
    res.json({ deleted: status.id });
  }),
);

export default router;