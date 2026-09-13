# Tuuchat Server

Realtime messaging server (REST **+** Socket.IO) backed by Supabase / PostgreSQL.
Built for Flutter (`socket_io_client`) and web clients.

## Setup

1. **Database (Supabase)**
   - Open the Supabase SQL Editor and run `supabase.sql` (creates `users`, `conversations`,
     `conversation_participants`, `messages`, `message_reactions`, helpers, indexes, and an
     `avatars` storage bucket).

2. **Server**
   ```bash
   npm install
   copy .env.example .env      # fill in DATABASE_URL + JWT_SECRET
   npm run dev                 # start with hot reload
   ```
   - `DATABASE_URL`: Supabase Dashboard → Project Settings → Database → "Connection string (URI)".
   - `JWT_SECRET`: any long random string.

3. **Verify**
   ```bash
   npm run typecheck
   curl http://localhost:3000/health
   ```

## Endpoints

All protected endpoints require `Authorization: Bearer <token>`. Tokens come from login/register.

### Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | `{ email, username, password, display_name? }` | returns `{ token, user }` |
| POST | `/api/auth/login` | `{ email?/username?, password }` | returns `{ token, user }` |
| GET | `/api/auth/me` | – | current user |

### Messages
| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/api/conversations/:id/messages` | `?limit=50&before=<msgId\|iso>` | returns `{ messages, has_more }` |
| POST | `/api/conversations/:id/messages` | `{ content, message_type? ('text'\|'image'\|'file'), reply_to_id? }` | broadcasts `message:new` over socket |
| DELETE | `/api/messages/:id` | – | own message, or any message if group admin |

### Conversations / Groups
| Method | Path | Body/Query | Notes |
|---|---|---|---|
| GET | `/api/conversations` | – | list mine, with last message + participants |
| POST | `/api/conversations` | direct: `{type:'direct', user_ids:[peerId]}` · group: `{type:'group', name, user_ids:[...]}` | reuses existing direct chat |
| GET | `/api/conversations/:id` | – | details + participants |
| PATCH | `/api/conversations/:id` | `{ name?, avatar_url? }` | group admins only |
| POST | `/api/conversations/:id/participants` | `{ user_ids: [...] }` | group admins only |
| DELETE | `/api/conversations/:id/participants/:userId` | – | leave yourself or admin removes |
| POST | `/api/conversations/:id/typing` | `{ is_typing }` | REST fallback for typing |

### Users / Presence
| Method | Path | Body/Query | Notes |
|---|---|---|---|
| PUT | `/api/users/me/status` | `{ status: 'online'\|'offline'\|'away'\|'busy' }` | set your status |
| GET | `/api/users/:id/presence` | – | `{ online, status, last_seen }` (online is live) |
| GET | `/api/users/search` | `?q=` | find users by username/display name |
| GET | `/api/users/:id` | – | public profile incl. status + last_seen |

### Profile pictures
| Method | Path | Notes |
|---|---|---|
| POST | `/api/users/me/avatar` | `multipart/form-data`, field `avatar`, max 5MB |
| POST | `/api/conversations/:id/avatar` | group photo, admins only |
| GET | `/uploads/avatars/<file>` | served statically (`avatar_url` returned by uploads) |

## Socket.IO events

Connect first — token in handshake auth:
```js
io(url, { auth: { token: '<jwt>' } })
```

| Event | Direction | Payload |
|---|---|---|
| `presence:update` | server → all | `{ userId, status, last_seen }` on connect/disconnect |
| `message:new` | server → room `conv:<id>` | full message row |
| `typing` | client → server | `{ conversationId, isTyping }` |
| `typing:update` | server → room (others) | `{ conversationId, userId, isTyping }` |

Presence is automatic: sockets mark you online, and offline with `last_seen` on disconnect.
Avatars are stored on the server in `uploads/avatars/` (also mirrored to the Supabase
`avatars` bucket if you prefer `supabase.storage`).