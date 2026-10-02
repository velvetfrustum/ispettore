import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashText } from '../../src/shared/storage/hash.js';
import {
  TransferError,
  TRANSFER_CHUNK_CHARS,
  createTransferId,
  parseTransferPackage,
  planTransfer,
  reassembleChunks,
  splitIntoChunks,
  verifyTransfer
} from '../../src/shared/storage/transferProtocol.js';

function sampleText(size) {
  let text = '';
  for (let index = 0; index < size; index += 1) text += String.fromCharCode(97 + (index % 26));
  return text;
}

describe('transfer protocol', () => {
  it('plans a single chunk for small payloads', () => {
    const plan = planTransfer('hello', 1024);
    assert.equal(plan.chunkCount, 1);
    assert.equal(plan.totalChars, 5);
    assert.equal(plan.chunkChars, 1024);
  });

  it('plans multiple chunks and keeps chunk ordering', () => {
    const text = sampleText(100);
    const plan = planTransfer(text, 8);
    assert.equal(plan.chunkCount, 13);
    assert.equal(plan.totalChars, 100);

    const chunks = splitIntoChunks(text, 8);
    assert.equal(chunks.length, plan.chunkCount);
    assert.deepEqual(chunks.map((chunk) => chunk.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(reassembleChunks(chunks, plan), text);
  });

  it('defaults chunk size and refuses invalid sizes', () => {
    assert.equal(TRANSFER_CHUNK_CHARS, 1024 * 1024);
    assert.equal(planTransfer('abc', 0).chunkChars, TRANSFER_CHUNK_CHARS);
    assert.equal(planTransfer('abc', -3).chunkChars, TRANSFER_CHUNK_CHARS);
  });

  it('rejects missing, duplicated, and out-of-range chunks', () => {
    const text = sampleText(30);
    const chunks = splitIntoChunks(text, 10);

    assert.throws(() => reassembleChunks(chunks.slice(1), { chunkCount: 3 }), /incomplete/);
    assert.throws(
      () => reassembleChunks([chunks[0], chunks[0], chunks[1]], { chunkCount: 3 }),
      /more than once/
    );
    assert.throws(() => reassembleChunks([chunks[1], chunks[2]]), /missing chunk 0/);
    assert.throws(() => reassembleChunks(chunks, { chunkCount: 3, totalChars: 99 }), /character count/);
    assert.throws(() => reassembleChunks([{ index: -1, data: 'x' }]), /invalid/);
  });

  it('verifies a complete transfer with a matching checksum', async () => {
    const text = sampleText(50);
    const chunks = splitIntoChunks(text, 16);
    const checksum = await hashText(text);

    const reassembled = await verifyTransfer(chunks, {
      chunkCount: chunks.length,
      totalChars: text.length,
      checksum: checksum.hex,
      checksumAlgorithm: checksum.algorithm
    });
    assert.equal(reassembled, text);
  });

  it('rejects a transfer whose checksum does not match', async () => {
    const text = sampleText(50);
    const chunks = splitIntoChunks(text, 16);
    const checksum = await hashText(text + '!');
    await assert.rejects(
      verifyTransfer(chunks, {
        chunkCount: chunks.length,
        totalChars: text.length,
        checksum: checksum.hex,
        checksumAlgorithm: checksum.algorithm
      }),
      /checksum mismatch/
    );
  });

  it('parses package JSON and rejects invalid text', () => {
    assert.deepEqual(parseTransferPackage('{"a":1}'), { a: 1 });
    assert.throws(() => parseTransferPackage('not json'), TransferError);
    assert.throws(() => parseTransferPackage('not json'), /not valid JSON/);
  });

  it('generates distinct transfer ids', () => {
    assert.notEqual(createTransferId(), createTransferId());
    assert.ok(String(createTransferId()).length > 0);
  });
});