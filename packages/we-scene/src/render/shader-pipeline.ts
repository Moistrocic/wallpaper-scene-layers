import { createProgram, type Capabilities, type ProgramInfo } from "../gl/gl-util.js";
import { composeShader, moderniseGlsl, relaxGlslTypes, type ComposedShader } from "../shader/compose.js";

export interface ShaderSourceProvider {
  getShaderSource(path: string): string | undefined;
  has(path: string): boolean;
}

/** Built in replacement for the engine shaders a scene can ask for. */
export const BUILTIN_SHADERS: Record<string, { vertex: string; fragment: string }> = {
  genericimage4: {
    vertex: `uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
varying vec2 v_MaskCoord;
void main() {
	gl_Position = g_ModelViewProjectionMatrix * vec4(a_Position, 1.0);
	v_TexCoord = a_TexCoord;
	v_MaskCoord = a_TexCoord;
}`,
    fragment: `precision mediump float;
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform vec4 g_Color4;
uniform vec4 g_Texture1Resolution;
varying vec2 v_TexCoord;
varying vec2 v_MaskCoord;
void main() {
	vec4 albedo = texture2D(g_Texture0, v_TexCoord);
#if MASK
	albedo.a *= texture2D(g_Texture1, v_MaskCoord).r;
#endif
	gl_FragColor = albedo * g_Color4;
}`
  },
  solid: {
    vertex: `uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
	gl_Position = g_ModelViewProjectionMatrix * vec4(a_Position, 1.0);
	v_TexCoord = a_TexCoord;
}`,
    fragment: `precision mediump float;
uniform vec4 g_Color4;
void main() {
	gl_FragColor = g_Color4;
}`
  },
  composite: {
    vertex: `uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
	gl_Position = g_ModelViewProjectionMatrix * vec4(a_Position, 1.0);
	v_TexCoord = a_TexCoord;
}`,
    fragment: `precision mediump float;
uniform sampler2D g_Texture0;
uniform vec4 g_Color4;
varying vec2 v_TexCoord;
void main() {
	gl_FragColor = texture2D(g_Texture0, v_TexCoord) * g_Color4;
}`
  },
  genericparticle: {
    vertex: `uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
attribute vec4 a_Color;
varying vec2 v_TexCoord;
varying vec4 v_Color;
void main() {
	gl_Position = g_ModelViewProjectionMatrix * vec4(a_Position, 1.0);
	v_TexCoord = a_TexCoord;
	v_Color = a_Color;
}`,
    fragment: `precision mediump float;
uniform sampler2D g_Texture0;
varying vec2 v_TexCoord;
varying vec4 v_Color;
void main() {
	vec4 albedo = texture2D(g_Texture0, v_TexCoord) * v_Color;
	gl_FragColor = albedo;
}`
  }
};

const VARYING_DECLARATION = /^(\s*)varying\s+(?:(?:lowp|mediump|highp)\s+)?(float|vec2|vec3|vec4)\s+(\w+)\s*;\s*$/;
const COMPONENT_COUNT: Record<string, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

function collectVaryings(source: string): Map<string, { type: string; index: number; indent: string }> {
  const found = new Map<string, { type: string; index: number; indent: string }>();
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = VARYING_DECLARATION.exec(lines[index]);
    if (match) found.set(match[3], { type: match[2], index, indent: match[1] });
  }
  return found;
}

/**
 * Rewrites varying declarations so both stages agree on their width. Required
 * because some workshop effects declare `varying vec2` in the vertex shader and
 * `varying vec4` in the fragment shader, which the engine tolerated but every
 * WebGL driver rejects.
 */
export function unifyVaryings(vertexSource: string, fragmentSource: string): [string, string] | null {
  const vertexVaryings = collectVaryings(vertexSource);
  const fragmentVaryings = collectVaryings(fragmentSource);
  const vertexLines = vertexSource.split("\n");
  const fragmentLines = fragmentSource.split("\n");
  let changed = false;
  for (const [name, vertexInfo] of vertexVaryings) {
    const fragmentInfo = fragmentVaryings.get(name);
    if (!fragmentInfo || fragmentInfo.type === vertexInfo.type) continue;
    const widest = COMPONENT_COUNT[vertexInfo.type] >= COMPONENT_COUNT[fragmentInfo.type] ? vertexInfo.type : fragmentInfo.type;
    vertexLines[vertexInfo.index] = `${vertexInfo.indent}varying ${widest} ${name};`;
    fragmentLines[fragmentInfo.index] = `${fragmentInfo.indent}varying ${widest} ${name};`;
    changed = true;
  }
  return changed ? [vertexLines.join("\n"), fragmentLines.join("\n")] : null;
}

export interface EffectProgram {
  program: ProgramInfo;
  layout: ComposedShader;
  /** Cache key, handy for diagnostics. */
  key: string;
}

/**
 * Compiles and caches every shader the scene needs: the built in materials and
 * the GLSL shipped inside the package (which is WebGL compatible as-is once the
 * engine headers and combo defines are inlined).
 */
export class ShaderPipeline {
  private readonly builtins = new Map<string, ProgramInfo>();
  private readonly effects = new Map<string, EffectProgram | null>();
  private readonly custom = new Map<string, ProgramInfo>();
  /** Compilation problems, surfaced through `SceneRenderer.diagnostics`. */
  readonly errors: string[] = [];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly provider: ShaderSourceProvider,
    private readonly capabilities: Capabilities,
    /**
     * Optional header override, e.g. the real `common*.h` from a local engine
     * installation. Compilation falls back to the built in prelude when the
     * engine headers do not work out.
     */
    private readonly headerProvider?: () => Record<string, string> | undefined
  ) {}

  getBuiltin(name: string, combos: Record<string, number> = {}): ProgramInfo | null {
    const source = BUILTIN_SHADERS[name] ?? BUILTIN_SHADERS.genericimage4;
    const comboKey = Object.entries(combos)
      .filter(([, value]) => value !== 0)
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join(",");
    const key = `builtin:${name}:${comboKey}`;
    const cached = this.builtins.get(key);
    if (cached) return cached;
    // Every combo the builtin sources reference must be defined, zero included:
    // ANGLE rejects `#if MASK` when MASK was never defined.
    const allCombos: Record<string, number> = { MASK: 0, ...combos };
    const defines = Object.entries(allCombos)
      .map(([define, value]) => `#define ${define} ${Math.round(value)}`)
      .join("\n");
    const info = createProgram(this.gl, source.vertex, `${defines}\n${source.fragment}`);
    if (info.error) {
      this.errors.push(`builtin shader "${name}" failed: ${info.error}`);
      return null;
    }
    this.builtins.set(key, info);
    return info;
  }

  /**
   * Resolves a material shader reference. Scene materials point either at a
   * built in engine shader (`genericimage4`) or at a shader that ships inside
   * the package (`workshop/3631185719/effects/rounded_mask`).
   */
  getEffect(shaderName: string, combos: Record<string, number> = {}): EffectProgram | null {
    const comboKey = Object.entries(combos)
      .filter(([, value]) => value !== 0)
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join(",");
    const key = `${shaderName}:${comboKey}`;
    if (this.effects.has(key)) return this.effects.get(key) ?? null;

    const vertexSource = this.provider.getShaderSource(`shaders/${shaderName}.vert`);
    const fragmentSource = this.provider.getShaderSource(`shaders/${shaderName}.frag`);
    if (!vertexSource || !fragmentSource) {
      this.effects.set(key, null);
      return null;
    }

    const headers = this.headerProvider?.();
    let vertex = composeShader(vertexSource, "vertex", { combos, headers });
    let fragment = composeShader(fragmentSource, "fragment", { combos, headers });
    let lastError: string | undefined;
    let info = createProgram(this.gl, vertex.code, fragment.code);
    if (info.error && headers) {
      // The engine headers did not work out (a shader may rely on the built in
      // prelude instead): retry with the prelude this runtime ships.
      lastError = info.error;
      vertex = composeShader(vertexSource, "vertex", { combos });
      fragment = composeShader(fragmentSource, "fragment", { combos });
      info = createProgram(this.gl, vertex.code, fragment.code);
    }
    if (info.error) {
      // A number of workshop shaders declare the same varying with different
      // widths in the two stages; widen both sides and try once more.
      const repaired = unifyVaryings(vertex.code, fragment.code) ?? [vertex.code, fragment.code];
      const retry = createProgram(this.gl, repaired[0], repaired[1]);
      if (!retry.error) {
        info = retry;
        this.errors.push(`shader "${shaderName}": varying declarations were unified across stages`);
      }
    }
    if (info.error) {
      // Second fallback: desktop GLSL accepts implicit int/float conversions,
      // GLSL ES does not. `relaxGlslTypes` widens those declarations.
      const relaxed = createProgram(this.gl, relaxGlslTypes(vertex.code), relaxGlslTypes(fragment.code));
      if (!relaxed.error) {
        info = relaxed;
        this.errors.push(`shader "${shaderName}": int declarations were relaxed to float for GLSL ES`);
      }
    }
    // Third fallback: upgrade to GLSL ES 3.00, which permits variable array
    // indexing (used by a few audio reactive workshop shaders).
    for (const [label, prepare] of [
      ["upgraded to GLSL ES 3.00", (code: string, stage: "vertex" | "fragment") => moderniseGlsl(relaxGlslTypes(code), stage)],
      [
        "repaired for GLSL ES (varyings unified, ints relaxed, GLSL ES 3.00)",
        (code: string, stage: "vertex" | "fragment") => {
          const unified = unifyVaryings(vertex.code, fragment.code);
          const source = (stage === "vertex" ? unified?.[0] : unified?.[1]) ?? code;
          return moderniseGlsl(relaxGlslTypes(source), stage);
        }
      ]
    ] as const) {
      if (!info.error) break;
      const attempt = createProgram(this.gl, prepare(vertex.code, "vertex"), prepare(fragment.code, "fragment"));
      if (!attempt.error) {
        info = attempt;
        this.errors.push(`shader "${shaderName}": ${label}`);
      } else {
        lastError = attempt.error;
      }
    }
    if (info.error) {
      this.errors.push(`shader "${shaderName}" failed to compile: ${info.error}${lastError ? `\n  last attempt: ${lastError}` : ""}`);
      this.effects.set(key, null);
      return null;
    }
    // Merge both stages: the vertex shader often declares uniforms and combos
    // (directions, control points) the fragment stage never mentions.
    const layout: ComposedShader = {
      ...fragment,
      combos: [...fragment.combos, ...vertex.combos.filter((combo) => !fragment.combos.some((other) => other.combo === combo.combo))],
      uniforms: [...fragment.uniforms, ...vertex.uniforms.filter((uniform) => !fragment.uniforms.some((other) => other.name === uniform.name))],
      samplers: [...fragment.samplers, ...vertex.samplers.filter((sampler) => !fragment.samplers.some((other) => other.name === sampler.name))],
      attributes: [...fragment.attributes, ...vertex.attributes.filter((attribute) => !fragment.attributes.includes(attribute))],
      resolvedCombos: { ...vertex.resolvedCombos, ...fragment.resolvedCombos }
    };
    const entry: EffectProgram = { program: info, layout, key };
    this.effects.set(key, entry);
    return entry;
  }

  /** Compiles an arbitrary pair of GLSL sources (used for engine utilities). */
  getCustom(key: string, vertexSource: string, fragmentSource: string): ProgramInfo | null {
    const cached = this.custom.get(key);
    if (cached) return cached;
    const info = createProgram(this.gl, vertexSource, fragmentSource);
    if (info.error) {
      this.errors.push(`shader "${key}" failed to compile: ${info.error}`);
      return null;
    }
    this.custom.set(key, info);
    return info;
  }

  get supportsCompressedTextures(): boolean {
    return this.capabilities.s3tc;
  }
}
