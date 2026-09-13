import { NextFunction, Request, RequestHandler, Response } from 'express';
import { UserRow, SafeUser, UserStatus, MessageType } from './types';
import { isUserOnline } from './socket';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function sanitizeUser(u: UserRow): SafeUser {
  const { password_hash, ...rest } = u;
  return {
    ...rest,
    last_seen: (u.last_seen ?? new Date()).toISOString(),
    created_at: (u.created_at ?? new Date()).toISOString(),
    online: isUserOnline(u.id),
  };
}

export function validStatus(s: unknown): s is UserStatus {
  return s === 'online' || s === 'offline' || s === 'away' || s === 'busy';
}

export function validMessageType(t: unknown): t is MessageType {
  return t === 'text' || t === 'image' || t === 'file';
}

export function trimString(v: unknown, maxLength: number): string {
  const s = String(v ?? '').trim();
  if (s.length > maxLength) throw new HttpError(400, `Field too long (max ${maxLength} chars)`);
  return s;
}