# 测试素材（不随仓库分发）

这里的壁纸**不入库**：它们分别是 Wallpaper Engine 官方模板（Deep Space）与创意工坊作品，
版权归原作者，且体积较大（约 67 MB）。请自行准备测试素材。

## 目录约定

两种素材都放在 `fixtures/<名字>/` 下，实验室会自动发现（点 ↻ 重新扫描）：

| 形式 | 目录内容 | 打开方式 |
| --- | --- | --- |
| 打包壁纸 | `scene.pkg`（可另有 `preview.jpg`、`project.json`） | 下拉框选择，或 `?wallpaper=/fixtures/<名字>` |
| 未打包工程 | `scene.json` + `materials/` + `models/` + `shaders/` | 同上，或 `?project=../../fixtures/<名字>/` |

`scene.pkg` 可以从 Wallpaper Engine 的创意工坊目录里找到（`steamapps/workshop/content/431960/<id>/scene.pkg`），
工程目录则可以直接复制引擎安装目录里的 `projects/defaultprojects/*` 模板。

## 校验脚本

`npm run verify` 默认读 `fixtures/scene-we-1/scene.pkg`，也可以直接指定：

```bash
npm run verify -- path/to/scene.pkg
```

没有素材时脚本会给出提示并跳过（不会失败）。

粒子相关的检查（`npm run presets`）读的是本机安装的 Wallpaper Engine 自带预设，不依赖这里。
