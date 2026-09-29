/**
 * Colour helpers: CIE 1931 xy ⇄ sRGB (with gamut clamping) and mirek ⇄ kelvin.
 *
 * The xy conversion follows the well-known Hue approach: linearise sRGB,
 * transform to XYZ with the Wide RGB D65 matrix, normalise to xy, then clamp
 * to the light's gamut triangle so the bridge never rejects the value.
 */

import type { Gamut, XY } from './types.js';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Default gamut (Hue "C" gamut) used when a light does not report one. */
export const GAMUT_C: Gamut = {
  red: { x: 0.6915, y: 0.3083 },
  green: { x: 0.17, y: 0.7 },
  blue: { x: 0.1532, y: 0.0475 },
};

export function parseHexColor(hex: string): RGB {
  const clean = hex.trim().replace(/^#/, '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Invalid hex colour: ${hex}`);
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function linearise(c: number): number {
  const v = c / 255;
  return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
}

function delinearise(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp(c, 0, 1) * 255;
}

/** Converts sRGB (0–255) to xy, clamped to `gamut`. Also returns a brightness hint (0–100). */
export function rgbToXy(rgb: RGB, gamut: Gamut = GAMUT_C): { xy: XY; brightness: number } {
  const r = linearise(rgb.r);
  const g = linearise(rgb.g);
  const b = linearise(rgb.b);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  const xy = sum === 0 ? { x: 0.3127, y: 0.329 } : { x: X / sum, y: Y / sum };
  return { xy: clampToGamut(xy, gamut), brightness: clamp(Y * 100, 0, 100) };
}

/** Converts xy + brightness (0–100) back to sRGB (0–255). */
export function xyToRgb(xy: XY, brightness = 100, gamut: Gamut = GAMUT_C): RGB {
  const { x, y } = clampToGamut(xy, gamut);
  const Y = clamp(brightness, 0, 100) / 100;
  if (y === 0) return { r: 0, g: 0, b: 0 };
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const max = Math.max(r, g, b);
  if (max > 1) {
    r /= max;
    g /= max;
    b /= max;
  }
  return { r: delinearise(Math.max(r, 0)), g: delinearise(Math.max(g, 0)), b: delinearise(Math.max(b, 0)) };
}

export function isInGamut(p: XY, gamut: Gamut): boolean {
  const { red, green, blue } = gamut;
  const v1 = { x: green.x - red.x, y: green.y - red.y };
  const v2 = { x: blue.x - red.x, y: blue.y - red.y };
  const q = { x: p.x - red.x, y: p.y - red.y };
  const s = cross(q, v2) / cross(v1, v2);
  const t = cross(v1, q) / cross(v1, v2);
  return s >= 0 && t >= 0 && s + t <= 1;
}

export function clampToGamut(p: XY, gamut: Gamut): XY {
  if (isInGamut(p, gamut)) return p;
  const candidates = [
    closestPointOnSegment(gamut.red, gamut.green, p),
    closestPointOnSegment(gamut.blue, gamut.red, p),
    closestPointOnSegment(gamut.green, gamut.blue, p),
  ];
  let best = candidates[0]!;
  let bestDistance = distance(p, best);
  for (const c of candidates.slice(1)) {
    const d = distance(p, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return { x: round(best.x), y: round(best.y) };
}

function closestPointOnSegment(a: XY, b: XY, p: XY): XY {
  const ap = { x: p.x - a.x, y: p.y - a.y };
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const ab2 = ab.x * ab.x + ab.y * ab.y;
  const t = ab2 === 0 ? 0 : clamp((ap.x * ab.x + ap.y * ab.y) / ab2, 0, 1);
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

function cross(a: XY, b: XY): number {
  return a.x * b.y - a.y * b.x;
}

function distance(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Mirek (micro reciprocal kelvin) to kelvin. Hue lights span ~153 (6500 K) to ~500 (2000 K). */
export function mirekToKelvin(mirek: number): number {
  return Math.round(1_000_000 / mirek);
}

export function kelvinToMirek(kelvin: number): number {
  return Math.round(1_000_000 / kelvin);
}

/**
 * Hue light-level sensors report `10000 * log10(lux) + 1`; invert it.
 * See the CLIP `light_level` documentation.
 */
export function lightLevelToLux(lightLevel: number): number {
  return Math.round(Math.pow(10, (lightLevel - 1) / 10000) * 100) / 100;
}
