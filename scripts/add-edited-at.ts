import { query } from '../src/db';

async function main() {
  await query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at timestamptz');
  console.log('messages.edited_at column present');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});