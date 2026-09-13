import { Request, Response, Router } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import multer from 'multer';
import crypto from 'crypto';
import { query } from '../db';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { ConversationRow } from '../types';
import { HttpError } from '../utils';
import { getParticipantById, requireParticipant } from '../helpers/conversations';

const router = Router();
router.use(requireAuth);

export const uploadsDir = path.resolve(process.cwd(), 'uploads');
const avatarsDir = path.join(uploadsDir, 'avatars');

mkdirSync(avatarsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new HttpError(400, 'Only image files are allowed'));
  },
});

function deleteOldAvatar(avatarUrl: string | null): void {
  if (!avatarUrl || !avatarUrl.startsWith('/uploads/avatars/')) return;
  const filename = path.basename(avatarUrl);
  const file = path.join(avatarsDir, filename);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
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
    deleteOldAvatar(rows[0]?.avatar_url ?? null);

    const url = `/uploads/avatars/${req.file.filename}`;
    await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [url, userId]);
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

    deleteOldAvatar(conversation.avatar_url);
    const url = `/uploads/avatars/${req.file.filename}`;
    await query('UPDATE conversations SET avatar_url = $1 WHERE id = $2', [url, conversation.id]);
    res.status(201).json({ avatar_url: url });
  },
);

export default router;