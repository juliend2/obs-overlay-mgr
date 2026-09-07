import fs from 'fs';
import path from 'path';

// Presets are markdown files with a minimal YAML frontmatter header:
//
//   ---
//   name: Lyrics of Song ABC
//   created: 2026-09-07T10:00:00.000Z
//   ---
//   <div class="wrapper">…rendered overlay HTML…</div>
//
// Only `name` and `created` are ever written, so a hand-rolled parser is
// enough — no YAML dependency. The body is the overlay HTML, stored and
// returned byte-for-byte.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name) {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents (é -> e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'preset';
}

function filePath(dir, slug) {
  return path.join(dir, `${slug}.md`);
}

function serialize(name, created, html) {
  // Frontmatter must stay single-line, so collapse any newlines in the name.
  const title = name.replace(/\s*\r?\n\s*/g, ' ');
  return `---\nname: ${title}\ncreated: ${created}\n---\n${html}`;
}

function parse(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { name: meta.name || 'Untitled', created: meta.created || '', html: match[2] };
}

export async function listPresets(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const presets = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const raw = await fs.promises.readFile(path.join(dir, entry), 'utf8');
    const parsed = parse(raw);
    if (parsed) {
      presets.push({ slug: entry.slice(0, -3), name: parsed.name, created: parsed.created });
    }
  }
  presets.sort((a, b) => (a.created < b.created ? 1 : -1)); // newest first
  return presets;
}

export async function readPreset(dir, slug) {
  if (!SLUG_RE.test(slug)) return null; // also blocks path traversal
  try {
    const raw = await fs.promises.readFile(filePath(dir, slug), 'utf8');
    return parse(raw);
  } catch {
    return null;
  }
}

export async function writePreset(dir, name, html) {
  await fs.promises.mkdir(dir, { recursive: true });
  const base = slugify(name);
  const taken = new Set(
    (await fs.promises.readdir(dir))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => entry.slice(0, -3))
  );
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  const created = new Date().toISOString();
  await fs.promises.writeFile(filePath(dir, slug), serialize(name, created, html));
  return { slug, name, created };
}

export async function deletePreset(dir, slug) {
  if (!SLUG_RE.test(slug)) return false; // also blocks path traversal
  try {
    await fs.promises.unlink(filePath(dir, slug));
    return true;
  } catch {
    return false;
  }
}
