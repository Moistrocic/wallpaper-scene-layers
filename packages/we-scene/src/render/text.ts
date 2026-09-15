import type { TextLayerConfig } from "../scene/types.js";
import { createImageTexture, type GpuTexture } from "../gl/gl-util.js";

/**
 * Rasterises a scene text layer with the Canvas2D API.
 *
 * Wallpaper Engine renders text with the font that ships inside the package,
 * which the browser can use directly through the FontFace API.
 */
export class TextRasterizer {
  private readonly fonts = new Map<string, string>();
  private readonly textures = new Map<string, GpuTexture>();

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** Registers a TTF/OTF from the package, returning the CSS family name. */
  async registerFont(path: string, data: Uint8Array): Promise<string> {
    const existing = this.fonts.get(path);
    if (existing) return existing;
    const family = `we-${hashString(path)}`;
    this.fonts.set(path, family);
    try {
      const font = new FontFace(family, data.slice().buffer as ArrayBuffer);
      await font.load();
      (document.fonts as FontFaceSet).add(font);
    } catch {
      // A missing font simply falls back to the generic family below.
    }
    return family;
  }

  hasFont(path: string): boolean {
    return this.fonts.has(path);
  }

  /** Returns (and caches) the texture for a text layer. */
  getTexture(layerId: number, text: TextLayerConfig, boxWidth: number, boxHeight: number, scale = 2): GpuTexture | null {
    const key = `${layerId}:${text.value}:${text.pointSize}:${boxWidth}x${boxHeight}:${text.color.join(",")}:${scale}`;
    const cached = this.textures.get(key);
    if (cached) return cached;
    const texture = this.rasterize(text, boxWidth, boxHeight, scale);
    if (!texture) return null;
    this.textures.set(key, texture);
    return texture;
  }

  invalidate(layerId?: number): void {
    if (layerId === undefined) {
      for (const texture of this.textures.values()) this.gl.deleteTexture(texture.texture);
      this.textures.clear();
      return;
    }
    for (const [key, texture] of [...this.textures]) {
      if (key.startsWith(`${layerId}:`)) {
        this.gl.deleteTexture(texture.texture);
        this.textures.delete(key);
      }
    }
  }

  private rasterize(text: TextLayerConfig, boxWidth: number, boxHeight: number, scale: number): GpuTexture | null {
    if (typeof document === "undefined") return null;
    const width = Math.max(1, Math.round(boxWidth * scale));
    const height = Math.max(1, Math.round(boxHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const family = this.fonts.get(text.font) ?? this.fonts.get(text.font.toLowerCase()) ?? "sans-serif";
    const fontSize = Math.max(1, text.pointSize * scale);
    context.font = `${fontSize}px "${family}", sans-serif`;
    context.textBaseline = "middle";
    context.fillStyle = "rgba(255,255,255,1)";

    const paddingX = text.padding[0] * scale;
    const paddingY = text.padding[1] * scale;
    const maxWidth = text.limitWidth && text.maxWidth > 0 ? text.maxWidth * scale : Math.max(1, width - paddingX * 2);
    const lineHeight = fontSize * 1.16;
    const lines = wrapText(context, text.value, maxWidth, text.limitRows ? text.maxRows : Number.POSITIVE_INFINITY);
    const totalHeight = lines.length * lineHeight;

    let originY: number;
    switch (text.verticalAlign) {
      case "bottom":
        originY = height - paddingY - totalHeight + lineHeight / 2;
        break;
      case "center":
        originY = (height - totalHeight) / 2 + lineHeight / 2;
        break;
      default:
        originY = paddingY + lineHeight / 2;
        break;
    }

    let originX: number;
    switch (text.horizontalAlign) {
      case "center":
        context.textAlign = "center";
        originX = width / 2;
        break;
      case "right":
        context.textAlign = "right";
        originX = width - paddingX;
        break;
      default:
        context.textAlign = "left";
        originX = paddingX;
        break;
    }

    for (const [index, line] of lines.entries()) {
      context.fillText(line, originX, originY + index * lineHeight);
    }

    return createImageTexture(this.gl, canvas, width, height);
  }

  dispose(): void {
    for (const texture of this.textures.values()) this.gl.deleteTexture(texture.texture);
    this.textures.clear();
  }
}

function wrapText(context: CanvasRenderingContext2D, value: string, maxWidth: number, maxRows: number): string[] {
  const paragraphs = value.split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (lines.length >= maxRows) break;
    if (context.measureText(paragraph).width <= maxWidth || paragraph.length === 0) {
      lines.push(paragraph);
      continue;
    }
    let current = "";
    for (const character of paragraph) {
      const candidate = current + character;
      if (context.measureText(candidate).width > maxWidth && current.length > 0) {
        lines.push(current);
        current = character;
        if (lines.length >= maxRows) break;
      } else {
        current = candidate;
      }
    }
    if (lines.length < maxRows && current.length > 0) lines.push(current);
  }
  return lines.slice(0, Math.max(1, maxRows));
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}
