import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT ?? 5180);
const host = process.env.HOST ?? "127.0.0.1";

// 只读暴露本机 Wallpaper Engine 的 assets 目录，供「读取本机引擎资源」开关测试。
// 资源不会进入仓库，也不对外分发；没有安装时该路由整体禁用。
const engineCandidates = [
  process.env.WE_ASSETS,
  "C:\\Games\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "D:\\Steam\\steamapps\\common\\wallpaper_engine\\assets",
  "D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\assets"
].filter(Boolean);
const engineRoot = engineCandidates.find((candidate) => fs.existsSync(candidate));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ttf": "font/ttf",
  ".pkg": "application/octet-stream",
  ".tex": "application/octet-stream",
  ".map": "application/json; charset=utf-8"
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  // 壁纸清单：扫描 fixtures/ 下的 scene.pkg 与工程目录，供页面切换测试。
  if (url.pathname === "/api/wallpapers") {
    const entries = [];
    // 返回以 / 开头的绝对路径：页面在 /testbed/web/ 下，相对路径会解析错。
    const relative = (target) => "/" + path.relative(root, target).replace(/\\/g, "/");
    const titleOf = (dir, fallback) => {
      try {
        const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
        if (typeof project.title === "string" && project.title.trim()) return project.title.trim();
      } catch {}
      return fallback;
    };
    const previewOf = (dir) => {
      for (const name of ["preview.jpg", "preview.png", "preview.gif"]) {
        if (fs.existsSync(path.join(dir, name))) return relative(path.join(dir, name));
      }
      return undefined;
    };
    const scan = (dir, depth) => {
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name.startsWith(".") || item.name === "node_modules") continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (fs.existsSync(path.join(full, "scene.pkg"))) {
            entries.push({
              id: relative(full),
              kind: "package",
              name: titleOf(full, item.name),
              path: relative(path.join(full, "scene.pkg")),
              preview: previewOf(full)
            });
          } else if (fs.existsSync(path.join(full, "scene.json"))) {
            entries.push({ id: relative(full), kind: "project", name: titleOf(full, item.name), path: relative(full) + "/", preview: previewOf(full) });
          } else if (depth > 0) {
            scan(full, depth - 1);
          }
        } else if (item.name.toLowerCase().endsWith(".pkg")) {
          entries.push({ id: relative(full), kind: "package", name: item.name.replace(/\.pkg$/i, ""), path: relative(full) });
        }
      }
    };
    for (const extra of ["fixtures", "wallpapers"]) {
      const dir = path.join(root, extra);
      if (fs.existsSync(dir)) scan(dir, 3);
    }
    // 仓库根下直接摆放的 .pkg 也算一份壁纸（不递归进 build/ 之类的目录）。
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (item.isFile() && item.name.toLowerCase().endsWith(".pkg")) {
        entries.push({ id: relative(path.join(root, item.name)), kind: "package", name: item.name.replace(/\.pkg$/i, ""), path: relative(path.join(root, item.name)) });
      }
    }
    const seen = new Set();
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ wallpapers: entries.filter((entry) => (seen.has(entry.path) ? false : seen.add(entry.path))) }));
    return;
  }

  // 工程目录文件清单：让浏览器能把一个未打包的 WE 工程目录当资源包加载。
  if (url.pathname === "/api/files") {
    // 接受 "fixtures/x" 或 "/fixtures/x" 两种写法。
    const relativeDir = (url.searchParams.get("dir") ?? "").replace(/^[/\\]+/, "");
    const target = path.resolve(root, relativeDir);
    if (!target.startsWith(root)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    const files = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        const relative = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) walk(child, relative);
        else files.push(relative);
      }
    };
    try {
      walk(target, "");
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ files }));
    } catch (error) {
      response.writeHead(404).end(String(error && error.message ? error.message : error));
    }
    return;
  }

  // 引擎资源可用性探测（页面用它决定是否显示开关）。
  if (url.pathname === "/api/engine-assets") {
    const body = JSON.stringify({ available: Boolean(engineRoot), directory: engineRoot ?? null, url: engineRoot ? "/we-assets/" : null });
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(body);
    return;
  }

  // 只读代理：/we-assets/<引擎 assets 下的相对路径>
  if (url.pathname.startsWith("/we-assets/")) {
    if (!engineRoot) {
      response.writeHead(404).end("no local Wallpaper Engine installation detected");
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice("/we-assets/".length));
    const target = path.join(engineRoot, relative);
    if (!target.startsWith(engineRoot)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(target, (error, data) => {
      if (error) {
        response.writeHead(404).end("not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": "no-store"
      });
      response.end(data);
    });
    return;
  }

  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(root)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  try {
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    response.writeHead(404).end(`not found: ${url.pathname}`);
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404).end(`not found: ${url.pathname}`);
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    response.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`serving ${root} at http://${host}:${port}/`);
  console.log(`testbed:  http://${host}:${port}/testbed/web/`);
  console.log(`snapshot: http://${host}:${port}/testbed/web/?snapshot=1`);
  console.log(`variants: http://${host}:${port}/testbed/web/variants.html`);
  console.log(
    engineRoot
      ? `engine assets: 已检测到 ${engineRoot}（页面上的「引擎资源」开关会用到）`
      : "engine assets: 未检测到本机 Wallpaper Engine，开关会自动隐藏"
  );
});
