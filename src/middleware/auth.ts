import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db';
import { UserRow } from '../types';
import { HttpError } from '../utils';

export interface AuthenticatedRequest extends Request {
  userId: string;
  user: UserRow;
}

export function signToken(userId: string, username: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return jwt.sign({ sub: userId, username }, secret, { expiresIn: '30d' });
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new HttpError(401, 'Missing bearer token');
    }
    const token = header.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new HttpError(500, 'JWT_SECRET is not set');

    const payload = jwt.verify(token, secret) as { sub: string };
    if (!payload?.sub) throw new HttpError(401, 'Invalid token');

    const { rows } = await query<UserRow>('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (rows.length === 0) throw new HttpError(401, 'User no longer exists');

    (req as AuthenticatedRequest).userId = rows[0].id;
    (req as AuthenticatedRequest).user = rows[0];
    next();
  } catch (err) {
    if (err instanceof HttpError) next(err);
    else if (err instanceof jwt.JsonWebTokenError) next(new HttpError(401, 'Invalid or expired token'));
    else next(err);
  }
}