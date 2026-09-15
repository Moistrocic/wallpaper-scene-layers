import type { PackageArchive } from "../pkg/archive.js";
import type { AssetBundle } from "../assets/bundle.js";
import { readNumber, readVec } from "../util/bytes.js";
import type {
  EffectDefinition,
  EffectInstance,
  LayerTransform,
  MaterialDefinition,
  MaterialPass,
  ModelDefinition,
  SceneCamera,
  SceneDocumentJSON,
  SceneGeneral,
  SceneLayer,
  TextLayerConfig
} from "./types.js";

export interface SceneSource {
  getJSON<T = unknown>(path: string): T | undefined;
  getText(path: string): string | undefined;
  has(path: string): boolean;
  /** Optional raw bytes, needed when the scene also carries textures. */
  getBytes?(path: string): Uint8Array | undefined;
}

const DEFAULT_GENERAL: SceneGeneral = {
  orthographicProjection: { width: 1920, height: 1080 },
  clearColor: [0.7, 0.7, 0.7],
  clearEnabled: true,
  ambientColor: [0.3, 0.3, 0.3],
  skylightColor: [0.3, 0.3, 0.3],
  cameraParallax: false,
  cameraParallaxAmount: 0.5,
  cameraParallaxDelay: 0.1,
  cameraParallaxMouseInfluence: 0.5,
  cameraFade: true,
  cameraShake: false,
  zoom: 1,
  fov: 50,
  nearZ: 0.01,
  farZ: 10000,
  hdr: false,
  bloom: false,
  windEnabled: false,
  windStrength: 1,
  windDirection: [0, -1, 0],
  gravityStrength: 1,
  gravityDirection: [0, -1, 0]
};

/** Reads the `value` of a field that may be a script binding. */
export function plainValue<T>(input: unknown, fallback: T): T {
  if (input === undefined || input === null) return fallback;
  if (typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if ("value" in record) return (record.value ?? fallback) as T;
    return fallback;
  }
  return input as T;
}

export function isVisible(input: unknown): { visible: boolean; user?: string } {
  if (input === undefined || input === null) return { visible: true };
  if (typeof input === "boolean") return { visible: input };
  if (typeof input === "number") return { visible: input !== 0 };
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    const user = typeof record.user === "string" ? record.user : undefined;
    return { visible: record.value === undefined ? true : Boolean(record.value), user };
  }
  return { visible: true };
}

/**
 * Parses a `scene.json` (plus the models / materials / effects it references)
 * into a flat, renderer friendly list of layers.
 */
export class SceneDocument {
  readonly version: number;
  readonly general: SceneGeneral;
  readonly camera: SceneCamera;
  /** Layers in painting order (index 0 is drawn first). */
  readonly layers: SceneLayer[];
  /** Layer ids in the same order as `layers`. */
  readonly order: number[];
  private readonly byId = new Map<number, SceneLayer>();
  private readonly source: SceneSource;
  /**
   * Files loaded from outside the package (a loose project folder or the local
   * Wallpaper Engine installation). Consulted whenever the package misses a
   * path, so a scene can borrow the engine's built in materials and shaders.
   */
  private readonly overlay = new Map<string, Uint8Array>();

  constructor(json: SceneDocumentJSON, source: SceneSource) {
    this.source = source;
    this.version = readNumber(json.version, 1);
    this.general = normaliseGeneral(json.general);
    this.camera = {
      eye: readVec(json.camera?.eye, 3) as SceneCamera["eye"],
      center: readVec(json.camera?.center ?? "0 0 -1", 3) as SceneCamera["center"],
      up: readVec(json.camera?.up ?? "0 1 0", 3) as SceneCamera["up"]
    };

    const objects = Array.isArray(json.objects) ? json.objects : [];
    this.layers = objects.map((object, index) => parseLayer(object, index));
    this.order = this.layers.map((layer) => layer.id);
    for (const layer of this.layers) this.byId.set(layer.id, layer);
    for (const layer of this.layers) {
      if (layer.parentId !== null && this.byId.has(layer.parentId)) {
        this.byId.get(layer.parentId)!.childIds.push(layer.id);
      }
    }
  }

  getLayer(id: number): SceneLayer | undefined {
    return this.byId.get(id);
  }

  /** Root layers (no parent), in painting order. */
  get rootLayers(): SceneLayer[] {
    return this.layers.filter((layer) => layer.parentId === null || !this.byId.has(layer.parentId));
  }

  getLayerIndex(id: number): number {
    return this.layers.findIndex((layer) => layer.id === id);
  }

  /** JSON from the package or the overlay. */
  private json<T>(path: string): T | undefined {
    const fromSource = this.source.getJSON<T>(path);
    if (fromSource !== undefined) return fromSource;
    const text = overlayText(this.overlay, path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  /** Model definition of an image layer (`models/...json`). */
  getModel(path: string): ModelDefinition | undefined {
    const json = this.json<Record<string, unknown>>(path);
    if (!json) return undefined;
    return {
      material: typeof json.material === "string" ? json.material : undefined,
      autosize: json.autosize === undefined ? true : Boolean(json.autosize),
      width: json.width === undefined ? undefined : readNumber(json.width, 0) || undefined,
      height: json.height === undefined ? undefined : readNumber(json.height, 0) || undefined,
      solidlayer: Boolean(json.solidlayer),
      instanced: Boolean(json.instanced),
      cropOffset: json.cropoffset === undefined ? undefined : (readVec(json.cropoffset, 2) as [number, number]),
      source: path
    };
  }

  /** Material definition (`materials/...json`). */
  getMaterial(path: string): MaterialDefinition | undefined {
    const json = this.json<Record<string, unknown>>(path);
    if (!json || !Array.isArray(json.passes)) return undefined;
    return { passes: json.passes.map((pass) => parseMaterialPass(pass as Record<string, unknown>)) };
  }

  /** Effect definition (`effects/.../effect.json`). */
  getEffect(path: string): EffectDefinition | undefined {
    const json = this.json<Record<string, unknown>>(path);
    if (!json) return undefined;
    const fbos = Array.isArray(json.fbos)
      ? (json.fbos as Array<Record<string, unknown>>).map((fbo) => ({
          name: String(fbo.name ?? ""),
          format: String(fbo.format ?? "rgba_backbuffer")
        }))
      : [];
    const passes = Array.isArray(json.passes)
      ? (json.passes as Array<Record<string, unknown>>).map((pass) => ({
          material: String(pass.material ?? ""),
          target: typeof pass.target === "string" ? pass.target : undefined,
          bind: Array.isArray(pass.bind)
            ? (pass.bind as Array<Record<string, unknown>>).map((binding) => ({
                index: readNumber(binding.index, 0),
                name: String(binding.name ?? "")
              }))
            : undefined
        }))
      : [];
    return {
      name: typeof json.name === "string" ? json.name : undefined,
      description: typeof json.description === "string" ? json.description : undefined,
      group: typeof json.group === "string" ? json.group : undefined,
      version: readNumber(json.version, 1),
      replacementKey: typeof json.replacementkey === "string" ? json.replacementkey : undefined,
      fbos,
      passes,
      dependencies: Array.isArray(json.dependencies) ? (json.dependencies as string[]) : []
    };
  }

  /** Shader source, resolved from the package or the overlay. */
  getShaderSource(path: string): string | undefined {
    return this.source.getText(path) ?? overlayText(this.overlay, path);
  }

  has(path: string): boolean {
    return this.source.has(path) || this.overlay.has(overlayKey(path));
  }

  /** True only when the path is inside the package itself (ignores the overlay). */
  hasFromPackage(path: string): boolean {
    return this.source.has(path);
  }

  /** JSON from the package or the overlay (public counterpart of `json()`). */
  getJSON<T = unknown>(path: string): T | undefined {
    return this.json<T>(path);
  }

  /** Raw bytes for a path, used by the texture cache. */
  getBytes(path: string): Uint8Array | undefined {
    const fromSource = this.source.getBytes?.(path);
    return fromSource ?? this.overlay.get(overlayKey(path));
  }

  /**
   * Registers a file that did not come from the package. Later calls for the
   * same path win, and `has()` / `getJSON()` / `getShaderSource()` pick it up
   * immediately, which is what makes "use the local engine assets" work.
   */
  useOverlay(path: string, bytes: Uint8Array): void {
    this.overlay.set(overlayKey(path), bytes);
  }

  get overlaySize(): number {
    return this.overlay.size;
  }
}

function overlayKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function overlayText(overlay: Map<string, Uint8Array>, path: string): string | undefined {
  const bytes = overlay.get(overlayKey(path));
  return bytes ? new TextDecoder("utf-8").decode(bytes) : undefined;
}

/** 从任意资源包（`scene.pkg` 或工程目录）构造场景。 */
export function createSceneFromBundle(bundle: AssetBundle): SceneDocument {
  const json = bundle.getJSON<SceneDocumentJSON>("scene.json");
  if (!json) throw new Error("scene.json not found in the asset bundle");
  return new SceneDocument(json, {
    getJSON: (path) => bundle.getJSON(path),
    getText: (path) => bundle.getText(path),
    has: (path) => bundle.has(path),
    getBytes: (path) => bundle.get(path)
  });
}

export function createSceneFromArchive(archive: PackageArchive): SceneDocument {
  return createSceneFromBundle(archive);
}

function normaliseGeneral(raw: SceneDocumentJSON["general"]): SceneGeneral {
  if (!raw) return { ...DEFAULT_GENERAL };
  const ortho = (raw.orthogonalprojection ?? {}) as Record<string, unknown>;
  return {
    ...DEFAULT_GENERAL,
    orthographicProjection: {
      width: readNumber(ortho.width, 3840),
      height: readNumber(ortho.height, 2160)
    },
    clearColor: readVec(raw.clearcolor ?? DEFAULT_GENERAL.clearColor, 3) as SceneGeneral["clearColor"],
    clearEnabled: raw.clearenabled === undefined ? true : Boolean(raw.clearenabled),
    ambientColor: readVec(raw.ambientcolor ?? DEFAULT_GENERAL.ambientColor, 3) as SceneGeneral["ambientColor"],
    skylightColor: readVec(raw.skylightcolor ?? DEFAULT_GENERAL.skylightColor, 3) as SceneGeneral["skylightColor"],
    cameraParallax: Boolean(raw.cameraparallax),
    cameraParallaxAmount: readNumber(raw.cameraparallaxamount, 0.5),
    cameraParallaxDelay: readNumber(raw.cameraparallaxdelay, 0.1),
    cameraParallaxMouseInfluence: readNumber(raw.cameraparallaxmouseinfluence, 0.5),
    cameraFade: raw.camerafade === undefined ? true : Boolean(raw.camerafade),
    cameraShake: Boolean(raw.camerashake),
    zoom: readNumber(raw.zoom, 1),
    fov: readNumber(raw.fov, 50),
    nearZ: readNumber(raw.nearz, 0.01),
    farZ: readNumber(raw.farz, 10000),
    hdr: Boolean(raw.hdr),
    bloom: Boolean(raw.bloom),
    windEnabled: Boolean(raw.windenabled),
    windStrength: readNumber(raw.windstrength, 1),
    windDirection: readVec(raw.winddirection ?? DEFAULT_GENERAL.windDirection, 3) as SceneGeneral["windDirection"],
    gravityStrength: readNumber(raw.gravitystrength, 1),
    gravityDirection: readVec(raw.gravitydirection ?? DEFAULT_GENERAL.gravityDirection, 3) as SceneGeneral["gravityDirection"]
  };
}

function parseLayer(object: Record<string, unknown>, index: number): SceneLayer {
  const id = readNumber(object.id, index);
  const visibility = isVisible(object.visible);
  const text = object.text !== undefined ? parseTextLayer(object) : undefined;
  const isSolid = Boolean(object.solid) || (object.solid === undefined && !object.image && !object.text && !object.particle && !object.model);

  let type: SceneLayer["type"] = "unknown";
  if (object.image) type = "image";
  else if (object.particle) type = "particle";
  else if (object.text !== undefined) type = "text";
  else if (object.model) type = "model";
  else if (isSolid) type = "solid";
  else if (object.sound) type = "sound";

  const transform: LayerTransform = {
    origin: readVec(plainValue(object.origin, "0 0 0"), 3) as LayerTransform["origin"],
    angles: readVec(plainValue(object.angles, "0 0 0"), 3) as LayerTransform["angles"],
    scale: readVec(plainValue(object.scale, "1 1 1"), 3) as LayerTransform["scale"],
    size: object.size === undefined ? undefined : (readVec(plainValue(object.size, "0 0"), 2) as [number, number]),
    alignment: typeof object.alignment === "string" ? object.alignment : "center",
    lockTransforms: Boolean(object.locktransforms),
    parallaxDepth: readVec(plainValue(object.parallaxdepth, "0 0"), 2) as [number, number]
  };

  const alpha = readNumber(plainValue(object.alpha, 1), 1);
  const color = readVec(plainValue(object.color, "1 1 1"), 4) as SceneLayer["color"];
  if (color[3] === 0 && typeof object.color !== "string") color[3] = 1;
  if (isSolid && color[3] === 0) color[3] = 1;

  return {
    id,
    name: typeof object.name === "string" ? object.name : `layer_${id}`,
    type,
    parentId: object.parent === undefined ? null : readNumber(object.parent, -1),
    childIds: [],
    index,
    visible: visibility.visible,
    visibilityUser: visibility.user,
    alpha,
    color,
    transform,
    image: typeof object.image === "string" ? object.image : undefined,
    solid: isSolid,
    text,
    particle: typeof object.particle === "string" ? object.particle : undefined,
    effects: parseEffects(object.effects),
    raw: object
  };
}

function parseTextLayer(object: Record<string, unknown>): TextLayerConfig {
  const text = object.text;
  const value = typeof text === "string" ? text : String(plainValue((text as Record<string, unknown>)?.value, ""));
  return {
    value,
    font: typeof object.font === "string" ? object.font : "",
    pointSize: readNumber(plainValue(object.pointsize, 32), 32),
    color: readVec(plainValue(object.color, "1 1 1"), 3) as TextLayerConfig["color"],
    horizontalAlign: (object.horizontalalign as TextLayerConfig["horizontalAlign"]) ?? "left",
    verticalAlign: (object.verticalalign as TextLayerConfig["verticalAlign"]) ?? "top",
    padding: readVec(plainValue(object.padding, "0 0"), 2) as [number, number],
    spacing: readVec(plainValue(object.spacing, "0 0"), 2) as [number, number],
    maxWidth: readNumber(object.maxwidth, 0),
    maxRows: readNumber(object.maxrows, 1),
    limitWidth: Boolean(object.limitwidth),
    limitRows: Boolean(object.limitrows),
    limitUseEllipsis: Boolean(object.limituseellipsis)
  };
}

function parseEffects(input: unknown): EffectInstance[] {
  if (!Array.isArray(input)) return [];
  return (input as Array<Record<string, unknown>>).map((effect) => {
    const visibility = isVisible(effect.visible);
    return {
      file: String(effect.file ?? ""),
      id: readNumber(effect.id, 0),
      name: typeof effect.name === "string" ? effect.name : "",
      visible: visibility.visible,
      passes: Array.isArray(effect.passes)
        ? (effect.passes as Array<Record<string, unknown>>).map((pass) => ({
            id: readNumber(pass.id, 0),
            combos: pass.combos as Record<string, number> | undefined,
            constantshadervalues: pass.constantshadervalues as Record<string, unknown> | undefined,
            textures: Array.isArray(pass.textures) ? (pass.textures as string[]) : undefined
          }))
        : []
    };
  });
}

export function parseMaterialPass(pass: Record<string, unknown>): MaterialPass {
  return {
    shader: String(pass.shader ?? ""),
    textures: Array.isArray(pass.textures) ? (pass.textures as string[]).map(String) : [],
    combos: (pass.combos as Record<string, number>) ?? {},
    constantshader: (pass.constantshader as Record<string, string>) ?? {},
    constantshadervalues: (pass.constantshadervalues as Record<string, unknown>) ?? {},
    blending: (pass.blending as MaterialPass["blending"]) ?? "normal",
    cullMode: (pass.cullmode as MaterialPass["cullMode"]) ?? "nocull",
    depthTest: pass.depthtest === undefined ? true : pass.depthtest !== "disabled" && pass.depthtest !== false,
    depthWrite: pass.depthwrite === undefined ? true : pass.depthwrite !== "disabled" && pass.depthwrite !== false,
    alphaWriting: String(pass.alphawriting ?? "default")
  };
}
