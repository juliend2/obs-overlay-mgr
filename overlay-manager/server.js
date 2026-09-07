#!/usr/bin/env node
// Zero-dependency HTTP + WebSocket server: serves the viewer and manager
// pages, component templates and presets, and pushes a "reload" message to
// viewers whenever the overlay on disk changes — /save-preview writes a new
// overlay-preview.html, and /golive publishes that preview into
// overlay-live.html (what viewers actually show). WebSocket is hand-rolled
// (handshake + outgoing framing only) to avoid an npm dependency for a
// two-message protocol.

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import * as ws from './websocket.js'
import * as web from './web.js'
import * as presets from './presets.js'

const PORT = process.env.PORT || 8081;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = path.join(DIR, 'components');
const PRESETS_DIR = path.join(DIR, 'presets');
const OVERLAY_PREVIEW_PATH = path.join(DIR, 'overlay-preview.html');
const OVERLAY_LIVE_PATH = path.join(DIR, 'overlay-live.html');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const clients = new Set();

// Collects a JSON request body (capped at 1MB, connection destroyed beyond
// that) and hands the parsed object to `handle`.
function readJsonBody(req, res, handle) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }
    handle(parsed);
  });
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead && pathname === '/') {
    return web.serveFile(res, path.join(DIR, 'viewer.html'), 'text/html', req.method);
  }
  if (isRead && pathname === '/test') {
    return web.serveFile(res, path.join(DIR, 'components/messe-sjb-date.html'), 'text/html', req.method);
  }
  if (isRead && pathname === '/manager') {
    return web.serveFile(res, path.join(DIR, 'manager.html'), 'text/html', req.method);
  }
  if (isRead && pathname === '/manager.js') {
    return web.serveFile(res, path.join(DIR, 'manager.js'), 'text/javascript', req.method);
  }
  if (isRead && pathname.startsWith('/components/')) {
    // Serve component templates, but only from inside components/ — resolve
    // the path and refuse anything that escapes the directory.
    let filePath;
    try {
      filePath = path.resolve(COMPONENTS_DIR, decodeURIComponent(pathname.slice('/components/'.length)));
    } catch {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (filePath !== COMPONENTS_DIR && !filePath.startsWith(COMPONENTS_DIR + path.sep)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const type = filePath.endsWith('.json') ? 'application/json' : 'text/html';
    return web.serveFile(res, filePath, type, req.method);
  }
  if (isRead && pathname === '/overlay-preview.html') {
    return web.serveFile(res, OVERLAY_PREVIEW_PATH, 'text/html', req.method);
  }
  if (isRead && pathname === '/overlay-live.html') {
    return web.serveFile(res, OVERLAY_LIVE_PATH, 'text/html', req.method);
  }
  if (req.method === 'POST' && pathname === '/golive') {
    // Publish: copy the staged preview over the live overlay, then push a
    // reload so viewers swap the new content in without a full-page refresh.
    fs.readFile(OVERLAY_PREVIEW_PATH, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500);
        res.end('Read failed');
        return;
      }
      fs.writeFile(OVERLAY_LIVE_PATH, html, (err) => {
        if (err) {
          res.writeHead(500);
          res.end('Write failed');
          return;
        }
        ws.broadcastReload(clients);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/save-preview') {
    return readJsonBody(req, res, (parsed) => {
      if (typeof parsed.html !== 'string') {
        res.writeHead(400);
        res.end('Missing "html" field');
        return;
      }
      fs.writeFile(OVERLAY_PREVIEW_PATH, parsed.html, (err) => {
        if (err) {
          res.writeHead(500);
          res.end('Write failed');
          return;
        }
        ws.broadcastReload(clients);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  }
  if (pathname === '/presets' && isRead) {
    try {
      const list = await presets.listPresets(PRESETS_DIR);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ presets: list }));
    } catch {
      res.writeHead(500);
      res.end('List failed');
    }
    return;
  }
  if (req.method === 'POST' && pathname === '/presets') {
    return readJsonBody(req, res, async (parsed) => {
      if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
        res.writeHead(400);
        res.end('Missing "name" field');
        return;
      }
      if (typeof parsed.html !== 'string') {
        res.writeHead(400);
        res.end('Missing "html" field');
        return;
      }
      try {
        const saved = await presets.writePreset(PRESETS_DIR, parsed.name.trim(), parsed.html);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...saved }));
      } catch {
        res.writeHead(500);
        res.end('Write failed');
      }
    });
  }
  let presetMatch;
  if ((presetMatch = pathname.match(/^\/presets\/([^/]+)$/))) {
    let slug;
    try {
      slug = decodeURIComponent(presetMatch[1]);
    } catch {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (req.method === 'GET') {
      const preset = await presets.readPreset(PRESETS_DIR, slug);
      if (!preset) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, ...preset }));
      return;
    }
    if (req.method === 'DELETE') {
      const deleted = await presets.deletePreset(PRESETS_DIR, slug);
      res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: deleted }));
      return;
    }
  }
  res.writeHead(404);
  res.end('Not found');
});

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || req.headers['upgrade']?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  clients.add(socket);
  // Viewers never send us anything meaningful (no client->server messages
  // in this protocol), so incoming frames are just drained and ignored.
  socket.on('data', () => {});
  // http.Server leaves hijacked upgrade sockets half-open (allowHalfOpen),
  // so a client's FIN only emits 'end' — destroy here so 'close' fires and
  // dead viewers don't linger in the clients set.
  socket.on('end', () => socket.destroy());
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => {
    clients.delete(socket);
    socket.destroy();
  });
});

// Only auto-start when executed directly (`node server.js` / start.sh);
// importing this module (e.g. from tests) starts nothing.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(PORT, () => {
    console.log(`overlay-manager listening on http://127.0.0.1:${PORT}`);
    console.log(`  viewer:  http://127.0.0.1:${PORT}/         (put this in OBS Browser Source)`);
    console.log(`  manager: http://127.0.0.1:${PORT}/manager  (edit the overlay here)`);
  });
}
