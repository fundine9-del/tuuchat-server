import { query } from '../src/db';

async function main() {
  await query(`
    create table if not exists public.statuses (
        id         uuid primary key default gen_random_uuid(),
        user_id    uuid not null references public.users (id) on delete cascade,
        content    text not null check (length(content) <= 280),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null default now() + interval '24 hours'
    )`);
  await query('create index if not exists idx_statuses_user on public.statuses (user_id)');
  await query('create index if not exists idx_statuses_expiry on public.statuses (expires_at)');
  await query('alter table public.statuses enable row level security');
  console.log('statuses table present');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});