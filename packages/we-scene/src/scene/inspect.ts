import type { SceneDocument } from "./document.js";
import type { SceneLayer } from "./types.js";
import { describeParticleParameters } from "../render/particle-defaults.js";

/** Flat, serialisable description of a scene layer ("分层的获取"). */
export interface LayerDescription {
  index: number;
  id: number;
  name: string;
  type: SceneLayer["type"];
  parent: number | null;
  /** Texture / model / particle references the layer needs. */
  asset: string | null;
  effects: string[];
  /** Screen placement in scene units. */
  origin: [number, number, number];
  size: [number, number] | null;
  scale: [number, number, number];
  angles: [number, number, number];
  alpha: number;
  color: [number, number, number, number];
  visible: boolean;
  /** Name of the user property the layer is bound to, when any. */
  visibilityProperty?: string;
}

/** One row per layer, in painting order, ready for `console.table`. */
export function describeLayers(scene: SceneDocument): LayerDescription[] {
  return scene.layers.map((layer, index) => ({
    index,
    id: layer.id,
    name: layer.name,
    type: layer.type,
    parent: layer.parentId,
    asset: layer.image ?? layer.particle ?? layer.text?.font ?? null,
    effects: layer.effects.map((effect) => effect.file),
    origin: layer.transform.origin,
    size: layer.transform.size ?? null,
    scale: layer.transform.scale,
    angles: layer.transform.angles,
    alpha: layer.alpha,
    color: layer.color,
    visible: layer.visible,
    visibilityProperty: layer.visibilityUser
  }));
}

/**
 * 场景引用了、但包里没有的资源路径（引擎内置资源）。
 *
 * 打开「读取本机引擎资源」时，运行时会去引擎安装目录里找这些文件；没装引擎时
 * 它们由程序化近似替代。也可以用命令行 `we-scene <pkg> --engine-deps` 查看。
 */
export function engineAssetDependencies(scene: SceneDocument): string[] {
  const paths = new Set<string>();
  const add = (path: string | undefined) => {
    // 系统字体由浏览器解析，不属于引擎资源。
    if (!path || path.startsWith("systemfont")) return;
    if (!scene.hasFromPackage(path)) paths.add(path);
  };
  // 材质的纹理名和着色器里声明的默认采样器（util/white 等）也来自引擎。
  const addMaterialTextures = (materialPath: string | undefined) => {
    if (!materialPath) return;
    for (const materialPass of scene.getMaterial(materialPath)?.passes ?? []) {
      for (const texture of materialPass.textures) add(`materials/${texture}.tex`);
      if (materialPass.shader.startsWith("generic") || materialPass.shader === "solid") continue;
      add(`shaders/${materialPass.shader}.vert`);
      add(`shaders/${materialPass.shader}.frag`);
      for (const stage of ["frag", "vert"]) {
        const source = scene.getShaderSource(`shaders/${materialPass.shader}.${stage}`);
        if (!source) continue;
        for (const match of source.matchAll(/uniform\s+sampler2D\s+\w+\s*;[^\n]*"default"\s*:\s*"([^"]+)"/g)) {
          if (!match[1].startsWith("util/")) continue;
          add(`materials/${match[1]}.tex`);
        }
      }
    }
  };

  for (const layer of scene.layers) {
    add(layer.image);
    add(layer.particle);
    add(layer.text?.font);
    if (layer.image) addMaterialTextures(scene.getModel(layer.image)?.material);
    for (const effect of layer.effects) {
      add(effect.file);
      for (const pass of scene.getEffect(effect.file)?.passes ?? []) {
        add(pass.material);
        addMaterialTextures(pass.material);
      }
    }
    const particle = layer.particle ? scene.getJSON<Record<string, unknown>>(layer.particle) : undefined;
    if (particle) addMaterialTextures(typeof particle.material === "string" ? particle.material : undefined);
    const children = Array.isArray(particle?.children) ? (particle!.children as Array<Record<string, unknown>>) : [];
    for (const child of children) {
      if (typeof child.name !== "string") continue;
      add(child.name);
      const childJson = scene.getJSON<Record<string, unknown>>(child.name);
      if (childJson) addMaterialTextures(typeof childJson.material === "string" ? childJson.material : undefined);
    }
  }
  // 引擎着色器头文件：核心集合，以及着色器里 #include 到的其它头文件。
  for (const name of [
    "common.h",
    "common_vertex.h",
    "common_fragment.h",
    "common_perspective.h",
    "common_blending.h",
    "common_blur.h",
    "common_particles.h",
    "common_composite.h"
  ]) {
    add(`shaders/${name}`);
  }
  for (const path of [...paths]) {
    if (!path.endsWith(".vert") && !path.endsWith(".frag")) continue;
    for (const match of scene.getShaderSource(path)?.matchAll(/#include\s+"([^"]+)"/g) ?? []) {
      add(`shaders/${match[1]}`);
    }
  }
  return [...paths];
}

/** 某个粒子图层展开后的参数表（含官方默认值补齐）。 */
export function describeLayerParticleParameters(scene: SceneDocument, layerId: number) {
  const layer = scene.getLayer(layerId);
  if (!layer?.particle) return undefined;
  const json = scene.getJSON<Record<string, unknown>>(layer.particle);
  if (!json) return undefined;
  const systems: Array<{ path: string; parameters: ReturnType<typeof describeParticleParameters> }> = [
    { path: layer.particle, parameters: describeParticleParameters(json) }
  ];
  // 子发射器（灰烬 + 光晕这类结构）也要展开。
  const children = Array.isArray(json.children) ? (json.children as Array<Record<string, unknown>>) : [];
  for (const child of children) {
    if (typeof child.name !== "string") continue;
    const childJson = scene.getJSON<Record<string, unknown>>(child.name);
    if (childJson) systems.push({ path: child.name, parameters: describeParticleParameters(childJson) });
  }
  return { layerId, name: layer.name, systems };
}

export interface SceneSummary {
  version: number;
  resolution: { width: number; height: number };
  camera: { eye: number[]; center: number[]; up: number[] };
  parallax: boolean;
  clearColor: number[];
  layerCount: number;
  layersByType: Record<string, number>;
  userProperties: Array<{ name: string; type: string; label: string }>;
}

/** Human readable overview of a parsed scene, used by the CLI and the lab UI. */
export function summariseScene(scene: SceneDocument): SceneSummary {
  const layersByType: Record<string, number> = {};
  for (const layer of scene.layers) layersByType[layer.type] = (layersByType[layer.type] ?? 0) + 1;
  const properties: Array<{ name: string; type: string; label: string }> = [];
  for (const layer of scene.layers) {
    const user = layer.visibilityUser;
    if (user && !properties.some((property) => property.name === user)) {
      properties.push({ name: user, type: "bool", label: user });
    }
  }
  return {
    version: scene.version,
    resolution: scene.general.orthographicProjection,
    camera: { eye: scene.camera.eye, center: scene.camera.center, up: scene.camera.up },
    parallax: scene.general.cameraParallax,
    clearColor: scene.general.clearColor,
    layerCount: scene.layers.length,
    layersByType,
    userProperties: properties
  };
}
