# OfficeDesk – Metaverse911

Projects, tasks, team reports, events, client pipeline, revenue forecast, cost estimates,
finance, payroll and payslips – with a separate login for every person.

- **Admin** sees everything. Money (pipeline, project values, payments, salaries, estimates,
  rate card) is only ever sent from the server to the Admin login.
- **Managers** see their team's projects, tasks, reports, leave and events.
- **Employees** see their own tasks, projects, timeline, leave, payslips and documents.

The app is a single page (`public/index.html`) plus a small API (`src/`). Data is stored in
PostgreSQL. It runs free on **Netlify + Supabase**, and moves unchanged to your own server
(OVH) with Docker.

---

## 1. Free setup: Supabase (database) + Netlify (website)

### Supabase – database (free plan, Mumbai)
1. Sign in at supabase.com → **New project**.
2. Name `officedesk`, click **Generate a password** and keep it safe, Region **South Asia (Mumbai)**, plan **Free**.
3. When the project is ready: **Connect** → **Connection string** → **Transaction pooler** (port **6543**).
   Copy it and replace `[YOUR-PASSWORD]` with the database password. This is your `DATABASE_URL`.

The app creates its own tables on first use. Nothing else to configure in Supabase.

> Free-plan notes: Supabase pauses a free project after 7 days with **no use**. Daily use keeps it
> awake; if it ever pauses, open the Supabase dashboard and click **Restore** – no data is lost.
> The free plan has no automatic backups, so the app keeps its own nightly copies (see Backups).

### Netlify – website + API (free plan)
1. Netlify → **Add new site** → **Import an existing project** → **GitHub** → choose this repository.
2. Build settings are read from `netlify.toml` – leave them as they are.
3. Before deploying, open **Site configuration → Environment variables** and add:

| Key | Value |
|---|---|
| `DATABASE_URL` | the Supabase transaction-pooler string from above |
| `SESSION_SECRET` | a long random string (at least 32 characters). Netlify can generate one, or use a password manager |
| `SETUP_KEY` | any one-time key you choose, e.g. `m911-setup-2026`. Used once for first-time setup |

4. **Deploy**. Your site will be at `https://<name>.netlify.app` (you can add your own domain later).

### First-time setup (once)
1. In the old prototype: **Settings → Download backup** (a `.json` file).
2. Open your new Netlify site. It shows **First-time setup**.
3. Enter the `SETUP_KEY`, choose the backup file, click **Check the file**.
4. Review the logins (username + first-time password, e.g. `gargi` / `Gargi@123`) and click
   **Import data and create logins**.
5. Share each first-time password privately. Everyone must choose their own password on first sign-in.

Setup can only run once (while there are no logins). After it's done you can delete the
`SETUP_KEY` variable in Netlify.

---

## 2. Logins and security
- Sign in with **username + password**. Usernames are not case-sensitive.
- First-time passwords must be replaced on first sign-in (min. 8 characters, letters + a number,
  not the person's name).
- 5 wrong passwords lock a login for 15 minutes. The Admin can reset any password
  (**Employees → person → Login → Reset password**), which also unlocks it.
- The Admin can switch a login off (ends that person's session immediately). Setting an
  employee's status to **Exited** also blocks their login.
- Passwords are stored as bcrypt hashes. Sessions are signed, HTTP-only cookies (7 days).
- Every change is checked on the server against the person's role, record by record:
  e.g. employees can update their own task status but not due dates; managers approve only
  their team's leave; only the Admin can touch pipeline, finance, payroll or projects' money.
- Documents (PAN, Aadhaar, offer letters…) are stored in the database and can only be opened
  by the Admin and the employee themselves. Max 4 MB per file (PDF/JPG/PNG/WEBP).
- **Settings → Activity log** shows who changed what.

## 3. Backups
- **Automatic:** a full copy every night (last 21 kept) – **Settings → Automatic backups**.
- **Manual:** **Settings → Download backup now** (a `.json` file – keep one weekly off-site).
- **Restore:** **Settings → Restore from a backup file** (a copy of current data is taken first).
- Logins and uploaded documents are not inside the `.json` backups; on your own server the
  nightly `pg_dump` (below) includes everything.

---

## 4. Moving to your own server (OVH) later
Requirements: a VPS with Docker (Ubuntu 22.04/24.04), a domain name pointing to it.

```bash
git clone <this repo> officedesk && cd officedesk
cp .env.example .env      # set POSTGRES_PASSWORD, SESSION_SECRET, SETUP_KEY
docker compose up -d      # app on 127.0.0.1:3000, PostgreSQL, nightly pg_dump to ./backups
```

Put HTTPS in front, e.g. with Caddy (`/etc/caddy/Caddyfile`):
```
office.metaverse911.rs {
  reverse_proxy 127.0.0.1:3000
}
```

**Moving the data from Supabase:**
```bash
pg_dump "<Supabase direct connection string, port 5432>" --no-owner --no-acl \
  -t 'od_*' > officedesk.sql
docker compose exec -T db psql -U officedesk officedesk < officedesk.sql
```
Logins, documents, backups and the activity log all move with this dump. Then point your
domain at the OVH server and remove the Netlify site.

Without Docker: install Node 20+ and PostgreSQL, set the same environment variables, run
`npm install --omit=dev && npm start`.

---

## 5. Development
```bash
npm install
cp .env.example .env   # point DATABASE_URL at a local PostgreSQL
node --env-file=.env server.js     # http://localhost:3000
```
API tests (need an empty database and a prototype backup at `tests/prototype-backup.json`,
which is git-ignored because it contains company data):
```bash
BASE_URL=http://localhost:3000 SETUP_KEY=... node tests/api.test.js
```

### Structure
```
public/index.html            the app (all screens)
src/api.js                   API routes
src/auth.js                  logins, password rules, lockout, sessions
src/policy.js                what each role can see and change
src/db.js                    PostgreSQL (tables are created automatically)
netlify/functions/api.mjs    Netlify adapter for the API
netlify/functions/nightly-backup.mjs   nightly copy on Netlify
server.js                    plain Node server for OVH / local
Dockerfile, docker-compose.yml        own-server setup
```
