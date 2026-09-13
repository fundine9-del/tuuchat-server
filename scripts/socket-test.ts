import { io, Socket } from 'socket.io-client';

const base = process.env.BASE ?? 'http://localhost:3000';
const tokenA = process.env.TOKEN_A!;
const tokenB = process.env.TOKEN_B!;
const convId = process.env.CONV_ID!;

const names = new Map<Socket, string>();
const log: string[] = [];

function mk(token: string, name: string): Socket {
  const s = io(base, { auth: { token } });
  names.set(s, name);
  s.on('presence:update', (d) => log.push(`${name}<-presence ${d.status} ${d.userId}`));
  s.on('typing:update', (d) => log.push(`${name}<-typing user=${d.userId} isTyping=${d.isTyping}`));
  s.on('message:new', (m) => log.push(`${name}<-message:new ${m.content}`));
  s.on('connect_error', (e) => log.push(`${name}<-error ${e.message}`));
  s.on('disconnect', () => log.push(`${name} disconnected`));
  return s;
}

const alice = mk(tokenA, 'alice');
const bob = mk(tokenB, 'bob');

let ready = 0;
function onReady() {
  ready += 1;
  if (ready < 2) return;
  // let server-side room joins finish first
  setTimeout(() => {
    bob.emit('typing', { conversationId: convId, isTyping: true });
    log.push('bob sent typing:start');
    setTimeout(() => bob.emit('typing', { conversationId: convId, isTyping: false }), 600);
  }, 1500);
  setTimeout(() => {
    console.log('EVENTS: ' + log.join(' | '));
    alice.close();
    bob.close();
    process.exit(0);
  }, 4500);
}

alice.on('connect', onReady);
bob.on('connect', onReady);

setTimeout(() => {
  console.log('TIMEOUT EVENTS: ' + log.join(' | '));
  alice.close();
  bob.close();
  process.exit(1);
}, 15000);