import fs from 'fs';
import path from 'path';

export const EMPTY_PRESET = '_VIDE';

function validateLayers(layers) {
  if (!Array.isArray(layers)) throw new Error('Layers must be an array');
  const ids = new Set();
  const categories = new Set();
  return layers.map((layer) => {
    if (!layer || typeof layer.id !== 'string' || !layer.id.trim()) {
      throw new Error('Each layer needs an id');
    }
    if (typeof layer.category !== 'string' || !layer.category.trim()) {
      throw new Error('Each layer needs a category');
    }
    const id = layer.id.trim();
    const category = layer.category.trim();
    if (ids.has(id)) throw new Error(`Duplicate layer id: ${id}`);
    if (categories.has(category)) throw new Error(`Duplicate layer category: ${category}`);
    ids.add(id);
    categories.add(category);
    return { id, category };
  });
}

export async function loadLayers(filePath) {
  const config = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  return validateLayers(config.layers);
}

export async function loadLayerState(filePath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return parsed && parsed.layers && typeof parsed.layers === 'object' ? parsed.layers : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export function layerStateForCategories(layers, state) {
  const result = {};
  for (const layer of layers) {
    if (state[layer.id]) result[layer.category] = state[layer.id];
  }
  return result;
}

export async function saveLayerState(filePath, state) {
  await fs.promises.writeFile(filePath, `${JSON.stringify({ layers: state }, null, 2)}\n`);
}

export async function composeLayers(layers, state, readPreset) {
  const output = [];
  for (const layer of layers) {
    const slug = state[layer.id] || EMPTY_PRESET;
    if (slug === EMPTY_PRESET) continue;
    const preset = await readPreset(slug);
    if (!preset) throw new Error(`Preset not found: ${slug}`);
    if (preset.category !== layer.category) {
      throw new Error(`Preset ${slug} does not belong to layer ${layer.category}`);
    }
    output.push(`<div data-overlay-layer="${escapeAttribute(layer.id)}">${preset.html}</div>`);
  }
  return output.join('\n');
}

function escapeAttribute(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

export function layerStateFromSelections(layers, selections) {
  const state = {};
  for (const layer of layers) {
    const slug = selections[layer.id];
    if (typeof slug === 'string' && slug.trim()) state[layer.id] = slug;
  }
  return state;
}

export function layerPaths(dir) {
  return {
    config: path.join(dir, 'layers.json'),
    state: path.join(dir, 'layers-state.json'),
  };
}
