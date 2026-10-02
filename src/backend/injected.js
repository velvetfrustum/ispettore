import { installThreeComposerHooks } from '../adapters/three/composerHooks.js';
import { webglFramebuffer } from './webgl/framebufferSnapshot.js';
import { parseTexImageArgs } from './webgl/parseTexImage.js';
import { installProgramSpy } from './webgl/spies/programSpy.js';
import { createWebGlCommandJournal } from './webgl/capture/commandJournal.js';
import { serializeWebGlJournal } from './webgl/serialize/serializeJournal.js';
import { createWebGlDrawSemantics } from './webgl/semantic/drawSemantics.js';
import { installTransferSender, sendWebGlPackage } from '../shared/storage/transferSender.js';
import { installWebGpuCapture } from './webgpu/capture/installWebGpuCapture.js';
import { serializeWebGpuJournal } from './webgpu/serialize/serializeJournal.js';
import { installModelAssetTracker } from './modelAssets.js';

(function () {
  const INJECT_GEN = (window.__ispettoreInjectGen = (window.__ispettoreInjectGen || 0) + 1);
  if (window.__ispettoreInjectActive === INJECT_GEN) return;
  window.__ispettoreInjectActive = INJECT_GEN;

  const CHANNEL = 'ISPETTORE';
  const MAX_PREVIEW = 128;
  const MAX_FULL_PREVIEW = 2048;
  const MAX_TEXTURES = 48;
  const CAPTURABLE_FRAME_KINDS = new Set(['animation-frame', 'on-demand']);

  // Survives extension reload / re-inject so hooks and capture share one object.
  const state =
    window.__ispettoreState ||
    (window.__ispettoreState = {
      hooked: false,
      textureList: [],
      programs: new Map(),
      contexts: new Set(),
      lastScene: null,
      lastCamera: null,
      lastRenderer: null,
      lastComposer: null,
      lastRenderPipeline: null,
      composerMainScene: null,
      composerMainCamera: null,
      activePass: null,
      rtPassSeq: 0,
      lastRenderTargetPass: null,
      boundRenderTarget: null,
      lastAnimationLoop: null,
      animationLoopFromRenderer: false,
      threeVersion: null,
      observedScenes: [],
      observedRenderers: [],
      threeBridgeAttached: false,
      nextTextureId: 1
    });

  state.webglJournals ??= new Map();
  state.webgpuJournals ??= new Map();
  state.ispettoreGlOperation ??= false;
  state.currentRenderObject ??= null;
  state.modelAssets ??= installModelAssetTracker(window);

  function withoutWebGlJournal(operation) {
    const previous = state.ispettoreGlOperation;
    state.ispettoreGlOperation = true;
    try {
      return operation();
    } finally {
      state.ispettoreGlOperation = previous;
    }
  }

  const animationCallbackIds =
    window.__ispettoreAnimationCallbackIds ||
    (window.__ispettoreAnimationCallbackIds = new WeakMap());
  state.nextAnimationCallbackId ??= 1;

  function getAnimationCallbackId(callback) {
    if (typeof callback !== 'function') return null;
    if (!animationCallbackIds.has(callback)) {
      animationCallbackIds.set(callback, state.nextAnimationCallbackId++);
    }
    return animationCallbackIds.get(callback);
  }

  state.animationRangeSeq ??= new Map();

  function beginAnimationRange(callback) {
    if (!state.webglJournals || !state.webgpuJournals) return;
    if (state.webglJournals.size === 0 && state.webgpuJournals.size === 0) return;
    const callbackId = getAnimationCallbackId(callback);
    if (callbackId == null) return;
    const journals = [...state.webglJournals.values(), ...state.webgpuJournals.values()];
    if (journals.length > 0 && journals.every((journal) => journal.overflow)) return;
    const seq = (state.animationRangeSeq.get(callbackId) ?? 0) + 1;
    state.animationRangeSeq.set(callbackId, seq);
    const frameId = `frame:${callbackId}:${seq}`;
    for (const journal of state.webglJournals.values()) {
      journal.markFrameStart({ frameId, label: 'animation callback', kind: 'animation-frame' });
    }
    for (const journal of state.webgpuJournals.values()) {
      journal.markFrameStart({ frameId, label: 'animation callback', kind: 'animation-frame' });
    }
  }

  function endAnimationRange() {
    for (const journal of state.webglJournals.values()) journal.markFrameEnd();
    for (const journal of state.webgpuJournals.values()) journal.markFrameEnd();
  }

  function shouldCaptureGpuCommands() {
    return !state.ispettoreGlOperation;
  }

  const webGpuCapture = installWebGpuCapture({
    shouldCapture: shouldCaptureGpuCommands,
    onJournal: (journal) => {
      if (!journal?.device) return;
      state.webgpuJournals.set(journal.device, journal);
    }
  });

  const textureByObject =
    window.__ispettoreTextureByObject || (window.__ispettoreTextureByObject = new WeakMap());

  const CUBE_FACE_NAMES = [
    'TEXTURE_CUBE_MAP_POSITIVE_X',
    'TEXTURE_CUBE_MAP_NEGATIVE_X',
    'TEXTURE_CUBE_MAP_POSITIVE_Y',
    'TEXTURE_CUBE_MAP_NEGATIVE_Y',
    'TEXTURE_CUBE_MAP_POSITIVE_Z',
    'TEXTURE_CUBE_MAP_NEGATIVE_Z'
  ];

  function targetLabel(ctx, target) {
    if (!ctx || target == null) return 'UNKNOWN';
    if (target === ctx.TEXTURE_2D) return 'TEXTURE_2D';
    if (target === ctx.TEXTURE_CUBE_MAP) return 'TEXTURE_CUBE_MAP';
    if (target === ctx.TEXTURE_3D) return 'TEXTURE_3D';
    if (target === ctx.TEXTURE_2D_ARRAY) return 'TEXTURE_2D_ARRAY';

    const min = ctx.TEXTURE_CUBE_MAP_POSITIVE_X;
    const max = ctx.TEXTURE_CUBE_MAP_NEGATIVE_Z;
    if (target >= min && target <= max) {
      return CUBE_FACE_NAMES[target - min] ?? `0x${target.toString(16)}`;
    }

    return `0x${target.toString(16)}`;
  }

  function isCubeMapFace(ctx, target) {
    if (!ctx || target == null) return false;
    return target >= ctx.TEXTURE_CUBE_MAP_POSITIVE_X && target <= ctx.TEXTURE_CUBE_MAP_NEGATIVE_Z;
  }

  function textureHint(entry) {
    const { ctx, width, height, target } = entry;
    if (!ctx) return null;

    if (width === 16 && height === 16 && target === ctx.TEXTURE_2D) {
      return (
        'Three.js default texture fallback: the renderer binds this for MeshStandardMaterial / lighting ' +
        '(missing map slots, IBL-related defaults, etc.).'
      );
    }

    if (width !== 1 || height !== 1) return null;

    if (isCubeMapFace(ctx, target)) {
      const face = targetLabel(ctx, target);
      return (
        `Three.js engine placeholder: a 1×1 cube map face (${face}). ` +
        `Not your material texture — the renderer binds this so shaders always have a valid cubemap. ` +
        `Look for larger TEXTURE_2D entries for your maps.`
      );
    }

    return (
      'A 1×1 placeholder texture, often created by Three.js as a default or fallback. ' +
      'Usually safe to ignore when debugging your materials.'
    );
  }

  function isValidDimension(n) {
    return Number.isInteger(n) && n > 0 && n <= 16384;
  }

  function postCapture(payload) {
    window.postMessage({ channel: CHANNEL, type: 'CAPTURE', payload }, '*');
  }

  function geometryInfo(geometry) {
    if (!geometry) return null;
    const bits = [];

    const pos = geometry.attributes?.position;
    if (pos?.count) bits.push(`${pos.count} verts`);

    if (geometry.index?.count) {
      bits.push(`${Math.floor(geometry.index.count / 3)} tris`);
    } else if (pos?.count) {
      bits.push(`~${Math.floor(pos.count / 3)} tris`);
    }

    return bits.length ? bits.join(' · ') : null;
  }

  function meshSummary(object) {
    if (!object?.isMesh && !object?.isInstancedMesh) return null;

    const geo = object.geometry;
    const geoType = geo?.type ?? 'Geometry';
    const geoDetail = geometryInfo(geo);
    const mat = object.material;
    const matLabel = Array.isArray(mat)
      ? mat.map((m) => m?.type ?? 'Material').join(' ')
      : mat?.type ?? 'Material';

    const parts = [geoType, matLabel];
    if (object.isInstancedMesh && object.count) parts.push(`${object.count} instances`);
    if (geoDetail) parts.push(geoDetail);
    return parts.join(' · ');
  }

  function countSceneObjects(object) {
    if (!object) return 0;
    let n = 1;
    for (const child of object.children || []) n += countSceneObjects(child);
    return n;
  }

  function buildSceneTree(object) {
    if (!object) return null;
    return {
      name: object.name || '(unnamed)',
      type: object.type,
      uuid: object.uuid,
      visible: object.visible,
      summary: meshSummary(object),
      children: (object.children || []).map(buildSceneTree)
    };
  }

  function rendererEntry(renderer) {
    if (!renderer?.domElement) return null;
    const attrs = renderer.getContextAttributes?.() ?? {};
    const info = renderer.info?.render ?? {};
    const mem = renderer.info?.memory ?? {};
    return {
      type: renderer.isWebGPURenderer ? 'WebGPURenderer' : 'WebGLRenderer',
      width: renderer.domElement.width,
      height: renderer.domElement.height,
      draws: info.calls ?? info.drawCalls ?? 0,
      triangles: info.triangles ?? 0,
      points: info.points ?? 0,
      lines: info.lines ?? 0,
      properties: {
        alpha: attrs.alpha ?? renderer.alpha,
        antialias: attrs.antialias ?? renderer.antialias,
        outputColorSpace: renderer.outputColorSpace,
        toneMapping: renderer.toneMapping,
        toneMappingExposure: renderer.toneMappingExposure,
        shadowMap: renderer.shadowMap?.enabled ?? false,
        autoClear: renderer.autoClear,
        autoClearColor: renderer.autoClearColor,
        autoClearDepth: renderer.autoClearDepth,
        autoClearStencil: renderer.autoClearStencil,
        physicallyCorrectLights: renderer.physicallyCorrectLights
      },
      memory: {
        geometries: mem.geometries ?? 0,
        textures: mem.textures ?? 0
      },
      programCount: renderer.info?.programs?.length ?? 0
    };
  }

  function collectRenderers() {
    const seen = new Set();
    const renderers = [];

    for (const r of state.observedRenderers) {
      if (!r || seen.has(r)) continue;
      seen.add(r);
      const entry = rendererEntry(r);
      if (entry) renderers.push(entry);
    }

    if (state.lastRenderer && !seen.has(state.lastRenderer)) {
      const entry = rendererEntry(state.lastRenderer);
      if (entry) renderers.push(entry);
    }

    return renderers;
  }

  function pickSceneObject() {
    if (state.composerMainScene) return state.composerMainScene;

    const withChildren = state.observedScenes.filter((s) => s?.children?.length);
    let bestObserved = null;
    let bestCount = 0;
    for (const s of withChildren) {
      const n = countSceneObjects(s);
      if (n > bestCount) {
        bestObserved = s;
        bestCount = n;
      }
    }

    if (bestObserved && bestCount > 1) return bestObserved;
    if (state.lastScene) {
      const lastCount = countSceneObjects(state.lastScene);
      if (lastCount > 1 || !bestObserved) return state.lastScene;
    }
    return bestObserved ?? state.observedScenes[0] ?? state.lastScene ?? null;
  }

  function registerTexture(ctx, texture) {
    if (!texture) return null;
    let entry = textureByObject.get(texture);
    if (entry) return entry;
    entry = {
      id: state.nextTextureId++,
      texture,
      ctx,
      target: null,
      width: 0,
      height: 0,
      sourcePreview: null,
      sourcePreviewFull: null,
      previewError: null
    };
    textureByObject.set(texture, entry);
    state.textureList.push(entry);
    return entry;
  }

  function imageToDataUrl(image, maxDim) {
    if (!image) return null;
    const w = image.width ?? image.videoWidth ?? image.naturalWidth ?? 0;
    const h = image.height ?? image.videoHeight ?? image.naturalHeight ?? 0;
    if (!w || !h) return null;
    try {
      const scale = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1;
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const g = canvas.getContext('2d');
      g.drawImage(image, 0, 0, cw, ch);
      return canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
  }

  function imageToPreview(image) {
    return imageToDataUrl(image, MAX_PREVIEW);
  }

  const GL_RGBA16F = 0x881a;
  const GL_RGBA32F = 0x8814;
  const GL_RGBA8 = 0x8058;
  const GL_HALF_FLOAT_OES = 0x8d61;

  function isWebGL2(gl) {
    return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  }

  function clearGlErrors(gl) {
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain */
    }
  }

  function resolveTextureInternalFormat(entry, gl, bindTarget) {
    const pixelType = entry.pixelType;
    if (pixelType === gl.HALF_FLOAT || pixelType === GL_HALF_FLOAT_OES) return GL_RGBA16F;
    if (pixelType === gl.FLOAT) return GL_RGBA32F;

    const stored = entry.internalFormat;
    if (stored === GL_RGBA16F || stored === GL_RGBA32F) return stored;

    if (isWebGL2(gl) && gl.TEXTURE_INTERNAL_FORMAT != null) {
      try {
        const queried = gl.getTexParameter(bindTarget, gl.TEXTURE_INTERNAL_FORMAT);
        if (queried === GL_RGBA16F || queried === GL_RGBA32F) return queried;
      } catch (_) {
        /* ignore */
      }
    }

    return GL_RGBA8;
  }

  function halfToFloat(half) {
    const sign = (half & 0x8000) >> 15;
    const exponent = (half & 0x7c00) >> 10;
    const mantissa = half & 0x03ff;
    if (exponent === 0) {
      if (mantissa === 0) return sign ? -0 : 0;
      return (sign ? -1 : 1) * 2 ** -14 * (mantissa / 1024);
    }
    if (exponent === 0x1f) return mantissa ? NaN : sign ? -Infinity : Infinity;
    return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + mantissa / 1024);
  }

  function linearToSrgb8(value) {
    const clamped = Math.max(0, Math.min(1, value));
    const channel =
      clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(channel * 255);
  }

  function rgba8ToPreview(readWidth, readHeight, rgba) {
    const canvas = document.createElement('canvas');
    canvas.width = readWidth;
    canvas.height = readHeight;
    canvas.getContext('2d').putImageData(new ImageData(rgba, readWidth, readHeight), 0, 0);
    return canvas.toDataURL('image/png');
  }

  function readPixelsToPreview(readWidth, readHeight, pixels) {
    const rgba = new Uint8ClampedArray(readWidth * readHeight * 4);
    for (let y = 0; y < readHeight; y++) {
      const srcRow = readHeight - 1 - y;
      for (let x = 0; x < readWidth; x++) {
        const src = (srcRow * readWidth + x) * 4;
        const dst = (y * readWidth + x) * 4;
        rgba[dst] = pixels[src];
        rgba[dst + 1] = pixels[src + 1];
        rgba[dst + 2] = pixels[src + 2];
        rgba[dst + 3] = pixels[src + 3];
      }
    }
    return rgba8ToPreview(readWidth, readHeight, rgba);
  }

  function readTexturePixelsToPreview(gl, readW, readH, internalFormat) {
    clearGlErrors(gl);

    if (internalFormat === GL_RGBA16F && gl.HALF_FLOAT) {
      const raw = new Uint16Array(readW * readH * 4);
      gl.readPixels(0, 0, readW, readH, gl.RGBA, gl.HALF_FLOAT, raw);
      if (gl.getError() === gl.NO_ERROR) {
        const rgba = new Uint8ClampedArray(readW * readH * 4);
        for (let y = 0; y < readH; y++) {
          const srcRow = readH - 1 - y;
          for (let x = 0; x < readW; x++) {
            const src = (srcRow * readW + x) * 4;
            const dst = (y * readW + x) * 4;
            rgba[dst] = linearToSrgb8(halfToFloat(raw[src]));
            rgba[dst + 1] = linearToSrgb8(halfToFloat(raw[src + 1]));
            rgba[dst + 2] = linearToSrgb8(halfToFloat(raw[src + 2]));
            rgba[dst + 3] = Math.round(Math.max(0, Math.min(1, halfToFloat(raw[src + 3]))) * 255);
          }
        }
        return rgba8ToPreview(readW, readH, rgba);
      }
      clearGlErrors(gl);
    }

    if (internalFormat === GL_RGBA32F && gl.FLOAT) {
      const raw = new Float32Array(readW * readH * 4);
      gl.readPixels(0, 0, readW, readH, gl.RGBA, gl.FLOAT, raw);
      if (gl.getError() === gl.NO_ERROR) {
        const rgba = new Uint8ClampedArray(readW * readH * 4);
        for (let y = 0; y < readH; y++) {
          const srcRow = readH - 1 - y;
          for (let x = 0; x < readW; x++) {
            const src = (srcRow * readW + x) * 4;
            const dst = (y * readW + x) * 4;
            rgba[dst] = linearToSrgb8(raw[src]);
            rgba[dst + 1] = linearToSrgb8(raw[src + 1]);
            rgba[dst + 2] = linearToSrgb8(raw[src + 2]);
            rgba[dst + 3] = Math.round(Math.max(0, Math.min(1, raw[src + 3])) * 255);
          }
        }
        return rgba8ToPreview(readW, readH, rgba);
      }
      clearGlErrors(gl);
    }

    const pixels = new Uint8Array(readW * readH * 4);
    gl.readPixels(0, 0, readW, readH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() === gl.NO_ERROR) return readPixelsToPreview(readW, readH, pixels);
    clearGlErrors(gl);

    if (internalFormat !== GL_RGBA16F && gl.HALF_FLOAT) {
      return readTexturePixelsToPreview(gl, readW, readH, GL_RGBA16F);
    }

    const blitPixels =
      webglFramebuffer.readFramebufferViaBlit?.(gl, readW, readH) ||
      webglFramebuffer.readFramebufferViaCopyShader?.(gl, readW, readH);
    if (blitPixels) return readPixelsToPreview(readW, readH, blitPixels);

    return null;
  }

  function isLiveGlTexture(gl, texture) {
    if (!gl || !texture) return false;
    if (typeof gl.isTexture === 'function') return gl.isTexture(texture);
    return true;
  }

  function resolveTextureSize(entry) {
    const { ctx, texture } = entry;
    if (!ctx || !texture || !isLiveGlTexture(ctx, texture)) return;
    if (isValidDimension(entry.width) && isValidDimension(entry.height)) return;

    const target = entry.target || ctx.TEXTURE_2D;
    const bindingEnum =
      target === ctx.TEXTURE_CUBE_MAP ? ctx.TEXTURE_BINDING_CUBE_MAP : ctx.TEXTURE_BINDING_2D;

    const prev = ctx.getParameter(bindingEnum);
    try {
      ctx.bindTexture(target, texture);
      const w = ctx.getTexParameter(target, ctx.TEXTURE_WIDTH);
      const h = ctx.getTexParameter(target, ctx.TEXTURE_HEIGHT);
      if (isValidDimension(w)) entry.width = w;
      if (isValidDimension(h)) entry.height = h;
      if (!entry.target) entry.target = target;
    } catch (_) {
      /* texture may have been deleted by Three.js */
    } finally {
      try {
        ctx.bindTexture(target, prev);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function snapshotGlTexture(entry, maxDim) {
    resolveTextureSize(entry);

    const { ctx, texture, width, height, target } = entry;
    if (!ctx || !texture || !isLiveGlTexture(ctx, texture)) {
      entry.previewError = 'Texture no longer valid';
      return null;
    }
    if (!isValidDimension(width) || !isValidDimension(height)) {
      entry.previewError = 'Unknown size';
      return null;
    }

    const gl = ctx;
    const isCube = target === gl.TEXTURE_CUBE_MAP;
    const texTarget = isCube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X : gl.TEXTURE_2D;
    const bindTarget = isCube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    const cap = maxDim ?? MAX_PREVIEW;
    const readW = Math.max(1, Math.min(width, cap));
    const readH = Math.max(1, Math.min(height, cap));

    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevTex2d = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const prevCube = gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP);
    const prevBind = gl.getParameter(
      bindTarget === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_BINDING_CUBE_MAP : gl.TEXTURE_BINDING_2D
    );

    let fbo = null;
    let preview = null;

    try {
      gl.bindTexture(bindTarget, texture);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texTarget, texture, 0);

      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        const internalFormat = resolveTextureInternalFormat(entry, gl, bindTarget);
        preview = readTexturePixelsToPreview(gl, readW, readH, internalFormat);
        if (!preview) {
          entry.previewError =
            internalFormat === GL_RGBA16F || internalFormat === GL_RGBA32F
              ? 'HDR readback failed'
              : 'Read failed';
        }
      } else {
        entry.previewError = 'Framebuffer incomplete';
      }
    } catch (e) {
      entry.previewError = e.message || 'Snapshot failed';
    } finally {
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
        gl.bindTexture(gl.TEXTURE_2D, prevTex2d);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, prevCube);
        gl.bindTexture(bindTarget, prevBind);
        if (fbo) gl.deleteFramebuffer(fbo);
      } catch (_) {
        /* ignore restore errors */
      }
    }

    return preview;
  }

  function collectTexturePayload(options = {}) {
    const includeFullPreview = options.includeFullPreview !== false;
    const skipGpuSnapshot = options.skipGpuSnapshot === true;
    const out = [];
    const list = state.textureList.slice(0, MAX_TEXTURES);

    for (const entry of list) {
      resolveTextureSize(entry);

      const hasSize = isValidDimension(entry.width) && isValidDimension(entry.height);
      if (!hasSize && !entry.sourcePreview) continue;

      let preview = entry.sourcePreview;
      let previewFull = includeFullPreview ? entry.sourcePreviewFull : null;
      let previewError = entry.previewError;

      if (!skipGpuSnapshot && !preview && hasSize) {
        try {
          preview = snapshotGlTexture(entry, MAX_PREVIEW);
        } catch (e) {
          previewError = e.message || 'Snapshot failed';
        }
      }

      if (!skipGpuSnapshot && includeFullPreview && !previewFull && hasSize) {
        try {
          previewFull = entry.sourcePreviewFull || snapshotGlTexture(entry, MAX_FULL_PREVIEW) || preview;
        } catch (_) {
          previewFull = preview;
        }
      } else if (!previewFull) {
        previewFull = includeFullPreview ? preview : null;
      }

      const hint = textureHint(entry);

      out.push({
        id: entry.id,
        label: `Texture #${entry.id}`,
        target: targetLabel(entry.ctx, entry.target),
        width: hasSize ? entry.width : null,
        height: hasSize ? entry.height : null,
        preview: preview || null,
        previewFull: previewFull || preview || null,
        previewError: preview && !previewError ? null : previewError || (preview ? null : 'No preview'),
        tooltip: hint,
        internal: Boolean(hint)
      });
    }

    return out;
  }

  function updateTextureFromUpload(ctx, target, args) {
    const bindingEnum =
      target === ctx.TEXTURE_CUBE_MAP ? ctx.TEXTURE_BINDING_CUBE_MAP : ctx.TEXTURE_BINDING_2D;
    const tex = ctx.getParameter(bindingEnum);
    const entry = registerTexture(ctx, tex);
    if (!entry) return;

    entry.target = target;
    const { width, height, image, internalFormat, pixelType } = parseTexImageArgs(args);
    if (typeof internalFormat === 'number') entry.internalFormat = internalFormat;
    if (typeof pixelType === 'number') entry.pixelType = pixelType;
    if (isValidDimension(width)) entry.width = width;
    if (isValidDimension(height)) entry.height = height;

    if (image && typeof image !== 'number') {
      const preview = imageToPreview(image);
      const previewFull = imageToDataUrl(image, MAX_FULL_PREVIEW);
      if (preview) {
        entry.sourcePreview = preview;
        entry.previewError = null;
      }
      if (previewFull) entry.sourcePreviewFull = previewFull;
    }
  }

  /*
   * __THREE_DEVTOOLS__ — official Three.js ↔ debugger bridge
   *
   * Modern Three.js (r106+) and the official "Three.js" Chrome DevTools extension share a
   * page-global EventTarget: window.__THREE_DEVTOOLS__
   *
   * Contract (see three.js devtools/bridge.js and src/Three.Core.js):
   *   • Must exist in the page main world BEFORE three.module.js evaluates, or the
   *     library will not register. Ispettore injects at document_start for this reason.
   *   • Three.js dispatches CustomEvents on it:
   *       'register' — { revision } when the library loads
   *       'observe'  — detail is a live Scene, WebGLRenderer, or WebGPURenderer
   *   • The official extension's bridge listens to those events and builds its panel.
   *
   * If the separate Three.js DevTools extension is installed, it may create
   * __THREE_DEVTOOLS__ first. Ispettore only addEventListener()s — it never replaces
   * the global, so both extensions can coexist.
   *
   * Do not hook WebGLRenderer.prototype.render: Three assigns `this.render = function…`
   * on each instance in the constructor, so prototype patches are ignored. We wrap
   * instance.render when an 'observe' event delivers a renderer (or via ctor fallback).
   */
  function detectGpuApi() {
    return state.lastRenderer?.isWebGPURenderer ? 'webgpu' : 'webgl';
  }

  const threeComposer = installThreeComposerHooks({ state }) ?? {
    setWrapRendererRender: () => {},
    resetRenderTargetPassTracking: () => {},
    registerComposer: () => {},
    registerRenderPipeline: () => {},
    wrapRendererSetRenderTarget: () => {},
    wrapRendererAnimationLoop: () => {},
    hookEffectComposerClass: () => false,
    schedulePostProcessingAutoHook: () => {},
    hookRendererConstructors: () => false,
    noteManualPostEffectRenderCall: () => {}
  };

  const {
    setWrapRendererRender,
    resetRenderTargetPassTracking,
    registerComposer,
    registerRenderPipeline,
    wrapRendererSetRenderTarget,
    wrapRendererAnimationLoop,
    hookEffectComposerClass,
    schedulePostProcessingAutoHook,
    hookRendererConstructors: hookThreeRendererConstructors,
    noteManualPostEffectRenderCall
  } = threeComposer;


  function wrapRendererRender(renderer) {
    if (!renderer || renderer.__ispettoreRenderWrapped) return;
    const orig = renderer.render;
    if (typeof orig !== 'function') return;

    renderer.__ispettoreRenderWrapped = true;
    wrapRendererSetRenderTarget(renderer);
    wrapRendererAnimationLoop(renderer);
    renderer.render = function (scene, camera) {
      const s = window.__ispettoreState;
      if (s) {
        s.lastRenderer = renderer;
        s.lastScene = scene;
        s.lastCamera = camera;
      }
      noteManualPostEffectRenderCall(scene, camera);
      return orig.call(this, scene, camera);
    };

    if (
      typeof renderer.renderBufferDirect === 'function' &&
      !renderer.__ispettoreRenderBufferDirectWrapped
    ) {
      const origRenderBufferDirect = renderer.renderBufferDirect;
      renderer.__ispettoreRenderBufferDirectWrapped = true;
      renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
        const s = window.__ispettoreState;
        if (s) s.currentRenderObject = { object, geometry, material, group, camera };
        try {
          return origRenderBufferDirect.call(this, camera, scene, geometry, material, object, group);
        } finally {
          if (s) s.currentRenderObject = null;
        }
      };
    }
  }

  setWrapRendererRender(wrapRendererRender);

  function isThreeInternalAnimationBridge(fn) {
    return typeof fn === 'function' && fn.name === 'onAnimationFrame';
  }

  function watchWindowThree(onAvailable) {
    if (typeof onAvailable !== 'function') return;
    const notify = () => {
      if (window.THREE?.WebGLRenderer) onAvailable();
    };

    if (window.__ispettoreThreeWatcher) {
      notify();
      return;
    }
    window.__ispettoreThreeWatcher = true;

    let value = window.THREE;
    try {
      Object.defineProperty(window, 'THREE', {
        configurable: true,
        enumerable: true,
        get() {
          return value;
        },
        set(v) {
          value = v;
          notify();
        }
      });
    } catch (_) {
      /* non-configurable — observe event + polling still hook renderers */
    }
    notify();
  }

  function onThreeLibraryAvailable() {
    hookRendererConstructors();
    schedulePostProcessingAutoHook(trackThreeObject);
    for (const renderer of state.observedRenderers) trackThreeObject(renderer);
  }

  function trackThreeObject(obj) {
    if (!obj) return;

    if (obj.isWebGLRenderer || obj.isWebGPURenderer) {
      if (!state.observedRenderers.includes(obj)) state.observedRenderers.push(obj);
      wrapRendererRender(obj);
      wrapRendererSetRenderTarget(obj);
      wrapRendererAnimationLoop(obj);
      return;
    }

    if (obj.isScene && !state.observedScenes.includes(obj)) {
      state.observedScenes.push(obj);
    }
  }

  function onThreeRegister(event) {
    const revision = event?.detail?.revision;
    if (revision != null) state.threeVersion = String(revision);
  }

  function onThreeObserve(event) {
    trackThreeObject(event?.detail);
  }

  function ensureThreeDevToolsBridge() {
    if (state.threeBridgeAttached && window.__THREE_DEVTOOLS__) return true;

    if (!window.__THREE_DEVTOOLS__) {
      window.__THREE_DEVTOOLS__ = new EventTarget();
    }

    const bridge = window.__THREE_DEVTOOLS__;
    if (!bridge.__ispettoreListening) {
      bridge.addEventListener('register', onThreeRegister);
      bridge.addEventListener('observe', onThreeObserve);
      bridge.__ispettoreListening = true;
    }

    state.threeBridgeAttached = true;

    if (state.threeVersion == null && window.THREE?.REVISION != null) {
      state.threeVersion = String(window.THREE.REVISION);
    }

    return true;
  }

  function hookRendererConstructors() {
    return hookThreeRendererConstructors(trackThreeObject);
  }

  function prepareCapture() {
    ensureThreeDevToolsBridge();
    installHooks();
    hookRendererConstructors();
    schedulePostProcessingAutoHook(trackThreeObject);
  }

  function invokeWebGlCommand({ original, thisArg, args }) {
    return Reflect.apply(original, thisArg, args);
  }

  const annotateWebGlDraw = createWebGlDrawSemantics({
    getRenderObject: () => state.currentRenderObject,
    getActivePass: () => state.activePass ?? state.lastRenderTargetPass,
    getProgramEntry: (program) => state.programs.get(program),
    getTextureEntry: (texture) => textureByObject.get(texture),
    summarizeMesh: meshSummary
  });

  /** Distinct overload signatures kept per method for diagnostics; real methods have very few. */
  const MAX_JOURNAL_SIGNATURES = 8;

  function summarizeWebGlJournals() {
    return Array.from(state.webglJournals.values(), (journal) => {
      const methods = {};
      const failedMethods = {};
      const signatures = {};
      const failureReasons = {};
      for (const command of journal.commands) {
        methods[command.op] = (methods[command.op] ?? 0) + 1;
        if (command.failed) {
          failedMethods[command.op] = (failedMethods[command.op] ?? 0) + 1;
          const reasons = (failureReasons[command.op] ??= []);
          if (command.error && reasons.length < MAX_JOURNAL_SIGNATURES && !reasons.includes(command.error)) {
            reasons.push(command.error);
          }
        }
        if (!command.argTypes) continue;
        const recorded = (signatures[command.op] ??= []);
        const signature = command.argTypes.join(',');
        if (recorded.length < MAX_JOURNAL_SIGNATURES && !recorded.includes(signature)) {
          recorded.push(signature);
        }
      }
      return {
        contextId: journal.contextId,
        contextInfo: journal.contextInfo,
        commandCount: journal.commands.length,
        capturedBytes: journal.capturedBytes,
        overflow: journal.overflow,
        frames: journal.frames.map(
          ({ frameId, label, kind, startCommandIndex, endCommandIndex, commandCount }) => ({
            frameId,
            label,
            kind,
            startCommandIndex,
            endCommandIndex,
            commandCount
          })
        ),
        wrappedMethodCount: journal.wrappedMethods.length,
        valid: journal.valid,
        failureCount: journal.failures.length,
        resizes: journal.resizes,
        methods,
        failedMethods,
        signatures,
        failureReasons
      };
    });
  }

  function describeTrackedTexture(texture) {
    const entry = textureByObject.get(texture);
    if (!entry || !isValidDimension(entry.width) || !isValidDimension(entry.height)) return null;
    return { width: entry.width, height: entry.height };
  }

  function wrapContext(ctx) {
    if (ctx.__ispettoreWrapped) return ctx;
    ctx.__ispettoreWrapped = true;
    state.contexts.add(ctx);

    const journal = createWebGlCommandJournal(ctx, {
      shouldCapture: () => !state.ispettoreGlOperation,
      invoke: invokeWebGlCommand,
      annotate: annotateWebGlDraw,
      describeTexture: describeTrackedTexture,
      getProgramLabel: (program) => state.programs.get(program)?.label ?? null,
      runIsolated: withoutWebGlJournal
    });
    state.webglJournals.set(ctx, journal);

    const wrapUpload = (original) =>
      function (...args) {
        withoutWebGlJournal(() => {
          try {
            updateTextureFromUpload(ctx, args[0], args);
          } catch (_) {
            /* ignore */
          }
        });
        return original.apply(this, args);
      };

    if (ctx.texImage2D) ctx.texImage2D = wrapUpload(ctx.texImage2D.bind(ctx));
    if (ctx.texSubImage2D) ctx.texSubImage2D = wrapUpload(ctx.texSubImage2D.bind(ctx));

    if (ctx.texStorage2D) {
      const orig = ctx.texStorage2D.bind(ctx);
      ctx.texStorage2D = function (target, levels, internalformat, width, height) {
        withoutWebGlJournal(() => {
          try {
            const bindingEnum =
              target === ctx.TEXTURE_CUBE_MAP ? ctx.TEXTURE_BINDING_CUBE_MAP : ctx.TEXTURE_BINDING_2D;
            const tex = ctx.getParameter(bindingEnum);
            const entry = registerTexture(ctx, tex);
            if (entry) {
              entry.target = target;
              entry.internalFormat = internalformat;
              if (isValidDimension(width)) entry.width = width;
              if (isValidDimension(height)) entry.height = height;
            }
          } catch (_) {
            /* ignore */
          }
        });
        return orig(target, levels, internalformat, width, height);
      };
    }

    installProgramSpy(ctx, state.programs, { runInspection: withoutWebGlJournal });

    return ctx;
  }

  function hookGetContext() {
    const protos = [HTMLCanvasElement.prototype, OffscreenCanvas?.prototype].filter(Boolean);

    for (const proto of protos) {
      if (!proto?.getContext || proto.__ispettoreGetContextHooked) continue;
      proto.__ispettoreGetContextHooked = true;

      const original = proto.getContext;
      proto.getContext = function (type, ...rest) {
        const context = original.call(this, type, ...rest);
        if (context && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
          wrapContext(context);
        }
        if (context && type === 'webgpu') {
          webGpuCapture.observeCanvasContext(context);
        }
        return context;
      };
    }
  }

  function installHooks() {
    if (state.hooked) return;
    state.hooked = true;
    hookGetContext();
    hookRendererConstructors();
    hookEffectComposerClass();
    schedulePostProcessingAutoHook(trackThreeObject);
    setInterval(() => {
      ensureThreeDevToolsBridge();
      hookRendererConstructors();
      hookEffectComposerClass();
      schedulePostProcessingAutoHook(trackThreeObject);
    }, 1000);
  }

  /** First revision with active Scene/WebGLRenderer `observe` on `__THREE_DEVTOOLS__` (r105 was commented-out). */
  const THREE_DEVTOOLS_MIN_REVISION = 106;

  function parseThreeRevision(revision) {
    if (revision == null || revision === '') return null;
    const n = Number(revision);
    return Number.isFinite(n) ? n : null;
  }

  function buildPayload(extra = {}) {
    return withoutWebGlJournal(() => buildPayloadInternal(extra));
  }

  function buildPayloadInternal(extra = {}) {
    const { includeFullPreview, skipGpuSnapshot, ...restExtra } = extra;
    const sceneObject = pickSceneObject();
    const sceneRoot = sceneObject ? buildSceneTree(sceneObject) : null;
    const revision =
      state.threeVersion ?? (window.THREE?.REVISION != null ? String(window.THREE.REVISION) : null);
    const revisionNum = parseThreeRevision(revision);

    return {
      capturedAt: new Date().toISOString(),
      gpuApi: detectGpuApi(),
      three: {
        detected: Boolean(window.THREE) || state.observedScenes.length > 0,
        revision,
        devtoolsMinRevision: THREE_DEVTOOLS_MIN_REVISION,
        devtoolsBridge: revisionNum != null ? revisionNum >= THREE_DEVTOOLS_MIN_REVISION : null
      },
      renderers: collectRenderers(),
      scene: sceneRoot,
      sceneObjectCount: sceneObject ? countSceneObjects(sceneObject) : 0,
      camera: (state.composerMainCamera || state.lastCamera)
        ? {
            name: (state.composerMainCamera || state.lastCamera).name,
            type: (state.composerMainCamera || state.lastCamera).type,
            uuid: (state.composerMainCamera || state.lastCamera).uuid
          }
        : null,
      textures: withoutWebGlJournal(() =>
        collectTexturePayload({ includeFullPreview, skipGpuSnapshot })
      ),
      programs: Array.from(state.programs.values()),
      models: state.modelAssets.list(),
      webGlCaptureContexts: summarizeWebGlJournals(),
      webgpuContextCount: state.webgpuJournals?.size ?? 0,
      buildId: globalThis.__ISPETTORE_BUILD_ID ?? null,
      ...restExtra
    };
  }

  function installRafCapture() {
    if (window.requestAnimationFrame.__ispettoreWrapped) return;

    const chain = window.requestAnimationFrame.bind(window);
    const wrapped = function (callback) {
      return chain((time) => {
        if (
          typeof callback === 'function' &&
          typeof state.lastAnimationLoop !== 'function' &&
          !state.animationLoopFromRenderer &&
          !isThreeInternalAnimationBridge(callback)
        ) {
          state.lastAnimationLoop = callback;
        }
        beginAnimationRange(callback);
        try {
          return callback(time);
        } finally {
          endAnimationRange();
        }
      });
    };
    wrapped.__ispettoreWrapped = true;
    window.requestAnimationFrame = wrapped;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.channel !== CHANNEL) return;
    if (event.data.type !== 'COMMAND') return;

    if (event.data.command === 'PING') {
      prepareCapture();
      postCapture(buildPayload({ ping: true, skipGpuSnapshot: true }));
    }
  });

  window.__ISPETTORE__ = {
    getSnapshot(extra = {}) {
      prepareCapture();
      return buildPayload(extra);
    },
    getWebGlJournalSummary() {
      return summarizeWebGlJournals();
    },
    getWebGpuJournalSummary() {
      const summaries = Array.from(state.webgpuJournals.values(), (journal) => ({
        contextId: journal.contextId,
        adapter: journal.adapterInfo,
        device: journal.deviceInfo,
        commandCount: journal.commands.length,
        submissionCount: journal.submissionCount,
        frames: journal.frames.map(({ frameId, label, kind, startCommandIndex, endCommandIndex, commandCount }) => ({
          frameId, label, kind, startCommandIndex, endCommandIndex, commandCount
        })),
        configuration: journal.configuration ?? null
      }));
      if (!summaries.length && webGpuCapture.installWarnings.length) {
        summaries.push({
          contextId: null,
          installWarning: webGpuCapture.installWarnings.join('; '),
          commandCount: 0,
          frames: []
        });
      }
      return summaries;
    },
    async getWebGpuJournalPackage(contextId) {
      for (const journal of state.webgpuJournals.values()) {
        if (contextId == null || journal.contextId === contextId) {
          await journal.collectPendingPreviews();
          return serializeWebGpuJournal(journal);
        }
      }
      return null;
    },
    setWebGlJournalBudget(budget = {}) {
      prepareCapture();
      let applied = 0;
      for (const journal of state.webglJournals.values()) {
        journal.setBudget(budget);
        applied++;
      }
      return { applied };
    },
    getWebGlJournalPackage(contextId, frameId) {
      const first = state.webglJournals.values().next();
      if (contextId == null) {
        if (first.done) return null;
        return serializeWebGlJournal(first.value, frameId ? { frameId } : {});
      }
      for (const journal of state.webglJournals.values()) {
        if (journal.contextId === contextId) {
          return serializeWebGlJournal(journal, frameId ? { frameId } : {});
        }
      }
      return null;
    },
    // Spector-style arm: records nothing until the next full animation frame starts, and
    // stops automatically once that frame ends — the capture is always exactly one bounded
    // frame, however long the page has been running (docs/PLAN.md, Phase 9).
    armWebGlCapture(contextId) {
      prepareCapture();
      let applied = 0;
      for (const journal of state.webglJournals.values()) {
        if (contextId != null && journal.contextId !== contextId) continue;
        if (journal.arm()) applied++;
      }
      if (applied === 0) {
        console.warn('[ispettore] armWebGlCapture matched no WebGL context');
      }
      return { applied };
    },
    async storeWebGlFrame(contextId, frameId) {
      prepareCapture();
      let journal = null;
      for (const candidate of state.webglJournals.values()) {
        if (contextId == null || candidate.contextId === contextId) {
          journal = candidate;
          break;
        }
      }
      if (!journal) {
        return { ok: false, error: 'No matching WebGL context is available to capture' };
      }
      const range = frameId
        ? journal.frames.find((candidate) => candidate.frameId === frameId)
        : journal.frames.find((candidate) => CAPTURABLE_FRAME_KINDS.has(candidate.kind));
      if (!range) {
        return { ok: false, error: 'No completed WebGL animation frame is available to capture' };
      }
      const gpuTimings = await withoutWebGlJournal(() => journal.collectPendingGpuTimings());
      const serializeStartedAt = performance.now();
      const packageValue = serializeWebGlJournal(journal, { frameId: range.frameId, gpuTimings });
      const serializeMs = Math.round((performance.now() - serializeStartedAt) * 100) / 100;
      const result = await sendWebGlPackage(packageValue);
      if (!result.ok) return { ...result, serializeMs };
      return {
        ...result,
        serializeMs,
        capturedBytes: journal.capturedBytes,
        frameCommandCount: range.endCommandIndex - range.startCommandIndex
      };
    },
    armWebGpuCapture(contextId) {
      prepareCapture();
      let applied = 0;
      for (const journal of state.webgpuJournals.values()) {
        if (contextId != null && journal.contextId !== contextId) continue;
        if (journal.arm()) applied++;
      }
      return { applied };
    },
    async storeWebGpuFrame(contextId, frameId) {
      prepareCapture();
      let journal = null;
      for (const candidate of state.webgpuJournals.values()) {
        if (contextId == null || candidate.contextId === contextId) {
          journal = candidate;
          break;
        }
      }
      if (!journal) {
        return { ok: false, error: 'No matching WebGPU device journal is available to capture' };
      }
      const waitUntil = performance.now() + 3000;
      while (journal.isArmed) {
        if (performance.now() > waitUntil) return { ok: false, error: 'Timed out waiting for the armed WebGPU frame' };
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      const frames = journal.frames;
      const frame =
        (frameId
          ? frames.find((candidate) => candidate.frameId === frameId)
          : frames.at(-1));
      if (!frame) {
        return { ok: false, error: 'No completed WebGPU animation frame is available to capture' };
      }
      const serializeStartedAt = performance.now();
      await journal.collectPendingPreviews();
      const packageValue = serializeWebGpuJournal(journal, { frameId: frame.frameId });
      const serializeMs = Math.round((performance.now() - serializeStartedAt) * 100) / 100;
      const result = await sendWebGlPackage(packageValue);
      if (!result.ok) return { ...result, serializeMs };
      return {
        ...result,
        api: 'webgpu',
        serializeMs,
        capturedBytes: journal.capturedBytes,
        frameCommandCount: frame.endCommandIndex - frame.startCommandIndex
      };
    },
    async storeWebGlPackage(package_) {
      prepareCapture();
      const target =
        package_ ??
        (() => {
          const first = state.webglJournals.values().next();
          return first.done ? null : serializeWebGlJournal(first.value);
        })();
      if (target == null) {
        return { ok: false, error: 'No WebGL journal is available to store' };
      }
      return sendWebGlPackage(target);
    },
    registerComposer(composer) {
      prepareCapture();
      registerComposer(composer);
    },
    registerRenderPipeline(pipeline, opts) {
      prepareCapture();
      registerRenderPipeline(pipeline, opts);
    }
  };

  ensureThreeDevToolsBridge();
  watchWindowThree(onThreeLibraryAvailable);
  installTransferSender();
  prepareCapture();
  installRafCapture();
})();
