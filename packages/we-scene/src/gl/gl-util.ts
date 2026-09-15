import type { BlendMode } from "../scene/types.js";

export interface GpuTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  /** Set when the texture still holds a placeholder while the real one loads. */
  pending?: boolean;
}

export interface Capabilities {
  /** `WEBGL_compressed_texture_s3tc`, needed to upload BC1/BC3 textures as-is. */
  s3tc: boolean;
  maxTextureSize: number;
  /** Renderer string, useful in diagnostics. */
  renderer: string;
}

export function createCapabilities(gl: WebGL2RenderingContext): Capabilities {
  const s3tc = Boolean(gl.getExtension("WEBGL_compressed_texture_s3tc"));
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    s3tc,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "unknown"
  };
}

export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  pixels: Uint8Array | null,
  options: { mipmaps?: boolean } = {}
): GpuTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate a WebGL texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (options.mipmaps !== false && isPowerOfTwo(width) && isPowerOfTwo(height)) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, width, height };
}

export function createCompressedTexture(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  width: number,
  height: number,
  data: Uint8Array
): GpuTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate a WebGL texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.compressedTexImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, width, height };
}

export function createImageTexture(gl: WebGL2RenderingContext, source: TexImageSource, width: number, height: number): GpuTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate a WebGL texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, width, height };
}

export function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** Applies a Wallpaper Engine blending mode to the GL blend state. */
export function applyBlendMode(gl: WebGL2RenderingContext, mode: BlendMode): void {
  gl.enable(gl.BLEND);
  switch (mode) {
    case "additive":
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.SRC_ALPHA, gl.ONE);
      break;
    case "multiplicative":
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.DST_ALPHA, gl.ZERO);
      break;
    case "translucent":
    case "normal":
    default:
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      break;
  }
}

export interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  attributes: Map<string, number>;
  error?: string;
}

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): { shader: WebGLShader | null; error?: string } {
  const shader = gl.createShader(type);
  if (!shader) return { shader: null, error: "createShader failed" };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader) ?? "unknown compile error";
    gl.deleteShader(shader);
    return { shader: null, error };
  }
  return { shader };
}

export function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): ProgramInfo {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  if (!vertex.shader) {
    return { program: null as unknown as WebGLProgram, uniforms: new Map(), attributes: new Map(), error: `vertex: ${vertex.error}` };
  }
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!fragment.shader) {
    gl.deleteShader(vertex.shader);
    return { program: null as unknown as WebGLProgram, uniforms: new Map(), attributes: new Map(), error: `fragment: ${fragment.error}` };
  }
  const program = gl.createProgram();
  if (!program) {
    return { program: null as unknown as WebGLProgram, uniforms: new Map(), attributes: new Map(), error: "createProgram failed" };
  }
  gl.attachShader(program, vertex.shader);
  gl.attachShader(program, fragment.shader);
  gl.linkProgram(program);
  gl.deleteShader(vertex.shader);
  gl.deleteShader(fragment.shader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const error = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    return { program: null as unknown as WebGLProgram, uniforms: new Map(), attributes: new Map(), error };
  }
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < uniformCount; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, "");
    uniforms.set(name, gl.getUniformLocation(program, info.name));
  }
  const attributes = new Map<string, number>();
  const attributeCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < attributeCount; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (!info) continue;
    attributes.set(info.name, gl.getAttribLocation(program, info.name));
  }
  return { program, uniforms, attributes };
}

/** An offscreen colour target used for layer composites and effect ping pong. */
export class RenderTarget {
  readonly framebuffer: WebGLFramebuffer;
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;

  constructor(private readonly gl: WebGL2RenderingContext, width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error("Unable to allocate a render target");
    this.texture = texture;
    this.framebuffer = framebuffer;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  bind(clear = true): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    if (clear) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.texture);
  }
}

/** Keeps a small pool of render targets alive between frames. */
export class RenderTargetPool {
  private readonly available: RenderTarget[] = [];
  private readonly inUse: RenderTarget[] = [];

  constructor(private readonly gl: WebGL2RenderingContext) {}

  acquire(width: number, height: number): RenderTarget {
    const index = this.available.findIndex((target) => target.width === width && target.height === height);
    if (index >= 0) {
      const [target] = this.available.splice(index, 1);
      this.inUse.push(target);
      return target;
    }
    const target = new RenderTarget(this.gl, width, height);
    this.inUse.push(target);
    return target;
  }

  /** Called once per frame: everything acquired last frame goes back to the pool. */
  releaseAll(): void {
    this.available.push(...this.inUse);
    this.inUse.length = 0;
    if (this.available.length > 12) {
      for (const target of this.available.splice(12)) target.dispose();
    }
  }

  dispose(): void {
    for (const target of [...this.available, ...this.inUse]) target.dispose();
    this.available.length = 0;
    this.inUse.length = 0;
  }
}
