import { ROSSI_WALLPAPER, createRossiWallpaper, createRossiWorkerWallpaper, createWallpaper, createWorkerWallpaper, describeLayerParticleParameters, describeLayers, summariseScene } from "../../packages/we-scene/dist/index.js";

const params = new URLSearchParams(location.search);
const snapshot = params.get("snapshot") === "1";
// 当前壁纸来源：?pkg=<相对路径> / ?project=<目录> / ?wallpaper=<清单里的 id>；
// 都没给就用 /api/wallpapers 里的第一个。
let source = params.get("project")
  ? { kind: "project", path: params.get("project"), name: params.get("project") }
  : params.get("pkg")
    ? { kind: "package", path: params.get("pkg"), name: params.get("pkg") }
    : null;
const requestedWallpaper = params.get("wallpaper");
const fixedTime = params.get("time") ? Number(params.get("time")) : snapshot ? 6 : null;
const onlyLayers = params.get("layers");
// ?engine=1 读取本机 Wallpaper Engine 资源（服务端 /we-assets/ 只读代理）
let useEngineAssets = params.get("engine") === "1";
// ?worker=1 把渲染放进 worker（OffscreenCanvas）：主线程只留画布、尺寸与指针转发。
const workerMode = params.get("worker") === "1";
// ?bench=2 载入后故意占住主线程 2 秒，对比两条渲染路径还能出多少帧。
const benchSeconds = Number(params.get("bench") ?? 0) || 0;

/**
 * 用哪个接口加载：`normal` = 接口一（`createWallpaper`），
 * `rossi` = 接口二（`createRossiWallpaper`，洛茜壁纸专用预设）。
 * ?api=rossi 可以直接指定。
 */
let apiMode = params.get("api") === "rossi" ? "rossi" : "normal";

/** 接口一的默认粒子参数：整体上升，约 80% 向右、20% 向左。 */
const DEFAULT_DRIFT = { rise: 120, speed: 200, forwardRatio: 0.8, spread: 0.6 };

/**
 * 粒子模拟参数。渲染器持有这个对象的引用，滑块改动后下一帧即时生效，无需重建。
 */
const particleOptions = {
  drift: { ...DEFAULT_DRIFT }
};

/** 当前画布元素；worker 模式下重建渲染器时要换一块新的（控制权交出去就收不回来）。 */
let canvas = document.getElementById("canvas");

function replaceCanvas() {
  const next = canvas.cloneNode(false);
  canvas.replaceWith(next);
  canvas = next;
  return next;
}
const layerList = document.getElementById("layers");
const statusBox = document.getElementById("status");
const sceneInfo = document.getElementById("scene-info");
const timeSlider = document.getElementById("time");

// Snapshot mode renders the wallpaper alone unless ?ui=1 keeps the panel.
if (snapshot && params.get("ui") !== "1") {
  document.querySelector("aside").classList.add("hidden");
  document.querySelector("header").classList.add("hidden");
  document.body.style.gridTemplateColumns = "1fr";
  document.body.style.gridTemplateRows = "1fr";
  canvas.parentElement.style.gridColumn = "1 / -1";
}

let wallpaper;
let alive = false;
let loopStarted = false;
let playing = true;
let clock = fixedTime ?? 0;
let isolated = null;

function log(message) {
  statusBox.textContent += (statusBox.textContent ? "\n" : "") + message;
}

/** 把「壁纸来源」翻译成 createWallpaper 的参数。 */
function sourceOptions(current) {
  if (current.kind === "file") return { source: current.file };
  if (current.kind === "project") {
    // 工程目录：文件清单由服务端的 /api/files 提供（目录相对工作区根）。
    const dir = current.path.replace(/^[/\\]+/, "").replace(/\/$/, "");
    return { project: { baseUrl: current.path, manifestUrl: `/api/files?dir=${encodeURIComponent(dir)}` } };
  }
  return { source: current.path };
}

async function boot() {
  const started = performance.now();
  const common = {
    canvas,
    ...sourceOptions(source),
    fit: document.getElementById("fit").value,
    autoStart: false,
    // ?bg=0 在纯黑背景上渲染，便于单独观察加法混合的粒子层。
    clearColor: params.get("bg") === "0" ? [0, 0, 0] : undefined,
    engineAssets: useEngineAssets ? "/we-assets/" : undefined,
    // 接口二自带粒子预设，不在这里覆盖。
    ...(apiMode === "rossi" ? {} : { particles: particleOptions }),
    onDiagnostic: (message) => log("! " + message)
  };
  // worker 模式：帧由 worker 自己的定时器推动（主线程卡住也照画）；截图模式不自动开始，
  // 这样画面固定在 warmUp 指定的时刻，便于和主线程渲染逐像素对比。
  const workerExtras = workerMode ? { driver: "timer", statsIntervalMs: 400, autoStart: !snapshot } : {};
  // 接口一：普通加载；接口二：洛茜专用（预设图层 + 预设漂移参数，由库决定）。
  wallpaper =
    apiMode === "rossi"
      ? workerMode
        ? await createRossiWorkerWallpaper({ ...common, ...workerExtras })
        : await createRossiWallpaper(common)
      : workerMode
        ? await createWorkerWallpaper({ ...common, ...workerExtras })
        : await createWallpaper(common);
  const loadMs = Math.round(performance.now() - started);

  // worker 模式下场景在主线程是不存在的：概览、图层清单、参数表都由 worker 回传。
  const summary = workerMode ? wallpaper.summary : summariseScene(wallpaper.scene);
  sceneInfo.textContent = `${summary.resolution.width}x${summary.resolution.height} · ${summary.layerCount} 个图层 · ${Object.entries(summary.layersByType).map(([k, v]) => k + ":" + v).join(" ")}`;

  const layers = workerMode ? wallpaper.layers : describeLayers(wallpaper.scene);
  document.getElementById("layer-count").textContent = `(${layers.length})`;
  layerList.innerHTML = "";
  for (const layer of layers) {
    const row = document.createElement("div");
    row.className = "layer";
    row.dataset.id = String(layer.id);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = layer.visible;
    checkbox.onclick = (event) => {
      event.stopPropagation();
      wallpaper.setLayerVisible(layer.id, checkbox.checked);
      row.classList.toggle("dim", !checkbox.checked);
      render();
    };
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${layer.index}. ${layer.name}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const asset = layer.asset ? layer.asset.split("/").slice(-1)[0] : "—";
    meta.textContent = `${layer.type} · ${asset}${layer.effects.length ? " · fx:" + layer.effects.length : ""}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `#${layer.id}`;
    const left = document.createElement("div");
    left.append(checkbox);
    const right = document.createElement("div");
    right.append(name, meta);
    row.append(left, right, tag);
    row.onclick = () => {
      showParameters(layer);
      isolated = isolated === layer.id ? null : layer.id;
      for (const other of layerList.children) other.classList.toggle("selected", isolated === layer.id && other.dataset.id === String(layer.id));
      applyIsolation();
    };
    layerList.append(row);
  }

  if (onlyLayers) {
    const keep = new Set(onlyLayers.split(",").map((value) => Number(value)));
    for (const layer of layers) wallpaper.setLayerVisible(layer.id, keep.has(layer.id));
  }
  // ?params=<图层 id 或名称> 直接展开该粒子图层的参数面板（不影响图层显隐）。
  const paramsTarget = params.get("params");
  if (paramsTarget) {
    const layer = layers.find((entry) => String(entry.id) === paramsTarget || entry.name === paramsTarget);
    if (layer) showParameters(layer);
  }

  log(
    apiMode === "rossi"
      ? `接口：洛茜专用（预设图层 ${ROSSI_WALLPAPER.layers.include.join(" / ")}，漂移 ${ROSSI_WALLPAPER.particles.drift.rise}/${ROSSI_WALLPAPER.particles.drift.speed}/${ROSSI_WALLPAPER.particles.drift.forwardRatio}）`
      : "接口：普通加载"
  );
  log(
    workerMode
      ? wallpaper.archiveInfo
        ? `包格式 ${wallpaper.archiveInfo.magic} v${wallpaper.archiveInfo.version}，${wallpaper.archiveInfo.files} 个文件`
        : `工程目录模式（${source.path}）`
      : wallpaper.archive
        ? `包格式 ${wallpaper.archive.magic} v${wallpaper.archive.version}，${wallpaper.archive.list().length} 个文件`
        : `工程目录模式：${wallpaper.bundle.list().length} 个文件（${source.path}）`
  );
  log(
    workerMode
      ? `渲染：worker（OffscreenCanvas · driver=${workerExtras.driver} · ${wallpaper.capabilities?.renderer ?? "unknown"}）`
      : `渲染：主线程（${wallpaper.renderer.capabilities.renderer}）`
  );
  if (useEngineAssets) {
    const engine = await fetch("/api/engine-assets").then((response) => response.json()).catch(() => ({ available: false }));
    log(engine.available ? `引擎资源已启用：${engine.directory}` : "引擎资源不可用（本机未检测到 Wallpaper Engine）");
  }
  log(`解析 + 预加载耗时 ${loadMs} ms`);
  const errors = workerMode ? wallpaper.shaderErrors : wallpaper.renderer.shaderErrors;
  log(errors.length ? `着色器提示：\n${errors.join("\n")}` : "全部着色器编译通过");

  if (snapshot) {
    // Simulate up to the requested time so emitters, effects and text settle.
    await warmUp(fixedTime ?? 6);
    document.title = "ready";
  } else {
    const parallax = document.getElementById("parallax").checked;
    // worker 模式下场景对象在主线程不存在，只能通过接口改。
    if (workerMode) void wallpaper.setCameraParallax(parallax);
    else wallpaper.scene.general.cameraParallax = parallax;
    render();
    if (!loopStarted) {
      loopStarted = true;
      requestAnimationFrame(tick);
    }
  }
  alive = true;
  if (benchSeconds > 0 && !snapshot) await runMainThreadBench(benchSeconds);
  window.__ready = true;
  window.__wallpaper = wallpaper;
}

/**
 * 切换壁纸：销毁当前渲染器，按新的来源重建。粒子参数、引擎资源开关、适配模式
 * 是共享状态，切换后继续保持。
 */
async function reload() {
  alive = false;
  if (wallpaper) {
    wallpaper.stop();
    wallpaper.dispose();
    wallpaper = undefined;
  }
  // 画布控制权已经移交给 worker，收不回来：换一块新画布再建渲染器。
  if (workerMode) replaceCanvas();
  isolated = null;
  paramsPanel.classList.add("hidden");
  layerList.innerHTML = "";
  statusBox.textContent = "";
  window.__wallpaper = undefined;
  window.__ready = false;
  await boot();
}

/**
 * 粒子图层的参数面板：预设里写明的值用高亮显示，其余是按官方默认值补齐的，
 * 第三列标出该默认值的出处（引擎组件预览工程 / 官方预设统计 / 库内推断）。
 */
const paramsPanel = document.getElementById("params");
const paramsTitle = document.getElementById("params-title");
const paramsBody = document.getElementById("params-body");
const ORIGIN_LABEL = {
  preset: "预设写入",
  "engine-preview": "官方默认 · 组件预览工程",
  "engine-content": "官方默认 · 官方预设统计",
  "runtime-inferred": "库内推断"
};

let paramsRequest = 0;

function showParameters(layer) {
  paramsPanel.classList.add("hidden");
  paramsBody.innerHTML = "";
  if (!layer || layer.type !== "particle") return;
  if (workerMode) {
    // 主线程没有 SceneDocument：参数表由 worker 算好回传。
    const token = ++paramsRequest;
    void wallpaper.particleParameters(layer.id).then((resolved) => {
      if (token === paramsRequest && resolved) renderParameters(resolved);
    });
    return;
  }
  const resolved = describeLayerParticleParameters(wallpaper.scene, layer.id);
  if (!resolved) return;
  renderParameters(resolved);
}

function renderParameters(resolved) {
  paramsTitle.textContent = `粒子参数 · ${resolved.name}`;
  for (const system of resolved.systems) {
    const heading = document.createElement("div");
    heading.className = "component";
    heading.textContent = system.path.split("/").slice(-1)[0];
    paramsBody.append(heading);
    const table = document.createElement("table");
    let currentComponent = "";
    for (const entry of system.parameters) {
      if (entry.component !== currentComponent) {
        currentComponent = entry.component;
        const groupRow = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.className = "component";
        cell.textContent = `${entry.kind} · ${entry.component}`;
        groupRow.append(cell);
        table.append(groupRow);
      }
      const row = document.createElement("tr");
      if (entry.origin === "preset") row.className = "preset";
      const name = document.createElement("td");
      name.textContent = entry.property;
      const value = document.createElement("td");
      value.className = "value";
      value.textContent = typeof entry.value === "number" ? String(Number(entry.value.toFixed(6))) : String(entry.value);
      const origin = document.createElement("td");
      origin.className = "origin";
      origin.textContent = ORIGIN_LABEL[entry.origin] ?? entry.origin;
      if (entry.evidence) origin.title = entry.evidence;
      row.append(name, value, origin);
      table.append(row);
    }
    paramsBody.append(table);
  }
  paramsPanel.classList.remove("hidden");
}

function applyIsolation() {
  for (const layer of wallpaper.layers) {
    wallpaper.setLayerVisible(layer.id, isolated === null ? true : layer.id === isolated);
  }
  render();
}

function render() {
  if (!wallpaper) return;
  if (workerMode) {
    // 只发一条消息；绘制发生在 worker 里。
    void wallpaper.renderFrame(clock);
    return;
  }
  wallpaper.renderer.render(clock, { mouse: mousePosition });
}

/** Advances the scene clock so particles and animations settle before a snapshot. */
async function warmUp(seconds) {
  if (workerMode) {
    // 整段推进都在 worker 里跑：主线程只等一条消息。
    await wallpaper.warmUp(seconds);
    clock = seconds;
    return;
  }
  const step = 1 / 60;
  for (let t = 0; t <= seconds; t += step) {
    wallpaper.renderer.render(t, { mouse: mousePosition });
    if (Math.round(t * 60) % 30 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  clock = seconds;
  wallpaper.renderer.render(clock, { mouse: mousePosition });
  await wallpaper.renderer.ready();
  wallpaper.renderer.render(clock, { mouse: mousePosition });
}

let lastFrameTime = performance.now();
/** 主线程自己画了多少帧（?bench= 对照用）。 */
let framesDrawn = 0;

function tick(timestamp) {
  const delta = (timestamp - lastFrameTime) / 1000;
  lastFrameTime = timestamp;
  if (!alive || !wallpaper) {
    requestAnimationFrame(tick);
    return;
  }
  if (workerMode) {
    // worker 自己在出帧：主线程这个循环只读统计、刷 UI。
    const stats = wallpaper.stats;
    if (stats) {
      clock = stats.time;
      if (playing) timeSlider.value = String(clock % 20);
      const drawn = stats.stats.filter((entry) => entry.drawn).length;
      statusBox.textContent = `${stats.fps.toFixed(0)} fps（worker）· 实绘 ${drawn}/${wallpaper.layers.length} 层 · t=${clock.toFixed(2)}s · 第 ${stats.frames} 帧`;
    }
    requestAnimationFrame(tick);
    return;
  }
  if (playing) {
    clock += delta;
    timeSlider.value = String(clock % 20);
  }
  render();
  framesDrawn++;
  const stats = wallpaper.renderer.layerStats.filter((entry) => entry.drawn).length;
  statusBox.textContent = `${Math.round(1 / Math.max(delta, 1e-4))} fps · 实绘 ${stats}/${wallpaper.layerCount} 层 · t=${clock.toFixed(2)}s`;
  for (const error of wallpaper.renderer.diagnostics.slice(-3)) if (!statusBox.textContent.includes(error)) statusBox.textContent += "\n! " + error;
  requestAnimationFrame(tick);
}

/**
 * 主线程阻塞对照（?bench=<秒>）：把主线程占住一段时间，数这段时间里画面出了多少帧。
 * worker 渲染时帧来自 worker 自己的定时器，主线程卡住照出；主线程渲染则直接停摆。
 */
async function runMainThreadBench(seconds) {
  const count = async () => (workerMode ? (await wallpaper.requestStats()).frames : framesDrawn);
  // 等 worker 热起来（首帧要编译着色器，SwANGLE 下可能占满一两秒），否则量到的是启动耗时。
  if (workerMode) {
    const deadline = performance.now() + 8000;
    for (;;) {
      const stats = await wallpaper.requestStats();
      if (stats.frames >= 60 || performance.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const before = await count();
  const started = performance.now();
  while (performance.now() - started < seconds * 1000) {
    // 故意占住主线程（等价于宿主在做重活）。
  }
  const after = await count();
  window.__bench = { mode: workerMode ? "worker" : "main", seconds, frames: after - before, fps: +((after - before) / seconds).toFixed(1) };
  log(`主线程阻塞 ${seconds}s：${workerMode ? "worker" : "主线程"}渲染出了 ${after - before} 帧（${((after - before) / seconds).toFixed(1)} fps）`);
}

let mousePosition;
window.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  mousePosition = [((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1)];
});

document.getElementById("fit").onchange = (event) => {
  if (workerMode) {
    void wallpaper.setFit(event.target.value);
    return;
  }
  wallpaper.renderer.options.fit = event.target.value;
  render();
};
document.getElementById("play").onclick = (event) => {
  playing = !playing;
  event.target.textContent = playing ? "暂停" : "播放";
  if (workerMode) {
    if (playing) wallpaper.start();
    else wallpaper.stop();
  }
};
document.getElementById("isolate").onclick = () => {
  isolated = isolated === null ? wallpaper.layers[wallpaper.layers.length - 1].id : null;
  applyIsolation();
};
document.getElementById("reset").onclick = () => {
  isolated = null;
  for (const row of layerList.children) {
    row.classList.remove("selected", "dim");
    row.querySelector("input").checked = true;
  }
  applyIsolation();
};
timeSlider.oninput = (event) => {
  playing = false;
  document.getElementById("play").textContent = "播放";
  clock = Number(event.target.value);
  if (workerMode) wallpaper.stop();
  render();
};
document.getElementById("parallax").onchange = (event) => {
  if (workerMode) {
    void wallpaper.setCameraParallax(event.target.checked);
    return;
  }
  wallpaper.scene.general.cameraParallax = event.target.checked;
  render();
};

// 上浮漂移：直接改 particleOptions（渲染器持有引用，改完下一帧生效）。
const driftToggle = document.getElementById("drift");
const driftInputs = {
  rise: document.getElementById("drift-rise"),
  speed: document.getElementById("drift-speed"),
  forwardRatio: document.getElementById("drift-ratio")
};
const driftValueLabels = {
  rise: document.getElementById("drift-rise-value"),
  speed: document.getElementById("drift-speed-value"),
  forwardRatio: document.getElementById("drift-ratio-value")
};

/** 把滑块与标签同步成给定的一组漂移参数。 */
function showDrift(preset, enabled) {
  for (const [key, input] of Object.entries(driftInputs)) {
    input.value = String(preset[key]);
    input.disabled = !enabled;
    driftValueLabels[key].textContent = key === "forwardRatio" ? Number(preset[key]).toFixed(2) : String(preset[key]);
  }
  driftToggle.checked = enabled;
  driftToggle.disabled = !enabled;
}

driftToggle.onchange = () => {
  particleOptions.drift = driftToggle.checked ? { ...DEFAULT_DRIFT } : undefined;
  showDrift(driftToggle.checked ? DEFAULT_DRIFT : DEFAULT_DRIFT, driftToggle.checked);
  render();
};
for (const [key, input] of Object.entries(driftInputs)) {
  input.oninput = () => {
    const value = Number(input.value);
    if (particleOptions.drift) particleOptions.drift[key] = value;
    driftValueLabels[key].textContent = key === "forwardRatio" ? value.toFixed(2) : String(value);
  };
}

/**
 * 接口切换：`normal` 用接口一（粒子参数由滑块控制），
 * `rossi` 用接口二 —— 图层与漂移参数都取自库里的洛茜预设，滑块只作展示。
 */
const apiSelect = document.getElementById("api");
function applyApiMode(mode, shouldReload = false) {
  apiMode = mode === "rossi" ? "rossi" : "normal";
  apiSelect.value = apiMode;
  const rossi = apiMode === "rossi";
  if (rossi) {
    // 接口二自己带参数：这里不覆盖 particleOptions，交给 createRossiWallpaper。
    showDrift(ROSSI_WALLPAPER.particles.drift, false);
  } else {
    showDrift(DEFAULT_DRIFT, true);
    Object.assign(particleOptions, { drift: { ...DEFAULT_DRIFT } });
  }
  const url = new URL(location.href);
  if (rossi) url.searchParams.set("api", "rossi");
  else url.searchParams.delete("api");
  history.replaceState(null, "", url);
  if (shouldReload) void reload();
}
apiSelect.onchange = () => applyApiMode(apiSelect.value, true);
applyApiMode(apiMode);

/**
 * 壁纸切换器：清单来自 /api/wallpapers（服务器扫描 fixtures/ 下的 scene.pkg 与工程目录），
 * 也可以选本机文件或直接把 .pkg 拖进画面。切换会重建渲染器（场景不同，无法增量替换）。
 */
const wallpaperSelect = document.getElementById("wallpaper");
let wallpapers = [];

function currentSourceId() {
  if (!source) return "";
  if (source.kind === "file") return "__file__";
  return wallpapers.find((entry) => entry.path === source.path)?.id ?? "";
}

async function loadWallpaperList() {
  try {
    const info = await fetch("/api/wallpapers").then((response) => response.json());
    wallpapers = info.wallpapers ?? [];
  } catch {
    wallpapers = [];
  }
  wallpaperSelect.innerHTML = "";
  for (const entry of wallpapers) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${entry.name}（${entry.kind === "package" ? "scene.pkg" : "工程目录"}）`;
    option.title = entry.path;
    wallpaperSelect.append(option);
  }
  const local = document.createElement("option");
  local.value = "__file__";
  local.textContent = "本地 .pkg（选文件或拖进画面）";
  wallpaperSelect.append(local);
  wallpaperSelect.value = currentSourceId();
}

/** 从清单（或 ?wallpaper=）里挑出初始壁纸。 */
async function resolveInitialSource() {
  await loadWallpaperList();
  if (source) return; // ?pkg= / ?project= 优先
  const entry = (requestedWallpaper && wallpapers.find((item) => item.id === requestedWallpaper)) || wallpapers[0];
  // 没有素材（仓库里不带 fixtures/）时不硬猜路径：提示用户放素材或直接拖 .pkg 进来。
  source = entry ? { kind: entry.kind, path: entry.path, name: entry.name } : null;
}

async function switchWallpaper(next) {
  source = next;
  wallpaperSelect.value = currentSourceId();
  const url = new URL(location.href);
  url.searchParams.delete("pkg");
  url.searchParams.delete("project");
  url.searchParams.delete("wallpaper");
  if (next.kind === "project") url.searchParams.set("project", next.path);
  else if (next.kind === "package") url.searchParams.set("wallpaper", currentSourceId());
  history.replaceState(null, "", url);
  await reload();
}

wallpaperSelect.onchange = async () => {
  const id = wallpaperSelect.value;
  if (id === "__file__") {
    document.getElementById("wallpaper-file").click();
    wallpaperSelect.value = currentSourceId();
    return;
  }
  const entry = wallpapers.find((item) => item.id === id);
  if (entry) await switchWallpaper({ kind: entry.kind, path: entry.path, name: entry.name });
};
document.getElementById("wallpaper-refresh").onclick = async () => {
  await loadWallpaperList();
  wallpaperSelect.value = currentSourceId();
};
document.getElementById("wallpaper-file").onchange = async (event) => {
  const file = event.target.files?.[0];
  if (file) await switchWallpaper({ kind: "file", file, name: file.name });
};

// 拖拽 .pkg 到画面上直接载入。
const stage = document.querySelector(".stage");
stage.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  stage.classList.add("drop-target");
});
stage.addEventListener("dragleave", () => stage.classList.remove("drop-target"));
stage.addEventListener("drop", async (event) => {
  const file = event.dataTransfer?.files?.[0];
  stage.classList.remove("drop-target");
  if (!file) return;
  event.preventDefault();
  await switchWallpaper({ kind: "file", file, name: file.name });
});

// 引擎资源开关：本机装了 Wallpaper Engine 时才出现；切换会重建渲染器。
const engineToggle = document.getElementById("engine");
fetch("/api/engine-assets")
  .then((response) => response.json())
  .then((info) => {
    if (!info.available) return;
    document.getElementById("engine-label").classList.remove("hidden");
    engineToggle.checked = useEngineAssets;
  })
  .catch(() => {});
engineToggle.onchange = async () => {
  useEngineAssets = engineToggle.checked;
  statusBox.textContent = useEngineAssets ? "重新加载：使用本机引擎资源…" : "重新加载：使用内置近似资源…";
  await reload();
};

// worker 渲染开关：画布控制权一旦移交就不能收回，切换直接改 URL 重载。
const workerToggle = document.getElementById("worker");
if (workerToggle) {
  workerToggle.checked = workerMode;
  workerToggle.onchange = () => {
    const url = new URL(location.href);
    if (workerToggle.checked) url.searchParams.set("worker", "1");
    else url.searchParams.delete("worker");
    location.href = url.toString();
  };
}

resolveInitialSource()
  .then(() => {
    if (!source) {
      statusBox.textContent = [
        "没有找到可测试的壁纸。",
        "把 scene.pkg 或未打包的工程目录放进 fixtures/<名字>/（详见 fixtures/README.md），",
        "然后点控制栏的 ↻ 重新扫描；也可以直接用「本地 .pkg」按钮或把 .pkg 拖进画面。"
      ].join("\n");
      return undefined;
    }
    return boot();
  })
  .catch((error) => {
    log("启动失败: " + (error && error.stack ? error.stack : error));
    console.error(error);
    window.__error = String(error && error.stack ? error.stack : error);
  });
