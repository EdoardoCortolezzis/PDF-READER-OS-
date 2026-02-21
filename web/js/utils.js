export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clampByte(value) {
  return clamp(Math.round(value), 0, 255);
}

export function hexToRgb(hexColor) {
  if (!/^#[0-9a-f]{6}$/i.test(hexColor)) {
    return null;
  }

  return {
    r: parseInt(hexColor.slice(1, 3), 16),
    g: parseInt(hexColor.slice(3, 5), 16),
    b: parseInt(hexColor.slice(5, 7), 16),
  };
}

export function rgbToCss(rgbColor) {
  return `rgb(${clampByte(rgbColor.r)}, ${clampByte(rgbColor.g)}, ${clampByte(rgbColor.b)})`;
}

export function mixRgb(colorA, colorB, mixFactor) {
  const t = clamp(mixFactor, 0, 1);
  return {
    r: clampByte(colorA.r + (colorB.r - colorA.r) * t),
    g: clampByte(colorA.g + (colorB.g - colorA.g) * t),
    b: clampByte(colorA.b + (colorB.b - colorA.b) * t),
  };
}

export function darkenRgb(color, amount) {
  return mixRgb(color, { r: 0, g: 0, b: 0 }, amount);
}

export function lightenRgb(color, amount) {
  return mixRgb(color, { r: 255, g: 255, b: 255 }, amount);
}
