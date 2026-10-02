function isWebGL2(gl) {
  return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
}

function clearGlErrors(gl) {
  while (gl.getError() !== gl.NO_ERROR) {
    /* drain */
  }
}

const copyResourcesByGl = new WeakMap();

function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function getCopyResources(gl) {
  let res = copyResourcesByGl.get(gl);
  if (res) return res;

  const vs = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`
  );
  const fs = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  c = c / (vec3(1.0) + c);
  c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  outColor = vec4(c, 1.0);
}`
  );
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW
  );
  const loc = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  res = {
    program,
    vao,
    vbo,
    uTex: gl.getUniformLocation(program, 'uTex')
  };
  copyResourcesByGl.set(gl, res);
  return res;
}

function getBoundColorTexture(gl) {
  if (!gl.getFramebufferAttachmentParameter) return null;
  try {
    const objectType = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE
    );
    if (objectType !== gl.TEXTURE) return null;
    return gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME
    );
  } catch (_) {
    return null;
  }
}

/** Sample COLOR_ATTACHMENT0 through a tone-mapped copy into RGBA8, then readPixels. */
function readFramebufferViaCopyShader(gl, width, height) {
  if (!isWebGL2(gl)) return null;

  const srcTex = getBoundColorTexture(gl);
  if (!srcTex) return null;

  const copy = getCopyResources(gl);
  if (!copy) return null;

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    return null;
  }

  const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
  const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
  const prevViewport = gl.getParameter(gl.VIEWPORT);
  const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
  const prevTex2dActive = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.activeTexture(gl.TEXTURE0);
  const prevTex2d0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.activeTexture(prevActive);
  const prevBlend = gl.isEnabled(gl.BLEND);
  const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
  const prevScissor = gl.isEnabled(gl.SCISSOR_TEST);

  let dstTex = null;
  let dstFb = null;

  try {
    dstTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dstTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    dstFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      return null;
    }

    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);

    gl.useProgram(copy.program);
    gl.bindVertexArray(copy.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(copy.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (gl.getError() !== gl.NO_ERROR) {
      clearGlErrors(gl);
      return null;
    }

    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, dstFb);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() === gl.NO_ERROR) return pixels;
  } catch (_) {
    /* ignore */
  } finally {
    if (dstFb) gl.deleteFramebuffer(dstFb);
    if (dstTex) gl.deleteTexture(dstTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, prevTex2d0);
    if (prevActive !== gl.TEXTURE0) {
      gl.activeTexture(prevActive);
      gl.bindTexture(gl.TEXTURE_2D, prevTex2dActive);
    }
    gl.bindVertexArray(prevVao);
    gl.useProgram(prevProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    if (prevBlend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    if (prevDepth) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (prevScissor) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
  }

  return null;
}

/** When float/half-float readPixels fails, blit the bound FB to a readable RGBA8 FBO. */
function readFramebufferViaBlit(gl, width, height) {
  if (!isWebGL2(gl) || !gl.blitFramebuffer || !gl.createFramebuffer) return null;

  const srcFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  if (!srcFb) return null;

  const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);

  let dstTex = null;
  let dstFb = null;

  try {
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      return null;
    }

    dstTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dstTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    dstFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dstFb);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);
    if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      return null;
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFb);
    gl.blitFramebuffer(
      0,
      0,
      width,
      height,
      0,
      0,
      width,
      height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST
    );
    if (gl.getError() !== gl.NO_ERROR) {
      clearGlErrors(gl);
      return null;
    }

    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, dstFb);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() === gl.NO_ERROR) return pixels;
  } catch (_) {
    /* ignore */
  } finally {
    if (dstFb) gl.deleteFramebuffer(dstFb);
    if (dstTex) gl.deleteTexture(dstTex);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
  }

  return null;
}

export const webglFramebuffer = {
  readFramebufferViaBlit,
  readFramebufferViaCopyShader
};
