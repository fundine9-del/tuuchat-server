import express, { NextFunction, Request, Response } from 'express';
import { createServer } from 'http';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import { query } from './db';
import { initSocket } from './socket';
import { HttpError } from './utils';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import conversationsRouter from './routes/conversations';
import messagesRouter from './routes/messages';
import statusesRouter from './routes/statuses';
import uploadsRouter, { uploadsDir } from './routes/uploads';

dotenv.config();

const rawCors = process.env.CORS_ORIGIN;
const corsOrigin = !rawCors || rawCors === '*' ? true : rawCors.split(',');

const app = express();

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));

// serve uploaded avatars at /uploads/...
app.use('/uploads', express.static(uploadsDir));

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'disconnected' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/statuses', statusesRouter);
app.use('/api', messagesRouter);
app.use('/api', uploadsRouter);

// 404 for unknown API routes
app.use('/api', (_req: Request, res: Response) => res.status(404).json({ error: 'Not found' }));

// central error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5MB)' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  // fail fast if the database is unreachable
  await query('SELECT 1').catch((err) => {
    console.error('[db] Could not reach the database. Check DATABASE_URL in .env');
    console.error(err.message);
    process.exit(1);
  });

  const server = createServer(app);
  const io = initSocket(server);

  server.listen(port, () => {
    console.log(`[tuuchat] REST + Socket.IO listening on http://localhost:${port}`);
    console.log(`[tuuchat] sockets: ${io.engine?.clientsCount ?? 0} connected`);
  });
}

main();