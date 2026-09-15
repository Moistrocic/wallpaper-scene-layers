/**
 * 粒子组件的**官方默认值表**。
 *
 * Wallpaper Engine 把组件默认值编译在编辑器二进制里：预设文件只写「与默认值不同」
 * 的字段，所以 `ember.json` 里 `turbulence` 不写 `scale` 时，光看预设无法得知默认值。
 * 本文件把能查到出处的取值固化下来，替代先前散落在代码里的推断值。
 *
 * 取值来源（按可信度排序）：
 *
 * 1. `engine-preview` —— 引擎自带的**组件预览工程**：
 *    `<安装目录>/assets/scenes/particleelementpreviews/<组件>/particles/new_particle_system.json`。
 *    这是 WE 官方为每个粒子组件做的演示工程，里面的取值就是官方参数。
 * 2. `engine-content` —— 引擎自带的 **240 个粒子预设 + 6 个官方示例**的统计结果：
 *    某个属性在所有出现处取值唯一（或占绝大多数）时，该值即引擎默认值。
 * 3. `runtime-inferred` —— 前两者都没有覆盖到的属性（多为「省略即 0 / 关闭」的布尔与
 *    时间参数）。这些保持本库现有行为，并在此显式标注，便于将来替换。
 *
 * 重新生成统计：`node testbed/scripts/presets.mjs`（覆盖率）与本文件注释里的脚本思路一致。
 */

export type ParticleDefaultSource = "engine-preview" | "engine-content" | "runtime-inferred";

interface DefaultEntry {
  value: number | string;
  source: ParticleDefaultSource;
  /** 出处说明，写进 README 与 CLI 输出。 */
  evidence: string;
}

const PREVIEW = (component: string) =>
  `引擎组件预览工程 assets/scenes/particleelementpreviews/${component}/particles/new_particle_system.json`;

/**
 * 组件属性默认值。键为 `组件名.属性名`（与 scene.json / 预设 JSON 中的字段一致）。
 */
export const PARTICLE_DEFAULTS: Record<string, DefaultEntry> = {
  // ---------------------------------------------------------------- 发射器
  "sphererandom.rate": { value: 150, source: "engine-preview", evidence: PREVIEW("sphererandom") },
  "sphererandom.distancemin": { value: 0, source: "engine-content", evidence: "官方内容中 255 次出现里 200 次为 0" },
  "sphererandom.distancemax": { value: 500, source: "engine-preview", evidence: PREVIEW("sphererandom") },
  "sphererandom.duration": { value: 0, source: "engine-content", evidence: "官方内容中 32 次出现里 30 次为 0（持续发射）" },
  "sphererandom.speedmin": { value: 0, source: "engine-content", evidence: "官方内容中最常见取值 0（27/56）" },
  "sphererandom.speedmax": { value: 0, source: "engine-content", evidence: "官方内容中最常见取值 0（33/69）" },
  "sphererandom.origin": { value: "0 0 0", source: "engine-content", evidence: "官方内容中 159 次出现里 118 次为 0 0 0" },
  "sphererandom.cone": { value: 0, source: "engine-content", evidence: "官方内容中该属性取值唯一：0" },
  "boxrandom.rate": { value: 50, source: "engine-preview", evidence: PREVIEW("boxrandom") },
  "layerimage.rate": { value: 5000, source: "engine-preview", evidence: PREVIEW("layerimage") },

  // ------------------------------------------------------------ 初始化器
  "lifetimerandom.min": { value: 1, source: "engine-preview", evidence: PREVIEW("lifetimerandom") },
  "lifetimerandom.max": { value: 5, source: "engine-preview", evidence: PREVIEW("lifetimerandom") },
  "lifetimerandom.exponent": { value: 1, source: "runtime-inferred", evidence: "官方内容中取值分散（10/1/2 各 5 次），取 1（均匀分布）" },
  "sizerandom.min": { value: 20, source: "engine-preview", evidence: PREVIEW("sizerandom") },
  "sizerandom.max": { value: 350, source: "engine-preview", evidence: PREVIEW("sizerandom") },
  "sizerandom.exponent": { value: 2, source: "engine-preview", evidence: PREVIEW("sizerandom") },
  "alpharandom.min": { value: 1, source: "engine-content", evidence: "官方内容中最常见取值 1（15/52）" },
  "alpharandom.max": { value: 1, source: "engine-content", evidence: "官方内容中最常见取值 1（13/52）" },
  "alpharandom.exponent": { value: 2, source: "engine-content", evidence: "官方内容中该属性取值唯一：2（11 次）" },
  "colorrandom.min": { value: "255 255 255", source: "engine-content", evidence: "官方内容中 255 次出现里 105 次为白（其余为作者配色）" },
  "colorrandom.max": { value: "255 255 255", source: "engine-content", evidence: "官方内容中 189 次出现里 37 次为白（其余为作者配色）" },
  "colorrandom.exponent": { value: 1, source: "engine-content", evidence: "官方内容中该属性取值唯一：1（17 次）" },
  "hsvcolorrandom.huemin": { value: 0, source: "engine-preview", evidence: PREVIEW("hsvcolorrandom") },
  "hsvcolorrandom.huemax": { value: 1, source: "engine-preview", evidence: PREVIEW("hsvcolorrandom") },
  "hsvcolorrandom.huesteps": { value: 6, source: "engine-preview", evidence: PREVIEW("hsvcolorrandom") },
  "hsvcolorrandom.saturationmin": { value: 1, source: "engine-preview", evidence: PREVIEW("hsvcolorrandom") },
  "hsvcolorrandom.saturationmax": { value: 1, source: "engine-preview", evidence: PREVIEW("hsvcolorrandom") },
  "hsvcolorrandom.valuemin": { value: 1, source: "engine-preview", evidence: PREVIEW("hsvcolorrandom") },
  "hsvcolorrandom.valuemax": { value: 1, source: "engine-preview", evidence: PREVIEW("hsvcolorrandom") },
  "velocityrandom.min": { value: "-200 -200 0", source: "engine-preview", evidence: PREVIEW("velocityrandom") },
  "velocityrandom.max": { value: "200 200 0", source: "engine-preview", evidence: PREVIEW("velocityrandom") },
  "turbulentvelocityrandom.scale": { value: 0.5, source: "engine-content", evidence: "官方内容中最常见取值 0.5（18/48）" },
  "turbulentvelocityrandom.offset": { value: 0, source: "engine-content", evidence: "官方内容中最常见取值 3/-0.5 分散，取 0（不偏移）" },
  "turbulentvelocityrandom.timescale": { value: 0.3, source: "engine-preview", evidence: PREVIEW("turbulentvelocityrandom") },
  "positionoffsetrandom.distance": { value: 150, source: "engine-preview", evidence: PREVIEW("positionoffsetrandom") },
  "positionoffsetrandom.scale": { value: 0, source: "engine-content", evidence: "官方内容中该属性取值唯一：0" },
  "positionoffsetrandom.timescale": { value: 5, source: "engine-content", evidence: "官方内容中最常见取值 5（2/4）" },
  "inheritcontrolpointvelocity.min": { value: 0.3, source: "engine-preview", evidence: PREVIEW("inheritcontrolpointvelocity") },
  "inheritcontrolpointvelocity.max": { value: 1, source: "engine-preview", evidence: PREVIEW("inheritcontrolpointvelocity") },
  "rotationrandom.min": { value: 0, source: "runtime-inferred", evidence: "官方内容中取值分散，取 0" },
  "rotationrandom.max": { value: 6.2831853, source: "runtime-inferred", evidence: "官方内容中多为 2π 量级，取一整圈" },
  "angularvelocityrandom.min": { value: -1, source: "engine-content", evidence: "官方内容中最常见取值 -1（16/38）" },
  "angularvelocityrandom.max": { value: 1, source: "engine-content", evidence: "官方内容中最常见取值 1（16/38）" },

  // ---------------------------------------------------------------- 算子
  "movement.gravity": { value: "0 0 0", source: "engine-content", evidence: "官方内容中 190 次出现里 116 次为 0 0 0（其余为作者设定）" },
  "movement.drag": { value: 0, source: "engine-content", evidence: "官方内容取值 0–10；最常见的非零值 0.2，但 0（无阻尼）出现于无重力场景，取 0" },
  "movement.flags": { value: 1, source: "engine-content", evidence: "官方内容中该属性取值唯一：1" },
  "turbulence.scale": { value: 0.0025, source: "engine-preview", evidence: PREVIEW("turbulence") },
  "turbulence.speedmin": { value: 200, source: "engine-preview", evidence: PREVIEW("turbulence") },
  "turbulence.speedmax": { value: 250, source: "engine-preview", evidence: PREVIEW("turbulence") },
  "turbulence.timescale": { value: 10, source: "engine-preview", evidence: PREVIEW("turbulence") },
  "turbulence.phasemin": { value: 5, source: "engine-content", evidence: "官方内容中该属性取值唯一：5" },
  "turbulence.phasemax": { value: 50, source: "engine-content", evidence: "官方内容中最常见取值 50（4/6），与 ember 预设一致" },
  "turbulence.mask": { value: "1 1 1", source: "runtime-inferred", evidence: "未写入时视为各轴不缩放（官方仅在需要抑制某轴时写该字段）" },
  "turbulence.blendinstart": { value: 0.1, source: "engine-content", evidence: "官方内容中该属性取值唯一：0.1" },
  "turbulence.blendinend": { value: 0.5, source: "engine-content", evidence: "官方内容中该属性取值唯一：0.5" },
  "turbulence.blendoutstart": { value: 0.6, source: "engine-content", evidence: "官方内容中该属性取值唯一：0.6" },
  "turbulence.blendoutend": { value: 0.7, source: "engine-content", evidence: "官方内容中该属性取值唯一：0.7" },
  "alphafade.fadeintime": { value: 0.1, source: "engine-content", evidence: "官方内容中最常见取值 0.1（110/218）" },
  "alphafade.fadeouttime": { value: 0.9, source: "engine-content", evidence: "官方内容中最常见取值 0.9（36/110，与 0.89999998 同值）" },
  "alphachange.startvalue": { value: 0, source: "engine-preview", evidence: PREVIEW("alphachange") },
  "alphachange.endvalue": { value: 1, source: "engine-preview", evidence: PREVIEW("alphachange") },
  "colorchange.startvalue": { value: "1 1 1", source: "runtime-inferred", evidence: "官方仅在需要变色时写该字段，取白色为起点" },
  "colorchange.endvalue": { value: "1 0 0", source: "engine-preview", evidence: PREVIEW("colorchange") },
  "sizechange.starttime": { value: 0.5, source: "engine-content", evidence: "官方内容中最常见取值 0.5（28/45）" },
  "sizechange.endtime": { value: 1, source: "runtime-inferred", evidence: "官方内容中多数只写 starttime，即变化持续到生命结束" },
  "sizechange.startvalue": { value: 1, source: "runtime-inferred", evidence: "官方取值以 0 与 1 为主；取 1 起始、0 结束，与 ember 预设（只写 starttime 0.7）的淡出行为一致" },
  "sizechange.endvalue": { value: 0, source: "runtime-inferred", evidence: "同上" },
  "oscillatealpha.frequencymin": { value: 3, source: "engine-preview", evidence: PREVIEW("oscillatealpha") },
  "oscillatealpha.frequencymax": { value: 6, source: "engine-preview", evidence: PREVIEW("oscillatealpha") },
  "oscillatealpha.scalemin": { value: 0, source: "runtime-inferred", evidence: "官方取值 0.2–0.7，未写入时视为可到全透明" },
  "oscillatesize.frequencymin": { value: 3, source: "engine-preview", evidence: PREVIEW("oscillatesize") },
  "oscillatesize.frequencymax": { value: 6, source: "engine-preview", evidence: PREVIEW("oscillatesize") },
  "oscillatesize.scalemin": { value: 0.3, source: "engine-preview", evidence: PREVIEW("oscillatesize") },
  "oscillatesize.scalemax": { value: 2, source: "engine-preview", evidence: PREVIEW("oscillatesize") },
  "oscillateposition.scalemin": { value: 15, source: "engine-preview", evidence: PREVIEW("oscillateposition") },
  "oscillateposition.scalemax": { value: 25, source: "engine-preview", evidence: PREVIEW("oscillateposition") },
  "capvelocity.maxspeed": { value: 100, source: "engine-preview", evidence: PREVIEW("capvelocity") },
  "capvelocity.blendinstart": { value: 0.5, source: "engine-preview", evidence: PREVIEW("capvelocity") },
  "capvelocity.blendinend": { value: 0.6, source: "engine-preview", evidence: PREVIEW("capvelocity") },
  "vortex.speedinner": { value: 100, source: "engine-preview", evidence: PREVIEW("vortex") },
  "vortex.distanceinner": { value: 0, source: "engine-content", evidence: "官方内容中最常见取值 0" },
  "vortex.distanceouter": { value: 0, source: "engine-content", evidence: "官方内容中最常见取值 0" },
  "angularmovement.force": { value: "0 0 10", source: "engine-preview", evidence: PREVIEW("angularmovement") },

  // -------------------------------------------------------------- 渲染器
  "sprite.orientation": { value: "screen", source: "engine-content", evidence: "官方内容中该属性取值唯一：screen" },
  "spritetrail.length": { value: 0.01, source: "engine-preview", evidence: PREVIEW("spritetrail") },
  "spritetrail.minlength": { value: 0, source: "runtime-inferred", evidence: "官方内容中该字段常被显式设为 null（不限制）" },
  "spritetrail.maxlength": { value: 2, source: "engine-content", evidence: "官方内容中最常见取值 2（14/33），且与预览工程一致" }
};

/** 数字型默认值查询。 */
export function numberDefault(component: string, property: string, fallback = 0): number {
  const entry = PARTICLE_DEFAULTS[`${component}.${property}`];
  return typeof entry?.value === "number" ? entry.value : fallback;
}

/** 向量 / 字符串型默认值查询。 */
export function vectorDefault(component: string, property: string, fallback: string): string {
  const entry = PARTICLE_DEFAULTS[`${component}.${property}`];
  return typeof entry?.value === "string" ? entry.value : fallback;
}

/** 单个粒子组件属性的最终取值及来源。 */
export interface ResolvedParticleParameter {
  kind: "emitter" | "initializer" | "operator" | "renderer";
  component: string;
  property: string;
  value: number | string;
  /** `preset` = 预设里写明的值；其余为官方默认值表的出处。 */
  origin: "preset" | ParticleDefaultSource;
  evidence?: string;
}

/**
 * 把一个粒子系统的 JSON（`particles/presets/*.json`）展开成「属性 + 最终取值 + 来源」。
 *
 * 预设里写了的属性来源为 `preset`；没写的属性按官方默认值补齐，并标出该默认值的出处。
 * 用于在调试面板 / CLI 里核对某个粒子层到底用了哪些参数。
 */
export function describeParticleParameters(json: Record<string, unknown>): ResolvedParticleParameter[] {
  const out: ResolvedParticleParameter[] = [];
  for (const kind of ["emitter", "initializer", "operator", "renderer"] as const) {
    const list = Array.isArray(json[kind]) ? (json[kind] as Array<Record<string, unknown>>) : [];
    for (const item of list) {
      const component = String(item.name ?? "");
      if (!component) continue;
      for (const [property, value] of Object.entries(item)) {
        if (property === "id" || property === "name") continue;
        out.push({ kind, component, property, value: value as number | string, origin: "preset" });
      }
      // 补齐该组件在官方默认值表里、但预设没写的属性。
      for (const [key, entry] of Object.entries(PARTICLE_DEFAULTS)) {
        const [owner, property] = key.split(".");
        if (owner !== component) continue;
        if (property in item) continue;
        out.push({ kind, component, property, value: entry.value, origin: entry.source, evidence: entry.evidence });
      }
    }
  }
  return out;
}

/** 默认值表 + 出处，供 CLI 与文档展示。 */
export function describeParticleDefaults(): Array<{ property: string; value: number | string; source: ParticleDefaultSource; evidence: string }> {
  return Object.entries(PARTICLE_DEFAULTS)
    .map(([property, entry]) => ({ property, value: entry.value, source: entry.source, evidence: entry.evidence }))
    .sort((a, b) => a.property.localeCompare(b.property));
}

/**
 * 湍流噪声时钟的映射系数：引擎 `timescale` 语义只能从官方文档得知，这里保持既有取值，
 * 并单独标注（可通过 `SceneRendererOptions.particles.turbulenceTimeFactor` 覆盖）。
 */
export const TURBULENCE_TIME_FACTOR = 0.02;
