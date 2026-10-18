// PostgreSQL access. Works with Supabase (free plan, transaction pooler) and a plain
// Postgres server (OVH / Docker). Connection comes from DATABASE_URL.
import pg from 'pg';

let pool = null;
let schemaReady = null;

function sslFor(cs) {
  if (process.env.PGSSL === 'off') return false;
  if (/@(localhost|127\.0\.0\.1|db|postgres)(:|\/)/.test(cs)) return false;
  return { rejectUnauthorized: false };
}

export function pool_() {
  if (!pool) {
    const cs = process.env.DATABASE_URL;
    if (!cs) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString: cs,
      ssl: sslFor(cs),
      max: process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME ? 1 : 5,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

export async function q(text, params) {
  await ensureSchema();
  return (await pool_().query(text, params)).rows;
}

export async function tx(fn) {
  await ensureSchema();
  const c = await pool_().connect();
  try {
    await c.query('begin');
    const run = (t, p) => c.query(t, p).then(r => r.rows);
    const out = await fn(run);
    await c.query('commit');
    return out;
  } catch (e) {
    try { await c.query('rollback'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

export const SCHEMA = `
create table if not exists od_users(
  id serial primary key,
  username text unique not null,
  employee_id text unique not null,
  password_hash text not null,
  must_change boolean not null default true,
  failed int not null default 0,
  locked_until timestamptz,
  token_version int not null default 0,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  last_login timestamptz
);
create table if not exists od_entities(
  coll text not null,
  id text not null,
  data jsonb not null,
  ord bigserial,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key(coll, id)
);
create table if not exists od_singletons(
  key text primary key,
  data jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
create table if not exists od_meta(key text primary key, value text);
create table if not exists od_audit(
  id bigserial primary key,
  at timestamptz not null default now(),
  username text,
  action text,
  coll text,
  entity_id text,
  detail text
);
create table if not exists od_files(
  id text primary key,
  employee_id text not null,
  doc_type text,
  name text,
  mime text,
  size int,
  data bytea not null,
  uploaded_by text,
  at timestamptz not null default now()
);
create table if not exists od_backups(
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text,
  data jsonb not null
);
`;

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool_().query(SCHEMA).catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

export async function getVersion(run) {
  const rows = await (run || q)(`select value from od_meta where key='version'`);
  return rows.length ? +rows[0].value : 0;
}

export async function bumpVersion(run) {
  const rows = await run(
    `insert into od_meta(key,value) values('version','1')
     on conflict(key) do update set value=(od_meta.value::bigint+1)::text returning value`);
  return +rows[0].value;
}

export async function loadAll(run) {
  const r = run || q;
  const ents = await r(`select coll, data from od_entities order by coll, ord`);
  const singles = await r(`select key, data from od_singletons`);
  const db = {};
  for (const s of singles) db[s.key] = s.data;
  for (const e of ents) (db[e.coll] = db[e.coll] || []).push(e.data);
  return db;
}

export async function audit(run, username, action, coll, id, detail) {
  await run(`insert into od_audit(username,action,coll,entity_id,detail) values($1,$2,$3,$4,$5)`,
    [username, action, coll || null, id || null, detail ? String(detail).slice(0, 500) : null]);
}

export async function closePool() { if (pool) { await pool.end(); pool = null; schemaReady = null; } }
