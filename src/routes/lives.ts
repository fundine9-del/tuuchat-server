import { Router } from 'express';
import { query } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { LiveRow } from '../types';
import { asyncHandler, HttpError, trimString } from '../utils';
import { liveRecipients, serializeLive, LivePayload } from '../helpers/lives';
import { emitToUsers, registerLiveHost, getLiveViewerCount, endLive } from '../socket';

const router = Router();
router.use(requireAuth);

// The live broadcasts the current user can see: their own + those hosted by
// people they share a conversation with.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;

    const { rows } = await query<LiveRow>(
      `SELECT l.*
         FROM lives l
        WHERE l.status = 'live'
          AND (
                l.host_id = $1
             OR l.host_id IN (
                  SELECT DISTINCT cp_other.user_id
                    FROM conversation_participants cp_me
                    JOIN conversation_participants cp_other
                      ON cp_other.conversation_id = cp_me.conversation_id
                   WHERE cp_me.user_id = $1
                )
              )
        ORDER BY l.started_at DESC`,
      [userId],
    );

    const lives: LivePayload[] = await Promise.all(
      rows.map((r) => serializeLive(r, getLiveViewerCount(r.id))),
    );
    res.json({ lives });
  }),
);

// POST /api/live/start { title } -> start broadcasting yourself (one live per user)
router.post(
  '/start',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const title = trimString(req.body?.title, 60);

    const dup = await query('SELECT 1 FROM lives WHERE host_id = $1 AND status = $2', [
      userId,
      'live',
    ]);
    if (dup.rows.length > 0) throw new HttpError(409, 'You are already live');

    const { rows } = await query<LiveRow>(
      `INSERT INTO lives (host_id, title) VALUES ($1, $2) RETURNING *`,
      [userId, title],
    );
    const live = rows[0];
    registerLiveHost(live.id, userId);

    const payload: LivePayload = await serializeLive(live, 0);
    const recipients = await liveRecipients(userId);
    emitToUsers('live:started', payload, recipients);
    res.status(201).json({ live: payload });
  }),
);

// POST /api/live/:id/end -> host ends the broadcast
router.post(
  '/:id/end',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const { rows } = await query<LiveRow>('SELECT * FROM lives WHERE id = $1', [
      String(req.params.id),
    ]);
    const live = rows[0];
    if (!live || live.status !== 'live') throw new HttpError(404, 'Live not found');
    if (live.host_id !== userId) throw new HttpError(403, 'Only the host can end this live');

    await endLive(live.id);
    res.json({ ended: live.id });
  }),
);

export default router;