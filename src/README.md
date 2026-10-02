# Source layout

```
src/
  backend/
    injected.js       # Page bootstrap: detects the API and wires the matching backend
    webgl/            # One backend for WebGL 1 and 2; WebGL2-only features are used
                      #   only when the context has them
      intercept/      # Declarative API spec + per-context wrappers + extension objects
      capture/        # Command journal (ranges, budgets, overflow), object registry,
                      #   argument snapshots, context info, DOM image-source
                      #   canonicalization (flip/premultiply/sRGB baking), live
                      #   preview baking against the page's own context
      serialize/      # Journal → versioned capture package (blobs, image normalization,
                      #   range/prefix statistics)
      semantic/       # Raw command to debugger-event projection
      spies/          # Overview program tracking; framebufferSnapshot.js and
                      #   parseTexImage.js feed the Overview texture previews
    webgpu/           # Independent bounded live capture, descriptor metadata, and previews
      capture/        # One armed frame; persistent resource identities and descriptors
      spies/          # Pass/copy snapshots inserted into live encoders, read after submission
      serialize/      # Frame-only commands + resource metadata + images → v2 package
  inspection/
    webgl/
      package.js      # Versioned WebGL package, blob encode/decode, validation
      events.js       # EID classification of significant GPU operations
      view.js         # Blob-free panel view of a capture package
      lookup.js       # Lookup of the preview baked at capture time for a command
      diff.js         # Frame-to-frame package diffing
      host.js/html    # Extension-owned host: stored captures, lookup, diff, export/import
    webgpu/           # v2 package + stored-image lookup + descriptor/event inspection; no GPU execution
  shared/
    capture/          # API-neutral envelope and inspection-status diagnostics
    storage/          # Capture repository, chunked transfer protocol, hashing (Phase 3)
  adapters/
    three/            # Three.js semantic annotations
  ui/                 # Side panel: panel.js, tooltip.js, index.html
    captureView.js    # Frame capture controls, stored-data inspection, import/export, diff
```

WebGL code lives under `backend/webgl/` and `inspection/webgl/`. API-neutral layers use neutral
names and never import WebGL enums or browser WebGL object types. See
**[../docs/PLAN.md](../docs/PLAN.md)** for goals, differentiation, and phased roadmap.

Both `inspection/` hosts inspect stored data only. Neither creates a GPU context/device or
executes recorded commands. Missing previews have explicit diagnostics, including older
WebGPU v1 packages that previously required reconstruction.

## Data flow

Live capture packages travel in a chunked, flow-controlled transfer and land in the
extension origin's IndexedDB, so captures survive the original page closing.

```
Page (Three.js)
  → backend/injected.js + spies
  → transferSender (chunked package, acked per chunk)
  → extension/content.js (relay + flow control)
  → extension/background.js (transfer receiver)
  → shared/storage/captureRepository (IndexedDB) + session storage index
  → inspection/{webgl,webgpu}/host.js (stored captures, preview lookup, export/import)
```

The Overview scene/texture/program snapshot still uses `chrome.storage.session` as its index;
capture packages never store their body in session storage.
