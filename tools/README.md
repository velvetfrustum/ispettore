# Tools

## `build.mjs`

Bundles the extension with esbuild and copies its static files into the generated `dist/` directory.

```bash
npm run build
npm run dev # watch JavaScript entry points
```

Load `dist/`, not the repository root, as the unpacked extension in Chrome.

## `serve-demos.mjs`

Serves `demos/` at `http://127.0.0.1:8765` and the pinned local Three.js package at `/vendor/three/`. Playwright starts it automatically for integration tests:

```bash
npm run test:integration
```

It can also be run directly:

```bash
npm run serve:demos
```

Set `PORT` to use another port:

```bash
PORT=8080 npm run serve:demos
```
