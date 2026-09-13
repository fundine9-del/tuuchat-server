-- ============================================================================
-- Tuuchat Server - Supabase / PostgreSQL schema
-- Run this in the Supabase SQL Editor.
-- ============================================================================

-- ============================================================================
-- USERS
-- ============================================================================
create table if not exists public.users (
    id            uuid primary key default gen_random_uuid(),
    username      text not null unique,
    email         text not null unique,
    password_hash text not null,
    display_name  text not null,
    bio           text not null default '',
    avatar_url    text,
    status        text not null default 'offline'
                  check (status in ('online', 'offline', 'away', 'busy')),
    last_seen     timestamptz not null default now(),
    created_at    timestamptz not null default now()
);

comment on column public.users.status is
    'Presence status. "online/offline" is driven by socket connections; away/busy are user-set.';

-- ============================================================================
-- CONVERSATIONS (direct chats and group chats)
-- ============================================================================
create table if not exists public.conversations (
    id         uuid primary key default gen_random_uuid(),
    type       text not null default 'direct'
               check (type in ('direct', 'group')),
    name       text,                               -- null for direct chats
    avatar_url text,                               -- group avatar
    created_by uuid references public.users (id) on delete set null,
    created_at timestamptz not null default now()
);

-- ============================================================================
-- MESSAGES
-- (must exist before conversation_participants, which references messages.id)
-- ============================================================================
create table if not exists public.messages (
    id              uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.conversations (id) on delete cascade,
    sender_id       uuid not null references public.users (id) on delete cascade,
    message_type    text not null default 'text'
                    check (message_type in ('text', 'image', 'file')),
    content         text not null,                 -- text body, or URL for image/file
    reply_to_id     uuid references public.messages (id) on delete set null,
    created_at      timestamptz not null default now(),
    edited_at       timestamptz
);

-- ============================================================================
-- CONVERSATION PARTICIPANTS
-- ============================================================================
create table if not exists public.conversation_participants (
    id                  uuid primary key default gen_random_uuid(),
    conversation_id     uuid not null references public.conversations (id) on delete cascade,
    user_id             uuid not null references public.users (id) on delete cascade,
    role                text not null default 'member'
                        check (role in ('member', 'admin')),
    last_read_message_id uuid references public.messages (id) on delete set null,
    joined_at           timestamptz not null default now(),
    unique (conversation_id, user_id)
);

-- optional: keep track of deleted/edited messages
-- alter table public.messages add column if not exists edited_at timestamptz;
-- alter table public.messages add column if not exists deleted_at timestamptz;

-- ============================================================================
-- MESSAGE REACTIONS (optional but handy)
-- ============================================================================
create table if not exists public.message_reactions (
    id         uuid primary key default gen_random_uuid(),
    message_id uuid not null references public.messages (id) on delete cascade,
    user_id    uuid not null references public.users (id) on delete cascade,
    emoji      text not null,
    created_at timestamptz not null default now(),
    unique (message_id, user_id, emoji)
);

-- ============================================================================
-- STATUSES (WhatsApp-style text status stories, expire after 24h)
-- ============================================================================
create table if not exists public.statuses (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references public.users (id) on delete cascade,
    content    text not null check (length(content) <= 280),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '24 hours'
);

comment on table public.statuses is
    'Short text statuses a user posts; visible to users sharing a conversation with them. Expire after 24h.';

-- ============================================================================
-- INDEXES
-- ============================================================================
create index if not exists idx_messages_conversation_created
    on public.messages (conversation_id, created_at);
create index if not exists idx_messages_sender
    on public.messages (sender_id);
create index if not exists idx_participants_user
    on public.conversation_participants (user_id);
create index if not exists idx_participants_conversation
    on public.conversation_participants (conversation_id);
create index if not exists idx_statuses_user
    on public.statuses (user_id);
create index if not exists idx_statuses_expiry
    on public.statuses (expires_at);
create index if not exists idx_users_username_lower
    on public.users (lower(username));
create index if not exists idx_users_display_name_lower
    on public.users (lower(display_name));

-- ============================================================================
-- HELPER: touch last_seen (used by the server on connect/disconnect)
-- ============================================================================
create or replace function public.touch_last_seen(p_user_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    update public.users
       set last_seen = now()
     where id = p_user_id;
end;
$$;

-- ============================================================================
-- HELPER: set online/offline presence and update last_seen together
-- ============================================================================
create or replace function public.set_presence(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
as $$
begin
    update public.users
       set status    = p_status,
           last_seen = case when p_status = 'online' then last_seen else now() end
     where id = p_user_id;
end;
$$;

-- ============================================================================
-- HELPER: newest messages of a conversation (used for pagination)
-- Returns messages older than p_before, limited to p_limit.
-- ============================================================================
create or replace view public.last_message_per_conversation as
select distinct on (m.conversation_id)
       m.conversation_id,
       m.id              as message_id,
       m.sender_id,
       m.message_type,
       m.content,
       m.created_at
from public.messages m
order by m.conversation_id, m.created_at desc;

-- ============================================================================
-- TRIGGERS: keep last_seen fresh when offline presence is written
-- ============================================================================
drop trigger if exists trg_set_offline_last_seen on public.users;

create or replace function public.before_user_status_change()
returns trigger
language plpgsql
as $$
begin
    if new.status = 'offline' and old.status <> 'offline' then
        new.last_seen := now();
    end if;
    return new;
end;
$$;

create trigger trg_user_status_change
before update of status on public.users
for each row
execute function public.before_user_status_change();

-- ============================================================================
-- STORAGE BUCKET for profile / group avatars (Supabase Storage)
-- The server also serves uploaded files locally from /uploads as a fallback.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- ============================================================================
-- ROW LEVEL SECURITY
-- The tuuchat server connects with the service role / direct connection which
-- bypasses RLS. Keep RLS enabled anyway so browser-facing Supabase clients
-- cannot read hidden data, and re-enable policies here if you wire Supabase
-- Auth later.
-- ============================================================================
alter table public.users                    enable row level security;
alter table public.conversations            enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages                 enable row level security;
alter table public.message_reactions        enable row level security;
alter table public.statuses                 enable row level security;