/**
 * worker 渲染的通信协议。
 *
 * 主线程（宿主）与渲染 worker 之间只传**可以结构化克隆**的数据：OffscreenCanvas、
 * ArrayBuffer、Blob 与普通对象。函数（onDiagnostic 之类）留在宿主侧，worker 用消息
 * 把它们转发回主线程。
 */
import type { EngineAssetsOptions } from "../assets/engine-assets.js";
import type { ProjectBundleOptions } from "../assets/project.js";
import type { ResolvedParticleParameter } from "../render/particle-defaults.js";
import type { ParticleOptions } from "../render/particles.js";
import type { FitMode, LayerDrawStats, RendererViewport } from "../render/renderer.js";
import type { LayerDescription, SceneSummary } from "../scene/inspect.js";
import type { LayerFilter } from "../wallpaper.js";

/**
 * 谁推动帧循环：
 *
 * * `timer` —— worker 自己按 `fps` 定时出帧。主线程卡死时壁纸照常播放（默认）；
 * * `manual` —— 只在宿主调用 `renderFrame()` 时画一帧，适合宿主已经有自己的循环。
 */
export type WorkerDriver = "timer" | "manual";

/** 能过 worker 边界的壁纸来源。 */
export type SerializedSource =
  | { kind: "url"; url: string }
  | { kind: "buffer"; buffer: ArrayBuffer }
  | { kind: "blob"; blob: Blob };

/** 与 `WallpaperOptions` 对应、但去掉函数与实例之后的版本。 */
export interface SerializedWorkerOptions {
  source?: SerializedSource;
  project?: Pick<ProjectBundleOptions, "baseUrl" | "manifestUrl" | "fetchOptions">;
  fit?: FitMode;
  pixelRatio?: number;
  clearColor?: [number, number, number];
  engineAssets?: string | EngineAssetsOptions;
  particles?: ParticleOptions;
  layers?: LayerFilter;
  maxLayerResolution?: number;
  textScale?: number;
  textureFormatOverrides?: Record<string, "bc1" | "bc2" | "bc3" | "rgba8" | "file">;
  disableEffects?: boolean;
  onlyLayers?: number[] | null;
  /** 是否转发指针坐标（缺省由场景的视差设置决定）。 */
  trackMouse?: boolean;
}

export interface WorkerArchiveInfo {
  magic: string;
  version: number;
  files: number;
}

export interface WorkerCapabilities {
  renderer: string;
  s3tc: boolean;
  maxTextureSize: number;
}

/** worker 按间隔（或按请求）回报的运行数据。 */
export interface WorkerStats {
  stats: LayerDrawStats[];
  /** 滑动窗口内的平均帧率。 */
  fps: number;
  /** 场景时钟（秒）。 */
  time: number;
  /** 累计绘制帧数：主线程被占用时它仍然在涨，就是 worker 渲染的意义。 */
  frames: number;
}

/** 粒子参数面板的数据（与 `describeLayerParticleParameters()` 的结构一致）。 */
export interface WorkerParticleParameters {
  layerId: number;
  name: string;
  systems: Array<{ path: string; parameters: ResolvedParticleParameter[] }>;
}

/** worker 侧「读取本机引擎资源」开关的实际结果。 */
export interface WorkerEngineAssets {
  cached: number;
  /** 找过但引擎里没有的文件数。 */
  missing: number;
  bytes: number;
  /** 真正读到的引擎文件路径。 */
  loaded: string[];
  missingFiles: string[];
}

/** worker 初始化完成后的自述。 */
export interface WorkerReadyMessage {
  type: "ready";
  summary: SceneSummary;
  layers: LayerDescription[];
  shaderErrors: string[];
  diagnostics: string[];
  archive?: WorkerArchiveInfo;
  capabilities: WorkerCapabilities;
  /** 场景是否需要指针视差（宿主据此决定要不要转发 pointermove）。 */
  trackMouse: boolean;
  /** 「读取本机引擎资源」开关的实际结果（关着或没探测到安装时为 undefined）。 */
  engineAssets?: WorkerEngineAssets;
  viewport: RendererViewport;
}

/** 宿主 -> worker。带 `id` 的消息会收到一条 `reply`。 */
export type HostMessage =
  | {
      type: "init";
      id: number;
      canvas: OffscreenCanvas;
      viewport: RendererViewport;
      options: SerializedWorkerOptions;
      driver: WorkerDriver;
      fps: number;
      statsIntervalMs: number;
    }
  | { type: "start"; id?: number }
  | { type: "stop"; id?: number }
  | { type: "renderFrame"; time: number; id?: number }
  | { type: "warmUp"; seconds: number; step?: number; id?: number }
  | { type: "layerVisible"; layer: number | string; visible: boolean; id?: number }
  | { type: "fit"; fit: FitMode; id?: number }
  | { type: "cameraParallax"; enabled: boolean; id?: number }
  | { type: "input"; mouse: [number, number] | null }
  | { type: "resize"; viewport: RendererViewport; id?: number }
  | { type: "stats"; id: number }
  | { type: "particleParameters"; layer: number | string; id: number }
  | { type: "flush"; id: number }
  | { type: "dispose"; id?: number };

/** worker -> 宿主。 */
export type WorkerMessage =
  | WorkerReadyMessage
  | { type: "stats"; stats: WorkerStats }
  | { type: "diagnostic"; message: string }
  | { type: "error"; message: string; fatal: boolean; id?: number }
  | { type: "reply"; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: "disposed" };

/** 判断一个对象是不是我们的宿主消息（worker 端用，避免处理无关消息）。 */
export function isHostMessage(value: unknown): value is HostMessage {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
