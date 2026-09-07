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
const OVERLAY_PREVIEW_PATH = path.join(APP, 'overlay-preview.html');
const OVERLAY_LIVE_PATH = path.join(APP, 'overlay-live.html');
const PRESETS_DIR = path.join(APP, 'presets');
const VIEWER_PATH = path.join(APP, 'viewer.html');
const MANAGER_PATH = path.join(APP, 'manager.html');
const MANAGER_JS_PATH = path.join(APP, 'manager.js');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// POST /save-preview and POST /golive write the real overlay files, so back
// them up and restore them.
const originalPreview = fs.readFileSync(OVERLAY_PREVIEW_PATH, 'utf8');
const originalLive = fs.readFileSync(OVERLAY_LIVE_PATH, 'utf8');
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
    fs.writeFileSync(OVERLAY_PREVIEW_PATH, originalPreview);
    fs.writeFileSync(OVERLAY_LIVE_PATH, originalLive);
    // Preset tests write into the real presets dir; sweep up anything left.
    for (const entry of fs.readdirSync(PRESETS_DIR)) {
      if (entry.endsWith('.md')) fs.unlinkSync(path.join(PRESETS_DIR, entry));
    }
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

    it('GET /manager.js serves manager.js', async () => {
      const res = await fetch(`${BASE}/manager.js`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/javascript');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(MANAGER_JS_PATH));
    });

    it('GET /components/manifest.json serves the manifest as JSON', async () => {
      const res = await fetch(`${BASE}/components/manifest.json`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/json');
      const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'components', 'manifest.json'), 'utf8'));
      assert.deepEqual(await res.json(), manifest);
    });

    it('GET /components/<file> serves component templates', async () => {
      const res = await fetch(`${BASE}/components/messe-sjb-date.html`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html');
      assert.deepEqual(
        Buffer.from(await res.arrayBuffer()),
        fs.readFileSync(path.join(APP, 'components', 'messe-sjb-date.html'))
      );
    });

    it('refuses component paths that escape the components dir', async () => {
      const res = await fetch(`${BASE}/components/..%2Fserver.js`);
      assert.equal(res.status, 404);
    });

    it('GET /overlay-preview.html serves the current overlay-preview.html', async () => {
      const res = await fetch(`${BASE}/overlay-preview.html`);
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(OVERLAY_PREVIEW_PATH));
    });

    it('GET /overlay-live.html serves the current overlay-live.html', async () => {
      const res = await fetch(`${BASE}/overlay-live.html`);
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(OVERLAY_LIVE_PATH));
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

  describe('POST /save-preview', () => {
    it('rejects invalid JSON with 400', async () => {
      const res = await fetch(`${BASE}/save-preview`, { method: 'POST', body: '{nope' });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Invalid JSON');
    });

    it('rejects a body without an html field with 400', async () => {
      const res = await fetch(`${BASE}/save-preview`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Missing "html" field');
    });

    it('rejects a non-string html field with 400', async () => {
      const res = await fetch(`${BASE}/save-preview`, {
        method: 'POST',
        body: JSON.stringify({ html: 42 }),
      });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Missing "html" field');
    });

    it('writes valid html to disk and returns ok', async () => {
      const html = '<h1>saved by test</h1>';
      const res = await fetch(`${BASE}/save-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(fs.readFileSync(OVERLAY_PREVIEW_PATH, 'utf8'), html);

      const served = await fetch(`${BASE}/overlay-preview.html`);
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
          socket.write('POST /save-preview HTTP/1.1\r\nHost: t\r\nContent-Length: 1100000\r\n\r\n');
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

  describe('POST /golive', () => {
    it('copies the preview overlay into the live overlay and returns ok', async () => {
      const html = '<h1>going live</h1>';
      await fetch(`${BASE}/save-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      });

      const res = await fetch(`${BASE}/golive`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });

      assert.equal(fs.readFileSync(OVERLAY_LIVE_PATH, 'utf8'), html);
      const served = await fetch(`${BASE}/overlay-live.html`);
      assert.equal(await served.text(), html);
    });

    it('pushes a reload frame to a connected viewer', async () => {
      const { socket, rest } = await wsConnect(port);
      try {
        const golivePromise = fetch(`${BASE}/golive`, { method: 'POST' });
        const frames = await readFrames(socket, 1, rest);
        assert.equal(frames.length, 1);
        assert.deepEqual(frames[0], RELOAD_FRAME);
        const res = await golivePromise;
        assert.equal(res.status, 200);
      } finally {
        socket.destroy();
      }
    });

    it('pushes a reload frame to every connected viewer', async () => {
      const clients = await Promise.all([wsConnect(port), wsConnect(port)]);
      try {
        const golivePromise = fetch(`${BASE}/golive`, { method: 'POST' });
        const [framesA, framesB] = await Promise.all([
          readFrames(clients[0].socket, 1, clients[0].rest),
          readFrames(clients[1].socket, 1, clients[1].rest),
        ]);
        assert.deepEqual(framesA[0], RELOAD_FRAME);
        assert.deepEqual(framesB[0], RELOAD_FRAME);
        const res = await golivePromise;
        assert.equal(res.status, 200);
      } finally {
        for (const c of clients) c.socket.destroy();
      }
    });
  });

  describe('presets', () => {
    const NAME = 'Lyrics of Song ABC';
    const HTML = '<p>la la &lt;b&gt; "quotes" é</p>';
    let slug;

    it('POST /presets writes a markdown file and returns the slug', async () => {
      const res = await fetch(`${BASE}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, html: HTML }),
      });
      assert.equal(res.status, 200);
      const saved = await res.json();
      assert.equal(saved.slug, 'lyrics-of-song-abc');
      assert.equal(saved.name, NAME);
      assert.match(saved.created, /^\d{4}-\d{2}-\d{2}T/);
      slug = saved.slug;

      const raw = fs.readFileSync(path.join(PRESETS_DIR, `${saved.slug}.md`), 'utf8');
      assert.ok(raw.startsWith(`---\nname: ${NAME}\ncreated: `));
    });

    it('GET /presets lists the saved preset', async () => {
      const res = await fetch(`${BASE}/presets`);
      assert.equal(res.status, 200);
      const { presets } = await res.json();
      assert.ok(presets.some((p) => p.slug === slug && p.name === NAME));
    });

    it('GET /presets/:slug returns the preset with its html intact', async () => {
      const res = await fetch(`${BASE}/presets/${slug}`);
      assert.equal(res.status, 200);
      const preset = await res.json();
      assert.equal(preset.name, NAME);
      assert.equal(preset.html, HTML);
      assert.match(preset.created, /^\d{4}-\d{2}-\d{2}T/);
    });

    it('suffixes the slug when the same name is saved again', async () => {
      const res = await fetch(`${BASE}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, html: '<p>again</p>' }),
      });
      assert.equal(res.status, 200);
      const saved = await res.json();
      assert.equal(saved.slug, `${slug}-2`);
    });

    it('rejects invalid JSON with 400', async () => {
      const res = await fetch(`${BASE}/presets`, { method: 'POST', body: '{nope' });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Invalid JSON');
    });

    it('rejects a missing name with 400', async () => {
      const res = await fetch(`${BASE}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: '<p>x</p>' }),
      });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Missing "name" field');
    });

    it('rejects a blank name with 400', async () => {
      const res = await fetch(`${BASE}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ', html: '<p>x</p>' }),
      });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Missing "name" field');
    });

    it('rejects a missing html field with 400', async () => {
      const res = await fetch(`${BASE}/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Missing "html" field');
    });

    it('GET /presets/:slug returns 404 for unknown and unsafe slugs', async () => {
      assert.equal((await fetch(`${BASE}/presets/unknown`)).status, 404);
      assert.equal((await fetch(`${BASE}/presets/..%2F..%2Fserver.js`)).status, 404);
    });

    it('DELETE /presets/:slug removes the file', async () => {
      const res = await fetch(`${BASE}/presets/${slug}`, { method: 'DELETE' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal((await fetch(`${BASE}/presets/${slug}`)).status, 404);
      assert.equal((await fetch(`${BASE}/presets/${slug}`, { method: 'DELETE' })).status, 404);
      assert.equal(fs.existsSync(path.join(PRESETS_DIR, `${slug}.md`)), false);
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
        const savePromise = fetch(`${BASE}/save-preview`, {
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

    it('keeps saving after a viewer disconnects abruptly', async () => {
      const { socket } = await wsConnect(port);
      socket.destroy();
      await delay(50); // let the server notice the close and drop the client
      const res = await fetch(`${BASE}/save-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: '<p>after disconnect</p>' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(
        fs.readFileSync(OVERLAY_PREVIEW_PATH, 'utf8'),
        '<p>after disconnect</p>'
      );
    });
  });
});
