import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installProgramSpy } from '../../src/backend/webgl/spies/programSpy.js';

function createContext() {
  const vertex = { type: 1 };
  const fragment = { type: 2 };
  let links = 0;
  return {
    ACTIVE_ATTRIBUTES: 10,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    SHADER_TYPE: 3,
    vertex,
    fragment,
    get links() {
      return links;
    },
    linkProgram() {
      links++;
      return 'linked';
    },
    getProgramParameter: () => 4,
    getAttachedShaders: () => [vertex, fragment],
    getShaderParameter: (shader) => shader.type,
    getShaderSource: (shader) => (shader === vertex ? 'vertex source' : 'fragment source')
  };
}

describe('programSpy', () => {
  it('records linked WebGL program metadata', () => {
    const ctx = createContext();
    const programs = new Map();
    const program = {};

    installProgramSpy(ctx, programs);
    assert.equal(ctx.linkProgram(program), 'linked');
    assert.equal(ctx.links, 1);
    assert.deepEqual(programs.get(program), {
      label: 'program#1',
      shaders: [
        { type: 'vertex', source: 'vertex source' },
        { type: 'fragment', source: 'fragment source' }
      ],
      attributeCount: 4
    });
  });

  it('does not wrap a context twice and tolerates inspection failures', () => {
    const ctx = createContext();
    const programs = new Map();
    installProgramSpy(ctx, programs);
    const wrapped = ctx.linkProgram;
    installProgramSpy(ctx, programs);
    assert.equal(ctx.linkProgram, wrapped);

    ctx.getProgramParameter = () => {
      throw new Error('context lost');
    };
    assert.equal(ctx.linkProgram({}), 'linked');
    assert.equal(ctx.links, 1);
    assert.equal(programs.size, 0);
  });

  it('keeps a stable label when a program is relinked', () => {
    const ctx = createContext();
    const programs = new Map();
    const program = {};
    installProgramSpy(ctx, programs);

    ctx.linkProgram(program);
    ctx.linkProgram(program);
    assert.equal(programs.get(program).label, 'program#1');
    assert.equal(programs.size, 1);
  });

  it('runs debugger introspection inside the supplied capture guard', () => {
    const ctx = createContext();
    const programs = new Map();
    let guarded = false;
    installProgramSpy(ctx, programs, {
      runInspection(inspect) {
        guarded = true;
        return inspect();
      }
    });

    ctx.linkProgram({});
    assert.equal(guarded, true);
  });
});
