/**
 * Screenshot / diagnostics harness for the lab pages.
 *
 * Launches headless Chrome with the DevTools protocol, waits for the page to
 * signal `window.__ready` (real time, unlike --virtual-time-budget which never
 * resolves `createImageBitmap`), then captures a screenshot and any console
 * output.
 *
 *   node testbed/scripts/snapshot.mjs "http://127.0.0.1:5180/testbed/web/?snapshot=1&time=6" build/lab.png
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];

const url = process.argv[2] ?? "http://127.0.0.1:5180/testbed/web/";
const outPath = path.resolve(process.argv[3] ?? "build/snapshot.png");
const width = Number(process.argv[4] ?? 1280);
const height = Number(process.argv[5] ?? 720);
const waitMs = Number(process.env.SNAPSHOT_TIMEOUT ?? 180000);

const chromePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!chromePath) throw new Error("Chrome or Edge not found");

const port = 9222 + Math.floor(Math.random() * 500);
const profile = path.resolve("build", `chrome-cdp-${port}`);
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    "about:blank"
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);
chrome.stderr.on("data", (chunk) => {
  const text = String(chunk);
  if (/FATAL|Uncaught|SEVERE/.test(text)) process.stderr.write(text);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findTarget() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting up.
    }
    await sleep(250);
  }
  throw new Error("Chrome DevTools endpoint never became available");
}

const socketUrl = await findTarget();
const socket = new WebSocket(socketUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const console_lines = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(typeof event.data === "string" ? event.data : "");
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
    console_lines.push(`[${message.params.type}] ${text}`);
  }
  if (message.method === "Runtime.exceptionThrown") {
    console_lines.push(`[exception] ${message.params.exceptionDetails?.exception?.description ?? "unknown"}`);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 120000);
  });
}

async function evaluate(expression, awaitPromise = false) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, includeCommandLineAPI: true });
  if (result.exceptionDetails) return { error: result.exceptionDetails.exception?.description ?? "evaluation failed" };
  return { value: result.result?.value };
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable").catch(() => {});
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });

const deadline = Date.now() + waitMs;
let ready = false;
while (Date.now() < deadline) {
  await sleep(500);
  const state = await evaluate("JSON.stringify({ ready: window.__ready === true, error: window.__error || null, title: document.title })");
  if (state.value) {
    const parsed = JSON.parse(state.value);
    if (parsed.error) {
      console.log("PAGE ERROR: " + parsed.error);
      break;
    }
    if (parsed.ready) {
      ready = true;
      break;
    }
  }
}

// Let a few animation frames run so textures finish uploading.
await sleep(2500);

// SNAPSHOT_EVAL=<js expression>: 在页面里跑一段脚本（用来模拟点选、切换壁纸等交互）。
const evalScript = process.env.SNAPSHOT_EVAL;
if (evalScript) {
  const result = await evaluate(`(async () => { ${evalScript} })()`, true);
  console.log("eval:", result.error ? "failed: " + String(result.error).split("\n")[0] : JSON.stringify(result.value));
  await sleep(2500);
}

// SNAPSHOT_CLICK=<css selector>: click something first (used to open lab panels).
const clickSelector = process.env.SNAPSHOT_CLICK;
if (clickSelector) {
  const clicked = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(clickSelector)});
    if (!element) return "not found";
    element.click();
    return "clicked";
  })()`);
  console.log("click " + clickSelector + ":", clicked.value);
  await sleep(600);
}
const diagnostics = await evaluate(`(async () => {
  const wallpaper = window.__wallpaper;
  if (!wallpaper) return JSON.stringify({ ready: window.__ready === true, note: 'no wallpaper handle' });
  const canvas = document.getElementById("canvas");
  // 主线程渲染时一切都在 wallpaper.renderer 上；worker 渲染时用回传的清单与统计。
  const renderer = wallpaper.renderer;
  const worker = renderer ? null : wallpaper;
  // worker 路径一律现问一次：statsIntervalMs 推回来的可能是上一帧的快照。
  const workerStats = renderer ? null : await worker.requestStats();
  const layerStats = renderer ? renderer.layerStats : workerStats.stats;
  const engine = renderer
    ? (renderer.engineAssetStats ? { stats: renderer.engineAssetStats, files: renderer.loadedEngineAssets, missing: renderer.missingEngineAssets } : null)
    : (worker.engineAssets ? { stats: { cached: worker.engineAssets.cached, missing: worker.engineAssets.missing, bytes: worker.engineAssets.bytes }, files: worker.engineAssets.loaded, missing: worker.engineAssets.missingFiles } : null);
  return JSON.stringify({
    mode: renderer ? "main" : "worker",
    bench: window.__bench ?? null,
    runtime: worker ? { offscreen: worker.offscreen === true, stats: workerStats } : null,
    canvas: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null,
    layers: renderer ? wallpaper.layerCount : wallpaper.layers.length,
    viewport: renderer ? renderer.viewportSize : { width: canvas.width, height: canvas.height, pixelRatio: window.devicePixelRatio || 1 },
    panel: (() => {
      const panel = document.getElementById("params");
      if (!panel || panel.classList.contains("hidden")) return null;
      return document.getElementById("params-body")?.textContent?.replace(/\\s+/g, " ").slice(0, 800) ?? null;
    })(),
    engine,
    drawn: layerStats.filter((entry) => entry.drawn).map((entry) => entry.layerId),
    shaderErrors: renderer ? renderer.shaderErrors : worker.shaderErrors,
    diagnostics: renderer ? renderer.diagnostics.slice(0, 20) : worker.diagnostics.slice(0, 20),
    stats: layerStats.map((entry) => ({ id: entry.layerId, type: entry.type, drawn: entry.drawn, reason: entry.reason, particles: entry.particles, quad: entry.quad, bounds: entry.bounds, clip: entry.clip })),
    // Mean luminance of the rendered canvas, handy to spot blown out effects.
    probe: (() => {
      const probe = document.createElement("canvas");
      probe.width = 1; probe.height = 20;
      const context = probe.getContext("2d");
      context.drawImage(canvas, 0, 0, 1, 20);
      const data = context.getImageData(0, 0, 1, 20).data;
      const rows = [];
      for (let i = 0; i < 20; i++) rows.push("y" + Math.round((i / 19) * 100) + "%=" + data[i * 4] + "," + data[i * 4 + 1] + "," + data[i * 4 + 2] + "," + data[i * 4 + 3]);
      return rows.join(" ");
    })(),
    image: (() => {
      const probe = document.createElement("canvas");
      probe.width = 160;
      probe.height = 90;
      const context = probe.getContext("2d");
      context.drawImage(canvas, 0, 0, probe.width, probe.height);
      const data = context.getImageData(0, 0, probe.width, probe.height).data;
      let sum = 0;
      let blown = 0;
      const count = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const luminance = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
        sum += luminance;
        if (luminance > 0.95) blown++;
      }
      return { mean: +(sum / count).toFixed(3), blownPercent: +((blown / count) * 100).toFixed(1) };
    })()
  });
})()`, true);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));

console.log("ready:", ready);
console.log("screenshot:", outPath);
if (diagnostics.error) console.log("diagnostics failed:", String(diagnostics.error).split("\n")[0]);
if (diagnostics.value) {
  const parsed = JSON.parse(diagnostics.value);
  if (parsed.mode) console.log("render mode:", parsed.mode + (parsed.runtime ? ` (${parsed.runtime.offscreen ? "OffscreenCanvas" : "canvas"})` : ""));
  if (parsed.bench) console.log("main-thread block bench:", JSON.stringify(parsed.bench));
  if (parsed.runtime?.stats) console.log("worker runtime:", JSON.stringify({ fps: parsed.runtime.stats.fps, frames: parsed.runtime.stats.frames, time: +parsed.runtime.stats.time.toFixed(2) }));
  console.log("drawn layers:", JSON.stringify(parsed.drawn));
  console.log("canvas:", JSON.stringify(parsed.canvas));
  if (parsed.viewport) console.log("viewport:", JSON.stringify(parsed.viewport));
  if (parsed.image) console.log("image:", JSON.stringify(parsed.image));
  if (parsed.probe) console.log("column:", parsed.probe);
  if (parsed.panel) console.log("panel:", parsed.panel);
  if (parsed.stats) {
    const drawn = parsed.stats.filter((entry) => entry.drawn && entry.quad);
    if (drawn.length) console.log("geometry:", JSON.stringify(drawn));
  }
  if (parsed.engine) {
    console.log("engine assets:", JSON.stringify(parsed.engine.stats));
    console.log("  loaded: " + parsed.engine.files.join("\n          "));
    if (parsed.engine.missing?.length) console.log("  missing: " + parsed.engine.missing.join(", "));
  }
  if (parsed.stats) {
    const particles = parsed.stats.filter((entry) => entry.particles !== undefined);
    if (particles.length) console.log("particles:", JSON.stringify(particles));
  }
  if (parsed.shaderErrors?.length) console.log("shader errors:\n" + parsed.shaderErrors.join("\n"));
  if (parsed.diagnostics?.length) console.log("diagnostics:\n" + parsed.diagnostics.join("\n"));
  if (parsed.stats) {
    const skipped = parsed.stats.filter((entry) => !entry.drawn);
    if (skipped.length) console.log("skipped:", JSON.stringify(skipped, null, 1));
  }
}
if (console_lines.length) console.log("console:\n" + console_lines.slice(0, 30).join("\n"));

socket.close();
chrome.kill();
await sleep(300);
process.exit(0);
