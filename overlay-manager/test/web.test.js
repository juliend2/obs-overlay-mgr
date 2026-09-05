import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { serveFile } from '../web.js';

// serveFile is exercised against a real http.Server and real
// ServerResponse objects — no fakes.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-mgr-test-'));
const existingFile = path.join(tmpDir, 'exists.txt');
fs.writeFileSync(existingFile, 'hello from disk');

const servers = [];
function start(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
after(() => {
  for (const server of servers) server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('serveFile', () => {
  it('serves an existing file with 200, content type and no-store', async () => {
    const port = await start((req, res) =>
      serveFile(res, existingFile, 'text/plain', 'GET')
    );
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), 'hello from disk');
  });

  it('defaults the method to GET', async () => {
    const port = await start((req, res) =>
      serveFile(res, existingFile, 'text/plain')
    );
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello from disk');
  });

  it('responds 404 for a missing file', async () => {
    const port = await start((req, res) =>
      serveFile(res, path.join(tmpDir, 'nope.txt'), 'text/plain', 'GET')
    );
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Not found');
  });

  it('sends headers but no body for HEAD', async () => {
    const port = await start((req, res) =>
      serveFile(res, existingFile, 'text/plain', req.method)
    );
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), '');
  });
});
