# testbed — 测试与演示环境

这里的代码**不对外发布**，只用于验证 `packages/we-scene`（`@web-we-scene/runtime`）。
库本身的代码全部在 `packages/we-scene/`，两者不互相依赖：测试环境通过
`../../packages/we-scene/dist/index.js` 以普通使用者的身份引入编译产物。

```
testbed/
├── server.mjs              # 静态服务器（同时服务测试页面与 fixtures）
├── web/                    # 浏览器测试环境
│   ├── index.html          #   主实验室：实时渲染 + 图层面板 + 图层隔离
│   ├── main.js             #   页面逻辑（加载、图层面板、时间轴、快照预热）
│   ├── variants.html       #   调试页：仅背景 / 背景+水波 / 全图层（关特效 & 开特效）四宫格对比
│   └── shader-probe.html   #   调试页：把场景用到的每个 shader+combo 逐个编译并报告结果
└── scripts/
    ├── verify.mjs          # Node 端校验：包解析、场景图、纹理解码、引用完整性
    └── snapshot.mjs        # 无头 Chrome（CDP）截图 + 运行时诊断
```

## 运行

```bash
npm run build      # 先编译库（必需：测试环境引用的是 dist）
npm run testbed    # http://127.0.0.1:5180/testbed/web/
```

* 主实验室：<http://127.0.0.1:5180/testbed/web/>
* 四宫格对比：<http://127.0.0.1:5180/testbed/web/variants.html>
* 着色器探针：<http://127.0.0.1:5180/testbed/web/shader-probe.html>

页面参数：

| 参数 | 作用 |
| --- | --- |
| `?pkg=<路径>` | 换素材 |
| `?snapshot=1&time=14` | 截图模式：先按 1/60 步长把场景推进到指定时刻，粒子与文字才处于正确状态 |
| `&ui=1` | 截图时保留右侧面板 |
| `&layers=44,52` | 只渲染指定图层（观察单个图层） |
| `&bg=0` | 纯黑背景（观察加法混合的粒子层） |
| `&engine=1` | 打开「读取本机引擎资源」开关 |
| `&params=52` | 展开某个粒子图层的参数面板（预设取值 + 官方默认值 + 出处） |
| `?wallpaper=<清单 id>` | 直接打开清单里的某张壁纸（切换器用的就是它） |
| `?project=<目录 URL>` | 渲染未打包的工程目录（走 `/api/files` 清单） |
| `?api=rossi` | 用**接口二**（洛茜专用）加载，等价于在页面上把「接口」切到「洛茜专用」 |

## 切换壁纸

控制栏左侧的「壁纸」下拉框可以随时切换正在渲染的壁纸，用于逐个验证新壁纸能否正常生效：

* 清单由 **`/api/wallpapers`** 提供——服务器扫描 `fixtures/` 与 `wallpapers/` 下的
  `scene.pkg`（打包壁纸）和含 `scene.json` 的目录（未打包工程），标题取自 `project.json`；
* 点 **↻** 重新扫描（新增了壁纸目录后不用重启服务器）；
* **本地 .pkg** 按钮或**把 .pkg 拖进画面**可以直接载入本机文件；
* 切换会**销毁并重建渲染器**（场景不同，无法增量替换），图层列表、场景信息、状态栏、
  参数面板都会刷新；粒子漂移参数、适配模式、引擎资源开关是共享状态，切换后保持；
* 当前壁纸写进 URL（`?wallpaper=/fixtures/scene-we-2` 或 `?project=…`/`?pkg=…`），可直接分享/刷新。

## 接口选择

控制栏的「接口」下拉框对应库里的两个入口：

| 选项 | 调用的接口 | 效果 |
| --- | --- | --- |
| 普通加载 | `createWallpaper` | 加载全部图层；粒子参数由下面的漂移滑块控制 |
| 洛茜专用 | `createRossiWallpaper` | 只保留背景美术 + `灰烬大` 图层，粒子使用预设漂移（上升 240 / 漂移 200 / 右移 0.7）；滑块变成只读展示 |

切换会重建渲染器（场景不同无法增量替换），当前选择写进 URL（`?api=rossi`）可直接分享。
两个接口的说明见 [`packages/we-scene/README.md`](../packages/we-scene/README.md) 的「两个接口」一节。

## 粒子漂移开关

控制栏里的「上浮漂移」默认开启：粒子整体从下往上，约 80% 向右、20% 向左。旁边的三个滑块
（上升 / 漂移 / 右向）直接改 `particleOptions`（渲染器持有引用，下一帧生效，无需重建）。
关掉开关即回到引擎语义（各向同性湍流，粒子四处游走）。

模型与参数含义见 [`packages/we-scene/README.md`](../packages/we-scene/README.md) 的
「上浮 / 定向漂移」一节。

## 粒子参数面板

点击右侧图层列表里的**粒子图层**（或直接用 `?params=<id>`）会展开参数面板，把该粒子系统
（含子发射器）的每个属性列出来：

* 预设里写明的值 → 标为「预设写入」（高亮）；
* 预设省略的属性 → 按官方默认值补齐，并标出出处：**官方默认 · 组件预览工程** /
  **官方默认 · 官方预设统计** / **库内推断**（悬停可看到具体依据）。

这些默认值固化在 `packages/we-scene/src/render/particle-defaults.ts`，与
`we-scene <pkg> --particle-defaults` 输出的是同一张表。

## 引擎资源开关（`/we-assets/`）

`server.mjs` 会探测本机的 Wallpaper Engine 安装（默认查常见 Steam 路径，可用 `WE_ASSETS` 指定），
并**只读**代理其 `assets` 目录：

```
GET /api/engine-assets                  -> { available, directory, url }
GET /we-assets/materials/particle/halo.tex
GET /we-assets/shaders/common.h
```

页面上勾选「引擎资源」会用它重建渲染器：缺失的内置贴图、材质、粒子预设与真实 `common*.h`
改从引擎读取，找不到才回退到库内置的程序化近似。资源不会进入仓库，也不对外分发；
没有安装 Wallpaper Engine 时该路由返回 404，开关自动隐藏。

截图对比：

```bash
npm run snapshot -- "http://127.0.0.1:5180/testbed/web/?snapshot=1&time=14"           build/engine-off.png
npm run snapshot -- "http://127.0.0.1:5180/testbed/web/?snapshot=1&time=14&engine=1"  build/engine-on.png
```

## 校验与截图

```bash
npm run verify                       # Node 端解析/解码校验（无需浏览器）
npm run verify -- other.pkg          # 换一个包校验
npm run snapshot -- "http://127.0.0.1:5180/testbed/web/?snapshot=1&time=14" build/shot.png 1920 1080
```

`snapshot.mjs` 会启动带 `--remote-debugging-port` 的无头 Chrome，等待页面把
`window.__ready` 置为 true（真实时间等待，`--virtual-time-budget` 会让
`createImageBitmap` 永远不返回），然后截图并打印每层绘制结果、着色器提示与控制台输出。

## 素材

测试素材在仓库根的 `fixtures/`：

| 目录 | 内容 | 能否渲染 |
| --- | --- | --- |
| `fixtures/scene-we-1/` | 完整的示例壁纸：`scene.pkg`（PKGV0024）+ 预览图 + 着色器缓存 | ✅ `?pkg=../../fixtures/scene-we-1/scene.pkg` |
| `fixtures/scene-we-2/` | **只有** `shaders/blobsSM40/*.dxs`（编译后的着色器缓存，64 个 D3D blobs） | ❌ 没有场景数据（无 `scene.pkg` / `scene.json` / 贴图），无可渲染内容 |

换素材时把新的 `scene.pkg` 放进 `fixtures/<名字>/`，再用 `?pkg=../../fixtures/<名字>/scene.pkg` 打开；
只有着色器缓存的目录可以用 `node testbed/scripts/dxs.mjs <目录>` 看看它属于什么内容。

```bash
node testbed/scripts/dxs.mjs fixtures/scene-we-2/shaders/blobsSM40
# 文件      64 个 .dxs，解析失败 0
# 容器      SHDV0069×32  SHDV0066×32
# 着色器阶段 vertex×64
# 着色器模型 5.0×64
# 编译器    Microsoft (R) HLSL Shader Compiler 10.1
```
