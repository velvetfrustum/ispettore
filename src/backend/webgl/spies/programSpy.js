// Generous enough for real shaders (three.js's built-in MeshStandardMaterial shaders run
// 5-10KB once chunks are inlined) while still bounding the live snapshot pushed through
// chrome.storage.session.
export const MAX_SHADER_SOURCE_LENGTH = 20000;

function findShader(ctx, program, shaderType) {
  const attached = ctx.getAttachedShaders?.(program);
  if (!attached) return null;
  return attached.find((shader) => ctx.getShaderParameter(shader, ctx.SHADER_TYPE) === shaderType) ?? null;
}

export function installProgramSpy(ctx, programs, { runInspection = (inspect) => inspect() } = {}) {
  if (!ctx?.linkProgram || ctx.__ispettoreProgramSpyInstalled) return;
  ctx.__ispettoreProgramSpyInstalled = true;

  const linkProgram = ctx.linkProgram.bind(ctx);
  ctx.linkProgram = function (program) {
    const result = linkProgram(program);
    runInspection(() => {
      try {
        const shaders = [];
        const attributeCount = ctx.getProgramParameter(program, ctx.ACTIVE_ATTRIBUTES);
        const vertexShader = findShader(ctx, program, ctx.VERTEX_SHADER);
        const fragmentShader = findShader(ctx, program, ctx.FRAGMENT_SHADER);
        const vertexSource = vertexShader ? ctx.getShaderSource(vertexShader) : null;
        const fragmentSource = fragmentShader ? ctx.getShaderSource(fragmentShader) : null;
        if (typeof vertexSource === 'string') {
          shaders.push({ type: 'vertex', source: vertexSource.slice(0, MAX_SHADER_SOURCE_LENGTH) });
        }
        if (typeof fragmentSource === 'string') {
          shaders.push({ type: 'fragment', source: fragmentSource.slice(0, MAX_SHADER_SOURCE_LENGTH) });
        }
        programs.set(program, {
          label: programs.get(program)?.label ?? `program#${programs.size + 1}`,
          shaders,
          attributeCount
        });
      } catch (_) {
        /* context may be lost */
      }
    });
    return result;
  };
}
