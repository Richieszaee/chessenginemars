const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8080", 10);
const VIEWER_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  // Allow embedding in Arena live preview iframe and any preview origin/host
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

  // Request log for diagnosing preview issues
  res.on("finish", () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode}`);
  });

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, "http://0.0.0.0");
  let pathname = decodeURIComponent(urlObj.pathname);

  if (pathname === "/" || pathname === "/index.html") {
    const htmlPath = path.join(VIEWER_DIR, "index.html");
    res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] });
    fs.createReadStream(htmlPath).pipe(res);
    return;
  }

  if (pathname === "/island.glb" || pathname === "/download/island.glb") {
    const glbPath = path.join(REPO_ROOT, "island.glb");
    if (!fs.existsSync(glbPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("island.glb not found");
      return;
    }
    const stat = fs.statSync(glbPath);
    const headers = {
      "Content-Type": "model/gltf-binary",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
    };
    if (pathname.startsWith("/download/")) {
      headers["Content-Disposition"] = 'attachment; filename="island.glb"';
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
    } else {
      fs.createReadStream(glbPath).pipe(res);
    }
    return;
  }

  // Serve static files inside island_3d/viewer (such as /node_modules/three/...)
  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(VIEWER_DIR, safePath);
  if (!filePath.startsWith(VIEWER_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  // Never cache viewer source (so fixes take effect immediately); cache vendored libs only
  const isVendored = safePath.includes("node_modules");
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": isVendored ? "public, max-age=3600" : "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`3D Island GLB Viewer listening on http://0.0.0.0:${PORT}`);
});
