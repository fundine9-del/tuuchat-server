import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { query } from './db';
import { MessageRow, UserRow } from './types';

// userId -> set of socket ids (a user can be connected from several devices)
const presence = new Map<string, Set<string>>();

export function isUserOnline(userId: string): boolean {
  return presence.has(userId) && (presence.get(userId)?.size ?? 0) > 0;
}

let io: Server | null = null;

export function getIo(): Server {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

export function emitNewMessage(message: MessageRow): void {
  getIo().to(`conv:${message.conversation_id}`).emit('message:new', message);
}

export function emitMessageUpdated(message: MessageRow): void {
  if (io) getIo().to(`conv:${message.conversation_id}`).emit('message:update', message);
}

export function emitMessageDeleted(conversationId: string, messageId: string): void {
  if (io) getIo().to(`conv:${conversationId}`).emit('message:delete', { messageId, conversationId });
}

// Tell specific users their conversation list changed (works even if they're not
// yet in the conversation room, e.g. brand-new conversations or newly added members).
export function emitConversationUpdate(conversationId: string, userIds: string[]): void {
  if (!io) return;
  const seen = new Set<string>();
  for (const userId of userIds) {
    const sockets = presence.get(userId);
    if (!sockets) continue;
    for (const sid of sockets) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      io.to(sid).emit('conversations:update', { conversationId });
    }
  }
}

// Room-based variant for events where all current participants are already in the room.
export function emitConversationUpdateToRoom(conversationId: string): void {
  if (io) getIo().to(`conv:${conversationId}`).emit('conversations:update', { conversationId });
}

// Add users' live sockets into a conversation room so message/typing events reach them
// immediately, even for conversations created after their socket connected.
export function joinUsersToConversation(conversationId: string, userIds: string[]): void {
  if (!io) return;
  for (const userId of userIds) {
    const sockets = presence.get(userId);
    if (!sockets) continue;
    for (const sid of sockets) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.join(`conv:${conversationId}`);
    }
  }
}

export function emitTyping(conversationId: string, userId: string, isTyping: boolean): void {
  getIo().to(`conv:${conversationId}`).emit('typing:update', {
    conversationId,
    userId,
    isTyping,
  });
}

// Send an event to the live sockets of the given user ids (and no-one else).
export function emitToUsers(event: string, payload: unknown, userIds: string[]): void {
  if (!io) return;
  const seen = new Set<string>();
  for (const userId of userIds) {
    const sockets = presence.get(userId);
    if (!sockets) continue;
    for (const sid of sockets) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      io.to(sid).emit(event, payload);
    }
  }
}

async function loadUserId(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret) as { sub: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

async function setPresence(userId: string, status: 'online' | 'offline'): Promise<void> {
  try {
    await query('SELECT set_presence($1, $2)', [userId, status]);
  } catch {
    // presence helper missing -> fall back to a simple update
    await query(`UPDATE users SET status = $2, last_seen = now() WHERE id = $1`, [userId, status]).catch(
      () => undefined,
    );
  }
}

async function joinUserRooms(socket: Socket, userId: string): Promise<void> {
  const { rows } = await query<{ conversation_id: string }>(
    `SELECT conversation_id FROM conversation_participants WHERE user_id = $1`,
    [userId],
  );
  for (const r of rows) socket.join(`conv:${r.conversation_id}`);
}

export function initSocket(server: HttpServer): Server {
  const rawCors = process.env.CORS_ORIGIN;
  const corsOrigin = !rawCors || rawCors === '*' ? true : rawCors.split(',');

  io = new Server(server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    let token = (socket.handshake.auth as any)?.token;
    if (!token && socket.handshake.query?.token) token = String(socket.handshake.query.token);
    const userId = await loadUserId(token);
    if (!userId) return next(new Error('unauthorized'));
    socket.data.userId = userId;
    next();
  });

  io.on('connection', async (socket) => {
    const userId: string = socket.data.userId;

    const set = presence.get(userId) ?? new Set<string>();
    set.add(socket.id);
    presence.set(userId, set);

    // mark online only on the first connected device
    if (set.size === 1) await setPresence(userId, 'online');

    await joinUserRooms(socket, userId);

    socket.broadcast.emit('presence:update', { userId, status: 'online', last_seen: null });

    socket.on('typing', (data: { conversationId?: string; isTyping?: boolean }) => {
      if (typeof data?.conversationId !== 'string') return;
      socket.to(`conv:${data.conversationId}`).emit('typing:update', {
        conversationId: data.conversationId,
        userId,
        isTyping: Boolean(data.isTyping),
      });
    });

    // Call signaling: a generic relay. Every payload carries a `to` field =
    // the user id that should receive the event; the server forwards it to all
    // of that user's live sockets (WebRTC offers/answers/ICE happen client-side,
    // the server just routes them), mirroring the per-user send pattern.
    const callEvents = [
      'call:initiate',
      'call:accept',
      'call:reject',
      'call:cancel',
      'call:end',
      'call:offer',
      'call:answer',
      'call:ice',
    ] as const;
    for (const ev of callEvents) {
      socket.on(ev, (data: { to?: string; callId?: string }) => {
        const to = String(data?.to ?? '');
        const callId = String(data?.callId ?? '');
        if (!to || !callId || to === userId) return;
        // if the callee is not connected anywhere right now, tell the caller at once
        if (ev === 'call:initiate' && !(presence.get(to)?.size ?? 0)) {
          emitToUsers('call:unavailable', { callId, to: userId }, [userId]);
          return;
        }
        emitToUsers(ev, data, [to]);
      });
    }

    socket.on('disconnect', async () => {
      const set = presence.get(userId);
      if (set) set.delete(socket.id);
      if (!set || set.size === 0) {
        presence.delete(userId);
        await setPresence(userId, 'offline');
        const { rows } = await query<UserRow>('SELECT last_seen FROM users WHERE id = $1', [userId]);
        socket.broadcast.emit('presence:update', {
          userId,
          status: 'offline',
          last_seen: rows[0]?.last_seen ?? new Date().toISOString(),
        });
      }
    });
  });

  return io;
}