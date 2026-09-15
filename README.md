# web-we-scene

把 Wallpaper Engine **场景壁纸**（`scene.pkg`）拆解成可在浏览器中逐层渲染、逐层控制的图层。

* 纯浏览器端解析：`PKGV` 包容器、`scene.json`、模型 / 材质 / 特效 / 粒子预设、`.tex` 纹理，**不需要安装 Wallpaper Engine**；
* 用 WebGL2 直接编译包内的 GLSL（引擎前置头文件由本库重新实现并内联）；
* 每个 object 都是一个图层，可读取、隐藏、单独渲染、重新排序——是分层的工具库，不是黑盒播放器；
* 零依赖、纯 ESM，可被打包器引用，也可直接 `<script type="module">` 引入。

仓库：<https://github.com/Moistrocic/web-we-scene>

![渲染结果](docs/screenshots/rendered-scene.png)

*示例壁纸（workshop 3691554683）由本库在无头 Chrome 中渲染：背景图 + 水波特效、音频卡片（圆角遮罩 / 精确模糊 / 渐变混合）、日式时间组件（15 个文字图层，字体取自包内 TTF）、两套灰烬粒子。*

## 仓库构成：库 / 测试分离

```
web-we-scene/
├── packages/we-scene/     ★ 对外发布的库（其他项目只需要这一个目录）
│   ├── src/               源码（TypeScript，零依赖）
│   ├── bin/               we-scene 命令行（分层导出 / 纹理解码）
│   ├── dist/              构建产物（ESM + .d.ts，npm 包的入口）
│   ├── README.md          库文档
│   └── LICENSE
├── testbed/               ☆ 测试与演示，不发布，只依赖 packages/we-scene/dist
│   ├── server.mjs         静态服务器
│   ├── web/               浏览器测试环境（实验室 / 对比页 / 着色器探针）
│   ├── scripts/           Node 端校验（verify.mjs）与无头截图（snapshot.mjs）
│   └── README.md
├── fixtures/              测试素材（scene.pkg / 未打包工程）—— 不入库，见 fixtures/README.md
├── docs/screenshots/      文档用截图
├── build/                 生成物（解包结果、图层 JSON、截图），已 gitignore
├── LICENSE / README.md / package.json
```

划分原则：

* **`packages/we-scene/` 是被其他项目调用的代码**——它不引用仓库里任何其他目录，
  可以单独复制或 `npm install` 使用；
* **`testbed/` 只是使用者之一**——它和外部项目一样通过
  `../../packages/we-scene/dist/index.js` 引入库，因此测试同时也在验证打包产物；
* **`fixtures/` 是测试输入**（示例壁纸），**`build/` 是生成物**，都不属于源码。

> `fixtures/` 里的壁纸**不在仓库里**：示例用的是 Wallpaper Engine 官方模板与创意工坊作品，
> 版权归原作者。放一份自己的 `scene.pkg`（或未打包的工程目录）到 `fixtures/<名字>/` 即可跑全部测试，
> 目录约定见 [`fixtures/README.md`](fixtures/README.md)。

## 快速开始

```bash
npm install
npm run build          # 用 tsc 编译库到 packages/we-scene/dist
npm run testbed        # 启动静态服务器 http://127.0.0.1:5180/testbed/web/
```

打开 <http://127.0.0.1:5180/testbed/web/>：左侧实时渲染壁纸，右侧列出全部图层（类型、资产、特效数量）并带显隐开关，点击某个图层即可单独隔离显示。

控制栏的「壁纸」下拉框可以随时切换 `fixtures/` 下的多张壁纸（`scene.pkg` 或未打包的工程目录），
也能直接拖入本机 `.pkg` —— 用来逐个验证新壁纸能否正常生效。

命令行导出图层清单：

```bash
node packages/we-scene/bin/we-scene.mjs fixtures/scene-we-1/scene.pkg
node packages/we-scene/bin/we-scene.mjs fixtures/scene-we-1/scene.pkg --json build/layers.json
node packages/we-scene/bin/we-scene.mjs fixtures/scene-we-1/scene.pkg --out build/extracted --tex
npm run verify                             # 校验解析 + 纹理解码 + 粒子位移
npm run presets                            # 扫描本机 Wallpaper Engine 自带的 240 个粒子预设
node packages/we-scene/bin/we-scene.mjs scene.pkg --particle-defaults   # 查看粒子默认值及其出处
```

## 库用法

```ts
import { createWallpaper } from "@web-we-scene/runtime";

const wallpaper = await createWallpaper({ canvas, source: "scene.pkg" });

// 每个图层都是普通对象：id、name、type、transform、effects ...
console.table(wallpaper.layers.map((l) => ({ id: l.id, name: l.name, type: l.type })));

wallpaper.setLayerVisible(44, false);   // 关掉灰烬粒子层
wallpaper.stop();                        // 暂停渲染循环
wallpaper.renderFrame(12);               // 或者只渲染 t=12s 的一帧
```

完整 API、包 / 纹理格式说明、着色器兼容策略与已知限制见 [`packages/we-scene/README.md`](packages/we-scene/README.md)。

### 可选：读取本机引擎资源

引擎内置的贴图 / 材质 / 着色器头文件不在场景包里，默认用程序化近似（实测亮度误差 0.4%–8%）。
本机装了 Wallpaper Engine 时，打开开关即可改用引擎的真实文件（库不包含也不分发这些资源）：

```ts
await createWallpaper({ canvas, source: "scene.pkg", engineAssets: "/we-assets/" });        // 浏览器
await createWallpaper({ canvas, source, engineAssets: {} });                                  // Node 自动探测
```

`we-scene scene.pkg --engine-deps` 可以先列出这个场景需要哪些引擎资源；测试环境里对应的是
页面上的「引擎资源」勾选框（`?engine=1`）。

## 渲染管线

```
scene.pkg ──parsePackage──▶ PackageArchive ──▶ scene.json ──▶ SceneDocument.layers（33 层）
     │                                            │
     │                                            ├─ models/*.json ─▶ materials/*.json ─▶ .tex
     │                                            ├─ effects/*/effect.json ─▶ shaders/*.frag|.vert（GLSL）
     │                                            └─ particles/*.json ─▶ materials/presets/*.json
     ▼
  .tex ──LZ4 + BC1/2/3 + PNG──▶ GL 纹理 ──▶ SceneRenderer（WebGL2，特效走 FBO ping-pong）
```

单个图层的绘制顺序：

1. 沿父链求出模型矩阵（`origin / angles / scale` 逐级相乘），按 `alignment` 与模型 `cropoffset` 摆好四边形；
2. 有特效时先画进该图层屏幕包围盒大小的 FBO（用世界坐标包围盒做正交投影，像素包围盒决定 FBO 尺寸）；
3. 按 `effect.json` 的 `passes` 依次执行全屏 pass，支持 ping-pong、pass 自定义 `target`、`bind` 重映射与 `constantshadervalues`；
4. 把最终 FBO 按原包围盒合成回屏幕。没有特效的图层直接画到屏幕。

## 对示例壁纸的验证

* 解析出 33 个图层（image 12 / text 15 / solid 4 / particle 2），每帧实绘 26 层，其余是变换组或场景内隐藏；
* 4 张纹理全部解码：一条 3840×2160 的 PNG mip 链 + 3 张 LZ4 + BC3；
* 场景用到的 **11 个 shader / combo 组合全部编译通过**（水波、镂空、圆角遮罩、精确模糊、渐变混合、透明度、音频响应可视化）；
* 粒子（父系统 34 个 + 光束 22 个）由 CPU 模拟：curl noise 速度场驱动，实测散布约 3200×1200 场景单位、平均速度 385 单位/秒，会像原壁纸那样飘动与闪烁；`npm run verify` 把「粒子是否真的产生位移」作为回归项；
* 粒子与着色器语义对照了本机安装的 Wallpaper Engine 自带资源（`assets/shaders/genericparticle.vert`、`assets/materials/particle/*.tex`、`assets/presets/**`），并用 `npm run presets` 扫描引擎自带的 **240 个粒子预设**：解析/模拟失败 0，发射器 2/2、初始化器 10/13、算子 14/19；
* 粒子组件的**默认值已按官方取值固化进源码**（`src/render/particle-defaults.ts`，共 80 余项，逐条标注出处：引擎自带的组件预览工程 / 240 个官方预设统计），可用 `we-scene <pkg> --particle-defaults` 或 `describeParticleDefaults()` 查看；
* 包内 CJK 字体文字、每个 effect pass 均由无头 Chrome 截图确认。

| 截图 | 内容 |
| --- | --- |
| `docs/screenshots/lab-ui.png` | 实验室界面：渲染画面 + 图层面板 |
| `docs/screenshots/rendered-scene.png` | t=14s 的完整场景（含特效与粒子） |
| `docs/screenshots/layer-variants.png` | 仅第 17 层 / 第 17 层 + 水波 / 全图层（关特效与开特效）对比 |
| `docs/screenshots/particles.png` | 只渲染两个粒子层（黑底，t=14s）：可以看到散布的灰烬光点 |

测试环境的页面与脚本说明见 [`testbed/README.md`](testbed/README.md)；
`?layers=44,52&bg=0` 可以把粒子层单独放在黑底上观察。

## 许可

代码 [MIT](LICENSE) © Moistrocic。

`docs/screenshots/` 与 README 中的截图渲染的是**第三方壁纸**（Wallpaper Engine 官方模板、创意工坊作品），
仅用于说明本库的渲染效果，相关美术版权归原作者；`fixtures/` 中的测试素材同理，且不随仓库分发。
