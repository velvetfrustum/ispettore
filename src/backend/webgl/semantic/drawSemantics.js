import { resolveWebGlObjectId } from '../capture/objectRegistry.js';
import { webGlEventKind } from '../../../inspection/webgl/events.js';

const ANNOTATED_TEXTURE_UNITS = 8;
const PASS_ONLY_KINDS = new Set(['clear', 'blit', 'copy']);

export function isWebGlDrawOp(name) {
  return webGlEventKind(name) === 'draw';
}

/**
 * Builds the WebGL2 draw-event projection: one annotate function that maps a
 * journaled draw command to the Three.js object, material, program, bound textures, and
 * composer pass that produced it. Page-side state reaches this module only through the
 * injected accessors, so no legacy inspector code is imported here.
 */
export function createWebGlDrawSemantics({
  getRenderObject,
  getActivePass,
  getProgramEntry,
  getTextureEntry,
  summarizeMesh
}) {
  return function annotateWebGlDraw({ descriptor, nativeGetParameter, nativeActiveTexture, context }) {
    if (!descriptor) return null;
    const isDraw = isWebGlDrawOp(descriptor.name);
    if (!isDraw && !PASS_ONLY_KINDS.has(webGlEventKind(descriptor.name))) return null;

    const semantic = { object: null, material: null, program: null, textures: [], pass: null };

    if (isDraw) {
      const current = getRenderObject?.() ?? null;
      if (current?.object) {
        semantic.object = {
          uuid: current.object.uuid ?? null,
          name: current.object.name || null,
          type: current.object.type ?? null,
          summary: summarizeMesh ? summarizeMesh(current.object) : null
        };
      }
      if (current?.material) {
        const material = current.material;
        const materialList = Array.isArray(material);
        const first = materialList ? material[0] : material;
        semantic.material = {
          type: first?.type ?? null,
          name: first?.name || null,
          label: first?.name || first?.type || 'Material',
          index: materialList ? (current.group?.materialIndex ?? null) : null,
          transparent: first?.transparent ?? null
        };
      }
    }

    const pass = getActivePass?.() ?? null;
    if (pass) {
      const step = pass.role === 'composer' ? pass.currentStep : pass.step;
      semantic.pass = {
        index: pass.index ?? null,
        name: pass.name ?? null,
        kind: pass.kind ?? null,
        role: pass.role ?? null,
        renderTarget: pass.renderTarget ?? null,
        effect: pass.effect ?? null,
        step: step ? { index: step.index ?? null, name: step.name ?? null, effect: step.effect ?? null } : null
      };
    }

    if (isDraw && nativeGetParameter && context) {
      try {
        const program = nativeGetParameter.call(context, context.CURRENT_PROGRAM);
        if (program) {
          const programEntry = getProgramEntry ? getProgramEntry(program) : null;
          semantic.program = {
            ref: resolveWebGlObjectId(context, program),
            label: programEntry?.label ?? null
          };
        }
        if (nativeActiveTexture && context.TEXTURE0 != null) {
          const previousUnit = nativeGetParameter.call(context, context.ACTIVE_TEXTURE);
          if (Number.isInteger(previousUnit)) {
            try {
              for (let unit = 0; unit < ANNOTATED_TEXTURE_UNITS; unit++) {
                nativeActiveTexture.call(context, context.TEXTURE0 + unit);
                const texture = nativeGetParameter.call(context, context.TEXTURE_BINDING_2D);
                if (!texture) continue;
                const entry = getTextureEntry ? getTextureEntry(texture) : null;
                const width = entry?.width ?? null;
                const height = entry?.height ?? null;
                semantic.textures.push({
                  ref: resolveWebGlObjectId(context, texture),
                  target: 'TEXTURE_2D',
                  width,
                  height,
                  label: `TEXTURE_2D${width && height ? ` ${width}×${height}` : ''}`
                });
              }
            } finally {
              nativeActiveTexture.call(context, previousUnit);
            }
          }
        }
      } catch (_) {
        /* semantic annotation is best-effort and must not break capture */
      }
    }
    return semantic;
  };
}
