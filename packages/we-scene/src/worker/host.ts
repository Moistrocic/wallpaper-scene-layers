/**
 * 把渲染搬进 worker 的宿主端 API。
 *
 * 主线程只做三件轻活：把画布 `transferControlToOffscreen()` 交给 worker、在尺寸变化时
 * 转发一条消息、在指针移动时转发坐标。下载、解析 `scene.pkg`、解码 `.tex`、编译着色器、
 * 粒子模拟与每一帧的绘制全部在 worker 里完成，所以主线程被占用时壁纸仍然照常播放。
 *
 * ```ts
 * const wallpaper = await createWorkerWallpaper({ canvas, source: "scene.pkg" });
 * console.log(wallpaper.layers.length, wallpaper.summary.resolution);
 * wallpaper.setLayerVisible("灰烬光束", false);
 * ```
 *
 * 环境不支持 OffscreenCanvas 时会自动退回主线程渲染（可用 `fallbackToMainThread: false`
 * 改成直接报错），两条路径返回同一个形状的对象。
 */
import { PackageArchive } from "../pkg/archive.js";
import { EngineAssets, type EngineAssetsOptions } from "../assets/engine-assets.js";
import type { FitMode, RendererViewport } from "../render/renderer.js";
import { describeLayerParticleParameters, describeLayers, summariseScene, type LayerDescription, type SceneSummary } from "../scene/inspect.js";
import { createWallpaper, type Wallpaper, type WallpaperOptions, type WallpaperSource } from "../wallpaper.js";
import type {
  HostMessage,
  SerializedSource,
  SerializedWorkerOptions,
  WorkerArchiveInfo,
  WorkerCapabilities,
  WorkerDriver,
  WorkerEngineAssets,
  WorkerMessage,
  WorkerParticleParameters,
  WorkerReadyMessage,
  WorkerStats
} from "./protocol.js";

/** 库自带的渲染 worker 入口（与宿主同目录，打包器能识别 `new URL(...)` 这种写法）。 */
export const DEFAULT_RENDER_WORKER_URL = new URL("./render-worker.js", import.meta.url);

export interface WorkerWallpaperOptions extends Omit<WallpaperOptions, "canvas" | "onDiagnostic"> {
  /** 主线程画布：控制权会被移交给 worker（移交给 OffscreenCanvas）。 */
  canvas: HTMLCanvasElement;
  /** 自定义 worker 实例或工厂；不给就用库自带的渲染 worker。 */
  worker?: Worker | (() => Worker);
  /**
   * 谁推动帧循环，默认 `"timer"`：worker 自己按 `fps` 出帧，主线程被占用也照常播放。
   * `"manual"` 时只在调用 `renderFrame()` 时画一帧，适合宿主已经有自己的循环。
   */
  driver?: WorkerDriver;
  /** `driver: "timer"` 时的目标帧率，默认 60。 */
  fps?: number;
  /** 每隔多少毫秒把统计推回宿主（默认 0 = 只在 `requestStats()` 时给）。 */
  statsIntervalMs?: number;
  /** 环境不支持 worker 渲染时退回主线程，默认 true。 */
  fallbackToMainThread?: boolean;
  onDiagnostic?: (message: string) => void;
  onStats?: (stats: WorkerStats) => void;
}

/** 宿主侧收到的事件（`wallpaper.on(...)`）。 */
export type WorkerWallpaperEvent =
  | { type: "stats"; stats: WorkerStats }
  | { type: "diagnostic"; message: string }
  | { type: "error"; error: Error }
  | { type: "disposed" };

export interface WorkerWallpaper {
  /** 主线程画布；绘制发生在 worker 里，这里只保留布局。 */
  readonly canvas: HTMLCanvasElement;
  /** worker 实例；回退到主线程渲染时为 undefined。 */
  readonly worker?: Worker;
  /** 是否真的在 worker 里渲染。 */
  readonly offscreen: boolean;
  /** 图层清单（worker 解析后回传，结构与 `describeLayers()` 一致）。 */
  readonly layers: LayerDescription[];
  readonly summary: SceneSummary;
  readonly shaderErrors: string[];
  readonly diagnostics: string[];
  /** 打包壁纸时才有（工程目录模式为 undefined）。 */
  readonly archiveInfo?: WorkerArchiveInfo;
  /** worker 侧的 WebGL 能力探测结果。 */
  readonly capabilities?: WorkerCapabilities;
  /** 打开「引擎资源」开关时，worker 实际读到的引擎文件。 */
  readonly engineAssets?: WorkerEngineAssets;
  readonly running: boolean;
  /** 最近一次收到的运行数据（配合 `statsIntervalMs` 或 `requestStats()`）。 */
  readonly stats: WorkerStats | null;
  start(): void;
  stop(): void;
  /** 渲染 t 秒这一帧。 */
  renderFrame(timeSeconds: number): Promise<void>;
  /** 在 worker 里按固定步长推进到指定时刻（截图/封面预热，粒子与文字才会到位）。 */
  warmUp(seconds: number, step?: number): Promise<void>;
  setLayerVisible(layer: number | string, visible: boolean): Promise<void>;
  setFit(fit: FitMode): Promise<void>;
  setCameraParallax(enabled: boolean): Promise<void>;
  /** 立刻取一次运行数据。 */
  requestStats(): Promise<WorkerStats>;
  /** 某个粒子图层展开后的参数表（含官方默认值补齐）。 */
  particleParameters(layer: number | string): Promise<WorkerParticleParameters | undefined>;
  /** 等此前发出的命令全部执行完。 */
  flush(): Promise<void>;
  /** 等 worker 完成初始化（`createWorkerWallpaper()` 返回时已经就绪）。 */
  ready(): Promise<void>;
  /** 重新量一次画布尺寸并同步给 worker。 */
  resize(): void;
  on(listener: (event: WorkerWallpaperEvent) => void): () => void;
  dispose(): void;
}

/** 当前环境能不能把渲染放进 worker。 */
export function supportsWorkerRendering(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function"
  );
}

function createWorkerInstance(options: WorkerWallpaperOptions): Worker {
  if (typeof options.worker === "function") return options.worker();
  if (options.worker) return options.worker;
  return new Worker(DEFAULT_RENDER_WORKER_URL, { type: "module", name: "we-scene-renderer" });
}

function measureViewport(canvas: HTMLCanvasElement, pixelRatio?: number): RendererViewport {
  const rect = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : undefined;
  const width = canvas.clientWidth || rect?.width || canvas.width || 1920;
  const height = canvas.clientHeight || rect?.height || canvas.height || 1080;
  return { width, height, pixelRatio: pixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1) };
}

/** 把来源拆成"能过 worker 边界"的形式；ArrayBuffer/PackageArchive 会被拷贝一份再 transfer。 */
function serializeSource(source: WallpaperSource | undefined, transfer: Transferable[]): SerializedSource | undefined {
  if (!source) return undefined;
  if (source instanceof PackageArchive) {
    const bytes = source.copyBytes();
    const buffer = bytes.buffer as ArrayBuffer;
    transfer.push(buffer);
    return { kind: "buffer", buffer };
  }
  if (typeof source === "string") return { kind: "url", url: source };
  if (typeof URL !== "undefined" && source instanceof URL) return { kind: "url", url: source.toString() };
  if (typeof Blob !== "undefined" && source instanceof Blob) return { kind: "blob", blob: source };
  if (ArrayBuffer.isView(source)) {
    const copy = (source.buffer as ArrayBuffer).slice(source.byteOffset, source.byteOffset + source.byteLength);
    transfer.push(copy);
    return { kind: "buffer", buffer: copy };
  }
  const copy = (source as ArrayBuffer).slice(0);
  transfer.push(copy);
  return { kind: "buffer", buffer: copy };
}

/** EngineAssets 实例不能过 worker 边界，换成等价的选项对象。 */
function serializeEngineAssets(input: WallpaperOptions["engineAssets"]): SerializedWorkerOptions["engineAssets"] {
  if (!input) return undefined;
  if (input instanceof EngineAssets) {
    const { baseUrl, directory } = input.source;
    if (baseUrl) return baseUrl;
    if (directory) return { directory };
    return undefined;
  }
  if (typeof input === "string") return input;
  return input as EngineAssetsOptions;
}

function serializeOptions(options: WorkerWallpaperOptions, transfer: Transferable[]): SerializedWorkerOptions {
  return {
    source: serializeSource(options.source, transfer),
    project: options.project ? { baseUrl: options.project.baseUrl, manifestUrl: options.project.manifestUrl, fetchOptions: options.project.fetchOptions } : undefined,
    fit: options.fit,
    pixelRatio: options.pixelRatio,
    clearColor: options.clearColor,
    engineAssets: serializeEngineAssets(options.engineAssets),
    particles: options.particles,
    layers: options.layers,
    maxLayerResolution: options.maxLayerResolution,
    textScale: options.textScale,
    textureFormatOverrides: options.textureFormatOverrides,
    disableEffects: options.disableEffects,
    onlyLayers: options.onlyLayers,
    trackMouse: options.trackMouse
  };
}

/**
 * 在 worker 里加载并渲染一张壁纸。返回的对象与主线程接口同名同义，
 * 区别只是需要等待的调用返回 Promise。
 */
export async function createWorkerWallpaper(options: WorkerWallpaperOptions): Promise<WorkerWallpaper> {
  if (!options.source && !options.project) throw new Error("createWorkerWallpaper 需要 source（scene.pkg）或 project（工程目录）");
  const fallback = options.fallbackToMainThread ?? true;
  if (!supportsWorkerRendering()) {
    if (!fallback) throw new Error("当前环境不支持 OffscreenCanvas / transferControlToOffscreen，无法把渲染放进 worker");
    options.onDiagnostic?.("worker 渲染不可用（缺少 OffscreenCanvas / transferControlToOffscreen），已退回主线程渲染");
    return createMainThreadWallpaper(options);
  }

  let offscreen: OffscreenCanvas;
  try {
    offscreen = options.canvas.transferControlToOffscreen();
  } catch (error) {
    if (!fallback) throw error;
    options.onDiagnostic?.(`画布无法移交给 worker（${(error as Error).message}），已退回主线程渲染`);
    return createMainThreadWallpaper(options);
  }

  const canvas = options.canvas;
  const worker = createWorkerInstance(options);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: WorkerWallpaperEvent) => void>();
  const diagnostics: string[] = [];
  let nextId = 1;
  let disposed = false;
  let running = false;
  let lastStats: WorkerStats | null = null;
  let resolveReady: ((value: WorkerReadyMessage) => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;

  const emit = (event: WorkerWallpaperEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const post = (message: HostMessage) => {
    if (disposed) return;
    worker.postMessage(message);
  };
  const call = <T>(build: (id: number) => HostMessage): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (disposed) {
        reject(new Error("wallpaper 已经 dispose()"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        worker.postMessage(build(id));
      } catch (error) {
        pending.delete(id);
        reject(error as Error);
      }
    });
  const failAll = (error: Error) => {
    for (const [, waiter] of pending) waiter.reject(error);
    pending.clear();
    rejectReady?.(error);
    rejectReady = undefined;
  };

  const readyPromise = new Promise<WorkerReadyMessage>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  worker.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as WorkerMessage;
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "ready":
        resolveReady?.(message);
        resolveReady = undefined;
        rejectReady = undefined;
        break;
      case "stats":
        lastStats = message.stats;
        options.onStats?.(message.stats);
        emit({ type: "stats", stats: message.stats });
        break;
      case "diagnostic":
        if (diagnostics.length < 500) diagnostics.push(message.message);
        options.onDiagnostic?.(message.message);
        emit({ type: "diagnostic", message: message.message });
        break;
      case "error": {
        const error = new Error(message.message);
        if (message.fatal) failAll(error);
        else {
          options.onDiagnostic?.(message.message);
          emit({ type: "diagnostic", message: message.message });
        }
        break;
      }
      case "reply": {
        const waiter = pending.get(message.id);
        if (!waiter) break;
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.value);
        else waiter.reject(new Error(message.error ?? "worker 执行失败"));
        break;
      }
      case "disposed":
        emit({ type: "disposed" });
        break;
    }
  });
  worker.addEventListener("error", (event: ErrorEvent) => {
    const error = new Error(event.message || "render worker 崩溃");
    failAll(error);
    options.onDiagnostic?.(error.message);
    emit({ type: "error", error });
  });
  worker.addEventListener("messageerror", () => {
    const error = new Error("render worker 收到无法反序列化的消息");
    failAll(error);
    emit({ type: "error", error });
  });

  const transfer: Transferable[] = [];
  const serialized = serializeOptions(options, transfer);
  const viewport = measureViewport(canvas, options.pixelRatio);
  transfer.push(offscreen);
  try {
    worker.postMessage(
      {
        type: "init",
        id: nextId++,
        canvas: offscreen,
        viewport,
        options: serialized,
        driver: options.driver ?? "timer",
        fps: options.fps ?? 60,
        statsIntervalMs: options.statsIntervalMs ?? 0
      } satisfies HostMessage,
      transfer
    );
  } catch (error) {
    worker.terminate();
    throw new Error(`选项无法传给 render worker（${(error as Error).message}）；engineAssets.fetchOptions 之类的字段必须是可结构化克隆的`);
  }

  let ready: WorkerReadyMessage;
  try {
    ready = await readyPromise;
  } catch (error) {
    worker.terminate();
    throw error;
  }

  // 尺寸变化：ResizeObserver 观察画布元素（布局仍在主线程这一侧）。
  let lastViewport = viewport;
  const syncViewport = () => {
    if (disposed) return;
    const next = measureViewport(canvas, options.pixelRatio);
    if (next.width === lastViewport.width && next.height === lastViewport.height && next.pixelRatio === lastViewport.pixelRatio) return;
    lastViewport = next;
    post({ type: "resize", viewport: next });
  };
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => syncViewport()) : undefined;
  observer?.observe(canvas);
  if (typeof window !== "undefined") window.addEventListener("resize", syncViewport);

  // 指针视差：主线程只转发坐标，并且最多每 8ms 合并一次。
  let pointerHandler: ((event: PointerEvent) => void) | undefined;
  let pendingMouse: [number, number] | null = null;
  let mouseTimer: ReturnType<typeof setTimeout> | undefined;
  const flushMouse = () => {
    mouseTimer = undefined;
    if (!pendingMouse) return;
    post({ type: "input", mouse: pendingMouse });
    pendingMouse = null;
  };
  if (options.trackMouse ?? ready.trackMouse) {
    pointerHandler = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pendingMouse = [((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1)];
      if (mouseTimer === undefined) mouseTimer = setTimeout(flushMouse, 8);
    };
    if (typeof window !== "undefined") window.addEventListener("pointermove", pointerHandler);
  }

  const wallpaper: WorkerWallpaper = {
    canvas,
    worker,
    offscreen: true,
    layers: ready.layers,
    summary: ready.summary,
    shaderErrors: ready.shaderErrors,
    diagnostics,
    archiveInfo: ready.archive,
    capabilities: ready.capabilities,
    engineAssets: ready.engineAssets,
    get running() {
      return running;
    },
    get stats() {
      return lastStats;
    },
    start() {
      if (disposed || running) return;
      running = true;
      post({ type: "start" });
    },
    stop() {
      if (disposed || !running) return;
      running = false;
      post({ type: "stop" });
    },
    renderFrame(timeSeconds: number) {
      return call<void>((id) => ({ type: "renderFrame", time: timeSeconds, id }));
    },
    warmUp(seconds: number, step?: number) {
      return call<void>((id) => ({ type: "warmUp", seconds, step, id }));
    },
    setLayerVisible(layer: number | string, visible: boolean) {
      return call<void>((id) => ({ type: "layerVisible", layer, visible, id }));
    },
    setFit(fit: FitMode) {
      return call<void>((id) => ({ type: "fit", fit, id }));
    },
    setCameraParallax(enabled: boolean) {
      return call<void>((id) => ({ type: "cameraParallax", enabled, id }));
    },
    async requestStats() {
      const stats = await call<WorkerStats>((id) => ({ type: "stats", id }));
      lastStats = stats;
      return stats;
    },
    particleParameters(layer: number | string) {
      return call<WorkerParticleParameters | undefined>((id) => ({ type: "particleParameters", layer, id }));
    },
    flush() {
      return call<void>((id) => ({ type: "flush", id }));
    },
    async ready() {
      await readyPromise;
    },
    resize() {
      syncViewport();
    },
    on(listener: (event: WorkerWallpaperEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      observer?.disconnect();
      if (typeof window !== "undefined") window.removeEventListener("resize", syncViewport);
      if (pointerHandler && typeof window !== "undefined") window.removeEventListener("pointermove", pointerHandler);
      if (mouseTimer !== undefined) clearTimeout(mouseTimer);
      failAll(new Error("wallpaper 已经 dispose()"));
      try {
        worker.postMessage({ type: "dispose" } satisfies HostMessage);
      } catch {
        // 已经崩了的 worker 直接跳过。
      }
      worker.terminate();
      emit({ type: "disposed" });
    }
  };

  if (options.previewTime !== undefined) await wallpaper.renderFrame(options.previewTime);
  if (options.autoStart !== false) wallpaper.start();
  return wallpaper;
}

/**
 * 回退路径：环境不支持 OffscreenCanvas 时用主线程渲染器，
 * 但返回同样形状的对象，宿主代码不用分叉。
 */
async function createMainThreadWallpaper(options: WorkerWallpaperOptions): Promise<WorkerWallpaper> {
  const wallpaper: Wallpaper = await createWallpaper({
    canvas: options.canvas,
    source: options.source,
    project: options.project,
    fit: options.fit,
    pixelRatio: options.pixelRatio,
    clearColor: options.clearColor,
    trackMouse: options.trackMouse,
    // manual 驱动时宿主自己发帧，别让主线程的 rAF 循环再画一遍。
    autoStart: options.autoStart ?? options.driver !== "manual",
    previewTime: options.previewTime,
    engineAssets: options.engineAssets,
    particles: options.particles,
    layers: options.layers,
    onDiagnostic: options.onDiagnostic
  });
  const renderer = wallpaper.renderer;
  const listeners = new Set<(event: WorkerWallpaperEvent) => void>();
  const diagnostics: string[] = [];
  const frameTimes: number[] = [];
  let frames = 0;
  let running = options.autoStart ?? options.driver !== "manual";
  let lastStats: WorkerStats | null = null;
  let lastFrameAt = 0;

  // 统计一下帧数/帧率，让回退路径与 worker 路径的数据形状一致。
  const originalRender = renderer.render.bind(renderer);
  renderer.render = (time: number, input) => {
    originalRender(time, input);
    frames++;
    const timestamp = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (lastFrameAt > 0) {
      frameTimes.push(timestamp - lastFrameAt);
      if (frameTimes.length > 60) frameTimes.shift();
    }
    lastFrameAt = timestamp;
  };

  const currentStats = (): WorkerStats => {
    const average = frameTimes.length ? frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length : 0;
    return { stats: renderer.layerStats, fps: average > 0 ? Math.round((1000 / average) * 10) / 10 : 0, time: 0, frames };
  };
  const emit = (event: WorkerWallpaperEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  return {
    canvas: options.canvas,
    worker: undefined,
    offscreen: false,
    layers: describeLayers(wallpaper.scene),
    summary: summariseScene(wallpaper.scene),
    shaderErrors: renderer.shaderErrors,
    diagnostics,
    archiveInfo: wallpaper.archive ? { magic: wallpaper.archive.magic, version: wallpaper.archive.version, files: wallpaper.archive.list().length } : undefined,
    capabilities: { s3tc: renderer.capabilities.s3tc, maxTextureSize: renderer.capabilities.maxTextureSize, renderer: renderer.capabilities.renderer },
    engineAssets: renderer.engineAssetStats
      ? {
          cached: renderer.engineAssetStats.cached,
          missing: renderer.engineAssetStats.missing,
          bytes: renderer.engineAssetStats.bytes,
          loaded: renderer.loadedEngineAssets,
          missingFiles: renderer.missingEngineAssets
        }
      : undefined,
    get running() {
      return running;
    },
    get stats() {
      return lastStats;
    },
    start() {
      running = true;
      wallpaper.start();
    },
    stop() {
      running = false;
      wallpaper.stop();
    },
    async renderFrame(timeSeconds: number) {
      renderer.render(timeSeconds, {});
    },
    async warmUp(seconds: number, step = 1 / 60) {
      const stride = step > 0 ? step : 1 / 60;
      for (let time = 0; time <= seconds; time += stride) {
        renderer.render(time, {});
        if (Math.round(time * 60) % 30 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      renderer.render(seconds, {});
      await renderer.ready();
      renderer.render(seconds, {});
    },
    async setLayerVisible(layer: number | string, visible: boolean) {
      renderer.setLayerVisible(layer, visible);
    },
    async setFit(fit: FitMode) {
      renderer.setFit(fit);
    },
    async setCameraParallax(enabled: boolean) {
      wallpaper.scene.general.cameraParallax = enabled;
    },
    async requestStats() {
      lastStats = currentStats();
      return lastStats;
    },
    async particleParameters(layer: number | string) {
      const target = typeof layer === "number" ? wallpaper.scene.getLayer(layer) : wallpaper.scene.layers.find((candidate) => candidate.name === layer);
      if (!target) return undefined;
      return describeLayerParticleParameters(wallpaper.scene, target.id);
    },
    async flush() {
      // 主线程路径本来就是同步的。
    },
    async ready() {
      await renderer.ready();
    },
    resize() {
      // 主线程渲染器自己量布局尺寸。
    },
    on(listener: (event: WorkerWallpaperEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      wallpaper.dispose();
      emit({ type: "disposed" });
    }
  };
}
