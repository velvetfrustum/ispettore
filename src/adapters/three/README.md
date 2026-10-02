# Three.js adapter

Scene/renderer discovery lives in `src/backend/injected.js` via the `__THREE_DEVTOOLS__`
bridge (see the comment block there).

**Composer / post-process hooks** — `composerHooks.js` (page inject):

- `EffectComposer` prototype + dynamic `import()` of the app's composer module
- Per-pass boundaries (`RenderPass`, bloom, DoF, …)
- Manual multi-pass scenes (`setRenderTarget` ping-pong, e.g. dof2)

Planned next:

- Map draw calls → `Mesh` / material names
- Enrich scene tree with engine metadata

Keep UI-specific code out of this folder.
