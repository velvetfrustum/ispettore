import { webGlEventKind } from './events.js';

export function isDrawOp(op) {
  return webGlEventKind(op) === 'draw';
}

function summarizeArg(value) {
  if (value == null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value?.blob != null) return `blob:${value.blob}`;
  if (value?.ref != null) return value.ref;
  return String(value);
}

function summarizeCommandArgs(command) {
  if (!Array.isArray(command?.args)) return null;
  return command.args.map(summarizeArg).join(' ');
}

export function summarizeCommand(command) {
  const base = { commandIndex: command.commandIndex, op: command.op };  if (command.failed) {
    return {
      ...base,
      failed: command.failed,
      error: command.error ?? null,
      summary: `${command.op} [failed: ${command.failed}]`
    };
  }
  const argsSummary = summarizeCommandArgs(command);
  return {
    ...base,
    argTypes: command.argTypes ?? null,
    semantic: command.semantic ?? null,
    summary: argsSummary ? `${command.op} ${argsSummary}` : command.op
  };
}

/**
 * Builds a compact, blob-free view of a WebGL2 capture package for panel rendering.
 * Blob payloads are replaced by their ids so the view stays small; inspection always uses
 * the full stored package on the isolated host.
 */
export function describeWebGlCapture(capture) {
  const blobs = Array.isArray(capture?.blobs) ? capture.blobs : [];
  const rawCommands = Array.isArray(capture?.commands) ? capture.commands : [];
  const commands = rawCommands.map((command, commandIndex) => {
    const args = Array.isArray(command?.args)
      ? command.args.map((value) =>
          value && typeof value === 'object' && value.blob != null ? { blob: value.blob } : value
        )
      : command.args;
    return {
      commandIndex,
      op: command.op ?? 'unknown',
      argTypes: command.argTypes ?? null,
      args,
      resultId: command.resultId ?? null,
      failed: command.failed ?? null,
      error: command.error ?? null,
      semantic: command.semantic ?? null,
      status: command.status ?? null,
      durationMs: Number.isFinite(command.durationMs) ? command.durationMs : null
    };
  });

  return {
    schema: capture.schema ?? null,
    version: capture.version ?? null,
    capturedAt: capture.capturedAt ?? null,
    context: capture.context ?? null,
    inspectionStatus: capture.inspectionStatus ?? { level: 'supported', reasons: [] },
    frames: Array.isArray(capture.frames) ? capture.frames : [],
    events: Array.isArray(capture.events) ? capture.events : [],
    commands,
    blobCount: blobs.length,
    blobBytes: blobs.reduce((sum, blob) => sum + (blob?.byteLength ?? 0), 0)
  };
}

export function buildEventIndex(view) {
  const byEid = new Map();
  const byObjectUuid = new Map();
  for (const event of view.events ?? []) {
    const command = view.commands?.[event.commandIndex] ?? null;
    const semantic = command?.semantic ?? null;
    const entry = { ...event, command, semantic };
    byEid.set(event.eid, entry);
    const uuid = semantic?.object?.uuid;
    if (uuid != null) {
      const ids = byObjectUuid.get(uuid) ?? new Set();
      ids.add(event.eid);
      byObjectUuid.set(uuid, ids);
    }
  }
  return { byEid, byObjectUuid };
}

export function preferredPreviewEvent(events) {
  const list = events ?? [];
  return [...list].reverse().find((event) => event.kind !== 'clear') ?? list.at(-1) ?? null;
}
