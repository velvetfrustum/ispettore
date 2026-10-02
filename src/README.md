# Source layout

## Architecture

Ispettore uses a **live capture, stored-data inspection** model for both WebGL and WebGPU: it
records one armed frame of real GPU activity, bakes the color output of each significant event
while the page actually renders it, and stores that frame as one self-contained package.
Browsing an event afterward — selecting it in the event list, stepping through pipeline
stages, scrubbing commands — is a pure lookup against that stored package.

Selecting an event **never** executes a captured GPU command, reconstructs a GPU resource,
requests a device/context, or calls back into your application. If something wasn't captured,
the panel says so explicitly instead of guessing or re-running your code to generate it.

This is a deliberate trade-off against the alternative (replaying recorded commands in an
isolated context to reconstruct arbitrary state): that approach scales badly with long-running
scenes and can diverge from what actually happened on screen. Capturing observable output
live, once, trades the ability to synthesize data that was never recorded for guaranteed
correctness and bounded capture cost.

## Layout

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
names and never import WebGL enums or browser WebGL object types.

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
