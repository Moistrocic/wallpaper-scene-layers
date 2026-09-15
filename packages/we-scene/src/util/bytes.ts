/**
 * Small little-endian binary reader used by the package / texture parsers.
 * Every parser in this library works on a `Uint8Array` view so that a single
 * downloaded `ArrayBuffer` (a whole `scene.pkg`) can be sliced without copying.
 */
export class BinaryReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  offset = 0;

  constructor(input: ArrayBuffer | ArrayBufferView) {
    if (input instanceof ArrayBuffer) {
      this.bytes = new Uint8Array(input);
    } else {
      this.bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get remaining(): number {
    return this.length - this.offset;
  }

  hasMore(): boolean {
    return this.offset < this.length;
  }

  seek(offset: number): this {
    this.offset = offset;
    return this;
  }

  skip(count: number): this {
    this.offset += count;
    return this;
  }

  i32(): number {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u8(): number {
    return this.bytes[this.offset++];
  }

  /** Reads a NUL terminated ASCII string (the magic strings of WE containers). */
  cstring(): string {
    let out = "";
    while (this.offset < this.length) {
      const code = this.bytes[this.offset++];
      if (code === 0) break;
      out += String.fromCharCode(code);
    }
    return out;
  }

  /** Reads a length prefixed ASCII string (the file names inside scene.pkg). */
  lengthPrefixedString(): string {
    const length = this.u32();
    return this.string(length);
  }

  string(length: number): string {
    let out = "";
    const end = this.offset + length;
    for (let i = this.offset; i < end; i += 4096) {
      const chunkEnd = Math.min(i + 4096, end);
      out += String.fromCharCode(...this.bytes.subarray(i, chunkEnd));
    }
    this.offset = end;
    return out;
  }

  /** Returns a *view* (no copy) over the next `length` bytes. */
  slice(length: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /** Returns a copy of the next `length` bytes. */
  copy(length: number): Uint8Array {
    return this.slice(length).slice();
  }

  /** Returns a view over an absolute range, without moving the cursor. */
  viewAt(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, offset + length);
  }
}

/** Reads a float or int field coming from a Wallpaper Engine JSON document. */
export function readNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** WE encodes vectors as space separated strings: `"1920.00000 1080.00000 0.00000"`. */
export function readVec(value: unknown, size: 2 | 3 | 4): number[] {
  const out = new Array<number>(size).fill(0);
  if (typeof value === "string") {
    const parts = value.trim().split(/\s+/);
    for (let i = 0; i < size; i++) out[i] = readNumber(parts[i], i === 3 ? 1 : 0);
    // A 2 component vector written as "x y" is common, keep the alpha default at 1.
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < size; i++) out[i] = readNumber(value[i], i === 3 ? 1 : 0);
    return out;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    out[0] = readNumber(record.x, 0);
    if (size > 1) out[1] = readNumber(record.y, 0);
    if (size > 2) out[2] = readNumber(record.z, 0);
    if (size > 3) out[3] = readNumber(record.w, 1);
    return out;
  }
  if (size === 4) out[3] = 1;
  return out;
}
