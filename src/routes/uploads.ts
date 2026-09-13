import { Request, Response, Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { query } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { ConversationRow } from '../types';
import { HttpError } from '../utils';
import { getParticipantById, requireParticipant } from '../helpers/conversations';

const router = Router();
router.use(requireAuth);

const BUCKET = 'avatars';

function storageClient(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceRole = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    throw new HttpError(500, 'Storage is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new HttpError(400, 'Only image files are allowed'));
  },
});

async function uploadAvatar(buffer: Buffer, mimetype: string, originalName: string, pathPrefix: string): Promise<string> {
  const ext = (require('path').extname(originalName).toLowerCase() || '.jpg').replace(/[^.a-z0-9]/g, '');
  const name = `${pathPrefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const sb = storageClient();
  const { error } = await sb.storage.from(BUCKET).upload(name, buffer, {
    contentType: mimetype,
    upsert: false,
  });
  if (error) throw new HttpError(500, `Upload failed: ${error.message}`);
  return sb.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
}

async function deleteAvatar(avatarUrl: string | null | undefined): Promise<void> {
  if (!avatarUrl) return;
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = avatarUrl.indexOf(marker);
  if (idx < 0) return;
  const name = avatarUrl.slice(idx + marker.length);
  if (!name) return;
  try {
    await storageClient().storage.from(BUCKET).remove([name]);
  } catch {
    /* ignore */
  }
}

// POST /api/users/me/avatar  (multipart field name: "avatar")
router.post(
  '/users/me/avatar',
  upload.single('avatar'),
  async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!req.file) throw new HttpError(400, 'No file provided (field name: avatar)');

    const { rows } = await query<{ avatar_url: string | null }>('SELECT avatar_url FROM users WHERE id = $1', [
      userId,
    ]);
    const url = await uploadAvatar(req.file.buffer, req.file.mimetype, req.file.originalname, `user-${userId}`);
    await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [url, userId]);
    await deleteAvatar(rows[0]?.avatar_url ?? null);
    res.status(201).json({ avatar_url: url });
  },
);

// POST /api/conversations/:id/avatar  (multipart field name: "avatar", group admins only)
router.post(
  '/conversations/:id/avatar',
  upload.single('avatar'),
  async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!req.file) throw new HttpError(400, 'No file provided (field name: avatar)');

    const conversation: ConversationRow = await requireParticipant(String(req.params.id), userId);
    const me = await getParticipantById(conversation.id, userId);
    if (!me || me.role !== 'admin') throw new HttpError(403, 'Only admins can change the group photo');

    const url = await uploadAvatar(req.file.buffer, req.file.mimetype, req.file.originalname, `conv-${conversation.id}`);
    await query('UPDATE conversations SET avatar_url = $1 WHERE id = $2', [url, conversation.id]);
    await deleteAvatar(conversation.avatar_url);
    res.status(201).json({ avatar_url: url });
  },
);

export default router;