/**
 * 资源包抽象：`scene.pkg`（`PackageArchive`）与**工程目录**（`ProjectBundle`）都实现它，
 * 渲染器只依赖这个接口，因此同一套代码既能渲染打包好的壁纸，也能直接渲染
 * Wallpaper Engine 的工程目录（`scene.json` + `materials/` + `models/` + `shaders/`）。
 *
 * `get()` 是同步的——渲染一帧时不能 await；`load()` 是可选的异步入口，
 * 工程目录用它按需读取贴图（首次调用后进入缓存，后续同步可得）。
 */
export interface AssetBundle {
  /** 包内全部路径（相对包根，正斜杠分隔）。 */
  list(): string[];
  has(path: string): boolean;
  /** 同步读取；未预取过的资源返回 undefined。 */
  get(path: string): Uint8Array | undefined;
  getText(path: string): string | undefined;
  getJSON<T = unknown>(path: string): T | undefined;
  /** 可选的异步读取（工程目录 / 引擎资源用）。 */
  load?(path: string): Promise<Uint8Array | undefined>;
}

const utf8 = new TextDecoder("utf-8");

/** 把字节转成 JSON，容错（工程里偶尔有注释或 BOM）。 */
export function bundleText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return utf8.decode(bytes.subarray(3));
  }
  return utf8.decode(bytes);
}

export function parseBundleJSON<T>(bytes: Uint8Array | undefined): T | undefined {
  if (!bytes) return undefined;
  try {
    return JSON.parse(bundleText(bytes)) as T;
  } catch {
    return undefined;
  }
}
