# wallpaper-scene-layers

在浏览器里把 **Wallpaper Engine 场景壁纸**（`scene.pkg`）渲染成一个个独立、可单独控制的图层。

* 解析 `PKGV` 包容器、`scene.json`、模型、材质、特效、粒子预设与 `.tex` 纹理——不需要安装 Wallpaper Engine；
* 用 WebGL2 编译包内自带的 GLSL（引擎前置头文件已重新实现并内联）；
* 每个 object 都是图层，可在运行时查看、隐藏、隔离、重排：这是一个分层工具库，而不是黑盒播放器；
* 零依赖、纯 ESM，可用于打包器，也可直接 `<script type="module">` 引入。

> **本库主要适配洛茜壁纸**（[Steam 创意工坊 · 3691554683](https://steamcommunity.com/sharedfiles/filedetails/?id=3691554683)）：
> 接口二 `createRossiWallpaper` 直接给出图层与粒子预设（只保留背景美术 + `灰烬大`，漂移 240/200/0.7）。
> 仓库**不包含也不分发**任何壁纸素材与 Wallpaper Engine 引擎资源，只提供适配代码。

```
npm install wallpaper-scene-layers
```

本目录就是全部对外代码：`src/`（源码）、`bin/`（命令行）、`dist/`（构建产物，包的入口）。
仓库里的 `testbed/` 只是该库的一个使用者与测试环境，发布时不会包含。

## 快速开始

```html
<canvas id="wallpaper" style="width:100vw;height:100vh;display:block"></canvas>
<script type="module">
  import { createWallpaper } from "wallpaper-scene-layers";

  const wallpaper = await createWallpaper({
    canvas: document.getElementById("wallpaper"),
    source: "/wallpapers/scene.pkg",   // URL / File / Blob / ArrayBuffer / PackageArchive
    fit: "cover"
  });

  // 图层就是普通对象：id、name、type、transform、effects ...
  console.table(wallpaper.layers.map((l) => ({ id: l.id, name: l.name, type: l.type })));

  wallpaper.setLayerVisible(44, false);   // 隐藏灰烬粒子层
  wallpaper.stop();                        // 暂停渲染循环
  wallpaper.renderFrame(12);               // 或者渲染 t=12s 的单帧
</script>
```

## 两个接口

| 接口 | 用途 |
| --- | --- |
| **接口一** `createWallpaper(options)` | 通用加载：任何场景壁纸（`scene.pkg` / 未打包工程目录），参数全开放 |
| **接口二** `createRossiWallpaper(options)` | **洛茜（Rossi）壁纸专用**：等于接口一 + 预设参数，可传同名参数覆盖 |

```ts
import { createWallpaper, createRossiWallpaper, ROSSI_WALLPAPER } from "wallpaper-scene-layers";

// 接口一：普通加载
const generic = await createWallpaper({ canvas, source: "/wallpapers/rossi.pkg" });

// 接口二：洛茜专用（图层只留背景美术 + 灰烬大，粒子开启 240/200/0.7 的上浮漂移）
const rossi = await createRossiWallpaper({ canvas, source: "/wallpapers/rossi.pkg" });

console.log(ROSSI_WALLPAPER);
// {
//   name: "洛茜 Rossi",
//   layers:   { include: ["142584003_p0", "灰烬大"] },   // 最基本的图层 + 灰烬大
//   particles:{ drift: { rise: 240, speed: 200, forwardRatio: 0.7 } }
// }
```

接口二用到的两个通用能力（接口一同样可用）：

* `layers: { include: [...], exclude: [...] }` —— **按 id 或名称筛选图层**。被排除的图层
  连贴图都不会加载、着色器也不会编译（保留图层的祖先会自动保留，父子变换链不会断）；
* `particles.drift` —— 上浮漂移，`rise`（上升）/ `speed`（漂移）/ `forwardRatio`（向右比例）。

## 只取图层，不渲染

```ts
import { loadPackage, createSceneFromArchive, describeLayers } from "wallpaper-scene-layers";

const archive = await loadPackage("scene.pkg");
const scene = createSceneFromArchive(archive);

for (const layer of describeLayers(scene)) {
  console.log(layer.index, layer.id, layer.type, layer.asset, layer.parent);
}
```

`describeLayers` 返回扁平、可直接序列化的图层描述：

| 字段 | 含义 |
| --- | --- |
| `index` | 绘制顺序中的位置（0 = 最底层） |
| `id` / `name` / `type` | 类型为 `image` \| `text` \| `particle` \| `solid` \| `model` \| `unknown` |
| `parent` | 父图层 id（子图层会叠加父级变换） |
| `asset` | 该层引用的 `models/…json`、`particles/…json` 或字体 |
| `effects` | 该层挂载的特效定义路径 |
| `origin` / `size` / `scale` / `angles` | 场景单位下的摆放（场景空间 `0,0` 为左下角） |
| `alpha` / `color` / `visible` | 外观与场景内作者的可见性 |
| `visibilityProperty` | `visible` 绑定的 Wallpaper Engine 用户属性名 |

## 手动渲染

```ts
import { PackageArchive, createSceneFromArchive, SceneRenderer } from "wallpaper-scene-layers";

const archive = new PackageArchive(await (await fetch(url)).arrayBuffer());
const scene = createSceneFromArchive(archive);
const renderer = new SceneRenderer({ canvas, archive, scene, fit: "cover", pixelRatio: 1 });

await renderer.preload();           // 可选：先把纹理和字体传上去
renderer.render(0, { mouse: [0, 0] });
```

### `SceneRenderer`

| 成员 | 说明 |
| --- | --- |
| `layers` | 解析后的 `SceneLayer[]`，按绘制顺序排列 |
| `scene` | `SceneDocument`（相机、general 配置、资产查询） |
| `render(timeSeconds, input?)` | 渲染一帧；`input.mouse` 驱动相机视差 |
| `setLayerVisible(id \| name, visible)` | 显示 / 隐藏单个图层 |
| `isLayerVisible(id \| name)` | 查询当前状态 |
| `ready()` / `preload()` | 等待纹理上传完成 / 预加载全部资源 |
| `layerStats` | 上一帧每个图层的结果（`drawn`、`reason`、`particles`） |
| `shaderErrors` / `diagnostics` | 非致命问题（见「着色器兼容」） |
| `capabilities` | `s3tc`、`maxTextureSize`、渲染器字符串 |
| `dispose()` | 释放 GL 资源 |

构造选项：`fit`（`cover` \| `contain` \| `stretch`）、`pixelRatio`、`clearColor`、
`maxLayerResolution`、`textScale`、`disableEffects`、`onlyLayers`、`fixedTime`、
`onDiagnostic`、`textureFormatOverrides`。


## 把渲染放进 worker（不卡主线程）

`createWallpaper()` 的每一帧都在主线程上跑：解析包、解码贴图、编译着色器、粒子模拟、绘制。
壁纸一大就会和宿主自己的界面抢主线程。`createWorkerWallpaper()` 把**整条管线**搬进 worker：

* 主线程只做三件轻活：把画布 `transferControlToOffscreen()` 交出去、尺寸变化时转发一条消息、
  指针移动时转发坐标（最多每 8ms 合并一次）；
* worker 里完成下载、`scene.pkg` 解析、`.tex` 解码、着色器编译、粒子模拟与每一帧绘制；
* 帧循环由 worker 自己的定时器推动（`driver: "timer"`），所以**主线程被占用时壁纸照常播放**。

```ts
import { createWorkerWallpaper } from "wallpaper-scene-layers";

const wallpaper = await createWorkerWallpaper({ canvas, source: "scene.pkg" });
console.table(wallpaper.layers.map((l) => ({ id: l.id, name: l.name, type: l.type })));
wallpaper.setLayerVisible("灰烬光束", false);   // 消息发给 worker，下一帧生效
```

洛茜壁纸有对应的 `createRossiWorkerWallpaper()`（参数与 `createRossiWallpaper()` 完全一致）。

### 谁驱动帧循环

| `driver` | 谁出帧 | 适用 |
| --- | --- | --- |
| `"timer"`（默认） | worker 自己的定时器，按 `fps`（默认 60） | 壁纸播放：主线程卡住也不掉帧 |
| `"manual"` | 宿主调用 `renderFrame(t)` 时才画一帧 | 宿主已有自己的循环，或需要逐帧确定性 |

`warmUp(seconds)` 在 worker 里按 1/60 步长把场景推进到指定时刻（粒子、特效、文字都到位），
主线程只等一条消息——封面与截图用它，不必在主线程跑几百帧。页面切到后台时浏览器会限制定时器，
worker 的帧率也会跟着降；需要完全自己掌控节奏就用 `driver: "manual"`。

### 宿主侧 API

| 成员 | 说明 |
| --- | --- |
| `layers` / `summary` / `archiveInfo` / `capabilities` | worker 解析完回传的清单与概览（主线程没有 `SceneDocument`） |
| `shaderErrors` / `diagnostics` / `engineAssets` | 着色器提示、非致命问题、实际读到的引擎资源 |
| `start()` / `stop()` | 开始 / 停止帧循环（`timer` 模式） |
| `renderFrame(t)` | 渲染 t 秒这一帧 |
| `warmUp(seconds, step?)` | 在 worker 里推进到指定时刻 |
| `setLayerVisible(id \| name, visible)` | 显隐图层 |
| `setFit(fit)` / `setCameraParallax(on)` | 运行中改适配模式 / 视差 |
| `requestStats()` | 取一次 `{ stats, fps, time, frames }`；`statsIntervalMs > 0` 时也会自动推 |
| `particleParameters(id)` | 某个粒子图层展开后的参数表（参数面板用） |
| `flush()` / `ready()` | 等此前命令执行完 / 等初始化完成 |
| `resize()` / `on(listener)` / `dispose()` | 重新量尺寸 / 订阅 stats、diagnostic、error、disposed / 关掉 worker |

上面所有会改状态的方法都返回 Promise（`dispose()` 除外），消息按发送顺序执行。

### 环境与回退

* 需要 `OffscreenCanvas` 与 `transferControlToOffscreen()`（Chrome/Edge 69+、Firefox 105+、
  Safari 16.4+）。不支持时自动退回主线程渲染并给出一条 `onDiagnostic`，返回的对象形状不变
  （`offscreen: false`）；不想要回退就传 `fallbackToMainThread: false`。
* 除驱动相关的选项外，其余选项（`source` / `project` / `layers` / `particles` / `engineAssets` /
  `fit` / `clearColor` / `maxLayerResolution` / `textScale` / `textureFormatOverrides` …）都会转给
  worker。函数与类实例不能过 worker 边界，所以 `onDiagnostic` 留在主线程，由 worker 用消息转发；
  `EngineAssets` 实例会被换等价的 `baseUrl` / `directory` 选项。
* **一块画布的控制权只能交出去一次**。切换壁纸要换一块新的画布元素（测试环境的 `reload()` 就是
  这么做的），不能把同一块画布先后交给两个 worker。
* 打包器里可以自己构造 worker 再传进来：
  `worker: () => new Worker(new URL("wallpaper-scene-layers/worker", import.meta.url), { type: "module" })`；
  在自己的 worker 脚本里则 `import { startRenderWorker }` 之后调用它接管消息循环。

### 实测

同样输入下（用 `?layers=` 排除粒子层，避免随机性）worker 与主线程渲染**逐像素一致**：
1280×720 共 921600 像素，最大通道差值 0。主线程被占住 2 秒时：

| 渲染位置 | 这 2 秒内出的帧数 |
| --- | --- |
| 主线程 | 0 |
| worker | 66–68（≈34 fps，无头 Chrome + SwiftShader 软件渲染） |

粒子用的是 `Math.random()`，所以**含粒子层的截图每次都不会完全相同**（主线程连续两次也一样，
平均差值 9.1）；做像素级对比时请排除粒子层。

## 包与纹理格式

```ts
const archive = new PackageArchive(buffer);   // PKGV0001 … PKGV0024
archive.list();                               // 包内所有路径
archive.get("materials/142584003_p0.tex");    // Uint8Array 视图，零拷贝
archive.getJSON("scene.json");
```

`.tex` 由 `parseTex` / `decodeTexImage` 解码（`TEXV0005` + `TEXB0003`/`TEXB0004`）：

* 以 PNG/JPEG 文件形式存放的 mip 直接交给浏览器解码；
* **补齐到 2 次幂的贴图会裁回真实尺寸**：WE 把非 2 次幂的图补齐存储
  （`.tex-json` 里的 `nonpoweroftwo`），补齐尺寸记在 `textureWidth/Height`、真实尺寸记在
  `imageWidth/Height`（例如 `2048x2048` 的文件里只有 `1920x1080` 有内容）。不裁剪就会出现
  "只有左上角一块有内容、其余是空白"；
* LZ4 block 压缩的像素由 `lz4DecompressBlock` 展开；
* BC1/BC2/BC3（DXT1/3/5）在驱动支持 `WEBGL_compressed_texture_s3tc` 时按压缩纹理上传，
  否则用 `decodeBC1/2/3` 在 CPU 上解码。

## 着色器兼容

包内的 `.frag` / `.vert` 是桌面版 GLSL，引擎会带上自己的前置头文件编译。本库的处理顺序：

1. 内联重新实现的 `common.h`、`common_vertex.h`、`common_fragment.h`、
   `common_perspective.h`、`common_blending.h`、`common_blur.h`
   （见 `src/shaders/prelude.ts`）；
2. 为材质与场景用到的所有 combo 生成 `#define`；
3. **仅在编译失败时**才修复着色器：统一两个阶段声明宽度不同的 varying、把 `int` 声明放宽为
   `float`（桌面 GLSL 允许隐式转换，GLSL ES 不允许），最后把「变量下标索引数组」的着色器升级为
   `#version 300 es`。

每次修复都会记录到 `renderer.shaderErrors`，宿主可以据此区分「原样渲染」与「已打补丁」。
完全无法编译的特效会被跳过，图层本身照常渲染。

## 已实现

* 图像图层：材质、多 pass、纹理 / 遮罩纹理单元、混合模式、尺寸（图层 `size` → 模型
  `width/height` → 贴图尺寸三级回退）、裁剪偏移、父子变换、对齐方式；
* 纯色（solid）图层与不带几何体的分组图层；
* 文字图层：用 Canvas2D 配合包内嵌字体栅格化；
* 粒子图层：发射器、初始化器、算子、sprite 与 sprite-trail 渲染器、子发射器预设，CPU 模拟（见下节）；
* 特效链：FBO ping-pong、pass 级渲染目标、读取 `scene.json` 中的 `constantshadervalues`；
* 相机视差、正交投影与画面适配。

## 粒子系统

粒子在 CPU 上模拟，每帧生成三角形后一次绘制。已实现的部分：

| 类别 | 支持 |
| --- | --- |
| 发射器 emitter | `boxrandom` / `box`、`sphererandom` / `sphere` |
| 初始化器 initializer | `lifetimerandom`、`sizerandom`、`colorrandom`、`alpharandom`、`velocityrandom`、`turbulentvelocityrandom`、`rotationrandom`、`angularvelocityrandom`、`offsetrandom` |
| 算子 operator | `movement`、`alphafade`、`turbulence`、`oscillatealpha`、`oscillateposition`、`sizechange`、`angularmovement` |
| 渲染器 renderer | `sprite`、`spritetrail`（按速度拉伸的近似） |
| 子发射器 children | 每个父粒子镜像一个子粒子（灰烬 + 光晕就是这种用法） |

几个必须说明的实现选择，它们决定了粒子「会不会动」：

### 实现依据：对齐引擎自身的资源与数据

下面这些语义不是猜的，而是从本机安装的 Wallpaper Engine（`steamapps/common/wallpaper_engine`）
自带的资源里核对出来的：

| 结论 | 依据 |
| --- | --- |
| 精灵宽度 = `size`，**高度 = `size × 纹理高/宽`** | 引擎 `assets/shaders/genericparticle.vert` 的 `ComputeParticlePosition` |
| `spritetrail` 长度 = `clamp(速度 × length, minlength, maxlength)` | 同文件 `ComputeParticleTrailTangents` |
| `drag` 是**每秒衰减率**，可以大于 1（官方示例用到 4、10） | `assets/particles/exampleturbolence.json` 等 213 处 movement |
| `colorchange` / `alphachange` 的取值是 **0–1**，而 `colorrandom` 是 0–255 | 240 个官方预设的参数统计 |
| `halo` / `halo_4` 等内置贴图的衰减曲线与整体亮度 | 直接解码 `assets/materials/particle/*.tex` 采样得到 |

* **`turbulence` 是速度场，不是加速度。** 预设里 `speedmin/speedmax` 就是粒子的实际速度：
  算子用 curl noise（无散度噪声场）取方向，归一化后乘以该速度，再按 `mask` 分轴缩放。
  如果把它当成逐帧累加的加速度，方向会每帧翻转、净位移趋近于 0，粒子会全部堆在发射点。
* **透明度、尺寸各自累乘**（`基础 × 淡入淡出 × 闪烁 × 渐变`、`初始尺寸 × 尺寸变化 × 尺寸振荡`），
  否则后执行的算子会覆盖前一个（引擎更新日志里称之为 operator blending）。
* **每个粒子的随机量（闪烁频率、湍流相位与速度）在生成时抽取一次**，逐帧重抽会变成无规律乱闪。
* **内置粒子贴图**（`particle/halo*`、`particle/beam/*`、`util/*`）不在场景包里，由本库程序化生成，
  但**衰减曲线是按引擎贴图逐点采样后拟合的**（见 `HALO_PROFILES`），因此整体亮度与形状一致：
  例如 `particle/halo` 平均 alpha 0.152、`particle/halo_4` 只有 0.040。自己拍脑袋画一张渐变色块
  会让几十个加法混合的光晕把画面冲成一片白。

### 官方默认值表（写在源码里）

预设文件只写「与默认值不同」的字段，所以 `ember.json` 里 `turbulence` 不写 `scale` 时，
光看预设无法得知默认值。这些值已经**固化进源码** `src/render/particle-defaults.ts`，
每一项都标注出处，代码里通过 `numberDefault(组件, 属性)` / `vectorDefault(...)` 读取：

| 出处 | 含义 | 例子 |
| --- | --- | --- |
| `engine-preview` | 引擎自带的**组件预览工程** `assets/scenes/particleelementpreviews/<组件>/particles/new_particle_system.json` | `turbulence.scale=0.0025`、`turbulence.speedmin/max=200/250`、`lifetimerandom.min/max=1/5`、`sizerandom.min/max/exponent=20/350/2`、`sphererandom.rate=150` |
| `engine-content` | 引擎自带的 240 个粒子预设 + 6 个官方示例中，该属性取值唯一或占绝大多数 | `alpharandom.exponent=2`、`colorrandom.exponent=1`、`movement.gravity="0 0 0"`、`turbulence.phasemax=50`、`alphafade.fadeintime/fadeouttime=0.1/0.9` |
| `runtime-inferred` | 前两者都没覆盖到（多为「省略即 0 / 关闭」的时间参数），保持库内行为并显式标注 | `turbulence.mask="1 1 1"`、`spritetrail.minlength=0`、`sizechange.endtime=1` |

查看完整表格：

```bash
we-scene --particle-defaults                # 命令行（不需要 scene.pkg）
```

```ts
import { describeParticleDefaults, describeParticleParameters, describeLayerParticleParameters } from "wallpaper-scene-layers";

console.table(describeParticleDefaults());                 // 整张默认值表：属性 / 取值 / 出处
console.table(describeLayerParticleParameters(scene, 52)); // 某个粒子层展开后的最终参数
```

`describeParticleParameters(json)` 接受一个 `particles/presets/*.json`，返回每个属性的
**最终取值与来源**：预设里写明的标为 `origin: "preset"`，省略的按默认值补齐并带上出处
（`engine-preview` / `engine-content` / `runtime-inferred`）；测试环境的图层参数面板就是用它渲染的。

唯一仍然只能推断的是 `timescale` 到噪声时钟的映射系数——引擎文档未公开该语义，
本库用 `× 0.02`（`timescale: 50` ≈ 每秒演化一次）。它可以在构造时覆盖：

```ts
new SceneRenderer({ canvas, archive, scene, particles: { turbulenceTimeFactor: 0.02 } });
```

顺带一提，官方默认值也让两处行为更贴近引擎：`alphafade` 默认 `0.1 / 0.9`（此前是 0/0，
即省略 `fadeouttime` 的预设不会淡出），`sizechange` 的起止值按官方取值给出。

### 覆盖率与验证

`npm run presets` 会扫描本机引擎自带的 **240 个粒子预设**，逐个解析、模拟 6 秒并生成顶点：

* 解析 / 模拟失败：**0**；
* 发射器 2/2、渲染器 2/4（`rope` / `ropetrail` 是 3D 绳索渲染器，按 sprite 近似）；
* 初始化器 10/13、算子 14/19 —— 未实现的都是控制点 / 群体行为类
  （`mapsequence*`、`maintaindistance*`、`reducemovementnearcontrolpoint`、`remap*`、`boids`），
  会通过 `renderer.diagnostics` 报告，不影响其它图层。

示例场景（灰烬粒子）12 秒后的实测：父系统 34 个粒子、散布约 3200×1200 场景单位、平均速度 385 单位/秒；
光束系统 22 个粒子、平均速度 458 单位/秒。`npm run verify` 会把「粒子是否真的产生位移」作为回归项。

## 多次创建 / 销毁渲染器

每个渲染器持有自己的 WebGL2 **VAO**。顶点属性状态在 GL 里是全局的：同一个 canvas 上先
`dispose()` 再建下一个渲染器（宿主切换壁纸就是这种用法）时，前者删除顶点缓冲后，
它遗留的 enabled 属性会让后续所有 `drawArrays` 报 `INVALID_OPERATION`——画面只剩清除色。
用 VAO 隔离后互不影响，销毁时一并删除。宿主按 `dispose()` → `createWallpaper()` 顺序调用即可。

## 渲染未打包的工程目录

除了 `scene.pkg`，也可以直接渲染 Wallpaper Engine **工程目录**（编辑器里的工程，
`scene.json` + `materials/` + `models/` + `shaders/`）：

```ts
// Node：直接给目录
await createWallpaper({ canvas, project: { directory: "C:\\path\\to\\project" } });

// 浏览器：把目录通过静态服务器暴露，并提供一份文件清单
//   清单响应为 string[] 或 { files: string[] }
await createWallpaper({
  canvas,
  project: { baseUrl: "/projects/deep-space/", manifestUrl: "/api/files?dir=projects/deep-space" }
});
```

`ProjectBundle` 也可以单独使用：`await ProjectBundle.open(options)` → `preloadSyncAssets()`
（把 JSON 与着色器源码读进内存，因为渲染是同步的）→ 贴图按需 `load()`。测试环境里的
`?project=` 参数就是这条路径。

和 pkg 的差异只在于"资源从哪里来"：两者都实现 `AssetBundle`，渲染器只依赖这个接口
（`list/has/get/getText/getJSON` + 可选的异步 `load`）。

## 可选：读取本机引擎资源

场景包只包含作者放进来的资源；像 `particle/halo`、`util/white`、`models/util/solidlayer.json`
这些**引擎内置资源**并不在包里，本库默认用程序化近似（近似程度见上一节：亮度误差 0.4%–8%）。
如果运行环境能读到本机的 Wallpaper Engine 安装目录，打开这个开关就会改用**引擎的真实文件**，
做到完全一致。本库**不包含也不分发**任何 Wallpaper Engine 资源，只读用户本机已安装的内容。

```ts
// 浏览器：把 <安装目录>/assets 通过静态服务器暴露成一个 URL
const wallpaper = await createWallpaper({
  canvas,
  source: "scene.pkg",
  engineAssets: "/we-assets/"
});

// Node：直接给目录，或让它自己探测常见 Steam 路径（也可用 WE_ASSETS 环境变量）
const wallpaper = await createWallpaper({ canvas, source, engineAssets: "C:\\Games\\Steam\\steamapps\\common\\wallpaper_engine\\assets" });
const wallpaper = await createWallpaper({ canvas, source, engineAssets: {} });   // 自动探测
```

`SceneRenderer` 的同名选项也接受一个已经构造好的 `EngineAssets` 实例（例如你想复用它、
或想自己控制 fetch 选项）。加载会在 `preload()` / `ready()` 时完成；即使宿主从不调用它们，
第一次 `render()` 也会自动补上（贴图请求会等待水合完成，不会固化回退结果）。

会从引擎读取的内容：

| 类别 | 说明 |
| --- | --- |
| 贴图 | `materials/**/*.tex`：`particle/halo*`、`particle/beam/*`、`util/*` 等（含 TEXB0001/0002 旧格式） |
| 材质与模型 | `materials/util/solidlayer*.json`、`models/util/*.json` 等内置资源 |
| 粒子预设 | `particles/presets/*.json`（子发射器引用到的那些） |
| 着色器头文件 | 真实的 `shaders/common*.h`；如果某个着色器用它们编译失败，会自动退回本库内置的等价实现并在 `shaderErrors` 里说明 |

诊断接口：

| 成员 | 说明 |
| --- | --- |
| `renderer.engineAssetStats` | `{ cached, missing, bytes }` |
| `renderer.loadedEngineAssets` | 实际读取过的引擎文件路径 |
| `renderer.missingEngineAssets` | 找过但引擎里没有的路径 |
| `engineAssetDependencies(scene)` | 场景需要、包里没有的资源清单（不联网即可得到） |

命令行可以直接看到需要哪些引擎资源：

```bash
we-scene scene.pkg --engine-deps
# 引擎内置资源依赖（15 个，包里没有）:
#   materials/particle/halo.tex
#   materials/util/white.tex
#   shaders/common.h
#   ...
```

### 上浮 / 定向漂移（`particles.drift`）

引擎的 `turbulence` 是各向同性的噪声速度场，本身没有方向偏好：默认语义下示例场景
15 个粒子向右、16 个向左、只有一半在上升。壁纸里常见的"灰烬整体往上飘、多数被吹向
一侧、少量反向"是**取向需求**，因此本库提供显式模型：

```ts
await createWallpaper({
  canvas,
  source: "scene.pkg",
  particles: { drift: true }                 // 整体上升 + 80% 向右、20% 向左
});

// 或自己给参数（对象引用会被保留，运行中改字段即可实时生效，适合做调参界面）
const particles = { drift: { rise: 120, speed: 200, forwardRatio: 0.8, spread: 0.6, turbulence: 0.15 } };
await createWallpaper({ canvas, source, particles });
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `rise` | 120 | 竖直基础速度（正数 = 从下往上，场景单位/秒） |
| `speed` | 200 | 主方向水平速度 |
| `forwardRatio` | 0.8 | 沿主方向的粒子比例，其余取反方向（**竖直方向不翻转**，所以反向粒子同样在上升） |
| `spread` | 0.6 | 主方向角度抖动（弧度），避免整齐划一 |
| `useEmitterDirection` | true | 用发射器的 `directions` 作为主方向（示例场景是 `"1 0.1 0"`，即向右略偏上） |
| `turbulence` | 0.15 | 开启漂移后湍流扰动的权重（预设的湍流速度远大于漂移速度，不压制就会抹平趋势） |

开启前后的实测（示例场景灰烬层，模拟 14 秒）：

| | 向右 | 向左 | 上升 | 平均速度 |
| --- | --- | --- | --- | --- |
| 引擎语义（`drift` 未设置） | 15 | 16 | 15/35 | (4, −36) |
| `drift: true` | **28** | **11** | **37/39** | (74, 130) |

## 已知限制

* **不执行 SceneScript。** 绑定到脚本的字段使用 `scene.json` 中保存的值，因此脚本时钟、
  音频可视化和媒体卡片会停留在作者编辑时的状态；需要动起来时，请直接改写图层对象上的字段。
* 粒子：控制点 / 群体行为类算子（`mapsequence*`、`maintaindistance*`、`remap*`、`boids`）未实现，
  `rope` / `ropetrail` 渲染器按 sprite 近似；未支持的组件名会通过 `renderer.diagnostics` 报告，
  不会让整个图层失效。粒子不会与场景其它部分做深度排序。
* 未实现视频纹理、骨骼 / 木偶动画。
* `locktransforms` 按「忽略相机视差」处理；相机有动画的场景会以静态姿态渲染。

## 命令行

包内自带一个检查 / 导出工具（`bin/we-scene.mjs`，仅 Node 端使用）：

```bash
# 打印包信息与图层清单
npx we-scene fixtures/scene-we-1/scene.pkg

# 图层清单写成 JSON（id / 名称 / 类型 / 父级 / 资产 / 变换 / 特效）
npx we-scene scene.pkg --json build/layers.json

# 解包全部文件，并把 .tex 解码成 .png
npx we-scene scene.pkg --out build/extracted --tex
```

## 开发

```bash
npm run build       # tsc -p packages/we-scene -> dist/（ESM + .d.ts）
npm run typecheck   # 只做类型检查
npm run testbed     # 启动测试环境（需要先 build）
npm run verify      # Node 端校验：包解析 / 场景图 / 纹理解码 / 引用完整性 / 粒子位移
npm run presets     # 扫描本机引擎自带的 240 个粒子预设，报告兼容性与组件覆盖率
# 测试环境的 /we-assets/ 路由会只读代理本机引擎 assets 目录，页面上的「引擎资源」开关即用它
npm run snapshot -- "http://127.0.0.1:5180/testbed/web/?snapshot=1&time=14" build/shot.png
```

测试环境与被测代码的分工见 [`../../testbed/README.md`](../../testbed/README.md)。

## 许可

[MIT](LICENSE) © Moistrocic
