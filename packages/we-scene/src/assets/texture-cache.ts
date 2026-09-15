import { createBuiltinImage, createSolid } from "./builtin.js";
import { cropImageRGBA, expandTexImageData, parseTex, decodeTexImage } from "../tex/tex.js";
import { createCompressedTexture, createImageTexture, createTexture, type Capabilities, type GpuTexture } from "../gl/gl-util.js";

export interface TextureSource {
  get(path: string): Uint8Array | undefined;
  has(path: string): boolean;
  list(): string[];
  /** 可选的异步读取（工程目录 / 引擎资源），`get()` 未命中时用它补齐。 */
  load?(path: string): Promise<Uint8Array | undefined>;
}

export interface TextureCacheOptions {
  capabilities: Capabilities;
  /** Called when a texture cannot be decoded, for diagnostics. */
  onError?: (message: string) => void;
  /** Force a pixel format for a path, e.g. `{"workshop/x/mask": "r8"}`. */
  formatOverrides?: Record<string, "bc1" | "bc2" | "bc3" | "rgba8" | "file">;
  /**
   * Optional local Wallpaper Engine assets. Textures the package does not carry
   * (`particle/halo`, `util/white`, ...) are then read from the engine
   * installation instead of being generated procedurally.
   */
  engine?: { load(path: string): Promise<Uint8Array | undefined> };
}

/**
 * Resolves material texture names (`142584003_p0`, `particle/halo_4`) into GL
 * textures. Packages only contain the textures a scene actually authors, so
 * anything missing falls back to a procedurally generated engine texture.
 *
 * Loading is asynchronous but `get()` never blocks: a white placeholder is
 * returned until the real texture is uploaded, which keeps `render()` a plain
 * synchronous call.
 */
export class TextureCache {
  private readonly cache = new Map<string, GpuTexture>();
  private readonly pending = new Map<string, Promise<GpuTexture>>();
  private readonly placeholder: GpuTexture;

  constructor(private readonly gl: WebGL2RenderingContext, private readonly source: TextureSource, private readonly options: TextureCacheOptions) {
    const white = createSolid(1, 1, [255, 255, 255, 255]);
    this.placeholder = createTexture(gl, 1, 1, white.pixels, { mipmaps: false });
    this.cache.set("__placeholder", this.placeholder);
  }

  /** Synchronous lookup; kicks off the asynchronous load on first use. */
  get(name: string): GpuTexture {
    const key = normalise(name);
    const cached = this.cache.get(key);
    if (cached) return cached;
    void this.load(key);
    this.cache.set(key, { ...this.placeholder, pending: true });
    return this.cache.get(key)!;
  }

  /** Resolves when every texture requested so far has been uploaded. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending.values()]);
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async load(name: string): Promise<GpuTexture> {
    const key = normalise(name);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.create(key).then((texture) => {
      this.cache.set(key, texture);
      this.pending.delete(key);
      return texture;
    });
    this.pending.set(key, task);
    return task;
  }

  private async create(key: string): Promise<GpuTexture> {
    // 1) the scene package, 2) the local engine install, 3) procedural fallback.
    const path = this.resolvePath(key);
    let bytes = path ? this.source.get(path) : undefined;
    if (!bytes && this.source.load) {
      for (const candidate of [`materials/${key}.tex`, `${key}.tex`, key]) {
        bytes = await this.source.load(candidate);
        if (bytes) break;
      }
    }
    if (!bytes && this.options.engine) {
      for (const candidate of [`materials/${key}.tex`, `${key}.tex`, key]) {
        bytes = await this.options.engine.load(candidate);
        if (bytes) break;
      }
    }
    if (bytes) {
      try {
        return await this.uploadTex(bytes, path ?? `${key}.tex`);
      } catch (error) {
        this.options.onError?.(`texture "${key}" failed to decode: ${(error as Error).message}`);
      }
    }
    const builtin = createBuiltinImage(key);
    return createTexture(this.gl, builtin.width, builtin.height, builtin.pixels, { mipmaps: true });
  }

  private resolvePath(key: string): string | undefined {
    const candidates = [`materials/${key}.tex`, `${key}.tex`, key];
    for (const candidate of candidates) {
      if (this.source.has(candidate)) return candidate;
    }
    return undefined;
  }

  private async uploadTex(bytes: Uint8Array, path: string): Promise<GpuTexture> {
    const container = parseTex(bytes);
    const first = container.images[0];
    if (!first) throw new Error("texture has no images");
    const override = this.options.formatOverrides?.[normalise(path)];
    const expanded = expandTexImageData(first, override as never);
    const gl = this.gl;
    // 补齐到 2 次幂的贴图要裁回真实尺寸，否则只有左上角一块有内容。
    const imageWidth = container.header.imageWidth || first.width;
    const imageHeight = container.header.imageHeight || first.height;
    const needsCrop = imageWidth < first.width || imageHeight < first.height;

    if (expanded.format === "file") {
      const blob = new Blob([expanded.data.slice().buffer as ArrayBuffer], { type: expanded.mimeType ?? "image/png" });
      const bitmap = await createImageBitmap(blob);
      const texture = createImageTexture(gl, bitmap, bitmap.width, bitmap.height);
      bitmap.close?.();
      return texture;
    }

    if (!needsCrop && (expanded.format === "bc1" || expanded.format === "bc2" || expanded.format === "bc3") && this.options.capabilities.s3tc) {
      const extension = gl.getExtension("WEBGL_compressed_texture_s3tc");
      const format =
        expanded.format === "bc1"
          ? extension?.COMPRESSED_RGB_S3TC_DXT1_EXT
          : expanded.format === "bc2"
            ? extension?.COMPRESSED_RGBA_S3TC_DXT3_EXT
            : extension?.COMPRESSED_RGBA_S3TC_DXT5_EXT;
      if (format) {
        return createCompressedTexture(gl, format, first.width, first.height, expanded.data);
      }
    }

    const decoded = decodeTexImage(first, override as never);
    if (decoded.pixels) {
      if (needsCrop) {
        const cropped = cropImageRGBA(decoded.pixels, decoded.width, Math.min(imageWidth, decoded.width), Math.min(imageHeight, decoded.height));
        return createTexture(gl, Math.min(imageWidth, decoded.width), Math.min(imageHeight, decoded.height), cropped, { mipmaps: true });
      }
      return createTexture(gl, decoded.width, decoded.height, decoded.pixels, { mipmaps: true });
    }
    const builtin = createBuiltinImage(path);
    return createTexture(gl, builtin.width, builtin.height, builtin.pixels, { mipmaps: true });
  }

  dispose(): void {
    for (const texture of this.cache.values()) this.gl.deleteTexture(texture.texture);
    this.cache.clear();
    this.pending.clear();
  }
}

function normalise(name: string): string {
  return name.replace(/\\/g, "/").replace(/^materials\//i, "").replace(/\.tex$/i, "").toLowerCase();
}
