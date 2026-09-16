/**
 * 渲染 worker 的入口。
 *
 * 两种用法：
 *
 * 1. **直接当 module worker 用**——本模块在被 worker 载入时会自动接管：
 *
 *    new Worker(new URL("wallpaper-scene-layers/worker/render-worker", import.meta.url), { type: "module" })
 *
 * 2. **在自己的 worker 脚本里手动接管**——`import { startRenderWorker } from "wallpaper-scene-layers"`
 *    之后调用 `startRenderWorker()`（默认作用于 `globalThis`），可以自己决定消息路由。
 *
 * worker 里没有 DOM：画布是宿主 `transferControlToOffscreen()` 过来的 OffscreenCanvas，
 * 贴图解码、着色器编译、粒子模拟、文字栅格化全都在这一侧完成。
 */
import { PackageArchive } from "../pkg/archive.js";
import { ProjectBundle } from "../assets/project.js";
import { SceneRenderer } from "../render/renderer.js";
import { createSceneFromArchive, createSceneFromBundle } from "../scene/document.js";
import { describeLayerParticleParameters, describeLayers, summariseScene } from "../scene/inspect.js";
import { applyLayerFilter, loadPackage, type WallpaperSource } from "../wallpaper.js";
import {
  isHostMessage,
  type HostMessage,
  type SerializedSource,
  type WorkerDriver,
  type WorkerMessage,
  type WorkerParticleParameters,
  type WorkerReadyMessage,
  type WorkerStats
} from "./protocol.js";

/**
 * worker 全局对象上用到的那一小部分 API。
 *
 * 库里不引入 WebWorker 类型库（会和 DOM 冲突），所以这里按结构声明；
 * 浏览器里的 DedicatedWorkerGlobalScope、SharedWorkerGlobalScope 都满足它。
 */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close?(): void;
}

type InitMessage = Extract<HostMessage, { type: "init" }>;

const DEFAULT_FPS = 60;
const MAX_QUEUED = 64;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** 把宿主序列化过的来源还原成 loadPackage 能吃的东西。 */
function deserializeSource(source: SerializedSource | undefined): WallpaperSource {
  if (!source) throw new Error("render worker 需要 source（scene.pkg）或 project（工程目录）");
  if (source.kind === "url") return source.url;
  if (source.kind === "blob") return source.blob;
  return source.buffer;
}

/** 一个已经加载好的壁纸会话：渲染器 + 帧循环 + 统计。 */
class RenderSession {
  private driver: WorkerDriver = "timer";
  private fps = DEFAULT_FPS;
  private statsIntervalMs = 0;
  private running = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frames = 0;
  private clock = 0;
  private startedAt = 0;
  private lastFrameAt = 0;
  private lastStatsAt = 0;
  private idleDrawScheduled = false;
  private readonly frameTimes: number[] = [];
  private mouse: [number, number] | undefined;

  constructor(
    private readonly scope: WorkerScope,
    private readonly renderer: SceneRenderer,
    private readonly post: (message: WorkerMessage) => void
  ) {}

  configure(options: { driver: WorkerDriver; fps: number; statsIntervalMs: number }): void {
    this.driver = options.driver;
    this.fps = options.fps > 0 ? options.fps : DEFAULT_FPS;
    this.statsIntervalMs = Math.max(0, options.statsIntervalMs);
  }

  get isRunning(): boolean {
    return this.running;
  }

  stats(): WorkerStats {
    const total = this.frameTimes.reduce((sum, value) => sum + value, 0);
    const average = this.frameTimes.length ? total / this.frameTimes.length : 0;
    return {
      stats: this.renderer.layerStats,
      fps: average > 0 ? Math.round((1000 / average) * 10) / 10 : 0,
      time: this.clock,
      frames: this.frames
    };
  }

  handle(message: HostMessage): void {
    try {
      switch (message.type) {
        case "start":
          this.start();
          this.reply(message);
          break;
        case "stop":
          this.stop();
          this.reply(message);
          break;
        case "renderFrame":
          this.renderAt(message.time);
          this.reply(message);
          break;
        case "warmUp":
          void this.warmUp(message.seconds, message.step).then(
            () => this.reply(message),
            (error: unknown) => this.fail(message, error)
          );
          break;
        case "layerVisible":
          this.renderer.setLayerVisible(message.layer, message.visible);
          this.drawIfIdle();
          this.reply(message);
          break;
        case "fit":
          this.renderer.setFit(message.fit);
          this.drawIfIdle();
          this.reply(message);
          break;
        case "cameraParallax":
          this.renderer.scene.general.cameraParallax = message.enabled;
          this.drawIfIdle();
          this.reply(message);
          break;
        case "input":
          this.mouse = message.mouse ?? undefined;
          break;
        case "resize":
          this.renderer.setViewport(message.viewport);
          this.drawIfIdle();
          this.reply(message);
          break;
        case "stats":
          // 直接把数据放在 reply 里，宿主 requestStats() 拿到的就是它。
          this.reply(message, this.stats());
          break;
        case "particleParameters": {
          const resolved = resolveParticleParameters(this.renderer, message.layer);
          this.post({ type: "reply", id: message.id, ok: true, value: resolved });
          break;
        }
        case "flush":
          this.reply(message);
          break;
        case "dispose":
          this.reply(message);
          this.dispose();
          break;
        case "init":
          break;
      }
    } catch (error) {
      this.fail(message, error);
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    try {
      this.renderer.dispose();
    } catch {
      // 关掉 context 时驱动可能已经失效，忽略。
    }
    this.post({ type: "disposed" });
    this.scope.close?.();
  }

  private start(): void {
    if (this.running || this.closed) return;
    this.running = true;
    // 从当前时钟继续，renderFrame(t) 之后 start() 不会跳回 0。
    this.startedAt = now() - this.clock * 1000;
    this.lastFrameAt = 0;
    if (this.driver === "timer") this.schedule();
    else this.draw(now());
  }

  private stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (!this.running || this.closed) return;
    const interval = 1000 / Math.max(1, this.fps);
    const delay = Math.max(0, interval - (now() - this.lastFrameAt));
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    if (!this.running || this.closed) return;
    this.clock = (now() - this.startedAt) / 1000;
    this.draw(now());
    this.schedule();
  }

  /** 单帧渲染（宿主给时刻）。 */
  private renderAt(time: number): void {
    this.clock = time;
    this.startedAt = now() - time * 1000;
    this.draw(now());
  }

  /**
   * 状态变更后补一帧；timer 驱动时下一帧自然会带上新状态，不必重复画。
   * 一串消息（比如宿主连续 setLayerVisible）只会合并成一次补画。
   */
  private drawIfIdle(): void {
    if (this.running || this.closed || this.idleDrawScheduled) return;
    this.idleDrawScheduled = true;
    setTimeout(() => {
      this.idleDrawScheduled = false;
      if (!this.running && !this.closed) this.draw(now());
    }, 0);
  }

  private draw(timestamp: number): void {
    if (this.closed) return;
    this.renderer.render(this.clock, { mouse: this.mouse });
    this.frames++;
    if (this.lastFrameAt > 0) {
      this.frameTimes.push(timestamp - this.lastFrameAt);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
    }
    this.lastFrameAt = timestamp;
    if (this.statsIntervalMs > 0 && timestamp - this.lastStatsAt >= this.statsIntervalMs) {
      this.lastStatsAt = timestamp;
      this.post({ type: "stats", stats: this.stats() });
    }
  }

  /**
   * 预热：按固定步长把场景推进到某一时刻，让发射器、特效与文字都进入稳定状态。
   * 整个过程留在 worker 里，主线程只等一条消息（截图与封面就靠它）。
   */
  private async warmUp(seconds: number, step?: number): Promise<void> {
    const stride = step && step > 0 ? step : 1 / 60;
    let count = 0;
    for (let time = 0; time <= seconds; time += stride) {
      this.renderer.render(time, { mouse: this.mouse });
      count++;
      // 周期性让出事件循环：贴图与字体是在这期间完成上传的。
      if (count % 30 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.clock = seconds;
    this.startedAt = now() - seconds * 1000;
    this.renderer.render(seconds, { mouse: this.mouse });
    await this.renderer.ready();
    this.renderer.render(seconds, { mouse: this.mouse });
    this.frames += count + 2;
    this.lastFrameAt = now();
  }

  private reply(message: HostMessage, value?: unknown): void {
    const id = (message as { id?: number }).id;
    if (id !== undefined) this.post({ type: "reply", id, ok: true, value });
  }

  private fail(message: HostMessage, error: unknown): void {
    const id = (message as { id?: number }).id;
    const text = error instanceof Error ? error.message : String(error);
    this.post({ type: "reply", id: id ?? -1, ok: false, error: text });
    this.post({ type: "diagnostic", message: text });
  }
}

function resolveParticleParameters(renderer: SceneRenderer, layer: number | string): WorkerParticleParameters | undefined {
  const target = typeof layer === "number" ? renderer.scene.getLayer(layer) : renderer.scene.layers.find((candidate) => candidate.name === layer);
  if (!target) return undefined;
  return describeLayerParticleParameters(renderer.scene, target.id);
}

/** 把一条 init 消息变成一个可用的会话（加载、解析、编译、预热首帧）。 */
async function createSession(scope: WorkerScope, message: InitMessage, post: (message: WorkerMessage) => void): Promise<RenderSession> {
  const options = message.options;
  const report = (text: string) => post({ type: "diagnostic", message: text });

  let archive: PackageArchive | undefined;
  let bundle: ProjectBundle | undefined;
  if (options.project) {
    bundle = await ProjectBundle.open(options.project);
    // 渲染是同步的：JSON 与着色器源码必须先落到内存里。
    await bundle.preloadSyncAssets();
  } else {
    archive = await loadPackage(deserializeSource(options.source));
  }
  const scene = archive ? createSceneFromArchive(archive) : createSceneFromBundle(bundle!);
  if (options.layers) applyLayerFilter(scene, options.layers);

  const renderer = new SceneRenderer({
    canvas: message.canvas,
    archive,
    bundle: bundle ?? archive,
    scene,
    fit: options.fit,
    pixelRatio: options.pixelRatio,
    viewport: message.viewport,
    clearColor: options.clearColor,
    engineAssets: options.engineAssets,
    particles: options.particles,
    maxLayerResolution: options.maxLayerResolution,
    textScale: options.textScale,
    textureFormatOverrides: options.textureFormatOverrides,
    disableEffects: options.disableEffects,
    onlyLayers: options.onlyLayers,
    onDiagnostic: report
  });
  await renderer.preload();
  await renderer.ready();
  // 刻意不在这里先画一帧：多出来的那次粒子更新会让截图与主线程路径对不上，
  // 首帧交给宿主的 renderFrame() / warmUp() / timer 循环。

  const ready: WorkerReadyMessage = {
    type: "ready",
    summary: summariseScene(scene),
    layers: describeLayers(scene),
    shaderErrors: [...renderer.shaderErrors],
    diagnostics: [...renderer.diagnostics],
    archive: archive ? { magic: archive.magic, version: archive.version, files: archive.list().length } : undefined,
    capabilities: { s3tc: renderer.capabilities.s3tc, maxTextureSize: renderer.capabilities.maxTextureSize, renderer: renderer.capabilities.renderer },
    trackMouse: options.trackMouse ?? scene.general.cameraParallax,
    engineAssets: renderer.engineAssetStats
      ? {
          cached: renderer.engineAssetStats.cached,
          missing: renderer.engineAssetStats.missing,
          bytes: renderer.engineAssetStats.bytes,
          loaded: renderer.loadedEngineAssets,
          missingFiles: renderer.missingEngineAssets
        }
      : undefined,
    viewport: renderer.viewportSize
  };
  post(ready);

  const session = new RenderSession(scope, renderer, post);
  session.configure({ driver: message.driver, fps: message.fps, statsIntervalMs: message.statsIntervalMs });
  return session;
}

/** 当前全局对象是不是一个 worker（不是窗口、也不是 Node）。 */
export function isWorkerScope(scope: unknown = globalThis): boolean {
  const candidate = scope as { postMessage?: unknown; addEventListener?: unknown; document?: unknown; window?: unknown } | undefined;
  if (!candidate) return false;
  return (
    typeof candidate.postMessage === "function" &&
    typeof candidate.addEventListener === "function" &&
    candidate.document === undefined &&
    candidate.window === undefined
  );
}

/**
 * 在当前 worker 里接管消息循环。可以重复调用（第二次起是空操作）。
 */
let started = false;
export function startRenderWorker(scope: WorkerScope = globalThis as unknown as WorkerScope): void {
  if (started) return;
  started = true;

  const post = (message: WorkerMessage) => scope.postMessage(message);
  const queue: HostMessage[] = [];
  let session: RenderSession | undefined;
  let initializing = false;

  scope.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isHostMessage(data)) return;
    const message = data as HostMessage;

    if (message.type === "init") {
      if (session || initializing) {
        post({ type: "error", fatal: true, id: message.id, message: "render worker 已经初始化过了" });
        return;
      }
      initializing = true;
      void createSession(scope, message, post)
        .then((created) => {
          session = created;
          for (const queued of queue.splice(0, queue.length)) if (queued.type !== "init") created.handle(queued);
          post({ type: "reply", id: message.id, ok: true });
        })
        .catch((error: unknown) => {
          initializing = false;
          post({ type: "error", fatal: true, id: message.id, message: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    // init 还没跑完就到的命令先排队（宿主正常会等 ready，这里只是兜底）。
    if (!session) {
      if (queue.length < MAX_QUEUED) queue.push(message);
      return;
    }
    session.handle(message);
  });
}

// 被 worker 直接载入（new Worker(url, { type: "module" })）时自动接管。
if (isWorkerScope()) startRenderWorker();
