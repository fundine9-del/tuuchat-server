import { query } from '../src/db';

async function main() {
  await query(`
    create table if not exists public.lives (
      id         uuid primary key default gen_random_uuid(),
      host_id    uuid not null references public.users (id) on delete cascade,
      title      text not null default '',
      status     text not null default 'live' check (status in ('live','ended')),
      started_at timestamptz not null default now(),
      ended_at   timestamptz
    )
  `);
  await query('create index if not exists idx_lives_status on public.lives (status)');
  await query('create index if not exists idx_lives_host on public.lives (host_id)');
  await query('alter table public.lives enable row level security');
  console.log('lives table present');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});