// End-to-end API tests against a running server (BASE_URL) with an EMPTY database.
// Covers setup, logins, lockout, forced password change, what each role can see, and
// which changes are refused. Usage: BASE_URL=http://localhost:3911 SETUP_KEY=... node tests/api.test.js
import { readFile } from 'node:fs/promises';

const BASE = process.env.BASE_URL || 'http://localhost:3911';
const KEY = process.env.SETUP_KEY;
const backup = JSON.parse(await readFile(new URL('./prototype-backup.json', import.meta.url)));
const results = [];
const check = (area, name, ok, detail = '') => { results.push({ area, name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${area} | ${name}${detail && !ok ? ' | ' + detail : ''}`); };

class Client {
  constructor() { this.cookie = ''; }
  async call(path, { method, data, raw, type } = {}) {
    const r = await fetch(BASE + path, {
      method: method || (data !== undefined || raw ? 'POST' : 'GET'),
      headers: { ...(raw ? { 'content-type': type } : { 'content-type': 'application/json' }), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: raw || (data !== undefined ? JSON.stringify(data) : undefined),
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc[0].split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  }
  login(u, p) { return this.call('/api/login', { data: { username: u, password: p } }); }
}

// ---------- setup ----------
const anon = new Client();
let r = await anon.call('/api/setup/status');
check('Setup', 'Fresh database asks for setup', r.body.needsSetup === true);
r = await anon.call('/api/setup/preview', { data: { setupKey: 'nope', backup } });
check('Setup', 'Wrong setup key is refused', r.status === 403);
r = await anon.call('/api/setup/preview', { data: { setupKey: KEY, backup } });
const logins = r.body.logins;
check('Setup', 'Suggested usernames + first passwords', logins && logins.find(l => l.username === 'gargi' && l.password === 'Gargi@123') && logins.find(l => l.username === 'jothi' && l.password === 'Jothi@123'), JSON.stringify(logins));
r = await anon.call('/api/setup', { data: { setupKey: KEY, backup, logins } });
check('Setup', 'Import backup and create 6 logins', r.status === 200 && r.body.created === 6, JSON.stringify(r.body));
r = await anon.call('/api/setup', { data: { setupKey: KEY, backup, logins } });
check('Setup', 'Setup cannot be run a second time', r.status === 409);
r = await anon.call('/api/data');
check('Security', 'Data needs a login', r.status === 401);

// ---------- login & password ----------
const admin = new Client();
r = await admin.login('jothi', 'wrong');
check('Login', 'Wrong password refused', r.status === 401);
r = await admin.login('JOTHI', 'Jothi@123');
check('Login', 'Username is not case-sensitive', r.status === 200 && r.body.user.mustChange === true);
r = await admin.call('/api/data');
check('Login', 'Must change first-time password before using the tool', r.status === 403);
r = await admin.call('/api/password', { data: { current: 'Jothi@123', next: 'jothi123' } });
check('Login', 'Password that is just the name is refused', r.status === 400);
r = await admin.call('/api/password', { data: { current: 'Jothi@123', next: 'short1' } });
check('Login', 'Password under 8 characters refused', r.status === 400);
r = await admin.call('/api/password', { data: { current: 'Jothi@123', next: 'Metaverse#2026' } });
check('Login', 'Change first-time password', r.status === 200);
r = await admin.call('/api/data');
check('Login', 'Admin can load data after changing password', r.status === 200);
const full = r.body.db;
const old = new Client(); r = await old.login('jothi', 'Jothi@123');
check('Login', 'Old first-time password no longer works', r.status === 401);

// lockout
const lk = new Client();
for (let i = 0; i < 5; i++) r = await lk.login('akash', 'bad-' + i);
check('Login', '5 wrong tries locks the login', /locked/i.test(r.body.error || ''), r.body.error);
r = await lk.login('akash', 'Akash@123');
check('Login', 'Correct password refused while locked', r.status === 401 && /Try again|locked/i.test(r.body.error));
r = await admin.call('/api/users', { data: { employeeId: 'G6', username: 'akash' } });
check('Login', 'Admin reset unlocks and gives a first-time password', r.status === 200 && r.body.password === 'Akash@123');
r = await lk.login('akash', 'Akash@123');
check('Login', 'Employee can sign in after reset', r.status === 200);

// ---------- what each role can see ----------
async function ready(u, p, np) { const c = new Client(); await c.login(u, p); await c.call('/api/password', { data: { current: p, next: np } }); return c; }
const ankit = await ready('ankit', 'Ankit@123', 'AnkitNew#2026');
const gargi = await ready('gargi', 'Gargi@123', 'GargiNew#2026');
const akash = lk; await akash.call('/api/password', { data: { current: 'Akash@123', next: 'AkashNew#2026' } });

for (const [name, c] of [['employee (ankit)', ankit], ['manager (gargi)', gargi]]) {
  r = await c.call('/api/data');
  const d = r.body.db, txt = JSON.stringify(d);
  check('Privacy', `${name}: pipeline, estimates, spendings not sent`, d.pipeline.length === 0 && d.estimates.length === 0 && d.expenses.length === 0);
  check('Privacy', `${name}: no project values, payments or invoices`, d.projects.every(p => p.value === 0 && p.schedule.length === 0 && p.receipts.length === 0) && !/"amount"/.test(JSON.stringify(d.projects)));
  check('Privacy', `${name}: rate card not sent`, Object.keys(d.rates || {}).length === 0);
  const others = d.employees.filter(e => e.id !== r.body.user.employeeId);
  check('Privacy', `${name}: other people’s salary, bank, PAN, Aadhaar, DOB, documents not sent`, others.every(e => !e.salary.basic && !e.bank.acct && !e.pan && !e.aadhaar && !e.dob && !e.docs));
  check('Privacy', `${name}: no known deal value appears anywhere`, !txt.includes('2100000') && !txt.includes('1652590') && !txt.includes('268750'));
}
r = await admin.call('/api/data');
check('Privacy', 'Admin receives full pipeline and project values', r.body.db.pipeline.length === full.pipeline.length && r.body.db.projects.some(p => p.value > 0));

// ---------- writes ----------
const write = (c, changes, singles = []) => c.call('/api/changes', { data: { changes, singles } });
const deal = full.pipeline.find(x => x.client === 'Extrutech');
r = await write(ankit, [{ c: 'pipeline', id: deal.id, op: 'upsert', d: { ...deal, value: 1 } }]);
check('Permissions', 'Employee cannot change pipeline', r.body.rejected.length === 1);
const proj = full.projects[0];
r = await write(gargi, [{ c: 'projects', id: proj.id, op: 'upsert', d: { ...proj, value: 1, schedule: [] } }]);
check('Permissions', 'Manager cannot change a project they don’t manage', r.body.rejected.length === 1);
r = await write(ankit, [], [{ k: 'payroll', d: {} }]);
check('Permissions', 'Employee cannot change payroll', r.body.rejected.length === 1);
const me = full.employees.find(e => e.id === 'G5');
r = await write(ankit, [{ c: 'employees', id: 'G5', op: 'upsert', d: { ...me, phone: '99999 11111', role: 'admin', salary: { basic: 999999, hra: 0, special: 0, other: 0 } } }]);
r = await admin.call('/api/data');
const meNow = r.body.db.employees.find(e => e.id === 'G5');
check('Permissions', 'Employee can update own phone, but not own role or salary', meNow.phone === '99999 11111' && meNow.role === 'employee' && meNow.salary.basic === me.salary.basic);
const task = { id: 'T-test1', projectId: null, title: 'Prepare demo', assignee: 'G5', status: 'To do', priority: 'Medium', start: '2026-10-18', due: '2026-10-25', estimate: 4, description: '', subtasks: [], completedOn: null, comments: [] };
r = await write(ankit, [{ c: 'tasks', id: task.id, op: 'upsert', d: task }]);
check('Permissions', 'Employee can add a task for themselves', r.body.rejected.length === 0);
r = await write(ankit, [{ c: 'tasks', id: 'T-test2', op: 'upsert', d: { ...task, id: 'T-test2', assignee: 'G6' } }]);
check('Permissions', 'Employee cannot assign a task to someone else', r.body.rejected.length === 1);
r = await write(ankit, [{ c: 'tasks', id: task.id, op: 'upsert', d: { ...task, status: 'In progress', due: '2027-01-01', assignee: 'G6' } }]);
r = await admin.call('/api/data'); const tNow = r.body.db.tasks.find(t => t.id === task.id);
check('Permissions', 'Employee can change status but not due date or assignee', tNow.status === 'In progress' && tNow.due === '2026-10-25' && tNow.assignee === 'G5');
r = await write(ankit, [{ c: 'tasks', id: task.id, op: 'delete' }]);
check('Permissions', 'Only Admin can delete tasks', r.body.rejected.length === 1);
r = await write(ankit, [{ c: 'logs', id: 'LG-1', op: 'upsert', d: { id: 'LG-1', e: 'G5', t: task.id, d: '2026-10-18', h: 3 } }, { c: 'logs', id: 'LG-2', op: 'upsert', d: { id: 'LG-2', e: 'G6', t: task.id, d: '2026-10-18', h: 3 } }]);
check('Permissions', 'Employee can log own hours, not someone else’s', r.body.rejected.length === 1 && r.body.rejected[0].id === 'LG-2');
const leave = { id: 'L-test', emp: 'G5', type: 'CL', from: '2026-10-28', to: '2026-10-28', days: 1, reason: 'Personal', status: 'Approved', applied: '2026-10-18' };
r = await write(ankit, [{ c: 'leaves', id: leave.id, op: 'upsert', d: leave }]);
check('Permissions', 'Employee cannot approve their own leave', r.body.rejected.length === 1);
r = await write(ankit, [{ c: 'leaves', id: leave.id, op: 'upsert', d: { ...leave, status: 'Pending' } }]);
check('Permissions', 'Employee can apply for leave', r.body.rejected.length === 0);
r = await write(akash, [{ c: 'leaves', id: leave.id, op: 'upsert', d: { ...leave, status: 'Approved' } }]);
check('Permissions', 'Another employee cannot approve it', r.body.rejected.length === 1);
r = await write(admin, [{ c: 'leaves', id: leave.id, op: 'upsert', d: { ...leave, status: 'Approved' } }]);
check('Permissions', 'Admin can approve it', r.body.rejected.length === 0);
r = await write(ankit, [{ c: 'events', id: 'EV1', op: 'upsert', d: { ...full.events[0], name: 'hacked' } }]);
check('Permissions', 'Employee cannot edit events', r.body.rejected.length === 1);
r = await write(gargi, [{ c: 'events', id: 'EV1', op: 'upsert', d: { ...full.events[0], status: 'Tentative' } }]);
check('Permissions', 'Manager can edit events', r.body.rejected.length === 0);

// ---------- documents ----------
const pdf = Buffer.from('%PDF-1.4\n% test\n');
r = await ankit.call('/api/files?emp=G5&type=pan&name=pan.pdf', { raw: pdf, type: 'application/pdf' });
check('Documents', 'Employee uploads own document', r.status === 200);
const docId = r.body.doc && r.body.doc.id;
r = await ankit.call('/api/files?emp=G6&type=pan&name=x.pdf', { raw: pdf, type: 'application/pdf' });
check('Documents', 'Employee cannot upload for someone else', r.status === 403);
r = await ankit.call('/api/files?emp=G5&type=pan&name=x.txt', { raw: Buffer.from('hi'), type: 'text/plain' });
check('Documents', 'Text file refused', r.status === 400);
r = await ankit.call('/api/files?emp=G5&type=pan&name=big.pdf', { raw: Buffer.alloc(4 * 1024 * 1024 + 10, 1), type: 'application/pdf' });
check('Documents', 'File over 4 MB refused', r.status === 413);
r = await akash.call('/api/files/' + docId);
check('Documents', 'Another employee cannot open it', r.status === 403);
r = await gargi.call('/api/files/' + docId);
check('Documents', 'A manager cannot open it', r.status === 403);
r = await admin.call('/api/files/' + docId);
check('Documents', 'Admin can open it', r.status === 200 && r.body.toString().startsWith('%PDF'));
r = await ankit.call('/api/data');
check('Documents', 'Upload appears on the employee’s document list', (r.body.db.employees.find(e => e.id === 'G5').docs || []).some(d => d.id === docId));
const docs = r.body.db.employees.find(e => e.id === 'G5').docs;
r = await write(ankit, [{ c: 'employees', id: 'G5', op: 'upsert', d: { ...r.body.db.employees.find(e => e.id === 'G5'), docs: docs.map(x => ({ ...x, verified: true })) } }]);
r = await admin.call('/api/data');
check('Documents', 'Employee cannot mark own document as verified', !r.body.db.employees.find(e => e.id === 'G5').docs.find(d => d.id === docId).verified);

// ---------- timesheets ----------
{
  const ist = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const dAdd = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const sheet = (e, d, lines) => ({ id: `TS-${e}-${d}`, e, d, at: new Date().toISOString(), slots: [
    { from: '10:00', to: '12:00', lines: lines[0] }, { from: '12:00', to: '14:00', lines: lines[1] }] });
  r = await admin.call('/api/data');
  const p3 = r.body.db.projects.find(p => p.id === 'P3qvs');
  r = await write(admin, [{ c: 'projects', id: p3.id, op: 'upsert', d: { ...p3, team: ['G5', 'G1'] } }]);
  check('Timesheet', 'Admin puts Ankit and Gargi on a project', r.status === 200 && !r.body.rejected.length);
  const mine = sheet('G5', ist, [[{ p: 'P3qvs', t: '', h: 2, w: 'Modelled the booth' }], [{ p: '@internal', t: '', h: 1, w: 'Internal tool fix' }, { p: 'P3qvs', t: '', h: 1, w: 'Client review' }]]);
  r = await write(ankit, [{ c: 'timesheets', id: mine.id, op: 'upsert', d: mine }]);
  check('Timesheet', 'Employee saves own timesheet for today', r.status === 200 && !r.body.rejected.length, JSON.stringify(r.body));
  r = await ankit.call('/api/data');
  check('Timesheet', 'It is stored on the server', (r.body.db.timesheets || []).some(x => x.id === mine.id && x.slots[0].lines[0].w === 'Modelled the booth'));
  const forAkash = sheet('G6', ist, [[{ p: '@idle', h: 2, w: 'x' }], []]);
  r = await write(ankit, [{ c: 'timesheets', id: forAkash.id, op: 'upsert', d: forAkash }]);
  check('Timesheet', 'Cannot fill in someone else’s timesheet', r.body.rejected.length === 1);
  const bad = { ...mine, id: 'TS-G5-x' };
  r = await write(ankit, [{ c: 'timesheets', id: bad.id, op: 'upsert', d: bad }]);
  check('Timesheet', 'Record id must match person and date', r.body.rejected.length === 1);
  const oldDay = sheet('G5', dAdd(ist, -20), [[{ p: 'P3qvs', h: 2, w: 'old' }], []]);
  r = await write(ankit, [{ c: 'timesheets', id: oldDay.id, op: 'upsert', d: oldDay }]);
  check('Timesheet', 'Days older than the edit window are locked', r.body.rejected.length === 1 && /7 days/.test(r.body.rejected[0].why), JSON.stringify(r.body.rejected));
  const future = sheet('G5', dAdd(ist, 3), [[{ p: 'P3qvs', h: 2, w: 'future' }], []]);
  r = await write(ankit, [{ c: 'timesheets', id: future.id, op: 'upsert', d: future }]);
  check('Timesheet', 'Future days are refused', r.body.rejected.length === 1);
  const junk = { ...sheet('G5', dAdd(ist, -1), [[], []]), slots: 'nope' };
  r = await write(ankit, [{ c: 'timesheets', id: junk.id, op: 'upsert', d: junk }]);
  check('Timesheet', 'Malformed timesheet is refused', r.body.rejected.length === 1);
  r = await write(ankit, [], [{ k: 'tsconfig', d: { slots: [{ from: '09:00', to: '18:00' }], editDays: 365 } }]);
  check('Timesheet', 'Employee cannot change the slots or edit window', r.body.rejected.length === 1);
  r = await akash.call('/api/data');
  check('Timesheet', 'Another employee does not see it', !(r.body.db.timesheets || []).some(x => x.e === 'G5'));
  r = await gargi.call('/api/data');
  const g = (r.body.db.timesheets || []).find(x => x.e === 'G5');
  const gl = g ? g.slots.flatMap(s => s.lines) : [];
  check('Timesheet', 'Project colleague sees only the lines on their project', g && gl.length === 2 && gl.every(l => l.p === 'P3qvs'), JSON.stringify(gl));
  r = await admin.call('/api/data');
  check('Timesheet', 'Admin sees the whole sheet', (r.body.db.timesheets || []).find(x => x.id === mine.id).slots[1].lines.length === 2);
  r = await write(admin, [], [{ k: 'tsconfig', d: { slots: [{ from: '10:00', to: '12:00' }, { from: '12:00', to: '14:00' }], editDays: 30 } }]);
  r = await write(ankit, [{ c: 'timesheets', id: oldDay.id, op: 'upsert', d: oldDay }]);
  check('Timesheet', 'Admin widens the edit window; older day can now be saved', r.status === 200 && !r.body.rejected.length, JSON.stringify(r.body));
  r = await ankit.call('/api/data');
  check('Timesheet', 'Employees receive the slot settings', r.body.db.tsconfig && r.body.db.tsconfig.editDays === 30);
  r = await write(ankit, [{ c: 'timesheets', id: oldDay.id, op: 'delete' }]);
  check('Timesheet', 'Employee can delete own sheet inside the window', r.status === 200 && !r.body.rejected.length);
  const fixed = sheet('G6', dAdd(ist, -40), [[{ p: '@internal', h: 2, w: 'Corrected by Admin' }], []]);
  r = await write(admin, [{ c: 'timesheets', id: fixed.id, op: 'upsert', d: fixed }]);
  check('Timesheet', 'Admin can correct anyone’s older sheet', r.status === 200 && !r.body.rejected.length);
  r = await admin.call('/api/backup');
  check('Timesheet', 'Timesheets are in the backup', (r.body.db.timesheets || []).length >= 2);
}

// ---------- admin tools ----------
r = await ankit.call('/api/backup');
check('Admin', 'Employee cannot download a backup', r.status === 403);
r = await admin.call('/api/backup');
check('Admin', 'Admin downloads a full backup', r.status === 200 && r.body.db.pipeline.length === full.pipeline.length);
const bk = r.body;
r = await admin.call('/api/audit');
check('Admin', 'Activity log records changes', r.body.entries.some(e => e.action === 'upload') && r.body.entries.some(e => e.coll === 'leaves'));
r = await admin.call('/api/users/disable', { data: { employeeId: 'G6', disabled: true } });
r = await akash.call('/api/data');
check('Admin', 'Switching off a login ends that person’s session', r.status === 401);
r = await admin.call('/api/users/disable', { data: { employeeId: 'G6', disabled: false } });
r = await admin.call('/api/restore', { data: { backup: bk } });
check('Admin', 'Restore from backup', r.status === 200);
r = await admin.call('/api/restore', { data: { backup: { db: { employees: [{ id: 'X', role: 'admin' }] } } } });
check('Admin', 'Restore that would lock out the Admin is refused', r.status === 400);

const failed = results.filter(x => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
