#!/usr/bin/env node
/**
 * Node side verification of the parsers (no browser needed).
 *
 *   node testbed/scripts/verify.mjs [scene.pkg]
 *
 * Checks the package table, the scene graph and every texture decode, then
 * prints the layer table. Exits non zero when something fails.
 */
import fs from "node:fs";
import path from "node:path";
import { PackageArchive, createSceneFromArchive, describeLayers, getBuiltinMaterial, getBuiltinModel, parseTex, decodeTexImage, parseParticleDefinition, ParticleSystem, summariseScene } from "../../packages/we-scene/dist/index.js";
import { writePNG } from "../../packages/we-scene/bin/png.mjs";

const pkgPath = process.argv[2] ?? "fixtures/scene-we-1/scene.pkg";
const problems = [];

// 测试素材不入库（版权归原作者），没有素材时给出指引并跳过，而不是报错。
if (!fs.existsSync(pkgPath)) {
  console.log(`未找到测试壁纸 ${pkgPath}`);
  console.log("把任意 scene.pkg 放到 fixtures/<名字>/ 下，或者指定路径：npm run verify -- path/to/scene.pkg");
  console.log("详见 fixtures/README.md；跳过本次校验。");
  process.exit(0);
}
const expect = (condition, message) => { if (!condition) problems.push(message); };

const archive = new PackageArchive(fs.readFileSync(pkgPath));
console.log("package      " + archive.magic + " v" + archive.version + ", " + archive.list().length + " files");
expect(archive.list().length > 0, "package has no files");

const scene = createSceneFromArchive(archive);
const summary = summariseScene(scene);
console.log("scene        " + summary.resolution.width + "x" + summary.resolution.height + ", " + summary.layerCount + " layers (" + Object.entries(summary.layersByType).map(([t, n]) => t + ":" + n).join(", ") + ")");
expect(summary.layerCount > 0, "scene has no layers");

const outDir = "build/tex-preview";
fs.mkdirSync(outDir, { recursive: true });
for (const entry of archive.list()) {
  if (!entry.endsWith(".tex")) continue;
  const data = archive.get(entry);
  const container = parseTex(data);
  const first = container.images[0];
  const decoded = decodeTexImage(first);
  const line = "texture      " + entry + " " + first.width + "x" + first.height + " " + decoded.format;
  if (decoded.pixels) {
    const target = path.join(outDir, path.basename(entry).replace(/\.tex$/, ".png"));
    writePNG(target, decoded.width, decoded.height, decoded.pixels);
    console.log(line + " -> " + target);
  } else {
    console.log(line + " (" + decoded.file.length + " bytes of " + decoded.mimeType + ")");
  }
  expect(first.width > 0 && first.height > 0, "texture " + entry + " has no size");
}

for (const layer of describeLayers(scene)) {
  const asset = layer.asset ? path.basename(layer.asset) : "-";
  console.log("layer        " + String(layer.index).padStart(2) + " id=" + String(layer.id).padStart(3) + " " + layer.type.padEnd(8) + " " + (layer.parent === null ? "root" : "p" + layer.parent) + " " + layer.name.slice(0, 30).padEnd(30) + " " + asset);
}

// Every model and material a layer points at must resolve, either from the
// package or from the built in engine assets this runtime provides.
for (const layer of scene.layers) {
  if (!layer.image) continue;
  const model = scene.getModel(layer.image) ?? getBuiltinModel(layer.image);
  expect(model !== undefined, "missing model " + layer.image);
  if (!model?.material) continue;
  const resolved = scene.getMaterial(model.material) ?? getBuiltinMaterial(model.material);
  expect(resolved !== undefined, "missing material " + model.material);
}
for (const layer of scene.layers) {
  for (const effect of layer.effects) {
    const definition = scene.getEffect(effect.file);
    expect(definition !== undefined, "missing effect " + effect.file);
    for (const pass of definition?.passes ?? []) {
      const material = scene.getMaterial(pass.material) ?? getBuiltinMaterial(pass.material);
      expect(material !== undefined, "effect " + effect.file + " references missing material " + pass.material);
      for (const shaderPass of material?.passes ?? []) {
        if (shaderPass.shader.startsWith("generic") || shaderPass.shader === "solid") continue;
        const hasVert = scene.has("shaders/" + shaderPass.shader + ".vert");
        const hasFrag = scene.has("shaders/" + shaderPass.shader + ".frag");
        expect(hasVert && hasFrag, "missing shader sources for " + shaderPass.shader);
      }
    }
  }
}

// 粒子必须真的会动：曾经因为 turbulence 的实现错误，粒子全部停在发射点。
for (const layer of scene.layers) {
  if (layer.type !== "particle" || !layer.particle) continue;
  const definition = parseParticleDefinition(archive.getJSON(layer.particle));
  const system = new ParticleSystem(definition);
  const dt = 1 / 60;
  for (let frame = 0; frame < 60 * 12; frame++) system.update(dt);
  const alive = system.slots.filter((particle) => particle.alive);
  if (alive.length === 0) {
    problems.push("particle layer " + layer.name + " produced no particles after 12s");
    continue;
  }
  const xs = alive.map((particle) => particle.position[0]);
  const ys = alive.map((particle) => particle.position[1]);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  const speed = alive.reduce((total, particle) => total + Math.hypot(particle.velocity[0], particle.velocity[1]), 0) / alive.length;
  console.log(
    "particles    " + layer.name + " n=" + alive.length + " spread=" + spreadX.toFixed(0) + "x" + spreadY.toFixed(0) +
    " avgSpeed=" + speed.toFixed(0) + (system.unsupported.length ? " unsupported=" + system.unsupported.join(",") : "")
  );
  expect(spreadX > 200 || spreadY > 200, "particle layer " + layer.name + " does not drift (spread " + spreadX.toFixed(0) + "x" + spreadY.toFixed(0) + ")");
  expect(speed > 50, "particle layer " + layer.name + " has no velocity (avg " + speed.toFixed(1) + ")");
}

// 上浮 / 定向漂移：开启后应满足"全部上升、多数向右、少数向左"。
for (const layer of scene.layers) {
  if (layer.type !== "particle" || !layer.particle) continue;
  const definition = parseParticleDefinition(archive.getJSON(layer.particle));
  const system = new ParticleSystem(definition, undefined, { drift: true });
  for (let frame = 0; frame < 60 * 14; frame++) system.update(1 / 60);
  const alive = system.slots.filter((particle) => particle.alive);
  if (alive.length === 0) continue;
  const rising = alive.filter((particle) => particle.velocity[1] > 0).length;
  const right = alive.filter((particle) => particle.velocity[0] > 20).length;
  const left = alive.filter((particle) => particle.velocity[0] < -20).length;
  console.log(
    "drift        " + layer.name + " 上升=" + rising + "/" + alive.length + " 向右=" + right + " 向左=" + left
  );
  expect(rising / alive.length > 0.9, "drift: only " + rising + "/" + alive.length + " particles rise in " + layer.name);
  expect(right > left, "drift: rightward particles (" + right + ") should outnumber leftward (" + left + ") in " + layer.name);
}

if (problems.length) {
  console.error("\nFAILED:\n" + problems.map((problem) => "  - " + problem).join("\n"));
  process.exit(1);
}
const shaders = new Set();
for (const layer of scene.layers) {
  for (const effect of layer.effects) {
    for (const pass of scene.getEffect(effect.file)?.passes ?? []) {
      for (const materialPass of scene.getMaterial(pass.material)?.passes ?? []) shaders.add(materialPass.shader);
    }
  }
}
console.log("shaders      " + [...shaders].join("\n             "));
console.log("\nall checks passed");
