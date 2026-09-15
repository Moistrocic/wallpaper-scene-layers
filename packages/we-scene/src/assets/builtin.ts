import type { MaterialDefinition, ModelDefinition } from "../scene/types.js";

export interface BuiltinImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Wallpaper Engine ships a set of utility textures that scenes reference but do
 * not contain (`util/white`, `particle/halo`, ...). They are regenerated here so
 * that a package can be rendered without the engine installation.
 */
export function createBuiltinImage(name: string): BuiltinImage {
  const key = name.toLowerCase().replace(/^materials\//, "").replace(/\.tex$/, "");
  if (key.startsWith("particle/beam")) return createBeam(32, 128);
  const halo = HALO_PROFILES[key];
  if (halo) return createHalo(halo.size, halo.profile);
  if (key.startsWith("particle/halo")) return createHalo(64, HALO_PROFILES["particle/halo"].profile);
  if (key.startsWith("util/clouds")) return createClouds(256);
  if (key.startsWith("util/normal") || key.endsWith("_normal")) return createSolid(4, 4, [128, 128, 255, 255]);
  if (key.startsWith("util/black")) return createSolid(4, 4, [0, 0, 0, 255]);
  if (key.includes("noise")) return createClouds(256);
  return createSolid(4, 4, [255, 255, 255, 255]);
}

export function createSolid(width: number, height: number, rgba: [number, number, number, number]): BuiltinImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = rgba[0];
    pixels[i * 4 + 1] = rgba[1];
    pixels[i * 4 + 2] = rgba[2];
    pixels[i * 4 + 3] = rgba[3];
  }
  return { width, height, pixels };
}

/**
 * Radial alpha profiles of the engine's built-in particle sprites, sampled at
 * 17 evenly spaced radii (0 = centre, 1 = edge of the sprite).
 *
 * They were measured from the `assets/materials/particle/*.tex` files shipped
 * with Wallpaper Engine so that the procedurally generated replacements below
 * have the same brightness and falloff. Sprites are expensive to get wrong:
 * particles use additive blending, so being a few times too bright turns a
 * field of embers into one washed out blob.
 */
export const HALO_PROFILES: Record<string, { size: number; profile: number[] }> = {
  "particle/halo": {
    size: 64,
    profile: [0.922, 0.914, 0.886, 0.831, 0.753, 0.655, 0.545, 0.427, 0.322, 0.224, 0.149, 0.09, 0.055, 0.031, 0.016, 0.008, 0]
  },
  "particle/halo_2": {
    size: 64,
    profile: [1, 0.993, 0.847, 0.475, 0.302, 0.259, 0.216, 0.176, 0.137, 0.1, 0.071, 0.047, 0.031, 0.02, 0.012, 0.008, 0.006]
  },
  "particle/halo_3": {
    size: 64,
    profile: [1, 1, 1, 0.514, 0.283, 0.145, 0.061, 0.025, 0.029, 0.051, 0.082, 0.103, 0.096, 0.065, 0.027, 0.008, 0]
  },
  "particle/halo_4": {
    size: 128,
    // A tiny bright core with a long low tail: this is the ember point itself.
    profile: [0.882, 0.58, 0.196, 0.165, 0.149, 0.129, 0.114, 0.094, 0.075, 0.059, 0.043, 0.031, 0.02, 0.016, 0.008, 0.004, 0.004]
  },
  "particle/halo_5": {
    size: 64,
    // A ring (the alpha peaks away from the centre).
    profile: [0, 0.008, 0.054, 0.124, 0.208, 0.302, 0.394, 0.496, 0.598, 0.69, 0.782, 0.851, 0.816, 0.567, 0.203, 0.031, 0]
  },
  "particle/halo_6": {
    size: 128,
    profile: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0.996, 0.969, 0.843, 0.59, 0.299, 0.116, 0.028, 0]
  },
  "particle/chromaticdot": {
    size: 64,
    profile: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  }
};

/** Linearly interpolates one of the measured radial profiles. */
export function sampleProfile(profile: number[], radius: number): number {
  const clamped = Math.min(1, Math.max(0, radius));
  const position = clamped * (profile.length - 1);
  const index = Math.floor(position);
  const next = Math.min(profile.length - 1, index + 1);
  const t = position - index;
  return profile[index] * (1 - t) + profile[next] * t;
}

/**
 * Light point sprite ("halo") built from a radial alpha profile.
 * White RGB, alpha from the profile - the same layout the engine uses.
 */
export function createHalo(size = 128, profile: number[] = HALO_PROFILES["particle/halo"].profile): BuiltinImage {
  const pixels = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const alpha = Math.min(1, Math.max(0, sampleProfile(profile, Math.hypot(dx, dy))));
      const index = (y * size + x) * 4;
      pixels[index] = 255;
      pixels[index + 1] = 255;
      pixels[index + 2] = 255;
      pixels[index + 3] = Math.round(alpha * 255);
    }
  }
  return { width: size, height: size, pixels };
}

/**
 * Fallback for the engine's beam textures (`particle/beam/beam_1`, 32x128).
 *
 * Those textures keep alpha at 1 and put a noisy luminance pattern in RGB
 * (mean luminance around 0.45), and the sprite is stretched along the particle
 * velocity by the trail renderer.
 */
export function createBeam(width = 32, height = 128): BuiltinImage {
  const pixels = new Uint8Array(width * height * 4);
  const random = mulberry32(0x5bf03635);
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    // Taper the ends, keep the middle bright, and never reach full black.
    const taper = v < 0.06 ? v / 0.06 : v > 0.94 ? (1 - v) / 0.06 : 1;
    for (let x = 0; x < width; x++) {
      const u = (x / (width - 1)) * 2 - 1;
      const across = Math.pow(Math.max(0, 1 - Math.abs(u)), 0.35);
      const grain = 0.55 + random() * 0.45;
      const value = Math.min(1, Math.max(0, 0.18 + across * taper * grain * 0.8));
      const index = (y * width + x) * 4;
      pixels[index] = Math.round(value * 255);
      pixels[index + 1] = Math.round(value * 255);
      pixels[index + 2] = Math.round(value * 255);
      pixels[index + 3] = 255;
    }
  }
  return { width, height, pixels };
}

/** Cheap value noise, used for `util/clouds_256` style masks. */
export function createClouds(size = 256): BuiltinImage {
  const pixels = new Uint8Array(size * size * 4);
  const grid = 8;
  const random = mulberry32(0x9e3779b9);
  const values = new Float32Array((grid + 1) * (grid + 1));
  for (let i = 0; i < values.length; i++) values[i] = random();
  const sample = (x: number, y: number) => {
    const gx = Math.min(grid, Math.max(0, Math.floor(x)));
    const gy = Math.min(grid, Math.max(0, Math.floor(y)));
    const fx = x - gx;
    const fy = y - gy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const v00 = values[gy * (grid + 1) + gx];
    const v10 = values[gy * (grid + 1) + Math.min(grid, gx + 1)];
    const v01 = values[Math.min(grid, gy + 1) * (grid + 1) + gx];
    const v11 = values[Math.min(grid, gy + 1) * (grid + 1) + Math.min(grid, gx + 1)];
    return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * grid;
      const v = (y / size) * grid;
      const n = sample(u, v) * 0.6 + sample(u * 2.13, v * 2.13) * 0.3 + sample(u * 4.7, v * 4.7) * 0.1;
      const index = (y * size + x) * 4;
      const value = Math.round(Math.min(1, Math.max(0, n)) * 255);
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }
  return { width: size, height: size, pixels };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Built in models the engine resolves without the package shipping them. */
export function getBuiltinModel(path: string): ModelDefinition | undefined {
  const key = path.toLowerCase();
  if (key.includes("solidlayer")) {
    return { material: "materials/util/solidlayer.json", autosize: false, solidlayer: true, source: path };
  }
  return undefined;
}

/** Built in materials, expressed with the shader names this runtime provides. */
export function getBuiltinMaterial(path: string): MaterialDefinition | undefined {
  const key = path.toLowerCase();
  if (key.includes("solidlayer")) {
    return {
      passes: [
        {
          shader: "solid",
          textures: [],
          combos: {},
          constantshader: {},
          constantshadervalues: {},
          blending: "translucent",
          cullMode: "nocull",
          depthTest: false,
          depthWrite: false,
          alphaWriting: "default"
        }
      ]
    };
  }
  return undefined;
}
