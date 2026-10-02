function method(name, category, { resultKind = null, argResourceIndexes = [] } = {}) {
  return Object.freeze({
    name,
    category,
    resultKind,
    argResourceIndexes: Object.freeze([...argResourceIndexes])
  });
}

const METHOD_NAMES = `
  activeTexture attachShader beginQuery beginTransformFeedback bindAttribLocation bindBuffer
  bindBufferBase bindBufferRange bindFramebuffer bindRenderbuffer bindSampler bindTexture
  bindTransformFeedback bindVertexArray blendColor blendEquation blendEquationSeparate blendFunc
  blendFuncSeparate blitFramebuffer bufferData bufferSubData checkFramebufferStatus clear
  clearBufferfi clearBufferfv clearBufferiv clearBufferuiv clearColor clearDepth clearStencil
  clientWaitSync colorMask compileShader compressedTexImage2D compressedTexImage3D
  compressedTexSubImage2D compressedTexSubImage3D copyBufferSubData copyTexImage2D copyTexSubImage2D
  copyTexSubImage3D createBuffer createFramebuffer createProgram createQuery createRenderbuffer
  createSampler createShader createTexture createTransformFeedback createVertexArray cullFace
  deleteBuffer deleteFramebuffer deleteProgram deleteQuery deleteRenderbuffer deleteSampler
  deleteShader deleteSync deleteTexture deleteTransformFeedback deleteVertexArray depthFunc depthMask
  depthRange detachShader disable disableVertexAttribArray drawArrays drawArraysInstanced drawBuffers
  drawElements drawElementsInstanced drawRangeElements enable enableVertexAttribArray endQuery
  endTransformFeedback fenceSync finish flush framebufferRenderbuffer framebufferTexture2D
  framebufferTextureLayer frontFace generateMipmap getActiveAttrib getActiveUniform
  getActiveUniformBlockName getActiveUniformBlockParameter getActiveUniforms getAttachedShaders
  getAttribLocation getBufferParameter getBufferSubData getContextAttributes getError getExtension
  getFragDataLocation getFramebufferAttachmentParameter getIndexedParameter getInternalformatParameter
  getParameter getProgramInfoLog getProgramParameter getQuery getQueryParameter getRenderbufferParameter
  getSamplerParameter getShaderInfoLog getShaderParameter getShaderPrecisionFormat getShaderSource
  getSupportedExtensions getSyncParameter getTexParameter getTransformFeedbackVarying getUniform
  getUniformBlockIndex getUniformIndices getUniformLocation getVertexAttrib getVertexAttribOffset hint
  invalidateFramebuffer invalidateSubFramebuffer isBuffer isContextLost isEnabled isFramebuffer
  isProgram isQuery isRenderbuffer isSampler isShader isSync isTexture isTransformFeedback
  isVertexArray lineWidth linkProgram makeXRCompatible pauseTransformFeedback pixelStorei polygonOffset
  readBuffer readPixels renderbufferStorage renderbufferStorageMultisample resumeTransformFeedback
  sampleCoverage samplerParameterf samplerParameteri scissor shaderSource stencilFunc stencilFuncSeparate
  stencilMask stencilMaskSeparate stencilOp stencilOpSeparate texImage2D texImage3D texParameterf
  texParameteri texStorage2D texStorage3D texSubImage2D texSubImage3D transformFeedbackVaryings
  uniform1f uniform1fv uniform1i uniform1iv uniform1ui uniform1uiv uniform2f uniform2fv uniform2i
  uniform2iv uniform2ui uniform2uiv uniform3f uniform3fv uniform3i uniform3iv uniform3ui uniform3uiv
  uniform4f uniform4fv uniform4i uniform4iv uniform4ui uniform4uiv uniformBlockBinding uniformMatrix2fv
  uniformMatrix2x3fv uniformMatrix2x4fv uniformMatrix3fv uniformMatrix3x2fv uniformMatrix3x4fv
  uniformMatrix4fv uniformMatrix4x2fv uniformMatrix4x3fv useProgram validateProgram vertexAttrib1f
  vertexAttrib1fv vertexAttrib2f vertexAttrib2fv vertexAttrib3f vertexAttrib3fv vertexAttrib4f
  vertexAttrib4fv vertexAttribDivisor vertexAttribI4i vertexAttribI4iv vertexAttribI4ui
  vertexAttribI4uiv vertexAttribIPointer vertexAttribPointer viewport waitSync
`.trim().split(/\s+/);

const RESOURCE_RESULTS = {
  createBuffer: 'buffer',
  createFramebuffer: 'framebuffer',
  createProgram: 'program',
  createQuery: 'query',
  createRenderbuffer: 'renderbuffer',
  createSampler: 'sampler',
  createShader: 'shader',
  createTexture: 'texture',
  createTransformFeedback: 'transform-feedback',
  createVertexArray: 'vertex-array',
  fenceSync: 'sync',
  getUniformLocation: 'uniform-location'
};

const RESOURCE_ARGS = {
  attachShader: [0, 1],
  beginQuery: [1],
  bindAttribLocation: [0],
  bindBuffer: [1],
  bindBufferBase: [2],
  bindBufferRange: [2],
  bindFramebuffer: [1],
  bindRenderbuffer: [1],
  bindSampler: [1],
  bindTexture: [1],
  bindTransformFeedback: [1],
  bindVertexArray: [0],
  clientWaitSync: [0],
  compileShader: [0],
  deleteBuffer: [0],
  deleteFramebuffer: [0],
  deleteProgram: [0],
  deleteQuery: [0],
  deleteRenderbuffer: [0],
  deleteSampler: [0],
  deleteShader: [0],
  deleteSync: [0],
  deleteTexture: [0],
  deleteTransformFeedback: [0],
  deleteVertexArray: [0],
  detachShader: [0, 1],
  framebufferRenderbuffer: [3],
  framebufferTexture2D: [3],
  framebufferTextureLayer: [2],
  getActiveAttrib: [0],
  getActiveUniform: [0],
  getActiveUniformBlockName: [0],
  getActiveUniformBlockParameter: [0],
  getActiveUniforms: [0],
  getAttachedShaders: [0],
  getAttribLocation: [0],
  getFragDataLocation: [0],
  getProgramInfoLog: [0],
  getProgramParameter: [0],
  getQueryParameter: [0],
  getSamplerParameter: [0],
  getShaderInfoLog: [0],
  getShaderParameter: [0],
  getShaderSource: [0],
  getSyncParameter: [0],
  getTransformFeedbackVarying: [0],
  getUniform: [0, 1],
  getUniformBlockIndex: [0],
  getUniformIndices: [0],
  getUniformLocation: [0],
  isBuffer: [0],
  isFramebuffer: [0],
  isProgram: [0],
  isQuery: [0],
  isRenderbuffer: [0],
  isSampler: [0],
  isShader: [0],
  isSync: [0],
  isTexture: [0],
  isTransformFeedback: [0],
  isVertexArray: [0],
  linkProgram: [0],
  samplerParameterf: [0],
  samplerParameteri: [0],
  shaderSource: [0],
  transformFeedbackVaryings: [0],
  uniform1f: [0],
  uniform1fv: [0],
  uniform1i: [0],
  uniform1iv: [0],
  uniform1ui: [0],
  uniform1uiv: [0],
  uniform2f: [0],
  uniform2fv: [0],
  uniform2i: [0],
  uniform2iv: [0],
  uniform2ui: [0],
  uniform2uiv: [0],
  uniform3f: [0],
  uniform3fv: [0],
  uniform3i: [0],
  uniform3iv: [0],
  uniform3ui: [0],
  uniform3uiv: [0],
  uniform4f: [0],
  uniform4fv: [0],
  uniform4i: [0],
  uniform4iv: [0],
  uniform4ui: [0],
  uniform4uiv: [0],
  uniformBlockBinding: [0],
  uniformMatrix2fv: [0],
  uniformMatrix2x3fv: [0],
  uniformMatrix2x4fv: [0],
  uniformMatrix3fv: [0],
  uniformMatrix3x2fv: [0],
  uniformMatrix3x4fv: [0],
  uniformMatrix4fv: [0],
  uniformMatrix4x2fv: [0],
  uniformMatrix4x3fv: [0],
  useProgram: [0],
  validateProgram: [0],
  waitSync: [0]
};

const DELETE_METHODS = new Set([
  'deleteBuffer',
  'deleteFramebuffer',
  'deleteProgram',
  'deleteQuery',
  'deleteRenderbuffer',
  'deleteSampler',
  'deleteShader',
  'deleteSync',
  'deleteTexture',
  'deleteTransformFeedback',
  'deleteVertexArray'
]);

const ACTION_METHODS = new Set([
  'blitFramebuffer',
  'clear',
  'clearBufferfi',
  'clearBufferfv',
  'clearBufferiv',
  'clearBufferuiv',
  'drawArrays',
  'drawArraysInstanced',
  'drawElements',
  'drawElementsInstanced',
  'drawRangeElements'
]);

const DATA_METHODS = new Set([
  'bufferData',
  'bufferSubData',
  'compressedTexImage2D',
  'compressedTexImage3D',
  'compressedTexSubImage2D',
  'compressedTexSubImage3D',
  'texImage2D',
  'texImage3D',
  'texSubImage2D',
  'texSubImage3D'
]);

const READBACK_METHODS = new Set(['getBufferSubData', 'readPixels']);

function categoryFor(name) {
  if (RESOURCE_RESULTS[name]) return 'resource';
  if (DELETE_METHODS.has(name)) return 'resource-delete';
  if (ACTION_METHODS.has(name)) return 'action';
  if (READBACK_METHODS.has(name)) return 'readback';
  if (DATA_METHODS.has(name)) return 'resource-data';
  if (RESOURCE_ARGS[name]) return 'resource-state';
  return 'context-state';
}

export const WEBGL_API_SPEC = Object.freeze(
  METHOD_NAMES.map((name) =>
    method(name, categoryFor(name), {
      resultKind: RESOURCE_RESULTS[name] ?? null,
      argResourceIndexes: RESOURCE_ARGS[name] ?? []
    })
  )
);
