# Integration tests

Playwright runs each specification against a real demo with the generated unpacked extension loaded in Chromium. External HTTP requests are blocked: demos must load Three.js and all runtime assets from the local project.

## First run

```bash
npm run test:integration:install
npm run test:integration
```

`test:integration` builds `dist/`, starts the local demo server, and runs Chromium with SwiftShader.
WebGPU specs opt into `test.use({ webgpu: true })`, explicitly selecting SwiftShader for both
ANGLE and Vulkan, with Vulkan compositing enabled so the live swapchain works. Merely exposing
`navigator.gpu` is not a sufficient capability check.
The WebGPU-specific flags are `--use-angle=swiftshader`, `--use-vulkan=swiftshader`,
`--enable-features=Vulkan`, and `--disable-vulkan-surface`.

Integration reruns are deferred for the 2026-10-01 migration follow-up. See
[the plan](../../docs/PLAN.md#migration-follow-up--2026-10-01) for pending checks and bounded
rerun commands, including the revised missing-capture diff test and WebGPU panel import.

## Output validation

The tests do not save captured-frame fixtures. They validate stored live previews in memory by checking:

- the preview decodes with non-zero dimensions;
- it contains opaque pixels;
- its luminance has enough variation to reject blank or single-color output.

Playwright screenshots, video, and traces are disabled. Temporary browser profiles and failure output under `test-results/` are ignored by Git.

Current coverage:

- `webgl-simple`: scene-tree refresh and bounded live journal recording;
- `webgl-afterimage`: scene-tree refresh and animation over time;
- `webgl-dof2`: stored previews for intermediate EIDs;
- `webgl-instanced`: instanced calls and low draw count in the captured frame;
- `webgl-be-the-sun`: WebGL1 (regl) capture with baked previews and no GL warnings;
- `webgl-smoke` / `webgl-parity`, `webgl-pipeline`, `webgl-ranges`, `webgl-panel`, `webgl-export-import`: per-demo canvas, journal, panel, and export checks.
- `webgpu-panel`, `webgpu-samples`, `webgpu-simple`: real Capture-button flow, portable live images,
  descriptors, and inspection with GPU requests blocked.
- `webgpu-live-capture`: pass/copy images before subsequent overwrites, reordered command-buffer
  submission, bounded idle recording, export/import after page closure, and unsubmitted output.

Hardware-backed coverage remains open. No test should treat successful reconstruction as proof
that live capture works; inspection must not execute GPU commands on either backend.
