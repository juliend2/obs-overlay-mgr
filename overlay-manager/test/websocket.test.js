import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame } from '../websocket.js';

// Minimal real parser for server->client frames (unmasked, FIN + text).
function parseFrame(buf) {
  assert.equal(buf[0] & 0x80, 0x80, 'FIN bit must be set');
  assert.equal(buf[0] & 0x0f, 0x1, 'opcode must be text (1)');
  assert.equal(buf[1] & 0x80, 0x00, 'server->client frames must not be masked');
  const lenBits = buf[1] & 0x7f;
  let len;
  let offset;
  if (lenBits < 126) {
    len = lenBits;
    offset = 2;
  } else if (lenBits === 126) {
    len = buf.readUInt16BE(2);
    offset = 4;
  } else {
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  return {
    len,
    headerLen: offset,
    payload: buf.subarray(offset, offset + len),
    totalLen: offset + len,
  };
}

describe('encodeFrame', () => {
  it('encodes a small payload with a 2-byte header', () => {
    const frame = encodeFrame('reload');
    const parsed = parseFrame(frame);
    assert.equal(parsed.headerLen, 2);
    assert.equal(parsed.len, 6);
    assert.equal(frame.length, parsed.totalLen);
    assert.equal(parsed.payload.toString('utf8'), 'reload');
  });

  it('uses the 16-bit length form at the 126-byte boundary', () => {
    const frame = encodeFrame('a'.repeat(125));
    assert.equal(parseFrame(frame).headerLen, 2);

    const frame126 = encodeFrame('a'.repeat(126));
    const parsed = parseFrame(frame126);
    assert.equal(parsed.headerLen, 4);
    assert.equal(parsed.len, 126);
    assert.equal(parsed.payload.toString('utf8'), 'a'.repeat(126));
  });

  it('uses the 16-bit length form up to 65535 bytes', () => {
    const frame = encodeFrame('b'.repeat(65535));
    const parsed = parseFrame(frame);
    assert.equal(parsed.headerLen, 4);
    assert.equal(parsed.len, 65535);
    assert.equal(parsed.payload.toString('utf8'), 'b'.repeat(65535));
  });

  it('uses the 64-bit length form at the 65536-byte boundary', () => {
    const frame = encodeFrame('c'.repeat(65536));
    const parsed = parseFrame(frame);
    assert.equal(parsed.headerLen, 10);
    assert.equal(parsed.len, 65536);
    assert.equal(parsed.payload.toString('utf8'), 'c'.repeat(65536));
    assert.equal(frame.length, 10 + 65536);
  });

  it('measures length in bytes, so multibyte UTF-8 survives', () => {
    const str = 'hello ☂ — 你好';
    const frame = encodeFrame(str);
    const parsed = parseFrame(frame);
    assert.equal(parsed.len, Buffer.byteLength(str, 'utf8'));
    assert.equal(parsed.payload.toString('utf8'), str);
  });

  it('encodes an empty payload', () => {
    const frame = encodeFrame('');
    const parsed = parseFrame(frame);
    assert.equal(parsed.len, 0);
    assert.equal(frame.length, 2);
  });
});
