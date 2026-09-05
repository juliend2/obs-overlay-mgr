import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../server.js';

// Black-box integration tests for server.js: real HTTP via fetch, and a
// real raw TCP client speaking the WebSocket handshake by hand. No mocks.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.dirname(HERE);
const OVERLAY_PATH = path.join(APP, 'overlay.html');
const VIEWER_PATH = path.join(APP, 'viewer.html');
const MANAGER_PATH = path.join(APP, 'manager.html');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// POST /save writes the real overlay.html, so back it up and restore it.
const originalOverlay = fs.readFileSync(OVERLAY_PATH, 'utf8');
const viewerHtml = fs.readFileSync(VIEWER_PATH);
const managerHtml = fs.readFileSync(MANAGER_PATH);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raw TCP WebSocket client: performs the handshake and resolves with the
// socket plus the raw response head. Frames are read off the socket as bytes.
function wsConnect(port, reqPath = '/ws') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let settled = false;

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(err);
      }
    });
    socket.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error('connection closed before handshake completed'));
      }
    });
    socket.on('connect', () => {
      socket.write(
        `GET ${reqPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1 || settled) return;
      settled = true;
      socket.removeAllListeners('close');
      resolve({
        socket,
        key,
        head: buf.subarray(0, idx).toString(),
        rest: buf.subarray(idx + 4),
      });
    });
  });
}

// Collects n unmasked server frames ('reload' payloads are always < 126
// bytes, so the 2-byte header form is the only one the server can emit here).
function readFrames(socket, n, initial = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buf = initial;
    const frames = [];
    const timer = setTimeout(() => {
      socket.off('data', onData);
      reject(new Error(`timed out waiting for ${n} frame(s), got ${frames.length}`));
    }, 2000);
    function onData(data) {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 2) {
        const total = 2 + (buf[1] & 0x7f);
        if (buf.length < total) break;
        frames.push(buf.subarray(0, total));
        buf = buf.subarray(total);
        if (frames.length === n) {
          clearTimeout(timer);
          socket.off('data', onData);
          resolve(frames);
          return;
        }
      }
    }
    socket.on('data', onData);
  });
}

const RELOAD_FRAME = Buffer.concat([Buffer.from([0x81, 0x06]), Buffer.from('reload')]);

let port;
let BASE;

describe('server integration', () => {
  before(async () => {
    port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  });

  after(async () => {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.writeFileSync(OVERLAY_PATH, originalOverlay);
  });

  describe('static files', () => {
    it('GET / serves viewer.html', async () => {
      const res = await fetch(`${BASE}/`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), viewerHtml);
    });

    it('GET /manager serves manager.html', async () => {
      const res = await fetch(`${BASE}/manager`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), managerHtml);
    });

    it('GET /overlay.html serves the current overlay.html', async () => {
      const res = await fetch(`${BASE}/overlay.html`);
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(OVERLAY_PATH));
    });

    it('GET on an unknown path returns 404', async () => {
      const res = await fetch(`${BASE}/nope`);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), 'Not found');
    });

    it('HEAD / returns headers with an empty body', async () => {
      const res = await fetch(`${BASE}/`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html');
      assert.equal(await res.text(), '');
    });
  });

  describe('POST /save', () => {
    it('rejects invalid JSON with 400', async () => {
      const res = await fetch(`${BASE}/save`, { method: 'POST', body: '{nope' });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Invalid JSON');
    });

    it('rejects a body without an html field with 400', async () => {
      const res = await fetch(`${BASE}/save`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Missing "html" field');
    });

    it('rejects a non-string html field with 400', async () => {
      const res = await fetch(`${BASE}/save`, {
        method: 'POST',
        body: JSON.stringify({ html: 42 }),
      });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Missing "html" field');
    });

    it('writes valid html to disk and returns ok', async () => {
      const html = '<h1>saved by test</h1>';
      const res = await fetch(`${BASE}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(fs.readFileSync(OVERLAY_PATH, 'utf8'), html);

      const served = await fetch(`${BASE}/overlay.html`);
      assert.equal(await served.text(), html);
    });

    it('destroys the connection for bodies over 1MB', async () => {
      // Raw socket for determinism: the server destroys mid-upload, so no
      // HTTP response must ever arrive.
      const gotResponse = await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let responded = false;
        const done = (fn) => {
          clearTimeout(timer);
          socket.destroy();
          fn();
        };
        const timer = setTimeout(() => done(() => reject(new Error('timeout'))), 3000);
        socket.on('connect', () => {
          socket.write('POST /save HTTP/1.1\r\nHost: t\r\nContent-Length: 1100000\r\n\r\n');
          socket.write('x'.repeat(600000));
          socket.write('x'.repeat(500000));
        });
        socket.on('data', () => { responded = true; });
        socket.on('error', () => done(() => resolve(responded)));
        socket.on('close', () => done(() => resolve(responded)));
      });
      assert.equal(gotResponse, false);
    });
  });

  describe('websocket', () => {
    it('completes the handshake with a correct Sec-WebSocket-Accept', async () => {
      const { socket, key, head } = await wsConnect(port);
      try {
        const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        assert.ok(head.includes('101 Switching Protocols'), head);
        assert.ok(head.includes(`Sec-WebSocket-Accept: ${expected}`), head);
        assert.ok(head.includes('Upgrade: websocket'), head);
        assert.ok(head.includes('Connection: Upgrade'), head);
      } finally {
        socket.destroy();
      }
    });

    it('refuses upgrades to any path other than /ws', async () => {
      await assert.rejects(wsConnect(port, '/nope'));
    });

    it('pushes a reload frame to a connected viewer on save', async () => {
      const { socket, rest } = await wsConnect(port);
      try {
        const savePromise = fetch(`${BASE}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: '<p>push test</p>' }),
        });
        const frames = await readFrames(socket, 1, rest);
        assert.equal(frames.length, 1);
        assert.deepEqual(frames[0], RELOAD_FRAME);
        const res = await savePromise;
        assert.equal(res.status, 200);
      } finally {
        socket.destroy();
      }
    });

    it('pushes a reload frame to every connected viewer', async () => {
      const clients = await Promise.all([wsConnect(port), wsConnect(port)]);
      try {
        const savePromise = fetch(`${BASE}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: '<p>multi test</p>' }),
        });
        const [framesA, framesB] = await Promise.all([
          readFrames(clients[0].socket, 1, clients[0].rest),
          readFrames(clients[1].socket, 1, clients[1].rest),
        ]);
        assert.deepEqual(framesA[0], RELOAD_FRAME);
        assert.deepEqual(framesB[0], RELOAD_FRAME);
        const res = await savePromise;
        assert.equal(res.status, 200);
      } finally {
        for (const c of clients) c.socket.destroy();
      }
    });

    it('keeps saving after a viewer disconnects abruptly', async () => {
      const { socket } = await wsConnect(port);
      socket.destroy();
      await delay(50); // let the server notice the close and drop the client
      const res = await fetch(`${BASE}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: '<p>after disconnect</p>' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(
        fs.readFileSync(OVERLAY_PATH, 'utf8'),
        '<p>after disconnect</p>'
      );
    });
  });
});
