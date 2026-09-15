import { bundleText, parseBundleJSON, type AssetBundle } from "./bundle.js";

export interface ProjectBundleOptions {
  /** 浏览器：工程目录的 HTTP 基地址，例如 `"../../fixtures/scene-we-2/"`。 */
  baseUrl?: string;
  /** Node：工程目录的绝对路径。 */
  directory?: string;
  /** 文件清单（相对工程根）。给了就不用去问服务端要清单。 */
  files?: string[];
  /**
   * 浏览器：返回文件清单的地址，响应为 `string[]` 或 `{ files: string[] }`。
   * 省略时按 `${baseUrl}__files.json` 取。
   */
  manifestUrl?: string;
  fetchOptions?: RequestInit;
  onDiagnostic?: (message: string) => void;
}

/**
 * 把一个 Wallpaper Engine **工程目录**当成资源包。
 *
 * 工程目录（编辑器里的工程，不是 `scene.pkg`）长这样：
 *
 * ```
 * scene.json  project.json  preview.jpg
 * materials/*.json  materials/*.tex  materials/*.tex-json
 * models/*.json
 * shaders/*.frag  shaders/*.vert  shaders/blobsSM40/*.dxs
 * ```
 *
 * JSON / 着色器源码必须在渲染前预取（渲染是同步的），贴图按需异步读取。
 */
export class ProjectBundle implements AssetBundle {
  private readonly cache = new Map<string, Uint8Array>();
  private readonly index = new Set<string>();
  private readonly baseUrl?: string;
  private readonly directory?: string;
  private readonly fetchOptions?: RequestInit;
  private readonly onDiagnostic?: (message: string) => void;
  private readonly pending = new Map<string, Promise<Uint8Array | undefined>>();

  private constructor(options: ProjectBundleOptions, files: string[]) {
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/?$/, "/") : undefined;
    this.directory = options.directory;
    this.fetchOptions = options.fetchOptions;
    this.onDiagnostic = options.onDiagnostic;
    for (const file of files) {
      const normalised = normalisePath(file);
      if (normalised) this.index.add(normalised);
    }
  }

  /** 打开一个工程目录：读清单 → 构造 bundle（不预取内容）。 */
  static async open(options: ProjectBundleOptions): Promise<ProjectBundle> {
    const files = options.files ?? (await ProjectBundle.readManifest(options));
    return new ProjectBundle(options, files);
  }

  private static async readManifest(options: ProjectBundleOptions): Promise<string[]> {
    if (options.directory) {
      const fs = await loadNodeFileSystem();
      if (!fs) throw new Error("ProjectBundle: node 环境缺少 fs");
      const files: string[] = [];
      const root = options.directory.replace(/[\\/]+$/, "");
      const walk = async (relative: string) => {
        const entries = await fs.readdir(relative ? `${root}/${relative}` : root, { withFileTypes: true });
        for (const entry of entries) {
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(child);
          else files.push(child);
        }
      };
      await walk("");
      return files;
    }
    if (!options.baseUrl) throw new Error("ProjectBundle: 需要 baseUrl 或 directory");
    const manifestUrl = options.manifestUrl ?? `${options.baseUrl}__files.json`;
    const response = await fetch(manifestUrl, options.fetchOptions);
    if (!response.ok) throw new Error(`ProjectBundle: 无法读取文件清单 ${manifestUrl} (${response.status})`);
    const payload = (await response.json()) as unknown;
    if (Array.isArray(payload)) return payload.filter((entry): entry is string => typeof entry === "string");
    const files = (payload as { files?: unknown }).files;
    if (Array.isArray(files)) return files.filter((entry): entry is string => typeof entry === "string");
    throw new Error("ProjectBundle: 文件清单格式不支持（应为 string[] 或 { files: string[] }）");
  }

  list(): string[] {
    return [...this.index];
  }

  has(path: string): boolean {
    return this.index.has(normalisePath(path));
  }

  get(path: string): Uint8Array | undefined {
    return this.cache.get(normalisePath(path));
  }

  getText(path: string): string | undefined {
    const bytes = this.get(path);
    return bytes ? bundleText(bytes) : undefined;
  }

  getJSON<T = unknown>(path: string): T | undefined {
    return parseBundleJSON<T>(this.get(path));
  }

  /** 异步读取（贴图等大文件），结果会缓存，之后 `get()` 同步可得。 */
  async load(path: string): Promise<Uint8Array | undefined> {
    const key = normalisePath(path);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const task = this.read(key)
      .then((bytes) => {
        this.pending.delete(key);
        if (bytes) this.cache.set(key, bytes);
        else this.onDiagnostic?.(`project file "${key}" is missing`);
        return bytes;
      })
      .catch((error: unknown) => {
        this.pending.delete(key);
        this.onDiagnostic?.(`project file "${key}" failed: ${(error as Error).message}`);
        return undefined;
      });
    this.pending.set(key, task);
    return task;
  }

  /**
   * 预取渲染期间需要**同步**读取的文件：所有 JSON（场景/材质/模型/特效）与着色器源码。
   * 贴图不在这里读，交给 `load()` 按需加载。
   */
  async preloadSyncAssets(): Promise<{ loaded: number; missing: number }> {
    const wanted = this.list().filter((path) => /\.(json|frag|vert)$/i.test(path) && !path.includes(".tex-json"));
    const results = await Promise.all(wanted.map((path) => this.load(path)));
    let loaded = 0;
    for (const result of results) if (result) loaded++;
    return { loaded, missing: wanted.length - loaded };
  }

  get stats(): { files: number; cached: number } {
    return { files: this.index.size, cached: this.cache.size };
  }

  private async read(path: string): Promise<Uint8Array | undefined> {
    if (this.directory) {
      const fs = await loadNodeFileSystem();
      if (!fs) return undefined;
      try {
        const contents = await fs.readFile(`${this.directory}/${path}`);
        return new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
      } catch {
        return undefined;
      }
    }
    if (!this.baseUrl) return undefined;
    const response = await fetch(`${this.baseUrl}${path}`, this.fetchOptions);
    if (!response.ok) return undefined;
    return new Uint8Array(await response.arrayBuffer());
  }
}

function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

interface NodeFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean }>>;
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
