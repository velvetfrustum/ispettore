import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrameCostGroups, buildPassGroups, buildStepGroups, computeRegionLayout } from '../../src/ui/frameCost.js';

function event(eid, commandIndex, kind) {
  return { eid, commandIndex, frameId: 'frame:1', kind, op: kind, label: kind };
}

test('groups durations by event kind and computes shares', () => {
  const commands = [
    { durationMs: null },
    { durationMs: 2 },
    { durationMs: 6 },
    { durationMs: 1 },
    { durationMs: 1 }
  ];
  const events = [
    event(1, 1, 'clear'),
    event(2, 2, 'draw'),
    event(3, 3, 'draw'),
    event(4, 4, 'blit')
  ];
  const { totalMs, timedEvents, groups } = buildFrameCostGroups(events, commands);
  assert.equal(totalMs, 10);
  assert.equal(timedEvents, 4);
  const byId = Object.fromEntries(groups.map((group) => [group.id, group]));
  assert.equal(byId.draw.durationMs, 7);
  assert.equal(byId.draw.eventCount, 2);
  assert.equal(byId.draw.share, 0.7);
  assert.equal(byId.clear.durationMs, 2);
  assert.equal(byId.transfer.durationMs, 1);
  assert.ok(!byId.other);
  assert.equal(byId.draw.firstEid, 2);
  assert.equal(byId.draw.lastEid, 3);
});

test('unknown kinds fall into the other group', () => {
  const { groups, totalMs } = buildFrameCostGroups([event(1, 0, 'mystery-op')], [{ durationMs: 4 }]);
  const other = groups.find((group) => group.id === 'other');
  assert.equal(other.durationMs, 4);
  assert.equal(other.eventCount, 1);
  assert.equal(totalMs, 4);
  assert.equal(groups.find((group) => group.id === 'draw'), undefined);
});

test('untimed events still count but contribute no duration', () => {
  const { totalMs, timedEvents, groups } = buildFrameCostGroups(
    [event(1, 0, 'draw'), event(2, 1, 'clear')],
    [{}, {}]
  );
  assert.equal(totalMs, 0);
  assert.equal(timedEvents, 0);
  const draw = groups.find((group) => group.id === 'draw');
  assert.equal(draw.eventCount, 1);
  assert.equal(draw.durationMs, 0);
});

test('null durations are untimed, zero durations are timed', () => {
  const { totalMs, timedEvents } = buildFrameCostGroups(
    [event(1, 0, 'draw'), event(2, 1, 'draw'), event(3, 2, 'clear')],
    [{ durationMs: null }, { durationMs: 0 }, { durationMs: 1.5 }]
  );
  assert.equal(totalMs, 1.5);
  assert.equal(timedEvents, 2);
});

test('empty input yields an empty group list', () => {
  const { groups, totalMs } = buildFrameCostGroups([], []);
  assert.deepEqual(groups, []);
  assert.equal(totalMs, 0);
});

function passEvent(eid, commandIndex, kind) {
  return { eid, commandIndex, frameId: 'frame:1', kind, op: kind, label: kind };
}

test('buildPassGroups keeps chronological EID order when a pass recurs non-contiguously', () => {
  const events = [
    passEvent(1, 0, 'clear'),
    passEvent(2, 1, 'draw'),
    passEvent(3, 2, 'clear'),
    passEvent(4, 3, 'draw')
  ];
  const commands = [
    { durationMs: 1, semantic: { pass: null } },
    { durationMs: 1, semantic: { pass: { index: 0, name: 'RenderPass' } } },
    { durationMs: 1, semantic: { pass: null } },
    { durationMs: 1, semantic: { pass: { index: 1, name: 'Afterimage' } } }
  ];

  const passes = buildPassGroups(events, commands);

  assert.equal(passes.length, 4);
  assert.equal(passes[0].name, 'Unattributed');
  assert.deepEqual(passes[0].ticks.map((t) => t.eid), [1]);
  assert.equal(passes[1].name, 'RenderPass');
  assert.deepEqual(passes[1].ticks.map((t) => t.eid), [2]);
  assert.equal(passes[2].name, 'Unattributed');
  assert.deepEqual(passes[2].ticks.map((t) => t.eid), [3]);
  assert.equal(passes[3].name, 'Afterimage');
  assert.deepEqual(passes[3].ticks.map((t) => t.eid), [4]);
});

test('buildStepGroups splits a pass into its internal sub-steps', () => {
  const ticks = [
    { eid: 1, durationMs: 1, step: { index: 0, name: 'Bright pass' } },
    { eid: 2, durationMs: 1, step: { index: 1, name: 'Blur H' } },
    { eid: 3, durationMs: 1, step: { index: 1, name: 'Blur H' } },
    { eid: 4, durationMs: 1, step: { index: 2, name: 'Composite', effect: 'bloom-combine' } }
  ];

  const steps = buildStepGroups(ticks);

  assert.equal(steps.length, 3);
  assert.equal(steps[0].name, 'Bright pass');
  assert.deepEqual(steps[0].ticks.map((t) => t.eid), [1]);
  assert.equal(steps[1].name, 'Blur H');
  assert.deepEqual(steps[1].ticks.map((t) => t.eid), [2, 3]);
  assert.equal(steps[2].name, 'Composite');
  assert.equal(steps[2].effect, 'bloom-combine');
});

test('buildStepGroups returns a single group when no step info was recorded', () => {
  const ticks = [{ eid: 1, durationMs: 1, step: null }, { eid: 2, durationMs: 1, step: null }];
  const steps = buildStepGroups(ticks);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].eventCount, 2);
});

test('computeRegionLayout sizes regions by tick count so boundaries match the equal-width ticks row', () => {
  const passes = [
    { name: 'A', durationMs: 100, ticks: [{ eid: 1 }] },
    { name: 'B', durationMs: 1, ticks: [{ eid: 2 }] },
    { name: 'C', durationMs: 1, ticks: [{ eid: 3 }, { eid: 4 }] }
  ];

  const regions = computeRegionLayout(passes);

  assert.equal(regions.length, 3);
  assert.equal(regions[0].left, 0);
  assert.equal(regions[0].width, 25);
  assert.equal(regions[1].left, 25);
  assert.equal(regions[1].width, 25);
  assert.equal(regions[2].left, 50);
  assert.equal(regions[2].width, 50);
  const total = regions.reduce((sum, r) => sum + r.width, 0);
  assert.equal(total, 100);
});

test('computeRegionLayout handles an empty pass list without dividing by zero', () => {
  assert.deepEqual(computeRegionLayout([]), []);
});

test('buildPassGroups merges consecutive events from the same pass into one region', () => {
  const events = [passEvent(1, 0, 'clear'), passEvent(2, 1, 'draw'), passEvent(3, 2, 'draw')];
  const commands = [
    { durationMs: 1, semantic: { pass: { index: 0, name: 'Scene' } } },
    { durationMs: 2, semantic: { pass: { index: 0, name: 'Scene' } } },
    { durationMs: 3, semantic: { pass: { index: 0, name: 'Scene' } } }
  ];

  const passes = buildPassGroups(events, commands);

  assert.equal(passes.length, 1);
  assert.equal(passes[0].eventCount, 3);
  assert.equal(passes[0].durationMs, 6);
  assert.deepEqual(passes[0].ticks.map((t) => t.eid), [1, 2, 3]);
});
