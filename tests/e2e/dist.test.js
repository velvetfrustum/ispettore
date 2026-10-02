import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const requiredFiles = [
  'dist/manifest.json',
  'dist/background.js',
  'dist/content.js',
  'dist/devtools.js',
  'dist/devtools.html',
  'dist/injected.js',
  'dist/ui/index.html',
  'dist/ui/panel.css',
  'dist/ui/panel.js',
  'dist/inspection/webgl/host.html',
  'dist/inspection/webgl/host.js',
  'dist/inspection/webgpu/host.html',
  'dist/inspection/webgpu/host.js',
  'dist/icons/icon48.png',
  'dist/icons/icon128.png'
];

test('build emits a loadable unpacked extension layout', async () => {
  for (const file of requiredFiles) {
    assert.equal((await stat(file)).isFile(), true, `${file} was not generated`);
  }

  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.devtools_page, 'devtools.html');
  assert.deepEqual(manifest.content_scripts[0].js, ['injected.js']);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.deepEqual(manifest.content_scripts[1].js, ['content.js']);
  for (const resource of manifest.web_accessible_resources) {
    assert.ok(!resource.resources.includes('injected.js'), 'injected.js must not be a web-accessible resource');
  }
});

test('page-world backend is one bundled IIFE with one public API', async () => {
  const injected = await readFile('dist/injected.js', 'utf8');
  assert.doesNotMatch(injected, /^\s*import\s/m);
  assert.match(injected, /window\.__ISPETTORE__\s*=/);

  for (const retiredGlobal of [
    '__ISPETTORE_WEBGL_FB__',
    '__ISPETTORE_WEBGL_DEPTH__',
    '__ISPETTORE_WEBGPU_FB__',
    '__ISPETTORE_WEBGPU__',
    '__ISPETTORE_REPLAY__',
    '__ISPETTORE_THREE__'
  ]) {
    assert.doesNotMatch(injected, new RegExp(retiredGlobal));
  }
});

test('WebGL inspection host is isolated from the live page backend', async () => {
  const inspectionHost = await readFile('dist/inspection/webgl/host.js', 'utf8');
  assert.doesNotMatch(inspectionHost, /^\s*import\s/m);
  assert.match(inspectionHost, /__ISPETTORE_WEBGL_INSPECTOR__/);
  assert.doesNotMatch(inspectionHost, /__ISPETTORE_WEBGL_REPLAY__|replayToStep|lastFrameCapture|renderer\.render/);
  assert.doesNotMatch(inspectionHost, /\b__ISPETTORE__\b/);
});

test('WebGPU capture host contains lookup and metadata inspection, never GPU execution', async () => {
  const host = await readFile('dist/inspection/webgpu/host.js', 'utf8');
  assert.match(host, /lookupWebGpuCapture/);
  assert.match(host, /describeWebGpuEvent/);
  assert.match(host, /__ISPETTORE_WEBGPU_INSPECTOR__/);
  assert.doesNotMatch(host, /__ISPETTORE_WEBGPU_REPLAY__/);
  assert.doesNotMatch(host, /requestAdapter|requestDevice|createCommandEncoder|executeWebGpuCommand|createWebGpuReplayEnvironment/);
  assert.doesNotMatch(host, /navigator\.gpu|getContext\(["']webgpu/);
  const injected = await readFile('dist/injected.js', 'utf8');
  assert.doesNotMatch(injected, /takeFrameSnapshot|restoreCommand|frameStartSnapshot/);
});
