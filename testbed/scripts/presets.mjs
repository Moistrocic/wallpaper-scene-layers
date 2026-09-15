#!/usr/bin/env node
/**
 * 引擎内置粒子预设兼容性扫描。
 *
 *   node testbed/scripts/presets.mjs [引擎资源目录]
 *
 * 会把 Wallpaper Engine 自带的全部粒子预设（assets/presets/**\/particles/**\/*.json
 * 与 assets/particles/example*.json）逐个解析、模拟 6 秒并生成顶点，报告：
 *   - 解析/模拟失败数（应为 0）
 *   - 引擎用到的组件词表及出现次数
 *   - 本库尚未实现的组件（会通过 renderer.diagnostics 报告）
 *
 * 资源目录默认按常见 Steam 路径探测，也可以用 WE_ASSETS 环境变量指定；
 * 找不到时直接跳过并返回 0，因此在没有安装 Wallpaper Engine 的机器上也能跑。
 */
import fs from "node:fs";
import path from "node:path";
import { parseParticleDefinition, ParticleSystem } from "../../packages/we-scene/dist/index.js";

const CANDIDATES = [
  process.env.WE_ASSETS,
  process.argv[2],
  "C:\\Games\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "D:\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\assets"
].filter(Boolean);

const assets = CANDIDATES.find((candidate) => fs.existsSync(path.join(candidate, "presets")));
if (!assets) {
  console.log("未找到 Wallpaper Engine 资源目录，跳过预设扫描（可用 WE_ASSETS=<assets 目录> 指定）");
  process.exit(0);
}
console.log("引擎资源目录: " + assets);

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".json") && full.includes("particles")) files.push(full);
  }
};
walk(path.join(assets, "presets"));
const examplesDir = path.join(assets, "particles");
if (fs.existsSync(examplesDir)) {
  for (const name of fs.readdirSync(examplesDir)) if (name.endsWith(".json")) files.push(path.join(examplesDir, name));
}

const vocabulary = { emitter: new Map(), initializer: new Map(), operator: new Map(), renderer: new Map() };
const unsupported = new Map();
const failures = [];

for (const file of files) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  for (const kind of Object.keys(vocabulary)) {
    for (const item of json[kind] ?? []) {
      const map = vocabulary[kind];
      map.set(item.name, (map.get(item.name) ?? 0) + 1);
    }
  }
  try {
    const system = new ParticleSystem(parseParticleDefinition(json));
    for (let frame = 0; frame < 60 * 6; frame++) system.update(1 / 60);
    system.buildVertices(new Float32Array(9 * 6 * 8192), 9, 1);
    for (const name of system.unsupported) unsupported.set(name, (unsupported.get(name) ?? 0) + 1);
  } catch (error) {
    failures.push(path.relative(assets, file) + ": " + error.message);
  }
}

console.log("扫描预设: " + files.length + " 个");
console.log("解析/模拟失败: " + failures.length);
for (const failure of failures.slice(0, 10)) console.log("  - " + failure);

const total = (map) => [...map.values()].reduce((a, b) => a + b, 0);
for (const [kind, map] of Object.entries(vocabulary)) {
  const supported = [...map.keys()].filter((name) => ![...unsupported.keys()].some((key) => key.endsWith(":" + name)));
  console.log("\n" + kind + " (" + map.size + " 种, 共 " + total(map) + " 次使用, 本库支持 " + supported.length + " 种)");
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    const isSupported = ![...unsupported.keys()].some((key) => key.endsWith(":" + name));
    console.log("  " + (isSupported ? "yes" : "NO ") + "  " + String(name).padEnd(32) + count);
  }
}

if (unsupported.size) {
  console.log("\n未实现的组件（会通过 renderer.diagnostics 报告，不影响其它图层）:");
  for (const [name, count] of [...unsupported.entries()].sort((a, b) => b[1] - a[1])) console.log("  " + String(name).padEnd(38) + count);
}

if (failures.length) {
  console.error("\n失败：" + failures.length + " 个预设无法模拟");
  process.exit(1);
}
console.log("\n全部预设解析与模拟通过");
