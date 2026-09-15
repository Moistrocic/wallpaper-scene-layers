import { readNumber, readVec } from "../util/bytes.js";
import { TURBULENCE_TIME_FACTOR, numberDefault, vectorDefault } from "./particle-defaults.js";

export interface ParticleDefinition {
  material: string;
  maxCount: number;
  startTime: number;
  emitters: Array<Record<string, unknown>>;
  initializers: Array<Record<string, unknown>>;
  operators: Array<Record<string, unknown>>;
  renderers: Array<Record<string, unknown>>;
  children: Array<{ id: number; name: string }>;
  raw: Record<string, unknown>;
}

interface Particle {
  alive: boolean;
  life: number;
  lifeMax: number;
  position: [number, number, number];
  velocity: [number, number, number];
  /** Size drawn by the initialisers; operators multiply their own factor in. */
  sizeStart: number;
  sizeChange: number;
  sizeOscillate: number;
  color: [number, number, number];
  /** Several operators write alpha, so each keeps its own factor. */
  baseAlpha: number;
  alphaFade: number;
  alphaOscillate: number;
  alphaChange: number;
  rotation: number;
  angularVelocity: number;
  seed: number;
  age: number;
  /** Random values drawn once at spawn: recomputing them per frame would jitter. */
  turbulenceSpeed: number;
  turbulencePhase: number;
  oscillateFrequency: number;
  /** 漂移基础速度（开启 drift 时使用；湍流只在其上叠加扰动）。 */
  driftVelocity: [number, number, number];
  /** Direction seeded by the emitter, consumed by velocity initialisers. */
  pendingDirection?: [number, number, number];
  /** Offset relative to the parent particle, for sub emitters. */
  localOffset?: [number, number, number];
}

/**
 * 官方默认值表（见 `particle-defaults.ts`）：组件属性在预设里被省略时使用。
 * 表里每一项都标注了出处（引擎自带组件预览工程 / 240 个官方预设的统计）。
 */
export { TURBULENCE_TIME_FACTOR } from "./particle-defaults.js";

/** 湍流的空间频率默认值，取自引擎自带的 turbulence 组件预览工程。 */
export const DEFAULT_TURBULENCE_SCALE = numberDefault("turbulence", "scale");

/**
 * 湍流运算符的默认值解析：优先取算子自己写的值，其次官方默认值表。
 */
function operatorDefault(operator: Record<string, unknown>, property: string, fallback = 0): number {
  return numberDefault(String(operator.name ?? ""), property, fallback);
}

function operatorVector(operator: Record<string, unknown>, property: string, fallback: string): string {
  return vectorDefault(String(operator.name ?? ""), property, fallback);
}

function initializerDefault(initializer: Record<string, unknown>, property: string, fallback = 0): number {
  return numberDefault(String(initializer.name ?? ""), property, fallback);
}

function initializerVector(initializer: Record<string, unknown>, property: string, fallback: string): string {
  return vectorDefault(String(initializer.name ?? ""), property, fallback);
}

/** `distancemax` 这类字段既可能是标量也可能是向量（"512 256 0"）。 */
function readScalarOrVector(value: unknown, fallbackScalar: number, size: 3): number[] {
  if (typeof value === "string") return readVec(value, size);
  if (Array.isArray(value)) return readVec(value, size);
  const scalar = readNumber(value, fallbackScalar);
  return [scalar, scalar, scalar];
}

/**
 * 粒子漂移取向（"上浮 + 主方向偏移"）。
 *
 * 引擎的 `turbulence` 是各向同性的噪声速度场，本身不产生方向偏好；而壁纸里常见的
 * "灰烬整体往上飘、多数被吹向一侧、少量反向"是**取向需求**，因此这里做成显式模型：
 * 每个粒子生成时取一个基础速度 `主方向 × speed`（默认用发射器的 directions），
 * 再按 `forwardRatio` 决定它沿主方向还是反向，并叠加竖直的 `rise` 与角度抖动 `spread`。
 *
 * 开启后 `turbulence` 由"设置速度"变为"在基础速度上叠加扰动"（权重 `turbulence`），
 * 这样漂移趋势不会被噪声抹平。
 */
export interface ParticleDriftOptions {
  /** 竖直方向的基础速度，正数表示从下往上（场景单位/秒）。 */
  rise?: number;
  /** 水平基础速度大小（场景单位/秒）。 */
  speed?: number;
  /** 沿主方向的粒子比例，其余取反方向，例如 0.75 = 四分之三从左往右。 */
  forwardRatio?: number;
  /** 主方向的角度抖动（弧度），让粒子不至于整齐划一。 */
  spread?: number;
  /** 是否用发射器的 `directions` 作为主方向（默认 true；设为 false 则用 +X）。 */
  useEmitterDirection?: boolean;
  /** 开启漂移后湍流扰动的权重（0 = 完全平滑，1 = 与原来一样强）。 */
  turbulence?: number;
}

/** Host side overrides for the two engine defaults this runtime has to infer. */
export interface ParticleOptions {
  /** 上浮 / 定向漂移，省略则完全按引擎语义（各向同性湍流）。 */
  drift?: ParticleDriftOptions | true;
  /** 湍流空间频率，默认取官方预览工程的 0.0025。 */
  turbulenceScale?: number;
  /** `timescale` 到噪声时钟的映射系数（引擎文档未覆盖，默认 0.02）。 */
  turbulenceTimeFactor?: number;
}

// 2D value noise with a fixed permutation table, used to build the flow field.
const PERMUTATION = new Uint8Array(512);
(() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  // Deterministic shuffle so every run of a scene looks the same.
  let seed = 1337;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    const swap = table[i];
    table[i] = table[j];
    table[j] = swap;
  }
  for (let i = 0; i < 512; i++) PERMUTATION[i] = table[i & 255];
})();

function fadeCurve(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function latticeValue(x: number, y: number, z: number): number {
  return PERMUTATION[(PERMUTATION[(PERMUTATION[x & 255] + (y & 255)) & 255] + (z & 255)) & 255] / 255;
}

/** 3D value noise in [-1, 1]; the third axis lets the flow field evolve in time. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = fadeCurve(xf);
  const v = fadeCurve(yf);
  const w = fadeCurve(zf);
  const c000 = latticeValue(xi, yi, zi);
  const c100 = latticeValue(xi + 1, yi, zi);
  const c010 = latticeValue(xi, yi + 1, zi);
  const c110 = latticeValue(xi + 1, yi + 1, zi);
  const c001 = latticeValue(xi, yi, zi + 1);
  const c101 = latticeValue(xi + 1, yi, zi + 1);
  const c011 = latticeValue(xi, yi + 1, zi + 1);
  const c111 = latticeValue(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 2 - 1;
}

/**
 * Divergence free flow: the curl of a scalar noise field. Particles swirl along
 * the field instead of piling up in sinks, which is what makes the ember presets
 * drift across the screen instead of staying at the emitter.
 */
export function curlNoise(x: number, y: number, z: number, out: [number, number]): [number, number] {
  const epsilon = 0.75;
  const up = noise3(x, y + epsilon, z);
  const down = noise3(x, y - epsilon, z);
  const right = noise3(x + epsilon, y, z);
  const left = noise3(x - epsilon, y, z);
  out[0] = (up - down) / (2 * epsilon);
  out[1] = -(right - left) / (2 * epsilon);
  return out;
}

export function parseParticleDefinition(json: Record<string, unknown>): ParticleDefinition {
  return {
    material: String(json.material ?? ""),
    maxCount: Math.max(1, Math.round(readNumber(json.maxcount, 100))),
    startTime: readNumber(json.starttime, 0),
    emitters: asArray(json.emitter),
    initializers: asArray(json.initializer),
    operators: asArray(json.operator),
    renderers: asArray(json.renderer),
    children: Array.isArray(json.children)
      ? (json.children as Array<Record<string, unknown>>)
          .filter((child) => typeof child?.name === "string")
          .map((child) => ({ id: readNumber(child.id, 0), name: String(child.name) }))
      : [],
    raw: json
  };
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function ramp(): number {
  return Math.random();
}

function randomRange(min: number, max: number): number {
  return min + (max - min) * ramp();
}

/** HSV (all components 0..1) to RGB, matching the engine's `hsvcolorrandom`. */
function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
  const h = ((hue % 1) + 1) % 1 * 6;
  const c = value * saturation;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = value - c;
  const table: Array<[number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ];
  const [r, g, b] = table[Math.min(5, Math.floor(h))];
  return [r + m, g + m, b + m];
}

/**
 * CPU simulation of the Wallpaper Engine particle system.
 *
 * The engine evaluates emitters, initialisers and operators in script order;
 * the implementations below mirror the documented behaviour of the operators
 * that shipped presets actually use. Unknown operators are ignored rather than
 * failing, so a scene always renders something sensible.
 */
/**
 * `drift: true` 时使用的默认取向参数：整体上升、约四分之三向右、其余向左，
 * 这些取值是按"灰烬从下方升起、多数被吹向一侧、少量反向"的观感调出来的。
 */
const DEFAULT_DRIFT = { rise: 120, speed: 200, forwardRatio: 0.8, spread: 0.6 };

/** 漂移模式下湍流扰动的权重（预设里的湍流速度通常远大于漂移速度）。 */
const DEFAULT_DRIFT_TURBULENCE = 0.15;

/** 漂移模式下保留多少初始化器给出的速度（其余被主方向取代）。 */
const DRIFT_JITTER = 0.25;

/** Reused by `curlNoise` so the simulation allocates nothing per frame. */
const CURL_SCRATCH: [number, number] = [0, 0];

export class ParticleSystem {
  private readonly particles: Particle[] = [];
  private spawnAccumulator = 0;
  private elapsed = 0;
  private readonly unknown: Set<string> = new Set();

  /**
   * \`parent\` turns this system into a sub emitter: it mirrors the parent's
   * particles one to one instead of running its own emitter, which is how the
   * engine attaches glow sprites to ash beams.
   */
  constructor(readonly definition: ParticleDefinition, private readonly parent?: ParticleSystem, private readonly options: ParticleOptions = {}) {
    for (let i = 0; i < definition.maxCount; i++) {
      this.particles.push({
        alive: false,
        life: 0,
        lifeMax: 1,
        position: [0, 0, 0],
        velocity: [0, 0, 0],
        sizeStart: 1,
        sizeChange: 1,
        sizeOscillate: 1,
        color: [1, 1, 1],
        baseAlpha: 1,
        alphaFade: 1,
        alphaOscillate: 1,
        alphaChange: 1,
        rotation: 0,
        angularVelocity: 0,
        seed: Math.random() * 1000,
        age: 0,
        turbulenceSpeed: 0,
        turbulencePhase: 0,
        oscillateFrequency: 1,
        driftVelocity: [0, 0, 0]
      });
    }
  }

  get aliveCount(): number {
    let count = 0;
    for (const particle of this.particles) if (particle.alive) count++;
    return count;
  }

  /** Names of operators/initialisers that were skipped, for diagnostics. */
  get unsupported(): string[] {
    return [...this.unknown];
  }

  reset(): void {
    for (const particle of this.particles) particle.alive = false;
    this.spawnAccumulator = 0;
    this.elapsed = 0;
  }

  /** Particles slots; the index is stable so sub emitters can mirror them. */
  get slots(): readonly Particle[] {
    return this.particles;
  }

  update(deltaSeconds: number): void {
    const dt = Math.min(Math.max(deltaSeconds, 0), 1 / 20);
    this.elapsed += dt;
    if (this.parent) {
      this.updateFromParent(dt);
      return;
    }
    if (this.elapsed < this.definition.startTime) return;

    for (const emitter of this.definition.emitters) {
      const name = String(emitter.name ?? "boxrandom");
      const rate = readNumber(emitter.rate, numberDefault(name, "rate", 10));
      // duration > 0 stops the emitter after that many seconds (0 = forever).
      const duration = readNumber(emitter.duration, numberDefault(name, "duration", 0));
      if (duration > 0 && this.elapsed > this.definition.startTime + duration) continue;
      this.spawnAccumulator += rate * dt;
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1;
        this.spawn(emitter);
      }
    }

    for (const particle of this.particles) {
      if (!particle.alive) continue;
      particle.age += dt;
      particle.life -= dt;
      if (particle.life <= 0) {
        particle.alive = false;
        continue;
      }
      for (const operator of this.definition.operators) this.applyOperator(particle, operator, dt);
    }
  }

  /** Mirrors the parent system's particles, keeping stable slot indices. */
  private updateFromParent(dt: number): void {
    const parents = this.parent!.slots;
    for (let index = 0; index < parents.length && index < this.particles.length; index++) {
      const source = parents[index];
      const particle = this.particles[index];
      if (!source.alive) {
        particle.alive = false;
        continue;
      }
      if (!particle.alive) {
        particle.alive = true;
        particle.age = 0;
        particle.color = [1, 1, 1];
        particle.baseAlpha = 1;
        particle.alphaFade = 1;
        particle.alphaOscillate = 1;
        particle.alphaChange = 1;
        particle.rotation = 0;
        particle.angularVelocity = 0;
        particle.velocity = [0, 0, 0];
        particle.seed = Math.random() * 1000;
        particle.sizeStart = 1;
        particle.sizeChange = 1;
        particle.sizeOscillate = 1;
        particle.driftVelocity = [0, 0, 0];
        this.seedTurbulence(particle);
        particle.localOffset = [
          (Math.random() - 0.5) * Math.max(1, source.sizeStart) * 0.2,
          (Math.random() - 0.5) * Math.max(1, source.sizeStart) * 0.2,
          0
        ];
        for (const initializer of this.definition.initializers) this.applyInitializer(particle, initializer);
      }
      particle.age = source.age;
      particle.life = source.life;
      particle.lifeMax = source.lifeMax;
      const offset = particle.localOffset ?? [0, 0, 0];
      particle.position = [source.position[0] + offset[0], source.position[1] + offset[1], source.position[2] + offset[2]];
      for (const operator of this.definition.operators) this.applyOperator(particle, operator, dt);
    }
  }

  private spawn(emitter: Record<string, unknown>): void {
    const particle = this.particles.find((candidate) => !candidate.alive);
    if (!particle) return;
    const name = String(emitter.name ?? "boxrandom");
    particle.alive = true;
    particle.age = 0;
    particle.life = 1;
    particle.lifeMax = 1;
    particle.sizeStart = 1;
    particle.sizeChange = 1;
    particle.sizeOscillate = 1;
    particle.color = [1, 1, 1];
    particle.baseAlpha = 1;
    particle.alphaFade = 1;
    particle.alphaOscillate = 1;
    particle.alphaChange = 1;
    particle.rotation = 0;
    particle.angularVelocity = 0;
    particle.velocity = [0, 0, 0];
    particle.seed = Math.random() * 1000;
    particle.driftVelocity = [0, 0, 0];
    this.seedTurbulence(particle);

    // 官方发射器参数：distancemin / distancemax 既可能是标量也可能是向量。
    const distanceMin = readScalarOrVector(emitter.distancemin, numberDefault(name, "distancemin", 0), 3);
    const distanceMax = readScalarOrVector(emitter.distancemax ?? emitter.distance, numberDefault(name, "distancemax", 0), 3);
    const directions = readVec(emitter.directions ?? vectorDefault(name, "directions", "0 1 0"), 3);

    switch (name) {
      case "boxrandom":
      case "box":
        // 每个轴在 ±[min, max] 之间取随机值。
        particle.position = [
          0, 1, 2
        ].map((axis) => {
          const magnitude = randomRange(distanceMin[axis], Math.max(distanceMin[axis], distanceMax[axis]));
          return (Math.random() < 0.5 ? -magnitude : magnitude);
        }) as [number, number, number];
        break;
      case "sphererandom":
      case "sphere": {
        let x = 0;
        let y = 0;
        let z = 0;
        let length = 0;
        do {
          x = Math.random() * 2 - 1;
          y = Math.random() * 2 - 1;
          z = Math.random() * 2 - 1;
          length = Math.hypot(x, y, z);
        } while (length > 1 || length === 0);
        // distancemin..distancemax 定义的是球壳；min = 0 时就是实心球。
        const radius = randomRange(distanceMin[0], Math.max(distanceMin[0], distanceMax[0]));
        particle.position = [(x / length) * radius, (y / length) * radius, (z / length) * radius];
        break;
      }
      default:
        if (!this.unknown.has(`emitter:${name}`)) this.unknown.add(`emitter:${name}`);
        particle.position = [0, 0, 0];
        break;
    }

    // 发射器自身可以给一个基础速度（speedmin/speedmax），初始化器再在此基础上细化。
    const directionLength = Math.hypot(directions[0], directions[1], directions[2]) || 1;
    const speedMin = readNumber(emitter.speedmin, numberDefault(name, "speedmin", 0));
    const speedMax = readNumber(emitter.speedmax, numberDefault(name, "speedmax", 0));
    const speed = randomRange(Math.min(speedMin, speedMax), Math.max(speedMin, speedMax));
    particle.pendingDirection = [directions[0] / directionLength, directions[1] / directionLength, directions[2] / directionLength];
    particle.velocity = [
      particle.pendingDirection[0] * speed,
      particle.pendingDirection[1] * speed,
      particle.pendingDirection[2] * speed
    ];
    for (const initializer of this.definition.initializers) this.applyInitializer(particle, initializer);
    // 漂移最后应用：初始化器（如 turbulentvelocityrandom）会重写速度，
    // 先应用就会被覆盖掉，趋势也就不成立了。
    this.applyDrift(particle, particle.pendingDirection);
  }

  /**
   * 上浮 / 定向漂移：每个粒子在生成时定下一个基础速度，
   * `forwardRatio` 决定它沿主方向还是反向，`rise` 保证整体向上，`spread` 提供角度抖动。
   */
  private applyDrift(particle: Particle, direction: [number, number, number]): void {
    const options = this.options.drift;
    if (!options) return;
    const drift = options === true ? {} : options;
    const rise = drift.rise ?? DEFAULT_DRIFT.rise;
    const speed = drift.speed ?? DEFAULT_DRIFT.speed;
    const forwardRatio = Math.min(1, Math.max(0, drift.forwardRatio ?? DEFAULT_DRIFT.forwardRatio));
    const spread = drift.spread ?? DEFAULT_DRIFT.spread;

    // 初始化器给出的速度保留一小部分，作为方向上的自然抖动。
    const initial = particle.velocity;
    const jitterX = initial[0] * DRIFT_JITTER;
    const jitterY = initial[1] * DRIFT_JITTER;

    const useEmitterDirection = drift.useEmitterDirection ?? true;
    const baseX = useEmitterDirection ? direction[0] : 1;
    const baseY = useEmitterDirection ? direction[1] : 0;
    const baseLength = Math.hypot(baseX, baseY) || 1;
    // 反向粒子只翻转水平分量：竖直方向始终保持向上，符合"全部都有从下往上的趋势"。
    const forward = Math.random() < forwardRatio ? 1 : -1;
    const jitter = (Math.random() * 2 - 1) * spread;
    const cos = Math.cos(jitter);
    const sin = Math.sin(jitter);
    const nx = baseX / baseLength;
    const ny = baseY / baseLength;
    // 角度抖动只作用在水平分量上，竖直分量始终由 rise 保底，
    // 这样"整体从下往上"是结构上保证的，而不是靠参数凑出来的。
    particle.driftVelocity = [
      (nx * cos - ny * sin) * speed * forward + jitterX,
      rise + ny * speed * forward + jitterY,
      0
    ];
    particle.velocity = [particle.driftVelocity[0], particle.driftVelocity[1], 0];
  }

  /** Draws the stable per particle randoms used by turbulence / alpha oscillators. */
  private seedTurbulence(particle: Particle): void {
    const turbulence = this.definition.operators.find((operator) => operator.name === "turbulence");
    if (turbulence) {
      const min = readNumber(turbulence.speedmin, operatorDefault(turbulence, "speedmin"));
      const max = readNumber(turbulence.speedmax, operatorDefault(turbulence, "speedmax", min));
      particle.turbulenceSpeed = randomRange(min, max);
      particle.turbulencePhase = randomRange(
        readNumber(turbulence.phasemin, operatorDefault(turbulence, "phasemin")),
        readNumber(turbulence.phasemax, operatorDefault(turbulence, "phasemax", 1))
      );
    } else {
      particle.turbulenceSpeed = 0;
      particle.turbulencePhase = 0;
    }
    const oscillate = this.definition.operators.find((operator) => operator.name === "oscillatealpha");
    particle.oscillateFrequency = oscillate
      ? randomRange(
          readNumber(oscillate.frequencymin, operatorDefault(oscillate, "frequencymin", 1)),
          readNumber(oscillate.frequencymax, operatorDefault(oscillate, "frequencymax", 1))
        )
      : 1;
  }

  private applyInitializer(particle: Particle, initializer: Record<string, unknown>): void {
    const name = String(initializer.name ?? "");
    switch (name) {
      case "lifetimerandom":
      case "lifetime":
        particle.lifeMax = Math.max(
          0.01,
          randomRange(
            readNumber(initializer.min, initializerDefault(initializer, "min", 1)),
            readNumber(initializer.max, initializerDefault(initializer, "max", 1))
          )
        );
        particle.life = particle.lifeMax;
        break;
      case "sizerandom":
      case "size": {
        const min = readNumber(initializer.min, initializerDefault(initializer, "min", 1));
        const max = readNumber(initializer.max, initializerDefault(initializer, "max", 1));
        const exponent = readNumber(initializer.exponent, initializerDefault(initializer, "exponent", 1));
        particle.sizeStart = Math.pow(randomRange(0, 1), exponent) * (max - min) + min;
        break;
      }
      case "positionoffsetrandom": {
        // Offsets the spawn position through a noise field (amplitude, scale, timescale).
        const distance = readNumber(initializer.distance, initializerDefault(initializer, "distance", 0));
        const spatialScale = readNumber(initializer.scale, initializerDefault(initializer, "scale", 0));
        const timeScale = readNumber(initializer.timescale, initializerDefault(initializer, "timescale", 0));
        const time = this.elapsed * timeScale * (this.options.turbulenceTimeFactor ?? TURBULENCE_TIME_FACTOR);
        particle.position = [
          particle.position[0] + noise3(particle.seed * 0.13, 0, time) * distance,
          particle.position[1] + noise3(0, particle.seed * 0.17, time) * distance,
          particle.position[2] + noise3(particle.seed * 0.19, spatialScale, time) * distance
        ];
        break;
      }
      case "hsvcolorrandom": {
        const hue = randomRange(
          readNumber(initializer.huemin, initializerDefault(initializer, "huemin", 0)),
          readNumber(initializer.huemax, initializerDefault(initializer, "huemax", 1))
        );
        const saturation = randomRange(
          readNumber(initializer.saturationmin, initializerDefault(initializer, "saturationmin", 1)),
          readNumber(initializer.saturationmax, initializerDefault(initializer, "saturationmax", 1))
        );
        const value = randomRange(
          readNumber(initializer.valuemin, initializerDefault(initializer, "valuemin", 1)),
          readNumber(initializer.valuemax, initializerDefault(initializer, "valuemax", 1))
        );
        particle.color = hsvToRgb(hue, saturation, value);
        break;
      }
      case "colorrandom":
      case "color": {
        const min = readVec(initializer.min ?? initializerVector(initializer, "min", "255 255 255"), 3);
        const max = readVec(initializer.max ?? initializerVector(initializer, "max", "255 255 255"), 3);
        particle.color = [
          randomRange(min[0], max[0]) / 255,
          randomRange(min[1], max[1]) / 255,
          randomRange(min[2], max[2]) / 255
        ];
        break;
      }
      case "alpharandom":
      case "alpha": {
        const min = readNumber(initializer.min, initializerDefault(initializer, "min", 1));
        const max = readNumber(initializer.max, initializerDefault(initializer, "max", 1));
        particle.baseAlpha = randomRange(min, max);
        break;
      }
      case "velocityrandom":
      case "turbulentvelocityrandom": {
        const min = readNumber(initializer.speedmin, readNumber(initializer.min, initializerDefault(initializer, "speedmin", 0)));
        const max = readNumber(initializer.speedmax, readNumber(initializer.max, Math.max(min, initializerDefault(initializer, "speedmax", min))));
        const speed = randomRange(min, max);
        const direction = particle.pendingDirection ?? [0, 1, 0];
        const scale = readNumber(initializer.scale, initializerDefault(initializer, "scale", 1));
        const offset = readNumber(initializer.offset, initializerDefault(initializer, "offset", 0));
        // A little noise on top of the emitter direction keeps the motion organic.
        particle.velocity = [
          (direction[0] + (Math.random() - 0.5 + offset) * scale) * speed,
          (direction[1] + (Math.random() - 0.5 + offset) * scale) * speed,
          (direction[2] + (Math.random() - 0.5 + offset) * scale) * speed * 0.2
        ];
        break;
      }
      case "rotationrandom":
        particle.rotation = randomRange(
          readNumber(initializer.min, initializerDefault(initializer, "min", 0)),
          readNumber(initializer.max, initializerDefault(initializer, "max", Math.PI * 2))
        );
        break;
      case "angularvelocityrandom":
        particle.angularVelocity = randomRange(
          readNumber(initializer.min, initializerDefault(initializer, "min", -1)),
          readNumber(initializer.max, initializerDefault(initializer, "max", 1))
        );
        break;
      case "offsetrandom": {
        const min = readVec(initializer.min ?? initializerVector(initializer, "min", "0 0 0"), 3);
        const max = readVec(initializer.max ?? initializerVector(initializer, "max", "0 0 0"), 3);
        particle.position = [
          particle.position[0] + randomRange(min[0], max[0]),
          particle.position[1] + randomRange(min[1], max[1]),
          particle.position[2] + randomRange(min[2], max[2])
        ];
        break;
      }
      default:
        if (name && !this.unknown.has(`initializer:${name}`)) this.unknown.add(`initializer:${name}`);
        break;
    }
  }

  private applyOperator(particle: Particle, operator: Record<string, unknown>, dt: number): void {
    const name = String(operator.name ?? "");
    const lifeRatio = particle.lifeMax > 0 ? 1 - particle.life / particle.lifeMax : 1;
    switch (name) {
      case "movement": {
        const gravity = readVec(operator.gravity ?? operatorVector(operator, "gravity", "0 0 0"), 3);
        const drag = readNumber(operator.drag, operatorDefault(operator, "drag", 0));
        particle.velocity[0] += gravity[0] * dt;
        particle.velocity[1] += gravity[1] * dt;
        particle.velocity[2] += gravity[2] * dt;
        if (drag > 0) {
          // `drag` is a rate per second, not a fraction: the engine's own examples
          // use values above 1 (drag 4 = velocity gone in a quarter second), so
          // damping has to clamp at zero instead of feeding a negative base into
          // a power function.
          const damping = Math.max(0, 1 - drag * dt);
          particle.velocity[0] *= damping;
          particle.velocity[1] *= damping;
          particle.velocity[2] *= damping;
        }
        particle.position[0] += particle.velocity[0] * dt;
        particle.position[1] += particle.velocity[1] * dt;
        particle.position[2] += particle.velocity[2] * dt;
        break;
      }
      case "alphafade": {
        const fadeIn = readNumber(operator.fadeintime, operatorDefault(operator, "fadeintime", 0));
        const fadeOut = readNumber(operator.fadeouttime, operatorDefault(operator, "fadeouttime", 0));
        let fade = 1;
        if (fadeIn > 0 && particle.age < fadeIn) fade *= particle.age / fadeIn;
        if (fadeOut > 0) {
          const remaining = particle.lifeMax - particle.age;
          if (remaining < fadeOut) fade *= Math.max(0, remaining / fadeOut);
        }
        particle.alphaFade = fade;
        break;
      }
      case "turbulence": {
        // The turbulence operator *is* the flow field: it drives the particle
        // velocity from a divergence free noise field, it does not accumulate.
        // Presets without a speed (or a scale) fall back to engine defaults.
        const mask = readVec(operator.mask ?? operatorVector(operator, "mask", "1 1 1"), 3);
        const timeScale = readNumber(operator.timescale, operatorDefault(operator, "timescale", 1));
        const spatialScale = readNumber(operator.scale, this.options.turbulenceScale ?? DEFAULT_TURBULENCE_SCALE);
        const timeFactor = this.options.turbulenceTimeFactor ?? TURBULENCE_TIME_FACTOR;
        const speed = particle.turbulenceSpeed;
        if (speed > 0) {
          const time = this.elapsed * timeScale * timeFactor + particle.turbulencePhase;
          const [vx, vy] = curlNoise(
            particle.position[0] * spatialScale + particle.turbulencePhase,
            particle.position[1] * spatialScale - particle.turbulencePhase,
            time,
            CURL_SCRATCH
          );
          // The field only supplies a direction: `speed` is the actual particle
          // speed the preset asks for, so normalise before scaling by the mask.
          const length = Math.hypot(vx, vy) || 1;
          const swirl = Math.sin(time * 1.7 + particle.seed) * 0.35;
          const drift = this.options.drift;
          if (drift) {
            // 开启漂移时，湍流退化为叠加在基础速度上的扰动，
            // 权重远小于 1，否则各向同性的噪声会把"整体上浮 + 主方向偏移"抹平。
            const weight = (drift === true ? undefined : drift.turbulence) ?? DEFAULT_DRIFT_TURBULENCE;
            // 向下的扰动最多抵消 60% 的上浮速度，因此净速度永远向上。
            const wobbleY = (vy / length) * speed * mask[1] * weight;
            particle.velocity[0] = particle.driftVelocity[0] + (vx / length) * speed * mask[0] * weight;
            particle.velocity[1] = particle.driftVelocity[1] + Math.max(wobbleY, -particle.driftVelocity[1] * 0.6);
            particle.velocity[2] = particle.driftVelocity[2] + swirl * speed * mask[2] * weight;
          } else {
            particle.velocity[0] = (vx / length) * speed * mask[0];
            particle.velocity[1] = (vy / length) * speed * mask[1];
            particle.velocity[2] = swirl * speed * mask[2];
          }
        }
        break;
      }
      case "oscillatealpha": {
        const min = readNumber(operator.scalemin, operatorDefault(operator, "scalemin", 0.5));
        const wave = (Math.sin(this.elapsed * particle.oscillateFrequency * Math.PI * 2 + particle.seed) + 1) * 0.5;
        particle.alphaOscillate = min + (1 - min) * wave;
        break;
      }
      case "sizechange": {
        // Ramps the size from `startvalue` to `endvalue` starting at `starttime`.
        const startTime = readNumber(operator.starttime, operatorDefault(operator, "starttime", 0.5));
        const startValue = readNumber(operator.startvalue, operatorDefault(operator, "startvalue", 1));
        const endValue = readNumber(operator.endvalue, operatorDefault(operator, "endvalue", 0));
        if (lifeRatio <= startTime) {
          particle.sizeChange = startValue;
        } else {
          const progress = (lifeRatio - startTime) / Math.max(0.0001, 1 - startTime);
          particle.sizeChange = startValue + (endValue - startValue) * Math.min(1, progress);
        }
        break;
      }
      case "oscillatesize": {
        const min = readNumber(operator.scalemin, operatorDefault(operator, "scalemin", 0.9));
        const max = readNumber(operator.scalemax, operatorDefault(operator, "scalemax", 1.1));
        const frequencyMin = readNumber(operator.frequencymin, operatorDefault(operator, "frequencymin", 1));
        const frequencyMax = readNumber(operator.frequencymax, operatorDefault(operator, "frequencymax", frequencyMin));
        const frequency = randomRange(Math.min(frequencyMin, frequencyMax), Math.max(frequencyMin, frequencyMax));
        const wave = (Math.sin(this.elapsed * frequency * Math.PI * 2 + particle.seed) + 1) * 0.5;
        particle.sizeOscillate = min + (max - min) * wave;
        break;
      }
      case "angularmovement": {
        // 官方角度算子参数是三维力矩 force（预览工程用 "0 0 10"），二维场景取 z 轴。
        const force = readVec(operator.force ?? operatorVector(operator, "force", "0 0 0"), 3);
        particle.angularVelocity += force[2] * dt;
        particle.rotation += particle.angularVelocity * dt;
        break;
      }
      case "oscillateposition": {
        const frequencyMin = readNumber(operator.frequencymin, operatorDefault(operator, "frequencymin", 1));
        const frequencyMax = readNumber(operator.frequencymax, operatorDefault(operator, "frequencymax", frequencyMin));
        const frequency = randomRange(Math.min(frequencyMin, frequencyMax), Math.max(frequencyMin, frequencyMax));
        const scaleMin = readNumber(operator.scalemin, operatorDefault(operator, "scalemin", 0.1));
        const scaleMax = readNumber(operator.scalemax, operatorDefault(operator, "scalemax", scaleMin));
        const scale = randomRange(Math.min(scaleMin, scaleMax), Math.max(scaleMin, scaleMax));
        particle.position[0] += Math.sin(this.elapsed * frequency * Math.PI * 2 + particle.seed) * scale * dt;
        particle.position[1] += Math.cos(this.elapsed * frequency * Math.PI * 2 + particle.seed) * scale * dt;
        break;
      }
      case "colorchange": {
        // Colour ramp between two keys over the particle lifetime. Unlike
        // `colorrandom` the keys are normalised (0..1), not 0..255.
        const startTime = readNumber(operator.starttime, operatorDefault(operator, "starttime", 0));
        const endTime = readNumber(operator.endtime, operatorDefault(operator, "endtime", 1));
        const start = readVec(operator.startvalue ?? operatorVector(operator, "startvalue", "1 1 1"), 3);
        const end = readVec(operator.endvalue ?? operatorVector(operator, "endvalue", "1 1 1"), 3);
        const span = Math.max(1e-4, endTime - startTime);
        const amount = Math.min(1, Math.max(0, (lifeRatio - startTime) / span));
        particle.color = [start[0] + (end[0] - start[0]) * amount, start[1] + (end[1] - start[1]) * amount, start[2] + (end[2] - start[2]) * amount];
        break;
      }
      case "alphachange": {
        const startTime = readNumber(operator.starttime, operatorDefault(operator, "starttime", 0));
        const endTime = readNumber(operator.endtime, operatorDefault(operator, "endtime", 1));
        const startValue = readNumber(operator.startvalue, operatorDefault(operator, "startvalue", 1));
        const endValue = readNumber(operator.endvalue, operatorDefault(operator, "endvalue", 1));
        const span = Math.max(1e-4, endTime - startTime);
        const amount = Math.min(1, Math.max(0, (lifeRatio - startTime) / span));
        particle.alphaChange = startValue + (endValue - startValue) * amount;
        break;
      }
      case "capvelocity": {
        const maxSpeed = readNumber(operator.maxspeed, operatorDefault(operator, "maxspeed", 0));
        const speed = Math.hypot(particle.velocity[0], particle.velocity[1], particle.velocity[2]);
        if (maxSpeed > 0 && speed > maxSpeed) {
          const scale = maxSpeed / speed;
          particle.velocity[0] *= scale;
          particle.velocity[1] *= scale;
          particle.velocity[2] *= scale;
        }
        break;
      }
      case "vortex":
      case "vortex_v2": {
        // Swirl around the control point at the particle system origin.
        const inner = readNumber(operator.distanceinner, operatorDefault(operator, "distanceinner", 0));
        const outer = readNumber(operator.distanceouter, operatorDefault(operator, "distanceouter", inner));
        const speedInner = readNumber(operator.speedinner, operatorDefault(operator, "speedinner", 0));
        const speedOuter = readNumber(operator.speedouter, operatorDefault(operator, "speedouter", speedInner));
        const distance = Math.hypot(particle.position[0], particle.position[1]);
        const amount = outer > inner ? Math.min(1, Math.max(0, (distance - inner) / (outer - inner))) : 1;
        const speed = speedInner + (speedOuter - speedInner) * amount;
        if (speed !== 0 && distance > 1e-3) {
          // Tangential direction of the axis aligned swirl.
          particle.velocity[0] += (-particle.position[1] / distance) * speed * dt;
          particle.velocity[1] += (particle.position[0] / distance) * speed * dt;
        }
        break;
      }
      case "controlpointattract":
      case "controlpoint":
        // Control point driven motion needs the editor's control point setup,
        // which scenes rarely animate in a way a static viewer can reproduce.
        break;
      default:
        if (name && !this.unknown.has(`operator:${name}`)) this.unknown.add(`operator:${name}`);
        break;
    }
  }

  /**
   * Writes the visible particles as triangles (`x, y, z, u, v, r, g, b, a`).
   * Returns the number of vertices written.
   *
   * The quad follows the engine's `ComputeParticlePosition`: `size` is the
   * *width* of the sprite in scene units and the height is
   * `size * (textureHeight / textureWidth)`, which is what keeps non square
   * sprites such as the 32x128 beam textures from being squashed into squares.
   */
  buildVertices(target: Float32Array, stride = 9, textureAspect = 1): number {
    const renderer = this.definition.renderers[0] ?? { name: "sprite" };
    const name = String(renderer.name ?? "sprite");
    if (name !== "sprite" && name !== "spritetrail" && !this.unknown.has(`renderer:${name}`)) {
      // Rope renderers need the 3D rope solver; draw them as sprites instead.
      this.unknown.add(`renderer:${name}`);
    }
    const lengthScale = readNumber(renderer.length, numberDefault(name, "length", 0.02));
    const minLength = readNumber(renderer.minlength, numberDefault(name, "minlength", 0));
    const maxLength = readNumber(renderer.maxlength, numberDefault(name, "maxlength", Number.POSITIVE_INFINITY));
    let vertex = 0;
    for (const particle of this.particles) {
      if (!particle.alive) continue;
      const size = particle.sizeStart * particle.sizeChange * particle.sizeOscillate;
      const half = size / 2;
      let ax = half;
      let ay = (size * textureAspect) / 2;
      let rotation = particle.rotation;
      if (name === "spritetrail") {
        // `ComputeParticleTrailTangents`: the sprite is stretched along the
        // velocity by clamp(speed * length, minlength, maxlength).
        const speed = Math.hypot(particle.velocity[0], particle.velocity[1]);
        const stretch = Math.min(maxLength, Math.max(minLength, speed * lengthScale));
        ay = (size * textureAspect * stretch) / 2;
        rotation = Math.atan2(particle.velocity[1], particle.velocity[0]) - Math.PI / 2;
      }
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const corners: Array<[number, number, number, number]> = [
        [-ax, -ay, 0, 0],
        [ax, -ay, 1, 0],
        [ax, ay, 1, 1],
        [-ax, -ay, 0, 0],
        [ax, ay, 1, 1],
        [-ax, ay, 0, 1]
      ];
      const [r, g, b] = particle.color;
      const alpha = Math.min(1, Math.max(0, particle.baseAlpha * particle.alphaFade * particle.alphaOscillate * particle.alphaChange));
      for (const [cx, cy, u, v] of corners) {
        const x = particle.position[0] + cx * cos - cy * sin;
        const y = particle.position[1] + cx * sin + cy * cos;
        const base = vertex * stride;
        if (base + stride > target.length) return vertex;
        target[base] = x;
        target[base + 1] = y;
        target[base + 2] = particle.position[2];
        target[base + 3] = u;
        target[base + 4] = v;
        target[base + 5] = r;
        target[base + 6] = g;
        target[base + 7] = b;
        target[base + 8] = alpha;
        vertex++;
      }
    }
    return vertex;
  }
}
