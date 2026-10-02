# Ispettore

A Chrome DevTools panel for debugging **Three.js, WebGL, and WebGPU** applications. It captures
one frame of real GPU activity and lets you browse every draw, clear, blit, and copy in it —
with the color output each one produced, the full render pipeline state, and (for Three.js
apps) which object, material, and pass each draw belongs to.

Think of it as Spector.js's live GPU capture combined with a RenderDoc-style pipeline
inspector, with Three.js scene awareness built in.

## Install

Ispettore isn't on the Chrome Web Store yet — install it from a release zip:

1. Download `ispettore-v<version>.zip` from the [Releases page](../../releases/latest).
2. Unzip it.
3. Open Chrome → `chrome://extensions`, enable **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder.

Ispettore needs to see `http`, `https`, and `file` pages to observe their GPU contexts, so
Chrome will ask for access to all sites. Nothing is sent off your machine: captures are stored
locally in the extension's own IndexedDB.

Open any WebGL/WebGPU page, press **F12**, choose the **Ispettore** tab, open the **Frame**
sub-tab, and click **Capture frame**. (The side panel via the toolbar icon also works; DevTools
is recommended.)

## Features

![Baked color output of a captured WebGL draw event, showing a detailed metallic chain mesh](screenshots/visual-output.png)

### Live frame capture for WebGL 1/2

Arm the next animation frame (or an on-demand render burst) and get back every GPU event it
contained, with a baked color image for each one.

### Three.js scene awareness

Events are linked back to the mesh, material, and post-processing pass that produced them, so
you can filter a capture down to one object in the scene tree.

![Overview tab showing the Three.js scene tree with renderers and nested objects](screenshots/overview.png)
![Frame tab filtered to draws from a single scene object, with Pipeline Rasterizer state](screenshots/filtered-objects-in-threejs.png)

### RenderDoc-style pipeline inspection

For any event, step through Vertex Input, Vertex Shader, Rasterizer, Fragment Shader, and
Output Merger: draw arguments, vertex/index buffer contents, uniform values, bound textures,
blend/depth/stencil state, and viewport/scissor — each tagged as set, redundant, or disabled,
the way Spector.js does.

![Pipeline tab showing the Vertex Shader stage with program and uniform values](screenshots/pipeline.png)
![Fragment shader GLSL source opened in a panel tab](screenshots/shader-view2.png)
![Compute shader WGSL source opened in a panel tab](screenshots/shader-view.png)

### Call Info

Command name with its MDN documentation, CPU/GPU duration, call arguments, and the JavaScript
stack trace that issued it.

### WebGPU capture (experimental)

Pass-final color images and texture-copy outputs, WGSL shader modules, bind groups, and
compute dispatch details, with the same capture-then-inspect model as WebGL.

![WebGPU Pipeline tab showing a compute dispatch, bind group, and buffer contents](screenshots/compute-shader.png)

### CPU time and GPU time, kept separate

Per-event CPU issue time next to live GPU duration (WebGL, where the browser exposes a timer
extension), instead of one conflated number.

![Frame-cost timeline above a post-process render transition pass](screenshots/effect-composer-visualizer.png)
![Frame-cost timeline broken down into individual bloom pass steps](screenshots/effect-composer-visualizer-2.png)

### Stored captures, export, import, and diff

Every capture survives page navigation and closure; save it as a portable JSON file, reload it
later, or diff two captures side by side.

![Captures tab showing capture details, stored captures list, and diff selectors](screenshots/capture-manager.png)
![Side-by-side command diff between two stored captures](screenshots/captures-dif.png)

### Never runs your code to show you data

Inspecting a capture only reads back what was recorded live. It never re-executes shaders,
recreates GPU resources, or replays your application — see [`src/README.md`](src/README.md)
for the capture/inspection architecture.

## Three.js support

| Three.js version / application | Support level | What to expect |
|---|---|---|
| **r184 (`three@0.184.0`)** | Tested target | Pinned development, demo, and automated browser-test target for scene observation, `EffectComposer` pass hooks, and live frame capture. Newer revisions are best effort until added to the regression matrix. |
| **r106–r183** | Best effort | The `__THREE_DEVTOOLS__` observation bridge exists, but these revisions are not part of the regression matrix. Composer annotations and capture coverage may differ. |
| **Before r106** | Low-level capture only, unsupported | WebGL interception may still record events, but Three.js scene discovery and live re-render inspection are unsupported. |
| **WebGL without Three.js** | Best effort | API-level events and resources can be captured; Three.js scene, mesh, material, and composer metadata are unavailable. |

## License

Apache License 2.0 — see [LICENSE](LICENSE).
