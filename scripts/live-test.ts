import { io, Socket } from 'socket.io-client';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const results: string[] = [];

function ok(name: string, cond: boolean) {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) throw new Error(`assertion failed: ${name}`);
}

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(j)}`);
  return j;
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function once(socket: Socket, event: string, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (d) => {
      clearTimeout(t);
      resolve(d);
    });
  });
}

async function main() {
  const ts = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const hostInfo = await api('/api/auth/register', {
    body: { username: `livehost_${ts}`, email: `livehost_${ts}@t.dev`, password: 'Pass123!', display_name: 'Live Host' },
  });
  const viewerInfo = await api('/api/auth/register', {
    body: { username: `liveview_${ts}`, email: `liveview_${ts}@t.dev`, password: 'Pass123!', display_name: 'Live Viewer' },
  });
  const hostToken = hostInfo.token;
  const viewerToken = viewerInfo.token;
  const hostId = hostInfo.user.id;
  const viewerId = viewerInfo.user.id;

  // make them co-conversants so the viewer can list the live
  await api('/api/conversations', {
    method: 'POST',
    token: hostToken,
    body: { type: 'direct', user_ids: [viewerId] },
  });

  // host goes live
  const started = await api('/api/live/start', { token: hostToken, body: { title: 'My first live' } });
  const liveId = started.live.id;
  ok('start returns live id', typeof liveId === 'string' && liveId.length > 0);

  // two sockets
  const hostSock = await connect(hostToken);
  const viewerSock = await connect(viewerToken);

  // viewer can list the live (direct conversation makes them a co-conversant)
  const listForViewer = await api('/api/live', { token: viewerToken });
  ok('viewer lists the live', listForViewer.lives.some((l: any) => l.id === liveId));

  // viewer watches
  const hostViewerCount = once(hostSock, 'live:viewer-count');
  const viewerJoined = once(viewerSock, 'live:joined');
  viewerSock.emit('live:watch', { liveId });
  const joined = await viewerJoined;
  ok('viewer receives live:joined viewers=1', joined.viewers === 1);
  const vc = await hostViewerCount;
  ok('host receives live:viewer-count viewers=1', vc.viewers === 1);

  // viewer offer -> host
  const hostOffer = once(hostSock, 'live:watch-offer');
  viewerSock.emit('live:watch-offer', { liveId, sdp: { type: 'offer', sdp: 'fake-v-offer' } });
  const offer = await hostOffer;
  ok('host receives watch-offer with viewerSocketId', offer.viewerSocketId === viewerSock.id && offer.sdp?.type === 'offer');

  // host answer -> viewer
  const viewerAnswer = once(viewerSock, 'live:host-answer');
  hostSock.emit('live:host-answer', { liveId, sdp: { type: 'answer', sdp: 'fake-v-answer' }, viewerSocketId: viewerSock.id });
  const ans = await viewerAnswer;
  ok('viewer receives host-answer', ans.sdp?.type === 'answer');

  // host ICE -> viewer, viewer ICE -> host
  const viewerIce = once(viewerSock, 'live:ice');
  hostSock.emit('live:ice', { liveId, candidate: { candidate: 'host-cand', sdpMid: '0', sdpMLineIndex: 0 }, to: 'viewer', viewerSocketId: viewerSock.id });
  const vic = await viewerIce;
  ok('viewer receives host ICE (to=viewer)', vic.to === 'viewer' && vic.candidate?.candidate === 'host-cand');

  const hostIce = once(hostSock, 'live:ice');
  viewerSock.emit('live:ice', { liveId, candidate: { candidate: 'view-cand', sdpMid: '0', sdpMLineIndex: 0 }, to: 'host' });
  const hic = await hostIce;
  ok('host receives viewer ICE (to=host) with viewerSocketId', hic.to === 'host' && hic.viewerSocketId === viewerSock.id && hic.candidate?.candidate === 'view-cand');

  // viewer leaves -> host gets count 0
  const countAfterLeave = once(hostSock, 'live:viewer-count');
  viewerSock.emit('live:leave', { liveId });
  const c2 = await countAfterLeave;
  ok('host receives live:viewer-count viewers=0 after leave', c2.viewers === 0);

  // host ends -> all sockets see ended (viewer already left; re-add to test broadcast)
  viewerSock.emit('live:watch', { liveId });
  await once(viewerSock, 'live:joined');
  const ended = once(viewerSock, 'live:ended');
  const hostEnded = once(hostSock, 'live:ended');
  hostSock.emit('live:end', { liveId });
  await ended;
  await hostEnded;
  ok('host + viewer both receive live:ended', true);

  const listAfter = await api('/api/live', { token: viewerToken });
  ok('live no longer listed after end', !listAfter.lives.some((l: any) => l.id === liveId));

  // viewer joining an ended live = no-such
  const noSuch = once(viewerSock, 'live:no-such');
  viewerSock.emit('live:watch', { liveId });
  await noSuch;
  ok('watching an ended live returns live:no-such', true);

  hostSock.close();
  viewerSock.close();
  results.forEach((r) => console.log(r));
  process.exit(0);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  results.forEach((r) => console.log(r));
  process.exit(1);
});