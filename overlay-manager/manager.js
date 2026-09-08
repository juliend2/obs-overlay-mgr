// Manager page logic: generic component forms + presets.
//
// The server stays a dumb file server — component templates are parsed and
// filled in the browser with DOMParser, and field values are injected via
// textContent (never innerHTML), so any character is safe: the browser's
// serializer does the escaping.

const $ = (id) => document.getElementById(id);

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

function extractFields(root) {
  return [...root.querySelectorAll('[data-field]')].map((el) => ({
    name: el.dataset.field,
    label: el.dataset.label || el.dataset.field,
    type: el.dataset.type || 'text',
    value: el.dataset.default !== undefined ? el.dataset.default : el.textContent,
  }));
}

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

    const html = await (await fetch(`/components/${component.file}`, { cache: 'no-store' })).text();
    const root = parseTemplate(html);

    const container = document.createElement('div');
    container.className = 'form';
    for (const field of extractFields(root)) {
      container.appendChild(buildFieldInput(field));
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    const saveStatus = document.createElement('span');
    saveStatus.className = 'status';

    const presetName = document.createElement('input');
    presetName.type = 'text';
    presetName.placeholder = 'Nom du preset';

    const presetBtn = document.createElement('button');
    presetBtn.textContent = 'Save as preset';
    const presetStatus = document.createElement('span');
    presetStatus.className = 'status';

    actions.append(saveBtn, saveStatus, presetName, presetBtn, presetStatus);
    container.appendChild(actions);

    const rendered = () => renderComponent(root, collectValues(container));

    saveBtn.addEventListener('click', async () => {
      flash(saveStatus, 'Saving...');
      try {
        await postJson('/save-preview', { html: rendered() });
        flash(saveStatus, 'Saved');
      } catch {
        flash(saveStatus, 'Error saving', false);
      }
    });

    presetBtn.addEventListener('click', async () => {
      const name = presetName.value.trim();
      if (!name) {
        flash(presetStatus, 'Name required', false);
        return;
      }
      flash(presetStatus, 'Saving...');
      try {
        await postJson('/presets', { name, html: rendered() });
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

async function loadComponents() {
  const { components } = await fetchJson('/components/manifest.json');
  const host = $('components');
  host.innerHTML = '';
  for (const component of components) {
    const btn = document.createElement('button');
    btn.textContent = component.label;
    btn.addEventListener('click', () => toggleComponentForm(component).catch((err) => console.error(err)));
    host.appendChild(btn);
  }
}

// --- presets ---

async function loadPresets() {
  const { presets } = await fetchJson('/presets');
  const host = $('presets');
  host.innerHTML = '';
  for (const preset of presets) {
    const li = document.createElement('li');

    const useBtn = document.createElement('a');
    useBtn.href = "#";
    useBtn.className = 'use';
    useBtn.textContent = preset.name;
    useBtn.title = preset.name;
    const useStatus = document.createElement('span');
    useStatus.className = 'status';

    useBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      flash(useStatus, 'Loading...');
      try {
        const full = await fetchJson(`/presets/${encodeURIComponent(preset.slug)}`);
        await postJson('/save-preview', { html: full.html });
        flash(useStatus, 'Loaded');
      } catch {
        flash(useStatus, 'Error', false);
      }
    });

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      try {
        await fetch(`/presets/${encodeURIComponent(preset.slug)}`, { method: 'DELETE' });
        await loadPresets();
      } catch {
        flash(useStatus, 'Delete failed', false);
      }
    });

    li.append(useBtn, delBtn, useStatus);
    host.appendChild(li);
  }
}

// --- editor / test / go live ---

async function load() {
  const res = await fetch('/overlay-preview.html', { cache: 'no-store' });
  $('editor').value = await res.text();
}

async function save() {
  const status = $('test-status');
  flash(status, 'Saving...');
  try {
    await postJson('/save-preview', { html: $('editor').value });
    flash(status, 'Saved');
  } catch {
    flash(status, 'Error saving', false);
  }
}

// $('test').addEventListener('click', () => {
//   $('editor').value = '<div style="background: rgba(255, 255, 255, 0.5); color: black;">test</div>';
//   save();
// });

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

load();
loadComponents().catch((err) => console.error(err));
loadPresets().catch((err) => console.error(err));
