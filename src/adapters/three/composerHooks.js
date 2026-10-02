/** EffectComposer / manual post-process pass boundaries + render-target pass labels. */
const nativeSetAnimationLoopByRenderer = new WeakMap();

// Matched by uniform names, since these passes carry no class identity to check with instanceof.
const POST_EFFECT_SIGNATURES = [
  { key: 'bokeh', label: 'Depth of Field (Bokeh)', uniforms: ['tColor', 'tDepth', 'focalDepth'] },
  { key: 'bloom-combine', label: 'Bloom (combine)', uniforms: ['blurTexture1', 'blurTexture2'] },
  { key: 'afterimage', label: 'Afterimage', uniforms: ['damp', 'tOld'] },
  { key: 'film', label: 'Film Grain', uniforms: ['nIntensity', 'sIntensity', 'sCount'] },
  { key: 'dot-screen', label: 'Dot Screen', uniforms: ['tSize', 'center', 'angle'] },
  { key: 'rgb-shift', label: 'RGB Shift', uniforms: ['amount', 'angle', 'tDiffuse'] },
  { key: 'vignette', label: 'Vignette', uniforms: ['offset', 'darkness', 'tDiffuse'] },
  { key: 'fxaa', label: 'FXAA', uniforms: ['resolution', 'tDiffuse'] }
];

function matchPostEffectSignature(uniforms) {
  if (!uniforms) return null;
  const keys = new Set(Object.keys(uniforms));
  for (const signature of POST_EFFECT_SIGNATURES) {
    if (signature.uniforms.every((name) => keys.has(name))) return signature;
  }
  return null;
}

function isFullscreenShaderMesh(node) {
  return Boolean(node?.isMesh && (node.material?.isShaderMaterial || node.material?.isRawShaderMaterial));
}

// ShaderPass etc. call renderer.render(mesh, camera) directly — no Scene wrapper.
function findFullscreenQuadMesh(scene) {
  if (isFullscreenShaderMesh(scene)) return scene;
  if (!scene?.isScene) return null;
  for (const child of scene.children ?? []) {
    if (isFullscreenShaderMesh(child)) return child;
  }
  return null;
}

// key/label null (rather than a made-up "custom shader" placeholder) means: this is a
// fullscreen quad draw, so still worth marking as postprocess, but don't have a specific name
// for it — callers should keep whatever name the render target already carried instead of
// downgrading it to a generic placeholder.
function detectManualPostEffect(scene, camera) {
  if (!camera?.isOrthographicCamera) return null;
  const quad = findFullscreenQuadMesh(scene);
  if (!quad) return null;
  const signature = matchPostEffectSignature(quad.material?.uniforms);
  if (signature) return signature;
  return { key: null, label: quad.material?.name || null };
}

export function installThreeComposerHooks(deps) {
    const { state } = deps;
    let wrapRendererRender = deps.wrapRendererRender || (() => {});

    function setWrapRendererRender(fn) {
      if (typeof fn === 'function') wrapRendererRender = fn;
    }

    function syncComposerScene(composer) {
      if (!composer?.passes) return;
      for (const pass of composer.passes) {
        if (pass.scene?.isScene) {
          state.composerMainScene = pass.scene;
          if (pass.camera) state.composerMainCamera = pass.camera;
          return;
        }
      }
    }

    function passDisplayName(pass, index) {
      if (pass.name) return pass.name;
      const cn = pass.constructor?.name;
      if (cn === 'RenderPass') return 'Scene';
      if (cn === 'UnrealBloomPass') return 'Bloom';
      if (cn === 'BokehPass') return 'DoF';
      if (cn === 'FilmPass') return 'Film';
      if (cn === 'ShaderPass') {
        const uniforms = pass.uniforms ?? pass.material?.uniforms;
        const signature = matchPostEffectSignature(uniforms);
        if (signature) return signature.label;
        return uniforms && 'tDiffuse' in uniforms ? 'Custom Shader Pass' : 'Shader';
      }
      return cn || `Pass ${index + 1}`;
    }

    function classifyPassKind(pass) {
      if (pass.scene?.isScene) return 'scene';
      if (pass.renderToScreen) return 'output';
      return 'postprocess';
    }

    function wrapComposerPasses(composer) {
      if (!composer?.passes) return;
      for (let index = 0; index < composer.passes.length; index++) {
        const pass = composer.passes[index];
        if (!pass || pass.__ispettorePassWrapped || typeof pass.render !== 'function') continue;

        const passIndex = index;
        const orig = pass.render.bind(pass);
        pass.render = function (...args) {
          const s = window.__ispettoreState;
          if (s) {
            s.activePass = {
              index: passIndex,
              name: passDisplayName(pass, passIndex),
              kind: classifyPassKind(pass),
              renderTarget: pass.renderToScreen ? 'canvas' : 'offscreen',
              role: 'composer',
              stepSeq: 0,
              currentStep: null
            };
          }
          try {
            return orig(...args);
          } finally {
            if (window.__ispettoreState) window.__ispettoreState.activePass = null;
          }
        };
        pass.__ispettorePassWrapped = true;
      }
    }

    function resetRenderTargetPassTracking() {
      state.rtPassSeq = 0;
      state.lastRenderTargetPass = null;
    }

    function renderTargetPassName(target, index) {
      if (target == null) return 'Screen';
      if (target.name) return target.name;
      if (target.texture?.name) return target.texture.name;
      if (index === 0) return 'Offscreen · Scene';
      if (index === 1) return 'Offscreen · Depth / Shader';
      return `Offscreen ${index + 1}`;
    }

    function classifyRenderTargetPassKind(target, index) {
      if (target == null) return 'output';
      if (index === 0) return 'scene';
      return 'postprocess';
    }

    // Three.js often names a pass's own render targets "ClassName.member" (e.g.
    // UnrealBloomPass's "UnrealBloomPass.h0", "UnrealBloomPass.v0", ...). Grouping by that class
    // prefix collapses a multi-stage effect's many internal targets into one region, with the
    // full name kept as the drill-down step — same idea as an EffectComposer pass's own steps.
    function passFamilyName(fullName) {
      const dotIndex = fullName.lastIndexOf('.');
      return dotIndex > 0 ? fullName.slice(0, dotIndex) : fullName;
    }

    /** Manual post-process (e.g. three.js dof2) — no EffectComposer, uses setRenderTarget ping-pong. */
    function noteRenderTargetPass(renderer, target) {
      wrapRendererRender(renderer);

      if (state.activePass) {
        const stepIndex = state.activePass.stepSeq ?? 0;
        state.activePass.currentStep = {
          index: stepIndex,
          name: renderTargetPassName(target, stepIndex),
          effect: null
        };
        state.activePass.stepSeq = stepIndex + 1;
        return;
      }

      // index is left out of the pass identity here (unlike composer.passes' stable index) since
      // it's an ever-incrementing call counter — grouping by name alone lets adjacent calls that
      // resolve to the same family name collapse into one region instead of one box per call.
      // The counter still identifies the individual call as this pass's own drill-down step.
      const index = state.rtPassSeq ?? 0;
      const fullName = renderTargetPassName(target, index);
      state.lastRenderTargetPass = {
        index: null,
        name: passFamilyName(fullName),
        kind: classifyRenderTargetPassKind(target, index),
        renderTarget: target ? 'offscreen' : 'canvas',
        role: 'manual',
        effect: null,
        step: { index, name: fullName, effect: null }
      };
      state.rtPassSeq = index + 1;
    }

    function noteManualPostEffectRenderCall(scene, camera) {
      const effect = detectManualPostEffect(scene, camera);
      if (!effect) return;

      if (state.activePass) {
        if (!state.activePass.currentStep) return;
        state.activePass.currentStep = {
          ...state.activePass.currentStep,
          name: effect.label ?? state.activePass.currentStep.name,
          effect: effect.key ?? state.activePass.currentStep.effect
        };
        return;
      }

      if (!state.lastRenderTargetPass) return;
      const step = state.lastRenderTargetPass.step;
      state.lastRenderTargetPass = {
        ...state.lastRenderTargetPass,
        name: effect.label ?? state.lastRenderTargetPass.name,
        kind: 'postprocess',
        effect: effect.key ?? state.lastRenderTargetPass.effect,
        step: { ...step, name: effect.label ?? step?.name, effect: effect.key ?? step?.effect }
      };
    }

    function hookRendererSetRenderTargetPrototype(THREE) {
      const root = THREE ?? window.THREE;
      if (!root) return false;

      let hooked = false;
      for (const name of ['WebGLRenderer', 'WebGPURenderer']) {
        const proto = root[name]?.prototype;
        if (!proto?.setRenderTarget || proto.__ispettoreSetRenderTargetHooked) continue;

        const orig = proto.setRenderTarget;
        proto.setRenderTarget = function (target) {
          state.boundRenderTarget = target ?? null;
          noteRenderTargetPass(this, target);
          return orig.call(this, target);
        };
        proto.__ispettoreSetRenderTargetHooked = true;
        hooked = true;
      }
      return hooked;
    }

    function wrapRendererSetRenderTarget(renderer) {
      if (!renderer?.setRenderTarget || renderer.__ispettoreSetRTInstanceWrapped) return;
      const orig = renderer.setRenderTarget.bind(renderer);
      renderer.setRenderTarget = function (target) {
        state.boundRenderTarget = target ?? null;
        noteRenderTargetPass(renderer, target);
        return orig(target);
      };
      renderer.__ispettoreSetRTInstanceWrapped = true;
    }

    function hookRendererAnimationLoopPrototype(THREE) {
      const root = THREE ?? window.THREE;
      if (!root) return false;

      let hooked = false;
      for (const name of ['WebGLRenderer', 'WebGPURenderer']) {
        const proto = root[name]?.prototype;
        if (!proto?.setAnimationLoop || proto.__ispettoreAnimLoopHooked) continue;

        const orig = proto.setAnimationLoop;
        proto.setAnimationLoop = function (fn) {
          if (typeof fn === 'function') {
            state.lastAnimationLoop = fn;
            state.lastRenderer = this;
            state.animationLoopFromRenderer = true;
          } else if (fn === null) {
            state.animationLoopFromRenderer = false;
          }
          wrapRendererRender(this);
          wrapRendererSetRenderTarget(this);
          return orig.call(this, fn);
        };
        proto.__ispettoreAnimLoopHooked = true;
        hooked = true;
      }
      return hooked;
    }

    function wrapRendererAnimationLoop(renderer) {
      if (!renderer?.setAnimationLoop || renderer.__ispettoreAnimLoopInstanceWrapped) return;

      nativeSetAnimationLoopByRenderer.set(renderer, renderer.setAnimationLoop);
      renderer.setAnimationLoop = function (fn) {
        if (typeof fn === 'function') {
          state.lastAnimationLoop = fn;
          state.lastRenderer = renderer;
          state.animationLoopFromRenderer = true;
        } else if (fn === null) {
          state.animationLoopFromRenderer = false;
        }
        const nativeSet = nativeSetAnimationLoopByRenderer.get(renderer);
        return nativeSet.call(this, fn);
      };
      renderer.__ispettoreAnimLoopInstanceWrapped = true;

      // three.js announces a renderer to devtools from inside its constructor, before the
      // animation loop object exists (WebGPURenderer.getAnimationLoop then throws). A loop set
      // later is still caught by the setAnimationLoop wrapper above.
      if (typeof renderer.getAnimationLoop === 'function') {
        let current = null;
        try {
          current = renderer.getAnimationLoop();
        } catch (_) {
          current = null;
        }
        if (typeof current === 'function') {
          state.lastAnimationLoop = current;
          state.lastRenderer = renderer;
          state.animationLoopFromRenderer = true;
        }
      }
    }

    function hookRendererConstructorsFor(THREE, trackThreeObject) {
      if (!THREE?.WebGLRenderer) return false;

      for (const name of ['WebGLRenderer', 'WebGPURenderer']) {
        const Ctor = THREE[name];
        if (!Ctor || Ctor.__ispettoreCtorHooked) continue;
        Ctor.__ispettoreCtorHooked = true;

        const Original = Ctor;
        function Patched(...args) {
          const instance = Reflect.construct(Original, args, Patched);
          if (typeof trackThreeObject === 'function') trackThreeObject(instance);
          return instance;
        }
        Patched.prototype = Original.prototype;
        Object.setPrototypeOf(Patched, Original);
        THREE[name] = Patched;
      }

      if (THREE.Scene && !THREE.Scene.__ispettoreCtorHooked) {
        THREE.Scene.__ispettoreCtorHooked = true;
        const OrigScene = THREE.Scene;
        function PatchedScene(...args) {
          const instance = Reflect.construct(OrigScene, args, PatchedScene);
          if (typeof trackThreeObject === 'function') trackThreeObject(instance);
          return instance;
        }
        PatchedScene.prototype = OrigScene.prototype;
        Object.setPrototypeOf(PatchedScene, OrigScene);
        THREE.Scene = PatchedScene;
      }

      state.threeVersion = state.threeVersion ?? String(THREE.REVISION ?? 'unknown');
      return true;
    }

    function retroWrapObservedRenderers() {
      for (const renderer of state.observedRenderers) {
        wrapRendererRender(renderer);
        wrapRendererSetRenderTarget(renderer);
        wrapRendererAnimationLoop(renderer);
      }
    }

    async function autoHookThreeModule(trackThreeObject) {
      let three = window.THREE;
      if (!three?.WebGLRenderer) {
        try {
          three = await import('three');
        } catch (_) {
          return false;
        }
      }
      if (!three?.WebGLRenderer) return false;

      if (three.REVISION != null) state.threeVersion = String(three.REVISION);

      hookRendererSetRenderTargetPrototype(three);
      hookRendererAnimationLoopPrototype(three);
      hookRendererConstructorsFor(three, trackThreeObject);
      retroWrapObservedRenderers();
      return true;
    }

    function registerRenderPipeline(pipeline, opts = {}) {
      if (!pipeline?.render) return;
      state.lastRenderPipeline = pipeline;
      if (opts.scene?.isScene) state.composerMainScene = opts.scene;
      if (opts.camera) state.composerMainCamera = opts.camera;
      wrapRenderPipeline(pipeline);
    }

    function wrapRenderPipeline(pipeline) {
      if (!pipeline?.render || pipeline.__ispettorePipelineWrapped) return;
      const orig = pipeline.render.bind(pipeline);
      pipeline.render = function (...args) {
        state.lastRenderPipeline = pipeline;
        if (pipeline.renderer) {
          state.lastRenderer = pipeline.renderer;
          wrapRendererRender(pipeline.renderer);
        }
        return orig(...args);
      };
      pipeline.__ispettorePipelineWrapped = true;
    }

    function registerComposer(composer) {
      if (!composer?.render) return;
      state.lastComposer = composer;
      syncComposerScene(composer);
      wrapComposerPasses(composer);
      wrapEffectComposer(composer);
    }

    function wrapEffectComposer(composer) {
      if (!composer?.render || composer.__ispettoreComposerWrapped) return;
      const orig = composer.render.bind(composer);
      composer.render = function (...args) {
        state.lastComposer = composer;
        syncComposerScene(composer);
        wrapComposerPasses(composer);
        if (composer.renderer) {
          state.lastRenderer = composer.renderer;
          wrapRendererRender(composer.renderer);
        }
        return orig(...args);
      };
      composer.__ispettoreComposerWrapped = true;
    }

    function hookEffectComposerClass(EffectComposer) {
      const C = EffectComposer ?? window.THREE?.EffectComposer;
      if (!C?.prototype?.render || C.prototype.__ispettoreEffectComposerHooked) return false;

      const origRender = C.prototype.render;
      C.prototype.render = function (...args) {
        state.lastComposer = this;
        syncComposerScene(this);
        wrapComposerPasses(this);
        if (this.renderer) {
          state.lastRenderer = this.renderer;
          wrapRendererRender(this.renderer);
        }
        return origRender.apply(this, args);
      };
      C.prototype.__ispettoreEffectComposerHooked = true;
      return true;
    }

    const EFFECT_COMPOSER_MODULE_SPECS = [
      'three/addons/postprocessing/EffectComposer.js',
      'three/examples/jsm/postprocessing/EffectComposer.js'
    ];

    async function autoHookEffectComposerModule() {
      if (hookEffectComposerClass(window.THREE?.EffectComposer)) return true;

      for (const spec of EFFECT_COMPOSER_MODULE_SPECS) {
        try {
          const mod = await import(spec);
          if (mod.EffectComposer && hookEffectComposerClass(mod.EffectComposer)) return true;
        } catch (_) {
          /* import map missing, bundle-only app, or module not loaded yet */
        }
      }
      return false;
    }

    function schedulePostProcessingAutoHook(trackThreeObject) {
      void autoHookThreeModule(trackThreeObject);
      void autoHookEffectComposerModule();
    }

    function hookRendererConstructors(trackThreeObject) {
      return hookRendererConstructorsFor(window.THREE, trackThreeObject);
    }

    return {
      setWrapRendererRender,
      resetRenderTargetPassTracking,
      registerComposer,
      registerRenderPipeline,
      wrapRendererSetRenderTarget,
      wrapRendererAnimationLoop,
      hookEffectComposerClass,
      schedulePostProcessingAutoHook,
      hookRendererConstructors,
      noteManualPostEffectRenderCall
    };
  }
