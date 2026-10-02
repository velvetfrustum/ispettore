import { context, build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const entries = [
  ['src/backend/injected.js', 'injected'],
  ['src/extension/content.js', 'content'],
  ['src/extension/background.js', 'background'],
  ['src/devtools/devtools.js', 'devtools'],
  ['src/ui/panel.js', 'ui/panel'],
  ['src/inspection/webgl/host.js', 'inspection/webgl/host'],
  ['src/inspection/webgpu/host.js', 'inspection/webgpu/host']
];

async function copyStaticFiles() {
  await mkdir(path.join(dist, 'ui'), { recursive: true });
  await mkdir(path.join(dist, 'inspection/webgl'), { recursive: true });
  await mkdir(path.join(dist, 'inspection/webgpu'), { recursive: true });
  await mkdir(path.join(dist, 'icons'), { recursive: true });

  const panelHtml = await readFile(path.join(root, 'src/ui/index.html'), 'utf8');
  await writeFile(
    path.join(dist, 'ui/index.html'),
    panelHtml.replace('<script type="module" src="panel.js"></script>', '<script src="panel.js"></script>')
  );
  await cp(path.join(root, 'src/ui/panel.css'), path.join(dist, 'ui/panel.css'));
  const inspectionHostHtml = await readFile(path.join(root, 'src/inspection/webgl/host.html'), 'utf8');
  await writeFile(
    path.join(dist, 'inspection/webgl/host.html'),
    inspectionHostHtml.replace('<script type="module" src="host.js"></script>', '<script src="host.js"></script>')
  );
  const webgpuHostHtml = await readFile(path.join(root, 'src/inspection/webgpu/host.html'), 'utf8');
  await writeFile(
    path.join(dist, 'inspection/webgpu/host.html'),
    webgpuHostHtml.replace('<script type="module" src="host.js"></script>', '<script src="host.js"></script>')
  );
  await cp(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true });
  await writeFile(
    path.join(dist, 'devtools.html'),
    '<!doctype html><html><head><meta charset="UTF-8"></head><body><script src="devtools.js"></script></body></html>\n'
  );

  const sourceManifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const manifest = {
    ...sourceManifest,
    background: { service_worker: 'background.js' },
    devtools_page: 'devtools.html',
    side_panel: { default_path: 'ui/index.html' },
    content_scripts: sourceManifest.content_scripts,
    web_accessible_resources: sourceManifest.web_accessible_resources
  };
  await writeFile(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function createBuild() {
  return context({
    entryPoints: Object.fromEntries(entries.map(([input, output]) => [output, path.join(root, input)])),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    external: ['three'],
    outdir: dist,
    entryNames: '[dir]/[name]',
    sourcemap: watch ? 'inline' : false,
    banner: { js: `globalThis.__ISPETTORE_BUILD_ID=${JSON.stringify(new Date().toISOString())};` },
    logLevel: 'info'
  });
}

await rm(dist, { recursive: true, force: true });
await copyStaticFiles();

if (watch) {
  const buildContext = await createBuild();
  await buildContext.watch();
  console.log('Watching JavaScript entry points; reload the unpacked dist/ extension after changes.');
} else {
  await build({
    entryPoints: Object.fromEntries(entries.map(([input, output]) => [output, path.join(root, input)])),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    external: ['three'],
    outdir: dist,
    entryNames: '[dir]/[name]',
    banner: { js: `globalThis.__ISPETTORE_BUILD_ID=${JSON.stringify(new Date().toISOString())};` },
    logLevel: 'info'
  });
}
