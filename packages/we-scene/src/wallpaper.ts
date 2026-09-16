import { PackageArchive } from "./pkg/archive.js";
import { SceneDocument, createSceneFromArchive, createSceneFromBundle } from "./scene/document.js";
import type { SceneLayer } from "./scene/types.js";
import { SceneRenderer, type FitMode, type SceneRendererOptions } from "./render/renderer.js";
import type { EngineAssets, EngineAssetsOptions } from "./assets/engine-assets.js";
import type { AssetBundle } from "./assets/bundle.js";
import { ProjectBundle, type ProjectBundleOptions } from "./assets/project.js";
import type { ParticleOptions } from "./render/particles.js";

export type WallpaperSource = string | URL | ArrayBuffer | ArrayBufferView | Blob | PackageArchive;

export interface WallpaperOptions {
  canvas: HTMLCanvasElement;
  /** `scene.pkg`（URL / File / Blob / ArrayBuffer / PackageArchive）。 */
  source?: WallpaperSource;
  /**
   * 直接渲染一个 Wallpaper Engine **工程目录**（未打包的工程）：
   * 浏览器给 `{ baseUrl, manifestUrl }`，Node 给 `{ directory }`。
   */
  project?: ProjectBundleOptions;
  fit?: FitMode;
  pixelRatio?: number;
  clearColor?: [number, number, number];
  /** Follow the pointer for camera parallax (enabled by default when the scene wants it). */
  trackMouse?: boolean;
  /** 单层渲染目标的上限分辨率（默认跟随画布，见 `SceneRendererOptions`）。 */
  maxLayerResolution?: number;
  /** 文字图层的栅格化倍率（2 = 每个场景单位两个纹素）。 */
  textScale?: number;
  /** 强制某些贴图的像素格式，例如 `{"workshop/x/mask": "r8"}`。 */
  textureFormatOverrides?: Record<string, "bc1" | "bc2" | "bc3" | "rgba8" | "file">;
  /** 跳过特效链（调试 / 廉价预览）。 */
  disableEffects?: boolean;
  /** 只渲染这些图层 id（调试）。 */
  onlyLayers?: number[] | null;
  /** Start the render loop immediately, defaults to true. */
  autoStart?: boolean;
  /** Render this many seconds once after loading, for thumbnails. */
  previewTime?: number;
  /**
   * Optional access to a local Wallpaper Engine installation (HTTP base URL,
   * Node directory, `EngineAssets` instance or options). Assets missing from
   * the package are then read from the engine instead of being approximated.
   */
  engineAssets?: EngineAssets | string | EngineAssetsOptions;
  /**
   * 粒子模拟参数（官方默认值覆盖 + 上浮/定向漂移）。传入的对象会被保留引用，
   * 因此运行中修改它的字段即可实时生效，方便做调参界面。
   */
  particles?: ParticleOptions;
  /**
   * 只加载部分图层（按 id 或名称筛选）。被排除的图层不会加载贴图、编译着色器或绘制，
   * 因此适合"这张壁纸只用其中几层"的适配场景。
   *
   * `include` 给定时只保留匹配的图层（祖先会一并保留，保证变换链完整）；
   * `exclude` 命中的图层连同其子层一起移除。
   */
  layers?: LayerFilter;
  onDiagnostic?: (message: string) => void;
}

/** 图层筛选条件。 */
export interface LayerFilter {
  /** 只保留这些图层（id 或名称）。 */
  include?: Array<number | string>;
  /** 排除这些图层（id 或名称）及其子层。 */
  exclude?: Array<number | string>;
}

export interface Wallpaper {
  /** 打包壁纸时有值；工程目录模式为 undefined。 */
  readonly archive?: PackageArchive;
  readonly bundle: AssetBundle;
  readonly scene: SceneDocument;
  readonly renderer: SceneRenderer;
  /** Layers in painting order. */
  readonly layers: SceneLayer[];
  start(): void;
  stop(): void;
  /** Renders a single frame at `timeSeconds`. */
  renderFrame(timeSeconds: number): void;
  setLayerVisible(layer: number | string, visible: boolean): void;
  dispose(): void;
}

/** Downloads and parses a `scene.pkg`. */
export async function loadPackage(source: WallpaperSource): Promise<PackageArchive> {
  if (source instanceof PackageArchive) return source;
  if (typeof source === "string" || source instanceof URL) {
    const response = await fetch(source.toString());
    if (!response.ok) throw new Error(`Failed to download ${source}: ${response.status} ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    return new PackageArchive(buffer);
  }
  if (source instanceof Blob) return loadPackageFromBlob(source);
  if (ArrayBuffer.isView(source)) {
    return new PackageArchive(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  }
  return new PackageArchive(source);
}

/** 按 id 或名称匹配。 */
function matchesLayer(layer: SceneLayer, entries: Array<number | string>): boolean {
  return entries.some((entry) => (typeof entry === "number" ? layer.id === entry : layer.name === entry));
}

/** 把 `WallpaperOptions.layers` 应用到场景上（就地移除图层）。 */
export function applyLayerFilter(scene: SceneDocument, filter: LayerFilter): { kept: number; removed: number } {
  const excluded = new Set<number>();
  if (filter.exclude?.length) {
    for (const layer of scene.layers) {
      if (!matchesLayer(layer, filter.exclude)) continue;
      // 命中的图层连同其所有子层一起排除。
      const stack = [layer.id];
      while (stack.length) {
        const id = stack.pop()!;
        if (excluded.has(id)) continue;
        excluded.add(id);
        const child = scene.getLayer(id);
        if (child) stack.push(...child.childIds);
      }
    }
  }
  const include = filter.include;
  return scene.retainLayers((layer) => {
    if (excluded.has(layer.id)) return false;
    if (!include || include.length === 0) return true;
    return matchesLayer(layer, include);
  });
}

export async function loadPackageFromBlob(blob: Blob): Promise<PackageArchive> {
  return new PackageArchive(await blob.arrayBuffer());
}

/**
 * One call setup: downloads the package, parses the scene and attaches the
 * render loop. Everything stays reachable through the returned object so a host
 * application can drive layers individually.
 */
export async function createWallpaper(options: WallpaperOptions): Promise<Wallpaper> {
  if (!options.source && !options.project) throw new Error("createWallpaper needs either source (scene.pkg) or project (工程目录)");

  let archive: PackageArchive | undefined;
  let bundle: ProjectBundle | undefined;
  if (options.project) {
    bundle = await ProjectBundle.open(options.project);
    // 渲染是同步的：JSON 与着色器源码必须先落到内存里。
    await bundle.preloadSyncAssets();
  } else {
    archive = await loadPackage(options.source as WallpaperSource);
    bundle = undefined;
  }
  const scene = archive ? createSceneFromArchive(archive) : createSceneFromBundle(bundle!);
  // 只保留指定图层：被排除的图层连贴图都不会加载。
  if (options.layers) applyLayerFilter(scene, options.layers);
  const rendererOptions: SceneRendererOptions = {
    canvas: options.canvas,
    archive,
    bundle: bundle ?? archive,
    scene,
    fit: options.fit,
    pixelRatio: options.pixelRatio,
    clearColor: options.clearColor,
    engineAssets: options.engineAssets,
    particles: options.particles,
    maxLayerResolution: options.maxLayerResolution,
    textScale: options.textScale,
    textureFormatOverrides: options.textureFormatOverrides,
    disableEffects: options.disableEffects,
    onlyLayers: options.onlyLayers,
    onDiagnostic: options.onDiagnostic
  };
  const renderer = new SceneRenderer(rendererOptions);
  await renderer.preload();

  let frame = 0;
  let running = false;
  let startTime = 0;
  let mouse: [number, number] | undefined;
  const trackMouse = options.trackMouse ?? scene.general.cameraParallax;

  const onPointerMove = (event: PointerEvent) => {
    const rect = options.canvas.getBoundingClientRect();
    mouse = [((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1)];
  };

  const loop = (timestamp: number) => {
    if (!running) return;
    if (startTime === 0) startTime = timestamp;
    renderer.render((timestamp - startTime) / 1000, { mouse });
    frame = requestAnimationFrame(loop);
  };

  const resolvedBundle: AssetBundle = (bundle ?? archive) as AssetBundle;

  const wallpaper: Wallpaper = {
    archive,
    bundle: resolvedBundle,
    scene,
    renderer,
    layers: scene.layers,
    start() {
      if (running) return;
      running = true;
      startTime = 0;
      if (trackMouse && typeof window !== "undefined") window.addEventListener("pointermove", onPointerMove);
      frame = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      if (trackMouse && typeof window !== "undefined") window.removeEventListener("pointermove", onPointerMove);
    },
    renderFrame(timeSeconds: number) {
      renderer.render(timeSeconds, { mouse });
    },
    setLayerVisible(layer: number | string, visible: boolean) {
      renderer.setLayerVisible(layer, visible);
    },
    dispose() {
      wallpaper.stop();
      renderer.dispose();
    }
  };

  if (options.previewTime !== undefined) wallpaper.renderFrame(options.previewTime);
  if (options.autoStart !== false) wallpaper.start();
  return wallpaper;
}
