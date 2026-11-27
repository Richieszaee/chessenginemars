import math
import numpy as np
from island_3d.terrain_and_cave import (
    X_MIN,
    Z_MIN,
    WORLD_SIZE,
    sample_height,
    evaluate_cave_void_sdf,
    compute_vertex_normals,
)


class MeshBuilder:
    """Accumulates UV-mapped, vertex-colored 3D triangle primitives into a single batched mesh."""

    def __init__(self):
        self.v_list = []
        self.n_list = []
        self.uv_list = []
        self.c_list = []
        self.f_list = []
        self.v_count = 0

    def add_raw(
        self,
        verts: np.ndarray,
        faces: np.ndarray,
        uvs: np.ndarray,
        normals: np.ndarray | None = None,
        color: tuple[float, float, float, float] | np.ndarray = (1.0, 1.0, 1.0, 1.0),
    ):
        verts = np.asarray(verts, dtype=np.float32)
        faces = np.asarray(faces, dtype=np.uint32)
        uvs = np.asarray(uvs, dtype=np.float32)
        if normals is None:
            normals = compute_vertex_normals(verts, faces)
        else:
            normals = np.asarray(normals, dtype=np.float32)

        if isinstance(color, np.ndarray) and color.ndim == 2:
            cols = color.astype(np.float32)
        else:
            c_arr = np.asarray(color, dtype=np.float32)
            if c_arr.size == 3:
                c_arr = np.array([c_arr[0], c_arr[1], c_arr[2], 1.0], dtype=np.float32)
            cols = np.broadcast_to(c_arr[None, :], (len(verts), 4)).copy()

        self.v_list.append(verts)
        self.n_list.append(normals)
        self.uv_list.append(uvs)
        self.c_list.append(cols)
        self.f_list.append(faces + self.v_count)
        self.v_count += len(verts)

    def build(self) -> dict[str, np.ndarray]:
        if self.v_count == 0:
            return {
                "verts": np.zeros((0, 3), dtype=np.float32),
                "normals": np.zeros((0, 3), dtype=np.float32),
                "uvs": np.zeros((0, 2), dtype=np.float32),
                "colors": np.zeros((0, 4), dtype=np.float32),
                "faces": np.zeros((0, 3), dtype=np.uint32),
            }
        return {
            "verts": np.vstack(self.v_list),
            "normals": np.vstack(self.n_list),
            "uvs": np.vstack(self.uv_list),
            "colors": np.vstack(self.c_list),
            "faces": np.vstack(self.f_list),
        }


def _rot_y(yaw: float) -> np.ndarray:
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]], dtype=np.float32)


def _rot_x(pitch: float) -> np.ndarray:
    c, s = math.cos(pitch), math.sin(pitch)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]], dtype=np.float32)


def _rot_z(roll: float) -> np.ndarray:
    c, s = math.cos(roll), math.sin(roll)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]], dtype=np.float32)


def _align_y_to_dir(direction: np.ndarray) -> np.ndarray:
    """Return 3x3 rotation matrix mapping +Y [0,1,0] onto unit vector `direction`."""
    d = np.asarray(direction, dtype=np.float32)
    d = d / max(float(np.linalg.norm(d)), 1e-8)
    up = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    if abs(float(np.dot(d, up))) > 0.999:
        ref = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    else:
        ref = up
    x_axis = np.cross(ref, d)
    x_axis /= max(float(np.linalg.norm(x_axis)), 1e-8)
    z_axis = np.cross(d, x_axis)
    return np.column_stack([x_axis, d, z_axis]).astype(np.float32)


def add_box(
    mb: MeshBuilder,
    center: tuple[float, float, float] | np.ndarray,
    size: tuple[float, float, float],
    rot: np.ndarray | None = None,
    uv_scale: float = 2.0,
    color=(1.0, 1.0, 1.0, 1.0),
):
    """Add a 24-vertex sharp-edged UV-mapped 3D box (outward CCW faces)."""
    hx, hy, hz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
    # 6 faces: +Z, -Z, +X, -X, +Y, -Y (CCW when viewed from outside)
    quads = [
        # (v0, v1, v2, v3), normal, (u_len, v_len)
        ([(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)], (0, 0, 1), (size[0], size[1])),
        ([(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)], (0, 0, -1), (size[0], size[1])),
        ([(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)], (1, 0, 0), (size[2], size[1])),
        ([(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz)], (-1, 0, 0), (size[2], size[1])),
        ([(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)], (0, 1, 0), (size[0], size[2])),
        ([(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)], (0, -1, 0), (size[0], size[2])),
    ]
    verts, norms, uvs, faces = [], [], [], []
    for i, (q, nrm, (ul, vl)) in enumerate(quads):
        verts.extend(q)
        norms.extend([nrm] * 4)
        u_rep, v_rep = ul / uv_scale, vl / uv_scale
        uvs.extend([(0.0, v_rep), (u_rep, v_rep), (u_rep, 0.0), (0.0, 0.0)])
        b = i * 4
        faces.extend([(b, b + 1, b + 2), (b, b + 2, b + 3)])

    v_arr = np.array(verts, dtype=np.float32)
    n_arr = np.array(norms, dtype=np.float32)
    if rot is not None:
        v_arr = v_arr @ rot.T
        n_arr = n_arr @ rot.T
    v_arr += np.asarray(center, dtype=np.float32)
    mb.add_raw(v_arr, np.array(faces, dtype=np.uint32), np.array(uvs, dtype=np.float32), n_arr, color=color)


def add_tapered_tube(
    mb: MeshBuilder,
    spine: np.ndarray,
    radii: np.ndarray,
    sides: int = 8,
    cap_top: bool = True,
    cap_bottom: bool = False,
    u_repeats: float = 1.5,
    v_tile_m: float = 2.5,
    color=(1.0, 1.0, 1.0, 1.0),
):
    """Build a smooth UV-wrapped tube/cone/trunk along a 3D spine polyline (K, 3) with radii (K,)."""
    k = len(spine)
    angles = np.linspace(0.0, 2.0 * np.pi, sides + 1)  # +1 seam vertex for clean U=[0..u_repeats]
    cos_a = np.cos(angles)
    sin_a = np.sin(angles)

    # Compute Bishop / parallel-transport frames along spine
    tangents = np.zeros_like(spine)
    tangents[:-1] = spine[1:] - spine[:-1]
    tangents[-1] = tangents[-2]
    tangents /= np.maximum(np.linalg.norm(tangents, axis=1, keepdims=True), 1e-8)

    arc = np.zeros(k, dtype=np.float32)
    arc[1:] = np.cumsum(np.linalg.norm(spine[1:] - spine[:-1], axis=1))

    verts = []
    uvs = []
    # Initial normal perpendicular to tangent[0]
    ref = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    if abs(float(np.dot(tangents[0], ref))) > 0.9:
        ref = np.array([0.0, 0.0, 1.0], dtype=np.float32)
    n_vec = np.cross(tangents[0], ref)
    n_vec /= max(float(np.linalg.norm(n_vec)), 1e-8)

    for i in range(k):
        t_vec = tangents[i]
        # Re-orthogonalize n_vec against current t_vec
        n_vec = n_vec - np.dot(n_vec, t_vec) * t_vec
        nl = float(np.linalg.norm(n_vec))
        if nl < 1e-6:
            n_vec = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        else:
            n_vec /= nl
        b_vec = np.cross(t_vec, n_vec)
        r = radii[i]
        ring = spine[i][None, :] + r * (cos_a[:, None] * n_vec[None, :] + sin_a[:, None] * b_vec[None, :])
        verts.append(ring)
        u_ring = np.linspace(0.0, u_repeats, sides + 1)
        v_coord = np.full(sides + 1, arc[i] / max(v_tile_m, 0.01))
        uvs.append(np.stack([u_ring, v_coord], axis=1))

    verts_arr = np.vstack(verts).astype(np.float32)
    uvs_arr = np.vstack(uvs).astype(np.float32)

    faces = []
    stride = sides + 1
    for i in range(k - 1):
        for j in range(sides):
            a = i * stride + j
            b = a + 1
            c = (i + 1) * stride + j + 1
            d = (i + 1) * stride + j
            # Check outward winding: (n_vec cos + b_vec sin), with b_vec = t x n -> cross((b-a), (d-a)) points OUTWARD if (a, d, c), (a, c, b) or (a, b, c)?
            # Wait: let theta increase: pos(theta) = cos*n + sin*(t x n).
            # d(pos)/d(theta) = -sin*n + cos*b. d(pos)/ds = t.
            # d(pos)/d(theta) x d(pos)/ds = (-sin*n + cos*b) x t = -sin*(n x t) + cos*(b x t) = +sin*b + cos*n = OUTWARD NORMAL!
            # Therefore (a -> b [d_theta] -> c [d_s]) has cross(b-a, c-a) = OUTWARD!
            faces.append((a, b, c))
            faces.append((a, c, d))

    if cap_top and radii[-1] > 1e-3:
        top_idx = len(verts_arr)
        verts_arr = np.vstack([verts_arr, spine[-1][None, :]])
        uvs_arr = np.vstack([uvs_arr, [[0.5, 0.5]]])
        base = (k - 1) * stride
        for j in range(sides):
            faces.append((base + j, base + j + 1, top_idx))

    if cap_bottom and radii[0] > 1e-3:
        bot_idx = len(verts_arr)
        verts_arr = np.vstack([verts_arr, spine[0][None, :]])
        uvs_arr = np.vstack([uvs_arr, [[0.5, 0.5]]])
        for j in range(sides):
            faces.append((j + 1, j, bot_idx))

    mb.add_raw(verts_arr, np.array(faces, dtype=np.uint32), uvs_arr, color=color)


def add_sculpted_spheroid(
    mb: MeshBuilder,
    center: np.ndarray,
    rx: float,
    ry: float,
    rz: float,
    n_lat: int = 8,
    n_lon: int = 12,
    bump_amp: float = 0.18,
    seed: int = 0,
    uv_scale: float = 2.0,
    top_color=(1.08, 1.10, 0.96, 1.0),
    bot_color=(0.64, 0.72, 0.62, 1.0),
    rot: np.ndarray | None = None,
):
    """Organic UV-wrapped displaced spheroid for lush tree crowns, bushes & sculpted boulders!"""
    rng = np.random.default_rng(seed)
    p1, p2, p3 = rng.uniform(0, 6.28, 3)

    thetas = np.linspace(0.02, np.pi - 0.02, n_lat)
    phis = np.linspace(0.0, 2.0 * np.pi, n_lon + 1)

    verts, uvs, cols = [], [], []
    tc = np.asarray(top_color, dtype=np.float32)
    bc = np.asarray(bot_color, dtype=np.float32)

    for i, th in enumerate(thetas):
        sin_t, cos_t = math.sin(th), math.cos(th)
        v_frac = i / max(n_lat - 1, 1)
        # Top of sphere is th ~ 0 (cos_t ~ +1), bottom is th ~ pi (cos_t ~ -1)
        shade_t = 0.5 + 0.5 * cos_t
        c_row = bc * (1.0 - shade_t) + tc * shade_t
        for j, ph in enumerate(phis):
            nx = sin_t * math.cos(ph)
            ny = cos_t
            nz = sin_t * math.sin(ph)
            disp = 1.0 + bump_amp * (
                math.sin(3.0 * nx + p1) * math.cos(3.0 * nz + p2)
                + 0.5 * math.cos(5.0 * ny + 4.0 * nx + p3)
            )
            verts.append((nx * rx * disp, ny * ry * disp, nz * rz * disp))
            uvs.append(((j / n_lon) * uv_scale, v_frac * uv_scale))
            cols.append(c_row)

    # Add north & south poles
    north_idx = len(verts)
    verts.append((0.0, ry * (1.0 + 0.3 * bump_amp), 0.0))
    uvs.append((0.5 * uv_scale, 0.0))
    cols.append(tc)

    south_idx = len(verts)
    verts.append((0.0, -ry * (1.0 - 0.2 * bump_amp), 0.0))
    uvs.append((0.5 * uv_scale, uv_scale))
    cols.append(bc)

    stride = n_lon + 1
    faces = []
    # North cap: viewing from outside (+Y), phi goes CCW from +X toward -Z?
    # Wait: nx = cos(phi), nz = sin(phi). From +Y looking down, +X is right, +Z is down -> increasing phi goes CLOCKWISE!
    # Let's check normal of (north, row0[j+1], row0[j]):
    # At j=0 (nx=1, nz=0) and j=1 (nx=cos, nz=sin>0):
    # v1 - north = (cos, dy, sin), v2 - north = (1, dy, 0).
    # cross(v1-north, v2-north)_y = sin * 1 - cos * 0 = +sin > 0! YES! So (north, j+1, j) is OUTWARD CCW!
    for j in range(n_lon):
        faces.append((north_idx, j + 1, j))

    for i in range(n_lat - 1):
        for j in range(n_lon):
            a = i * stride + j
            b = a + 1
            c = (i + 1) * stride + j + 1
            d = (i + 1) * stride + j
            # Check outward normal: d(pos)/d(theta) points -Y, d(pos)/d(phi) points +Z at phi=0.
            # (-Y) x (+Z) = -X (inward), whereas (+Z) x (-Y) = +X (OUTWARD)!
            # So (a -> b [+phi] -> d [+theta])? (b-a) x (d-a) = (+Z) x (-Y) = +X OUTWARD!
            # Wait: let's verify: (a, c, b) -> (c-a) is (+phi - Y), (b-a) is (+phi):
            # cross(c-a, b-a) = (-Y) x (+Z) = -X! Whereas cross(b-a, c-a) = (+Z) x (-Y) = +X OUTWARD!
            # Wait: wait! Let's check exact coordinates at th=pi/2, phi=0:
            # a = (1, 0, 0), b = (cos d, 0, sin d) ~ (1, 0, +d), d = (cos d, -d, 0) ~ (1, -d, 0).
            # (b - a) = (0, 0, +d). (d - a) = (0, -d, 0).
            # cross(b - a, d - a) = (0*0 - (+d)*(-d), (+d)*0 - 0*0, 0*(-d) - 0*0) = (+d^2, 0, 0) = +X OUTWARD!!
            # YES!! Always checking cross product explicitly makes it 100% bug-free!
            faces.append((a, b, c))
            faces.append((a, c, d))

    last_row = (n_lat - 1) * stride
    for j in range(n_lon):
        faces.append((south_idx, last_row + j, last_row + j + 1))

    v_arr = np.array(verts, dtype=np.float32)
    if rot is not None:
        v_arr = v_arr @ rot.T
    v_arr += np.asarray(center, dtype=np.float32)
    mb.add_raw(
        v_arr,
        np.array(faces, dtype=np.uint32),
        np.array(uvs, dtype=np.float32),
        color=np.array(cols, dtype=np.float32),
    )


# ---------------------------------------------------------------------------
# 1. WATER MESHES: River, Waterfall, Plunge Lagoon, Cave Lagoon & Ocean
# ---------------------------------------------------------------------------

def _add_ribbon_water(mb: MeshBuilder, curve: np.ndarray, width_extra: float = 2.2, v_tile_m: float = 12.0):
    """Build smooth flat water ribbon mesh along river curve (M, 4): [x, wy, z, half_w]."""
    m = len(curve)
    pos = curve[:, :3]
    wy = curve[:, 1]
    hw = curve[:, 3] + width_extra

    tang = np.zeros((m, 2), dtype=np.float32)
    tang[:-1, 0] = curve[1:, 0] - curve[:-1, 0]
    tang[:-1, 1] = curve[1:, 2] - curve[:-1, 2]
    tang[-1] = tang[-2]
    tang /= np.maximum(np.linalg.norm(tang, axis=1, keepdims=True), 1e-8)
    # Left normal in XZ so cross(right - left, forward) points +Y UP!
    # Wait: forward = (tx, 0, tz). Let right_vec = (-tz, 0, tx):
    # cross(right_vec, forward) = (0, tz*(-tz) - tx*tx, 0) = (0, -1, 0) (-Y)!
    # Let right_vec = (tz, 0, -tx): cross((tz, 0, -tx), (tx, 0, tz))_y = (-tx)*tx - tz*tz = -1!
    # Wait: cross_y(A, B) = Az * Bx - Ax * Bz!
    # For forward B = (tx, 0, tz), we want Az * tx - Ax * tz = +1 -> Ax = -tz, Az = +tx!
    # Check at forward = (0, 0, 1) (flowing South +Z): A = (-1, 0, 0).
    # From left (-A = +1, 0, 0) to right (+A = -1, 0, 0): delta_A = (-2, 0, 0).
    # cross_y((-2, 0, 0), (0, 0, 1)) = 0*0 - (-2)*1 = +2 (+Y UP)!! YES!
    side_x = -tang[:, 1]
    side_z = tang[:, 0]

    arc = np.zeros(m, dtype=np.float32)
    arc[1:] = np.cumsum(np.sqrt(np.diff(curve[:, 0]) ** 2 + np.diff(curve[:, 2]) ** 2))

    n_cols = 5
    s_vals = np.linspace(-1.0, 1.0, n_cols, dtype=np.float32)
    verts, uvs, cols = [], [], []
    for i in range(m):
        for j, sv in enumerate(s_vals):
            px = pos[i, 0] + sv * hw[i] * side_x[i]
            pz = pos[i, 2] + sv * hw[i] * side_z[i]
            verts.append((px, wy[i], pz))
            uvs.append(((sv * hw[i]) / v_tile_m + 0.5, arc[i] / v_tile_m))
            # Subtle bright foam hint near banks
            foam = 1.0 + 0.14 * (abs(sv) ** 2.0)
            cols.append((foam, foam, min(foam * 1.04, 1.2), 0.90))

    faces = []
    for i in range(m - 1):
        for j in range(n_cols - 1):
            a = i * n_cols + j
            b = a + 1
            c = (i + 1) * n_cols + j + 1
            d = (i + 1) * n_cols + j
            faces.append((a, b, c))
            faces.append((a, c, d))

    v_arr = np.array(verts, dtype=np.float32)
    f_arr = np.array(faces, dtype=np.uint32)
    # Guarantee +Y normal
    fn = np.cross(v_arr[f_arr[:, 1]] - v_arr[f_arr[:, 0]], v_arr[f_arr[:, 2]] - v_arr[f_arr[:, 0]])
    if np.sum(fn[:, 1]) < 0:
        f_arr = f_arr[:, [0, 2, 1]]

    norms = np.broadcast_to(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), v_arr.shape).copy()
    mb.add_raw(v_arr, f_arr, np.array(uvs, dtype=np.float32), norms, color=np.array(cols, dtype=np.float32))


def build_water_meshes(hf: dict) -> tuple[dict, dict]:
    """Return (river_and_waterfall_mesh, surrounding_ocean_mesh)."""
    river_mb = MeshBuilder()
    rdef = hf["river_def"]

    # 1. Upper stream + Spring Pond
    _add_ribbon_water(river_mb, rdef["upper"], width_extra=1.8, v_tile_m=10.0)
    # 2. Lower river + Plunge Lagoon + Delta
    _add_ribbon_water(river_mb, rdef["lower"], width_extra=2.4, v_tile_m=13.0)

    # 3. Extra circular pond patch at Mountain Spring (-38, 42.5, -56) & Plunge Lagoon (-20, 13.8, -9)
    for cx, cy, cz, rad in [(-38.0, 42.52, -56.0, 9.8), (-20.0, 13.82, -9.0, 15.2)]:
        rings, segs = 4, 24
        verts = [(cx, cy, cz)]
        uvs = [(0.5, 0.5)]
        cols = [(0.92, 1.02, 1.06, 0.92)]
        for ir in range(1, rings + 1):
            rr = rad * (ir / rings)
            for j in range(segs):
                ang = 2.0 * math.pi * j / segs
                px, pz = cx + rr * math.cos(ang), cz + rr * math.sin(ang)
                verts.append((px, cy, pz))
                uvs.append((0.5 + (px - cx) / 14.0, 0.5 + (pz - cz) / 14.0))
                cols.append((1.0, 1.05, 1.08, 0.90))
        faces = []
        for j in range(segs):
            jn = (j + 1) % segs
            faces.append((0, 1 + jn, 1 + j))
        for ir in range(rings - 1):
            b0 = 1 + ir * segs
            b1 = 1 + (ir + 1) * segs
            for j in range(segs):
                jn = (j + 1) % segs
                faces.append((b0 + j, b0 + jn, b1 + jn))
                faces.append((b0 + j, b1 + jn, b1 + j))
        v_arr = np.array(verts, dtype=np.float32)
        f_arr = np.array(faces, dtype=np.uint32)
        if np.sum(np.cross(v_arr[f_arr[:, 1]] - v_arr[f_arr[:, 0]], v_arr[f_arr[:, 2]] - v_arr[f_arr[:, 0]])[:, 1]) < 0:
            f_arr = f_arr[:, [0, 2, 1]]
        norms = np.broadcast_to(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), v_arr.shape).copy()
        river_mb.add_raw(v_arr, f_arr, np.array(uvs, dtype=np.float32), norms, color=np.array(cols, dtype=np.float32))

    # 4. Grand 24.5-meter Curved Waterfall Curtain from (-24.0, 38.2, -24.5) down to (-20.8, 13.5, -13.5)!
    wf_rows, wf_cols = 18, 12
    wf_verts, wf_uvs, wf_cols_arr = [], [], []
    for i in range(wf_rows):
        t = i / (wf_rows - 1)
        # Parabolic free-fall trajectory over the rock cliff!
        wy = 38.25 * (1.0 - t * t) + 13.4 * (t * t)
        wz = -24.6 + 11.2 * (t ** 0.72)
        wx_center = -24.0 + 3.2 * t
        half_w = 4.6 + 2.4 * t
        for j in range(wf_cols):
            s = -1.0 + 2.0 * (j / (wf_cols - 1))
            # Slight forward bow in center of waterfall curtain
            bow_z = 1.3 * (1.0 - s * s) * math.sin(math.pi * t)
            rip_y = 0.25 * math.sin(6.0 * s + 9.0 * t)
            wf_verts.append((wx_center + s * half_w, wy + rip_y, wz + bow_z))
            wf_uvs.append(((j / (wf_cols - 1)) * 1.4, t * 3.8))
            # Bright white-aqua foaming crest at top (t~0) and splash base (t~1)!
            foam = 1.08 + 0.35 * (math.exp(-((t / 0.18) ** 2)) + math.exp(-(((1.0 - t) / 0.22) ** 2)))
            wf_cols_arr.append((min(foam, 1.45), min(foam * 1.04, 1.48), min(foam * 1.08, 1.5), 0.94))

    wf_faces = []
    for i in range(wf_rows - 1):
        for j in range(wf_cols - 1):
            a = i * wf_cols + j
            b = a + 1
            c = (i + 1) * wf_cols + j + 1
            d = (i + 1) * wf_cols + j
            wf_faces.append((a, d, c))
            wf_faces.append((a, c, b))
    wf_v = np.array(wf_verts, dtype=np.float32)
    wf_f = np.array(wf_faces, dtype=np.uint32)
    # Waterfall faces South (+Z)
    if np.sum(np.cross(wf_v[wf_f[:, 1]] - wf_v[wf_f[:, 0]], wf_v[wf_f[:, 2]] - wf_v[wf_f[:, 0]])[:, 2]) < 0:
        wf_f = wf_f[:, [0, 2, 1]]
    river_mb.add_raw(wf_v, wf_f, np.array(wf_uvs, dtype=np.float32), color=np.array(wf_cols_arr, dtype=np.float32))

    # Foamy mist rings at waterfall plunge base (-20.8, 14.0, -13.2)
    for mx, mz, rx, ry, rz in [(-20.8, -13.2, 5.8, 1.4, 3.8), (-18.0, -12.5, 3.5, 1.0, 2.8), (-23.5, -12.8, 3.4, 1.0, 2.6)]:
        add_sculpted_spheroid(
            river_mb,
            np.array([mx, 13.9, mz], dtype=np.float32),
            rx, ry, rz,
            n_lat=6, n_lon=10, bump_amp=0.15, seed=77,
            uv_scale=1.2,
            top_color=(1.35, 1.42, 1.45, 0.85),
            bot_color=(0.95, 1.15, 1.22, 0.85),
        )

    # 5. Underground Crystal Cavern Lagoon & Sea-Cave Water Channel (Y = +0.08m)!
    cave_water_curve = np.array([
        [+42.0, 0.08, -31.0, 18.0],
        [+58.0, 0.08, -32.0, 21.0],
        [+82.0, 0.06, -33.0, 11.0],
        [+108.0, 0.04, -34.0, 10.5],
        [+134.0, 0.02, -34.5, 13.0],
    ], dtype=np.float32)
    _add_ribbon_water(river_mb, cave_water_curve, width_extra=1.0, v_tile_m=11.0)

    # 6. Surrounding Giant Tropical Ocean & Coral Reef Lagoon Disk (Radius = 245m at Y = 0.0m)!
    ocean_mb = MeshBuilder()
    o_rings, o_segs = 28, 72
    max_r = 245.0
    o_verts = [(0.0, 0.0, 0.0)]
    o_uvs = [(0.0, 0.0)]
    o_cols = [(0.85, 1.02, 1.05, 0.88)]
    for ir in range(1, o_rings + 1):
        rr = max_r * ((ir / o_rings) ** 1.15)
        for j in range(o_segs):
            ang = 2.0 * math.pi * j / o_segs
            px, pz = rr * math.cos(ang), rr * math.sin(ang)
            o_verts.append((px, 0.0, pz))
            o_uvs.append((px / 18.0, pz / 18.0))
            # Deeper sapphire-turquoise tint farther out to sea, bright aqua over shallow coral lagoon!
            deep_t = min(max((rr - 125.0) / 110.0, 0.0), 1.0)
            rc = 0.92 * (1.0 - deep_t) + 0.36 * deep_t
            gc = 1.04 * (1.0 - deep_t) + 0.72 * deep_t
            bc = 1.06 * (1.0 - deep_t) + 0.96 * deep_t
            o_cols.append((rc, gc, bc, 0.88))

    o_faces = []
    for j in range(o_segs):
        jn = (j + 1) % o_segs
        o_faces.append((0, 1 + jn, 1 + j))
    for ir in range(o_rings - 1):
        b0 = 1 + ir * o_segs
        b1 = 1 + (ir + 1) * o_segs
        for j in range(o_segs):
            jn = (j + 1) % o_segs
            o_faces.append((b0 + j, b0 + jn, b1 + jn))
            o_faces.append((b0 + j, b1 + jn, b1 + j))

    ov = np.array(o_verts, dtype=np.float32)
    of = np.array(o_faces, dtype=np.uint32)
    if np.sum(np.cross(ov[of[:, 1]] - ov[of[:, 0]], ov[of[:, 2]] - ov[of[:, 0]])[:, 1]) < 0:
        of = of[:, [0, 2, 1]]
    on = np.broadcast_to(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), ov.shape).copy()
    ocean_mb.add_raw(ov, of, np.array(o_uvs, dtype=np.float32), on, color=np.array(o_cols, dtype=np.float32))

    return river_mb.build(), ocean_mb.build()


# ---------------------------------------------------------------------------
# 2. TREES & JUNGLE FLORA ("ada pohon"): Palms, Rainforest Trees, Pines, Bushes
# ---------------------------------------------------------------------------

def add_coconut_palm(trunk_mb: MeshBuilder, canopy_mb: MeshBuilder, base_pos: np.ndarray, scale: float, yaw: float, seed: int):
    """Curved tropical coconut palm with ringed trunk, coconuts & 9 arching 3D frond blades."""
    rng = np.random.default_rng(seed)
    height = (10.5 + rng.uniform(-1.5, 3.2)) * scale
    lean = (2.4 + rng.uniform(0.0, 2.2)) * scale
    dx_lean = math.cos(yaw) * lean
    dz_lean = math.sin(yaw) * lean

    t = np.linspace(0.0, 1.0, 8, dtype=np.float32)
    spine = np.stack([
        base_pos[0] + dx_lean * (t ** 1.65),
        base_pos[1] - 0.5 + height * t,
        base_pos[2] + dz_lean * (t ** 1.65),
    ], axis=1)
    radii = (0.48 * (1.0 - 0.55 * t) + 0.03 * np.sin(t * 22.0)) * scale
    add_tapered_tube(trunk_mb, spine, radii, sides=7, cap_top=True, u_repeats=1.2, v_tile_m=2.2, color=(1.02, 0.96, 0.88, 1.0))

    crown = spine[-1]
    # 3 coconuts under crown
    for k in range(3):
        ca = yaw + k * 2.1
        cpos = crown + np.array([math.cos(ca) * 0.32 * scale, -0.25 * scale, math.sin(ca) * 0.32 * scale], dtype=np.float32)
        add_sculpted_spheroid(trunk_mb, cpos, 0.24 * scale, 0.26 * scale, 0.24 * scale, n_lat=4, n_lon=6, bump_amp=0.05, seed=seed + k, top_color=(0.72, 0.55, 0.34, 1.0), bot_color=(0.48, 0.35, 0.20, 1.0))

    # 9 arching 3D folded palm fronds
    n_fronds = 9
    for k in range(n_fronds):
        ang = yaw + (2.0 * math.pi * k / n_fronds) + rng.uniform(-0.14, 0.14)
        droop = 0.24 + 0.30 * (k % 2)
        frond_len = (5.0 + rng.uniform(-0.4, 0.8)) * scale
        frond_w = 1.22 * scale
        dir_xz = np.array([math.cos(ang), 0.0, math.sin(ang)], dtype=np.float32)
        side_xz = np.array([-math.sin(ang), 0.0, math.cos(ang)], dtype=np.float32)

        segs = 6
        f_verts, f_uvs, f_cols = [], [], []
        for i in range(segs):
            s = i / (segs - 1)
            r_out = frond_len * s
            y_arc = frond_len * (0.34 * math.sin(math.pi * s * 0.78) - droop * (s ** 1.9))
            w_s = frond_w * math.sin(math.pi * (s ** 0.68)) * (1.0 - 0.15 * s)
            center_pt = crown + r_out * dir_xz + np.array([0.0, y_arc, 0.0], dtype=np.float32)
            # 3-point V-fold cross section (left edge, raised midrib, right edge) so frond has crisp 3D volume!
            f_verts.append(center_pt - w_s * side_xz - np.array([0.0, 0.18 * w_s, 0.0], dtype=np.float32))
            f_verts.append(center_pt + np.array([0.0, 0.12 * w_s, 0.0], dtype=np.float32))
            f_verts.append(center_pt + w_s * side_xz - np.array([0.0, 0.18 * w_s, 0.0], dtype=np.float32))
            f_uvs.extend([(0.0, s), (0.5, s), (1.0, s)])
            sun = 0.92 + 0.22 * (1.0 - 0.4 * s)
            f_cols.extend([(sun * 0.95, sun * 1.06, sun * 0.85, 1.0)] * 3)

        f_faces = []
        for i in range(segs - 1):
            b0 = i * 3
            b1 = (i + 1) * 3
            f_faces.extend([
                (b0, b0 + 1, b1 + 1), (b0, b1 + 1, b1),
                (b0 + 1, b0 + 2, b1 + 2), (b0 + 1, b1 + 2, b1 + 1),
            ])
        fv = np.array(f_verts, dtype=np.float32)
        ff = np.array(f_faces, dtype=np.uint32)
        if np.sum(np.cross(fv[ff[:, 1]] - fv[ff[:, 0]], fv[ff[:, 2]] - fv[ff[:, 0]])[:, 1]) < 0:
            ff = ff[:, [0, 2, 1]]
        canopy_mb.add_raw(fv, ff, np.array(f_uvs, dtype=np.float32), color=np.array(f_cols, dtype=np.float32))


def add_rainforest_tree(trunk_mb: MeshBuilder, canopy_mb: MeshBuilder, leaf_mb: MeshBuilder, base_pos: np.ndarray, scale: float, seed: int):
    """Lush tropical rainforest / banyan canopy tree with branching limbs, multi-lobe crown & cutout leaf cards."""
    rng = np.random.default_rng(seed)
    h_main = (9.5 + rng.uniform(-1.5, 3.5)) * scale
    lean_x = rng.uniform(-1.1, 1.1) * scale
    lean_z = rng.uniform(-1.1, 1.1) * scale

    t = np.linspace(0.0, 1.0, 6, dtype=np.float32)
    spine = np.stack([
        base_pos[0] + lean_x * t,
        base_pos[1] - 0.7 + h_main * t,
        base_pos[2] + lean_z * t,
    ], axis=1)
    # Flared tropical buttress base tapering upward
    radii = (0.85 * ((1.0 - t) ** 1.4) + 0.28) * scale
    add_tapered_tube(trunk_mb, spine, radii, sides=7, cap_top=True, u_repeats=1.6, v_tile_m=2.5)

    top = spine[-1]
    # Central main canopy dome
    tint = rng.uniform(0.88, 1.12)
    add_sculpted_spheroid(
        canopy_mb,
        top + np.array([0.0, 1.8 * scale, 0.0], dtype=np.float32),
        rx=4.4 * scale, ry=3.1 * scale, rz=4.4 * scale,
        n_lat=7, n_lon=10, bump_amp=0.18, seed=seed + 1, uv_scale=2.2,
        top_color=(1.02 * tint, 1.14 * tint, 0.88 * tint, 1.0),
        bot_color=(0.52 * tint, 0.68 * tint, 0.50 * tint, 1.0),
    )

    # 3 spreading branches + secondary canopy lobes
    b0_ang = rng.uniform(0.0, 6.28)
    for k in range(3):
        ang = b0_ang + k * 2.09 + rng.uniform(-0.25, 0.25)
        b_start = spine[3]
        b_end = top + np.array([math.cos(ang) * 3.1 * scale, rng.uniform(0.2, 1.3) * scale, math.sin(ang) * 3.1 * scale], dtype=np.float32)
        b_spine = np.stack([
            np.linspace(b_start[0], b_end[0], 4),
            np.linspace(b_start[1], b_end[1], 4),
            np.linspace(b_start[2], b_end[2], 4),
        ], axis=1).astype(np.float32)
        add_tapered_tube(trunk_mb, b_spine, np.array([0.36, 0.28, 0.22, 0.15], dtype=np.float32) * scale, sides=5, cap_top=True)
        add_sculpted_spheroid(
            canopy_mb,
            b_end + np.array([0.0, 0.7 * scale, 0.0], dtype=np.float32),
            rx=3.0 * scale, ry=2.2 * scale, rz=3.0 * scale,
            n_lat=6, n_lon=9, bump_amp=0.20, seed=seed + 10 + k, uv_scale=1.8,
            top_color=(0.98 * tint, 1.12 * tint, 0.86 * tint, 1.0),
            bot_color=(0.48 * tint, 0.64 * tint, 0.48 * tint, 1.0),
        )
        # Cutout leaf-card clusters hanging off this lobe
        lobe_c = b_end + np.array([0.0, 0.7 * scale, 0.0], dtype=np.float32)
        for j in range(5):
            th = rng.uniform(0.0, 6.28)
            ph = rng.uniform(-0.35, 1.15)
            out = np.array([math.cos(th) * math.cos(ph), math.sin(ph), math.sin(th) * math.cos(ph)], dtype=np.float32)
            pos = lobe_c + out * np.array([2.7 * scale, 2.0 * scale, 2.7 * scale], dtype=np.float32)
            _add_leaf_card_pair(leaf_mb, pos, out, size=1.9 * scale, seed=seed + 40 + k * 7 + j)

    # Leaf-card fringe around the main dome (the visible "real leaves" layer)
    main_c = top + np.array([0.0, 1.8 * scale, 0.0], dtype=np.float32)
    for j in range(14):
        th = rng.uniform(0.0, 6.28)
        ph = rng.uniform(-0.45, 1.30)
        out = np.array([math.cos(th) * math.cos(ph), math.sin(ph), math.sin(th) * math.cos(ph)], dtype=np.float32)
        pos = main_c + out * np.array([4.2 * scale, 3.0 * scale, 4.2 * scale], dtype=np.float32)
        _add_leaf_card_pair(leaf_mb, pos, out, size=2.3 * scale, seed=seed + 80 + j)


def _add_leaf_card_pair(mb: MeshBuilder, pos: np.ndarray, outward: np.ndarray, size: float, seed: int, base_bright: float = 1.0):
    """Two crossed alpha-cutout leaf cards floating just outside a canopy blob (tangent + vertical plane)."""
    rng = np.random.default_rng(seed)
    n = np.asarray(outward, dtype=np.float32)
    n /= max(float(np.linalg.norm(n)), 1e-6)
    ref = np.array([0.0, 1.0, 0.0], dtype=np.float32) if abs(float(n[1])) < 0.9 else np.array([1.0, 0.0, 0.0], dtype=np.float32)
    t1 = np.cross(ref, n)
    t1 /= max(float(np.linalg.norm(t1)), 1e-6)
    t2 = np.cross(n, t1)
    roll = float(rng.uniform(0.0, math.pi))
    r1 = t1 * math.cos(roll) + t2 * math.sin(roll)
    r2 = -t1 * math.sin(roll) + t2 * math.cos(roll)

    s = size * float(rng.uniform(0.75, 1.3))
    # Sunlit top leaves / shaded downward leaves, with per-card jitter
    bright = base_bright * (0.72 + 0.38 * (0.5 + 0.5 * float(n[1]))) * float(rng.uniform(0.88, 1.14))
    col = np.array([[bright, bright * 1.04, bright * 0.94, 1.0]] * 4, dtype=np.float32)

    # Random UV flips so cards don't all show the identical leaf layout
    fu = 1.0 if rng.random() < 0.5 else -1.0
    fv = 1.0 if rng.random() < 0.5 else -1.0
    u0, v0 = (0.0, 0.0) if fu > 0 else (1.0, 0.0)
    v0 = 0.0 if fv > 0 else 1.0
    uvs = np.array([[u0, v0], [u0 + fu, v0], [u0 + fu, v0 + fv], [u0, v0 + fv]], dtype=np.float32)

    # Quad A: tangent plane (normal = outward n)
    c = np.asarray(pos, dtype=np.float32)
    a_verts = np.stack([c - s * r1 - s * r2, c + s * r1 - s * r2, c + s * r1 + s * r2, c - s * r1 + s * r2])
    a_faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
    mb.add_raw(a_verts, a_faces, uvs.copy(), color=col.copy())

    # Quad B: vertical plane through outward axis (breaks the silhouette from the side)
    b_verts = np.stack([c - s * r1 - s * n * 0.7, c + s * r1 - s * n * 0.7, c + s * r1 + s * n * 1.1, c - s * r1 + s * n * 1.1])
    b_faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
    mb.add_raw(b_verts, b_faces, uvs.copy(), color=col.copy())


def add_highland_pine(trunk_mb: MeshBuilder, canopy_mb: MeshBuilder, base_pos: np.ndarray, scale: float, seed: int):
    """Tall highland conifer/casuarina tree for upper mountain ridges."""
    rng = np.random.default_rng(seed)
    h_tot = (12.0 + rng.uniform(-1.5, 3.0)) * scale
    spine = np.array([
        [base_pos[0], base_pos[1] - 0.6, base_pos[2]],
        [base_pos[0], base_pos[1] + h_tot * 0.5, base_pos[2]],
        [base_pos[0], base_pos[1] + h_tot * 0.92, base_pos[2]],
    ], dtype=np.float32)
    add_tapered_tube(trunk_mb, spine, np.array([0.52, 0.32, 0.10], dtype=np.float32) * scale, sides=6, cap_top=True)

    # 4 tiered conical foliage skirts
    for tier in range(4):
        frac = tier / 3.0
        y_lo = base_pos[1] + h_tot * (0.26 + 0.52 * frac)
        y_hi = y_lo + h_tot * (0.34 - 0.05 * frac)
        r_lo = (3.4 - 1.85 * frac) * scale
        c_spine = np.array([
            [base_pos[0], y_lo, base_pos[2]],
            [base_pos[0], 0.5 * (y_lo + y_hi), base_pos[2]],
            [base_pos[0], y_hi, base_pos[2]],
        ], dtype=np.float32)
        add_tapered_tube(
            canopy_mb, c_spine,
            np.array([r_lo, r_lo * 0.56, 0.08 * scale], dtype=np.float32),
            sides=9, cap_top=True, cap_bottom=True, u_repeats=2.0, v_tile_m=2.5,
            color=(0.82, 0.96, 0.80, 1.0),
        )


def populate_flora(hf: dict) -> tuple[dict, dict, dict]:
    """Scatter ~350 realistic 3D trees & bushes across beaches, valleys, riverbanks & mountains.

    Returns (trunk, canopy, leaf_cards): leaf_cards are alpha-cutout quads carrying the
    actual painted-leaf texture so the foliage reads as real leaves, not smooth blobs.
    """
    trunk_mb = MeshBuilder()
    canopy_mb = MeshBuilder()
    leaf_mb = MeshBuilder()

    H = hf["H"]
    n_xz = H.shape[0]
    pixel_m = WORLD_SIZE / (n_xz - 1)
    dHdx = np.gradient(H, pixel_m, axis=1)
    dHdz = np.gradient(H, pixel_m, axis=0)
    slope_grid = np.sqrt(dHdx * dHdx + dHdz * dHdz)

    rng = np.random.default_rng(20261127)
    placed_xz = []

    def _can_place(x: float, z: float, min_spacing: float) -> tuple[bool, float, float]:
        # Exclude Cenote opening (+60, -33), Valley Cave mouth (+25, -3), Ruins (+72, +38), Lighthouse (-12, +114), Village pad (-96, +22), Bridge (+2, +36)
        if (x - 60.0) ** 2 + (z + 33.0) ** 2 < 14.0 ** 2:
            return False, 0.0, 0.0
        if (x - 25.0) ** 2 + (z + 2.0) ** 2 < 13.0 ** 2:
            return False, 0.0, 0.0
        if (x - 72.0) ** 2 + (z - 38.0) ** 2 < 24.5 ** 2:
            return False, 0.0, 0.0
        if (x + 12.0) ** 2 + (z - 114.0) ** 2 < 11.5 ** 2:
            return False, 0.0, 0.0
        if (x + 96.0) ** 2 + (z - 22.0) ** 2 < 16.0 ** 2:
            return False, 0.0, 0.0
        if (x - 2.0) ** 2 + (z - 36.0) ** 2 < 13.0 ** 2:
            return False, 0.0, 0.0

        ix = int(np.clip((x - X_MIN) / WORLD_SIZE * (n_xz - 1), 0, n_xz - 1))
        iz = int(np.clip((z - Z_MIN) / WORLD_SIZE * (n_xz - 1), 0, n_xz - 1))
        h = sample_height(hf, x, z)
        sl = float(slope_grid[iz, ix])
        rdist = float(hf["river_dist"][iz, ix])
        rhw = float(hf["river_hw"][iz, ix])
        tmask = float(hf["trail_mask"][iz, ix])

        if h < 1.1 or sl > 0.62 or tmask > 0.35 or rdist < rhw + 2.8:
            return False, h, sl

        for px, pz, psp in placed_xz:
            req = max(min_spacing, psp)
            if (x - px) ** 2 + (z - pz) ** 2 < req * req:
                return False, h, sl
        return True, h, sl

    # A. Beach & Cove Coconut Palms (~82 palms in coastal zone Y = 1.2m .. 8.5m)
    attempts = 0
    palms = 0
    while palms < 82 and attempts < 3500:
        attempts += 1
        x = float(rng.uniform(-148.0, 148.0))
        z = float(rng.uniform(-148.0, 148.0))
        ok, h, _ = _can_place(x, z, min_spacing=7.5)
        if not ok or not (1.2 <= h <= 8.5):
            continue
        # Lean gracefully outward toward the ocean!
        yaw = math.atan2(z, x) + float(rng.uniform(-0.45, 0.45))
        sc = float(rng.uniform(0.85, 1.30))
        add_coconut_palm(trunk_mb, canopy_mb, np.array([x, h, z], dtype=np.float32), sc, yaw, seed=1000 + palms)
        placed_xz.append((x, z, 6.8))
        palms += 1

    # B. Tropical Rainforest / Banyan Canopy Trees (~95 trees in Y = 6.5m .. 34.0m)
    attempts = 0
    jungles = 0
    while jungles < 95 and attempts < 4000:
        attempts += 1
        x = float(rng.uniform(-135.0, 135.0))
        z = float(rng.uniform(-135.0, 135.0))
        ok, h, _ = _can_place(x, z, min_spacing=9.5)
        if not ok or not (6.2 <= h <= 34.0):
            continue
        sc = float(rng.uniform(0.85, 1.42))
        add_rainforest_tree(trunk_mb, canopy_mb, leaf_mb, np.array([x, h, z], dtype=np.float32), sc, seed=2000 + jungles)
        placed_xz.append((x, z, 8.8))
        jungles += 1

    # C. Highland Mountain Conifers (~62 pines in Y = 28.0m .. 68.0m)
    attempts = 0
    pines = 0
    while pines < 62 and attempts < 3500:
        attempts += 1
        x = float(rng.uniform(-110.0, 110.0))
        z = float(rng.uniform(-125.0, 60.0))
        ok, h, _ = _can_place(x, z, min_spacing=8.0)
        if not ok or not (27.0 <= h <= 68.0):
            continue
        sc = float(rng.uniform(0.82, 1.28))
        add_highland_pine(trunk_mb, canopy_mb, np.array([x, h, z], dtype=np.float32), sc, seed=3000 + pines)
        placed_xz.append((x, z, 7.2))
        pines += 1

    # D. Lush Riparian Bushes & Jungle Shrubs (~125 bushes near riverbanks, plunge lagoon & trails)
    attempts = 0
    bushes = 0
    while bushes < 125 and attempts < 3500:
        attempts += 1
        x = float(rng.uniform(-135.0, 135.0))
        z = float(rng.uniform(-135.0, 135.0))
        ix = int(np.clip((x - X_MIN) / WORLD_SIZE * (n_xz - 1), 0, n_xz - 1))
        iz = int(np.clip((z - Z_MIN) / WORLD_SIZE * (n_xz - 1), 0, n_xz - 1))
        h = sample_height(hf, x, z)
        sl = float(slope_grid[iz, ix])
        rdist = float(hf["river_dist"][iz, ix])
        rhw = float(hf["river_hw"][iz, ix])
        tmask = float(hf["trail_mask"][iz, ix])
        if h < 1.8 or h > 46.0 or sl > 0.65 or tmask > 0.45 or rdist < rhw + 1.8:
            continue
        if (x - 60.0) ** 2 + (z + 33.0) ** 2 < 13.0 ** 2:
            continue
        if (x - 25.0) ** 2 + (z + 2.0) ** 2 < 15.0 ** 2:
            continue
        if (x - 72.0) ** 2 + (z - 38.0) ** 2 < 16.5 ** 2:
            continue
        if (x + 96.0) ** 2 + (z - 22.0) ** 2 < 14.0 ** 2:
            continue
        sc = float(rng.uniform(0.9, 2.1))
        add_sculpted_spheroid(
            canopy_mb,
            np.array([x, h + 0.45 * sc, z], dtype=np.float32),
            rx=1.45 * sc, ry=0.95 * sc, rz=1.45 * sc,
            n_lat=5, n_lon=8, bump_amp=0.24, seed=4000 + bushes, uv_scale=1.5,
            top_color=(1.04, 1.15, 0.85, 1.0),
            bot_color=(0.48, 0.65, 0.45, 1.0),
        )
        bushes += 1

    return trunk_mb.build(), canopy_mb.build(), leaf_mb.build()


# ---------------------------------------------------------------------------
# 3. CAVE STALACTITES, STALAGMITES, GLOWING CRYSTALS & SCATTERED BOULDERS
# ---------------------------------------------------------------------------

def add_crystal_cluster(
    crystal_mb: MeshBuilder,
    pos: np.ndarray,
    normal_dir: np.ndarray,
    scale: float,
    palette: tuple[float, float, float],
    seed: int,
):
    """Multi-spire 6-sided pointed glowing crystal cluster oriented along normal_dir."""
    rng = np.random.default_rng(seed)
    base_rot = _align_y_to_dir(normal_dir)
    n_spires = 6
    for k in range(n_spires):
        tilt_x = 0.0 if k == 0 else rng.uniform(-0.52, 0.52)
        tilt_z = 0.0 if k == 0 else rng.uniform(-0.52, 0.52)
        rot = base_rot @ _rot_x(tilt_x) @ _rot_z(tilt_z)
        h_s = (3.4 if k == 0 else rng.uniform(1.6, 2.8)) * scale
        r_s = (0.58 if k == 0 else rng.uniform(0.28, 0.46)) * scale
        local_spine = np.array([
            [0.0, -0.35 * scale, 0.0],
            [0.0, h_s * 0.72, 0.0],
            [0.0, h_s, 0.0],
        ], dtype=np.float32)
        offset_local = np.array([rng.uniform(-0.55, 0.55) * scale, 0.0, rng.uniform(-0.55, 0.55) * scale], dtype=np.float32) if k > 0 else np.zeros(3, dtype=np.float32)
        world_spine = (local_spine + offset_local[None, :]) @ rot.T + pos[None, :]
        add_tapered_tube(
            crystal_mb,
            world_spine,
            np.array([r_s * 0.92, r_s, 0.02], dtype=np.float32),
            sides=6,
            cap_top=True,
            u_repeats=1.0,
            v_tile_m=max(h_s, 0.5),
            color=(palette[0], palette[1], palette[2], 0.96),
        )


def build_cave_details_and_boulders(hf: dict) -> tuple[dict, dict]:
    """
    Build:
    - Cave Stalactites (hanging from exact SDF ceiling!) & Stalagmites + Scattered Island Boulders
    - Glowing Cave Crystal Clusters + Ancient Temple Altar Relic Crystal
    """
    rock_mb = MeshBuilder()
    crystal_mb = MeshBuilder()

    rng = np.random.default_rng(778899)
    ys_probe = np.linspace(-3.0, 32.0, 140, dtype=np.float32)

    palettes = [
        (0.45, 1.25, 1.40),  # Electric Cyan-Aqua
        (0.95, 0.62, 1.42),  # Mystic Amethyst-Violet
        (0.40, 1.38, 0.95),  # Bioluminescent Emerald
    ]

    # Sample interior points across the cave tunnels & main cavern X in [26..106], Z in [-50..0]
    stalactite_count = 0
    crystal_count = 0
    for attempt in range(900):
        if stalactite_count >= 75 and crystal_count >= 28:
            break
        x = float(rng.uniform(26.0, 106.0))
        z = float(rng.uniform(-50.0, 0.0))
        # Skip open Cenote shaft (+60, -33)
        if (x - 60.0) ** 2 + (z + 33.0) ** 2 < 9.2 ** 2:
            continue

        h_top = sample_height(hf, x, z)
        px = np.full_like(ys_probe, x)
        pz = np.full_like(ys_probe, z)
        csdf = evaluate_cave_void_sdf(px, ys_probe, pz)

        inside = np.where((csdf < -0.2) & (ys_probe < h_top - 4.0))[0]
        if len(inside) < 6:
            continue

        y_floor = float(ys_probe[inside[0]])
        y_ceil = float(ys_probe[inside[-1]])
        room_h = y_ceil - y_floor
        if room_h < 4.5:
            continue

        # Hang Stalactite from ceiling!
        if stalactite_count < 75 and rng.random() < 0.65:
            st_len = float(rng.uniform(1.8, min(5.8, room_h * 0.36)))
            st_rad = st_len * float(rng.uniform(0.14, 0.22))
            spine = np.array([
                [x, y_ceil + 0.65, z],
                [x + rng.uniform(-0.15, 0.15), y_ceil - st_len * 0.55, z + rng.uniform(-0.15, 0.15)],
                [x, y_ceil - st_len, z],
            ], dtype=np.float32)
            add_tapered_tube(
                rock_mb, spine,
                np.array([st_rad, st_rad * 0.52, 0.04], dtype=np.float32),
                sides=7, cap_top=True, u_repeats=1.2, v_tile_m=3.0,
                color=(0.76, 0.82, 0.88, 1.0),
            )
            stalactite_count += 1

        # Floor Stalagmites & Giant Glowing Crystals on dry cave ledges OR shallow lagoon islets!
        if y_floor > -0.35:
            if crystal_count < 28 and rng.random() < 0.42:
                pal = palettes[crystal_count % len(palettes)]
                sc = float(rng.uniform(0.85, 1.65))
                n_dir = np.array([rng.uniform(-0.28, 0.28), 1.0, rng.uniform(-0.28, 0.28)], dtype=np.float32)
                add_crystal_cluster(
                    crystal_mb,
                    np.array([x, max(y_floor, 0.05) - 0.15, z], dtype=np.float32),
                    n_dir, sc, pal, seed=5000 + crystal_count,
                )
                crystal_count += 1
            elif stalactite_count < 75 and rng.random() < 0.40 and y_floor > 0.4:
                sg_len = float(rng.uniform(1.5, min(4.5, room_h * 0.30)))
                sg_rad = sg_len * 0.20
                spine = np.array([
                    [x, y_floor - 0.5, z],
                    [x, y_floor + sg_len * 0.6, z],
                    [x, y_floor + sg_len, z],
                ], dtype=np.float32)
                add_tapered_tube(
                    rock_mb, spine,
                    np.array([sg_rad, sg_rad * 0.58, 0.06], dtype=np.float32),
                    sides=7, cap_top=True, u_repeats=1.2, v_tile_m=3.0,
                    color=(0.74, 0.80, 0.86, 1.0),
                )

    # Also place Hero Crystal Formations right inside the Valley Cave Entrance (+30.5, 15.4, -7.5) & Cavern!
    add_crystal_cluster(crystal_mb, np.array([31.5, 15.1, -8.5], dtype=np.float32), np.array([-0.2, 1.0, 0.2]), 1.45, palettes[0], seed=9101)
    add_crystal_cluster(crystal_mb, np.array([25.5, 15.3, -4.5], dtype=np.float32), np.array([0.2, 1.0, 0.15]), 1.15, palettes[1], seed=9104)
    add_crystal_cluster(crystal_mb, np.array([50.0, 1.2, -24.5], dtype=np.float32), np.array([0.1, 1.0, -0.15]), 1.85, palettes[1], seed=9102)
    add_crystal_cluster(crystal_mb, np.array([65.0, 0.6, -22.0], dtype=np.float32), np.array([-0.15, 1.0, 0.25]), 1.75, palettes[2], seed=9103)

    # Hero Glowing Relic Crystal atop the Eastern Ancient Temple Ruins Altar (+72, +38)!
    add_crystal_cluster(crystal_mb, np.array([72.0, 33.4, 38.0], dtype=np.float32), np.array([0.0, 1.0, 0.0]), 1.25, (0.45, 1.35, 1.48), seed=9199)

    # Scatter ~145 Sculpted 3D Boulders along riverbanks, waterfall plunge pool, beaches & cliffs!
    boulders = 0
    for i in range(900):
        if boulders >= 145:
            break
        if boulders < 26:
            # Cluster boulders around the Emerald Waterfall Plunge Lagoon (-20, -9)!
            ang = rng.uniform(0, 6.28)
            rad = rng.uniform(11.5, 18.5)
            x = -20.0 + rad * math.cos(ang)
            z = -9.0 + rad * math.sin(ang)
        else:
            x = float(rng.uniform(-148.0, 148.0))
            z = float(rng.uniform(-148.0, 148.0))

        # Avoid trails & building pads
        if (x - 72.0) ** 2 + (z - 38.0) ** 2 < 15.0 ** 2:
            continue
        if (x + 96.0) ** 2 + (z - 22.0) ** 2 < 14.0 ** 2:
            continue
        if (x - 25.0) ** 2 + (z + 2.0) ** 2 < 9.0 ** 2:
            continue

        h = sample_height(hf, x, z)
        if h < -0.8 or h > 64.0:
            continue
        rx = float(rng.uniform(0.9, 3.1))
        ry = rx * float(rng.uniform(0.55, 0.90))
        rz = rx * float(rng.uniform(0.75, 1.25))
        rot = _rot_y(float(rng.uniform(0, 6.28))) @ _rot_x(float(rng.uniform(-0.25, 0.25)))
        add_sculpted_spheroid(
            rock_mb,
            np.array([x, h + ry * 0.35, z], dtype=np.float32),
            rx, ry, rz,
            n_lat=6, n_lon=9, bump_amp=0.22, seed=6000 + boulders, uv_scale=1.4,
            top_color=(1.04, 1.02, 0.98, 1.0),
            bot_color=(0.68, 0.70, 0.68, 1.0),
            rot=rot,
        )
        boulders += 1

    return rock_mb.build(), crystal_mb.build()


# ---------------------------------------------------------------------------
# 4. ARCHITECTURAL LANDMARKS ("dan macem2"):
#    Bridge, Beach Village Huts, Pier & Boats, Ancient Temple Ruins, Lighthouse, Campfires
# ---------------------------------------------------------------------------

def _add_tropical_hut(
    wood_mb: MeshBuilder,
    thatch_mb: MeshBuilder,
    fire_mb: MeshBuilder,
    hf: dict,
    cx: float,
    cz: float,
    yaw: float,
    w: float = 5.6,
    d: float = 6.8,
):
    """Build a detailed tropical stilt cabin with plank deck, walls, doorway, steps, thatch roof & porch lantern."""
    rot = _rot_y(yaw)
    h_ground = sample_height(hf, cx, cz)
    deck_y = max(h_ground + 1.15, 2.6)

    def to_world(lx: float, ly: float, lz: float) -> np.ndarray:
        return (np.array([lx, ly, lz], dtype=np.float32) @ rot.T) + np.array([cx, deck_y, cz], dtype=np.float32)

    # 6 Stilt Posts extending deep into ground
    for sx in (-w * 0.46, w * 0.46):
        for sz in (-d * 0.46, 0.0, d * 0.46):
            p_top = to_world(sx, 0.0, sz)
            p_bot = np.array([p_top[0], h_ground - 1.5, p_top[2]], dtype=np.float32)
            add_tapered_tube(wood_mb, np.stack([p_bot, p_top]), np.array([0.20, 0.20], dtype=np.float32), sides=6)

    # Main Floor Deck + Front Veranda Porch (+Z local)
    add_box(wood_mb, to_world(0.0, 0.12, 0.25), (w + 0.6, 0.24, d + 1.6), rot=rot, uv_scale=2.2)

    # Front Access Wooden Steps (+Z local)
    n_steps = 4
    for s_i in range(n_steps):
        frac = (s_i + 1) / (n_steps + 1)
        sy = -1.15 * frac
        sz = d * 0.5 + 1.05 + 0.45 * s_i
        add_box(wood_mb, to_world(0.0, sy, sz), (2.0, 0.16, 0.48), rot=rot, uv_scale=1.5)

    # Cabin Timber Walls (Back -Z, Left -X, Right +X, and Front +Z split for open doorway!)
    wall_h = 2.85
    add_box(wood_mb, to_world(0.0, wall_h * 0.5 + 0.2, -d * 0.42), (w, wall_h, 0.22), rot=rot, uv_scale=2.0)
    add_box(wood_mb, to_world(-w * 0.48, wall_h * 0.5 + 0.2, -0.2), (0.22, wall_h, d * 0.84), rot=rot, uv_scale=2.0)
    add_box(wood_mb, to_world(w * 0.48, wall_h * 0.5 + 0.2, -0.2), (0.22, wall_h, d * 0.84), rot=rot, uv_scale=2.0)
    # Front wall panels leaving 1.5m open doorway
    panel_w = (w - 1.5) * 0.5
    add_box(wood_mb, to_world(-(w * 0.5 - panel_w * 0.5), wall_h * 0.5 + 0.2, d * 0.40 - 0.2), (panel_w, wall_h, 0.22), rot=rot, uv_scale=2.0)
    add_box(wood_mb, to_world(+(w * 0.5 - panel_w * 0.5), wall_h * 0.5 + 0.2, d * 0.40 - 0.2), (panel_w, wall_h, 0.22), rot=rot, uv_scale=2.0)

    # Porch corner posts & railings
    for sx in (-w * 0.48, w * 0.48):
        add_box(wood_mb, to_world(sx, wall_h * 0.5 + 0.2, d * 0.5 + 0.85), (0.18, wall_h, 0.18), rot=rot, uv_scale=1.5)

    # Steep Woven Palm-Thatch Hip/Pyramid Roof (`thatch_mb`)!
    rw, rd, rh = (w + 1.8) * 0.5, (d + 2.8) * 0.5, 2.95
    ry0 = wall_h + 0.12
    ridge_z = 1.2
    # 4 sloped thatch faces meeting at ridge line (0, ry0 + rh, -ridge_z .. +ridge_z)
    c0 = (-rw, ry0, rd + 0.2)     # front-left
    c1 = (rw, ry0, rd + 0.2)      # front-right
    c2 = (rw, ry0, -rd + 0.2)     # back-right
    c3 = (-rw, ry0, -rd + 0.2)    # back-left
    r_front = (0.0, ry0 + rh, ridge_z + 0.2)
    r_back = (0.0, ry0 + rh, -ridge_z + 0.2)

    roof_tris_local = [
        # Front hip triangle: c0 -> c1 -> r_front
        (c0, c1, r_front, (0.0, 1.8), (2.2, 1.8), (1.1, 0.0)),
        # Back hip triangle: c2 -> c3 -> r_back
        (c2, c3, r_back, (0.0, 1.8), (2.2, 1.8), (1.1, 0.0)),
        # Right slope quad: c1 -> c2 -> r_back -> r_front
        (c1, c2, r_back, (0.0, 1.8), (2.6, 1.8), (2.0, 0.0)),
        (c1, r_back, r_front, (0.0, 1.8), (2.0, 0.0), (0.6, 0.0)),
        # Left slope quad: c3 -> c0 -> r_front -> r_back
        (c3, c0, r_front, (0.0, 1.8), (2.6, 1.8), (2.0, 0.0)),
        (c3, r_front, r_back, (0.0, 1.8), (2.0, 0.0), (0.6, 0.0)),
    ]
    rv, ruv, rf = [], [], []
    for idx_t, (p0, p1, p2, uv0, uv1, uv2) in enumerate(roof_tris_local):
        rv.extend([to_world(*p0), to_world(*p1), to_world(*p2)])
        ruv.extend([uv0, uv1, uv2])
        b = idx_t * 3
        rf.append((b, b + 1, b + 2))
    rv_arr = np.array(rv, dtype=np.float32)
    rf_arr = np.array(rf, dtype=np.uint32)
    if np.sum(np.cross(rv_arr[rf_arr[:, 1]] - rv_arr[rf_arr[:, 0]], rv_arr[rf_arr[:, 2]] - rv_arr[rf_arr[:, 0]])[:, 1]) < 0:
        rf_arr = rf_arr[:, [0, 2, 1]]
    thatch_mb.add_raw(rv_arr, rf_arr, np.array(ruv, dtype=np.float32), color=(1.04, 0.98, 0.88, 1.0))

    # Warm Glowing Porch Lantern!
    add_box(fire_mb, to_world(1.1, wall_h - 0.35, d * 0.5 + 0.75), (0.34, 0.46, 0.34), rot=rot, uv_scale=0.5, color=(1.2, 0.95, 0.65, 1.0))


def _add_outrigger_boat(wood_mb: MeshBuilder, thatch_mb: MeshBuilder, cx: float, cz: float, yaw: float):
    """Build a traditional tropical wooden outrigger boat with curved hull, outrigger float & woven sail."""
    rot = _rot_y(yaw)
    # Tapered hull along local Z (-3.8m stern .. +4.2m bow)
    t = np.linspace(0.0, 1.0, 7, dtype=np.float32)
    zs = -3.8 + 8.0 * t
    ys = 0.25 + 0.55 * ((2.0 * t - 1.0) ** 4)
    radii = 0.72 * np.sin(np.pi * np.clip(0.08 + 0.84 * t, 0.05, 0.95))
    local_spine = np.stack([np.zeros_like(zs), ys, zs], axis=1)
    world_spine = (local_spine @ rot.T) + np.array([cx, 0.0, cz], dtype=np.float32)
    add_tapered_tube(wood_mb, world_spine, radii, sides=7, cap_top=True, cap_bottom=True, u_repeats=1.2, v_tile_m=2.5)

    # Outrigger crossbeams & pontoon float on +X side
    for bz in (-1.5, 1.5):
        p_mid = (np.array([1.25, 0.55, bz], dtype=np.float32) @ rot.T) + np.array([cx, 0.0, cz], dtype=np.float32)
        add_box(wood_mb, p_mid, (2.5, 0.12, 0.14), rot=rot)
    fl_spine = (np.array([[2.4, 0.14, -2.6], [2.4, 0.12, 0.0], [2.4, 0.22, 2.8]], dtype=np.float32) @ rot.T) + np.array([cx, 0.0, cz], dtype=np.float32)
    add_tapered_tube(wood_mb, fl_spine, np.array([0.14, 0.22, 0.08], dtype=np.float32), sides=6, cap_top=True, cap_bottom=True)

    # Mast + Triangular Woven Sail (`thatch_mb` tinted warm cream!)
    mast_bot = np.array([cx, 0.35, cz], dtype=np.float32)
    mast_top = mast_bot + np.array([0.0, 5.2, 0.0], dtype=np.float32)
    add_tapered_tube(wood_mb, np.stack([mast_bot, mast_top]), np.array([0.11, 0.06], dtype=np.float32), sides=6, cap_top=True)

    s0 = (np.array([0.0, 5.0, 0.1], dtype=np.float32) @ rot.T) + np.array([cx, 0.0, cz], dtype=np.float32)
    s1 = (np.array([0.35, 1.3, 2.8], dtype=np.float32) @ rot.T) + np.array([cx, 0.0, cz], dtype=np.float32)
    s2 = (np.array([-0.15, 1.4, -2.2], dtype=np.float32) @ rot.T) + np.array([cx, 0.0, cz], dtype=np.float32)
    # Double-sided sail (2 triangles back-to-back)
    sv = np.array([s0, s1, s2, s0, s2, s1], dtype=np.float32)
    sf = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.uint32)
    suv = np.array([[0.5, 0.0], [1.0, 1.0], [0.0, 1.0], [0.5, 0.0], [0.0, 1.0], [1.0, 1.0]], dtype=np.float32)
    thatch_mb.add_raw(sv, sf, suv, color=(1.22, 1.18, 1.08, 1.0))


def build_landmarks_and_structures(hf: dict) -> dict[str, dict]:
    """
    Build all architectural landmarks ("dan macem2"):
    - Arched Wooden Plank River Bridge (+2, +36)
    - Western Cove Fishing Village (4 Stilt Huts + Long Wooden Pier + 2 Outrigger Boats + Campfire)
    - Valley Cave Explorer Boardwalk & Torch Campfire
    - Eastern Plateau Ancient Temple Ruins (+72, +38)
    - Southern Cliffside Lighthouse (-12, +114)
    """
    wood_mb = MeshBuilder()
    thatch_mb = MeshBuilder()
    stone_mb = MeshBuilder()
    fire_mb = MeshBuilder()

    # ------------------------------------------------------------------
    # A. ARCHED WOODEN PLANK RIVER BRIDGE across river at (+2.0, +36.0)!
    #    Spans from West Bank (-9.5, +40.2) to East Bank (+13.5, +31.8)
    # ------------------------------------------------------------------
    bw_start = np.array([-9.8, sample_height(hf, -9.8, 40.2) + 0.35, 40.2], dtype=np.float32)
    bw_end = np.array([13.8, sample_height(hf, 13.8, 31.8) + 0.35, 31.8], dtype=np.float32)
    span_vec = bw_end - bw_start
    span_xz = np.array([span_vec[0], 0.0, span_vec[2]], dtype=np.float32)
    span_len = float(np.linalg.norm(span_xz))
    bridge_yaw = math.atan2(-span_xz[2], span_xz[0])  # Align local +X along bridge span? Let's align local +Z along span!
    b_yaw = math.atan2(span_xz[0], span_xz[2])
    b_rot = _rot_y(b_yaw)
    side_dir = np.array([math.cos(b_yaw), 0.0, -math.sin(b_yaw)], dtype=np.float32)  # perpendicular to span in XZ

    # Stone Abutments on West & East banks
    for end_pt in (bw_start, bw_end):
        add_box(stone_mb, end_pt - np.array([0.0, 1.6, 0.0], dtype=np.float32), (4.8, 3.8, 3.4), rot=b_rot, uv_scale=2.5)

    # 22 Arched Deck Planks + Twin Arch Support Beams + Side Posts & Handrails!
    n_planks = 24
    deck_pts = []
    for i in range(n_planks):
        t = i / (n_planks - 1)
        p = (1.0 - t) * bw_start + t * bw_end
        arch_lift = 3.1 * math.sin(math.pi * t)
        p[1] += arch_lift
        deck_pts.append(p)
        add_box(wood_mb, p, (3.6, 0.18, span_len / n_planks * 0.92), rot=b_rot, uv_scale=2.0)

    deck_arr = np.array(deck_pts, dtype=np.float32)
    for s_off in (-1.62, +1.62):
        beam_spine = deck_arr + s_off * side_dir[None, :] - np.array([[0.0, 0.22, 0.0]], dtype=np.float32)
        add_tapered_tube(wood_mb, beam_spine, np.full(n_planks, 0.18, dtype=np.float32), sides=6)
        rail_spine = deck_arr + s_off * side_dir[None, :] + np.array([[0.0, 1.12, 0.0]], dtype=np.float32)
        add_tapered_tube(wood_mb, rail_spine, np.full(n_planks, 0.09, dtype=np.float32), sides=6)
        # Vertical railing posts every 3 planks + lanterns at ends & apex!
        for i in range(0, n_planks, 3):
            p_base = deck_arr[i] + s_off * side_dir
            add_box(wood_mb, p_base + np.array([0.0, 0.6, 0.0], dtype=np.float32), (0.16, 1.25, 0.16), rot=b_rot)
            if i in (0, n_planks // 2, n_planks - 1):
                add_box(fire_mb, p_base + np.array([0.0, 1.38, 0.0], dtype=np.float32), (0.30, 0.36, 0.30), rot=b_rot, uv_scale=0.4)

    # ------------------------------------------------------------------
    # B. WESTERN COVE FISHING VILLAGE, WOODEN PIER, BOATS & CAMPFIRE
    # ------------------------------------------------------------------
    hut_specs = [
        (-92.0, 12.0, -1.35, 5.8, 7.0),
        (-88.0, 29.5, -1.75, 5.4, 6.4),
        (-78.0, 16.0, -1.55, 6.2, 7.4),
        (-82.0, 38.0, -1.90, 5.2, 6.2),
    ]
    for hx, hz, hyaw, hw, hd in hut_specs:
        _add_tropical_hut(wood_mb, thatch_mb, fire_mb, hf, hx, hz, hyaw, hw, hd)

    # Long Wooden Pier / Dock extending West from beach (-102, +22) out into cove (-138, +22) at Y = +1.85m!
    pier_y = 1.85
    pier_xs = np.linspace(-101.0, -138.0, 28)
    for idx_p, px in enumerate(pier_xs):
        add_box(wood_mb, (px, pier_y, 22.0), (1.25, 0.18, 4.2), uv_scale=2.0)
        if idx_p % 3 == 0:
            h_bed = sample_height(hf, float(px), 22.0)
            for sz in (20.1, 23.9):
                p_bot = np.array([px, min(h_bed - 1.2, -4.5), sz], dtype=np.float32)
                p_top = np.array([px, pier_y + 0.95, sz], dtype=np.float32)
                add_tapered_tube(wood_mb, np.stack([p_bot, p_top]), np.array([0.22, 0.20], dtype=np.float32), sides=6, cap_top=True)
                if idx_p in (0, 12, 27):
                    add_box(fire_mb, (px, pier_y + 1.15, sz), (0.30, 0.38, 0.30), uv_scale=0.4)

    # Two Stringer Beams under Pier
    for sz in (20.3, 23.7):
        add_box(wood_mb, (-119.5, pier_y - 0.18, sz), (37.5, 0.24, 0.24), uv_scale=3.0)

    # 2 Traditional Outrigger Sailboats:
    # Boat 1 moored next to Western Pier (-131, +15.5)
    _add_outrigger_boat(wood_mb, thatch_mb, -131.0, 15.5, yaw=0.35)
    # Boat 2 exploring right outside the Eastern Sea-Cave Cliff Arch (+136, -34)!
    _add_outrigger_boat(wood_mb, thatch_mb, +136.0, -34.0, yaw=-1.52)

    # Beach Campfire Circle at (-96.5, +27.5) & Cave Plaza Explorer Campfire at (+18.5, +5.5)!
    for fx, fz in [(-96.5, 27.5), (+18.5, +5.5)]:
        fy = sample_height(hf, fx, fz)
        # Ring of 8 fire stones
        for k in range(8):
            ka = k * math.pi * 0.25
            add_sculpted_spheroid(stone_mb, np.array([fx + 1.05 * math.cos(ka), fy + 0.18, fz + 1.05 * math.sin(ka)], dtype=np.float32), 0.34, 0.24, 0.30, n_lat=4, n_lon=6, seed=800 + k)
        # Crossed firewood logs
        for ka in (0.3, 1.35, 2.4):
            add_box(wood_mb, (fx, fy + 0.22, fz), (1.5, 0.18, 0.18), rot=_rot_y(ka))
        # Glowing Fire Flame Cone!
        f_spine = np.array([[fx, fy + 0.15, fz], [fx + 0.08, fy + 0.95, fz - 0.05], [fx, fy + 1.65, fz]], dtype=np.float32)
        add_tapered_tube(fire_mb, f_spine, np.array([0.62, 0.36, 0.04], dtype=np.float32), sides=7, cap_top=True, color=(1.35, 0.95, 0.45, 1.0))
        # 3 Rustic Log Benches around fire
        for ka in (0.6, 2.7, 4.7):
            bx, bz = fx + 2.8 * math.cos(ka), fz + 2.8 * math.sin(ka)
            by = sample_height(hf, bx, bz)
            add_box(wood_mb, (bx, by + 0.32, bz), (2.2, 0.42, 0.48), rot=_rot_y(ka + 1.57), uv_scale=1.5)

    # Explorer Wooden Boardwalk leading level into the Valley Cave Mouth (+23.5, 15.7, -1.5 -> +45.5, 9.2, -22.8)!
    bw_cave_pts = np.array([
        [23.5, 15.75, -1.5],
        [29.0, 15.55, -6.8],
        [34.5, 14.30, -12.0],
        [40.0, 12.10, -17.5],
        [45.5, 9.20,  -22.8],
    ], dtype=np.float32)
    for i in range(len(bw_cave_pts) - 1):
        p0, p1 = bw_cave_pts[i], bw_cave_pts[i + 1]
        seg_v = p1 - p0
        seg_l = float(np.linalg.norm(seg_v))
        cyaw = math.atan2(seg_v[0], seg_v[2])
        cpitch = -math.asin(float(np.clip(seg_v[1] / max(seg_l, 1e-4), -0.8, 0.8)))
        crot = _rot_y(cyaw) @ _rot_x(cpitch)
        mid = 0.5 * (p0 + p1)
        add_box(wood_mb, mid, (2.4, 0.18, seg_l * 1.02), rot=crot, uv_scale=2.0)
        # Standing cave torch post beside boardwalk!
        t_pos = mid + np.array([1.35, 0.0, 0.0], dtype=np.float32)
        add_box(wood_mb, t_pos + np.array([0.0, 0.65, 0.0], dtype=np.float32), (0.16, 1.5, 0.16))
        add_box(fire_mb, t_pos + np.array([0.0, 1.52, 0.0], dtype=np.float32), (0.32, 0.42, 0.32), uv_scale=0.4)

    # ------------------------------------------------------------------
    # C. EASTERN PLATEAU ANCIENT TEMPLE RUINS (+72.0, +38.0, Y ~ +30.5m)!
    # ------------------------------------------------------------------
    rcx, rcz = 72.0, 38.0
    ry_base = sample_height(hf, rcx, rcz) - 0.3
    # 3-Tiered Stepped Mossy Stone Ziggurat Platform
    add_box(stone_mb, (rcx, ry_base + 0.55, rcz), (18.0, 1.2, 18.0), uv_scale=3.0)
    add_box(stone_mb, (rcx, ry_base + 1.55, rcz), (13.6, 0.9, 13.6), uv_scale=3.0)
    add_box(stone_mb, (rcx, ry_base + 2.30, rcz), (9.4, 0.7, 9.4), uv_scale=2.8)
    # Central Carved Stone Altar Pedestal (holding the Glowing Cyan Relic Crystal!)
    add_box(stone_mb, (rcx, ry_base + 3.15, rcz), (2.4, 1.1, 2.4), uv_scale=1.8)
    # Western Ceremonial Stone Stairway facing the trail (-X)
    for st in range(6):
        add_box(stone_mb, (rcx - 9.2 + st * 0.85, ry_base + 0.25 + st * 0.42, rcz), (1.1, 0.5, 4.4), uv_scale=2.0)
    # Grand Mossy Stone Portal Archway at West Entrance
    for sz_off in (-2.4, +2.4):
        add_box(stone_mb, (rcx - 8.6, ry_base + 3.4, rcz + sz_off), (1.2, 5.2, 1.2), uv_scale=2.0)
    add_box(stone_mb, (rcx - 8.6, ry_base + 6.3, rcz), (1.5, 1.1, 6.6), uv_scale=2.2)

    # 8 Perimeter Carved Temple Columns (some intact with lintels, some dramatically broken!)
    col_ring = [
        (-5.6, -5.6, 5.4, True),
        (0.0,  -5.6, 5.4, True),
        (+5.6, -5.6, 3.1, False),  # Broken column!
        (+5.6,  0.0, 5.4, True),
        (+5.6, +5.6, 5.4, True),
        (0.0,  +5.6, 2.4, False),  # Broken column!
        (-5.6, +5.6, 5.4, True),
        (-5.6, +2.8, 3.8, False),
    ]
    for dx, dz, ch, intact in col_ring:
        c_bot = np.array([rcx + dx, ry_base + 2.6, rcz + dz], dtype=np.float32)
        c_top = c_bot + np.array([0.0, ch, 0.0], dtype=np.float32)
        add_tapered_tube(stone_mb, np.stack([c_bot, c_top]), np.array([0.62, 0.54], dtype=np.float32), sides=10, cap_top=True, u_repeats=1.5, v_tile_m=2.5)
        add_box(stone_mb, c_bot + np.array([0.0, 0.2, 0.0], dtype=np.float32), (1.45, 0.45, 1.45), uv_scale=1.5)
        if intact:
            add_box(stone_mb, c_top + np.array([0.0, 0.22, 0.0], dtype=np.float32), (1.55, 0.45, 1.55), uv_scale=1.5)
    # Stone Lintel Beams connecting intact North & East columns
    add_box(stone_mb, (rcx - 2.8, ry_base + 8.45, rcz - 5.6), (7.2, 0.85, 1.25), uv_scale=2.5)
    add_box(stone_mb, (rcx + 5.6, ry_base + 8.45, rcz + 2.8), (1.25, 0.85, 7.2), uv_scale=2.5)
    # Fallen broken column drum resting on plaza!
    fallen_s = np.array([[rcx + 7.2, ry_base + 1.1, rcz - 4.2], [rcx + 9.8, ry_base + 0.9, rcz - 2.8]], dtype=np.float32)
    add_tapered_tube(stone_mb, fallen_s, np.array([0.54, 0.52], dtype=np.float32), sides=10, cap_top=True, cap_bottom=True)

    # ------------------------------------------------------------------
    # D. SOUTHERN PROMONTORY CLIFFSIDE LIGHTHOUSE (-12.0, +114.0, Y ~ +25m)!
    # ------------------------------------------------------------------
    lx, lz = -12.0, 114.0
    ly = sample_height(hf, lx, lz) - 0.4
    # Octagonal Stone Foundation Base
    add_tapered_tube(
        stone_mb,
        np.array([[lx, ly - 1.2, lz], [lx, ly + 2.4, lz]], dtype=np.float32),
        np.array([4.6, 4.1], dtype=np.float32),
        sides=8, cap_top=True, u_repeats=3.0, v_tile_m=3.0,
    )
    # Tall Tapered 17-meter Stone Lighthouse Tower!
    add_tapered_tube(
        stone_mb,
        np.array([[lx, ly + 2.2, lz], [lx, ly + 10.5, lz], [lx, ly + 18.8, lz]], dtype=np.float32),
        np.array([3.4, 2.7, 2.15], dtype=np.float32),
        sides=12, cap_top=True, u_repeats=2.5, v_tile_m=3.5,
    )
    # Timber Observation Gallery Deck & Railing at Y = ly + 19.0m
    add_tapered_tube(
        wood_mb,
        np.array([[lx, ly + 18.6, lz], [lx, ly + 19.3, lz]], dtype=np.float32),
        np.array([2.85, 2.95], dtype=np.float32),
        sides=12, cap_top=True, cap_bottom=True,
    )
    # Bright 360-degree Glowing Golden Lighthouse Beacon Lantern Room!
    add_tapered_tube(
        fire_mb,
        np.array([[lx, ly + 19.3, lz], [lx, ly + 22.1, lz]], dtype=np.float32),
        np.array([1.72, 1.72], dtype=np.float32),
        sides=10, cap_top=True, color=(1.45, 1.18, 0.65, 1.0),
    )
    # Conical Timber/Thatch Lighthouse Roof Cap + Spire!
    add_tapered_tube(
        wood_mb,
        np.array([[lx, ly + 22.0, lz], [lx, ly + 24.8, lz], [lx, ly + 26.2, lz]], dtype=np.float32),
        np.array([2.45, 0.45, 0.05], dtype=np.float32),
        sides=12, cap_top=True, cap_bottom=True, color=(0.95, 0.52, 0.42, 1.0),
    )

    return {
        "wood": wood_mb.build(),
        "thatch": thatch_mb.build(),
        "stone": stone_mb.build(),
        "fire": fire_mb.build(),
    }
