# WebGPU backend

Deterministic WebGPU capture lives under `capture/` — `installWebGpuCapture.js` hooks device/queue/pass-encoder methods into a per-device command journal (`deviceJournal.js`), with object identity tracked by `objectRegistry.js` and argument snapshotting by `snapshotValue.js`. `serialize/serializeJournal.js` turns a journal into a storable package for the isolated replay host.

WebGL counterpart: `../webgl/`.
