import { PackageArchive } from "../pkg/archive.js";
import { SceneDocument, createSceneFromBundle } from "../scene/document.js";
import { engineAssetDependencies } from "../scene/inspect.js";
import type { EffectDefinition, MaterialDefinition, MaterialPass, SceneLayer } from "../scene/types.js";
import type { ComposedShader } from "../shader/compose.js";
import { TextureCache } from "../assets/texture-cache.js";
import { EngineAssets, resolveEngineAssets, type EngineAssetsOptions } from "../assets/engine-assets.js";
import type { AssetBundle } from "../assets/bundle.js";
import { getBuiltinMaterial, getBuiltinModel } from "../assets/builtin.js";
import { ShaderPipeline } from "./shader-pipeline.js";
import { ParticleSystem, parseParticleDefinition, type ParticleOptions } from "./particles.js";
import { TextRasterizer } from "./text.js";
import {
  RenderTargetPool,
  applyBlendMode,
  createCapabilities,
  type Capabilities,
  type GpuTexture,
  type ProgramInfo,
  type RenderTarget
} from "../gl/gl-util.js";
import {
  alignmentOffset,
  clamp,
  fromRotationX,
  fromRotationY,
  fromRotationZ,
  fromScale,
  fromTranslation,
  mat4,
  multiply,
  orthographic,
  transformPoint,
  type Mat4
} from "../util/math.js";
import { readNumber, readVec } from "../util/bytes.js";

export type FitMode = "cover" | "contain" | "stretch";

export interface SceneRendererOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Parsed `scene.pkg`. */
  archive?: PackageArchive;
  /** 任意资源包（`scene.pkg` 或工程目录）；给了它就可以不用 `archive`。 */
  bundle?: AssetBundle;
  /** Pre-built scene document; parsed from the archive when omitted. */
  scene?: SceneDocument;
  /** How the scene's orthographic volume maps onto the canvas. */
  fit?: FitMode;
  /** Device pixel ratio override, defaults to `window.devicePixelRatio`. */
  pixelRatio?: number;
  clearColor?: [number, number, number];
  /** Upper bound for per layer render targets, defaults to the canvas size. */
  maxLayerResolution?: number;
  /** Rasterisation scale for text layers (2 = two texels per scene unit). */
  textScale?: number;
  textureFormatOverrides?: Record<string, "bc1" | "bc2" | "bc3" | "rgba8" | "file">;
  /** Receives non fatal problems (unsupported shaders, missing assets, ...). */
  onDiagnostic?: (message: string) => void;
  /** Freeze the animation clock (tests, thumbnails). */
  fixedTime?: number;
  /** Render layers without their effect chains (debugging / cheap previews). */
  disableEffects?: boolean;
  /** Restrict rendering to these layer ids (debugging). */
  onlyLayers?: number[] | null;
  /**
   * Overrides for the particle defaults this runtime has to infer
   * (turbulence spatial scale and noise clock, see `ParticleOptions`).
   */
  particles?: ParticleOptions;
  /**
   * Optional access to a local Wallpaper Engine installation.
   *
   * Assets the scene package does not carry (engine materials, models, particle
   * presets, `particle/halo` style textures and the real `common*.h` shader
   * headers) are then read from the engine instead of being approximated. Accepts
   * an `EngineAssets` instance, an HTTP base URL, a directory path (Node) or the
   * options object; nothing is bundled or redistributed by this library.
   */
  engineAssets?: EngineAssets | string | EngineAssetsOptions;
}

export interface RenderInput {
  /** Pointer position in the range [-1, 1], drives the camera parallax. */
  mouse?: [number, number];
}

export interface LayerDrawStats {
  layerId: number;
  name: string;
  type: string;
  drawn: boolean;
  reason?: string;
  effects: number;
  particles?: number;
  /** 场景单位下的四边形尺寸与屏幕包围盒（像素），便于排查尺寸/摆放问题。 */
  quad?: { width: number; height: number; offsetX: number; offsetY: number };
  bounds?: { left: number; right: number; bottom: number; top: number };
  /** 四边形四角的裁剪空间坐标（左下、右下、右上、左上）。 */
  clip?: Array<[number, number]>;
}

interface Quad {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

interface Rect {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

interface Bounds {
  /** Axis aligned bounds in scene units, used for the render target projection. */
  world: Rect;
  /** Bounds in device pixels, used to size and place the render target. */
  pixel: Rect & { width: number; height: number };
}

interface PassDraw {
  pass: MaterialPass;
  layer: SceneLayer;
  /** Pre-resolved program; resolved from the material when omitted. */
  resolved?: { program: ProgramInfo; layout: ComposedShader | null } | null;
  /** World space model matrix, ignored when `clipSpace` is set. */
  model: Mat4;
  projection: Mat4;
  textures: Array<GpuTexture | null>;
  constants?: Record<string, unknown>;
  clipSpace?: boolean;
  time: number;
  stats: LayerDrawStats;
}

/** Vertices are `x, y, z, u, v` (20 bytes), matching the attribute setup below. */
const FULLSCREEN_QUAD = new Float32Array([
  -1, -1, 0, 0, 0,
  1, -1, 0, 1, 0,
  1, 1, 0, 1, 1,
  -1, -1, 0, 0, 0,
  1, 1, 0, 1, 1,
  -1, 1, 0, 0, 1
]);

/** Unit quad in the image convention: v = 0 is the top of the texture. */
const IMAGE_QUAD = new Float32Array([
  -0.5, -0.5, 0, 0, 1,
  0.5, -0.5, 0, 1, 1,
  0.5, 0.5, 0, 1, 0,
  -0.5, -0.5, 0, 0, 1,
  0.5, 0.5, 0, 1, 0,
  -0.5, 0.5, 0, 0, 0
]);

const BUILTIN_NAMES = new Set([
  "genericimage",
  "genericimage3",
  "genericimage4",
  "generictext",
  "genericparticle",
  "solid",
  "composite"
]);

const SOLID_MATERIAL: MaterialDefinition = {
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

const TEXT_MATERIAL: MaterialDefinition = {
  passes: [{ ...SOLID_MATERIAL.passes[0], shader: "genericimage4" }]
};

/**
 * Renders a Wallpaper Engine scene as independent layers on a WebGL2 canvas.
 *
 * Every entry of `scene.json` becomes a layer that can be inspected, hidden or
 * re-ordered through the public API. Materials, effect passes and particle
 * systems are evaluated in the order the engine uses, and the GLSL that ships
 * inside the package is compiled as-is (only the engine headers are inlined).
 */
export class SceneRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly scene: SceneDocument;
  readonly capabilities: Capabilities;
  readonly diagnostics: string[] = [];

  private readonly bundle?: AssetBundle;
  private readonly options: SceneRendererOptions;
  private readonly pipeline: ShaderPipeline;
  private readonly textures: TextureCache;
  private readonly targets: RenderTargetPool;
  private readonly text: TextRasterizer;
  private readonly imageQuad: WebGLBuffer;
  private readonly fullQuad: WebGLBuffer;
  private readonly particleBuffer: WebGLBuffer;
  private particleVertices = new Float32Array(6 * 9 * 256);
  private readonly particleSystems = new Map<number, ParticleSystem[]>();
  private readonly worldMatrices = new Map<number, Mat4>();
  private readonly hidden = new Set<number>();
  private engine?: EngineAssets;
  private hydrationPromise?: Promise<void>;
  private stats: LayerDrawStats[] = [];
  private lastTime = -1;
  private width = 1;
  private height = 1;
  private disposed = false;
  /**
   * 每个渲染器一个 VAO（WebGL2）。顶点属性状态是**全局**的：如果两个渲染器
   * （例如切换壁纸时）共用同一个 GL context，前一个 dispose 删掉顶点缓冲后，
   * 它遗留的 enabled 属性会让后续所有 drawArrays 报 INVALID_OPERATION。
   * 用 VAO 把各自的属性状态隔离开。
   */
  private readonly vertexArray?: WebGLVertexArrayObject | null;

  constructor(options: SceneRendererOptions) {
    this.options = options;
    const gl = (options.canvas as HTMLCanvasElement).getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      depth: false,
      stencil: false,
      powerPreference: "high-performance"
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.vertexArray = typeof gl.createVertexArray === "function" ? gl.createVertexArray() : null;
    this.capabilities = createCapabilities(gl);
    this.bundle = options.bundle ?? options.archive;
    this.scene = options.scene ?? createSceneFromBundle(requireBundle(this.bundle));

    this.pipeline = new ShaderPipeline(gl, this.scene, this.capabilities, () => this.engineShaderHeaders());
    this.textures = new TextureCache(
      gl,
      {
        has: (path) => this.scene.has(path),
        get: (path) => this.scene.getBytes(path),
        load: (path) => this.bundle?.load?.(path) ?? Promise.resolve(undefined),
        list: () => this.bundle?.list() ?? []
      },
      {
        capabilities: this.capabilities,
        onError: (message) => this.report(message),
        formatOverrides: options.textureFormatOverrides,
        engine: { load: (path) => this.engineLoad(path) }
      }
    );
    this.targets = new RenderTargetPool(gl);
    this.text = new TextRasterizer(gl);
    this.imageQuad = createBuffer(gl, IMAGE_QUAD);
    this.fullQuad = createBuffer(gl, FULLSCREEN_QUAD);
    const particleBuffer = gl.createBuffer();
    if (!particleBuffer) throw new Error("Unable to allocate the particle vertex buffer");
    this.particleBuffer = particleBuffer;
  }

  get layers(): SceneLayer[] {
    return this.scene.layers;
  }

  get layerCount(): number {
    return this.scene.layers.length;
  }

  /** Per layer statistics of the last frame. */
  get layerStats(): LayerDrawStats[] {
    return this.stats;
  }

  get shaderErrors(): string[] {
    return this.pipeline.errors;
  }

  /** Stats of the local engine installation, when the switch is enabled. */
  get engineAssetStats(): { cached: number; missing: number; bytes: number } | undefined {
    return this.engine?.stats;
  }

  /** Paths the runtime has read from the local engine installation. */
  get loadedEngineAssets(): string[] {
    return this.engine?.list() ?? [];
  }

  /** Paths the runtime looked for but the engine installation does not have. */
  get missingEngineAssets(): string[] {
    return this.engine?.missingAssets ?? [];
  }

  setLayerVisible(layer: number | string, visible: boolean): void {
    const target = this.findLayer(layer);
    if (!target) return;
    if (visible) this.hidden.delete(target.id);
    else this.hidden.add(target.id);
  }

  isLayerVisible(layer: number | string): boolean {
    const target = this.findLayer(layer);
    if (!target) return false;
    return target.visible && !this.hidden.has(target.id);
  }

  /** Resolves once every texture requested so far has been uploaded. */
  async ready(): Promise<void> {
    await this.hydrateEngineAssets();
    await this.textures.settle();
  }

  /**
   * Pulls the assets this scene needs but the package does not contain from a
   * local Wallpaper Engine installation (when one was configured).
   *
   * JSON and shader sources have to be in memory before rendering, because
   * layers resolve their materials synchronously while drawing; textures are
   * fetched lazily by the texture cache.
   */
  async hydrateEngineAssets(): Promise<void> {
    if (this.hydration) return this.hydration;
    this.hydration = (async () => {
      const engine = await resolveEngineAssets(this.options.engineAssets);
      if (!engine) return;
      this.engine = engine;
      const wanted = this.engineAssetPaths();
      const result = await engine.preload(wanted);
      for (const path of wanted) {
        const bytes = engine.get(path);
        if (bytes) this.scene.useOverlay(path, bytes);
      }
      this.report(
        `engine assets: ${result.loaded} 个文件来自本机 Wallpaper Engine` +
          (result.missing ? `, ${result.missing} 个在引擎里不存在` : "")
      );
    })();
    return this.hydration;
  }

  private get hydration(): Promise<void> | undefined {
    return this.hydrationPromise;
  }

  private set hydration(value: Promise<void> | undefined) {
    this.hydrationPromise = value;
  }

  /** Engine files the scene references but the package does not carry. */
  private engineAssetPaths(): string[] {
    return engineAssetDependencies(this.scene);
  }

  /** Real engine shader headers, when the caller enabled engine assets. */
  private engineShaderHeaders(): Record<string, string> | undefined {
    if (!this.engine) return undefined;
    const headers: Record<string, string> = {};
    for (const name of ["common.h", "common_vertex.h", "common_fragment.h", "common_perspective.h", "common_blending.h", "common_blur.h", "common_particles.h"]) {
      const text = this.engine.getText(`shaders/${name}`);
      if (text) headers[name] = text;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private async engineLoad(path: string): Promise<Uint8Array | undefined> {
    // Textures can be requested before (or while) the engine assets are being
    // resolved; waiting here keeps the first lookup from falling back to a
    // procedural texture that would then be cached for the rest of the session.
    await this.hydrateEngineAssets();
    return this.engine?.load(path);
  }

  /** Uploads every texture and font the scene references (used before snapshots). */
  async preload(): Promise<void> {
    const names = new Set<string>();
    for (const layer of this.scene.layers) {
      for (const name of this.materialTextureNames(layer)) names.add(name);
      if (layer.text?.font) {
        const data = this.bundle?.get(layer.text.font) ?? (await this.bundle?.load?.(layer.text.font));
        if (data) await this.text.registerFont(layer.text.font, data);
      }
    }
    await Promise.all([...names].map((name) => this.textures.load(name)));
  }

  render(timeSeconds: number, input: RenderInput = {}): void {
    if (this.disposed) return;
    if (!this.hydrationPromise && this.options.engineAssets) void this.hydrateEngineAssets();
    const gl = this.gl;
    this.resizeToDisplaySize();
    const time = this.options.fixedTime ?? timeSeconds;
    const delta = this.lastTime < 0 ? 1 / 60 : clamp(time - this.lastTime, 0, 0.1);
    this.lastTime = time;

    this.updateParticles(delta);
    this.worldMatrices.clear();

    const projection = this.computeProjection(input);
    const clear = this.options.clearColor ?? this.scene.general.clearColor;
    if (this.vertexArray) gl.bindVertexArray(this.vertexArray);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const stats: LayerDrawStats[] = [];
    for (const layer of this.scene.layers) {
      const entry: LayerDrawStats = { layerId: layer.id, name: layer.name, type: layer.type, drawn: false, effects: layer.effects.length };
      stats.push(entry);
      if (!layer.visible) {
        entry.reason = "hidden in scene";
        continue;
      }
      if (this.hidden.has(layer.id)) {
        entry.reason = "hidden by host";
        continue;
      }
      if (this.options.onlyLayers && !this.options.onlyLayers.includes(layer.id)) {
        entry.reason = "filtered";
        continue;
      }
      try {
        this.renderLayer(layer, projection, time, entry, projection);
      } catch (error) {
        entry.reason = `error: ${(error as Error).message}`;
        this.report(`layer "${layer.name}" failed: ${(error as Error).message}`);
      }
    }
    this.stats = stats;
    this.targets.releaseAll();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.targets.dispose();
    this.textures.dispose();
    this.text.dispose();
    gl.deleteBuffer(this.imageQuad);
    gl.deleteBuffer(this.fullQuad);
    gl.deleteBuffer(this.particleBuffer);
    if (this.vertexArray) {
      gl.bindVertexArray(null);
      gl.deleteVertexArray(this.vertexArray);
    }
  }

  // ---------------------------------------------------------------- internals

  private findLayer(layer: number | string): SceneLayer | undefined {
    return typeof layer === "number" ? this.scene.getLayer(layer) : this.scene.layers.find((candidate) => candidate.name === layer);
  }

  private report(message: string): void {
    if (this.diagnostics.length < 500) this.diagnostics.push(message);
    this.options.onDiagnostic?.(message);
  }

  private resizeToDisplaySize(): void {
    const canvas = this.options.canvas as HTMLCanvasElement;
    const ratio = this.options.pixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const clientWidth = canvas.clientWidth || canvas.width || 1920;
    const clientHeight = canvas.clientHeight || canvas.height || 1080;
    const width = Math.max(1, Math.floor(clientWidth * ratio));
    const height = Math.max(1, Math.floor(clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.width = width;
    this.height = height;
  }

  private computeProjection(input: RenderInput): Mat4 {
    const ortho = this.scene.general.orthographicProjection;
    const base = orthographic(0, ortho.width, 0, ortho.height, -this.scene.general.farZ, this.scene.general.farZ);
    const fit = this.options.fit ?? "cover";
    let scaleX = 1;
    let scaleY = 1;
    if (fit !== "stretch") {
      const canvasAspect = this.width / this.height;
      const sceneAspect = ortho.width / ortho.height;
      const cropWidth = fit === "cover" ? canvasAspect < sceneAspect : canvasAspect > sceneAspect;
      if (cropWidth) scaleY = sceneAspect / canvasAspect;
      else scaleX = canvasAspect / sceneAspect;
    }
    let projection = multiply(fromScale(scaleX, scaleY, 1), base);
    const parallax = this.scene.general.cameraParallax ? this.parallaxOffset(input) : ([0, 0] as [number, number]);
    if (parallax[0] !== 0 || parallax[1] !== 0) projection = multiply(fromTranslation(parallax[0], parallax[1], 0), projection);
    return projection;
  }

  private parallaxOffset(input: RenderInput): [number, number] {
    if (!input.mouse) return [0, 0];
    const amount = this.scene.general.cameraParallaxAmount * this.scene.general.cameraParallaxMouseInfluence;
    const ortho = this.scene.general.orthographicProjection;
    return [-input.mouse[0] * amount * ortho.width * 0.05, -input.mouse[1] * amount * ortho.height * 0.05];
  }

  private worldMatrix(layer: SceneLayer): Mat4 {
    const cached = this.worldMatrices.get(layer.id);
    if (cached) return cached;
    const { origin, angles, scale } = layer.transform;
    const rotation = multiply(
      fromRotationZ((angles[2] * Math.PI) / 180),
      multiply(fromRotationY((angles[1] * Math.PI) / 180), fromRotationX((angles[0] * Math.PI) / 180))
    );
    const local = multiply(fromTranslation(origin[0], origin[1], origin[2]), multiply(rotation, fromScale(scale[0], scale[1], scale[2])));
    const parent = layer.parentId !== null ? this.scene.getLayer(layer.parentId) : undefined;
    const world = parent ? multiply(this.worldMatrix(parent), local) : local;
    this.worldMatrices.set(layer.id, world);
    return world;
  }

  private resolveModel(path: string) {
    return this.scene.getModel(path) ?? getBuiltinModel(path);
  }

  private resolveMaterial(path: string): MaterialDefinition | undefined {
    return this.scene.getMaterial(path) ?? getBuiltinMaterial(path);
  }

  private materialForLayer(layer: SceneLayer): MaterialDefinition | undefined {
    if (layer.type === "image" && layer.image) {
      const model = this.resolveModel(layer.image);
      if (model?.material) {
        const material = this.resolveMaterial(model.material);
        if (material) return material;
      }
      return SOLID_MATERIAL;
    }
    if (layer.type === "text") return TEXT_MATERIAL;
    if (layer.type === "solid") return SOLID_MATERIAL;
    return undefined;
  }

  private baseTexture(layer: SceneLayer, pass: MaterialPass): GpuTexture | null {
    if (layer.type === "text" && layer.text) {
      const size = layer.transform.size;
      if (!size || size[0] <= 0 || size[1] <= 0) return null;
      return this.text.getTexture(layer.id, layer.text, size[0], size[1], this.options.textScale ?? 2);
    }
    const name = pass.textures[0];
    return name ? this.textures.get(name) : null;
  }

  private resolveQuad(layer: SceneLayer, texture: GpuTexture | null): Quad | null {
    if (layer.type === "particle") return { width: 0, height: 0, offsetX: 0, offsetY: 0 };
    let width = layer.transform.size?.[0] ?? 0;
    let height = layer.transform.size?.[1] ?? 0;
    let offsetX = 0;
    let offsetY = 0;
    if (layer.type === "image" && layer.image) {
      const model = this.resolveModel(layer.image);
      if (model?.cropOffset) {
        offsetX += model.cropOffset[0];
        offsetY += model.cropOffset[1];
      }
      // 尺寸优先级：图层自己的 size → 模型声明的 width/height → 贴图尺寸。
      // （工程里的模型常写 width/height，此时图层不需要 size，也不能拿
      //   `textures[0]` 推断——那可能是一张小尺寸的遮罩。）
      if (width <= 0 || height <= 0) {
        if (model?.width && model?.height) {
          width = model.width;
          height = model.height;
        } else if (texture) {
          width = texture.width;
          height = texture.height;
        }
      }
    }
    if (width <= 0 || height <= 0) return null;
    const [alignX, alignY] = alignmentOffset(layer.transform.alignment, width, height);
    return { width, height, offsetX: offsetX + alignX, offsetY: offsetY + alignY };
  }

  /** 供调试用的视口尺寸（CSS 像素 × pixelRatio）。 */
  get viewportSize(): { width: number; height: number; pixelRatio: number } {
    return { width: this.width, height: this.height, pixelRatio: this.options.pixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1) };
  }

  private renderLayer(layer: SceneLayer, projection: Mat4, time: number, stats: LayerDrawStats, localProjectionForDebug?: Mat4): void {
    if (layer.type === "particle") {
      this.renderParticleLayer(layer, projection, time, stats);
      return;
    }
    const material = this.materialForLayer(layer);
    if (!material || material.passes.length === 0) {
      stats.reason = "no material";
      return;
    }
    const firstPass = material.passes[0];
    const texture = this.baseTexture(layer, firstPass);
    const quad = this.resolveQuad(layer, texture);
    if (!quad) {
      stats.reason = layer.type === "solid" ? "transform group" : "no size";
      return;
    }

    stats.quad = { width: quad.width, height: quad.height, offsetX: quad.offsetX, offsetY: quad.offsetY };
    stats.clip = ([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as Array<[number, number]>).map(([x, y]) => {
      const point = transformPoint(
        multiply((localProjectionForDebug ?? projection), multiply(this.worldMatrix(layer), multiply(fromTranslation(quad.offsetX, quad.offsetY, 0), fromScale(quad.width, quad.height, 1)))),
        [x, y, 0]
      );
      return [Number(point[0].toFixed(3)), Number(point[1].toFixed(3))] as [number, number];
    });
    const quadModel = multiply(this.worldMatrix(layer), multiply(fromTranslation(quad.offsetX, quad.offsetY, 0), fromScale(quad.width, quad.height, 1)));
    const activeEffects = this.options.disableEffects ? [] : layer.effects.filter((effect) => effect.visible && this.scene.getEffect(effect.file));
    const bounds = this.layerBounds(quadModel, projection);
    const needsTarget = activeEffects.length > 0 || material.passes.length > 1;
    if (bounds) stats.bounds = { left: bounds.pixel.left, right: bounds.pixel.right, bottom: bounds.pixel.bottom, top: bounds.pixel.top };
    if (needsTarget && !bounds) {
      stats.reason = "outside the view";
      return;
    }

    if (!needsTarget) {
      applyBlendMode(this.gl, firstPass.blending);
      this.drawPass({
        pass: firstPass,
        layer,
        model: quadModel,
        projection,
        textures: this.resolvePassTextures(firstPass, layer, texture, null),
        time,
        stats
      });
      stats.drawn = true;
      return;
    }

    const target = this.targets.acquire(bounds!.pixel.width, bounds!.pixel.height);
    target.bind(true);
    const targetProjection = orthographic(bounds!.world.left, bounds!.world.right, bounds!.world.bottom, bounds!.world.top, -this.scene.general.farZ, this.scene.general.farZ);
    applyBlendMode(this.gl, firstPass.blending);
    this.drawPass({
      pass: firstPass,
      layer,
      model: quadModel,
      projection: targetProjection,
      textures: this.resolvePassTextures(firstPass, layer, texture, null),
      time,
      stats
    });

    let current = target;
    for (const effect of activeEffects) {
      current = this.applyEffect(layer, effect, current, bounds!, time, stats);
    }
    this.composite(current, bounds!.pixel, layer, firstPass.blending);
    stats.drawn = true;
  }

  /**
   * Bounds of a layer quad: in scene units (so a render target can use the very
   * same coordinates) and in device pixels (so the target can be sized and later
   * composited in the right place).
   */
  private layerBounds(model: Mat4, projection: Mat4): Bounds | null {
    const mvp = multiply(projection, model);
    const corners: Array<[number, number]> = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5]
    ];
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let worldMinX = Number.POSITIVE_INFINITY;
    let worldMinY = Number.POSITIVE_INFINITY;
    let worldMaxX = Number.NEGATIVE_INFINITY;
    let worldMaxY = Number.NEGATIVE_INFINITY;
    for (const [x, y] of corners) {
      const point = transformPoint(mvp, [x, y, 0]);
      minX = Math.min(minX, point[0]);
      maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]);
      maxY = Math.max(maxY, point[1]);
      const world = transformPoint(model, [x, y, 0]);
      worldMinX = Math.min(worldMinX, world[0]);
      worldMaxX = Math.max(worldMaxX, world[0]);
      worldMinY = Math.min(worldMinY, world[1]);
      worldMaxY = Math.max(worldMaxY, world[1]);
    }
    const toPixelX = (value: number) => ((value + 1) * 0.5) * this.width;
    const toPixelY = (value: number) => ((value + 1) * 0.5) * this.height;
    const padding = 4;
    let left = clamp(Math.floor(toPixelX(minX)) - padding, 0, this.width);
    let right = clamp(Math.ceil(toPixelX(maxX)) + padding, 0, this.width);
    let bottom = clamp(Math.floor(toPixelY(minY)) - padding, 0, this.height);
    let top = clamp(Math.ceil(toPixelY(maxY)) + padding, 0, this.height);
    if (right - left < 1 || top - bottom < 1) return null;
    const limit = this.options.maxLayerResolution ?? Math.max(this.width, this.height);
    if (right - left > limit || top - bottom > limit) {
      const scale = limit / Math.max(right - left, top - bottom);
      const centerX = (left + right) / 2;
      const centerY = (bottom + top) / 2;
      left = Math.max(0, centerX - ((right - left) * scale) / 2);
      right = Math.min(this.width, centerX + ((right - left) * scale) / 2);
      bottom = Math.max(0, centerY - ((top - bottom) * scale) / 2);
      top = Math.min(this.height, centerY + ((top - bottom) * scale) / 2);
    }
    return {
      world: { left: worldMinX, right: worldMaxX, bottom: worldMinY, top: worldMaxY },
      pixel: { left, right, bottom, top, width: Math.max(1, Math.round(right - left)), height: Math.max(1, Math.round(top - bottom)) }
    };
  }

  /**
   * Texture units for a pass. Unit 0 is the layer's own texture for material
   * passes and the accumulated composite for effect passes.
   */
  private resolvePassTextures(pass: MaterialPass, layer: SceneLayer, base: GpuTexture | null, previous: GpuTexture | null): Array<GpuTexture | null> {
    const textures: Array<GpuTexture | null> = [previous ?? base];
    for (let unit = 1; unit < 4; unit++) {
      const name = pass.textures[unit];
      textures.push(name ? this.textures.get(name) : null);
    }
    return textures;
  }

  private drawPass(draw: PassDraw): void {
    const gl = this.gl;
    const resolved = draw.resolved ?? this.programFor(draw.pass, draw.constants);
    if (!resolved) {
      draw.stats.reason = `shader "${draw.pass.shader}" unavailable`;
      return;
    }
    const program = resolved.program;
    const layout = resolved.layout;
    gl.useProgram(program.program);
    const mvp = draw.clipSpace ? mat4() : multiply(draw.projection, draw.model);
    this.setMatrix(program, "g_ModelViewProjectionMatrix", mvp);
    this.setMatrix(program, "g_LayerModelMatrix", draw.clipSpace ? mat4() : draw.model);
    this.setFloat(program, "g_Time", draw.time);
    const color = draw.layer.color;
    const alpha = draw.layer.alpha;
    this.setVec4(program, "g_Color4", [color[0], color[1], color[2], color[3] * alpha]);
    this.setVec4(program, "g_Color", [color[0], color[1], color[2], color[3] * alpha]);
    this.setFloat(program, "g_Alpha", alpha);
    this.setVec2(program, "u_Size", [draw.layer.transform.size?.[0] ?? draw.textures[0]?.width ?? 1, draw.layer.transform.size?.[1] ?? draw.textures[0]?.height ?? 1]);
    this.bindTextures(program, draw.textures, layout);
    this.applyShaderConstants(program, layout, draw.pass, draw.constants, draw.layer);
    drawQuad(gl, draw.clipSpace ? this.fullQuad : this.imageQuad, program);
  }

  /** Resolves the program for a material pass from either the builtins or the package. */
  private programFor(pass: MaterialPass, constants?: Record<string, unknown>): { program: ProgramInfo; layout: ComposedShader | null } | null {
    const combos = { ...pass.combos };
    if (BUILTIN_NAMES.has(pass.shader)) {
      const program = this.pipeline.getBuiltin(pass.shader, combos);
      return program ? { program, layout: null } : null;
    }
    const effect = this.pipeline.getEffect(pass.shader, combos);
    return effect ? { program: effect.program, layout: effect.layout } : null;
  }

  private bindTextures(program: ProgramInfo, textures: Array<GpuTexture | null>, layout?: ComposedShader | null): void {
    const gl = this.gl;
    for (let unit = 0; unit < 4; unit++) {
      let texture = textures[unit] ?? null;
      if (!texture && layout) {
        const hint = layout.samplers.find((sampler) => sampler.name === `g_Texture${unit}`);
        if (hint?.default && typeof hint.default === "string") texture = this.textures.get(hint.default);
      }
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture ? texture.texture : null);
      const location = program.uniforms.get(`g_Texture${unit}`);
      if (location) gl.uniform1i(location, unit);
      const resolution = program.uniforms.get(`g_Texture${unit}Resolution`);
      if (resolution) {
        const width = texture?.width ?? 1;
        const height = texture?.height ?? 1;
        gl.uniform4f(resolution, width, height, 1 / width, 1 / height);
      }
    }
  }

  private applyShaderConstants(
    program: ProgramInfo,
    layout: ComposedShader | null,
    pass: MaterialPass,
    constants: Record<string, unknown> | undefined,
    layer: SceneLayer
  ): void {
    if (!layout) return;
    const gl = this.gl;
    const lookup = new Map<string, unknown>();
    for (const [key, value] of Object.entries(pass.constantshadervalues)) lookup.set(key.toLowerCase(), value);
    for (const [key, value] of Object.entries(constants ?? {})) lookup.set(key.toLowerCase(), value);

    for (const hint of layout.uniforms) {
      if (hint.glslType === "sampler2D") continue;
      const location = program.uniforms.get(hint.name);
      if (!location) continue;
      let value: unknown;
      if (hint.material) value = lookup.get(hint.material.toLowerCase());
      if (value === undefined) value = lookup.get(hint.name.toLowerCase());
      if (value === undefined) value = hint.default;
      if (value === undefined || value === null) continue;
      switch (hint.glslType) {
        case "float":
          gl.uniform1f(location, readNumber(value, 0));
          break;
        case "vec2":
          gl.uniform2fv(location, readVec(value, 2));
          break;
        case "vec3":
          gl.uniform3fv(location, readVec(value, 3));
          break;
        case "vec4":
          gl.uniform4fv(location, readVec(value, 4));
          break;
        default:
          break;
      }
    }
  }

  // ------------------------------------------------------------------ effects

  private applyEffect(layer: SceneLayer, effect: SceneLayer["effects"][number], input: RenderTarget, bounds: Bounds, time: number, stats: LayerDrawStats): RenderTarget {
    const size = bounds.pixel;
    const definition: EffectDefinition | undefined = this.scene.getEffect(effect.file);
    if (!definition) return input;
    const named = new Map<string, RenderTarget>();
    let current = input;

    for (const [index, passDefinition] of definition.passes.entries()) {
      const material = this.resolveMaterial(passDefinition.material);
      const pass = material?.passes[0];
      if (!pass) continue;
      const instance = effect.passes[index];
      const combos = { ...pass.combos, ...(instance?.combos ?? {}) };
      const resolved = this.pipeline.getEffect(pass.shader, combos);
      if (!resolved) {
        stats.reason = `effect shader "${pass.shader}" unavailable`;
        this.report(`effect "${effect.file}" pass ${index} uses unavailable shader "${pass.shader}"`);
        continue;
      }

      let target: RenderTarget;
      if (passDefinition.target) {
        const existing = named.get(passDefinition.target);
        target = existing ?? this.targets.acquire(size.width, size.height);
        named.set(passDefinition.target, target);
      } else {
        target = this.targets.acquire(size.width, size.height);
      }
      if (target === current) target = this.targets.acquire(size.width, size.height);

      const textures: Array<GpuTexture | null> = [asTexture(current), null, null, null];
      if (passDefinition.bind) {
        for (const binding of passDefinition.bind) {
          const bound = binding.name === "previous" ? current : named.get(binding.name);
          if (binding.index >= 0 && binding.index < 4) textures[binding.index] = bound ? asTexture(bound) : null;
        }
      }
      for (let unit = 1; unit < 4; unit++) {
        const name = instance?.textures?.[unit];
        if (typeof name === "string" && name.length > 0) textures[unit] = this.textures.get(name);
        else if (pass.textures[unit]) textures[unit] = this.textures.get(pass.textures[unit]);
      }
      // Samplers declared with an engine default (util/white, ...) resolve last.
      for (const hint of resolved.layout.samplers) {
        const unit = Number.parseInt(hint.name.replace("g_Texture", ""), 10);
        if (Number.isNaN(unit) || unit < 0 || unit > 3 || unit === 0) continue;
        if (textures[unit]) continue;
        if (typeof hint.default === "string" && this.scene.has(`materials/${hint.default}.tex`)) textures[unit] = this.textures.get(hint.default);
        else if (typeof hint.default === "string") textures[unit] = this.textures.get(hint.default);
      }

      target.bind(true);
      applyBlendMode(this.gl, pass.blending === "normal" ? "translucent" : pass.blending);
      this.drawPass({
        pass,
        layer,
        resolved,
        model: mat4(),
        projection: mat4(),
        textures,
        constants: instance?.constantshadervalues,
        clipSpace: true,
        time,
        stats
      });
      current = target;
    }
    return current;
  }

  private composite(target: RenderTarget, bounds: Rect & { width: number; height: number }, layer: SceneLayer, blending: MaterialPass["blending"]): void {
    const gl = this.gl;
    const program = this.pipeline.getBuiltin("composite");
    if (!program) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    applyBlendMode(gl, blending);
    gl.useProgram(program.program);
    const left = (bounds.left / this.width) * 2 - 1;
    const right = (bounds.right / this.width) * 2 - 1;
    const bottom = (bounds.bottom / this.height) * 2 - 1;
    const top = (bounds.top / this.height) * 2 - 1;
    const model = mat4();
    model[0] = (right - left) / 2;
    model[5] = (top - bottom) / 2;
    model[12] = (left + right) / 2;
    model[13] = (bottom + top) / 2;
    this.setMatrix(program, "g_ModelViewProjectionMatrix", model);
    const color = layer.color;
    this.setVec4(program, "g_Color4", [color[0], color[1], color[2], color[3] * layer.alpha]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    const sampler = program.uniforms.get("g_Texture0");
    if (sampler) gl.uniform1i(sampler, 0);
    drawQuad(gl, this.fullQuad, program);
  }

  // ---------------------------------------------------------------- particles

  private updateParticles(delta: number): void {
    for (const layer of this.scene.layers) {
      if (layer.type !== "particle" || !layer.particle) continue;
      for (const system of this.particleSystemsFor(layer)) system.update(delta);
    }
  }

  private particleSystemsFor(layer: SceneLayer): ParticleSystem[] {
    const existing = this.particleSystems.get(layer.id);
    if (existing) return existing;
    const systems: ParticleSystem[] = [];
    const json = this.bundle?.getJSON<Record<string, unknown>>(layer.particle!);
    if (json) {
      const definition = parseParticleDefinition(json);
      const root = new ParticleSystem(definition, undefined, this.options.particles);
      systems.push(root);
      for (const child of definition.children) {
        const childJSON = this.bundle?.getJSON<Record<string, unknown>>(child.name);
        if (!childJSON) continue;
        systems.push(new ParticleSystem(parseParticleDefinition(childJSON), root, this.options.particles));
      }
    }
    const unsupported = new Set<string>();
    for (const system of systems) for (const name of system.unsupported) unsupported.add(name);
    for (const name of unsupported) this.report(`particle feature "${name}" is not implemented`);
    this.particleSystems.set(layer.id, systems);
    return systems;
  }

  private renderParticleLayer(layer: SceneLayer, projection: Mat4, time: number, stats: LayerDrawStats): void {
    const systems = this.particleSystemsFor(layer);
    if (systems.length === 0) {
      stats.reason = "no particle definition";
      return;
    }
    const material = this.resolveMaterial(systems[0].definition.material);
    const pass = material?.passes[0];
    if (!pass) {
      stats.reason = "no particle material";
      return;
    }
    const program = this.pipeline.getBuiltin("genericparticle", pass.combos);
    if (!program) {
      stats.reason = "particle shader unavailable";
      return;
    }
    // The sprite height is derived from the texture aspect ratio, exactly like
    // the engine's ComputeParticlePosition does.
    const textureName = pass.textures[0];
    const particleTexture = textureName ? this.textures.get(textureName) : null;
    const textureAspect = particleTexture && particleTexture.width > 0 ? particleTexture.height / particleTexture.width : 1;

    let vertices = 0;
    const stride = 9;
    for (const system of systems) {
      const required = (vertices + system.definition.maxCount * 6) * stride;
      if (this.particleVertices.length < required) {
        const grown = new Float32Array(Math.max(required, this.particleVertices.length * 2));
        grown.set(this.particleVertices);
        this.particleVertices = grown;
      }
      vertices += system.buildVertices(this.particleVertices.subarray(vertices * stride), stride, textureAspect);
    }
    stats.particles = Math.round(vertices / 6);
    if (vertices === 0) {
      stats.reason = "no live particles";
      return;
    }

    const gl = this.gl;
    applyBlendMode(gl, pass.blending);
    gl.useProgram(program.program);
    this.setMatrix(program, "g_ModelViewProjectionMatrix", multiply(projection, this.worldMatrix(layer)));
    this.setFloat(program, "g_Time", time);
    this.bindTextures(program, [particleTexture]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.particleVertices.subarray(0, vertices * stride), gl.DYNAMIC_DRAW);
    const byteStride = stride * 4;
    const position = program.attributes.get("a_Position");
    const texCoord = program.attributes.get("a_TexCoord");
    const color = program.attributes.get("a_Color");
    if (position !== undefined) {
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 3, gl.FLOAT, false, byteStride, 0);
    }
    if (texCoord !== undefined) {
      gl.enableVertexAttribArray(texCoord);
      gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, byteStride, 12);
    }
    if (color !== undefined) {
      gl.enableVertexAttribArray(color);
      gl.vertexAttribPointer(color, 4, gl.FLOAT, false, byteStride, 20);
    }
    gl.drawArrays(gl.TRIANGLES, 0, vertices);
    stats.drawn = true;
  }

  private materialTextureNames(layer: SceneLayer): string[] {
    const names: string[] = [];
    for (const pass of this.materialForLayer(layer)?.passes ?? []) names.push(...pass.textures);
    if (layer.type === "particle" && layer.particle) {
      const json = this.bundle?.getJSON<Record<string, unknown>>(layer.particle);
      if (json) {
        const definition = parseParticleDefinition(json);
        for (const pass of this.resolveMaterial(definition.material)?.passes ?? []) names.push(...pass.textures);
        for (const child of definition.children) {
          const childJSON = this.bundle?.getJSON<Record<string, unknown>>(child.name);
          if (!childJSON) continue;
          for (const pass of this.resolveMaterial(parseParticleDefinition(childJSON).material)?.passes ?? []) names.push(...pass.textures);
        }
      }
    }
    for (const effect of layer.effects) {
      const definition = this.scene.getEffect(effect.file);
      for (const pass of definition?.passes ?? []) {
        for (const materialPass of this.resolveMaterial(pass.material)?.passes ?? []) names.push(...materialPass.textures);
      }
    }
    return names;
  }

  // ------------------------------------------------------------ uniform helpers

  private setMatrix(program: ProgramInfo, name: string, value: Mat4): void {
    const location = program.uniforms.get(name);
    if (location) this.gl.uniformMatrix4fv(location, false, value);
  }

  private setVec4(program: ProgramInfo, name: string, value: number[]): void {
    const location = program.uniforms.get(name);
    if (location) this.gl.uniform4f(location, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1);
  }

  private setVec2(program: ProgramInfo, name: string, value: [number, number]): void {
    const location = program.uniforms.get(name);
    if (location) this.gl.uniform2f(location, value[0], value[1]);
  }

  private setFloat(program: ProgramInfo, name: string, value: number): void {
    const location = program.uniforms.get(name);
    if (location) this.gl.uniform1f(location, value);
  }
}

function requireBundle(bundle: AssetBundle | undefined): AssetBundle {
  if (!bundle) throw new Error("SceneRenderer requires a package archive, a project bundle or a scene document");
  return bundle;
}

function asTexture(target: RenderTarget): GpuTexture {
  return { texture: target.texture, width: target.width, height: target.height };
}

function createBuffer(gl: WebGL2RenderingContext, data: Float32Array): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("Unable to allocate a vertex buffer");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

function drawQuad(gl: WebGL2RenderingContext, buffer: WebGLBuffer, program: ProgramInfo): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const position = program.attributes.get("a_Position");
  const texCoord = program.attributes.get("a_TexCoord");
  const color = program.attributes.get("a_Color");
  if (position !== undefined) {
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 20, 0);
  }
  if (texCoord !== undefined) {
    gl.enableVertexAttribArray(texCoord);
    gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, 20, 12);
  }
  if (color !== undefined) {
    gl.disableVertexAttribArray(color);
    gl.vertexAttrib4f(color, 1, 1, 1, 1);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
