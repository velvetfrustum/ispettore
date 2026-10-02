import test from 'node:test';
import assert from 'node:assert/strict';
import { installModelAssetTracker, modelAssetFromEntry, modelFormatOf } from '../../src/backend/modelAssets.js';

test('model formats are detected from the URL path, ignoring query and hash', () => {
  assert.equal(modelFormatOf('https://threejs.org/examples/models/obj/male02/male02.obj'), 'obj');
  assert.equal(modelFormatOf('https://example.com/Flower.GLB?v=3#x'), 'glb');
  assert.equal(modelFormatOf('scene.gltf', 'https://example.com/a/'), 'gltf');
  assert.equal(modelFormatOf('https://example.com/texture.png'), null);
  assert.equal(modelFormatOf('https://example.com/file.obj.png'), null);
  assert.equal(modelFormatOf('https://example.com/?file=model.obj'), null);
  assert.equal(modelFormatOf('not a url'), null);
});

test('resource entries become model assets with file name and size', () => {
  const asset = modelAssetFromEntry({
    name: 'https://threejs.org/examples/models/obj/male02/male%2002.obj',
    initiatorType: 'fetch',
    decodedBodySize: 0,
    encodedBodySize: 1234,
    transferSize: 1500
  });
  assert.deepEqual(asset, {
    url: 'https://threejs.org/examples/models/obj/male02/male%2002.obj',
    fileName: 'male 02.obj',
    format: 'obj',
    formatLabel: 'Wavefront OBJ',
    byteSize: 1234,
    initiatorType: 'fetch'
  });
  assert.equal(modelAssetFromEntry({ name: 'https://example.com/a.js' }), null);
  assert.equal(modelAssetFromEntry({}), null);
});

test('tracker collects buffered and observed entries once per URL', () => {
  let observerCallback = null;
  const win = {
    location: { href: 'https://example.com/' },
    performance: {
      getEntriesByType: () => [
        { name: 'https://example.com/a.glb', encodedBodySize: 10 },
        { name: 'https://example.com/style.css' }
      ]
    },
    PerformanceObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }
      observe(options) {
        assert.deepEqual(options, { type: 'resource', buffered: true });
      }
    }
  };
  const tracker = installModelAssetTracker(win);
  observerCallback({
    getEntries: () => [
      { name: 'https://example.com/a.glb', encodedBodySize: 10 },
      { name: 'https://example.com/b.gltf', decodedBodySize: 20 }
    ]
  });
  assert.deepEqual(
    tracker.list().map((asset) => [asset.fileName, asset.format, asset.byteSize]),
    [
      ['a.glb', 'glb', 10],
      ['b.gltf', 'gltf', 20]
    ]
  );
});
