import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('all demos use only local runtime modules and assets', async () => {
  const entries = await readdir('demos', { withFileTypes: true });
  const htmlFiles = ['demos/index.html'];
  for (const entry of entries) {
    if (entry.isDirectory()) htmlFiles.push(path.join('demos', entry.name, 'index.html'));
  }

  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, 'utf8');
    assert.doesNotMatch(
      html,
      /<(?:script|img|link)\b[^>]*(?:src|href)=["']https?:\/\//i,
      `${htmlFile} loads a remote runtime resource`
    );

    for (const match of html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)) {
      const importMap = JSON.parse(match[1]);
      for (const [specifier, url] of Object.entries(importMap.imports || {})) {
        assert.doesNotMatch(url, /^(?:[a-z]+:)?\/\//i, `${htmlFile} maps ${specifier} to non-local URL ${url}`);
      }
    }
  }
});

test('demo server dependency is pinned to the supported Three.js revision', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(packageJson.devDependencies.three, '0.184.0');
});
