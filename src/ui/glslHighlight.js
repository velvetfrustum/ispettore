const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard', 'switch',
  'case', 'default', 'struct', 'precision', 'highp', 'mediump', 'lowp', 'const', 'in', 'out',
  'inout', 'uniform', 'buffer', 'varying', 'attribute', 'layout', 'flat', 'smooth', 'invariant',
  'centroid', 'patch', 'void', 'true', 'false'
]);

const TYPES = new Set([
  'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'bvec2', 'bvec3', 'bvec4', 'dvec2', 'dvec3', 'dvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray', 'sampler2DShadow',
  'samplerCubeShadow', 'sampler2DArrayShadow', 'isampler2D', 'usampler2D'
]);

const BUILTINS = new Set([
  'gl_Position', 'gl_FragColor', 'gl_FragCoord', 'gl_PointSize', 'gl_FragDepth', 'gl_VertexID',
  'gl_InstanceID', 'texture', 'texture2D', 'textureCube', 'textureProj', 'texelFetch',
  'normalize', 'dot', 'cross', 'mix', 'clamp', 'min', 'max', 'pow', 'sqrt', 'inversesqrt',
  'floor', 'ceil', 'round', 'fract', 'mod', 'abs', 'sign', 'length', 'distance', 'reflect',
  'refract', 'step', 'smoothstep', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan', 'asin',
  'acos', 'atan', 'transpose', 'inverse', 'determinant'
]);

const TOKEN_PATTERN = new RegExp(
  [
    '(\\/\\/[^\\n]*)', // 1: line comment
    '(\\/\\*[\\s\\S]*?\\*\\/)', // 2: block comment
    '(^[ \\t]*#[^\\n]*)', // 3: preprocessor directive
    '(\\b\\d+\\.\\d+(?:[eE][+-]?\\d+)?[fF]?\\b|\\b\\.\\d+\\b|\\b\\d+[fF]?\\b)', // 4: number
    '([A-Za-z_][A-Za-z0-9_]*)' // 5: identifier
  ].join('|'),
  'gm'
);

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function classifyIdentifier(word) {
  if (KEYWORDS.has(word)) return 'glsl-keyword';
  if (TYPES.has(word)) return 'glsl-type';
  if (BUILTINS.has(word) || word.startsWith('gl_')) return 'glsl-builtin';
  return null;
}

export function highlightGlsl(source) {
  if (typeof source !== 'string' || !source) return '';
  let html = '';
  let lastIndex = 0;
  TOKEN_PATTERN.lastIndex = 0;

  let match;
  while ((match = TOKEN_PATTERN.exec(source))) {
    const [full, lineComment, blockComment, preprocessor, number, identifier] = match;
    html += escapeHtml(source.slice(lastIndex, match.index));

    if (lineComment || blockComment) {
      html += `<span class="glsl-comment">${escapeHtml(full)}</span>`;
    } else if (preprocessor) {
      html += `<span class="glsl-preprocessor">${escapeHtml(full)}</span>`;
    } else if (number) {
      html += `<span class="glsl-number">${escapeHtml(full)}</span>`;
    } else if (identifier) {
      const className = classifyIdentifier(identifier);
      html += className ? `<span class="${className}">${identifier}</span>` : identifier;
    }

    lastIndex = match.index + full.length;
  }
  html += escapeHtml(source.slice(lastIndex));
  return html;
}
