// One-shot tool: extracts the song texts from a Wirecast document (messe.xml)
// and writes one overlay-manager preset per song — each preset is the
// lyrics.html component template filled with the song's lyrics, saved into
// overlay-manager/presets/ under the "Chants" category.
//
// Re-running only creates the presets that don't exist yet (songs removed
// from the document keep their preset, user-made presets are never touched);
// pass --force to refresh the matching preset files in place, keeping their
// original creation date. Duplicate song titles get the same -2/-3 slug
// suffixes the manager itself would produce.
//
// The XML is scanned without any dependency: Wirecast documents are
// machine-written, so a small tolerant tag scanner (entity decoding + open
// element stack) is enough to index what the extraction needs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify, readPreset, serialize } from '../overlay-manager/presets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = path.join(HERE, 'messe.xml');
const OUTPUT_PATH = path.join(HERE, 'messe.json');
const PRESETS_DIR = path.join(HERE, '..', 'overlay-manager', 'presets');
const LYRICS_TEMPLATE_PATH = path.join(HERE, '..', 'overlay-manager', 'components', 'lyrics.html');
const CATEGORY = 'Chants';
const FORCE = process.argv.includes('--force');

// --- Wirecast XML scanning ---

// One alternation for the whole tag stream: skipped blocks first, then real
// tags. Attribute values may contain ">" as long as they are quoted.
const TOKEN_RE = new RegExp([
  '<!--[\\s\\S]*?-->',
  '<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  '<\\?[\\s\\S]*?\\?>',
  '<![^>]*>',
  '<(\\/?)(([a-zA-Z_][\\w.:-]*)((?:"[^"]*"|\'[^\']*\'|[^"\'>])*))>',
].join('|'), 'g');

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? entity : String.fromCodePoint(code);
    }
    switch (body) {
      case 'quot': return '"';
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'apos': return "'";
      default: return entity;
    }
  });
}

function parseAttrs(raw) {
  const attrs = {};
  for (const match of raw.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

// Nearest open element with the given tag name, walking the stack from the top.
function nearest(stack, name) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].name === name) return stack[i];
  }
  return null;
}

// Indexes everything the song extraction needs, mirroring what the DOM-based
// version read off the parsed document:
// - sources: source unique_id -> base64 text, for sources whose first xml_tag
//   descendant carries a widget_settings attribute
// - assets: asset unique_id -> { name, layer }
// - shots: document-order shot records with their event/source descendant ids
function scanDocument(xml) {
  const sources = new Map();
  const assets = new Map();
  const shots = [];
  const stack = [];

  const finalizeSource = (data) => {
    if (!data?.id || data.settings === undefined) return;
    try {
      const settings = JSON.parse(data.settings);
      if (typeof settings?.text === 'string') sources.set(data.id, settings.text);
    } catch {
      // Ignore non-JSON widget settings, which are not song text sources.
    }
  };

  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(xml)) !== null) {
    const [, slash, tagWithAttrs] = match;
    if (slash === undefined) continue; // comment / CDATA / PI / doctype

    // The attrs blob swallows a trailing "/" (self-closing) when the tag ends
    // right after an attribute, so detect it there too.
    const rawAttrs = tagWithAttrs.slice(tagWithAttrs.search(/[\s]/) + 1);
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const attrs = parseAttrs(selfClosing ? rawAttrs.replace(/\/\s*$/, '') : rawAttrs);

    if (slash) {
      const idx = stack.map((entry) => entry.name).lastIndexOf(match[3]);
      if (idx !== -1) {
        if (match[3] === 'source') finalizeSource(stack[idx].data);
        stack.length = idx;
      }
      continue;
    }

    switch (match[3]) {
      case 'source': {
        // A source inside a shot is both indexed globally and linked to it.
        const shot = nearest(stack, 'shot');
        const entry = { name: 'source', data: { id: attrs.unique_id || null, settings: undefined } };
        if (shot && entry.data.id) shot.data.sourceIds.push(entry.data.id);
        stack.push(entry);
        break;
      }
      case 'shot': {
        const shot = { unique_id: attrs.unique_id || null, eventIds: [], sourceIds: [] };
        shots.push(shot);
        if (!selfClosing) stack.push({ name: 'shot', data: shot });
        break;
      }
      case 'asset':
        if (attrs.unique_id) {
          assets.set(attrs.unique_id, { name: attrs.name ?? '', layer: attrs.created_for_layer });
        }
        break;
      case 'xml_tag': {
        // Only the first xml_tag descendant of a source counts.
        const source = nearest(stack, 'source');
        if (source && source.data.settings === undefined) {
          source.data.settings = attrs.widget_settings ?? null;
        }
        break;
      }
      case 'event': {
        const shot = nearest(stack, 'shot');
        if (shot) shot.data.eventIds.push(attrs.unique_id || null);
        break;
      }
      default:
        if (!selfClosing) stack.push({ name: match[3], data: null });
    }
  }
  // Tolerate an unclosed source at the end of the document.
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].name === 'source') finalizeSource(stack[i].data);
  }
  return { sources, assets, shots };
}

function extractSongs(xml) {
  const { sources, assets, shots } = scanDocument(xml);

  const songs = [];
  for (const shot of shots) {
    const titleAsset = shot.unique_id ? assets.get(shot.unique_id) : null;
    if (!titleAsset || titleAsset.layer !== '2') continue;

    const sourceId = shot.eventIds.find((id) => id && sources.has(id))
      || (sources.has(shot.unique_id) ? shot.unique_id : null)
      || shot.sourceIds.find((id) => id && sources.has(id))
      || null;
    if (!sourceId) continue;

    const content = decodeURIComponent(
      Buffer.from(sources.get(sourceId), 'base64').toString('utf8'),
    );
    if (content.trim().length < 30) continue;

    songs.push({
      title: titleAsset.name,
      content,
    });
  }
  return songs;
}

// --- preset generation ---

// Fills the lyrics.html component template with a song's text, the same way
// the manager does: text injected into the data-field="lyrics" element,
// HTML-escaped like the browser serializer would.
function renderLyricsTemplate(content) {
  const template = fs.readFileSync(LYRICS_TEMPLATE_PATH, 'utf8');
  const field = /(<div\b[^>]*\bdata-field="lyrics"[^>]*>)[\s\S]*?(<\/div\s*>)/.exec(template);
  if (!field) {
    throw new Error(`No data-field="lyrics" element in ${LYRICS_TEMPLATE_PATH}`);
  }
  const escaped = content.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  return template.slice(0, field.index) + field[1] + escaped + field[2]
    + template.slice(field.index + field[0].length);
}

async function writeSongPresets(songs) {
  await fs.promises.mkdir(PRESETS_DIR, { recursive: true });
  let created = 0;
  let skipped = 0;
  const usedSlugs = new Set();
  for (const song of songs) {
    const base = slugify(song.title);
    let slug = base;
    for (let i = 2; usedSlugs.has(slug); i++) slug = `${base}-${i}`;

    const file = path.join(PRESETS_DIR, `${slug}.md`);
    if (!FORCE && fs.existsSync(file)) {
      skipped++;
      continue;
    }
    const existing = await readPreset(PRESETS_DIR, slug);
    const stamp = existing?.created || new Date().toISOString();
    await fs.promises.writeFile(file, serialize(song.title, stamp, CATEGORY, renderLyricsTemplate(song.content)));
    usedSlugs.add(slug);
    created++;
  }
  return { created, skipped };
}

const xml = fs.readFileSync(INPUT_PATH, 'utf8');
const songs = extractSongs(xml);

fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(songs, null, 2)}\n`);
console.log(`Wrote ${songs.length} songs to ${OUTPUT_PATH}`);

const { created, skipped } = await writeSongPresets(songs);
console.log(`Wrote ${created} presets to ${PRESETS_DIR} (category "${CATEGORY}", ${skipped} skipped)`);