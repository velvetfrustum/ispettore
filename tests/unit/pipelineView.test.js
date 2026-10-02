import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPipelineStages } from '../../src/ui/pipelineView.js';
import { renderEventDetails } from '../../src/ui/detailsView.js';

const states = [
  { name: 'CullState', entries: { CULL_FACE: true, CULL_FACE_MODE: 'BACK' }, commands: { valid: [3], redundant: [], disabled: [] } },
  { name: 'DrawState', entries: { VIEWPORT: [0, 0, 4, 4], DITHER: true, FRAGMENT_SHADER_DERIVATIVE_HINT: 'DONT_CARE' }, commands: { valid: [], redundant: [], disabled: [] } },
  { name: 'ScissorState', entries: { SCISSOR_TEST: false, SCISSOR_BOX: [0, 0, 4, 4] }, commands: { valid: [], redundant: [], disabled: [5] } }
];

function drawResult() {
  return {
    command: { commandIndex: 7, op: 'drawArrays', durationMs: 0.1, gpuTimingMs: null },
    program: {
      shaders: [
        { type: 'vertex', source: 'uniform mat4 modelViewMatrix;\nvoid main() {}' },
        { type: 'fragment', source: 'uniform vec3 diffuse;\nuniform sampler2D map;\nvoid main() {}' }
      ]
    },
    details: {
      command: { name: 'drawArrays', help: null, arguments: [{ name: 'mode', value: 'TRIANGLES' }] },
      stackTrace: ['at render (app.js:1:1)'],
      states,
      frameBuffer: { frameBuffer: null, target: 'canvas', width: 4, height: 4 },
      drawCall: {
        programStatus: { program: 'ctx-1:program-1', label: 'program#1', LINK_STATUS: true, VALIDATE_STATUS: false },
        shaders: [{ type: 'vertex', shaderType: 'VERTEX_SHADER', COMPILE_STATUS: true, DELETE_STATUS: false, shader: null }],
        attributes: [{ name: 'position', location: 0, enabled: true, arraySize: 3, arrayType: 'FLOAT', sample: { firstVertex: 0, values: [[1, 2, 3]] } }],
        uniforms: [
          { name: 'modelViewMatrix', type: 'FLOAT_MAT4', value: [1] },
          { name: 'diffuse', type: 'FLOAT_VEC3', value: [1, 0, 0] },
          { name: 'map', type: 'SAMPLER_2D', value: 0, textures: [{ unit: 0, target: 'TEXTURE_2D', texture: 'ctx-1:texture-1' }] }
        ]
      }
    }
  };
}

test('pipeline stages render the selected stage and split uniforms by the shader that declares them', () => {
  const commandOp = (index) => ({ 3: 'enable', 5: 'scissor' })[index];
  const vertex = renderPipelineStages(drawResult(), { stage: 'vertex-shader', commandOp });
  assert.match(vertex, /pipeline-stage--selected" data-pipeline-stage="vertex-shader"/);
  assert.match(vertex, /modelViewMatrix/);
  assert.doesNotMatch(vertex, /diffuse/);
  assert.match(vertex, /data-open-program data-stage="vertex"/);

  const fragment = renderPipelineStages(drawResult(), { stage: 'fragment-shader', commandOp });
  assert.match(fragment, /diffuse/);
  assert.match(fragment, /ctx-1:texture-1/);
  assert.doesNotMatch(fragment, /modelViewMatrix/);

  const rasterizer = renderPipelineStages(drawResult(), { stage: 'rasterizer', commandOp });
  assert.match(rasterizer, /CULL_FACE_MODE/);
  assert.match(rasterizer, /<span class="details-cmd details-cmd--valid" title="valid">CMD 3 · enable<\/span>/);

  const input = renderPipelineStages(drawResult(), { stage: 'vertex-input', commandOp });
  assert.match(input, /Vertex buffer contents/);
  assert.match(input, /\[1, 2, 3\]/);
});

test('non-draw events only enable the output merger stage, which then includes the scissor', () => {
  const result = drawResult();
  delete result.details.drawCall;
  const html = renderPipelineStages(result, { stage: 'vertex-input', commandOp: () => 'scissor' });
  assert.match(html, /data-pipeline-stage="vertex-input" disabled/);
  assert.match(html, /pipeline-stage--selected" data-pipeline-stage="output-merger"/);
  assert.match(html, /SCISSOR_BOX/);
});

test('details leave out everything the pipeline tab already shows', () => {
  const html = renderEventDetails(drawResult());
  assert.match(html, /Global/);
  assert.match(html, /VALIDATE_STATUS/);
  assert.match(html, /FRAGMENT_SHADER_DERIVATIVE_HINT/);
  assert.match(html, /Stack trace/);
  for (const duplicate of ['CULL_FACE', 'VIEWPORT', 'SCISSOR', 'LINK_STATUS', 'COMPILE_STATUS', 'modelViewMatrix', 'Arguments', 'Framebuffer']) {
    assert.doesNotMatch(html, new RegExp(duplicate), duplicate);
  }

  const clear = drawResult();
  delete clear.details.drawCall;
  assert.match(renderEventDetails(clear), /Arguments/);
});
