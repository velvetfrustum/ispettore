const TEXTURE_HINT_16X2D =
  'Three.js default texture fallback: the renderer binds this for MeshStandardMaterial / lighting (missing map slots, IBL-related defaults, etc.).';

export const getTextureHintText = (tex) => {
  if (tex.tooltip) return tex.tooltip;

  if (tex.width === 16 && tex.height === 16 && tex.target === 'TEXTURE_2D') {
    return TEXTURE_HINT_16X2D;
  }

  if (tex.width !== 1 || tex.height !== 1) return null;

  if (/CUBE_MAP/i.test(tex.target || '')) {
    return (
      `Three.js engine placeholder: a 1×1 cube map face (${tex.target}). ` +
      `Not your material — the renderer binds this so shaders always have a valid cubemap.`
    );
  }

  return (
    'A 1×1 placeholder texture, often created by Three.js as a default or fallback. ' +
    'Usually safe to ignore when debugging your materials.'
  );
};
