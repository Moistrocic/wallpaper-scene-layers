#!/usr/bin/env node
/**
 * 两张 PNG 的逐像素对比（零依赖，只用 node:zlib）。
 *
 *   node testbed/scripts/pixel-diff.mjs build/main.png build/worker.png [--max=<容差>]
 *
 * 用途：验证「worker 渲染」与「主线程渲染」在同样输入下画面是否一致。
 * 默认要求逐像素完全相同（容差 0），有差异时打印差异最大的像素并返回 1。
 * 注意：粒子系统用的是 Math.random()，含粒子层的截图本来就每次都不一样——
 * 对比时请用 ?layers= 排除粒子层，或者接受一定容差。
 */
import fs from "node:fs";
import zlib from "node:zlib";

/** 解码 8 位 PNG（颜色类型 2/6，非隔行）。 */
function decodePNG(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47 || data.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error(file + ": 不是 PNG");
  let offset = 8;
  let header;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12]
      };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error(file + ": 缺少 IHDR");
  if (header.bitDepth !== 8) throw new Error(file + ": 只支持 8 位深度（收到 " + header.bitDepth + "）");
  if (header.interlace !== 0) throw new Error(file + ": 不支持隔行扫描");
  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(file + ": 只支持 RGB / RGBA（颜色类型 " + header.colorType + "）");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(header.height * stride);
  let source = 0;
  for (let y = 0; y < header.height; y++) {
    const filter = raw[source++];
    const row = raw.subarray(source, source + stride);
    source += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0;
      const above = up ? up[x] : 0;
      const upperLeft = up && x >= channels ? up[x - channels] : 0;
      const value = row[x];
      switch (filter) {
        case 0: out[x] = value; break;
        case 1: out[x] = (value + left) & 0xff; break;
        case 2: out[x] = (value + above) & 0xff; break;
        case 3: out[x] = (value + ((left + above) >> 1)) & 0xff; break;
        case 4: {
          const p = left + above - upperLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - above);
          const pc = Math.abs(p - upperLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
          out[x] = (value + predictor) & 0xff;
          break;
        }
        default: throw new Error(file + ": 未知的行过滤器 " + filter);
      }
    }
  }
  return { width: header.width, height: header.height, channels, pixels };
}

const args = process.argv.slice(2);
const files = args.filter((arg) => !arg.startsWith("--"));
const toleranceArg = args.find((arg) => arg.startsWith("--max="));
const tolerance = toleranceArg ? Number(toleranceArg.slice(6)) : 0;
if (files.length !== 2) {
  console.log("用法: node testbed/scripts/pixel-diff.mjs <a.png> <b.png> [--max=<允许的最大单通道差值>]");
  process.exit(2);
}

const a = decodePNG(files[0]);
const b = decodePNG(files[1]);
if (a.width !== b.width || a.height !== b.height) {
  console.log("尺寸不同: " + a.width + "x" + a.height + " vs " + b.width + "x" + b.height);
  process.exit(1);
}

const channels = Math.min(a.channels, b.channels);
let max = 0;
let sum = 0;
let differing = 0;
let worst = null;
for (let y = 0; y < a.height; y++) {
  for (let x = 0; x < a.width; x++) {
    const ia = (y * a.width + x) * a.channels;
    const ib = (y * b.width + x) * b.channels;
    let pixelDiffers = false;
    for (let c = 0; c < channels; c++) {
      const diff = Math.abs(a.pixels[ia + c] - b.pixels[ib + c]);
      sum += diff;
      if (diff > max) {
        max = diff;
        worst = { x, y, channel: c, a: a.pixels[ia + c], b: b.pixels[ib + c] };
      }
      if (diff > 0) pixelDiffers = true;
    }
    if (pixelDiffers) differing++;
  }
}
const samples = a.width * a.height * channels;
console.log(files[0] + "  vs  " + files[1]);
console.log("尺寸      " + a.width + "x" + a.height);
console.log("最大差值  " + max + (worst ? "  @(" + worst.x + "," + worst.y + ") 通道" + worst.channel + " " + worst.a + "->" + worst.b : ""));
console.log("平均差值  " + (sum / samples).toFixed(4));
console.log("不同像素  " + differing + " / " + a.width * a.height + " (" + ((differing / (a.width * a.height)) * 100).toFixed(2) + "%)");
if (max > tolerance) {
  console.log("结果      不一致（容差 " + tolerance + "）");
  process.exit(1);
}
console.log("结果      一致（容差 " + tolerance + "）");