// Who can see what, and who can change what. Everything money-related is only ever
// sent to the Admin. Non-admin changes are checked record by record and field by field.

const ADMIN_ONLY_COLLECTIONS = new Set(['pipeline', 'estimates', 'expenses', 'clients_private']);
const MONEY_PROJECT_FIELDS = ['value', 'schedule', 'receipts', 'budget', 'estimateId', 'terms'];
const PRIVATE_EMPLOYEE_FIELDS = ['salary', 'bank', 'pan', 'aadhaar', 'address', 'dob', 'docs'];
const SELF_EDITABLE = ['phone', 'dob', 'address', 'pan', 'aadhaar', 'bank'];
const EMPLOYEE_TASK_FIELDS = ['status', 'completedOn', 'subtasks', 'comments'];

export const isAdmin = u => u && u.role === 'admin';

function ctx(user, db) {
  const me = user.employee_id;
  const emps = db.employees || [];
  const manager = user.role === 'manager';
  const reports = emps.filter(e => e.managerId === me).map(e => e.id);
  const scope = new Set(manager ? [me, ...reports] : [me]);
  const projects = (db.projects || []).filter(p => p.managerId === me || (p.team || []).includes(me));
  const projIds = new Set(projects.map(p => p.id));
  const managedIds = new Set(projects.filter(p => p.managerId === me).map(p => p.id));
  const taskVisible = t => manager ? (scope.has(t.assignee) || (t.projectId && projIds.has(t.projectId))) : t.assignee === me;
  return { me, manager, scope, projIds, managedIds, taskVisible };
}

const omit = (o, keys) => { const c = { ...o }; keys.forEach(k => delete c[k]); return c; };

// ---------- read filter ----------
export function viewFor(user, db) {
  if (isAdmin(user)) return db;
  const c = ctx(user, db);
  const v = {};
  for (const [k, val] of Object.entries(db)) {
    if (!Array.isArray(val)) v[k] = val;
  }
  delete v.rates; delete v.demo;
  v.rates = {};
  // payroll: only this person's own lines, for their own payslips
  v.payroll = {};
  for (const [m, run] of Object.entries(db.payroll || {})) {
    const adj = (run.adj || {})[c.me];
    v.payroll[m] = { status: run.status, paidOn: run.paidOn, adj: adj ? { [c.me]: adj } : {} };
  }
  v.designations = db.designations || [];
  v.holidays = db.holidays || [];
  v.events = db.events || [];
  v.clients = (db.clients || []).map(x => ({ id: x.id, name: x.name, contact: x.contact }));
  v.employees = (db.employees || []).map(e => {
    if (e.id === c.me) return e;
    const o = omit(e, PRIVATE_EMPLOYEE_FIELDS);
    if (!(c.manager && c.scope.has(e.id))) { delete o.leave; delete o.onboarding; }
    o.salary = { basic: 0, hra: 0, special: 0, other: 0 };
    o.bank = { name: '', acct: '', ifsc: '' };
    return o;
  });
  v.projects = (db.projects || []).filter(p => c.projIds.has(p.id))
    .map(p => ({ ...omit(p, MONEY_PROJECT_FIELDS), value: 0, schedule: [], receipts: [] }));
  v.tasks = (db.tasks || []).filter(c.taskVisible);
  const visibleTaskIds = new Set(v.tasks.map(t => t.id));
  v.logs = (db.logs || []).filter(l => c.scope.has(l.e) || visibleTaskIds.has(l.t));
  v.leaves = (db.leaves || []).filter(l => c.scope.has(l.emp));
  v.updates = (db.updates || []).filter(u => c.projIds.has(u.project) || u.emp === c.me);
  v.advances = (db.advances || []).filter(a => a.emp === c.me);
  v.pipeline = []; v.estimates = []; v.expenses = [];
  return v;
}

// ---------- write checks ----------
const pick = (o, keys) => { const r = {}; keys.forEach(k => { if (o && k in o) r[k] = o[k]; }); return r; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns { ok:true, data } (data = what to store) or { ok:false, why }.
export function checkChange(user, db, ch) {
  if (isAdmin(user)) return { ok: true, data: ch.d };
  const c = ctx(user, db);
  const list = db[ch.c] || [];
  const old = list.find(x => x.id === ch.id) || null;
  const no = why => ({ ok: false, why });
  const d = ch.d;
  switch (ch.c) {
    case 'tasks': {
      if (ch.op === 'delete') return no('Only the Admin can delete tasks.');
      if (!old) {
        if (!d || !(c.manager ? c.scope.has(d.assignee) || c.projIds.has(d.projectId) : d.assignee === c.me)) return no('You can only add tasks for yourself or your team.');
        if (d.projectId && !c.projIds.has(d.projectId)) return no('You are not on that project.');
        return { ok: true, data: d };
      }
      if (!c.taskVisible(old)) return no('That task is not yours.');
      if (c.manager) {
        if (!c.taskVisible(d)) return no('You can only assign tasks within your team or projects.');
        return { ok: true, data: d };
      }
      return { ok: true, data: { ...old, ...pick(d, EMPLOYEE_TASK_FIELDS) } };
    }
    case 'logs': {
      const rec = old || d;
      if (!rec || rec.e !== c.me || (d && d.e !== c.me)) return no('You can only log your own time.');
      return ch.op === 'delete' ? { ok: true } : { ok: true, data: d };
    }
    case 'updates': {
      if (ch.op === 'delete' || old) return no('Updates cannot be edited.');
      if (!d || d.emp !== c.me || !c.projIds.has(d.project)) return no('You can only post updates on your projects.');
      return { ok: true, data: d };
    }
    case 'leaves': {
      if (!old) {
        if (!d || d.emp !== c.me || d.status !== 'Pending') return no('You can only apply for your own leave.');
        return { ok: true, data: d };
      }
      if (ch.op === 'delete') {
        if (old.emp === c.me && old.status === 'Pending') return { ok: true };
        return no('Only pending requests can be cancelled.');
      }
      if (c.manager && c.scope.has(old.emp) && old.emp !== c.me && old.status === 'Pending' && ['Approved', 'Rejected'].includes(d.status)
        && same(omit(d, ['status']), omit(old, ['status']))) return { ok: true, data: { ...old, status: d.status } };
      return no('You cannot change this leave request.');
    }
    case 'employees': {
      if (!old || ch.op === 'delete') return no('Only the Admin can add or remove employees.');
      if (old.id === c.me) return { ok: true, data: { ...old, ...pick(d, SELF_EDITABLE) } };
      if (c.manager && c.scope.has(old.id)) return { ok: true, data: { ...old, ...pick(d, ['leave', 'onboarding']) } };
      return no('You cannot change this person’s details.');
    }
    case 'events': {
      if (!c.manager) return no('Only managers and the Admin can edit events.');
      if (ch.op === 'delete') return no('Only the Admin can delete events.');
      return { ok: true, data: d };
    }
    case 'projects': {
      if (!old || ch.op === 'delete') return no('Only the Admin can add or remove projects.');
      if (!c.managedIds.has(old.id)) return no('Only the project manager can change this project.');
      return { ok: true, data: { ...old, ...pick(d, ['status', 'milestones']) } };
    }
    default:
      return no('Only the Admin can change this.');
  }
}

export function checkSingle(user) {
  return isAdmin(user) ? { ok: true } : { ok: false, why: 'Only the Admin can change this.' };
}

export const ADMIN_ONLY = ADMIN_ONLY_COLLECTIONS;
