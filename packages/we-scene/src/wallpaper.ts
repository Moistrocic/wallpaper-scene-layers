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
  onDiagnostic?: (message: string) => void;
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
