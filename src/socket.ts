import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { query } from './db';
import { MessageRow, UserRow } from './types';
import { liveRecipients } from './helpers/lives';

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

/* ------------------------- live broadcast rooms ------------------------- */

interface LiveRoom {
  liveId: string;
  hostUserId: string;
  readers: Map<string, string>; // socketId -> userId
}

const liveRooms = new Map<string, LiveRoom>();

export function registerLiveHost(liveId: string, hostUserId: string): void {
  const room = liveRooms.get(liveId) ?? { liveId, hostUserId, readers: new Map() };
  room.hostUserId = hostUserId;
  liveRooms.set(liveId, room);
}

export function getLiveViewerCount(liveId: string): number {
  return liveRooms.get(liveId)?.readers.size ?? 0;
}

export function unregisterLive(liveId: string): void {
  liveRooms.delete(liveId);
}

// Rebuild the in-memory room from the DB if the server restarted mid-live.
async function ensureLiveRoom(liveId: string): Promise<LiveRoom | undefined> {
  const existing = liveRooms.get(liveId);
  if (existing) return existing;
  const { rows } = await query<{ host_id: string }>(
    `SELECT host_id FROM lives WHERE id = $1 AND status = 'live'`,
    [liveId],
  );
  if (rows.length === 0) return undefined;
  const room: LiveRoom = { liveId, hostUserId: rows[0].host_id, readers: new Map() };
  liveRooms.set(liveId, room);
  return room;
}

function notifyViewerCount(liveId: string, hostUserId: string, count: number): void {
  emitToUsers('live:viewer-count', { liveId, viewers: count }, [hostUserId]);
}

export async function endLive(liveId: string): Promise<void> {
  const room = liveRooms.get(liveId);
  liveRooms.delete(liveId);
  await query('UPDATE lives SET status = $2, ended_at = now() WHERE id = $1', [liveId, 'ended']).catch(
    () => undefined,
  );
  if (!room) return;
  if (io) {
    for (const sid of room.readers.keys()) io.to(sid).emit('live:ended', { liveId });
  }
  const recipients = await liveRecipients(room.hostUserId);
  emitToUsers('live:ended', { liveId }, recipients);
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

    // Live broadcast: "watch" viewers register themselves; the host handles
    // each viewer's offer and answers back routed to that viewer's socket.
    socket.on('live:watch', async (data: { liveId?: string }) => {
      const liveId = String(data?.liveId ?? '');
      if (!liveId) return;
      const room = await ensureLiveRoom(liveId);
      if (!room) {
        socket.emit('live:no-such', { liveId });
        return;
      }
      room.readers.set(socket.id, userId);
      (socket.data as any).liveId = liveId;
      notifyViewerCount(liveId, room.hostUserId, room.readers.size);
      socket.emit('live:joined', { liveId, viewers: room.readers.size });
    });

    socket.on('live:watch-offer', (data: { liveId?: string; sdp?: unknown }) => {
      const liveId = String(data?.liveId ?? '');
      const room = liveRooms.get(liveId);
      if (!room || !data?.sdp) return;
      emitToUsers(
        'live:watch-offer',
        { liveId, sdp: data.sdp, viewerSocketId: socket.id },
        [room.hostUserId],
      );
    });

    socket.on('live:host-answer', (data: { liveId?: string; sdp?: unknown; viewerSocketId?: string }) => {
      const liveId = String(data?.liveId ?? '');
      const room = liveRooms.get(liveId);
      if (!room || !data?.sdp || socket.data.userId !== room.hostUserId) return;
      const sid = String(data.viewerSocketId ?? '');
      const sock = io?.sockets.sockets.get(sid);
      if (sock) sock.emit('live:host-answer', { liveId, sdp: data.sdp });
    });

    socket.on(
      'live:ice',
      (data: { liveId?: string; candidate?: unknown; to?: string; viewerSocketId?: string }) => {
        const liveId = String(data?.liveId ?? '');
        const room = liveRooms.get(liveId);
        if (!room || !data?.candidate) return;
        if (data.to === 'host') {
          emitToUsers(
            'live:ice',
            { liveId, candidate: data.candidate, to: 'host', viewerSocketId: socket.id },
            [room.hostUserId],
          );
        } else if (data.to === 'viewer' && socket.data.userId === room.hostUserId) {
          const sid = String(data.viewerSocketId ?? '');
          const sock = io?.sockets.sockets.get(sid);
          if (sock) sock.emit('live:ice', { liveId, candidate: data.candidate, to: 'viewer' });
        }
      },
    );

    socket.on('live:leave', (data: { liveId?: string }) => {
      const liveId = String(data?.liveId ?? '');
      const room = liveRooms.get(liveId);
      if (!room) return;
      room.readers.delete(socket.id);
      if ((socket.data as any).liveId === liveId) delete (socket.data as any).liveId;
      if (liveRooms.get(liveId) === room) notifyViewerCount(liveId, room.hostUserId, room.readers.size);
    });

    socket.on('live:end', (data: { liveId?: string }) => {
      const liveId = String(data?.liveId ?? '');
      const room = liveRooms.get(liveId);
      if (!room || socket.data.userId !== room.hostUserId) return;
      void endLive(liveId);
    });

    socket.on('disconnect', async () => {
      const set = presence.get(userId);
      // remove this socket from any live it was watching
      const watchedLive = (socket.data as any).liveId as string | undefined;
      if (watchedLive) {
        const room = liveRooms.get(watchedLive);
        if (room && room.readers.delete(socket.id)) {
          notifyViewerCount(watchedLive, room.hostUserId, room.readers.size);
        }
      }
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
        // a live host going fully offline ends their broadcast(s)
        const hostLives = [...liveRooms.entries()]
          .filter(([, r]) => r.hostUserId === userId)
          .map(([id]) => id);
        for (const liveId of hostLives) void endLive(liveId);
      }
    });
  });

  return io;
}