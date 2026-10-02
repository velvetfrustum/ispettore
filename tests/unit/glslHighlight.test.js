import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { highlightGlsl } from '../../src/ui/glslHighlight.js';

describe('highlightGlsl', () => {
  it('wraps keywords, types, numbers, and comments in classed spans', () => {
    const source = 'uniform float uTime;\nvoid main() {\n  vec3 pos = position * 2.0; // scale\n}';
    const html = highlightGlsl(source);

    assert.match(html, /<span class="glsl-keyword">uniform<\/span>/);
    assert.match(html, /<span class="glsl-type">float<\/span>/);
    assert.match(html, /<span class="glsl-type">vec3<\/span>/);
    assert.match(html, /<span class="glsl-number">2\.0<\/span>/);
    assert.match(html, /<span class="glsl-comment">\/\/ scale<\/span>/);
  });

  it('highlights preprocessor directives and gl_ builtins', () => {
    const html = highlightGlsl('#define PI 3.14159\nvoid main() {\n  gl_Position = vec4(0.0);\n}');
    assert.match(html, /<span class="glsl-preprocessor">#define PI 3\.14159<\/span>/);
    assert.match(html, /<span class="glsl-builtin">gl_Position<\/span>/);
  });

  it('escapes HTML-significant characters outside of tokens', () => {
    const html = highlightGlsl('// a < b && b > c');
    assert.ok(!html.includes('< b'));
    assert.match(html, /&lt; b/);
  });

  it('returns an empty string for non-string or empty input', () => {
    assert.equal(highlightGlsl(''), '');
    assert.equal(highlightGlsl(null), '');
    assert.equal(highlightGlsl(undefined), '');
  });
});
