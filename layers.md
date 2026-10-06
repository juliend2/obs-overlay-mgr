# Layered Overlay Proposal

## Goal

Allow more than one preset to be displayed at the same time by composing the
overlay from category-based layers.

For example, a `Chants` preset and a `Messe` preset can both be visible in the
preview and, after clicking **Go live**, in `overlay-live.html`.

## Recommended Model

Each configured layer has a stable identifier, a category, a position in the
layer order, and one selected preset or no preset.

Example configuration:

```json
{
  "layers": [
    { "id": "chants", "category": "Chants" },
    { "id": "messe", "category": "Messe" }
  ]
}
```

The array order determines the render order. Layers later in the array are
rendered later in the document and therefore appear above earlier layers when
their content overlaps.

## Configuration File

The current `components/manifest.json` describes editor templates. It should
remain responsible for defining what users can create, rather than also
defining overlay composition.

Add a separate file, for example:

```text
overlay-manager/layers.json
```

This keeps these concepts separate:

- `components/manifest.json`: component templates and their categories.
- `layers.json`: simultaneously visible layers and their order.

Adding or reordering layers would only require changing `layers.json`.

## The `_VIDE` Preset

Every configured layer should expose a virtual `_VIDE` option. Selecting it
disables that layer and contributes no HTML to the composed overlay.

The recommended implementation is to generate `_VIDE` in the existing preset
selector instead of creating a file on disk. It is a reserved value, not an
ordinary preset.

This avoids unnecessary files and makes the disabled state unambiguous. A user
should not create a normal preset named `_VIDE`.

## Current Layer State

The selected preset for each layer should be persisted separately from the
configuration. For example:

```text
overlay-manager/layers-state.json
```

Example contents:

```json
{
  "layers": {
    "chants": "alleluia",
    "messe": "messe-du-6-septembre"
  }
}
```

The state stores preset slugs rather than rendered HTML. This keeps the state
small and understandable and allows the server to validate selections.

`layers-state.json` is generated runtime state and should be ignored by Git,
like `overlay-live.html`.

## Manager UI

Keep the current category-grouped preset selector as the only selection UI. Do
not add a separate layer-selection panel or a second set of selectors.

The existing list remains structurally similar:

```text
Chants
  _VIDE
  Alleluia
  Viens Esprit Saint

Messe
  _VIDE
  Messe du dimanche
```

Clicking a preset continues to load it immediately, but it replaces only the
active layer associated with that preset's category. It must not replace the
complete composed preview. A selected `Chants` preset and a selected `Messe`
preset can therefore remain active and visible together.

The manager should maintain one selection per category rather than one global
`selectedSlug`, for example:

```js
{
  Chants: 'alleluia',
  Messe: 'messe-du-dimanche'
}
```

The current selected styling should remain category-aware: one preset can be
marked selected in `Chants` while another is marked selected in `Messe`.
Selecting `_VIDE` clears that category's layer. The existing list also remains
the place for searching, renaming, deleting, and creating presets.

Initially, a preset whose category is not configured as a layer should not be
assignable. The manager should show a clear message rather than implicitly
changing configuration.

## Server API

The layer workflow should use dedicated state and composition logic. Possible
endpoints:

```text
GET  /layers
POST /layers/state
```

The server should:

1. Load and validate `layers.json`.
2. Load the saved layer state.
3. Validate that each selected preset exists.
4. Validate that a selected preset has the category expected by its layer.
5. Treat `_VIDE` as an empty layer.
6. Read the selected preset HTML.
7. Compose the selected layers in configured order.
8. Write the composed HTML to `overlay-preview.html`.
9. Broadcast `reload:preview`.

The existing `/golive` endpoint can continue to copy the composed preview to
`overlay-live.html` and broadcast `reload:live`.

## Composed HTML

The composed preview can contain one wrapper per active layer:

```html
<div data-overlay-layer="chants">
  ...selected Chants preset...
</div>
<div data-overlay-layer="messe">
  ...selected Messe preset...
</div>
```

The layer wrappers make the output easier to inspect and provide a future hook
for layer-specific styling, without requiring the viewer to understand the
layer model.

## Preview and Live Behavior

The existing viewer architecture already maps well to this design:

- Preview fetches `/overlay-preview.html`.
- Live fetches `/overlay-live.html`.
- Changing a layer updates the composed preview and broadcasts
  `reload:preview`.
- Clicking **Go live** publishes the complete composed preview and broadcasts
  `reload:live`.
- OBS continues to display the live overlay and does not need to understand
  layers.

No change to the iframe protocol should be necessary.

## Validation Rules

The implementation should validate:

- layer IDs are unique;
- layer categories are unique;
- selected presets exist;
- selected preset categories match their configured layer;
- `_VIDE` is accepted for every configured layer;
- unknown layer IDs in saved state are ignored or reported clearly;
- layer order comes from the configuration array.

Duplicate categories should initially be invalid. One category per layer keeps
the selection behavior clear and matches the intended use case.

## Testing Plan

Add tests for:

- loading and validating layer configuration;
- composing multiple selected presets in configured order;
- empty `_VIDE` layers;
- category mismatch rejection;
- missing preset rejection;
- saving and reloading selected layer state;
- preview reload notifications;
- publishing the complete composition on **Go live**;
- existing single-overlay and preset behavior remaining valid.

## Implementation Phases

1. Add `layers.json` and a server-side composition module.
2. Add layer state storage and API endpoints.
3. Generate `overlay-preview.html` from selected layers.
4. Add virtual `_VIDE` handling.
5. Update the existing category-grouped preset selector so each category can
   have its own selected preset.
6. Add integration and composition tests.
7. Update documentation and generated-file handling.

## Core Decision

Categories should identify layers, but the rendered overlay should be composed
from explicit per-category selection state rather than directly from a single
global preset selection. The existing category-grouped preset selector remains
the user-facing interaction. This supports simultaneous `Messe` and `Chants`
presets now while allowing more layers and configurable ordering later.
