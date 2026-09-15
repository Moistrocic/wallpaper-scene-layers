import { BinaryReader } from "../util/bytes.js";
import { decodeBlockCompressed, type BlockFormat } from "./bcn.js";
import { lz4DecompressBlock } from "./lz4.js";

/**
 * Wallpaper Engine `.tex` container.
 *
 * ```
 * "TEXV0005\0"
 * "TEXI0001\0"
 *   i32 format, i32 flags
 *   i32 textureWidth, i32 textureHeight
 *   i32 imageWidth,   i32 imageHeight
 *   u32 averageColour            // BGRA, used as the loading placeholder
 * "TEXB0003\0" | "TEXB0004\0"
 *   [v4] i32 unknown, i32 sourceFormat, i32 unknown
 *   i32 imageCount
 *   per image: i32 width, i32 height, i32 mode, i32 rawSize, i32 storedSize, u8 data[storedSize]
 * ```
 *
 * `mode === 1` means the payload is a raw LZ4 block that expands to `rawSize`
 * bytes; `mode === 0` means it is stored verbatim (either a PNG/JPEG file or
 * uncompressed pixel data, which is what the `rawSize` field distinguishes).
 */
export interface TexHeader {
  containerVersion: string;
  format: number;
  flags: number;
  textureWidth: number;
  textureHeight: number;
  imageWidth: number;
  imageHeight: number;
  /** BGRA placeholder colour stored in the header. */
  averageColour: { r: number; g: number; b: number; a: number };
}

export interface TexImage {
  width: number;
  height: number;
  /** 0 = stored verbatim, 1 = LZ4 compressed block. */
  mode: number;
  /** Size of the payload after decompression (0 for stored image files). */
  rawSize: number;
  /** Size of the payload as stored in the file. */
  storedSize: number;
  data: Uint8Array;
}

export interface TexContainer {
  header: TexHeader;
  /** `TEXB0003` / `TEXB0004` */
  blockVersion: number;
  /** Container level source format hint (13 = PNG). */
  sourceFormat: number;
  /** Mip levels, largest first. */
  images: TexImage[];
}

export type TexPixelFormat = "file" | "rgba8" | "rgb8" | "bc1" | "bc2" | "bc3" | "r8";

export interface DecodedTexImage {
  width: number;
  height: number;
  /** RGBA8888 pixels; only present for the raw / block compressed formats. */
  pixels?: Uint8Array;
  /** Encoded file bytes (PNG / JPEG / DDS); only present when `format === "file"`. */
  file?: Uint8Array;
  format: TexPixelFormat;
  mimeType?: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(data: Uint8Array, signature: number[]): boolean {
  if (data.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (data[i] !== signature[i]) return false;
  return true;
}

export function isTexContainer(input: ArrayBuffer | ArrayBufferView): boolean {
  const reader = new BinaryReader(input);
  return reader.string(8) === "TEXV0005";
}

export function parseTex(input: ArrayBuffer | ArrayBufferView): TexContainer {
  const reader = new BinaryReader(input);
  const containerVersion = reader.cstring();
  if (containerVersion !== "TEXV0005") {
    throw new Error(`Unsupported texture container: "${containerVersion}"`);
  }
  const imageHeaderMagic = reader.cstring();
  if (!imageHeaderMagic.startsWith("TEXI")) {
    throw new Error(`Unsupported texture header: "${imageHeaderMagic}"`);
  }
  const format = reader.i32();
  const flags = reader.i32();
  const textureWidth = reader.i32();
  const textureHeight = reader.i32();
  const imageWidth = reader.i32();
  const imageHeight = reader.i32();
  const colour = reader.u32();
  const header: TexHeader = {
    containerVersion,
    format,
    flags,
    textureWidth,
    textureHeight,
    imageWidth,
    imageHeight,
    averageColour: {
      r: colour & 0xff,
      g: (colour >> 8) & 0xff,
      b: (colour >> 16) & 0xff,
      a: (colour >>> 24) & 0xff
    }
  };

  const blockMagic = reader.cstring();
  const blockVersion = Number.parseInt(blockMagic.replace(/[^0-9]/g, ""), 10) || 0;
  const images: TexImage[] = [];
  let sourceFormat = -1;

  if (blockVersion <= 2) {
    // TEXB0001 / TEXB0002 store the mip chain of a single image as
    // (width, height, format, decompressedSize, compressedSize) records.
    reader.i32(); // unknown, always 1
    const mipmapCount = reader.u32();
    for (let i = 0; i < mipmapCount; i++) {
      const width = reader.i32();
      const height = reader.i32();
      reader.i32(); // format of the mip, the container header already told us
      const rawSize = reader.i32();
      const storedSize = reader.i32();
      const data = reader.slice(storedSize);
      images.push({ width, height, mode: 1, rawSize, storedSize, data });
    }
    return { header, blockVersion, sourceFormat, images };
  }

  if (blockVersion >= 4) {
    reader.i32(); // unknown, always 1
    sourceFormat = reader.i32();
    reader.i32(); // unknown, always 0
  } else {
    reader.i32(); // unknown, always 1
    sourceFormat = reader.i32();
  }

  const imageCount = reader.i32();
  for (let i = 0; i < imageCount; i++) {
    const width = reader.i32();
    const height = reader.i32();
    const mode = reader.i32();
    const rawSize = reader.i32();
    const storedSize = reader.i32();
    const data = reader.slice(storedSize);
    images.push({ width, height, mode, rawSize, storedSize, data });
  }

  return { header, blockVersion, sourceFormat, images };
}

export interface ExpandedTexImage {
  /** LZ4 expanded payload. */
  data: Uint8Array;
  format: TexPixelFormat;
  /** MIME type when `format === "file"`. */
  mimeType?: string;
}

/**
 * Expands the LZ4 payload of a mip level and works out how the pixels are
 * stored, without decoding anything: block compressed data can then be handed
 * to the GPU untouched when the driver supports it.
 *
 * `imageFormat` lets callers override the heuristic for ambiguous cases
 * (a texture with 1 byte per pixel may be BC3, BC2 or a single channel mask).
 */
export function expandTexImageData(image: TexImage, imageFormat?: TexPixelFormat): ExpandedTexImage {
  let data = image.data;
  if (image.mode === 1 && image.rawSize > 0) {
    data = lz4DecompressBlock(data, image.rawSize);
  }
  if (startsWith(data, PNG_SIGNATURE)) return { data, format: "file", mimeType: "image/png" };
  if (startsWith(data, JPEG_SIGNATURE)) return { data, format: "file", mimeType: "image/jpeg" };

  const pixels = image.width * image.height;
  const bytesPerPixel = data.length / pixels;
  if (imageFormat) return { data, format: imageFormat };
  if (bytesPerPixel >= 3.9) return { data, format: "rgba8" };
  if (bytesPerPixel >= 2.9) return { data, format: "rgb8" };
  if (bytesPerPixel >= 1.99) return { data, format: "bc2" };
  if (bytesPerPixel >= 0.99) return { data, format: "bc3" };
  return { data, format: "bc1" };
}

/**
 * Expands one stored mip level into either encoded file bytes or raw pixels.
 * `imageFormat` lets callers override the heuristic for ambiguous cases
 * (a texture with 1 byte per pixel may be BC3, BC2 or a single channel mask).
 */
export function decodeTexImage(image: TexImage, imageFormat?: TexPixelFormat): DecodedTexImage {
  const expanded = expandTexImageData(image, imageFormat);
  const data = expanded.data;
  const resolved = expanded.format;
  const pixels = image.width * image.height;

  if (resolved === "file") {
    return { width: image.width, height: image.height, format: "file", file: data, mimeType: expanded.mimeType };
  }
  if (resolved === "rgba8") {
    return { width: image.width, height: image.height, format: "rgba8", pixels: data };
  }
  if (resolved === "rgb8") {
    const rgba = new Uint8Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
      rgba[i * 4] = data[i * 3];
      rgba[i * 4 + 1] = data[i * 3 + 1];
      rgba[i * 4 + 2] = data[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    return { width: image.width, height: image.height, format: "rgba8", pixels: rgba };
  }
  if (resolved === "bc1" || resolved === "bc2" || resolved === "bc3") {
    const pixelsRGBA = decodeBlockCompressed(resolved, data, image.width, image.height);
    return { width: image.width, height: image.height, format: resolved, pixels: pixelsRGBA };
  }
  // Single channel masks are expanded to RGBA so the shader path stays uniform.
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    rgba[i * 4] = data[i];
    rgba[i * 4 + 1] = data[i];
    rgba[i * 4 + 2] = data[i];
    rgba[i * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, format: "rgba8", pixels: rgba };
}

/**
 * 把补齐到 2 次幂的 RGBA 图裁回真实尺寸。
 *
 * Wallpaper Engine 会把非 2 次幂的贴图补齐到 2 次幂存储（`.tex-json` 里的
 * `nonpoweroftwo`），真实尺寸记在 TEXI 头的 `imageWidth/imageHeight`，
 * 补齐后的尺寸则记在 `textureWidth/textureHeight`（也是每个 mip 的尺寸）。
 * 不裁剪就会像工程贴图那样"只有左上角一块有内容"。
 */
export function cropImageRGBA(pixels: Uint8Array, sourceWidth: number, width: number, height: number): Uint8Array {
  const cropped = new Uint8Array(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const sourceStart = y * sourceWidth * 4;
    cropped.set(pixels.subarray(sourceStart, sourceStart + rowBytes), y * rowBytes);
  }
  return cropped;
}

/** Decodes the largest mip level of a texture straight to RGBA8888. */
export function decodeTexToRGBA(input: ArrayBuffer | ArrayBufferView, imageFormat?: TexPixelFormat): DecodedTexImage {
  const container = parseTex(input);
  const first = container.images[0];
  if (!first) throw new Error("Texture contains no images");
  return decodeTexImage(first, imageFormat);
}

export { lz4DecompressBlock, decodeBlockCompressed };
export type { BlockFormat };
