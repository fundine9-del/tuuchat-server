import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db';
import { requireAuth, signToken, AuthenticatedRequest } from '../middleware/auth';
import { UserRow } from '../types';
import { asyncHandler, HttpError, sanitizeUser, trimString } from '../utils';

const router = Router();

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /api/auth/register
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    const username = trimString(req.body?.username ?? '', 40);
    const displayName = trimString(req.body?.display_name ?? (username || 'User'), 60);

    if (!validEmail(String(email ?? ''))) throw new HttpError(400, 'Invalid email');
    if (!username) throw new HttpError(400, 'Username is required');
    if (typeof password !== 'string' || password.length < 6)
      throw new HttpError(400, 'Password must be at least 6 characters');

    const emailNorm = String(email).toLowerCase();
    const usernameNorm = username.toLowerCase();

    const dup = await query('SELECT 1 FROM users WHERE lower(email) = $1 OR lower(username) = $2', [
      emailNorm,
      usernameNorm,
    ]);
    if (dup.rows.length > 0) throw new HttpError(409, 'Email or username already taken');

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query<UserRow>(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [username, emailNorm, hash, displayName],
    );

    const user = rows[0];
    res.status(201).json({ token: signToken(user.id, user.username), user: sanitizeUser(user) });
  }),
);

// POST /api/auth/login
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email = '', username = '', password = '' } = req.body as {
      email?: string;
      username?: string;
      password?: string;
    };
    if (typeof password !== 'string' || !password)
      throw new HttpError(400, 'Password is required');

    const { rows } = await query<UserRow>(
      `SELECT * FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($2)`,
      [email || username, username || email],
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      throw new HttpError(401, 'Invalid credentials');

    res.json({ token: signToken(user.id, user.username), user: sanitizeUser(user) });
  }),
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthenticatedRequest;
    const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (rows.length === 0) throw new HttpError(404, 'User not found');
    res.json({ user: sanitizeUser(rows[0]) });
  }),
);

export default router;