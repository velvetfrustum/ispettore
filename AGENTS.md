- Use ES6 modules and conventions
- Source lives under `src/` — see `src/README.md`
- Tests live under `tests/` — see `tests/README.md`. Add tests when behavior is non-trivial.
  `npm test` only runs the fast suites (`tests/unit/`, `tests/e2e/`); it does **not** cover
  `tests/integration/` (Playwright, real browser). Run `npm run test:integration` explicitly
  when changing capture, inspection, panel, or extension-messaging behavior.
- Do not add comments unless necessary
- If you see unused code (functions, variables, classes, files, tests), ask the user if it can be removed.

## Graphics API isolation (WebGL / WebGPU)

Ispettore supports **WebGL (1/2) and WebGPU** side by side, on both the capture and inspection
sides. Keep API-specific code isolated so both backends coexist without leaking into shared
layers — a page can use both APIs at once, so this isn't just a startup-time choice.

**Rules**

1. **WebGL-only code** lives under `src/backend/webgl/` (intercept/spies, capture journal,
   serialize, semantic annotations) and `src/inspection/webgl/` (package, lookup, diff, host).
   Do not add WebGL types, GLenum values, or `WebGLRenderingContext` hooks in `shared/`, `ui/`,
   `bridge/`, or `adapters/`.
2. **WebGPU-only code** lives under `src/backend/webgpu/` (capture, serialize, spies) and
   `src/inspection/webgpu/` (package, lookup, eventState, host) — mirror the WebGL layout's
   roles, do not merge the two implementations.
3. **API-agnostic layers** use neutral names in `src/shared/capture/` (e.g. `gpuApi: 'webgl' |
   'webgpu'`, the neutral package diff in `diff.js`, blob encode/decode in `blobs.js`). The
   side panel and adapters consume this shape only.
4. `src/backend/injected.js` installs **both** backends directly (the WebGL command journal and
   `installWebGpuCapture`) rather than detecting the API once and loading a single matching
   module — do not introduce an either/or dispatch here. No WebGL imports in the WebGPU path
   and vice versa.
5. When moving existing logic out of `injected.js`, place it in `webgl/` or `webgpu/` first;
   refactor into shared capture types second — do not block one backend by baking the other's
   assumptions into shared code.
6. The inspection side mirrors the same isolation: `src/inspection/webgl/host.js` and
   `src/inspection/webgpu/host.js` never import each other's package/lookup implementation.
   Package comparison (diffing two stored captures) is the one API-neutral exception and lives
   in `src/shared/capture/diff.js`.

New WebGL features go in `backend/webgl/` (or `inspection/webgl/`) rather than growing
`injected.js`; the WebGPU equivalents go in `backend/webgpu/` / `inspection/webgpu/`. See
`src/README.md` for the full current layout.
