export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

/**
 * Column major 4x4 matrices, matching what `gl.uniformMatrix4fv` expects.
 * Wallpaper Engine shaders are written with the HLSL row vector convention
 * (`mul(vec4(position, 1.0), matrix)`), which the shader prelude maps onto the
 * standard `matrix * vector` form, so no transposing happens on upload.
 */
export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4, out = mat4()): Mat4 {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function multiplyAll(...matrices: Mat4[]): Mat4 {
  let out = matrices[0] ?? mat4();
  for (let i = 1; i < matrices.length; i++) out = multiply(out, matrices[i]);
  return out;
}

export function fromTranslation(x: number, y: number, z: number): Mat4 {
  const m = mat4();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function fromScale(x: number, y: number, z: number): Mat4 {
  const m = mat4();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

export function fromRotationZ(radians: number): Mat4 {
  const m = mat4();
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

export function fromRotationY(radians: number): Mat4 {
  const m = mat4();
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function fromRotationX(radians: number): Mat4 {
  const m = mat4();
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

/** Orthographic projection, y up, looking down -z (matches the WE default scene). */
export function orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
  const m = mat4();
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = -2 / (far - near);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -(far + near) / (far - near);
  return m;
}

export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const z = normalise([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = normalise(cross(up, z));
  const y = cross(z, x);
  const m = mat4();
  m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
  m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
  m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  return m;
}

export function perspective(fovDegrees: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovDegrees * Math.PI) / 360);
  const m = mat4();
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  m[15] = 0;
  return m;
}

export function transformPoint(m: Mat4, point: Vec3): Vec3 {
  const [x, y, z] = point;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w
  ];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Applies an alignment offset to a quad of `size`, in scene units. */
export function alignmentOffset(alignment: string, width: number, height: number): Vec2 {
  const a = alignment || "center";
  let x = 0;
  let y = 0;
  if (a.includes("left")) x = width / 2;
  else if (a.includes("right")) x = -width / 2;
  // Wallpaper Engine scene origins grow upwards, alignment strings follow the
  // editor wording (top = the quad hangs below its origin).
  if (a.includes("top")) y = -height / 2;
  else if (a.includes("bottom")) y = height / 2;
  return [x, y];
}
