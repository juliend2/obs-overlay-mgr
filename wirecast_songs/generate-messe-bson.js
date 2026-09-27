const fs = require('node:fs');
const path = require('node:path');
const { DOMParser } = require('@xmldom/xmldom');

const inputPath = path.join(__dirname, 'messe.xml');
const outputPath = path.join(__dirname, 'messe.json');
const xml = fs.readFileSync(inputPath, 'utf8');
const document = new DOMParser().parseFromString(xml, 'text/xml');

const sources = new Map();
for (const source of Array.from(document.getElementsByTagName('source'))) {
  const sourceId = source.getAttribute('unique_id');
  const tag = source.getElementsByTagName('xml_tag')[0];
  const settings = tag?.getAttribute('widget_settings');
  if (!sourceId || !settings) continue;

  try {
    const widgetSettings = JSON.parse(settings);
    if (typeof widgetSettings.text === 'string') {
      sources.set(sourceId, widgetSettings.text);
    }
  } catch {
    // Ignore non-JSON widget settings, which are not song text sources.
  }
}

const assets = new Map();
for (const asset of Array.from(document.getElementsByTagName('asset'))) {
  const assetId = asset.getAttribute('unique_id');
  if (assetId) assets.set(assetId, asset);
}

const songs = [];
for (const shot of Array.from(document.getElementsByTagName('shot'))) {
  const shotId = shot.getAttribute('unique_id');
  const titleAsset = shotId ? assets.get(shotId) : null;
  if (!titleAsset || titleAsset.getAttribute('created_for_layer') !== '2') continue;

  let sourceId = null;
  for (const event of Array.from(shot.getElementsByTagName('event'))) {
    const eventId = event.getAttribute('unique_id');
    if (eventId && sources.has(eventId)) {
      sourceId = eventId;
      break;
    }
    const eventAsset = eventId ? assets.get(eventId) : null;
    if (eventAsset && sources.has(eventId)) {
      sourceId = eventId;
      break;
    }
  }

  if (!sourceId && sources.has(shotId)) sourceId = shotId;
  if (!sourceId) {
    const directSource = Array.from(shot.getElementsByTagName('source'))
      .map((element) => element.getAttribute('unique_id'))
      .find((id) => id && sources.has(id));
    sourceId = directSource || null;
  }
  if (!sourceId) continue;

  const encodedText = sources.get(sourceId);
  const content = decodeURIComponent(
    Buffer.from(encodedText, 'base64').toString('utf8'),
  );
  if (content.trim().length < 30) continue;

  songs.push({
    title: titleAsset.getAttribute('name'),
    content,
  });
}

fs.writeFileSync(outputPath, `${JSON.stringify(songs, null, 2)}\n`);
console.log(`Wrote ${songs.length} songs to ${outputPath}`);
