/**
 * Re-implementation of the Wallpaper Engine shader prelude.
 *
 * The `.frag` / `.vert` files shipped inside a `scene.pkg` are plain
 * GLSL ES 1.00 that `#include` a handful of engine headers which are not part of
 * the package. The functions below provide the same names and signatures, which
 * is all the shipped shaders in practice rely on.
 *
 * The engine writes its matrices in the HLSL row vector convention
 * (`mul(vec4(position, 1.0), matrix)`); `mul` is therefore defined as the
 * reversed multiplication so that ordinary column major matrices can be
 * uploaded without transposing.
 */
export const COMMON_HEADER = `#ifndef DSH_COMMON_H
#define DSH_COMMON_H

#define M_PI 3.1415926535897932384626433832795
#define M_PI_2 1.5707963267948966192313216916398
#define M_PI_4 0.78539816339744830961566084581988
#define M_2PI 6.283185307179586476925286766559
#define M_1_PI 0.31830988618379067153776752674503
#define M_SQRT2 1.4142135623730950488016887242097
#define M_EPSILON 1e-6

#define CAST2(x) vec2(x)
#define CAST3(x) vec3(x)
#define CAST4(x) vec4(x)
#define mul(a, b) ((b) * (a))
#define texSample2D(sampler, uv) texture2D(sampler, uv)
#define texSample2DLod(sampler, uv, lod) texture2D(sampler, uv, lod)

float saturate(float value) { return clamp(value, 0.0, 1.0); }
vec2 saturate(vec2 value) { return clamp(value, 0.0, 1.0); }
vec3 saturate(vec3 value) { return clamp(value, 0.0, 1.0); }
vec4 saturate(vec4 value) { return clamp(value, 0.0, 1.0); }

float frac(float value) { return fract(value); }
vec2 frac(vec2 value) { return fract(value); }

float sign2(float value) { return value < 0.0 ? -1.0 : 1.0; }

vec2 rotateVec2(vec2 value, float angle) {
	float s = sin(angle);
	float c = cos(angle);
	return vec2(value.x * c - value.y * s, value.x * s + value.y * c);
}

float luminance(vec3 color) { return dot(color, vec3(0.299, 0.587, 0.114)); }

// Cheap hash / noise helpers used by particles and procedural materials.
float hash11(float p) {
	p = fract(p * 0.1031);
	p *= p + 33.33;
	p *= p + p;
	return fract(p);
}

float hash21(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

float random(vec2 uv) { return hash21(uv); }

// Bilinear taps that do not bleed across the border (used by the blur helpers).
vec4 sampleClamped(sampler2D tex, vec2 uv, vec4 resolution) {
	vec2 clamped = clamp(uv, vec2(0.0), vec2(1.0));
	return texSample2D(tex, clamped);
}

#endif
`;

export const COMMON_VERTEX_HEADER = `#ifndef DSH_COMMON_VERTEX_H
#define DSH_COMMON_VERTEX_H

#include "common.h"

mat3 identity3() {
	return mat3(1.0);
}

#endif
`;

export const COMMON_FRAGMENT_HEADER = `#ifndef DSH_COMMON_FRAGMENT_H
#define DSH_COMMON_FRAGMENT_H

#include "common.h"

// Engine provided render state.
uniform vec4 g_Texture0Resolution;
uniform vec4 g_Texture1Resolution;
uniform vec4 g_Texture2Resolution;
uniform vec4 g_Texture3Resolution;
uniform float g_Time;
uniform vec4 g_Color4;
uniform vec3 g_Color3;
uniform float g_Alpha;

#endif
`;

export const COMMON_PERSPECTIVE_HEADER = `#ifndef DSH_COMMON_PERSPECTIVE_H
#define DSH_COMMON_PERSPECTIVE_H

#include "common.h"

// Builds the homography that maps the unit square onto the given quad, which is
// what the "perspective" effect combo needs.
mat3 squareToQuad(vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
	float dx1 = p1.x - p2.x;
	float dx2 = p3.x - p2.x;
	float dy1 = p1.y - p2.y;
	float dy2 = p3.y - p2.y;
	float den = dx1 * dy2 - dx2 * dy1;
	float sx = (p1.x - p0.x + p2.x - p3.x);
	float sy = (p1.y - p0.y + p2.y - p3.y);
	vec3 row0 = vec3(0.0);
	vec3 row1 = vec3(0.0);
	vec3 row2 = vec3(0.0);
	if (abs(den) > 1e-8) {
		float dx3 = p0.x - p1.x + p2.x - p3.x;
		float dy3 = p0.y - p1.y + p2.y - p3.y;
		float g = (dx3 * dy2 - dx2 * dy3) / den;
		float h = (dx1 * dy3 - dx3 * dy1) / den;
		row0 = vec3(p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x);
		row1 = vec3(p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y);
		row2 = vec3(g, h, 1.0);
	} else {
		row0 = vec3(p1.x - p0.x, p2.x - p1.x, p0.x);
		row1 = vec3(p1.y - p0.y, p2.y - p1.y, p0.y);
		row2 = vec3(0.0, 0.0, 1.0);
	}
	return mat3(row0, row1, row2);
}

mat3 inverse3(mat3 m) {
	float a00 = m[0][0], a01 = m[0][1], a02 = m[0][2];
	float a10 = m[1][0], a11 = m[1][1], a12 = m[1][2];
	float a20 = m[2][0], a21 = m[2][1], a22 = m[2][2];
	float b01 = a22 * a11 - a12 * a21;
	float b11 = -a22 * a10 + a12 * a20;
	float b21 = a21 * a10 - a11 * a20;
	float det = a00 * b01 + a01 * b11 + a02 * b21;
	if (abs(det) < 1e-12) return mat3(1.0);
	float inv = 1.0 / det;
	return mat3(
		vec3(b01 * inv, (-a22 * a01 + a02 * a21) * inv, (a12 * a01 - a02 * a11) * inv),
		vec3(b11 * inv, (a22 * a00 - a02 * a20) * inv, (-a12 * a00 + a02 * a10) * inv),
		vec3(b21 * inv, (-a21 * a00 + a01 * a20) * inv, (a11 * a00 - a01 * a10) * inv)
	);
}

#endif
`;

export const COMMON_BLENDING_HEADER = `#ifndef DSH_COMMON_BLENDING_H
#define DSH_COMMON_BLENDING_H

#include "common.h"

// Matches the "imageblending" combo of the engine materials.
#define BLENDMODE_NORMAL 0
#define BLENDMODE_TRANSLUCENT 1
#define BLENDMODE_ADDITIVE 2
#define BLENDMODE_MULTIPLICATIVE 3

vec3 ApplyBlending(int mode, vec3 base, vec3 blend, float opacity) {
#if BLENDMODE == 0
	return mix(base, blend, opacity);
#elif BLENDMODE == 1
	return base * (1.0 - opacity) + blend * opacity + base * blend * (1.0 - opacity) * opacity;
#elif BLENDMODE == 2
	return base + blend * opacity;
#elif BLENDMODE == 3
	return mix(base, base * blend, opacity);
#else
	return mix(base, blend, opacity);
#endif
}

vec4 ApplyBlending4(int mode, vec4 base, vec4 blend, float opacity) {
	vec4 result = base;
	result.rgb = ApplyBlending(mode, base.rgb, blend.rgb, opacity);
	result.a = mix(base.a, blend.a, opacity);
	return result;
}

#endif
`;

export const COMMON_BLUR_HEADER = `#ifndef DSH_COMMON_BLUR_H
#define DSH_COMMON_BLUR_H

#include "common.h"

// Declared here so the helpers below compile even though the shader declares
// its own samplers further down (duplicates are stripped when composing).
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform vec4 g_Texture0Resolution;
uniform vec4 g_Texture1Resolution;
uniform vec2 g_BlurDirection; // {"material":"blurdirection","default":"1 0"}

vec4 blurSample(sampler2D tex, vec2 uv, vec2 step, float weight) {
	return texSample2D(tex, uv) * weight;
}

// 9 tap gaussian along g_BlurDirection, alpha from g_Texture1.
vec4 blur3a(vec2 uv, vec2 maskUv) {
	vec2 texel = g_BlurDirection / g_Texture0Resolution.xy;
	vec4 sum = texSample2D(g_Texture0, uv) * 0.2941176;
	sum += texSample2D(g_Texture0, uv + texel * 1.4117647) * 0.2352941;
	sum += texSample2D(g_Texture0, uv - texel * 1.4117647) * 0.2352941;
	sum += texSample2D(g_Texture0, uv + texel * 3.2941176) * 0.1176471;
	sum += texSample2D(g_Texture0, uv - texel * 3.2941176) * 0.1176471;
	return sum;
}

vec4 blur7a(vec2 uv, vec2 maskUv) {
	vec2 texel = g_BlurDirection / g_Texture0Resolution.xy;
	vec4 sum = texSample2D(g_Texture0, uv) * 0.1964825;
	sum += texSample2D(g_Texture0, uv + texel * 1.4407961) * 0.1747515;
	sum += texSample2D(g_Texture0, uv - texel * 1.4407961) * 0.1747515;
	sum += texSample2D(g_Texture0, uv + texel * 3.3571215) * 0.1167588;
	sum += texSample2D(g_Texture0, uv - texel * 3.3571215) * 0.1167588;
	sum += texSample2D(g_Texture0, uv + texel * 5.2699124) * 0.0535109;
	sum += texSample2D(g_Texture0, uv - texel * 5.2699124) * 0.0535109;
	return sum;
}

vec4 blur13a(vec2 uv, vec2 maskUv) {
	vec2 texel = g_BlurDirection / g_Texture0Resolution.xy;
	vec4 sum = texSample2D(g_Texture0, uv) * 0.1633803;
	sum += texSample2D(g_Texture0, uv + texel * 1.2626053) * 0.1522476;
	sum += texSample2D(g_Texture0, uv - texel * 1.2626053) * 0.1522476;
	sum += texSample2D(g_Texture0, uv + texel * 2.9172921) * 0.1189382;
	sum += texSample2D(g_Texture0, uv - texel * 2.9172921) * 0.1189382;
	sum += texSample2D(g_Texture0, uv + texel * 4.5534218) * 0.0777674;
	sum += texSample2D(g_Texture0, uv - texel * 4.5534218) * 0.0777674;
	sum += texSample2D(g_Texture0, uv + texel * 6.1588534) * 0.0417732;
	sum += texSample2D(g_Texture0, uv - texel * 6.1588534) * 0.0417732;
	sum += texSample2D(g_Texture0, uv + texel * 7.7224301) * 0.0185547;
	sum += texSample2D(g_Texture0, uv - texel * 7.7224301) * 0.0185547;
	return sum;
}

#endif
`;

/** Engine headers addressable from a `#include` directive. */
export const ENGINE_HEADERS: Record<string, string> = {
  "common.h": COMMON_HEADER,
  "common_vertex.h": COMMON_VERTEX_HEADER,
  "common_fragment.h": COMMON_FRAGMENT_HEADER,
  "common_perspective.h": COMMON_PERSPECTIVE_HEADER,
  "common_blending.h": COMMON_BLENDING_HEADER,
  "common_blur.h": COMMON_BLUR_HEADER
};
