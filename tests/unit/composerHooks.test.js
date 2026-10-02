import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installThreeComposerHooks } from '../../src/adapters/three/composerHooks.js';

function makeState() {
  return {
    activePass: null,
    rtPassSeq: 0,
    lastRenderTargetPass: null,
    boundRenderTarget: null,
    composerMainScene: null,
    composerMainCamera: null,
    lastComposer: null,
    lastRenderPipeline: null
  };
}

function orthoCamera() {
  return { isOrthographicCamera: true };
}

function perspectiveCamera() {
  return { isPerspectiveCamera: true };
}

function shaderQuadScene(uniforms) {
  return {
    isScene: true,
    children: [{ isMesh: true, material: { isShaderMaterial: true, uniforms } }]
  };
}

test('manual (non-EffectComposer) DoF pipeline is named by its bokeh uniform signature', () => {
  const state = makeState();
  const hooks = installThreeComposerHooks({ state });
  const renderer = { setRenderTarget() {} };
  hooks.wrapRendererSetRenderTarget(renderer);

  renderer.setRenderTarget({}); // offscreen color pass (index 0)
  renderer.setRenderTarget({}); // offscreen depth pass (index 1)
  renderer.setRenderTarget(null); // screen composite pass (index 2)
  assert.equal(state.lastRenderTargetPass.kind, 'output');
  assert.equal(state.lastRenderTargetPass.effect, null);
  assert.equal(state.lastRenderTargetPass.role, 'manual');
  assert.equal(state.lastRenderTargetPass.index, null);
  assert.equal(state.lastRenderTargetPass.step.index, 2);

  const scene = shaderQuadScene({ tColor: {}, tDepth: {}, focalDepth: {} });
  hooks.noteManualPostEffectRenderCall(scene, orthoCamera());

  assert.equal(state.lastRenderTargetPass.name, 'Depth of Field (Bokeh)');
  assert.equal(state.lastRenderTargetPass.kind, 'postprocess');
  assert.equal(state.lastRenderTargetPass.effect, 'bokeh');
  assert.equal(state.lastRenderTargetPass.step.name, 'Depth of Field (Bokeh)');
  assert.equal(state.lastRenderTargetPass.step.effect, 'bokeh');
});

test('adjacent manual-pipeline calls that resolve to the same name share one coarse identity, keyed by name not call index', () => {
  const state = makeState();
  const hooks = installThreeComposerHooks({ state });
  const renderer = { setRenderTarget() {} };
  hooks.wrapRendererSetRenderTarget(renderer);

  renderer.setRenderTarget({ name: 'BlurTarget' });
  const first = state.lastRenderTargetPass;
  renderer.setRenderTarget({ name: 'BlurTarget' }); // a different target instance, same resolved name
  const second = state.lastRenderTargetPass;

  assert.equal(first.index, null);
  assert.equal(second.index, null);
  assert.equal(first.name, second.name);
  assert.equal(first.step.index, 0);
  assert.equal(second.step.index, 1);
});

test('render targets named "Class.member" are grouped by the class prefix, keeping the full name as the step', () => {
  const state = makeState();
  const hooks = installThreeComposerHooks({ state });
  const renderer = { setRenderTarget() {} };
  hooks.wrapRendererSetRenderTarget(renderer);

  renderer.setRenderTarget({ name: 'UnrealBloomPass.h0' });
  const first = state.lastRenderTargetPass;
  renderer.setRenderTarget({ name: 'UnrealBloomPass.v0' });
  const second = state.lastRenderTargetPass;

  assert.equal(first.name, 'UnrealBloomPass');
  assert.equal(second.name, 'UnrealBloomPass');
  assert.equal(first.step.name, 'UnrealBloomPass.h0');
  assert.equal(second.step.name, 'UnrealBloomPass.v0');
});

test('a fullscreen quad with no recognized signature keeps its render-target name but is still marked postprocess', () => {
  const state = makeState();
  const hooks = installThreeComposerHooks({ state });
  const renderer = { setRenderTarget() {} };
  hooks.wrapRendererSetRenderTarget(renderer);
  renderer.setRenderTarget({ name: 'UnrealBloomPass.h0' });

  const scene = shaderQuadScene({ someUnrecognizedUniform: {} });
  hooks.noteManualPostEffectRenderCall(scene, orthoCamera());

  assert.equal(state.lastRenderTargetPass.name, 'UnrealBloomPass');
  assert.equal(state.lastRenderTargetPass.kind, 'postprocess');
  assert.equal(state.lastRenderTargetPass.effect, null);
  assert.equal(state.lastRenderTargetPass.step.name, 'UnrealBloomPass.h0');
});

test('a fullscreen quad rendered as a bare mesh (no Scene wrapper) is still detected', () => {
  const state = makeState();
  const hooks = installThreeComposerHooks({ state });
  const renderer = { setRenderTarget() {} };
  hooks.wrapRendererSetRenderTarget(renderer);
  renderer.setRenderTarget(null);

  const bareQuadMesh = { isMesh: true, material: { isShaderMaterial: true, uniforms: { damp: {}, tOld: {} } } };
  hooks.noteManualPostEffectRenderCall(bareQuadMesh, orthoCamera());

  assert.equal(state.lastRenderTargetPass.name, 'Afterimage');
  assert.equal(state.lastRenderTargetPass.effect, 'afterimage');
});

test('a plain perspective-camera scene render does not get mislabeled as a post-process pass', () => {
  const state = makeState();
  const hooks = installThreeComposerHooks({ state });
  const renderer = { setRenderTarget() {} };
  hooks.wrapRendererSetRenderTarget(renderer);

  renderer.setRenderTarget(null);
  const before = { ...state.lastRenderTargetPass };

  hooks.noteManualPostEffectRenderCall({ isScene: true, children: [] }, perspectiveCamera());

  assert.deepEqual(state.lastRenderTargetPass, before);
});

test('renderTarget switches inside an active composer pass populate currentStep, not the manual pipeline field', () => {
  const state = makeState();
  const hooks = installThreeComposerHooks({ state });
  const renderer = { setRenderTarget() {} };
  hooks.wrapRendererSetRenderTarget(renderer);

  state.activePass = { index: 1, name: 'BloomPass', kind: 'postprocess', renderTarget: 'offscreen', stepSeq: 0, currentStep: null };

  renderer.setRenderTarget({}); // bright-pass extract
  assert.equal(state.activePass.currentStep.index, 0);
  assert.equal(state.lastRenderTargetPass, null);

  renderer.setRenderTarget({}); // blur pass
  assert.equal(state.activePass.currentStep.index, 1);
  assert.equal(state.activePass.stepSeq, 2);
  assert.equal(state.lastRenderTargetPass, null);

  const scene = shaderQuadScene({ tColor: {}, tDepth: {}, focalDepth: {} });
  hooks.noteManualPostEffectRenderCall(scene, orthoCamera());
  assert.equal(state.activePass.currentStep.name, 'Depth of Field (Bokeh)');
  assert.equal(state.activePass.currentStep.effect, 'bokeh');
});

test('EffectComposer ShaderPass instances are named by their uniform signature, not just "Shader"', () => {
  const state = makeState();
  const originalWindow = global.window;
  global.window = { __ispettoreState: state };
  try {
    const hooks = installThreeComposerHooks({ state });
    let capturedDuringRender = null;
    const vignettePass = {
      constructor: { name: 'ShaderPass' },
      uniforms: { tDiffuse: {}, offset: {}, darkness: {} },
      renderToScreen: false,
      render() {
        capturedDuringRender = { ...global.window.__ispettoreState.activePass };
      }
    };
    const composer = { render() {}, passes: [vignettePass] };
    hooks.registerComposer(composer);

    vignettePass.render();
    assert.equal(capturedDuringRender.name, 'Vignette');
    assert.equal(capturedDuringRender.kind, 'postprocess');
    assert.equal(state.activePass, null);
  } finally {
    global.window = originalWindow;
  }
});

test('a renderer announced before its animation loop exists is wrapped without throwing', () => {
  const state = makeState();
  const hooks = installThreeComposerHooks({ state });
  const renderer = {
    _animation: null,
    setAnimationLoop(fn) {
      this._loop = fn;
    },
    // Mirrors three.js WebGPURenderer during construction: _animation is not created yet.
    getAnimationLoop() {
      return this._animation.getAnimationLoop();
    }
  };
  assert.doesNotThrow(() => hooks.wrapRendererAnimationLoop(renderer));
  const loop = () => {};
  renderer.setAnimationLoop(loop);
  assert.equal(state.lastAnimationLoop, loop);
  assert.equal(renderer._loop, loop);
});
