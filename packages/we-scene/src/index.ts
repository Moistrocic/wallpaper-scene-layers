/**
 * @web-we-scene/runtime
 *
 * Extracts and renders Wallpaper Engine **scene** wallpapers in the browser.
 *
 * ```ts
 * import { createWallpaper } from "@web-we-scene/runtime";
 *
 * const wallpaper = await createWallpaper({ canvas, source: "scene.pkg" });
 * wallpaper.start();
 * ```
 *
 * The package layers are available without rendering anything:
 *
 * ```ts
 * import { loadPackage, createSceneFromArchive, describeLayers } from "@web-we-scene/runtime";
 *
 * const archive = await loadPackage("scene.pkg");
 * const scene = createSceneFromArchive(archive);
 * console.table(describeLayers(scene));
 * ```
 */

export { PackageArchive, parsePackage, decodeUtf8, stripJsonComments, type PackageEntry, type PackageHeader } from "./pkg/archive.js";
export { SceneDocument, createSceneFromArchive, createSceneFromBundle, plainValue, isVisible, type SceneSource } from "./scene/document.js";
export { ProjectBundle, type ProjectBundleOptions } from "./assets/project.js";
export { parseBundleJSON, bundleText, type AssetBundle } from "./assets/bundle.js";
export type {
  BlendMode,
  EffectDefinition,
  EffectInstance,
  EffectPassDefinition,
  EffectPassInstance,
  LayerTransform,
  LayerType,
  MaterialDefinition,
  MaterialPass,
  ModelDefinition,
  SceneCamera,
  SceneDocumentJSON,
  SceneGeneral,
  SceneLayer,
  TextLayerConfig
} from "./scene/types.js";
export { parseTex, expandTexImageData, decodeTexImage, decodeTexToRGBA, isTexContainer, type TexContainer, type TexHeader, type TexImage, type DecodedTexImage, type TexPixelFormat } from "./tex/tex.js";
export { decodeBlockCompressed, decodeBC1, decodeBC2, decodeBC3, type BlockFormat } from "./tex/bcn.js";
export { lz4DecompressBlock } from "./tex/lz4.js";
export { composeShader, parseShader, relaxGlslTypes, moderniseGlsl, sanitiseConditionals, collectConditionalIdentifiers, expandIncludes, type ComposedShader, type ComboDeclaration, type UniformHint } from "./shader/compose.js";
export { unifyVaryings } from "./render/shader-pipeline.js";
export { ENGINE_HEADERS } from "./shaders/prelude.js";
export { SceneRenderer, type FitMode, type LayerDrawStats, type RenderInput, type SceneRendererOptions } from "./render/renderer.js";
export {
  ParticleSystem,
  parseParticleDefinition,
  DEFAULT_TURBULENCE_SCALE,
  type ParticleDefinition,
  type ParticleOptions,
  type ParticleDriftOptions
} from "./render/particles.js";
export {
  PARTICLE_DEFAULTS,
  TURBULENCE_TIME_FACTOR,
  describeParticleDefaults,
  describeParticleParameters,
  numberDefault,
  vectorDefault,
  type ParticleDefaultSource,
  type ResolvedParticleParameter
} from "./render/particle-defaults.js";
export { TextRasterizer } from "./render/text.js";
export { BUILTIN_SHADERS, ShaderPipeline } from "./render/shader-pipeline.js";
export { createBuiltinImage, createHalo, createBeam, createClouds, createSolid, getBuiltinMaterial, getBuiltinModel } from "./assets/builtin.js";
export { TextureCache } from "./assets/texture-cache.js";
export {
  EngineAssets,
  resolveEngineAssets,
  detectEngineAssetsDirectory,
  ENGINE_ASSET_CANDIDATES,
  type EngineAssetsOptions,
  type EngineAssetStats
} from "./assets/engine-assets.js";
export { createCapabilities, RenderTarget, RenderTargetPool, type Capabilities, type GpuTexture, type ProgramInfo } from "./gl/gl-util.js";
export * as mat4 from "./util/math.js";
export { readNumber, readVec, BinaryReader } from "./util/bytes.js";
export { describeLayers, summariseScene, engineAssetDependencies, describeLayerParticleParameters, type LayerDescription } from "./scene/inspect.js";
export { loadPackage, loadPackageFromBlob, createWallpaper, applyLayerFilter, type LayerFilter, type Wallpaper, type WallpaperOptions, type WallpaperSource } from "./wallpaper.js";
export { ROSSI_WALLPAPER, createRossiWallpaper, type RossiWallpaperOptions } from "./presets/rossi.js";
