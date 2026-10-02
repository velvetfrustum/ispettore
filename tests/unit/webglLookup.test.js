import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lookupWebGlCapture } from '../../src/inspection/webgl/lookup.js';

function makeCapture({ commands, events, inspectionStatus } = {}) {
  return {
    context: { width: 64, height: 64 },
    commands,
    events,
    inspectionStatus: inspectionStatus ?? { level: 'supported', reasons: [] }
  };
}

const command = (op, preview = null, extra = {}) => ({ op, preview, ...extra });

describe('WebGL inspection lookup (Spector-style baked previews)', () => {
  it('returns the preview baked directly onto the target command', () => {
    const capture = makeCapture({
      commands: [
        command('bindBuffer'),
        command('clear', { width: 64, height: 64, color: { range: 5 }, colorTarget: 'default', reasons: [] })
      ],
      events: [{ eid: 1, commandIndex: 1, kind: 'clear', op: 'clear', label: 'clear' }]
    });

    const result = lookupWebGlCapture(capture, { eid: 1 });
    assert.equal(result.selectedCommandIndex, 1);
    assert.deepEqual(result.color, { range: 5 });
    assert.equal(result.colorTarget, 'default');
    assert.equal(result.inspectionStatus.level, 'supported');
  });

  it('walks backward to the nearest preceding preview for a non-significant command index', () => {
    const capture = makeCapture({
      commands: [
        command('clear', { width: 8, height: 8, color: { range: 9 }, colorTarget: 'default', reasons: [] }),
        command('bindTexture'),
        command('uniform1f')
      ],
      events: [{ eid: 1, commandIndex: 0, kind: 'clear', op: 'clear', label: 'clear' }]
    });

    // CMD 2 (uniform1f) never renders anything itself — the nearest true picture is CMD 0's.
    const result = lookupWebGlCapture(capture, { commandIndex: 2 });
    assert.equal(result.selectedCommandIndex, 2);
    assert.deepEqual(result.color, { range: 9 });
  });

  it('reports a degraded, empty result when nothing has drawn yet at the requested point', () => {
    const capture = makeCapture({
      commands: [command('bindBuffer'), command('bufferData')],
      events: []
    });

    const result = lookupWebGlCapture(capture, { commandIndex: 1 });
    assert.equal(result.color, null);
    assert.equal(result.inspectionStatus.level, 'degraded');
    assert.ok(result.inspectionStatus.reasons.some((reason) => reason.includes('no draw')));
  });

  it('defaults to the last command when no stop target is given', () => {
    const capture = makeCapture({
      commands: [command('clear', { width: 4, height: 4, color: { range: 1 }, colorTarget: 'default', reasons: [] })],
      events: [{ eid: 1, commandIndex: 0, kind: 'clear', op: 'clear', label: 'clear' }]
    });

    const result = lookupWebGlCapture(capture, {});
    assert.equal(result.selectedCommandIndex, 0);
  });

  it('rejects an unknown eid and an out-of-range command index', () => {
    const capture = makeCapture({ commands: [command('clear')], events: [] });

    assert.throws(() => lookupWebGlCapture(capture, { eid: 999 }), /is not in the capture/);
    assert.throws(() => lookupWebGlCapture(capture, { commandIndex: 5 }), /out of range/);
  });

  it('combines a preview-level degradation reason with the capture-level inspectionStatus', () => {
    const capture = makeCapture({
      commands: [
        command('clear', {
          width: 4,
          height: 4,
          color: { range: 1 },
          colorTarget: 'framebuffer',
          reasons: ['preview readback failed: boom']
        })
      ],
      events: [{ eid: 1, commandIndex: 0, kind: 'clear', op: 'clear', label: 'clear' }],
      inspectionStatus: { level: 'degraded', reasons: ['captured command is missing from the package: foo'] }
    });

    const result = lookupWebGlCapture(capture, { eid: 1 });
    assert.equal(result.inspectionStatus.level, 'degraded');
    assert.deepEqual(result.inspectionStatus.reasons, [
      'captured command is missing from the package: foo',
      'preview readback failed: boom'
    ]);
  });

  it('surfaces each event GPU timing baked onto its command as a per-eid map', () => {
    const capture = makeCapture({
      commands: [
        command('clear', { width: 4, height: 4, color: { range: 1 }, colorTarget: 'default', reasons: [] }, { gpuTimingMs: 0.42 }),
        command('drawArrays', { width: 4, height: 4, color: { range: 2 }, colorTarget: 'default', reasons: [] }, { gpuTimingMs: 1.1 })
      ],
      events: [
        { eid: 1, commandIndex: 0, kind: 'clear', op: 'clear', label: 'clear' },
        { eid: 2, commandIndex: 1, kind: 'draw', op: 'drawArrays', label: 'draw' }
      ]
    });

    const result = lookupWebGlCapture(capture, { eid: 2 });
    assert.deepEqual(result.timings, { 1: 0.42, 2: 1.1 });
  });
});
