#!/usr/bin/env node
/**
 * 查看一个 Wallpaper Engine 工程目录里的 `shaders/blobsSM40/*.dxs`（编译后的 D3D 着色器缓存）。
 *
 *   node testbed/scripts/dxs.mjs <目录>
 *
 * 只报告可靠信息：容器版本、着色器阶段（SM5 程序类型）、chunk 组成、编译器版本。
 * `.dxs` 是**编译产物**：本库渲染场景时用的是 `scene.pkg` 里的 GLSL 源码
 * （`shaders/*.vert|.frag`），因此这些文件本身不参与渲染，只能用来判断
 * "这份缓存属于什么内容"。
 */
import fs from "node:fs";
import path from "node:path";

const STAGES = { 0: "pixel", 1: "vertex", 2: "geometry", 3: "hull", 4: "domain", 5: "compute" };

/** `.dxs` = "SHDV00xx\0" + uint32 长度 + DXBC 容器。 */
export function parseDXS(buffer) {
  const marker = buffer.toString("latin1").indexOf("DXBC");
  if (marker < 0) return null;
  const view = buffer.subarray(marker);
  const u32 = (offset) => (offset >= 0 && offset + 4 <= view.length ? view.readUInt32LE(offset) : 0);
  const chunkCount = Math.min(u32(28), 32);
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    const offset = u32(32 + i * 4);
    if (offset <= 0 || offset + 8 > view.length) continue;
    chunks.push({ fourcc: view.toString("latin1", offset, offset + 4), size: u32(offset + 4) });
  }
  const shex = chunks.find((chunk) => chunk.fourcc === "SHEX");
  const shexOffset = shex ? u32(32 + chunks.indexOf(shex) * 4) : 0;
  const token = shexOffset ? u32(shexOffset + 8) : 0;
  const creatorMatch = /Microsoft \(R\) HLSL Shader Compiler [0-9.]+/.exec(buffer.toString("latin1"));
  return {
    container: buffer.toString("latin1", 0, 8).replace(/\0.*$/, ""),
    stage: STAGES[(token >> 16) & 0xffff] ?? "unknown",
    shaderModel: `${(token >> 4) & 0xf}.${token & 0xf}`,
    chunks: chunks.map((chunk) => chunk.fourcc + ":" + chunk.size),
    creator: creatorMatch ? creatorMatch[0] : null,
    size: buffer.length
  };
}

if (process.argv[1] && process.argv[1].endsWith("dxs.mjs")) {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) {
    console.log("用法: node testbed/scripts/dxs.mjs <包含 *.dxs 的目录>");
    process.exit(dir ? 1 : 0);
  }
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".dxs")).sort();
  const byStage = new Map();
  const containers = new Map();
  const creators = new Set();
  const chunkShapes = new Map();
  const models = new Map();
  let failed = 0;
  for (const file of files) {
    const info = parseDXS(fs.readFileSync(path.join(dir, file)));
    if (!info) { failed++; continue; }
    byStage.set(info.stage, (byStage.get(info.stage) ?? 0) + 1);
    containers.set(info.container, (containers.get(info.container) ?? 0) + 1);
    models.set(info.shaderModel, (models.get(info.shaderModel) ?? 0) + 1);
    if (info.creator) creators.add(info.creator);
    const shape = info.chunks.map((chunk) => chunk.split(":")[0]).join(",");
    chunkShapes.set(shape, (chunkShapes.get(shape) ?? 0) + 1);
  }
  console.log("目录      " + dir);
  console.log("文件      " + files.length + " 个 .dxs，解析失败 " + failed);
  console.log("容器      " + [...containers.entries()].map(([k, v]) => k + "×" + v).join("  "));
  console.log("着色器阶段 " + [...byStage.entries()].map(([k, v]) => k + "×" + v).join("  "));
  console.log("着色器模型 " + [...models.entries()].map(([k, v]) => k + "×" + v).join("  "));
  console.log("编译器    " + ([...creators].join(" | ") || "(未找到)"));
  console.log("chunk 组成 " + [...chunkShapes.entries()].map(([k, v]) => k + " ×" + v).join("   "));
  console.log("\n注意：这些是编译产物，渲染时不使用；可运行的是 scene.pkg（或含 scene.json 的工程目录）。");
}
