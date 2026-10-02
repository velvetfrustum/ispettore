const KIND_GROUPS = [
  { id: 'draw', label: 'Draws', kinds: new Set(['draw']) },
  { id: 'clear', label: 'Clears', kinds: new Set(['clear']) },
  { id: 'transfer', label: 'Blits/copies', kinds: new Set(['blit', 'copy', 'dispatch', 'write']) }
];

export function buildPassGroups(events, commands) {
  const passes = [];
  let current = null;
  let currentKey = null;
  for (const event of events ?? []) {
    const command = commands?.[event.commandIndex];
    const pass = command?.semantic?.pass;
    const key = pass ? `${pass.index ?? '?'}:${pass.name ?? ''}` : 'unattributed';
    // New group on every pass change, even if the key recurs later — keeps EID order intact.
    if (!current || key !== currentKey) {
      current = {
        key,
        name: pass?.name || (Number.isInteger(pass?.index) ? `Pass ${pass.index}` : 'Unattributed'),
        index: Number.isInteger(pass?.index) ? pass.index : null,
        kind: pass?.kind ?? null,
        effect: pass?.effect ?? null,
        durationMs: 0,
        eventCount: 0,
        drawCount: 0,
        clearCount: 0,
        firstEid: null,
        lastEid: null,
        ticks: []
      };
      currentKey = key;
      passes.push(current);
    }
    const duration = Number(command?.durationMs);
    const safeDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0;
    current.durationMs += safeDuration;
    current.eventCount += 1;
    if (event.kind === 'draw') current.drawCount += 1;
    if (event.kind === 'clear') current.clearCount += 1;
    if (current.firstEid == null) current.firstEid = event.eid;
    current.lastEid = event.eid;
    current.ticks.push({ eid: event.eid, durationMs: safeDuration, kind: event.kind, step: pass?.step ?? null });
  }
  return passes.map((pass, position) => ({
    ...pass,
    share: passes.reduce((sum, candidate) => sum + candidate.durationMs, 0) > 0
      ? pass.durationMs / passes.reduce((sum, candidate) => sum + candidate.durationMs, 0)
      : 0,
    position
  }));
}

// Sub-steps within one pass (e.g. UnrealBloomPass's internal bright/blur/composite draws),
// grouped the same contiguous way as buildPassGroups. Callers should treat a single-entry
// result as "nothing to drill into" — it means no step info was recorded for this pass.
export function buildStepGroups(ticks) {
  const steps = [];
  let current = null;
  let currentKey = null;
  for (const tick of ticks ?? []) {
    const key = tick.step ? `${tick.step.index ?? '?'}:${tick.step.name ?? ''}` : 'no-step';
    if (!current || key !== currentKey) {
      current = {
        name: tick.step?.name || 'Pass',
        effect: tick.step?.effect ?? null,
        durationMs: 0,
        eventCount: 0,
        firstEid: null,
        lastEid: null,
        ticks: []
      };
      currentKey = key;
      steps.push(current);
    }
    const safeDuration = Number.isFinite(tick.durationMs) && tick.durationMs >= 0 ? tick.durationMs : 0;
    current.durationMs += safeDuration;
    current.eventCount += 1;
    if (current.firstEid == null) current.firstEid = tick.eid;
    current.lastEid = tick.eid;
    current.ticks.push(tick);
  }
  return steps;
}

/** Lays out pass regions by tick-count share, matching the equal-width flex row the ticks
 *  themselves render in below */
export function computeRegionLayout(passes) {
  const grandTotal = passes.reduce((sum, pass) => sum + pass.ticks.length, 0) || 1;
  let cursor = 0;
  return passes.map((pass) => {
    const width = (pass.ticks.length / grandTotal) * 100;
    const left = cursor;
    cursor += width;
    return { pass, left, width };
  });
}

export function buildFrameCostGroups(events, commands) {
  const groups = KIND_GROUPS.map((group) => ({
    ...group,
    durationMs: 0,
    eventCount: 0,
    firstEid: null,
    lastEid: null
  }));
  const byKind = new Map();
  for (const group of groups) {
    for (const kind of group.kinds) byKind.set(kind, group);
  }
  const other = { id: 'other', label: 'Other', kinds: null, durationMs: 0, eventCount: 0, firstEid: null, lastEid: null };
  let totalMs = 0;

  for (const event of events ?? []) {
    const command = commands?.[event.commandIndex];
    const duration = command?.durationMs;
    const safeDuration = duration != null && Number.isFinite(duration) && duration >= 0 ? duration : 0;
    totalMs += safeDuration;
    const target = byKind.get(event.kind) ?? other;
    target.durationMs += safeDuration;
    target.eventCount += 1;
    if (target.firstEid == null) target.firstEid = event.eid;
    target.lastEid = event.eid;
  }

  const present = [...groups, other].filter((group) => group.eventCount > 0 || group.durationMs > 0);
  return {
    totalMs,
    timedEvents: (events ?? []).filter((event) => {
      const duration = commands?.[event.commandIndex]?.durationMs;
      return duration != null && Number.isFinite(duration) && duration >= 0;
    }).length,
    groups: present.map((group) => ({
      ...group,
      share: totalMs > 0 ? group.durationMs / totalMs : 0
    }))
  };
}
