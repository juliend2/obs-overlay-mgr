// Manager page logic: generic component forms + presets.
//
// The server stays a dumb file server — component templates are parsed and
// filled in the browser with DOMParser, and field values are injected via
// textContent (never innerHTML), so any character is safe: the browser's
// serializer does the escaping.

const $ = (id) => document.getElementById(id);

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const detail = (await res.text()).trim();
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Displays a temporary message next to an element
function flash(statusEl, message, ok = true) {
  clearTimeout(statusEl._flashTimer);
  statusEl.textContent = message;
  statusEl.className = ok ? 'status' : 'status err';
  statusEl._flashTimer = setTimeout(() => { statusEl.textContent = ''; }, 2000);
}


// --- component forms ---

// Wrapping the fragment before parsing keeps <style> blocks inside the root
// instead of the parser hoisting them into <head>.
function parseTemplate(html) {
  const doc = new DOMParser().parseFromString(`<div id="template-root">${html}</div>`, 'text/html');
  return doc.getElementById('template-root');
}

// Extracts from a DOM root element (technically, from the components/*.html)
// the fields that need to be edited for this component, when creating a new
// preset.
function extractFieldsFrom(root) {
  return [...root.querySelectorAll('[data-field]')].map((el) => ({
    name: el.dataset.field,
    label: el.dataset.label || el.dataset.field,
    type: el.dataset.type || 'text',
    value: el.dataset.default !== undefined ? el.dataset.default : el.textContent,
  }));
}

// Builds the field input(s) for the Preset creator form
function buildFieldInput(field) {
  const label = document.createElement('label');
  label.className = 'field';
  const name = document.createElement('span');
  name.textContent = field.label;
  label.appendChild(name);
  let input;
  if (field.type === 'textarea') {
    input = document.createElement('textarea');
  } else {
    input = document.createElement('input');
    input.type = 'text';
  }
  input.value = field.value;
  input.dataset.fieldInput = field.name;
  label.appendChild(input);
  return label;
}

// Fills a fresh clone of the template with the form values.
function renderComponent(root, values) {
  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll('[data-field]')) {
    const value = values[el.dataset.field];
    if (value !== undefined) el.textContent = value;
  }
  return clone.innerHTML;
}

function collectValues(form) {
  const values = {};
  for (const input of form.querySelectorAll('[data-field-input]')) {
    values[input.dataset.fieldInput] = input.value;
  }
  return values;
}

let openForm = null;
let formToggleBusy = false;

function closeOpenForm() {
  if (openForm) {
    openForm.container.remove();
    openForm = null;
  }
}

async function toggleComponentForm(component) {
  if (formToggleBusy) return;
  formToggleBusy = true;
  try {
    if (openForm && openForm.key === component.file) {
      closeOpenForm();
      return;
    }
    closeOpenForm();

    const html = await (await fetch(`/components/${component.file}`, {
      cache: 'no-store'
    })).text();
    const root = parseTemplate(html);

    const container = document.createElement('div');
    container.className = 'form';
    for (const field of extractFieldsFrom(root)) {
      container.appendChild(buildFieldInput(field));
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const presetName = document.createElement('input');
    presetName.type = 'text';
    presetName.placeholder = 'Nom du preset';

    const presetCategory = document.createElement('input');
    presetCategory.type = 'text';
    presetCategory.placeholder = 'Catégorie';
    presetCategory.value = component.category || '';
    presetCategory.setAttribute('list', 'preset-categories');

    const presetBtn = document.createElement('button');
    presetBtn.textContent = 'Save as preset';
    const presetStatus = document.createElement('span');
    presetStatus.className = 'status';

    actions.append(presetName, presetCategory, presetBtn, presetStatus);
    container.appendChild(actions);

    const rendered = () => renderComponent(root, collectValues(container));

    presetBtn.addEventListener('click', async () => {
      const name = presetName.value.trim();
      if (!name) {
        flash(presetStatus, 'Name required', false);
        return;
      }
      const category = presetCategory.value.trim();
      if (!category) {
        flash(presetStatus, 'Category required', false);
        return;
      }
      if (!configuredLayers.some((layer) => layer.category === category)) {
        flash(presetStatus, 'Category is not a layer', false);
        return;
      }
      flash(presetStatus, 'Saving...');
      try {
        await postJson('/presets', { name, html: rendered(), category });
        presetName.value = '';
        flash(presetStatus, 'Preset saved');
        await loadPresets();
      } catch {
        flash(presetStatus, 'Error saving preset', false);
      }
    });

    $('form-container').appendChild(container);
    openForm = { key: component.file, container };
  } finally {
    formToggleBusy = false;
  }
}

// Loads the template components
async function loadComponents() {
  const { components } = await fetchJson('/components/manifest.json');
  const host = $('components');
  host.innerHTML = '';
  for (const component of components) {
    const div = document.createElement('div')
    const btn = document.createElement('button');
    btn.textContent = component.label;
    btn.addEventListener('click',
      () => toggleComponentForm(component).catch((err) => console.error(err)));
    div.appendChild(btn)
    host.appendChild(div)
  }
}

// --- presets ---

// Categories currently seen across presets; feeds the datalist of the
// preset creation forms (pick an existing one or type a new name).
let knownCategories = [];

// Categories the user manually collapsed, so the open/closed state of the
// <details> groups survives list re-renders (save/delete).
const closedCategories = new Set();

// Full preset list from the server, kept so the fuzzy search can filter the
// rendered list without re-fetching. `text` (tag-stripped body, already
// lowercase and accent-free) comes from the /presets endpoint; `_name` and
// `_category` are precomputed here with the same normalization.
let presetsCache = [];

// Current preview selection, one preset slug per configured layer id.
let selectedByLayer = {};
let configuredLayers = [];
const EMPTY_PRESET = '_VIDE';

// Lowercase + strip accents, so "Église" matches a query of "eglise" (same
// folding as slugify/searchableText server-side).
function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Scores `query` matched as a subsequence of `haystack` (both pre-normalized).
// Returns 0 when the query is not a subsequence; otherwise a positive score
// that rewards contiguous runs and word starts, so hits like "abba" inside the
// name "Abba Père" rank above scattered letters across the lyrics.
// Best score across the searchable fields, with name and category matches
// weighted above body-text matches.
function refreshCategoryDatalist() {
  let datalist = $('preset-categories');
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = 'preset-categories';
    document.body.appendChild(datalist);
  }
  datalist.replaceChildren(...knownCategories.map((category) => {
    const option = document.createElement('option');
    option.value = category;
    return option;
  }));
}

function fuzzyScore(query, haystack) {
  if (!query) return 1;
  const contiguous = haystack.indexOf(query);
  if (contiguous !== -1) return 1000 + query.length * 10 - contiguous;
  let score = 0;
  let matched = 0;
  let prev = -2;
  for (let i = 0; i < haystack.length && matched < query.length; i++) {
    if (haystack[i] !== query[matched]) continue;
    score += 1;
    if (i === prev + 1) score += 2;
    if (i === 0 || haystack[i - 1] === ' ') score += 3;
    prev = i;
    matched++;
  }
  return matched === query.length ? score : 0;
}

function presetScore(preset, query) {
  return Math.max(
    fuzzyScore(query, preset._name) * 3,
    fuzzyScore(query, preset._category) * 2,
    fuzzyScore(query, preset._text),
  );
}

// In-place rename: double-click the preset name to edit it. Blurring the
// field saves (PUT /presets/:slug), Escape cancels. A name that changes the
// slug moves the file, so the list is re-rendered from the updated cache.
function startRename(useBtn, useStatus, preset) {
  const li = useBtn.parentElement;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = preset.name;
  input.className = 'rename';
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    input.remove();
    useBtn.style.display = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish();
    if (e.key === 'Enter') input.blur(); // commit, same as clicking away
  });
  input.addEventListener('blur', async () => {
    if (closed) return;
    const name = input.value.trim();
    if (!name || name === preset.name) {
      finish();
      return;
    }
    closed = true; // the re-render below detaches the input -> a blur follows
    flash(useStatus, 'Saving...');
    const oldSlug = preset.slug;
    try {
      const renamed = await fetchJson(`/presets/${encodeURIComponent(oldSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      preset.name = renamed.name;
      preset.slug = renamed.slug;
      preset._name = normalize(preset.name);
      for (const [layerId, slug] of Object.entries(selectedByLayer)) {
        if (slug === oldSlug) selectedByLayer[layerId] = renamed.slug;
      }
      renderPresetList();
    } catch {
      flash(useStatus, 'Rename failed', false);
      // `closed` is already true (set before the request, to guard against
      // the blur the re-render would cause), so restore the anchor directly.
      input.remove();
      useBtn.style.display = '';
    }
  });
  useBtn.style.display = 'none';
  li.insertBefore(input, useBtn.nextSibling);
  input.focus();
  input.select();
}

function buildPresetItem(preset) {
  const li = document.createElement('li');

  const useBtn = document.createElement('a');
  useBtn.href = "#";
  useBtn.className = 'use';
  useBtn.textContent = preset.name;
  useBtn.title = preset.name;
  const layer = configuredLayers.find((item) => item.category === preset.category);
  if (layer && selectedByLayer[layer.id] === preset.slug) useBtn.classList.add('selected');
  const useStatus = document.createElement('span');
  useStatus.className = 'status';

  let clickTimer;
  useBtn.addEventListener('click', (e) => {
    e.preventDefault();
    clearTimeout(clickTimer);
    // Load on click, but wait a beat first: a double-click means "rename",
    // and the dblclick event would otherwise fire two loads first.
    clickTimer = setTimeout(async () => {
      flash(useStatus, 'Loading...');
      try {
        const layer = configuredLayers.find((item) => item.category === preset.category);
        if (!layer) {
          flash(useStatus, 'Category is not a layer', false);
          return;
        }
        selectedByLayer[layer.id] = preset.slug;
        await saveLayerSelection();
        renderPresetList();
        flash(useStatus, 'Loaded');
      } catch (err) {
        flash(useStatus, err.message || 'Error', false);
      }
    }, 250);
  });

  useBtn.addEventListener('dblclick', (e) => {
    e.preventDefault();
    clearTimeout(clickTimer);
    startRename(useBtn, useStatus, preset);
  });

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.classList.add('delete-btn');
  delBtn.addEventListener('click', async () => {
    try {
      await fetch(`/presets/${encodeURIComponent(preset.slug)}`, { method: 'DELETE' });
      await loadPresets();
    } catch {
      flash(useStatus, 'Delete failed', false);
    }
  });

  li.append(useBtn, delBtn, useStatus);
  return li;
}

function addEmptyPresetItems() {
  for (const layer of configuredLayers) {
    const category = layer.category;
    if ($('preset-search') && normalize($('preset-search').value)
      && !presetsCache.some((preset) => preset.category === category && presetScore(preset, normalize($('preset-search').value)) > 0)) {
      continue;
    }
    const details = [...document.querySelectorAll('#presets details')]
      .find((element) => element.querySelector('summary')?.textContent === category);
    if (!details) continue;
    const list = details.querySelector('ul');
    const li = document.createElement('li');
    const useBtn = document.createElement('a');
    useBtn.href = '#';
    useBtn.className = 'use';
    useBtn.textContent = EMPTY_PRESET;
    if (!selectedByLayer[layer.id] || selectedByLayer[layer.id] === EMPTY_PRESET) {
      useBtn.classList.add('selected');
    }
    useBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        selectedByLayer[layer.id] = EMPTY_PRESET;
        await saveLayerSelection();
        renderPresetList();
      } catch (err) {
        flash(useBtn, err.message || 'Error', false);
      }
    });
    li.appendChild(useBtn);
    list.prepend(li);
  }
}

async function saveLayerSelection() {
  const state = {};
  for (const layer of configuredLayers) {
    const slug = selectedByLayer[layer.id];
    if (typeof slug === 'string' && slug.trim()) state[layer.id] = slug;
  }
  const saved = await postJson('/layers/state', { layers: state });
  selectedByLayer = { ...saved.state };
}

// Fetches the preset list (including searchable text) and refreshes the
// category datalist from the full, unfiltered list.
async function loadPresets() {
  const layerData = await fetchJson('/layers');
  configuredLayers = layerData.layers;
  const configuredIds = new Set(configuredLayers.map((layer) => layer.id));
  selectedByLayer = Object.fromEntries(
    Object.entries(layerData.state).filter(([id]) => configuredIds.has(id))
  );
  const { presets } = await fetchJson('/presets');
  // Alphabetical (ascending) within each category and in the uncategorized
  // list — grouping below preserves this order; the API returns newest-first.
  presets.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  presetsCache = presets.map((preset) => ({
    ...preset,
    _name: normalize(preset.name),
    _category: normalize(preset.category),
    // Server-side normalized already; an absent field means a pre-fuzzy-search
    // server response (stale process), so search just falls back to
    // name/category instead of crashing.
    _text: preset.text ?? '',
  }));
  knownCategories = [...new Set(presets.map((p) => p.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  refreshCategoryDatalist();
  renderPresetList();
}

// Re-renders the presets list, keeping only the presets whose fuzzy score
// against the search input is above zero (an empty query keeps everything).
// Groups with no matches are hidden entirely, and every group is forced open
// while a query is active so matches can't hide behind a collapsed category.
function renderPresetList() {
  const query = normalize($('preset-search').value);
  const host = $('presets');
  const scrollTop = host.scrollTop; // keep the view stable across re-renders
  host.innerHTML = '';

  const matches = query
    ? presetsCache
      .map((preset, index) => ({ preset, score: presetScore(preset, query), index }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ preset }) => preset)
    : presetsCache;

  if (!matches.length) {
    const none = document.createElement('div');
    none.className = 'no-match';
    none.textContent = 'Aucun preset trouvé';
    host.appendChild(none);
    addEmptyPresetItems();
    host.scrollTop = scrollTop;
    return;
  }

  const groups = new Map();
  for (const preset of matches) {
    const category = preset.category || '';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(preset);
  }

  for (const [category, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!category) continue; // uncategorized presets are listed directly, no group

    const details = document.createElement('details');
    details.open = query ? true : !closedCategories.has(category);
    if (!query) {
      details.addEventListener('toggle', () => {
        if (details.open) closedCategories.delete(category);
        else closedCategories.add(category);
      });
    }

    const summary = document.createElement('summary');
    summary.textContent = category;

    const list = document.createElement('ul');
    for (const preset of items) list.appendChild(buildPresetItem(preset));

    details.append(summary, list);
    host.appendChild(details);
  }

  for (const preset of groups.get('') || []) {
    host.appendChild(buildPresetItem(preset));
  }
  addEmptyPresetItems();
  host.scrollTop = scrollTop;
}

// --- iframes ---

// Keeps the preview/live iframes at a 16:9 aspect ratio: width stays at 100%
// and the height is recomputed whenever the frame's size changes.
const ratioObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    entry.target.style.height = `${Math.round(entry.contentRect.width * 9 / 16)}px`;
  }
});
for (const iframe of document.querySelectorAll('iframe.overlay-frame')) {
  ratioObserver.observe(iframe);
}

// Button that sends the preview in live:
$('golive').addEventListener('click', async () => {
  const status = $('golive-status');
  flash(status, 'Going live...');
  try {
    await postJson('/golive');
    flash(status, 'Live!');
  } catch {
    flash(status, 'Error going live', false);
  }
});

//load();
loadComponents().catch((err) => console.error(err));
loadPresets().catch((err) => console.error(err));

// Fuzzy search over presets: debounce the keystrokes (~150ms) then re-render
// the list from the cached copy — no request is involved in filtering.
let searchTimer;
$('preset-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderPresetList, 150);
});
