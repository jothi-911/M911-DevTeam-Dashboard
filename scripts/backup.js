// Writes a full JSON backup to ./backups (used by cron on OVH). Usage: node scripts/backup.js
import { mkdir, writeFile } from 'node:fs/promises';
import { loadAll, closePool } from '../src/db.js';
const db = await loadAll();
await mkdir('backups', { recursive: true });
const f = `backups/OfficeDesk-${new Date().toISOString().slice(0, 10)}.json`;
await writeFile(f, JSON.stringify({ app: 'OfficeDesk', savedOn: new Date().toISOString(), db }, null, 1));
console.log('Saved', f);
await closePool();
