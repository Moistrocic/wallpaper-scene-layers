import { createWallpaper, type Wallpaper, type WallpaperOptions } from "../wallpaper.js";
import { createWorkerWallpaper, type WorkerWallpaper, type WorkerWallpaperOptions } from "../worker/host.js";

/**
 * **接口二：洛茜（Rossi）壁纸专用适配。**
 *
 * 它本身就是接口一（`createWallpaper`）加上一组固定参数——想微调就传同名参数覆盖即可：
 *
 * ```ts
 * const wallpaper = await createRossiWallpaper({ canvas, source: "scene.pkg" });
 * ```
 */
export interface RossiWallpaperOptions extends WallpaperOptions {
  /** 覆盖预设的图层筛选（默认只保留背景美术 + `灰烬大`）。 */
  layers?: WallpaperOptions["layers"];
  /** 覆盖预设的粒子参数（默认开启上浮漂移）。 */
  particles?: WallpaperOptions["particles"];
}

/**
 * 洛茜壁纸的适配参数。
 *
 * * **图层**：只保留最基本的图层（背景美术 `142584003_p0`）与粒子层 `灰烬大`；
 *   时钟文字、音频卡片、可视化条、`灰烬光束` 等都不加载。
 * * **粒子**：开启上浮漂移，上升 240、漂移 200、右移比例 0.7。
 */
export const ROSSI_WALLPAPER = {
  name: "洛茜 Rossi",
  layers: {
    include: ["142584003_p0", "灰烬大"]
  },
  particles: {
    drift: {
      rise: 240,
      speed: 200,
      forwardRatio: 0.7
    }
  }
} as const;

/** 接口二：加载洛茜壁纸（= 接口一 + 上面的预设参数）。 */
export function createRossiWallpaper(options: RossiWallpaperOptions): Promise<Wallpaper> {
  return createWallpaper(rossiOptions(options));
}

/** 接口二的 worker 版本：参数完全一致，只是渲染发生在 worker 里。 */
export interface RossiWorkerWallpaperOptions extends WorkerWallpaperOptions {
  layers?: WorkerWallpaperOptions["layers"];
  particles?: WorkerWallpaperOptions["particles"];
}

export function createRossiWorkerWallpaper(options: RossiWorkerWallpaperOptions): Promise<WorkerWallpaper> {
  return createWorkerWallpaper(rossiOptions(options));
}

/** 接口二 = 接口一 + 预设图层与预设漂移（同名参数可覆盖）。 */
function rossiOptions<T extends WallpaperOptions>(options: T): T {
  return {
    ...options,
    layers: options.layers ?? { include: [...ROSSI_WALLPAPER.layers.include] },
    particles: options.particles ?? {
      drift: { ...ROSSI_WALLPAPER.particles.drift }
    }
  };
}
