import { test, expect } from './fixtures.js';
import { openDemo, armWebGlAndWaitForFrame } from './helpers.js';
import { hashText } from '../../src/shared/storage/hash.js';

const MEBIBYTE = 1024 * 1024;

async function buildSyntheticPackage(demoPage, byteSize) {
  return demoPage.evaluate(async (size) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
    }
    return {
      schema: 'ispettore-webgl-capture',
      version: 1,
      context: {
        api: 'webgl',
        width: 64,
        height: 64,
        attributes: { alpha: false },
        capabilities: {},
        extensions: [],
        resizes: []
      },
      commands: [
        {
          op: 'bufferData',
          argTypes: ['number', 'typed-array:Uint8Array', 'number'],
          args: [0x8892, { blob: 'big' }, 0x88e4],
          resultId: null,
          failed: null,
          error: null
        }
      ],
      blobs: [{ id: 'big', arrayType: 'Uint8Array', byteLength: size, data: btoa(binary) }],
      frames: [],
      events: [],
      inspectionStatus: { level: 'supported', reasons: [] }
    };
  }, byteSize);
}

async function storageSnapshot(extensionWorker) {
  return extensionWorker.evaluate(async () => {
    const storage = globalThis.__ISPETTORE_STORAGE__;
    const [info, captures, indexes, pendingStatus] = await Promise.all([
      storage.getStorageInfo(),
      storage.listCaptures(),
      storage.getCaptureIndexes(),
      storage.getTransferStatus()
    ]);
    const session = await chrome.storage.session.get(null);
    return { info, captures, indexes, pendingStatus, sessionKeys: Object.keys(session) };
  });
}

async function openTransferClient(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
  return {
    send: (message) => page.evaluate(
      (payload) => chrome.runtime.sendMessage({ type: 'ISPETTORE_TRANSFER', ...payload }),
      message
    ),
    close: () => page.close()
  };
}

test('captures larger than the session-storage limit transfer, store, and inspect', async ({
  context,
  extensionId,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');

  const size = 12 * MEBIBYTE;
  const bigPackage = await buildSyntheticPackage(demoPage, size);
  const stored = await demoPage.evaluate((pkg) => window.__ISPETTORE__.storeWebGlPackage(pkg), bigPackage);

  expect(stored.ok).toBe(true);
  expect(stored.captureId).toBeTruthy();
  expect(stored.byteSize).toBeGreaterThan(12 * MEBIBYTE);

  const snapshot = await storageSnapshot(extensionWorker);
  const capture = snapshot.captures.find((entry) => entry.captureId === stored.captureId);
  expect(capture).toBeTruthy();
  expect(capture.version).toBe(1);
  expect(capture.meta.byteSize).toBeGreaterThan(12 * MEBIBYTE);
  expect(snapshot.info.usedBytes).toBeGreaterThan(12 * MEBIBYTE);
  expect(snapshot.indexes.map((entry) => entry.captureId)).toContain(stored.captureId);
  expect(
    snapshot.sessionKeys.some((key) => key !== 'ispettoreCaptureIndexes' && key !== 'ispettoreTransferStatus')
  ).toBe(false);

  const inspectionPage = await context.newPage();
  await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);
  const result = await inspectionPage.evaluate((captureId) => window.__ISPETTORE_WEBGL_INSPECTOR__.inspectStored(captureId), stored.captureId);
  expect(result.ok).toBe(true);
  expect(result.selectedCommandIndex).toBe(0);
  expect(['supported', 'degraded']).toContain(result.inspectionStatus.level);
  await inspectionPage.close();
});

test('interrupted and cancelled transfers never create apparently valid captures', async ({
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');

  const before = await storageSnapshot(extensionWorker);
  expect(before.captures).toHaveLength(0);

  const transferId = await demoPage.evaluate(async () => {
    const id = `interrupted-${Date.now()}`;
    const post = (message) => window.postMessage({ channel: 'ISPETTORE', ...message }, '*');
    post({
      type: 'TRANSFER_BEGIN',
      transferId: id,
      payload: {
        captureId: `capture-${Date.now()}`,
        schema: 'ispettore-webgl-capture',
        version: 1,
        chunkCount: 5,
        totalChars: 500,
        checksum: 'deadbeefdeadbeef',
        checksumAlgorithm: 'fnv',
        source: { url: location.href, capturedAt: new Date().toISOString() }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    post({ type: 'TRANSFER_CHUNK', transferId: id, index: 0, data: 'A'.repeat(100) });
    await new Promise((resolve) => setTimeout(resolve, 400));
    post({ type: 'TRANSFER_CHUNK', transferId: id, index: 1, data: 'B'.repeat(100) });
    await new Promise((resolve) => setTimeout(resolve, 400));
    return id;
  });

  const midTransfer = await storageSnapshot(extensionWorker);
  expect(midTransfer.captures).toHaveLength(0);
  expect(midTransfer.info.pendingTransferCount).toBe(1);
  expect(midTransfer.indexes).toHaveLength(0);

  await demoPage.evaluate((id) => {
    window.postMessage({ channel: 'ISPETTORE', type: 'TRANSFER_CANCEL', transferId: id }, '*');
  }, transferId);

  await expect
    .poll(async () => (await storageSnapshot(extensionWorker)).info.pendingTransferCount)
    .toBe(0);
  const after = await storageSnapshot(extensionWorker);
  expect(after.captures).toHaveLength(0);
  expect(after.indexes).toHaveLength(0);
});

test('invalid finalized packages atomically clean pending data and status', async ({
  context,
  extensionId,
  extensionWorker
}) => {
  const transferId = `invalid-${Date.now()}`;
  const captureId = `capture-${Date.now()}`;
  const text = '{}';
  const checksum = await hashText(text, { algorithm: 'fnv' });
  const client = await openTransferClient(context, extensionId);

  expect(await client.send({
    phase: 'begin',
    transferId,
    payload: {
      captureId,
      chunkCount: 1,
      totalChars: text.length,
      checksum: checksum.hex,
      checksumAlgorithm: checksum.algorithm
    }
  })).toEqual({ ok: true });
  expect(await client.send({ phase: 'chunk', transferId, index: 0, data: text }))
    .toMatchObject({ ok: true, receivedChunks: 1 });

  const finalized = await client.send({ phase: 'end', transferId });
  expect(finalized.ok).toBe(false);
  expect(finalized.error).toMatch(/capture|package|schema/i);

  const snapshot = await storageSnapshot(extensionWorker);
  expect(snapshot.captures).toHaveLength(0);
  expect(snapshot.info.pendingTransferCount).toBe(0);
  expect(snapshot.pendingStatus).toEqual({});
  await client.close();
});

test('concurrent pending transfers cannot reserve the same capture id', async ({
  context,
  extensionId,
  extensionWorker
}) => {
  const captureId = `shared-${Date.now()}`;
  const firstTransferId = `first-${Date.now()}`;
  const secondTransferId = `second-${Date.now()}`;
  const payload = {
    captureId,
    chunkCount: 1,
    totalChars: 2,
    checksum: '08f44b07b5901a25',
    checksumAlgorithm: 'fnv'
  };
  const client = await openTransferClient(context, extensionId);

  const [first, second] = await Promise.all([
    client.send({ phase: 'begin', transferId: firstTransferId, payload }),
    client.send({ phase: 'begin', transferId: secondTransferId, payload })
  ]);
  expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  expect([first, second].find((result) => !result.ok)?.error).toMatch(/Capture id is already in use/);

  const acceptedTransferId = first.ok ? firstTransferId : secondTransferId;
  await client.send({ phase: 'cancel', transferId: acceptedTransferId });
  const snapshot = await storageSnapshot(extensionWorker);
  expect(snapshot.info.pendingTransferCount).toBe(0);
  await client.close();
});

test('duplicate finalization commits a transfer exactly once', async ({
  context,
  extensionId,
  extensionWorker
}) => {
  const transferId = `duplicate-end-${Date.now()}`;
  const captureId = `capture-${Date.now()}`;
  const capture = {
    schema: 'ispettore-webgl-capture',
    version: 1,
    context: { api: 'webgl', width: 1, height: 1, attributes: {}, resizes: [] },
    commands: [
      { op: 'clear', argTypes: ['number'], args: [0x4000], resultId: null, failed: null, error: null }
    ],
    blobs: [],
    frames: [],
    events: [],
    inspectionStatus: { level: 'supported', reasons: [] }
  };
  const text = JSON.stringify(capture);
  const checksum = await hashText(text, { algorithm: 'fnv' });
  const client = await openTransferClient(context, extensionId);

  expect(await client.send({
    phase: 'begin',
    transferId,
    payload: {
      captureId,
      schema: capture.schema,
      version: capture.version,
      chunkCount: 1,
      totalChars: text.length,
      checksum: checksum.hex,
      checksumAlgorithm: checksum.algorithm
    }
  })).toEqual({ ok: true });
  expect(await client.send({ phase: 'chunk', transferId, index: 0, data: text }))
    .toMatchObject({ ok: true, receivedChunks: 1 });

  const results = await Promise.all([
    client.send({ phase: 'end', transferId }),
    client.send({ phase: 'end', transferId })
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)?.error).toMatch(/finalized|cancelled/);

  const snapshot = await storageSnapshot(extensionWorker);
  expect(snapshot.captures.map((entry) => entry.captureId)).toEqual([captureId]);
  expect(snapshot.info.pendingTransferCount).toBe(0);
  expect(snapshot.pendingStatus).toEqual({});
  await client.close();
});

test('stored captures export, import, and inspect without the original page', async ({
  context,
  extensionId,
  extensionWorker,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');
  await armWebGlAndWaitForFrame(demoPage);

  const stored = await demoPage.evaluate(() => window.__ISPETTORE__.storeWebGlPackage());
  expect(stored.ok).toBe(true);

  const inspectionPage = await context.newPage();
  await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);

  const original = await inspectionPage.evaluate((captureId) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    return api.inspectStored(captureId);
  }, stored.captureId);
  expect(original.ok).toBe(true);
  expect(original.color.range).toBeGreaterThan(10);

  const exported = await inspectionPage.evaluate((captureId) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    return api.exportStoredCapture(captureId);
  }, stored.captureId);
  expect(exported.ok).toBe(true);
  expect(JSON.parse(exported.data).commands.length).toBeGreaterThan(0);

  await demoPage.close();

  const imported = await inspectionPage.evaluate((data) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    return api.importCapture(data);
  }, exported.data);
  expect(imported.ok).toBe(true);
  expect(imported.captureId).not.toBe(stored.captureId);

  const inspected = await inspectionPage.evaluate((captureId) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    return api.inspectStored(captureId);
  }, imported.captureId);
  expect(inspected.ok).toBe(true);
  expect(inspected.selectedCommandIndex).toBe(original.selectedCommandIndex);
  expect(inspected.color).toEqual(original.color);

  const listed = await inspectionPage.evaluate((id) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    return api.listStoredCaptures();
  });
  const ids = listed.captures.map((entry) => entry.captureId);
  expect(ids).toContain(stored.captureId);
  expect(ids).toContain(imported.captureId);

  const removed = await inspectionPage.evaluate((id) => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    return api.deleteStoredCapture(id);
  }, imported.captureId);
  expect(removed.ok).toBe(true);

  const afterDelete = await storageSnapshot(extensionWorker);
  expect(afterDelete.captures.map((entry) => entry.captureId)).not.toContain(imported.captureId);
  expect(afterDelete.indexes.map((entry) => entry.captureId)).not.toContain(imported.captureId);

  await inspectionPage.close();
});

test('multiple captures from distinct packages never overwrite one another', async ({
  context,
  extensionId,
  demoPage
}) => {
  await openDemo(demoPage, 'webgl-simple');
  await armWebGlAndWaitForFrame(demoPage);

  const first = await demoPage.evaluate(() => window.__ISPETTORE__.storeWebGlPackage());
  expect(first.ok).toBe(true);

  const secondPackage = await buildSyntheticPackage(demoPage, 2 * MEBIBYTE);
  const second = await demoPage.evaluate((pkg) => window.__ISPETTORE__.storeWebGlPackage(pkg), secondPackage);
  expect(second.ok).toBe(true);
  expect(second.captureId).not.toBe(first.captureId);

  const inspectionPage = await context.newPage();
  await inspectionPage.goto(`chrome-extension://${extensionId}/inspection/webgl/host.html`);

  const listed = await inspectionPage.evaluate(() => {
    const api = window.__ISPETTORE_WEBGL_INSPECTOR__;
    return api.listStoredCaptures();
  });
  const ids = listed.captures.map((entry) => entry.captureId);
  expect(ids).toContain(first.captureId);
  expect(ids).toContain(second.captureId);

  const firstInspection = await inspectionPage.evaluate((id) => window.__ISPETTORE_WEBGL_INSPECTOR__.inspectStored(id), first.captureId);
  const secondInspection = await inspectionPage.evaluate((id) => window.__ISPETTORE_WEBGL_INSPECTOR__.inspectStored(id), second.captureId);
  expect(firstInspection.ok).toBe(true);
  expect(secondInspection.ok).toBe(true);
  expect(firstInspection.selectedCommandIndex).toBeGreaterThan(50);
  expect(secondInspection.selectedCommandIndex).toBe(0);

  await inspectionPage.close();
});
