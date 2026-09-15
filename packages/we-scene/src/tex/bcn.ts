/**
 * Software decoders for the BC1/BC2/BC3 (DXT1/DXT3/DXT5) blocks that Wallpaper
 * Engine uses for packed textures.
 *
 * The WebGL renderer prefers the GPU compressed texture extensions when they are
 * available; these decoders are the portable fallback (and are what the
 * offscreen `decodeTexture` helper uses to produce an `ImageData`).
 */

function expand565(value: number): [number, number, number] {
  const r = (value >> 11) & 0x1f;
  const g = (value >> 5) & 0x3f;
  const b = value & 0x1f;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/** Decodes one 4x4 colour block into `out` at (x, y). */
function decodeColorBlock(
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  dxt1: boolean
): void {
  const c0 = data[offset] | (data[offset + 1] << 8);
  const c1 = data[offset + 2] | (data[offset + 3] << 8);
  const [r0, g0, b0] = expand565(c0);
  const [r1, g1, b1] = expand565(c1);

  const palette = new Uint8Array(16);
  palette[0] = r0; palette[1] = g0; palette[2] = b0; palette[3] = 255;
  palette[4] = r1; palette[5] = g1; palette[6] = b1; palette[7] = 255;

  if (!dxt1 || c0 > c1) {
    palette[8] = (2 * r0 + r1) / 3; palette[9] = (2 * g0 + g1) / 3; palette[10] = (2 * b0 + b1) / 3; palette[11] = 255;
    palette[12] = (r0 + 2 * r1) / 3; palette[13] = (g0 + 2 * g1) / 3; palette[14] = (b0 + 2 * b1) / 3; palette[15] = 255;
  } else {
    palette[8] = (r0 + r1) / 2; palette[9] = (g0 + g1) / 2; palette[10] = (b0 + b1) / 2; palette[11] = 255;
    palette[12] = 0; palette[13] = 0; palette[14] = 0; palette[15] = 0;
  }

  const bits = data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24);
  for (let i = 0; i < 16; i++) {
    const px = x + (i & 3);
    const py = y + (i >> 2);
    if (px >= width || py >= height) continue;
    const index = (bits >>> (2 * i)) & 3;
    const dst = (py * width + px) * 4;
    out[dst] = palette[index * 4];
    out[dst + 1] = palette[index * 4 + 1];
    out[dst + 2] = palette[index * 4 + 2];
    out[dst + 3] = palette[index * 4 + 3];
  }
}

export function decodeBC1(data: Uint8Array, width: number, height: number, out = new Uint8Array(width * height * 4)): Uint8Array {
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  let offset = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      decodeColorBlock(data, offset, out, width, height, bx * 4, by * 4, true);
      offset += 8;
    }
  }
  return out;
}

export function decodeBC2(data: Uint8Array, width: number, height: number, out = new Uint8Array(width * height * 4)): Uint8Array {
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  let offset = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      // Explicit 4 bit alpha, stored as 16 little endian nibbles.
      for (let i = 0; i < 16; i++) {
        const px = bx * 4 + (i & 3);
        const py = by * 4 + (i >> 2);
        if (px >= width || py >= height) continue;
        const byte = data[offset + (i >> 1)];
        const nibble = (i & 1) === 0 ? byte & 0x0f : byte >> 4;
        out[(py * width + px) * 4 + 3] = nibble * 17;
      }
      decodeColorBlock(data, offset + 8, out, width, height, bx * 4, by * 4, false);
      offset += 16;
    }
  }
  return out;
}

export function decodeBC3(data: Uint8Array, width: number, height: number, out = new Uint8Array(width * height * 4)): Uint8Array {
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  let offset = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const a0 = data[offset];
      const a1 = data[offset + 1];
      const alpha = new Uint8Array(8);
      alpha[0] = a0;
      alpha[1] = a1;
      if (a0 > a1) {
        for (let i = 1; i <= 6; i++) alpha[i + 1] = ((7 - i) * a0 + i * a1) / 7;
      } else {
        for (let i = 1; i <= 4; i++) alpha[i + 1] = ((5 - i) * a0 + i * a1) / 5;
        alpha[6] = 0;
        alpha[7] = 255;
      }
      // 48 bits of 3 bit indices.
      let bits = 0n;
      for (let i = 5; i >= 0; i--) bits = (bits << 8n) | BigInt(data[offset + 2 + i]);
      for (let i = 0; i < 16; i++) {
        const px = bx * 4 + (i & 3);
        const py = by * 4 + (i >> 2);
        if (px >= width || py >= height) continue;
        const index = Number((bits >> BigInt(3 * i)) & 7n);
        out[(py * width + px) * 4 + 3] = alpha[index];
      }
      decodeColorBlock(data, offset + 8, out, width, height, bx * 4, by * 4, false);
      offset += 16;
    }
  }
  return out;
}

export type BlockFormat = "bc1" | "bc2" | "bc3";

export function decodeBlockCompressed(format: BlockFormat, data: Uint8Array, width: number, height: number): Uint8Array {
  switch (format) {
    case "bc1":
      return decodeBC1(data, width, height);
    case "bc2":
      return decodeBC2(data, width, height);
    case "bc3":
      return decodeBC3(data, width, height);
  }
}

/** Fully transparent pixel buffer, used when a texture cannot be decoded. */
export function emptyRGBA(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height * 4);
}
