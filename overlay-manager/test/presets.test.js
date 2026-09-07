import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugify, listPresets, readPreset, writePreset, deletePreset } from '../presets.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-test-'));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('slugify', () => {
  it('lowercases and dashes', () => {
    assert.equal(slugify('Lyrics of Song ABC'), 'lyrics-of-song-abc');
  });

  it('strips accents', () => {
    assert.equal(slugify('Église Saint-Jean Baptiste'), 'eglise-saint-jean-baptiste');
  });

  it('falls back to "preset" when nothing usable remains', () => {
    assert.equal(slugify('???'), 'preset');
  });
});

describe('writePreset / readPreset round trip', () => {
  it('writes frontmatter to disk and reads the html back byte-for-byte', async () => {
    const html = `<b>& "quotes" 'apostrophes' é</b>\n<p>line1\nline2</p>`;
    const saved = await writePreset(tmpDir, 'Lyrics of Song ABC', html);

    assert.equal(saved.slug, 'lyrics-of-song-abc');
    assert.equal(saved.name, 'Lyrics of Song ABC');
    assert.match(saved.created, /^\d{4}-\d{2}-\d{2}T/);

    const raw = fs.readFileSync(path.join(tmpDir, `${saved.slug}.md`), 'utf8');
    assert.ok(raw.startsWith('---\nname: Lyrics of Song ABC\ncreated: '));
    assert.ok(raw.endsWith(`---\n${html}`));

    const read = await readPreset(tmpDir, saved.slug);
    assert.deepEqual(read, { name: 'Lyrics of Song ABC', created: saved.created, html });
  });

  it('suffixes the slug when the name is taken again', async () => {
    const dir = path.join(tmpDir, 'dedupe');
    const first = await writePreset(dir, 'Lyrics of Song ABC', '<p>a</p>');
    const second = await writePreset(dir, 'Lyrics of Song ABC', '<p>b</p>');
    assert.equal(first.slug, 'lyrics-of-song-abc');
    assert.equal(second.slug, 'lyrics-of-song-abc-2');
  });

  it('single-lines names that contain newlines', async () => {
    const saved = await writePreset(tmpDir, 'Two\nlines', '<p>x</p>');
    const raw = fs.readFileSync(path.join(tmpDir, `${saved.slug}.md`), 'utf8');
    assert.ok(raw.includes('name: Two lines'));
    const read = await readPreset(tmpDir, saved.slug);
    assert.equal(read.name, 'Two lines');
  });

  it('returns null for a missing preset', async () => {
    assert.equal(await readPreset(tmpDir, 'nope'), null);
  });
});

describe('listPresets', () => {
  it('returns [] for a missing directory', async () => {
    assert.deepEqual(await listPresets(path.join(tmpDir, 'does-not-exist')), []);
  });

  it('lists presets newest first and skips non-markdown files', async () => {
    const dir = path.join(tmpDir, 'list');
    await writePreset(dir, 'First', '<p>1</p>');
    await delay(10);
    await writePreset(dir, 'Second', '<p>2</p>');
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    fs.writeFileSync(path.join(dir, 'broken.md'), 'no frontmatter here');

    const list = await listPresets(dir);
    assert.deepEqual(
      list.map((p) => p.name),
      ['Second', 'First']
    );
    assert.deepEqual(
      list.map((p) => p.slug),
      ['second', 'first']
    );
  });
});

describe('deletePreset', () => {
  it('deletes an existing preset and returns true', async () => {
    const { slug } = await writePreset(tmpDir, 'Doomed', '<p>bye</p>');
    assert.equal(await deletePreset(tmpDir, slug), true);
    assert.equal(await readPreset(tmpDir, slug), null);
  });

  it('returns false for a missing preset', async () => {
    assert.equal(await deletePreset(tmpDir, 'nope'), false);
  });

  it('refuses slugs that would escape the directory', async () => {
    assert.equal(await readPreset(tmpDir, '../presets'), null);
    assert.equal(await deletePreset(tmpDir, '..'), false);
    assert.equal(await deletePreset(tmpDir, 'a/b'), false);
  });
});
