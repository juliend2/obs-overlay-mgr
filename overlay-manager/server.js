#!/usr/bin/env node
// Zero-dependency HTTP + WebSocket server: serves the viewer and manager
// pages, and pushes a "reload" message to viewers whenever /save writes a
// new overlay.html. WebSocket is hand-rolled (handshake + outgoing framing
// only) to avoid an npm dependency for a two-message protocol.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8081;
const DIR = __dirname;
const OVERLAY_PATH = path.join(DIR, 'overlay.html');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const clients = new Set();

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcastReload() {
  const frame = encodeFrame('reload');
  for (const socket of clients) {
    socket.write(frame, (err) => { if (err) clients.delete(socket); });
  }
}

function serveFile(res, filePath, contentType, method = 'GET') {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (isRead && pathname === '/') {
    return serveFile(res, path.join(DIR, 'viewer.html'), 'text/html', req.method);
  }
  if (isRead && pathname === '/manager') {
    return serveFile(res, path.join(DIR, 'manager.html'), 'text/html', req.method);
  }
  if (isRead && pathname === '/overlay.html') {
    return serveFile(res, OVERLAY_PATH, 'text/html', req.method);
  }
  if (req.method === 'POST' && pathname === '/save') {
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
      if (typeof parsed.html !== 'string') {
        res.writeHead(400);
        res.end('Missing "html" field');
        return;
      }
      fs.writeFile(OVERLAY_PATH, parsed.html, (err) => {
        if (err) {
          res.writeHead(500);
          res.end('Write failed');
          return;
        }
        broadcastReload();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
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
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

server.listen(PORT, () => {
  console.log(`overlay-manager listening on http://127.0.0.1:${PORT}`);
  console.log(`  viewer:  http://127.0.0.1:${PORT}/         (put this in OBS Browser Source)`);
  console.log(`  manager: http://127.0.0.1:${PORT}/manager   (edit the overlay here)`);
});
