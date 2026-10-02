import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeHostFailure } from '../../src/ui/hostErrors.js';

test('timeout failures get recovery guidance', () => {
  const message = describeHostFailure(new Error('Capture host did not respond within 30 seconds'));
  assert.match(message, /did not respond within 30 seconds/);
  assert.match(message, /Close and reopen Ispettore/);
});

test('missing captures point at refreshing the stored list', () => {
  for (const raw of ['Capture not found', 'Capture is not loaded']) {
    const message = describeHostFailure(new Error(raw));
    assert.match(message, /no longer stored|gone or was evicted/);
    assert.match(message, /Refresh the stored captures list/);
  }
});

test('storage failures surface the underlying reason and a next step', () => {
  const message = describeHostFailure(new Error('IndexedDB transaction aborted'));
  assert.match(message, /Capture storage failed/);
  assert.match(message, /IndexedDB transaction aborted/);
  assert.match(message, /extension-origin IndexedDB/);
});

test('unknown errors pass through unchanged', () => {
  assert.equal(describeHostFailure(new Error('boom')), 'boom');
});

test('unsupported or corrupt import files explain the accepted package versions', () => {
  for (const raw of [
    'Unsupported WebGL capture package',
    'Imported capture is not valid JSON: Unexpected token x',
    'Imported capture is empty'
  ]) {
    const message = describeHostFailure(new Error(raw));
    assert.match(message, /version 1\)/);
  }
});
