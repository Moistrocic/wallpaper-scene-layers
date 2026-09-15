import { ENGINE_HEADERS } from "../shaders/prelude.js";

/** A `// [COMBO] { ... }` declaration at the top of a WE shader. */
export interface ComboDeclaration {
  /** Human readable material property name. */
  material?: string;
  combo: string;
  type?: string;
  default: number;
  options?: Record<string, number>;
  require?: Record<string, number>;
}

/** The `// {...}` JSON comment that follows a uniform declaration. */
export interface UniformHint {
  name: string;
  glslType: string;
  /** Name of the material property this uniform is driven by. */
  material?: string;
  combo?: string;
  default?: unknown;
  hidden?: boolean;
  range?: [number, number];
  /** `true` when the value is an angle in radians. */
  direction?: boolean;
  mode?: string;
}

export interface ParsedShader {
  combos: ComboDeclaration[];
  uniforms: UniformHint[];
  /** `uniform sampler2D g_TextureN` declarations. */
  samplers: UniformHint[];
  attributes: string[];
  includes: string[];
}

const COMBO_PATTERN = /^\s*\/\/\s*\[COMBO\]\s*(\{.*\})\s*$/;
const UNIFORM_PATTERN = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(\[\s*\d+\s*\])?\s*;\s*(?:\/\/\s*(\{.*\}))?\s*$/;
const SAMPLER_PATTERN = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?sampler2D\s+(\w+)\s*;\s*(?:\/\/\s*(\{.*\}))?\s*$/;
const ATTRIBUTE_PATTERN = /^\s*attribute\s+\w+\s+(\w+)\s*;/;
const INCLUDE_PATTERN = /^\s*#include\s+"([^"]+)"\s*$/;

function parseJSONComment(source: string | undefined): Record<string, unknown> | undefined {
  if (!source) return undefined;
  try {
    return JSON.parse(source) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Extracts combo declarations, uniform hints and attribute names from a shader. */
export function parseShader(source: string): ParsedShader {
  const combos: ComboDeclaration[] = [];
  const uniforms: UniformHint[] = [];
  const samplers: UniformHint[] = [];
  const attributes: string[] = [];
  const includes: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    const comboMatch = COMBO_PATTERN.exec(line);
    if (comboMatch) {
      const json = parseJSONComment(comboMatch[1]);
      if (json && typeof json.combo === "string") {
        combos.push({
          material: typeof json.material === "string" ? json.material : undefined,
          combo: json.combo,
          type: typeof json.type === "string" ? json.type : undefined,
          default: typeof json.default === "number" ? json.default : 0,
          options: json.options as Record<string, number> | undefined,
          require: json.require as Record<string, number> | undefined
        });
      }
      continue;
    }
    const includeMatch = INCLUDE_PATTERN.exec(line);
    if (includeMatch) {
      includes.push(includeMatch[1]);
      continue;
    }
    const samplerMatch = SAMPLER_PATTERN.exec(line);
    if (samplerMatch) {
      const json = parseJSONComment(samplerMatch[2]);
      const hint: UniformHint = {
        name: samplerMatch[1],
        glslType: "sampler2D",
        material: typeof json?.material === "string" ? json.material : undefined,
        combo: typeof json?.combo === "string" ? json.combo : undefined,
        default: json?.default,
        hidden: json?.hidden === true,
        mode: typeof json?.mode === "string" ? json.mode : undefined
      };
      samplers.push(hint);
      uniforms.push(hint);
      continue;
    }
    const uniformMatch = UNIFORM_PATTERN.exec(line);
    if (uniformMatch) {
      const json = parseJSONComment(uniformMatch[4]);
      uniforms.push({
        name: uniformMatch[2],
        glslType: uniformMatch[1],
        material: typeof json?.material === "string" ? json.material : undefined,
        combo: typeof json?.combo === "string" ? json.combo : undefined,
        default: json?.default,
        hidden: json?.hidden === true,
        range: Array.isArray(json?.range) ? (json.range as [number, number]) : undefined,
        direction: json?.direction === true,
        mode: typeof json?.mode === "string" ? json.mode : undefined
      });
      continue;
    }
    const attributeMatch = ATTRIBUTE_PATTERN.exec(line);
    if (attributeMatch) attributes.push(attributeMatch[1]);
  }

  // Combos may also be declared implicitly through a sampler / uniform hint.
  const known = new Set(combos.map((combo) => combo.combo));
  for (const uniform of uniforms) {
    if (uniform.combo && !known.has(uniform.combo)) {
      known.add(uniform.combo);
      combos.push({ combo: uniform.combo, default: 0 });
    }
  }

  return { combos, uniforms, samplers, attributes, includes };
}

export interface ComposeOptions {
  /** Values coming from `scene.json` / the material, keyed by combo name. */
  combos?: Record<string, number>;
  /** Inline every engine header even when the shader did not include it. */
  inlineEngineHeaders?: boolean;
  /**
   * Header sources overriding the built in prelude, keyed by include name
   * (`"common.h"`). Used to compile against the real headers from a local
   * Wallpaper Engine installation when the caller enabled engine assets.
   */
  headers?: Record<string, string>;
}

export interface ComposedShader extends ParsedShader {
  code: string;
  /** Fully resolved combo values (declaration defaults + overrides). */
  resolvedCombos: Record<string, number>;
}

/**
 * Turns a Wallpaper Engine shader into something a WebGL context accepts:
 * engine headers are inlined, every combo referenced by the source gets a
 * numeric `#define`, and duplicate declarations coming from the inlined
 * headers are commented out.
 */
export function composeShader(source: string, stage: "vertex" | "fragment", options: ComposeOptions = {}): ComposedShader {
  const parsed = parseShader(source);
  const resolvedCombos: Record<string, number> = {};
  for (const combo of parsed.combos) {
    const override = options.combos?.[combo.combo];
    resolvedCombos[combo.combo] = typeof override === "number" && Number.isFinite(override) ? override : combo.default ?? 0;
  }

  // The engine implicitly prepends its core headers to every shader; a few
  // workshop shaders rely on that by calling `mul` without including common.h.
  const headers: Record<string, string> = { ...ENGINE_HEADERS, ...(options.headers ?? {}) };
  const headerLines: string[] = [];
  for (const [name, text] of Object.entries(headers)) {
    if (ALWAYS_INLINED_HEADERS.has(name) || parsed.includes.includes(name) || options.inlineEngineHeaders) {
      headerLines.push(expandIncludes(text, 0, headers));
    }
  }
  // Headers the shader includes but that are not part of the core set (the
  // engine ships extras such as common_particles.h alongside its shaders).
  for (const name of parsed.includes) {
    if (headers[name] || ENGINE_HEADERS[name]) continue;
    if (options.headers?.[name]) headerLines.push(expandIncludes(options.headers[name], 0, headers));
  }

  const body: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (INCLUDE_PATTERN.test(line)) continue;
    body.push(line);
  }
  const sanitisedBody = sanitiseConditionals(body);

  // Any identifier used by a preprocessor conditional must exist: ANGLE reports
  // "unexpected token after conditional expression" for `#if UNDEFINED_COMBO`.
  const conditionalIdentifiers = collectConditionalIdentifiers([...headerLines, ...sanitisedBody].join("\n"));
  for (const identifier of conditionalIdentifiers) {
    if (!(identifier in resolvedCombos)) resolvedCombos[identifier] = 0;
  }

  const defines = Object.entries(resolvedCombos).map(([name, value]) => `#define ${name} ${Math.round(value)}`);

  // Both stages must agree on the default float precision: the engine headers
  // declare shared uniforms (`g_Texture0Resolution`) in each stage.
  const precision =
    stage === "fragment"
      ? "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\nprecision mediump int;"
      : "precision highp float;\nprecision highp int;";

  const prefix = [
    precision,
    "",
    "// --- generated by @web-we-scene/runtime ---",
    ...defines,
    "",
    HEADER_BEGIN,
    ...headerLines,
    HEADER_END,
    "// --- shader source ---"
  ].join("\n");

  const code = dedupeDeclarations(prefix + "\n" + sanitisedBody.join("\n"));
  return { ...parsed, code, resolvedCombos };
}

/** Region markers: the GLSL ES compatibility rewrites never touch this code. */
export const HEADER_BEGIN = "// [engine headers begin]";
export const HEADER_END = "// [engine headers end]";

const OPEN_DIRECTIVE = /^\s*#\s*(?:if|ifdef|ifndef)\b/;
const CLOSE_DIRECTIVE = /^\s*#\s*endif\b/;

/**
 * Wallpaper Engine's preprocessor ignores a stray `#endif` (a handful of
 * workshop shaders ship one); every WebGL driver treats it as a hard error, so
 * unmatched closers are commented out.
 */
export function sanitiseConditionals(lines: string[]): string[] {
  const output: string[] = [];
  let depth = 0;
  for (const line of lines) {
    if (OPEN_DIRECTIVE.test(line)) {
      depth++;
      output.push(line);
      continue;
    }
    if (CLOSE_DIRECTIVE.test(line)) {
      if (depth === 0) {
        output.push(`// [unmatched endif] ${line.trim()}`);
        continue;
      }
      depth--;
      output.push(line);
      continue;
    }
    output.push(line);
  }
  return output;
}

/**
 * Rewrites a GLSL ES 1.00 shader as GLSL ES 3.00.
 *
 * Some workshop shaders index arrays with a variable, which ES 1.00 forbids but
 * ES 3.00 allows. The rewrite is mechanical: keywords are renamed and
 * `gl_FragColor` becomes a declared output.
 */
export function moderniseGlsl(source: string, stage: "vertex" | "fragment"): string {
  let output = source.replace(/^\s*#version.*$/gm, "");
  if (stage === "fragment") output = output.replace(/\bgl_FragColor\b/g, "dsh_FragColor");
  output = output
    .replace(/\battribute\b/g, "in")
    .replace(/\bvarying\b/g, stage === "vertex" ? "out" : "in")
    .replace(/\btexture2D\s*\(/g, "texture(")
    .replace(/\btexture2DLod\s*\(/g, "textureLod(");
  const prelude =
    stage === "fragment"
      ? "#version 300 es\nprecision highp float;\nout vec4 dsh_FragColor;\n"
      : "#version 300 es\nprecision highp float;\n";
  return prelude + output;
}

/**
 * Desktop GLSL (what the engine compiles) accepts implicit int/float
 * conversions that GLSL ES rejects. Applied as a second attempt: the first
 * compile always uses the shader exactly as shipped.
 */
export function relaxGlslTypes(source: string): string {
  // Variables used to index arrays have to stay `int`, everything else can be
  // widened without changing the meaning of the shader.
  const indexVariables = new Set<string>();
  for (const match of source.matchAll(/\[([^\]]*)\]/g)) {
    for (const token of match[1].matchAll(/[A-Za-z_]\w*/g)) indexVariables.add(token[0]);
  }

  const relaxIntegers = (segment: string): string =>
    segment.replace(/(?<![\w.[])(\d+\.?\d*(?:[eE][+-]?\d+)?)(?![\w.\]])/g, (match) =>
      match.includes(".") || /[eE]/.test(match) ? match : `${match}.0`
    );

  let inHeaders = false;
  return source
    .split("\n")
    .map((line) => {
      if (line.includes(HEADER_BEGIN)) inHeaders = true;
      if (inHeaders) {
        if (line.includes(HEADER_END)) inHeaders = false;
        return line;
      }
      if (/^\s*#/.test(line)) return line; // never touch preprocessor directives
      // Bracketed expressions (array indices) keep their integer arithmetic.
      return line
        .split(/(\[[^\]]*\])/)
        .map((segment, index) => {
          if (index % 2 === 1) return segment;
          return relaxIntegers(
            segment
              .replace(/\bint\s+([A-Za-z_]\w*)\s*=/g, (match, name: string) => (indexVariables.has(name) ? match : `float ${name} =`))
              .replace(/\bint\s+([A-Za-z_]\w*)\s*;/g, (match, name: string) => (indexVariables.has(name) ? match : `float ${name};`))
              .replace(/\bint\s+([A-Za-z_]\w*)\s*(?=[,)])/g, (match, name: string) => (indexVariables.has(name) ? match : `float ${name}`))
              .replace(/\bint\s*\(/g, "float(")
              .replace(/\bivec([234])\b/g, "vec$1")
          );
        })
        .join("");
    })
    .join("\n");
}

/**
 * Headers the engine always makes available. `common_blur.h` is excluded
 * because it defines sampler based helpers that only compile when the shader
 * asks for them.
 */
const ALWAYS_INLINED_HEADERS = new Set(["common.h", "common_vertex.h", "common_fragment.h", "common_perspective.h", "common_blending.h"]);

/** `#if` / `#elif` only: `#ifdef` guards are already satisfied by their `#define`. */
const CONDITIONAL_PATTERN = /^\s*#\s*(?:if|elif)\b(.*)$/;
const DEFINE_PATTERN = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/;
const KEYWORDS = new Set(["defined", "true", "false", "GL_ES", "__VERSION__", "__LINE__", "__FILE__"]);

/**
 * Identifiers referenced by `#if` expressions. Anything the source defines
 * itself (include guards, helper macros) is left alone.
 */
export function collectConditionalIdentifiers(source: string): Set<string> {
  const defined = new Set<string>();
  const identifiers = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const defineMatch = DEFINE_PATTERN.exec(line);
    if (defineMatch) {
      defined.add(defineMatch[1]);
      continue;
    }
    const match = CONDITIONAL_PATTERN.exec(line);
    if (!match) continue;
    for (const token of match[1].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (!KEYWORDS.has(token[0])) identifiers.add(token[0]);
    }
  }
  for (const name of defined) identifiers.delete(name);
  return identifiers;
}

/** Inlines the engine headers (which include each other) into plain GLSL. */
export function expandIncludes(source: string, depth = 0, headers: Record<string, string> = ENGINE_HEADERS): string {
  if (depth > 8 || source.indexOf("#include") === -1) return source;
  const expanded = source
    .split(/\r?\n/)
    .map((line) => {
      const match = INCLUDE_PATTERN.exec(line);
      if (!match) return line;
      const header = headers[match[1]] ?? ENGINE_HEADERS[match[1]];
      if (!header) return `// [missing engine header: ${match[1]}]`;
      return expandIncludes(header, depth + 1, headers);
    })
    .join("\n");
  return expanded;
}

const DECLARATION_PATTERN = /^\s*(uniform|attribute|varying)\s+(?:(?:lowp|mediump|highp)\s+)?[\w\[\]\s]+?\s+(\w+)\s*;\s*(?:\/\/.*)?$/;

/**
 * GLSL rejects a repeated declaration, and the inlined engine headers declare a
 * few uniforms the shaders declare as well. Comment out the later duplicates.
 */
export function dedupeDeclarations(code: string): string {
  const seen = new Set<string>();
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = DECLARATION_PATTERN.exec(lines[i]);
    if (!match) continue;
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) {
      lines[i] = `// [deduplicated] ${lines[i]}`;
    } else {
      seen.add(key);
    }
  }
  return lines.join("\n");
}

/** Values of the `#if` guarded branches, used to explain missing features. */
export function activeCombos(combos: Record<string, number>): string[] {
  return Object.entries(combos)
    .filter(([, value]) => value !== 0)
    .map(([name, value]) => `${name}=${value}`);
}
