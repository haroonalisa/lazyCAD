#!/usr/bin/env node
// LazyCAD live server: serves the browser app and keeps it in sync with a document file.
//   node server.mjs [--port 8777] [--doc models/current.cad.json]
// The CLI writes the document file → the server pushes it to every open tab (SSE).
// Edits made in the app are PUT back and saved to the same file.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('port', process.env.LAZYCAD_PORT || 8777));
const DOC = path.resolve(arg('doc', path.join(ROOT, 'models', 'current.cad.json')));

const EMPTY = { version: 1, units: 'mm', params: {}, features: [] };
if (!fs.existsSync(DOC)) { fs.mkdirSync(path.dirname(DOC), { recursive: true }); fs.writeFileSync(DOC, JSON.stringify(EMPTY, null, 2)); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };
const STATIC = [
  ['/node_modules/', path.join(ROOT, 'node_modules')],
  ['/core/', path.join(ROOT, 'core')],
  ['/examples/', path.join(ROOT, 'examples')],
  ['/', path.join(ROOT, 'app')],
];

const clients = new Set();
let lastContent = fs.readFileSync(DOC, 'utf8');
let version = 1;

function broadcast(msg, except) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) if (c.id !== except) c.res.write(data);
}

// Watch the document file for external changes (CLI builds, manual edits).
fs.watchFile(DOC, { interval: 250 }, () => {
  let txt;
  try { txt = fs.readFileSync(DOC, 'utf8'); } catch { return; }
  if (txt === lastContent) return;
  try { JSON.parse(txt); } catch { return; } // partially written
  lastContent = txt;
  version++;
  broadcast({ type: 'doc', version, source: 'file', doc: JSON.parse(txt) });
});

function serveStatic(req, res, urlPath) {
  for (const [prefix, dir] of STATIC) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir)) break;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
      return true;
    }
  }
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (p === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: 'lazycad', clients: clients.size, doc: DOC, version }));
    return;
  }
  if (p === '/api/doc' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Doc-Version': String(version) });
    res.end(lastContent);
    return;
  }
  if (p === '/api/doc' && req.method === 'PUT') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const doc = JSON.parse(body);
        const txt = JSON.stringify(doc, null, 2);
        lastContent = txt;
        version++;
        fs.writeFileSync(`${DOC}.tmp`, txt);
        fs.renameSync(`${DOC}.tmp`, DOC);
        broadcast({ type: 'doc', version, source: req.headers['x-client-id'] || 'app', doc }, req.headers['x-client-id']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const c = { id: url.searchParams.get('client') || String(Math.random()), res };
    clients.add(c);
    res.write(`data: ${JSON.stringify({ type: 'hello', version, doc: DOC })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(c); });
    return;
  }
  if (serveStatic(req, res, p)) return;
  res.writeHead(404); res.end('not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use — is LazyCAD already running? (curl localhost:${PORT}/api/health)`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, () => console.log(`LazyCAD running at http://localhost:${PORT}  (document: ${DOC})`));
