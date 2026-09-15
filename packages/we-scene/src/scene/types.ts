import type { Vec2, Vec3, Vec4 } from "../util/math.js";

/** Anything in a `scene.json` that is a number may also be a script binding. */
export type Animated<T> = T | { value?: T; user?: string; script?: string };

/** The raw `scene.json` document, before it is normalised into layers. */
export interface SceneDocumentJSON {
  version?: unknown;
  general?: Record<string, unknown>;
  camera?: Record<string, unknown>;
  objects?: Array<Record<string, unknown>>;
}

export interface SceneGeneral {
  /** Orthographic view volume in scene units (3840 x 2160 by default). */
  orthographicProjection: { width: number; height: number };
  clearColor: Vec3;
  clearEnabled: boolean;
  ambientColor: Vec3;
  skylightColor: Vec3;
  cameraParallax: boolean;
  cameraParallaxAmount: number;
  cameraParallaxDelay: number;
  cameraParallaxMouseInfluence: number;
  cameraFade: boolean;
  cameraShake: boolean;
  zoom: number;
  fov: number;
  nearZ: number;
  farZ: number;
  hdr: boolean;
  bloom: boolean;
  windEnabled: boolean;
  windStrength: number;
  windDirection: Vec3;
  gravityStrength: number;
  gravityDirection: Vec3;
}

export interface SceneCamera {
  eye: Vec3;
  center: Vec3;
  up: Vec3;
}

/** A single pass of a material: one shader plus its textures and render state. */
export interface MaterialPass {
  /** Built in shader name (`genericimage4`) or a path to a custom `.vert`/`.frag` pair. */
  shader: string;
  /** Material texture names, resolved against `materials/`. */
  textures: string[];
  combos: Record<string, number>;
  constantshader: Record<string, string>;
  constantshadervalues: Record<string, unknown>;
  blending: BlendMode;
  cullMode: "nocull" | "back" | "front";
  depthTest: boolean;
  depthWrite: boolean;
  alphaWriting: string;
}

export type BlendMode = "normal" | "translucent" | "additive" | "multiplicative";

export interface MaterialDefinition {
  passes: MaterialPass[];
}

export interface ModelDefinition {
  material?: string;
  /** Layer size follows the texture size. */
  autosize?: boolean;
  /** 模型声明的层尺寸（工程里的模型常用它，此时图层可以不写 size）。 */
  width?: number;
  height?: number;
  solidlayer?: boolean;
  instanced?: boolean;
  /** Offsets the texture inside the layer quad. */
  cropOffset?: Vec2;
  /** Path of the file the model was loaded from (filled in by the parser). */
  source?: string;
}

export interface EffectPassDefinition {
  material: string;
  /** Render target name from `effect.fbos`. */
  target?: string;
  /** Remaps incoming textures: `previous` is the accumulated result. */
  bind?: Array<{ index: number; name: string }>;
}

export interface EffectFboDefinition {
  name: string;
  format: string;
}

export interface EffectDefinition {
  name?: string;
  description?: string;
  group?: string;
  version?: number;
  replacementKey?: string;
  fbos: EffectFboDefinition[];
  passes: EffectPassDefinition[];
  dependencies: string[];
}

/** An effect applied to a layer, with the per layer values baked into `scene.json`. */
export interface EffectInstance {
  /** `effects/<name>/effect.json` */
  file: string;
  id: number;
  name: string;
  visible: boolean;
  passes: EffectPassInstance[];
}

export interface EffectPassInstance {
  id: number;
  combos?: Record<string, number>;
  constantshadervalues?: Record<string, unknown>;
  /** Render targets this pass samples, e.g. `_rt_imageLayerComposite_57_a`. */
  textures?: string[];
}

export interface TextLayerConfig {
  value: string;
  font: string;
  pointSize: number;
  color: Vec3;
  horizontalAlign: "left" | "center" | "right";
  verticalAlign: "top" | "center" | "bottom";
  padding: Vec2;
  spacing: Vec2;
  maxWidth: number;
  maxRows: number;
  limitWidth: boolean;
  limitRows: boolean;
  limitUseEllipsis: boolean;
}

export type LayerType = "image" | "text" | "particle" | "solid" | "sound" | "model" | "unknown";

export interface LayerTransform {
  origin: Vec3;
  angles: Vec3;
  scale: Vec3;
  /** Layer size in scene units; `undefined` when the layer has no explicit size. */
  size?: Vec2;
  alignment: string;
  /** Ignore scene camera parallax / eye movement for this layer. */
  lockTransforms: boolean;
  /** Extra parallax offset applied on top of the camera parallax. */
  parallaxDepth: Vec2;
}

/** One entry of the `objects` array, normalised for rendering. */
export interface SceneLayer {
  id: number;
  name: string;
  type: LayerType;
  parentId: number | null;
  childIds: number[];
  /** Index in the scene's painting order (0 = furthest back). */
  index: number;
  visible: boolean;
  /** The `visible.user` property key when the layer is bound to a user property. */
  visibilityUser?: string;
  alpha: number;
  color: Vec4;
  transform: LayerTransform;
  /** `models/...json` for image layers. */
  image?: string;
  /** Set for layers that draw a flat colour. */
  solid: boolean;
  text?: TextLayerConfig;
  /** `particles/...json` for particle emitters. */
  particle?: string;
  effects: EffectInstance[];
  /** The untouched JSON entry, for tools that want to write scenes back out. */
  raw: Record<string, unknown>;
}
