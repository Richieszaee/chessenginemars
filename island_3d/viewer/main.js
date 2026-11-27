import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Sky } from "three/addons/objects/Sky.js";

// ─── Global error surface (so any failure is visible on the loading screen) ──
function showFatal(msg) {
  const label = document.getElementById("load-label");
  if (label) {
    label.textContent = "❌ " + msg;
    label.style.color = "#ff8a80";
    label.style.maxWidth = "80vw";
    label.style.textAlign = "center";
  }
}
window.addEventListener("error", (e) => {
  const t = e.target;
  if (t && t !== window && (t.tagName === "SCRIPT" || t.tagName === "LINK")) {
    showFatal("Resource gagal dimuat: " + (t.src || t.href || t.tagName));
    return;
  }
  showFatal("JS error: " + (e.message || e.type));
}, true);
window.addEventListener("unhandledrejection", (e) => showFatal("Promise error: " + (e.reason?.message || e.reason)));

// ─── Renderer ────────────────────────────────────────────────────────────────
const app = document.getElementById("app");
function rendererSupported() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (_) { return false; }
}
if (!rendererSupported()) showFatal("WebGL tidak tersedia di browser ini");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

// ─── Scene / Camera / Controls ───────────────────────────────────────────────
const scene = new THREE.Scene();
// far must exceed the Sky box (scale 8000 → faces up to ~7000 away) or the sky gets clipped
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 20000);
camera.position.set(340, 240, 340);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.06;
orbit.maxPolarAngle = Math.PI * 0.52;
orbit.minDistance = 8;
orbit.maxDistance = 1400;
orbit.target.set(0, 20, 0);
orbit.update();

// ─── Lighting ────────────────────────────────────────────────────────────────
const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -320;
sun.shadow.camera.right = 320;
sun.shadow.camera.top = 320;
sun.shadow.camera.bottom = -320;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 1200;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3c5a32, 0.85);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0xffffff, 0.18);
scene.add(ambient);

// ─── Sky (PMREM environment) ─────────────────────────────────────────────────
const sky = new Sky();
sky.scale.setScalar(8000);
scene.add(sky);
const sunVec = new THREE.Vector3();
let skyTurbidity = 8, skyRayleigh = 1.6, skyMie = 0.006, hourOfDay = 10.5, skyIntensity = 1.0;
let sunIntSlider = 1.6;

function updateSun() {
  const phi = THREE.MathUtils.degToRad(90 - THREE.MathUtils.clamp(90 - (hourOfDay - 6) * 12.5, 2, 88));
  const theta = THREE.MathUtils.degToRad(155);
  sunVec.setFromSphericalCoords(1, phi, theta);
  sky.material.uniforms["sunPosition"].value.copy(sunVec);
  sun.position.copy(sunVec).multiplyScalar(700);
  sun.target.position.set(0, 0, 0);
  const dayness = THREE.MathUtils.clamp(Math.sin(((hourOfDay - 6) / 12) * Math.PI), 0, 1);
  sun.intensity = sunIntSlider * (0.25 + 0.75 * dayness);
  sun.color.setHSL(0.09 + 0.04 * dayness, 0.55 - 0.3 * dayness, 0.5 + 0.28 * dayness);
  hemi.intensity = 0.35 + 0.5 * dayness * skyIntensity;
}

const pmrem = new THREE.PMREMGenerator(renderer);
let envRT = null;
function updateEnvironment() {
  if (envRT) envRT.dispose();
  // far=20000 so the Sky box (scale 8000) is included in the environment map
  envRT = pmrem.fromScene(scene, 0, 0.1, 20000);
  scene.environment = envRT.texture;
}
updateSun();
sky.material.uniforms["turbidity"].value = skyTurbidity;
sky.material.uniforms["rayleigh"].value = skyRayleigh;
sky.material.uniforms["mieCoefficient"].value = skyMie;
sky.material.uniforms["mieDirectionalG"].value = 0.8;
updateEnvironment();

// ─── Camera viewpoints (matches render_verify.py) ────────────────────────────
const VIEWPOINTS = [
  // overview stays put: island grew 1.4x so it now fills more of the frame
  { id: "overview",  label: "1 · 🛩️ Aerial Overview",        pos: [330, 265, 335], tgt: [0, 15, 0],        fov: 50 },
  // the rest track features that moved with the 1.4x grow
  { id: "waterfall", label: "2 · 💧 Waterfall & Bridge",      pos: [14, 64.4, 134.4], tgt: [-16.8, 28, -8.4], fov: 56 },
  { id: "cave",      label: "3 · 🦇 Valley Cave Entrance",    pos: [21.7, 32.3, 17.5], tgt: [37.8, 20.3, -8.4], fov: 62 },
  { id: "cavern",    label: "4 · 💎 Inside Crystal Cavern",   pos: [80.5, 7.7, -28.7], tgt: [82.6, 9.8, -56],  fov: 68 },
  { id: "village",   label: "5 · 🛖 Village & Pier",          pos: [-104, 28, 64], tgt: [-157, 4, 22],       fov: 58 },
  { id: "temple",    label: "6 · 🏛️ Ancient Temple Ruins",    pos: [75.6, 58.8, 67.2], tgt: [102.2, 47.6, 53.2], fov: 58 },
  { id: "lighthouse",label: "7 · 🗼 Lighthouse & Sea Arch",   pos: [-72.8, 58.8, 235.2], tgt: [-19.6, 33.6, 170.8], fov: 56 },
  { id: "riverdelta",label: "8 · 🌊 River Delta & Beach",     pos: [98, 42, 245], tgt: [56, 5.6, 156.8],     fov: 58 },
  { id: "cenote",    label: "9 · 🕳️ Cenote Skylight",         pos: [133, 168, 28], tgt: [82.6, 42, -44.8],   fov: 55 },
];

// ─── Fly mode (WASD + mouse look) ────────────────────────────────────────────
let flyMode = false;
const flyKeys = new Set();
let yaw = 0, pitch = 0;
const flyBtn = document.getElementById("btn-fly");

function enterFly() {
  flyMode = true;
  orbit.enabled = false;
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
  yaw = e.y; pitch = e.x;
  try {
    const p = renderer.domElement.requestPointerLock?.();
    if (p && typeof p.catch === "function") p.catch(() => showToast("🖱️ Pointer lock ditolak — tekan F atau klik canvas dulu"));
  } catch (_) { /* pointer lock unavailable in this iframe */ }
  flyBtn.classList.add("active");
  showToast("🎮 Mode Terbang aktif — WASD/QE gerak, mouse lihat, Esc keluar");
}
function exitFly() {
  if (!flyMode) return;
  flyMode = false;
  orbit.target.copy(camera.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(40));
  orbit.enabled = true;
  try { document.exitPointerLock?.(); } catch (_) {}
  flyBtn.classList.remove("active");
}
flyBtn.addEventListener("click", () => (flyMode ? exitFly() : enterFly()));
document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement && flyMode) exitFly();
});
document.addEventListener("mousemove", (ev) => {
  if (!flyMode || document.pointerLockElement !== renderer.domElement) return;
  yaw -= ev.movementX * 0.0022;
  pitch -= ev.movementY * 0.0022;
  pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
});
window.addEventListener("keydown", (ev) => {
  flyKeys.add(ev.code);
  if (ev.code === "KeyF") (flyMode ? exitFly() : enterFly());
});
window.addEventListener("keyup", (ev) => flyKeys.delete(ev.code));

function updateFly(dt) {
  if (!flyMode) return;
  const speed = (flyKeys.has("ShiftLeft") ? 190 : 75) * dt; // island grew 1.4x — faster traverse
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  if (flyKeys.has("KeyW")) camera.position.addScaledVector(forward, speed);
  if (flyKeys.has("KeyS")) camera.position.addScaledVector(forward, -speed);
  if (flyKeys.has("KeyD")) camera.position.addScaledVector(right, speed);
  if (flyKeys.has("KeyA")) camera.position.addScaledVector(right, -speed);
  if (flyKeys.has("KeyE") || flyKeys.has("Space")) camera.position.y += speed;
  if (flyKeys.has("KeyQ") || flyKeys.has("ControlLeft")) camera.position.y -= speed;
}

// ─── Camera tour / tween ─────────────────────────────────────────────────────
let tween = null; // {t, dur, fromPos, toPos, fromTgt, toTgt, fromFov, toFov}
let autoTour = false;
let autoTourTimer = 0;
let currentViewId = "overview";

function flyToView(vp, duration = 1.6, keepTour = false) {
  exitFly();
  if (!keepTour) {
    autoTour = false;
    document.getElementById("btn-tour").classList.remove("active");
  }
  currentViewId = vp.id;
  setActiveCamButton(vp.id);
  tween = {
    t: 0, dur: duration,
    fromPos: camera.position.clone(),
    toPos: new THREE.Vector3(...vp.pos),
    fromTgt: orbit.target.clone(),
    toTgt: new THREE.Vector3(...vp.tgt),
    fromFov: camera.fov,
    toFov: vp.fov ?? 55,
  };
}

function updateTween(dt) {
  if (!tween) return;
  tween.t += dt;
  let k = Math.min(tween.t / tween.dur, 1);
  k = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
  camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
  orbit.target.lerpVectors(tween.fromTgt, tween.toTgt, k);
  camera.fov = THREE.MathUtils.lerp(tween.fromFov, tween.toFov, k);
  camera.updateProjectionMatrix();
  if (tween.t >= tween.dur) tween = null;
}

function setActiveCamButton(id) {
  document.querySelectorAll(".cam-btn").forEach((b) => b.classList.toggle("active", b.dataset.id === id));
}

// Build camera buttons
const camGrid = document.getElementById("cam-grid");
VIEWPOINTS.forEach((vp) => {
  const b = document.createElement("button");
  b.className = "cam-btn";
  b.dataset.id = vp.id;
  b.textContent = vp.label;
  b.addEventListener("click", () => flyToView(vp));
  camGrid.appendChild(b);
});
setActiveCamButton("overview");

document.getElementById("btn-tour").addEventListener("click", () => {
  autoTour = !autoTour;
  document.getElementById("btn-tour").classList.toggle("active", autoTour);
  if (autoTour) {
    showToast("▶️ Auto Tour aktif — berputar antar landmark");
    const idx = VIEWPOINTS.findIndex((v) => v.id === currentViewId);
    flyToView(VIEWPOINTS[(idx + 1) % VIEWPOINTS.length], 2.2, true);
    autoTourTimer = 0;
  }
});
document.getElementById("btn-reset").addEventListener("click", () => {
  autoTour = false;
  document.getElementById("btn-tour").classList.remove("active");
  flyToView(VIEWPOINTS[0], 1.4);
});

// ─── Lighting sliders ────────────────────────────────────────────────────────
const slExposure = document.getElementById("sl-exposure");
const slSun = document.getElementById("sl-sun");
const slSky = document.getElementById("sl-sky");
const slHour = document.getElementById("sl-hour");

slExposure.addEventListener("input", () => {
  renderer.toneMappingExposure = parseFloat(slExposure.value);
  document.getElementById("v-exposure").textContent = (+slExposure.value).toFixed(2);
});
slSun.addEventListener("input", () => {
  sunIntSlider = parseFloat(slSun.value);
  document.getElementById("v-sun").textContent = sunIntSlider.toFixed(2);
  updateSun();
});
slSky.addEventListener("input", () => {
  skyIntensity = parseFloat(slSky.value);
  document.getElementById("v-sky").textContent = skyIntensity.toFixed(2);
  sky.material.uniforms["rayleigh"].value = 0.6 + 2.2 * skyIntensity;
  hemi.intensity = 0.35 + 0.55 * skyIntensity;
  updateEnvironment();
});
slHour.addEventListener("input", () => {
  hourOfDay = parseFloat(slHour.value);
  const h = Math.floor(hourOfDay);
  const m = Math.round((hourOfDay - h) * 60);
  document.getElementById("v-hour").textContent = `${h}:${String(m).padStart(2, "0")}`;
  updateSun();
  updateEnvironment();
});

// ─── GLB load (fetch + parse with explicit errors, progress & retry) ─────────
const loadBar = document.getElementById("load-bar");
const loadLabel = document.getElementById("load-label");
const retryBtn = document.getElementById("btn-retry");
const loader = new GLTFLoader();
const layerNodes = []; // {name, obj, visible}
let modelLoaded = false;
let loadWatchdog = null;

const NODE_META = {
  Island_Terrain_Exterior:        { color: "#4caf50", label: "Terrain Exterior" },
  Island_Cave_And_Cliffs:         { color: "#8d6e63", label: "Cave & Cliffs" },
  Cave_Stalactites_And_Boulders:  { color: "#a1887f", label: "Stalactites & Boulders" },
  Cave_Glowing_Crystals:          { color: "#00e5ff", label: "Glowing Crystals" },
  Trees_Trunks_And_Branches:      { color: "#795548", label: "Tree Trunks" },
  Trees_Canopy_And_Palms:         { color: "#2e7d32", label: "Tree Canopy & Palms" },
  Trees_Leaf_Cards:               { color: "#66bb6a", label: "Leaf Cards (cutout daun)" },
  Village_Bridge_Pier_And_Boats_Wood: { color: "#ff8f00", label: "Bridge, Pier & Boats" },
  Village_Huts_Thatch_Roofs:      { color: "#f0c060", label: "Hut Thatch Roofs" },
  Ancient_Ruins_And_Lighthouse_Stone: { color: "#9e9e9e", label: "Ruins & Lighthouse" },
  Lanterns_Beacon_And_Campfires:  { color: "#ff5722", label: "Lanterns & Campfires" },
  River_Waterfall_And_Lagoon:     { color: "#29b6f6", label: "River, Waterfall & Lagoon" },
  Ocean_Surrounding_Sea:          { color: "#0277bd", label: "Ocean" },
};

function onModelReady(gltf) {
  modelLoaded = true;
  clearTimeout(loadWatchdog);
  retryBtn.style.display = "none";

  const model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) o.material.envMapIntensity = 0.55;
    }
  });
  scene.add(model);

  // Collect named layer nodes (single-primitive glTF nodes load as bare Meshes)
  model.traverse((o) => {
    const meta = NODE_META[o.name];
    if (meta && (o.isMesh || o.children.length > 0)) {
      layerNodes.push({ name: o.name, obj: o, visible: true, ...meta });
    }
  });

  // Layer toggles UI
  const layerList = document.getElementById("layer-list");
  layerList.innerHTML = "";
  layerNodes.forEach((ln) => {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML = `<span class="layer-dot" style="background:${ln.color}"></span>
      <input type="checkbox" id="layer-${ln.name}" checked>
      <label for="layer-${ln.name}">${ln.label}</label>`;
    row.querySelector("input").addEventListener("change", (e) => {
      ln.visible = e.target.checked;
      ln.obj.visible = ln.visible;
    });
    layerList.appendChild(row);
  });

  // Stats
  let verts = 0, tris = 0;
  model.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      verts += g.attributes.position?.count ?? 0;
      tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
    }
  });
  document.getElementById("stats-card").innerHTML =
    `<b>${verts.toLocaleString()}</b> verts · <b>${Math.round(tris).toLocaleString()}</b> tris · <b>13</b> material · <b>16</b> texture`;

  loadBar.style.width = "100%";
  loadLabel.textContent = "Selesai! ✅";
  loadLabel.style.color = "";
  setTimeout(() => document.getElementById("loading-screen").classList.add("hidden"), 450);
  updateEnvironment();
  showToast("🏝️ island.glb siap dieksplorasi!");
}

function showLoadError(msg) {
  clearTimeout(loadWatchdog);
  showFatal(msg);
  retryBtn.style.display = "inline-block";
}

async function loadIslandGLB() {
  if (modelLoaded) return;
  retryBtn.style.display = "none";
  loadLabel.style.color = "";
  loadBar.style.width = "0%";
  // 40s watchdog — surfaces proxy/network stalls instead of a silent stuck bar
  clearTimeout(loadWatchdog);
  loadWatchdog = setTimeout(() => {
    if (!modelLoaded) showLoadError("Timeout: island.glb tidak selesai dimuat dalam 40 detik — klik 🔄 Coba Lagi");
  }, 40000);

  try {
    loadLabel.textContent = "Mengunduh island.glb…";
    const res = await fetch("island.glb", { cache: "no-store" });
    if (!res.ok) throw new Error(`server menjawab HTTP ${res.status} ${res.statusText}`);

    const total = parseInt(res.headers.get("Content-Length") || "0", 10);
    let buffer;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total) {
          const pct = Math.round((loaded / total) * 100);
          loadBar.style.width = `${pct}%`;
          loadLabel.textContent = `Memuat island.glb… ${pct}% (${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`;
        } else {
          loadLabel.textContent = `Memuat island.glb… ${(loaded / 1048576).toFixed(1)} MB`;
        }
      }
      const all = new Uint8Array(loaded);
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.length; }
      buffer = all.buffer;
    } else {
      buffer = await res.arrayBuffer();
    }

    loadLabel.textContent = "Memproses model 3D…";
    loader.parse(buffer, "", onModelReady, (err) => {
      showLoadError("GLTF parse gagal: " + (err?.message || err));
    });
  } catch (e) {
    showLoadError("Gagal memuat island.glb — " + (e.message || e));
  }
}
retryBtn.addEventListener("click", loadIslandGLB);
loadIslandGLB();

// ─── Download (multi-strategy: Save-As picker → blob anchor → new tab → URL) ─
const dlHelp = document.getElementById("dl-help");
const dlUrlInput = document.getElementById("dl-url");
const dlOpen = document.getElementById("dl-open");
document.getElementById("dl-help-close").addEventListener("click", () => dlHelp.classList.remove("show"));
document.getElementById("dl-copy").addEventListener("click", async () => {
  dlUrlInput.select();
  try {
    await navigator.clipboard.writeText(dlUrlInput.value);
    showToast("📋 Link disalin!");
  } catch (_) {
    document.execCommand?.("copy");
    showToast("📋 Link disalin (atau tekan Ctrl+C)");
  }
});

function showDownloadHelp(url, status) {
  dlUrlInput.value = url;
  dlOpen.href = url;
  if (status) document.getElementById("dl-help-status").textContent = status;
  dlHelp.classList.add("show");
}

document.getElementById("btn-download").addEventListener("click", async (ev) => {
  ev.preventDefault();
  const url = new URL("download/island.glb", document.baseURI).href;

  // Strategy 1: File System Access "Save As" dialog (best UX when available)
  if (window.showSaveFilePicker) {
    try {
      showToast("⬇️ Membuka dialog Simpan Sebagai…");
      const handle = await window.showSaveFilePicker({
        suggestedName: "island.glb",
        types: [{ description: "glTF Binary", accept: { "model/gltf-binary": [".glb"] } }],
      });
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const w = await handle.createWritable();
      await w.write(await res.blob());
      await w.close();
      showToast("✅ island.glb tersimpan!");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled on purpose
    }
  }

  // Strategy 2: blob + temporary anchor with download attr
  try {
    showToast("⬇️ Menyiapkan unduhan island.glb (18 MB)…");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "island.glb";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    // Sandboxed iframes can silently swallow the click — always offer manual fallback too
    setTimeout(() => showDownloadHelp(url,
      "Unduhan seharusnya mulai sekarang — kalau tidak muncul dalam beberapa detik, pakai cara di bawah:"), 1500);
    showToast("✅ Unduhan diproses — cek toolbar browser");
    return;
  } catch (_) { /* fall through */ }

  // Strategy 3+: show copyable URL panel
  showDownloadHelp(url, "Unduhan otomatis diblokir oleh iframe preview — salin link di bawah, lalu buka di tab baru:");
  showToast("⚠️ Unduhan otomatis diblokir — salin link di panel bawah");
});



// ─── Toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
}

// ─── Resize ──────────────────────────────────────────────────────────────────
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Main loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  updateTween(dt);
  updateFly(dt);
  if (autoTour && !tween) {
    autoTourTimer += dt;
    if (autoTourTimer > 2.2) {
      autoTourTimer = 0;
      const idx = VIEWPOINTS.findIndex((v) => v.id === currentViewId);
      flyToView(VIEWPOINTS[(idx + 1) % VIEWPOINTS.length], 2.4, true);
    }
  }
  if (!flyMode) orbit.update();
  renderer.render(scene, camera);
});
