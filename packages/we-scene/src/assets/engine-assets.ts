/**
 * 可选的「读取本机 Wallpaper Engine 资源」开关。
 *
 * 场景包（`scene.pkg`）只包含作者自己放进来的资源；像 `particle/halo`、
 * `util/white`、`models/util/solidlayer.json` 这些**引擎内置资源**并不在包里，
 * 本库默认用程序化生成的近似替代。
 *
 * 如果运行环境能读到本机的 Wallpaper Engine 安装目录（浏览器里通常是把
 * `steamapps/common/wallpaper_engine/assets` 通过静态服务器暴露成一个 URL，
 * Node 里可以直接给目录路径），打开这个开关后，缺失的资源会优先使用引擎的
 * 真实文件，从而做到像素级一致。
 *
 * 本库**不包含也不分发**任何 Wallpaper Engine 资源，只读取用户本机的安装。
 */

export interface EngineAssetsOptions {
  /** 浏览器：资源的 HTTP 基地址，例如 `"/we-assets/"`（末尾斜杠可选）。 */
  baseUrl?: string;
  /** Node：`.../wallpaper_engine/assets` 的绝对路径。 */
  directory?: string;
  /** 传给 fetch 的额外选项（凭证、headers 等）。 */
  fetchOptions?: RequestInit;
  /** 非致命问题的回调。 */
  onDiagnostic?: (message: string) => void;
}

export interface EngineAssetStats {
  /** 已缓存的资源数量。 */
  cached: number;
  /** 请求过但引擎里没有的资源数量（会被记入负缓存，不重复请求）。 */
  missing: number;
  /** 已缓存的字节数。 */
  bytes: number;
}

/** Steam 上 Wallpaper Engine（appid 431960）的常见安装位置。 */
export const ENGINE_ASSET_CANDIDATES = [
  "C:\\Games\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "C:\\Program Files\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "D:\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\assets",
  "E:\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "E:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\assets"
];

/**
 * 引擎资源读取器：异步拉取、同步读取。
 *
 * 渲染是同步的（一个 requestAnimationFrame 里画完一帧），所以 JSON / 着色器这类
 * 必须在渲染前 `preload()` 进内存；贴图由 `TextureCache` 异步加载，可以按需拉取。
 */
export class EngineAssets {
  private readonly cache = new Map<string, Uint8Array>();
  private readonly missing = new Set<string>();
  private readonly pending = new Map<string, Promise<Uint8Array | undefined>>();
  private readonly baseUrl?: string;
  private readonly directory?: string;
  private readonly fetchOptions?: RequestInit;
  private readonly onDiagnostic?: (message: string) => void;
  private totalBytes = 0;

  constructor(options: EngineAssetsOptions) {
    if (!options.baseUrl && !options.directory) {
      throw new Error("EngineAssets needs either baseUrl (browser) or directory (node)");
    }
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/?$/, "/") : undefined;
    this.directory = options.directory;
    this.fetchOptions = options.fetchOptions;
    this.onDiagnostic = options.onDiagnostic;
  }

  get stats(): EngineAssetStats {
    return { cached: this.cache.size, missing: this.missing.size, bytes: this.totalBytes };
  }

  /**
   * 读取来源（baseUrl / directory）。把「引擎资源」开关转交给 worker 时，
   * 宿主用它把这个实例换成一个可以结构化克隆的选项对象。
   */
  get source(): { baseUrl?: string; directory?: string } {
    return { baseUrl: this.baseUrl, directory: this.directory };
  }

  /** 已缓存（或已确认不存在）的资源路径。 */
  list(): string[] {
    return [...this.cache.keys()];
  }

  /** 请求过、但引擎目录里不存在的资源路径（诊断用）。 */
  get missingAssets(): string[] {
    return [...this.missing];
  }

  /** 是否已经拿到过这个资源（同步，供渲染期间查询）。 */
  has(path: string): boolean {
    return this.cache.has(normalise(path));
  }

  /** 同步读取已缓存的资源；没预加载过就返回 undefined。 */
  get(path: string): Uint8Array | undefined {
    return this.cache.get(normalise(path));
  }

  getText(path: string): string | undefined {
    const bytes = this.get(path);
    return bytes ? new TextDecoder("utf-8").decode(bytes) : undefined;
  }

  getJSON<T = unknown>(path: string): T | undefined {
    const text = this.getText(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  /** 拉取一个资源并缓存；不存在时记入负缓存并返回 undefined。 */
  async load(path: string): Promise<Uint8Array | undefined> {
    const key = normalise(path);
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.missing.has(key)) return undefined;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const task = this.read(key)
      .then((bytes) => {
        this.pending.delete(key);
        if (bytes) {
          this.cache.set(key, bytes);
          this.totalBytes += bytes.byteLength;
        } else {
          this.missing.add(key);
        }
        return bytes;
      })
      .catch((error: unknown) => {
        this.pending.delete(key);
        this.missing.add(key);
        this.onDiagnostic?.(`engine asset "${key}" failed: ${(error as Error).message}`);
        return undefined;
      });
    this.pending.set(key, task);
    return task;
  }

  /** 批量预加载，返回命中 / 缺失数量。 */
  async preload(paths: Iterable<string>): Promise<{ loaded: number; missing: number }> {
    const unique = [...new Set([...paths].map(normalise))];
    const results = await Promise.all(unique.map((path) => this.load(path)));
    let loaded = 0;
    for (const result of results) if (result) loaded++;
    return { loaded, missing: unique.length - loaded };
  }

  /** 等待所有正在进行的请求结束。 */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending.values()]);
  }

  private async read(path: string): Promise<Uint8Array | undefined> {
    if (this.directory) return this.readFile(path);
    return this.readUrl(path);
  }

  private async readFile(path: string): Promise<Uint8Array | undefined> {
    const fs = await loadNodeFileSystem();
    if (!fs) return undefined;
    try {
      const contents = await fs.readFile(`${this.directory}/${path}`);
      return new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
    } catch {
      return undefined;
    }
  }

  private async readUrl(path: string): Promise<Uint8Array | undefined> {
    if (typeof fetch !== "function") return undefined;
    const response = await fetch(`${this.baseUrl}${path}`, this.fetchOptions);
    if (!response.ok) return undefined;
    return new Uint8Array(await response.arrayBuffer());
  }
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The library itself stays free of Node typings: the file system module is
 * imported through a variable specifier so bundlers for the browser never try
 * to resolve it, and only the (optional) node code path ever calls it.
 */
interface NodeFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}
declare const process: { versions?: { node?: string }; env?: Record<string, string | undefined> };
const NODE_FS_SPECIFIER = "node:fs/promises";
let nodeFileSystem: Promise<NodeFileSystem | undefined> | undefined;

function loadNodeFileSystem(): Promise<NodeFileSystem | undefined> {
  if (typeof process === "undefined" || !process.versions?.node) return Promise.resolve(undefined);
  nodeFileSystem ??= import(/* @vite-ignore */ NODE_FS_SPECIFIER).then(
    (module) => module as unknown as NodeFileSystem,
    () => undefined
  );
  return nodeFileSystem;
}

/**
 * Node 环境下探测本机的 Wallpaper Engine 安装目录。
 * 浏览器里没有文件系统访问，返回 undefined（改用 `baseUrl`）。
 */
export async function detectEngineAssetsDirectory(explicit?: string): Promise<string | undefined> {
  const fs = await loadNodeFileSystem();
  if (!fs) return undefined;
  const candidates = [explicit, typeof process === "undefined" ? undefined : process.env?.WE_ASSETS, ...ENGINE_ASSET_CANDIDATES].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // 继续找下一个候选路径。
    }
  }
  return undefined;
}

/**
 * 便捷入口：给定 URL、目录或已构造的实例，返回 `EngineAssets`；
 * 探测不到就返回 undefined（调用方按「开关关闭」处理）。
 */
export async function resolveEngineAssets(
  input?: EngineAssets | string | EngineAssetsOptions
): Promise<EngineAssets | undefined> {
  if (!input) return undefined;
  if (input instanceof EngineAssets) return input;
  if (typeof input === "string") {
    if (/^https?:|^\//.test(input)) return new EngineAssets({ baseUrl: input });
    const directory = await detectEngineAssetsDirectory(input);
    return directory ? new EngineAssets({ directory }) : undefined;
  }
  if (!input.baseUrl && !input.directory) {
    const directory = await detectEngineAssetsDirectory();
    return directory ? new EngineAssets({ ...input, directory }) : undefined;
  }
  return new EngineAssets(input);
}
