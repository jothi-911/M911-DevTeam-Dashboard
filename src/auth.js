// Username + password logins. Passwords are stored as bcrypt hashes; sessions are
// HMAC-signed cookies. After 5 wrong passwords a login is locked for 15 minutes.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { q } from './db.js';

const COOKIE = 'od_session';
const SESSION_DAYS = 7;
export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 24) throw new Error('SESSION_SECRET must be set (at least 24 characters)');
  return s;
}
const b64u = b => Buffer.from(b).toString('base64url');
const sign = data => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export function makeToken(user) {
  const body = b64u(JSON.stringify({ u: user.id, v: user.token_version, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return body + '.' + sign(body);
}

export function readToken(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}

export function cookieHeader(token, req) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  if (!token) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function tokenFrom(req) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}

export const hash = pw => bcrypt.hash(pw, 10);
let DUMMY = null;
const dummy = () => DUMMY || (DUMMY = bcrypt.hashSync('not-a-real-password', 10));
export const verify = (pw, h) => bcrypt.compare(pw, h);

export function passwordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (username && pw.toLowerCase().replace(/[^a-z]/g, '') === username.toLowerCase().replace(/[^a-z]/g, '')) return 'Don’t use your name as the password.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and at least one number.';
  return null;
}

// Returns the signed-in user row joined with the employee's role, or null.
export async function currentUser(req) {
  const t = readToken(tokenFrom(req));
  if (!t) return null;
  const rows = await q(`select u.*, e.data->>'role' as role, e.data->>'name' as name, e.data->>'status' as emp_status
    from od_users u left join od_entities e on e.coll='employees' and e.id=u.employee_id where u.id=$1`, [t.u]);
  const u = rows[0];
  if (!u || u.disabled || u.token_version !== t.v || u.emp_status === 'Exited' || !u.role) return null;
  return u;
}

export async function login(username, password) {
  const uname = String(username || '').trim().toLowerCase();
  const rows = await q(`select u.*, e.data->>'role' as role, e.data->>'status' as emp_status, e.data->>'name' as name
    from od_users u left join od_entities e on e.coll='employees' and e.id=u.employee_id where lower(u.username)=$1`, [uname]);
  const u = rows[0];
  const fail = { ok: false, error: 'Username or password is wrong.' };
  if (!u) { await bcrypt.compare(String(password || ''), dummy()); return fail; }
  if (u.disabled || u.emp_status === 'Exited') return { ok: false, error: 'This login is switched off. Ask the Admin.' };
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(u.locked_until) - new Date()) / 60000);
    return { ok: false, error: `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask the Admin to reset your password.` };
  }
  if (!(await verify(String(password || ''), u.password_hash))) {
    const failed = u.failed + 1;
    if (failed >= MAX_FAILED) {
      await q(`update od_users set failed=0, locked_until=now()+interval '${LOCK_MINUTES} minutes' where id=$1`, [u.id]);
      return { ok: false, error: `Too many wrong attempts. This login is locked for ${LOCK_MINUTES} minutes.` };
    }
    await q(`update od_users set failed=$2 where id=$1`, [u.id, failed]);
    return fail;
  }
  await q(`update od_users set failed=0, locked_until=null, last_login=now() where id=$1`, [u.id]);
  return { ok: true, user: u };
}

export function suggestUsername(name, taken) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  let base = (words.find(w => w.length >= 3 && !/^[A-Z]{1,3}$/.test(w)) || words[0] || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (base.length > 10 && base.startsWith('jothi')) base = 'jothi';
  let u = base, n = 2;
  while (taken.has(u)) u = base + n++;
  taken.add(u);
  return u;
}

export function defaultPassword(name) {
  const w = String(name || '').trim().split(/\s+/).find(x => x.length >= 3 && !/^[A-Z]{1,3}$/.test(x)) || 'Welcome';
  const first = w.replace(/[^a-zA-Z]/g, '') || 'Welcome';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() + '@123';
}
