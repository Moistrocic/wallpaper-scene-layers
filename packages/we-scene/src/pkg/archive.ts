import { BinaryReader } from "../util/bytes.js";

/**
 * A single file stored inside a `scene.pkg`.
 *
 * Offsets are relative to the start of the payload section (right after the
 * file table), which is how Wallpaper Engine <-> PKGV0024 stores them.
 */
export interface PackageEntry {
  /** Normalised, forward slash separated path, e.g. `materials/foo.tex`. */
  path: string;
  /** Offset of the payload relative to the package data section. */
  offset: number;
  /** Size of the payload in bytes. */
  size: number;
}

export interface PackageHeader {
  /** e.g. `PKGV0024` */
  magic: string;
  version: number;
  /** Absolute offset of the first payload byte. */
  dataOffset: number;
  entries: PackageEntry[];
}

/**
 * Parses the file table of a Wallpaper Engine package.
 *
 * Layout (little endian):
 * ```
 * u32  magicLength            // 8
 * char magic[magicLength]     // "PKGV0024"
 * u32  entryCount
 * entryCount * {
 *   u32  pathLength
 *   char path[pathLength]
 *   u32  offset
 *   u32  size
 * }
 * byte payload[]              // offsets above are relative to this point
 * ```
 */
export function parsePackage(input: ArrayBuffer | ArrayBufferView): PackageHeader {
  const reader = new BinaryReader(input);
  const magicLength = reader.u32();
  const magic = reader.string(magicLength);
  if (!magic.startsWith("PKGV")) {
    throw new Error(`Not a Wallpaper Engine package (magic: "${magic}")`);
  }
  const version = Number.parseInt(magic.slice(4), 10) || 0;
  const entryCount = reader.u32();
  if (entryCount > 1_000_000) {
    throw new Error(`Corrupt package: unreasonable entry count ${entryCount}`);
  }
  const entries: PackageEntry[] = new Array(entryCount);
  for (let i = 0; i < entryCount; i++) {
    const path = reader.lengthPrefixedString();
    const offset = reader.u32();
    const size = reader.u32();
    entries[i] = { path: path.replace(/\\/g, "/"), offset, size };
  }
  return { magic, version, dataOffset: reader.offset, entries };
}

/**
 * A parsed `scene.pkg`. Payloads are exposed as zero copy `Uint8Array` views,
 * so holding an archive alive keeps the (single) backing buffer alive as well.
 */
export class PackageArchive {
  readonly header: PackageHeader;
  private readonly bytes: Uint8Array;
  private readonly index = new Map<string, PackageEntry>();

  constructor(input: ArrayBuffer | ArrayBufferView) {
    this.header = parsePackage(input);
    const buffer = input instanceof ArrayBuffer ? input : input.buffer;
    const byteOffset = input instanceof ArrayBuffer ? 0 : input.byteOffset;
    // Keep only the slice that actually belongs to this package.
    const total = this.header.dataOffset + this.header.entries.reduce((max, e) => Math.max(max, e.offset + e.size), 0);
    this.bytes = new Uint8Array(buffer, byteOffset, Math.min(total, input.byteLength));
    for (const entry of this.header.entries) {
      this.index.set(entry.path.toLowerCase(), entry);
    }
  }

  get version(): number {
    return this.header.version;
  }

  get magic(): string {
    return this.header.magic;
  }

  /** All file paths contained in the package. */
  list(): string[] {
    return this.header.entries.map((entry) => entry.path);
  }

  has(path: string): boolean {
    return this.index.has(normalise(path));
  }

  find(path: string): PackageEntry | undefined {
    return this.index.get(normalise(path));
  }

  /** Returns a zero copy view of a stored file, or `undefined` when missing. */
  get(path: string): Uint8Array | undefined {
    const entry = this.find(path);
    if (!entry) return undefined;
    const start = this.header.dataOffset + entry.offset;
    return this.bytes.subarray(start, start + entry.size);
  }

  /** Returns a textual file (JSON, shader source, ...). */
  getText(path: string): string | undefined {
    const data = this.get(path);
    return data ? decodeUtf8(data) : undefined;
  }

  getJSON<T = unknown>(path: string): T | undefined {
    const text = this.getText(path);
    if (text === undefined) return undefined;
    return JSON.parse(stripJsonComments(text)) as T;
  }
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

const utf8 = new TextDecoder("utf-8");

export function decodeUtf8(data: Uint8Array): string {
  // Wallpaper Engine writes UTF-8 JSON, sometimes with a BOM.
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return utf8.decode(data.subarray(3));
  }
  return utf8.decode(data);
}

/**
 * Wallpaper Engine is lenient about JSON and some workshop items ship shader or
 * material files with `//` comments. `JSON.parse` is not, so strip them.
 */
export function stripJsonComments(text: string): string {
  if (text.indexOf("//") === -1) return text;
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}
