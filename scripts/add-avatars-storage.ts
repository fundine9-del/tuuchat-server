import { createClient } from '@supabase/supabase-js';
import { query } from '../src/db';

async function main() {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceRole = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });

  const { data, error } = await admin.storage.createBucket('avatars', {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  });
  if (error && !String(error.message).includes('already exist')) {
    console.error('createBucket failed:', error.message);
    process.exit(1);
  }
  console.log('avatars bucket present (public)');

  await query(`
    do $$
    begin
      if not exists (select 1 from pg_policy where polname = 'avatars public read' and polrelid = 'storage.objects'::regclass) then
        create policy "avatars public read" on storage.objects for select using (bucket_id = 'avatars');
      end if;
      if not exists (select 1 from pg_policy where polname = 'avatars auth insert' and polrelid = 'storage.objects'::regclass) then
        create policy "avatars auth insert" on storage.objects for insert to authenticated with check (bucket_id = 'avatars');
      end if;
      if not exists (select 1 from pg_policy where polname = 'avatars auth update' and polrelid = 'storage.objects'::regclass) then
        create policy "avatars auth update" on storage.objects for update to authenticated using (bucket_id = 'avatars');
      end if;
      if not exists (select 1 from pg_policy where polname = 'avatars auth delete' and polrelid = 'storage.objects'::regclass) then
        create policy "avatars auth delete" on storage.objects for delete to authenticated using (bucket_id = 'avatars');
      end if;
    end
    $$;
  `);
  console.log('storage policies present (public read + auth write)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});