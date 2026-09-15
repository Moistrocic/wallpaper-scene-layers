/**
 * LZ4 *block* decompressor.
 *
 * Wallpaper Engine stores compressed texture mip data as a bare LZ4 block
 * (no frame header, no checksum), so the standard `lz4js` frame decoder does
 * not apply. The expected output size is always known from the container.
 */
export function lz4DecompressBlock(source: Uint8Array, outputSize: number): Uint8Array {
  const output = new Uint8Array(outputSize);
  let si = 0;
  let di = 0;
  const srcLength = source.length;

  while (si < srcLength) {
    const token = source[si++];

    // Literals.
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let byte = 0;
      do {
        byte = source[si++];
        literalLength += byte;
      } while (byte === 255);
    }
    if (literalLength > 0) {
      if (di + literalLength > outputSize) {
        // Tolerate slightly over-long streams instead of throwing on a whole scene.
        literalLength = outputSize - di;
        if (literalLength <= 0) break;
      }
      output.set(source.subarray(si, si + literalLength), di);
      si += literalLength;
      di += literalLength;
    }

    if (si >= srcLength) break;

    // Match copy.
    const offset = source[si] | (source[si + 1] << 8);
    si += 2;
    if (offset === 0) throw new Error("LZ4: invalid zero match offset");

    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let byte = 0;
      do {
        byte = source[si++];
        matchLength += byte;
      } while (byte === 255);
    }
    matchLength += 4;

    let from = di - offset;
    if (from < 0) throw new Error(`LZ4: match offset ${offset} before start of output`);
    const limit = Math.min(di + matchLength, outputSize);
    while (di < limit) output[di++] = output[from++];
    if (di >= outputSize) break;
  }

  return output;
}
