#!/usr/bin/env node
/**
 * Wallpaper Engine 场景壁纸检查 / 导出工具。
 *
 *   we-scene <scene.pkg> [--out <dir>] [--tex] [--json <file>] [--engine-deps]
 *   we-scene --particle-defaults        # 不需要包：打印粒子组件默认值表
 *
 * 不带 --out 时只打印包内容与图层清单，通常这就是把场景接入其他项目时需要的信息。
 */
import fs from "node:fs";
import path from "node:path";
import { PackageArchive, createSceneFromArchive, describeLayers, describeParticleDefaults, engineAssetDependencies, decodeTexToRGBA, summariseScene } from "../dist/index.js";
import { writePNG } from "./png.mjs";

const USAGE = `用法: we-scene <scene.pkg> [--out <dir>] [--tex] [--json <file>] [--engine-deps] [--particle-defaults]

  --out <dir>    解包全部文件到目录
  --tex          额外把 .tex 解码为 .png（隐含 --out）
  --json <file>  把图层清单写成 JSON
  --engine-deps  列出场景需要、但包里没有的引擎内置资源
  --particle-defaults  打印库内置的粒子组件默认值及其出处（不需要 scene.pkg）

示例:
  we-scene scene.pkg
  we-scene scene.pkg --json build/layers.json
  we-scene scene.pkg --engine-deps
  we-scene --particle-defaults`;

function printParticleDefaults() {
  const defaults = describeParticleDefaults();
  const sources = { "engine-preview": "引擎组件预览工程", "engine-content": "240 个官方预设统计", "runtime-inferred": "库内推断（无官方出处）" };
  console.log(`粒子组件默认值（${defaults.length} 项）:\n`);
  console.log("组件.属性".padEnd(42) + "取值".padEnd(16) + "出处");
  for (const entry of defaults) {
    console.log(entry.property.padEnd(42) + String(entry.value).padEnd(16) + sources[entry.source]);
  }
  console.log("\n提示：预设省略某个字段时使用这里的取值，出处见第三列；可用 describeParticleDefaults() 在代码里读取。");
}

const args = process.argv.slice(2);
const wantsDefaults = args.includes("--particle-defaults");
const wantsEngineDeps = args.includes("--engine-deps");
const wantsTex = args.includes("--tex");

// 把 "取值型" 选项的参数摘掉，剩下的第一个位置参数就是包路径。
let outDir;
let jsonFile;
const positionals = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--out") { outDir = args[++index]; continue; }
  if (arg === "--json") { jsonFile = args[++index]; continue; }
  if (arg.startsWith("-")) continue;
  positionals.push(arg);
}
const pkgPath = positionals[0];
const extractAll = outDir !== undefined || wantsTex;
const targetOutDir = outDir ?? "build/extracted";

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
// --particle-defaults 只读库内置的表，没有包也能跑。
if (wantsDefaults && !pkgPath) {
  printParticleDefaults();
  process.exit(0);
}
if (!pkgPath) {
  console.error("缺少 scene.pkg 路径。\n");
  console.log(USAGE);
  process.exit(1);
}
if (!fs.existsSync(pkgPath)) {
  console.error(`找不到文件 ${pkgPath}`);
  process.exit(1);
}

const archive = new PackageArchive(fs.readFileSync(pkgPath));
const scene = createSceneFromArchive(archive);
const summary = summariseScene(scene);

console.log(`${path.basename(pkgPath)}: ${archive.magic} (v${archive.version}, ${archive.list().length} 个文件)`);
console.log(`场景: ${summary.resolution.width}x${summary.resolution.height}, ${summary.layerCount} 个图层, 视差=${summary.parallax ? "开" : "关"}`);
console.log(`图层构成: ${Object.entries(summary.layersByType).map(([type, count]) => `${type}=${count}`).join(" ")}`);

console.log("\n# | id | 类型 | 父级 | 名称 | 资产 | 特效");
for (const layer of describeLayers(scene)) {
  const asset = layer.asset ? layer.asset.replace(/^(models|particles|fonts)\//, "") : "-";
  console.log(
    `${String(layer.index).padStart(2)} | ${String(layer.id).padStart(3)} | ${layer.type.padEnd(8)} | ${String(layer.parent ?? "-").padStart(3)} | ${layer.name.slice(0, 34).padEnd(34)} | ${asset.slice(0, 44).padEnd(44)} | ${layer.effects.length}`
  );
}

if (jsonFile) {
  fs.mkdirSync(path.dirname(path.resolve(jsonFile)), { recursive: true });
  fs.writeFileSync(jsonFile, JSON.stringify({ summary, layers: describeLayers(scene) }, null, 2));
  console.log(`\n图层清单已写入 ${jsonFile}`);
}

if (wantsDefaults) printParticleDefaults();

if (wantsEngineDeps) {
  const dependencies = engineAssetDependencies(scene);
  console.log(`\n引擎内置资源依赖（${dependencies.length} 个，包里没有）:`);
  for (const dependency of dependencies) console.log("  " + dependency);
  console.log("提示：这些文件位于 <Wallpaper Engine 安装>\\assets\\ 下；");
  console.log("      打开 engineAssets 开关（或把 assets 目录通过静态服务器暴露）即可使用真实资源。");
}

if (extractAll) {
  let count = 0;
  for (const entry of archive.list()) {
    const data = archive.get(entry);
    if (!data) continue;
    const target = path.join(targetOutDir, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    count++;
  }
  console.log(`已解包 ${count} 个文件到 ${targetOutDir}`);
}

if (wantsTex) {
  let decoded = 0;
  for (const entry of archive.list()) {
    if (!entry.endsWith(".tex")) continue;
    const data = archive.get(entry);
    if (!data) continue;
    const image = decodeTexToRGBA(data);
    if (!image.pixels) continue;
    const target = path.join(targetOutDir, entry.replace(/\.tex$/, ".png"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writePNG(target, image.width, image.height, image.pixels);
    decoded++;
    console.log(`纹理解码 ${entry} ${image.width}x${image.height} ${image.format}`);
  }
  console.log(`共解码 ${decoded} 张纹理`);
}
