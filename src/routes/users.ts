import { Router } from 'express';
import { query } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { UserRow, UserStatus } from '../types';
import { asyncHandler, HttpError, sanitizeUser, trimString, validStatus } from '../utils';

const router = Router();
router.use(requireAuth);

// PATCH /api/users/me  { display_name?, bio? }
router.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const { userId, user } = req as AuthenticatedRequest;

    const displayName =
      req.body?.display_name !== undefined ? trimString(req.body.display_name, 60) : user.display_name;
    const bio =
      req.body?.bio !== undefined ? trimString(String(req.body.bio), 200) : user.bio;

    const { rows } = await query<UserRow>(
      'UPDATE users SET display_name = $1, bio = $2 WHERE id = $3 RETURNING *',
      [displayName, bio, userId],
    );
    res.json({ user: sanitizeUser(rows[0]) });
  }),
);

// PUT /api/users/me/status { status: 'online'|'offline'|'away'|'busy' }
router.put(
  '/me/status',
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const { status } = req.body as { status?: unknown };
    if (!validStatus(status)) throw new HttpError(400, 'Invalid status value');

    await query('UPDATE users SET status = $1 WHERE id = $2', [status, userId]);
    res.json({ status });
  }),
);

// GET /api/users/:id/presence -> { status, online, last_seen }
router.get(
  '/:id/presence',
  asyncHandler(async (req, res) => {
    const { rows } = await query<UserRow>('SELECT status, last_seen FROM users WHERE id = $1', [
      req.params.id,
    ]);
    if (rows.length === 0) throw new HttpError(404, 'User not found');
    const user = rows[0];
    res.json({
      user_id: req.params.id,
      online: user.status === 'online',
      status: user.status,
      last_seen: user.last_seen?.toISOString() ?? null,
    });
  }),
);

// GET /api/users/search?q=... -> find users by username or display name
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ users: [] });

    const { rows } = await query<UserRow>(
      `SELECT * FROM users
        WHERE lower(username) LIKE lower($1) OR lower(display_name) LIKE lower($1)
        ORDER BY display_name
        LIMIT 30`,
      [`%${q}%`],
    );
    res.json({ users: rows.map(sanitizeUser) });
  }),
);

// GET /api/users/:id -> public profile + presence
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) throw new HttpError(404, 'User not found');
    res.json({ user: sanitizeUser(rows[0]) });
  }),
);

export type { UserStatus };
export default router;