// Plain Node server for OVH / Docker / local use. Serves the app from ./public and
// the API from src/api.js. No framework needed.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, snapshot } from './src/api.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = +process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const SEC = { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };

http.createServer(async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const url = new URL(req.url, `${proto}://${host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      if (body && body.length > 6 * 1024 * 1024) { res.writeHead(413); return res.end('Too large'); }
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
      const headers = Object.fromEntries(r.headers.entries());
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) headers['set-cookie'] = sc;
      res.writeHead(r.status, { ...SEC, ...headers });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try { if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html'); } catch { file = path.join(ROOT, 'index.html'); }
    const data = await readFile(file);
    res.writeHead(200, { ...SEC, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  } catch (e) {
    console.error(e); res.writeHead(500); res.end('Server error');
  }
}).listen(PORT, () => console.log(`OfficeDesk running on http://localhost:${PORT}`));

// Nightly copy when running on your own server (Netlify uses its scheduled function instead).
if (process.env.NIGHTLY_BACKUP !== 'off') {
  const day = 24 * 3600 * 1000;
  setInterval(() => snapshot('nightly').catch(e => console.error('backup failed', e)), day);
}
