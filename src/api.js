// HTTP API. Uses web-standard Request/Response so the same code runs as a Netlify
// Function (free plan) and inside the plain Node server used on OVH / Docker.
import crypto from 'node:crypto';
import { q, tx, loadAll, getVersion, bumpVersion, audit } from './db.js';
import { currentUser, login, makeToken, cookieHeader, hash, verify, passwordProblem, suggestUsername, defaultPassword } from './auth.js';
import { viewFor, checkChange, checkSingle, isAdmin } from './policy.js';

const DOC_MAX = 4 * 1024 * 1024;
const DOC_MIME = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const COLLECTION_KEYS = ['designations', 'employees', 'clients', 'projects', 'tasks', 'leaves', 'expenses', 'advances', 'updates', 'logs', 'pipeline', 'events', 'estimates'];

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const err = (status, message) => json({ error: message }, status);
const uid = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

async function body(req) { try { return await req.json(); } catch { return {}; } }

function publicUser(u) {
  return { username: u.username, employeeId: u.employee_id, role: u.role, name: u.name, mustChange: u.must_change };
}

// Splits a prototype backup into collections (arrays of records with ids) and settings.
function normaliseBackup(db) {
  const out = { ...db };
  delete out.demo;
  (out.logs || []).forEach((l, i) => { if (!l.id) l.id = 'LG' + i.toString(36) + crypto.randomBytes(2).toString('hex'); });
  return out;
}

async function writeAll(run, db, username) {
  await run('delete from od_entities');
  await run('delete from od_singletons');
  for (const [k, v] of Object.entries(db)) {
    const isColl = COLLECTION_KEYS.includes(k) || (Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && x.id));
    if (isColl && Array.isArray(v)) {
      for (const rec of v) await run(`insert into od_entities(coll,id,data,updated_by) values($1,$2,$3,$4)`, [k, String(rec.id), rec, username]);
    } else {
      await run(`insert into od_singletons(key,data,updated_by) values($1,$2,$3)`, [k, JSON.stringify(v), username]);
    }
  }
}

export async function snapshot(kind = 'auto') {
  const db = await loadAll();
  await q(`insert into od_backups(kind,data) values($1,$2)`, [kind, JSON.stringify(db)]);
  await q(`delete from od_backups where id not in (select id from od_backups order by at desc limit 21)`);
  return db;
}

export async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/\.netlify\/functions\/api/, '/api').replace(/\/+$/, '');
  const m = req.method;
  try {
    // ---------- public ----------
    if (path === '/api/health') return json({ ok: true, time: new Date().toISOString() });

    if (path === '/api/setup/status' && m === 'GET') {
      const n = (await q('select count(*)::int n from od_users'))[0].n;
      return json({ needsSetup: n === 0, setupKeyConfigured: !!process.env.SETUP_KEY });
    }

    if (path === '/api/setup/preview' && m === 'POST') {
      const b = await body(req);
      const n = (await q('select count(*)::int n from od_users'))[0].n;
      if (n > 0) return err(409, 'Setup is already done.');
      if (!process.env.SETUP_KEY || b.setupKey !== process.env.SETUP_KEY) return err(403, 'The setup key is wrong.');
      const db = b.backup && (b.backup.db || b.backup);
      if (!db || !Array.isArray(db.employees) || !db.employees.length) return err(400, 'That file is not an OfficeDesk backup.');
      const taken = new Set();
      const logins = db.employees.filter(e => !e.isOwner && e.status !== 'Exited').map(e => ({
        employeeId: e.id, name: e.name, role: e.role, username: suggestUsername(e.name, taken) })).map(l => ({ ...l, password: defaultPassword(l.username) }));
      return json({ logins, counts: Object.fromEntries(COLLECTION_KEYS.map(k => [k, (db[k] || []).length])) });
    }

    if (path === '/api/setup' && m === 'POST') {
      const b = await body(req);
      if (!process.env.SETUP_KEY || b.setupKey !== process.env.SETUP_KEY) return err(403, 'The setup key is wrong.');
      const db = normaliseBackup((b.backup && (b.backup.db || b.backup)) || {});
      if (!Array.isArray(db.employees) || !db.employees.length) return err(400, 'That file is not an OfficeDesk backup.');
      const logins = Array.isArray(b.logins) ? b.logins : [];
      if (!logins.some(l => (db.employees.find(e => e.id === l.employeeId) || {}).role === 'admin')) return err(400, 'At least one Admin login is needed.');
      const names = new Set();
      for (const l of logins) {
        l.username = String(l.username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(l.username)) return err(400, `Username “${l.username}” must be 3–30 letters or numbers.`);
        if (names.has(l.username)) return err(400, `Username “${l.username}” is used twice.`);
        names.add(l.username);
        if (!l.password || String(l.password).length < 6) return err(400, `Password for ${l.username} must be at least 6 characters.`);
      }
      const hashes = await Promise.all(logins.map(l => hash(String(l.password))));
      await tx(async run => {
        const n = (await run('select count(*)::int n from od_users'))[0].n;
        if (n > 0) throw Object.assign(new Error('Setup is already done.'), { status: 409 });
        await writeAll(run, db, 'setup');
        for (let i = 0; i < logins.length; i++) {
          await run(`insert into od_users(username,employee_id,password_hash,must_change) values($1,$2,$3,true)`, [logins[i].username, logins[i].employeeId, hashes[i]]);
        }
        await bumpVersion(run);
        await audit(run, 'setup', 'setup', null, null, `Imported backup; created ${logins.length} logins`);
      });
      await snapshot('after-setup');
      return json({ ok: true, created: logins.length });
    }

    if (path === '/api/login' && m === 'POST') {
      const b = await body(req);
      const r = await login(b.username, b.password);
      if (!r.ok) return err(401, r.error);
      await q(`insert into od_audit(username,action) values($1,'login')`, [r.user.username]);
      return json({ user: publicUser(r.user) }, 200, { 'set-cookie': cookieHeader(makeToken(r.user), req) });
    }

    if (path === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookieHeader(null, req) });

    // ---------- signed in ----------
    const user = await currentUser(req);
    if (!user) return err(401, 'Please sign in.');

    if (path === '/api/me') return json({ user: publicUser(user) });

    if (path === '/api/password' && m === 'POST') {
      const b = await body(req);
      if (!(await verify(String(b.current || ''), user.password_hash))) return err(400, 'Your current password is wrong.');
      const prob = passwordProblem(b.next, user.username);
      if (prob) return err(400, prob);
      if (b.next === b.current) return err(400, 'Choose a password different from the current one.');
      const h = await hash(b.next);
      const rows = await q(`update od_users set password_hash=$2, must_change=false, token_version=token_version+1 where id=$1 returning *`, [user.id, h]);
      await q(`insert into od_audit(username,action) values($1,'password changed')`, [user.username]);
      return json({ ok: true }, 200, { 'set-cookie': cookieHeader(makeToken(rows[0]), req) });
    }

    if (user.must_change && !['/api/me', '/api/password', '/api/logout'].includes(path)) return err(403, 'Please change your password first.');

    if (path === '/api/version') return json({ version: await getVersion() });

    if (path === '/api/data' && m === 'GET') {
      const db = await loadAll();
      return json({ version: await getVersion(), db: viewFor(user, db), user: publicUser(user) });
    }

    if (path === '/api/changes' && m === 'POST') {
      const b = await body(req);
      const changes = Array.isArray(b.changes) ? b.changes : [];
      const singles = Array.isArray(b.singles) ? b.singles : [];
      if (changes.length + singles.length > 2000) return err(400, 'Too many changes at once.');
      const rejected = [];
      const version = await tx(async run => {
        const db = await loadAll(run);
        let applied = 0;
        for (const ch of changes) {
          if (!ch || typeof ch.c !== 'string' || ch.id == null || !['upsert', 'delete'].includes(ch.op)) { rejected.push({ ...ch, why: 'Bad change' }); continue; }
          ch.id = String(ch.id);
          if (ch.op === 'upsert' && (!ch.d || String(ch.d.id) !== ch.id)) { rejected.push({ c: ch.c, id: ch.id, why: 'Bad record' }); continue; }
          const ok = checkChange(user, db, ch);
          if (!ok.ok) { rejected.push({ c: ch.c, id: ch.id, op: ch.op, why: ok.why }); continue; }
          if (ch.op === 'delete') {
            await run(`delete from od_entities where coll=$1 and id=$2`, [ch.c, ch.id]);
            db[ch.c] = (db[ch.c] || []).filter(x => x.id !== ch.id);
          } else {
            await run(`insert into od_entities(coll,id,data,updated_by) values($1,$2,$3,$4)
              on conflict(coll,id) do update set data=excluded.data, updated_at=now(), updated_by=excluded.updated_by`, [ch.c, ch.id, ok.data, user.username]);
            const arr = db[ch.c] = db[ch.c] || [];
            const i = arr.findIndex(x => x.id === ch.id);
            if (i >= 0) arr[i] = ok.data; else arr.push(ok.data);
          }
          await audit(run, user.username, ch.op, ch.c, ch.id, ch.op === 'upsert' ? (ok.data.name || ok.data.title || ok.data.client || ok.data.label || '') : '');
          applied++;
        }
        for (const s of singles) {
          if (!s || typeof s.k !== 'string') continue;
          const ok = checkSingle(user, s.k);
          if (!ok.ok) { rejected.push({ k: s.k, why: ok.why }); continue; }
          await run(`insert into od_singletons(key,data,updated_by) values($1,$2,$3)
            on conflict(key) do update set data=excluded.data, updated_at=now(), updated_by=excluded.updated_by`, [s.k, JSON.stringify(s.d === undefined ? null : s.d), user.username]);
          await audit(run, user.username, 'update', s.k, null, '');
          applied++;
        }
        return applied ? await bumpVersion(run) : await getVersion(run);
      });
      return json({ version, rejected });
    }

    // ---------- documents ----------
    if (path === '/api/files' && m === 'POST') {
      const empId = url.searchParams.get('emp'), type = url.searchParams.get('type') || 'other', name = (url.searchParams.get('name') || 'document').slice(0, 200);
      const mime = (req.headers.get('content-type') || '').split(';')[0];
      if (!isAdmin(user) && empId !== user.employee_id) return err(403, 'You can only upload your own documents.');
      if (!DOC_MIME[mime]) return err(400, 'Upload a PDF, JPG, PNG or WEBP file.');
      const buf = Buffer.from(await req.arrayBuffer());
      if (!buf.length) return err(400, 'The file is empty.');
      if (buf.length > DOC_MAX) return err(413, 'The file is over 4 MB. Compress it or scan at a lower resolution.');
      const id = uid('DOC');
      const meta = { id, type, name, size: buf.length, mime, uploaded: new Date().toISOString().slice(0, 10), by: user.employee_id, verified: isAdmin(user) };
      const version = await tx(async run => {
        const rows = await run(`select data from od_entities where coll='employees' and id=$1 for update`, [empId]);
        if (!rows.length) throw Object.assign(new Error('Employee not found.'), { status: 404 });
        const e = rows[0].data; e.docs = (e.docs || []).concat(meta);
        await run(`insert into od_files(id,employee_id,doc_type,name,mime,size,data,uploaded_by) values($1,$2,$3,$4,$5,$6,$7,$8)`, [id, empId, type, name, mime, buf.length, buf, user.username]);
        await run(`update od_entities set data=$2, updated_at=now(), updated_by=$3 where coll='employees' and id=$1`, [empId, e, user.username]);
        await audit(run, user.username, 'upload', 'files', id, `${name} for ${e.name}`);
        return bumpVersion(run);
      });
      return json({ ok: true, doc: meta, version });
    }

    const fm = path.match(/^\/api\/files\/([A-Za-z0-9_-]+)$/);
    if (fm) {
      const rows = await q(`select id,employee_id,name,mime,size,data from od_files where id=$1`, [fm[1]]);
      const f = rows[0];
      if (!f) return err(404, 'File not found.');
      if (!isAdmin(user) && f.employee_id !== user.employee_id) return err(403, 'You cannot open this document.');
      if (m === 'GET') {
        const dl = url.searchParams.get('download') === '1';
        return new Response(f.data, { headers: { 'content-type': f.mime, 'cache-control': 'private, no-store',
          'content-disposition': `${dl ? 'attachment' : 'inline'}; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"` } });
      }
      if (m === 'DELETE') {
        const version = await tx(async run => {
          await run(`delete from od_files where id=$1`, [f.id]);
          const er = await run(`select data from od_entities where coll='employees' and id=$1 for update`, [f.employee_id]);
          if (er.length) { const e = er[0].data; e.docs = (e.docs || []).filter(d => d.id !== f.id);
            await run(`update od_entities set data=$2, updated_at=now(), updated_by=$3 where coll='employees' and id=$1`, [f.employee_id, e, user.username]); }
          await audit(run, user.username, 'delete', 'files', f.id, f.name);
          return bumpVersion(run);
        });
        return json({ ok: true, version });
      }
    }

    // ---------- admin ----------
    if (!isAdmin(user)) return err(403, 'Only the Admin can do this.');

    if (path === '/api/users' && m === 'GET') {
      const rows = await q(`select username, employee_id, must_change, disabled, last_login, locked_until, failed from od_users order by username`);
      return json({ users: rows.map(r => ({ username: r.username, employeeId: r.employee_id, mustChange: r.must_change, disabled: r.disabled,
        lastLogin: r.last_login, locked: !!(r.locked_until && new Date(r.locked_until) > new Date()) })) });
    }

    if (path === '/api/users' && m === 'POST') {
      const b = await body(req);
      const empId = String(b.employeeId || '');
      const er = await q(`select data from od_entities where coll='employees' and id=$1`, [empId]);
      if (!er.length) return err(404, 'Save the employee first, then create the login.');
      const uname = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(uname)) return err(400, 'Username must be 3–30 letters or numbers (no spaces).');
      const pw = String(b.password || defaultPassword(uname));
      if (pw.length < 6) return err(400, 'Password must be at least 6 characters.');
      const clash = await q(`select employee_id from od_users where lower(username)=$1 and employee_id<>$2`, [uname, empId]);
      if (clash.length) return err(409, 'That username is already used by someone else.');
      const h = await hash(pw);
      await q(`insert into od_users(username,employee_id,password_hash,must_change) values($1,$2,$3,true)
        on conflict(employee_id) do update set username=excluded.username, password_hash=excluded.password_hash, must_change=true,
        failed=0, locked_until=null, disabled=false, token_version=od_users.token_version+1`, [uname, empId, h]);
      await q(`insert into od_audit(username,action,coll,entity_id,detail) values($1,'login set','users',$2,$3)`, [user.username, empId, uname]);
      return json({ ok: true, username: uname, password: pw });
    }

    if (path === '/api/users/disable' && m === 'POST') {
      const b = await body(req);
      if (b.employeeId === user.employee_id) return err(400, 'You cannot switch off your own login.');
      await q(`update od_users set disabled=$2, token_version=token_version+1 where employee_id=$1`, [b.employeeId, !!b.disabled]);
      await q(`insert into od_audit(username,action,coll,entity_id) values($1,$2,'users',$3)`, [user.username, b.disabled ? 'login off' : 'login on', b.employeeId]);
      return json({ ok: true });
    }

    if (path === '/api/users/delete' && m === 'POST') {
      const b = await body(req);
      if (b.employeeId === user.employee_id) return err(400, 'You cannot delete your own login.');
      await q(`delete from od_users where employee_id=$1`, [b.employeeId]);
      await q(`delete from od_files where employee_id=$1`, [b.employeeId]);
      return json({ ok: true });
    }

    if (path === '/api/backup' && m === 'GET') {
      const id = url.searchParams.get('id');
      let db, at = new Date().toISOString();
      if (id) { const r = await q(`select at, data from od_backups where id=$1`, [id]); if (!r.length) return err(404, 'Backup not found.'); db = r[0].data; at = r[0].at; }
      else db = await loadAll();
      return json({ app: 'OfficeDesk', savedOn: at, db }, 200, { 'content-disposition': `attachment; filename="OfficeDesk-backup-${String(at).slice(0, 10)}.json"` });
    }

    if (path === '/api/backups' && m === 'GET') {
      const rows = await q(`select id, at, kind, length(data::text) as size from od_backups order by at desc limit 21`);
      return json({ backups: rows });
    }

    if (path === '/api/backups' && m === 'POST') { await snapshot('manual'); return json({ ok: true }); }

    if (path === '/api/restore' && m === 'POST') {
      const b = await body(req);
      const db = normaliseBackup((b.backup && (b.backup.db || b.backup)) || {});
      if (!Array.isArray(db.employees) || !db.employees.length) return err(400, 'That file is not an OfficeDesk backup.');
      if (!db.employees.some(e => e.id === user.employee_id && e.role === 'admin')) return err(400, 'This backup does not contain your Admin login, so restoring it would lock you out.');
      await snapshot('before-restore');
      const version = await tx(async run => { await writeAll(run, db, user.username); await audit(run, user.username, 'restore', null, null, String(b.backup && b.backup.savedOn || '')); return bumpVersion(run); });
      return json({ ok: true, version });
    }

    if (path === '/api/audit' && m === 'GET') {
      const rows = await q(`select at, username, action, coll, entity_id, detail from od_audit order by id desc limit 300`);
      return json({ entries: rows });
    }

    return err(404, 'Not found.');
  } catch (e) {
    if (e.status) return err(e.status, e.message);
    console.error(e);
    return err(500, 'Something went wrong on the server. Please try again.');
  }
}
