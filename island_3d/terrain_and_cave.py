import numpy as np
from scipy.ndimage import gaussian_filter
from skimage.measure import marching_cubes
import fast_simplification


# World bounds: 360m x 360m island terrain domain
X_MIN, X_MAX = -180.0, 180.0
Z_MIN, Z_MAX = -180.0, 180.0
WORLD_SIZE = 360.0


def _smoothstep(e0, e1, x: np.ndarray) -> np.ndarray:
    diff = e1 - e0
    denom = np.where(np.abs(diff) < 1e-6, 1e-6, diff)
    t = np.clip((x - e0) / denom, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _fbm_2d(xx: np.ndarray, zz: np.ndarray, seed: int = 42, octaves: int = 5, base_freq: float = 0.012) -> np.ndarray:
    """Deterministic smooth multi-octave 2D value/gradient noise via band-limited trig/hash."""
    rng = np.random.default_rng(seed)
    val = np.zeros_like(xx, dtype=np.float32)
    amp = 1.0
    norm = 0.0
    freq = base_freq
    for _ in range(octaves):
        # Sum 4 random wave directions per octave -> isotropic smooth Perlin-like fBm
        layer = np.zeros_like(xx, dtype=np.float32)
        for _k in range(4):
            ang = rng.uniform(0.0, 2.0 * np.pi)
            phase = rng.uniform(0.0, 2.0 * np.pi)
            kx = np.cos(ang) * freq * 2.0 * np.pi
            kz = np.sin(ang) * freq * 2.0 * np.pi
            layer += np.sin(kx * xx + kz * zz + phase)
        val += amp * (layer * 0.25)
        norm += amp
        amp *= 0.5
        freq *= 2.07
    return val / max(norm, 1e-6)


def _catmull_rom_chain(pts: np.ndarray, samples_per_seg: int = 40) -> np.ndarray:
    """Interpolate a smooth polyline through control points (N, D)."""
    n = len(pts)
    padded = np.vstack([pts[0], pts, pts[-1]])
    out = []
    for i in range(1, n):
        p0, p1, p2, p3 = padded[i - 1], padded[i], padded[i + 1], padded[i + 2]
        t = np.linspace(0.0, 1.0, samples_per_seg, endpoint=(i == n - 1))[:, None]
        t2 = t * t
        t3 = t2 * t
        seg = 0.5 * (
            (2.0 * p1)
            + (-p0 + p2) * t
            + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
            + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
        )
        out.append(seg)
    return np.vstack(out).astype(np.float32)


def get_river_definition() -> dict[str, np.ndarray]:
    """
    Return dense sampled river curves:
    - upper_pts: (M1, 4) -> [x, water_y, z, half_width] from Spring Pond to Waterfall Rim
    - lower_pts: (M2, 4) -> [x, water_y, z, half_width] from Plunge Lagoon to Ocean Delta
    - waterfall: dict with rim & plunge coordinates
    """
    upper_ctrl = np.array([
        [-38.0, 42.5, -56.0, 8.5],   # Mountain spring pond
        [-34.0, 41.2, -45.0, 4.2],   # Upper alpine stream
        [-29.0, 39.6, -34.0, 4.0],   # Stream approaching cliff
        [-24.0, 38.2, -24.5, 4.6],   # Waterfall cliff rim
    ], dtype=np.float32)

    lower_ctrl = np.array([
        [-20.0, 13.8, -9.0,  14.0],  # Emerald plunge lagoon center
        [-19.0, 12.2, +7.0,  6.8],   # Exiting lagoon
        [-11.0, 9.8,  +22.0, 6.2],   # Upper valley curve
        [+2.0,  7.6,  +36.0, 6.5],   # Wooden bridge crossing!
        [+19.0, 5.2,  +52.0, 7.2],   # Mid-jungle S-bend East
        [+14.0, 3.4,  +74.0, 8.2],   # Mid-jungle S-bend West
        [+28.0, 1.6,  +96.0, 10.2],  # Broadening lower river
        [+44.0, 0.15, +118.0, 14.5], # Sandy river mouth at beach
        [+52.0, 0.0,  +140.0, 18.0], # Merging into ocean
    ], dtype=np.float32)

    upper_curve = _catmull_rom_chain(upper_ctrl, samples_per_seg=35)
    lower_curve = _catmull_rom_chain(lower_ctrl, samples_per_seg=40)

    # Enforce monotonically non-increasing water_y along each curve so water never flows uphill!
    upper_curve[:, 1] = np.minimum.accumulate(upper_curve[:, 1])
    lower_curve[:, 1] = np.minimum.accumulate(lower_curve[:, 1])

    return {
        "upper": upper_curve,
        "lower": lower_curve,
        "spring_center": np.array([-38.0, 42.5, -56.0], dtype=np.float32),
        "waterfall_top": np.array([-24.0, 38.2, -24.5], dtype=np.float32),
        "waterfall_bottom": np.array([-21.0, 13.8, -14.5], dtype=np.float32),
        "plunge_center": np.array([-20.0, 13.8, -9.0], dtype=np.float32),
        "bridge_center": np.array([+2.0, 7.6, +36.0], dtype=np.float32),
    }


def get_trails_polylines() -> list[np.ndarray]:
    """Walking paths connecting Pier/Village -> Bridge -> Cave Mouth / Plunge Pool / Ruins / Lighthouse."""
    # Path 1: Beach Village (-96, +22) -> winding jungle trail -> Bridge (-8, +40 -> +12, +32) -> Ruins (+72, +38)
    p1 = _catmull_rom_chain(np.array([
        [-102.0, 22.0],
        [-82.0,  18.0],
        [-58.0,  29.0],
        [-34.0,  44.0],
        [-8.0,   40.0],
        [+12.0,  32.0],
        [+38.0,  26.0],
        [+56.0,  39.0],
        [+72.0,  38.0],
    ], dtype=np.float32), 30)

    # Path 2: Bridge East (+12, +32) -> winding mountain path -> Valley Cave Entrance (+24, -2)
    p2 = _catmull_rom_chain(np.array([
        [+12.0, 32.0],
        [+22.0, 21.0],
        [+19.0, 9.0],
        [+24.0, -2.0],
    ], dtype=np.float32), 25)

    # Path 3: Village Trail (-34, +44) -> winding coastal ridge -> Southern Lighthouse (-12, +114)
    p3 = _catmull_rom_chain(np.array([
        [-34.0, 44.0],
        [-42.0, 68.0],
        [-28.0, 92.0],
        [-12.0, 114.0],
    ], dtype=np.float32), 25)

    # Path 4: Scenic overlook trail to Emerald Plunge Lagoon (-6, -6)
    p4 = _catmull_rom_chain(np.array([
        [+18.0, 20.0],
        [+4.0,  6.0],
        [-5.0,  -6.0],
    ], dtype=np.float32), 20)

    return [p1, p2, p3, p4]


def build_heightfield(n_xz: int = 360) -> dict[str, np.ndarray]:
    """
    Construct the 2D base heightfield H(x, z) with mountains, coastal bays, cliffs,
    carved continuous river + waterfall amphitheater, and flat landmark pads.
    """
    xs = np.linspace(X_MIN, X_MAX, n_xz, dtype=np.float32)
    zs = np.linspace(Z_MIN, Z_MAX, n_xz, dtype=np.float32)
    xx, zz = np.meshgrid(xs, zs)

    r = np.sqrt(xx * xx + zz * zz)
    theta = np.arctan2(zz, xx)

    # Organic island coastline radius (120m .. 146m) with Western cove indentation & Eastern headland
    coast_r = (
        130.0
        + 12.0 * np.cos(2.0 * theta - 0.6)
        + 9.0 * np.sin(3.0 * theta + 1.1)
        + 6.5 * np.cos(5.0 * theta + 0.4)
        - 14.0 * np.exp(-(((theta - 2.90) / 0.42) ** 2))  # Western sandy crescent bay
        - 14.0 * np.exp(-(((theta + 3.38) / 0.42) ** 2))  # Wrap around -pi/+pi
        + 10.0 * np.exp(-(((theta + 0.28) / 0.35) ** 2))  # Eastern cave cliff headland
        + 11.0 * np.exp(-(((theta - 1.68) / 0.30) ** 2))  # Southern lighthouse promontory
    )
    noise_macro = _fbm_2d(xx, zz, seed=101, octaves=5, base_freq=0.008)
    noise_detail = _fbm_2d(xx, zz, seed=202, octaves=5, base_freq=0.026)
    noise_ridge = 1.0 - np.abs(_fbm_2d(xx, zz, seed=303, octaves=4, base_freq=0.014))

    coast_r += 11.0 * noise_macro

    # Base island dome rising from -10.5m seabed to +18m rolling interior
    norm_r = r / np.maximum(coast_r, 40.0)
    # Underwater coral shelf -> beach -> interior
    H = np.full_like(xx, -10.5, dtype=np.float32)
    land_profile = 24.0 * np.clip(1.0 - norm_r * norm_r, -0.45, 1.0)
    H = np.maximum(H, land_profile + 5.5 * noise_macro + 2.2 * noise_detail)

    # Smooth outer seabed falloff near domain boundaries so mesh closes cleanly under water
    edge_fade = 1.0 - _smoothstep(145.0, 174.0, np.maximum(np.abs(xx), np.abs(zz)))
    H = -10.5 + (H + 10.5) * edge_fade

    # Gentle Western Crescent Beach slope around (-95, +22)
    d_west_bay = np.sqrt(((xx + 98.0) / 42.0) ** 2 + ((zz - 22.0) / 48.0) ** 2)
    west_calm = np.exp(-(d_west_bay ** 2))
    target_beach = 4.2 * np.clip(1.0 - (r - 82.0) / 40.0, -0.8, 1.4)
    H = (1.0 - 0.72 * west_calm) * H + (0.72 * west_calm) * target_beach

    # 1. Main North-Central Volcanic/Limestone Peak (+4, -68) -> ~82m tall!
    d_peak = np.sqrt(((xx - 4.0) / 54.0) ** 2 + ((zz + 68.0) / 48.0) ** 2)
    peak_h = 68.0 * np.exp(-(d_peak ** 1.65)) * (0.82 + 0.35 * noise_ridge)
    H += peak_h

    # 2. Massive North-East Cave Massif (+58, -32) -> ~58m tall mountain housing our Giant Crystal Cavern!
    d_cave_mtn = np.sqrt(((xx - 58.0) / 52.0) ** 2 + ((zz + 32.0) / 42.0) ** 2)
    H += 44.0 * np.exp(-(d_cave_mtn ** 1.80)) * (0.85 + 0.22 * noise_ridge)

    # Steep cliff wall right behind Valley Cave Entrance (+27, -5) so cave mouth is a dramatic vertical rock arch!
    cave_cliff_step = _smoothstep(-10.0, +8.0, (xx - 24.0) * 0.65 - (zz + 4.0) * 0.76)
    near_cave_mouth = np.exp(-(((xx - 30.0) / 26.0) ** 2 + ((zz + 6.0) / 24.0) ** 2))
    H = (1.0 - 0.65 * near_cave_mouth) * H + (0.65 * near_cave_mouth) * (13.8 + 30.0 * cave_cliff_step)

    # Steep Eastern Sea Cliff at (+114, -34) dropping sharply into -6.5m ocean right outside X=+120!
    near_east_cliff = np.exp(-(((xx - 114.0) / 24.0) ** 2 + ((zz + 34.0) / 28.0) ** 2))
    east_cliff_profile = -6.5 + 41.0 * _smoothstep(121.0, 96.0, xx)
    H = (1.0 - 0.82 * near_east_cliff) * H + (0.82 * near_east_cliff) * east_cliff_profile

    # 3. High Mountain Spring Shelf at (-38, -56) around Y = +43m, dropping steeply south of Z = -24.5 for Waterfall!
    d_spring = np.sqrt(((xx + 38.0) / 24.0) ** 2 + ((zz + 46.0) / 28.0) ** 2)
    spring_shelf = np.exp(-(d_spring ** 2))
    H = (1.0 - 0.65 * spring_shelf) * H + (0.65 * spring_shelf) * 43.5

    # Waterfall cliff amphitheater between Z = -25 (Y~40m) and Z = -13 (Y~14m) around X = -22
    near_wf = np.exp(-(((xx + 22.0) / 22.0) ** 2 + ((zz + 19.0) / 14.0) ** 2))
    wf_step = 14.5 + 25.5 * _smoothstep(-13.5, -24.5, zz)
    H = (1.0 - 0.85 * near_wf) * H + (0.85 * near_wf) * wf_step

    # 4. Eastern Ancient Temple Plateau (+72, +38) at Y = +30.5m
    d_ruins = np.sqrt((xx - 72.0) ** 2 + (zz - 38.0) ** 2)
    H += 16.0 * np.exp(-((d_ruins / 34.0) ** 2))
    ruins_flat = 1.0 - _smoothstep(11.0, 21.0, d_ruins)
    H = (1.0 - 0.88 * ruins_flat) * H + (0.88 * ruins_flat) * 30.5

    # 5. Southern Lighthouse Promontory (-12, +114) at Y = +25.0m
    d_lh = np.sqrt((xx + 12.0) ** 2 + (zz - 114.0) ** 2)
    H += 18.0 * np.exp(-((d_lh / 24.0) ** 2))
    lh_flat = 1.0 - _smoothstep(6.5, 14.0, d_lh)
    H = (1.0 - 0.88 * lh_flat) * H + (0.88 * lh_flat) * 25.0

    # 6. Carve Continuous River Valley, Plunge Lagoon & Stream Bed!
    river_def = get_river_definition()
    all_river = np.vstack([river_def["upper"], river_def["lower"]])  # (M, 4): x, wy, z, half_w

    # Vectorized nearest-point query from (n_xz, n_xz) grid to river polyline
    rx = all_river[:, 0][None, None, :]
    rw_y = all_river[:, 1][None, None, :]
    rz = all_river[:, 2][None, None, :]
    rhw = all_river[:, 3][None, None, :]

    dist_sq = (xx[:, :, None] - rx) ** 2 + (zz[:, :, None] - rz) ** 2
    idx_min = np.argmin(dist_sq, axis=2)
    min_dist = np.sqrt(np.take_along_axis(dist_sq, idx_min[:, :, None], axis=2)[:, :, 0])
    nearest_wy = all_river[:, 1][idx_min]
    nearest_hw = all_river[:, 3][idx_min]

    # Do not pull down the waterfall cliff face itself via lower-river valley blending!
    # Mask out lower-river influence north of Z=-21 when near waterfall cliff
    valley_blend = 1.0 - _smoothstep(nearest_hw * 0.9, nearest_hw + 22.0, min_dist)
    # Protect waterfall upper rim from lower pool pull
    wf_rim_protect = _smoothstep(-18.0, -24.0, zz) * np.exp(-(((xx + 23.0) / 18.0) ** 2))
    valley_target_y = np.where(wf_rim_protect > 0.4, np.maximum(nearest_wy, 38.2), nearest_wy)

    # Gently lower surrounding terrain into a natural river valley so water never floats above banks!
    bank_margin = 1.2 + 2.8 * _smoothstep(nearest_hw, nearest_hw + 20.0, min_dist)
    H = np.where(
        valley_blend > 0.01,
        (1.0 - 0.82 * valley_blend) * H + (0.82 * valley_blend) * np.minimum(H, valley_target_y + bank_margin),
        H,
    )

    # Carve the submerged river channel & plunge lagoon bed below water_y!
    channel_factor = np.clip(1.0 - (min_dist / np.maximum(nearest_hw, 1.0)) ** 2, 0.0, 1.0)
    carve_depth = 2.6 + 1.4 * _smoothstep(7.0, 13.0, nearest_hw)
    bed_y = valley_target_y - carve_depth * channel_factor
    in_channel = _smoothstep(nearest_hw + 1.8, nearest_hw * 0.75, min_dist)
    H = (1.0 - in_channel) * H + in_channel * np.minimum(H, bed_y)

    # Flat terrace & gentle valley pass leading from Bridge East (+12, +32) to Valley Cave Entrance (+23, +1) at Y ~ 15.5m!
    cave_approach_pts = np.array([[12.0, 32.0], [17.0, 21.0], [21.0, 10.0], [23.5, 0.5]], dtype=np.float32)
    ca_d2 = (xx[:, :, None] - cave_approach_pts[:, 0][None, None, :]) ** 2 + (zz[:, :, None] - cave_approach_pts[:, 1][None, None, :]) ** 2
    ca_dist = np.sqrt(np.min(ca_d2, axis=2))
    cave_pass = 1.0 - _smoothstep(6.5, 16.5, ca_dist)
    H = (1.0 - 0.86 * cave_pass) * H + (0.86 * cave_pass) * 15.6

    # Compute trail mask for texture baking & tree exclusion
    trail_mask = np.zeros_like(H, dtype=np.float32)
    for poly in get_trails_polylines():
        td2 = (xx[:, :, None] - poly[:, 0][None, None, :]) ** 2 + (zz[:, :, None] - poly[:, 1][None, None, :]) ** 2
        td = np.sqrt(np.min(td2, axis=2))
        trail_mask = np.maximum(trail_mask, 1.0 - _smoothstep(1.8, 4.2, td))
    # Also mark Ancient Ruins plaza & Lighthouse pad on trail/stone mask
    trail_mask = np.maximum(trail_mask, 1.0 - _smoothstep(11.0, 16.0, d_ruins))
    trail_mask = np.maximum(trail_mask, 1.0 - _smoothstep(5.5, 9.0, d_lh))

    # Cave mouth rocky mask (for seamless rock texture transition around Valley Cave, Cenote & Sea Cave)
    d_cenote_2d = np.sqrt((xx - 60.0) ** 2 + (zz + 33.0) ** 2)
    d_seacave_2d = np.sqrt((xx - 114.0) ** 2 + (zz + 34.0) ** 2)
    d_valcave_2d = np.sqrt((xx - 27.0) ** 2 + (zz + 5.0) ** 2)
    cave_mouth_mask = np.maximum.reduce([
        1.0 - _smoothstep(10.0, 18.0, d_cenote_2d),
        1.0 - _smoothstep(12.0, 22.0, d_seacave_2d),
        1.0 - _smoothstep(10.0, 19.0, d_valcave_2d),
    ])

    return {
        "xs": xs,
        "zs": zs,
        "xx": xx,
        "zz": zz,
        "H": H,
        "river_dist": min_dist,
        "river_wy": valley_target_y,
        "river_hw": nearest_hw,
        "trail_mask": trail_mask,
        "cave_mouth_mask": cave_mouth_mask,
        "river_def": river_def,
    }


def _capsule_sdf(px: np.ndarray, py: np.ndarray, pz: np.ndarray, a: tuple, b: tuple, r_xz: float, r_y: float) -> np.ndarray:
    """Ellipsoidal-cross-section capsule SDF (< 0 inside tunnel)."""
    ax, ay, az = a
    bx, by, bz = b
    abx, aby, abz = bx - ax, by - ay, bz - az
    apx, apy, apz = px - ax, py - ay, pz - az
    ab2 = abx * abx + aby * aby + abz * abz + 1e-8
    t = np.clip((apx * abx + apy * aby + apz * abz) / ab2, 0.0, 1.0)
    dx = (apx - t * abx) / r_xz
    dy = (apy - t * aby) / r_y
    dz = (apz - t * abz) / r_xz
    # Flat-bottomed natural cave floor bias: make bottom slightly flatter so it's walkable!
    dy_mod = np.where(dy < 0.0, dy * 1.38, dy)
    return (np.sqrt(dx * dx + dy_mod * dy_mod + dz * dz) - 1.0) * min(r_xz, r_y)


def _smin(a: np.ndarray, b: np.ndarray, k: float = 3.5) -> np.ndarray:
    """Smooth polynomial union of two SDFs (<0 inside)."""
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return (1.0 - h) * b + h * a - k * h * (1.0 - h)


def evaluate_cave_void_sdf(px: np.ndarray, py: np.ndarray, pz: np.ndarray) -> np.ndarray:
    """
    Evaluate 3D Signed Distance Field of ALL hollow caves, cenote & coastal rock arch!
    Returns cave_sdf < 0 inside hollowed-out cave air, > 0 in solid rock.
    Works on both 3D voxel grids and 1D vertex coordinate arrays!
    """
    # 1. Valley Cave Entrance Tunnel: flush with Y=15.6m exterior plaza!
    #    With r_y=6.8 and flat-bottom factor 1.38, floor is cy - 6.8/1.38 = cy - 4.93m -> cy=20.6 gives floor Y=15.67m, roof Y=27.4m!
    t1 = _capsule_sdf(px, py, pz, (19.0, 20.6, 3.5), (37.0, 17.5, -13.0), r_xz=8.2, r_y=6.8)
    t2 = _capsule_sdf(px, py, pz, (37.0, 17.5, -13.0), (55.0, 9.5, -28.0), r_xz=9.0, r_y=7.8)

    # 2. Colossal Subterranean Crystal & Lagoon Domed Cavern centered at (+58, +9.5, -32)
    # Spans ~44m wide, floor dips below Y=0 for glowing underground lagoon, domed ceiling up to Y=+28m!
    cx = (px - 58.0) / 22.0
    cz = (pz + 32.0) / 20.0
    cy = np.where(py >= 6.0, (py - 6.0) / 21.5, (py - 6.0) / 8.8)  # Floor down to Y = -2.8m (lagoon bed!)
    cavern = (np.sqrt(cx * cx + cy * cy + cz * cz) - 1.0) * 14.0

    cave_void = _smin(_smin(t1, t2, k=3.5), cavern, k=4.5)

    # 3. Natural Cenote Skylight shaft punching all the way up through mountain shoulder (+60, Y=18..98, -33) to open sky!
    cenote = _capsule_sdf(px, py, pz, (60.0, 18.0, -33.0), (60.0, 98.0, -33.0), r_xz=7.6, r_y=14.0)
    cave_void = _smin(cave_void, cenote, k=3.8)

    # 4. Grand Coastal Sea-Cave Tunnel from Cavern Lagoon (+62, +3.5, -32) straight East through cliff (+130, +3.5, -34)!
    # Floor goes down to Y = -2.8m so ocean water (Y=0) flows continuously into the cavern!
    sea_tunnel = _capsule_sdf(px, py, pz, (60.0, 3.8, -32.0), (132.0, 3.8, -34.5), r_xz=8.6, r_y=7.6)
    cave_void = _smin(cave_void, sea_tunnel, k=4.0)

    # Add organic 3D rock wall roughness inside caves so walls & arches look naturally sculpted!
    rough = (
        1.15 * np.sin(0.21 * px + 0.17 * py) * np.cos(0.19 * pz - 0.13 * py)
        + 0.65 * np.cos(0.43 * px - 0.37 * pz + 0.29 * py)
    )
    cave_void = cave_void + rough

    return cave_void


def evaluate_sea_arch_addition_sdf(px: np.ndarray, py: np.ndarray, pz: np.ndarray) -> np.ndarray:
    """
    Create a dramatic standalone Natural Coastal Rock Arch off the Southern Lighthouse Headland
    around (-14, Y, +132)! Returns solid_sdf < 0 inside arch rock.
    """
    # Outer rock bridge ridge from headland (-12, +118) out to sea stack (-16, +144)
    ridge = _capsule_sdf(px, py, pz, (-12.0, 6.0, 118.0), (-16.0, 5.0, 143.0), r_xz=7.2, r_y=12.5)
    # Hollow wave tunnel punching East-West right through the middle at (-14, +2.5, +131)!
    hole = _capsule_sdf(px, py, pz, (-30.0, 2.2, 131.0), (+2.0, 2.2, 131.0), r_xz=6.8, r_y=7.2)
    rough = 0.8 * np.sin(0.28 * px + 0.22 * pz) * np.cos(0.25 * py)
    arch_solid = np.maximum(ridge + rough, -(hole - 0.5))
    return arch_solid


def taubin_smooth(verts: np.ndarray, faces: np.ndarray, iterations: int = 2, lam: float = 0.45, mu: float = -0.47) -> np.ndarray:
    """Fast vectorized volume-preserving Taubin mesh smoothing to remove voxel stair-stepping."""
    v = verts.copy()
    n_verts = len(v)
    # Directed edges from triangle faces
    i0, i1, i2 = faces[:, 0], faces[:, 1], faces[:, 2]
    src = np.concatenate([i0, i1, i1, i2, i2, i0])
    dst = np.concatenate([i1, i0, i2, i1, i0, i2])
    deg = np.bincount(src, minlength=n_verts).astype(np.float32)[:, None]
    deg = np.maximum(deg, 1.0)

    # Pin outer domain boundary vertices so edges stay crisp
    boundary = (np.abs(v[:, 0]) > 178.5) | (np.abs(v[:, 2]) > 178.5) | (v[:, 1] < -11.2)

    for _ in range(iterations):
        for factor in (lam, mu):
            acc = np.zeros_like(v)
            np.add.at(acc, src, v[dst])
            avg = acc / deg
            delta = avg - v
            v[~boundary] += factor * delta[~boundary]
    return v


def compute_vertex_normals(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    v0 = verts[faces[:, 0]]
    v1 = verts[faces[:, 1]]
    v2 = verts[faces[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    vn = np.zeros_like(verts)
    np.add.at(vn, faces[:, 0], fn)
    np.add.at(vn, faces[:, 1], fn)
    np.add.at(vn, faces[:, 2], fn)
    lens = np.linalg.norm(vn, axis=1, keepdims=True)
    vn = np.where(lens > 1e-10, vn / np.maximum(lens, 1e-10), np.array([[0.0, 1.0, 0.0]], dtype=np.float32))
    return vn.astype(np.float32)


def _box_project_mesh(verts: np.ndarray, normals: np.ndarray, colors: np.ndarray, faces: np.ndarray, tile_m: float = 14.0):
    """
    Duplicate seam vertices per dominant face normal axis so box/cube UV projection has ZERO stretching
    and ZERO distorted cross-axis triangle interpolation on vertical cave walls, ceilings & sea arches!
    """
    v0 = verts[faces[:, 0]]
    v1 = verts[faces[:, 1]]
    v2 = verts[faces[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    abs_fn = np.abs(fn)
    dom_axis = np.argmax(abs_fn, axis=1)  # 0: X-wall, 1: Y-floor/ceiling, 2: Z-wall

    out_v, out_n, out_uv, out_c, out_f = [], [], [], [], []
    v_offset = 0

    for axis in (0, 1, 2):
        f_sub = faces[dom_axis == axis]
        if len(f_sub) == 0:
            continue
        unique_idx, inv = np.unique(f_sub, return_inverse=True)
        sv = verts[unique_idx]
        sn = normals[unique_idx]
        sc = colors[unique_idx]
        sf = inv.reshape(-1, 3) + v_offset

        if axis == 0:
            uv = np.stack([sv[:, 2] / tile_m, -sv[:, 1] / tile_m], axis=1)
        elif axis == 1:
            uv = np.stack([sv[:, 0] / tile_m, sv[:, 2] / tile_m], axis=1)
        else:
            uv = np.stack([sv[:, 0] / tile_m, -sv[:, 1] / tile_m], axis=1)

        out_v.append(sv)
        out_n.append(sn)
        out_uv.append(uv.astype(np.float32))
        out_c.append(sc)
        out_f.append(sf.astype(np.uint32))
        v_offset += len(sv)

    return (
        np.vstack(out_v),
        np.vstack(out_n),
        np.vstack(out_uv),
        np.vstack(out_c),
        np.vstack(out_f),
    )


def build_island_and_cave_meshes(hf: dict[str, np.ndarray]) -> dict[str, dict]:
    """
    Build the full 3D Volumetric SDF of the giant island + hollow caves + cenote + coastal sea arch,
    extract manifold mesh via Marching Cubes, smooth, simplify, and split cleanly into:
      - exterior_terrain: UV-wrapped [0,1]^2 to 2048x2048 Master Island Image
      - cave_and_cliffs: Cube-UV-wrapped to 1024x1024 Seamless Cave/Cliff Rock Image
    """
    H = hf["H"]
    n_xz = H.shape[0]
    y_min, y_max = -12.0, 108.0
    n_y = 130

    xs = hf["xs"]
    ys = np.linspace(y_min, y_max, n_y, dtype=np.float32)
    zs = hf["zs"]

    # Build 3D SDF grid of shape (n_x, n_y, n_z) so marching_cubes vertex axes are directly (x, y, z)!
    # Note: H has shape (n_z, n_x) -> H.T has shape (n_x, n_z)
    H_xz = H.T[:, None, :]  # (n_x, 1, n_z)
    px = xs[:, None, None]
    py = ys[None, :, None]
    pz = zs[None, None, :]

    # Base terrain solid SDF (< 0 inside earth, > 0 in air)
    sdf = py - H_xz

    # Add Southern Coastal Sea Rock Arch solid
    # Evaluate only in bounding sub-box around (-14, Y, +131) for blazing speed!
    ix_arch = np.where((xs >= -34.0) & (xs <= +8.0))[0]
    iz_arch = np.where((zs >= 112.0) & (zs <= 152.0))[0]
    if len(ix_arch) > 0 and len(iz_arch) > 0:
        sl_x = slice(ix_arch[0], ix_arch[-1] + 1)
        sl_z = slice(iz_arch[0], iz_arch[-1] + 1)
        arch_sdf = evaluate_sea_arch_addition_sdf(px[sl_x, :, :], py, pz[:, :, sl_z])
        sdf[sl_x, :, sl_z] = _smin(sdf[sl_x, :, sl_z], arch_sdf, k=2.5)

    # Carve Giant Cave System (Valley Cave + Crystal Cavern + Cenote + Sea-Cave Tunnel)
    # Sub-box X in [+6, +138], Z in [-62, +18]
    ix_cave = np.where((xs >= 6.0) & (xs <= 138.0))[0]
    iz_cave = np.where((zs >= -62.0) & (zs <= 18.0))[0]
    sl_cx = slice(ix_cave[0], ix_cave[-1] + 1)
    sl_cz = slice(iz_cave[0], iz_cave[-1] + 1)
    cave_void = evaluate_cave_void_sdf(px[sl_cx, :, :], py, pz[:, :, sl_cz])
    # Smoothly subtract cave_void from solid earth: solid_new = smooth_max(sdf, -cave_void)
    sdf[sl_cx, :, sl_cz] = -_smin(-sdf[sl_cx, :, sl_cz], cave_void, k=1.8)

    # Close bottom of volume at y_min + 0.8 so mesh has a clean seabed bottom if needed (optional, keep open bottom to save 120k unseen underground faces!)
    # Actually keeping y > -11.5 open at bottom saves 50% wasted faces underneath the seabed!

    dx = (X_MAX - X_MIN) / (n_xz - 1)
    dy = (y_max - y_min) / (n_y - 1)
    dz = (Z_MAX - Z_MIN) / (n_xz - 1)

    verts, faces, _, _ = marching_cubes(sdf, level=0.0, spacing=(dx, dy, dz))
    verts[:, 0] += X_MIN
    verts[:, 1] += y_min
    verts[:, 2] += Z_MIN
    verts = verts.astype(np.float32)
    faces = faces.astype(np.int32)

    # Verify outward CCW winding (average ny on top terrain should be strongly positive!)
    v0, v1, v2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    if np.sum(fn[:, 1]) < 0:
        faces = faces[:, [0, 2, 1]]

    # Smooth out voxel stair-stepping with volume-preserving Taubin smoothing!
    verts = taubin_smooth(verts, faces, iterations=3, lam=0.46, mu=-0.48)

    # Quadric mesh simplification to ~95,000 crisp triangles!
    target_tris = 160000  # island is exported 1.4x bigger -> keep tri density
    if len(faces) > target_tris:
        reduction = float(np.clip(1.0 - (target_tris / len(faces)), 0.1, 0.88))
        verts_s, faces_s = fast_simplification.simplify(verts, faces, target_reduction=reduction, agg=7)
        verts = verts_s.astype(np.float32)
        faces = faces_s.astype(np.int32)

    normals = compute_vertex_normals(verts, faces)

    # Evaluate surface height H(vx, vz) at every vertex to detect underground cave & overhang vertices
    u_v = np.clip((verts[:, 0] - X_MIN) / WORLD_SIZE, 0.0, 1.0)
    v_v = np.clip((verts[:, 2] - Z_MIN) / WORLD_SIZE, 0.0, 1.0)
    ix_v = np.clip((u_v * (n_xz - 1)).astype(np.int32), 0, n_xz - 1)
    iz_v = np.clip((v_v * (n_xz - 1)).astype(np.int32), 0, n_xz - 1)
    h_surf = H[iz_v, ix_v]

    depth_below_top = np.maximum(h_surf - verts[:, 1], 0.0)
    cave_sdf_v = evaluate_cave_void_sdf(verts[:, 0], verts[:, 1], verts[:, 2])

    # Smooth vertex ambient occlusion / atmospheric cave tint in COLOR_0 (RGBA float32 -> uint8)
    # Keep cave interior >= 0.62 brightness so cave rock texture & details stay vivid in all GLB viewers!
    cave_ness = _smoothstep(1.5, 9.0, depth_below_top) * _smoothstep(3.5, -1.5, cave_sdf_v)
    # Slight cool mineral cyan-blue bounce near underground lagoon & crystals
    r_c = 1.0 - 0.34 * cave_ness
    g_c = 1.0 - 0.26 * cave_ness
    b_c = 1.0 - 0.18 * cave_ness
    v_colors = np.stack([r_c, g_c, b_c, np.ones_like(r_c)], axis=1).astype(np.float32)

    # Classify triangles:
    # Cave interior, cenote shaft, sea-arch underbelly, or near-vertical rocky cliff -> Cube-Projected Rock
    tri_centers = (verts[faces[:, 0]] + verts[faces[:, 1]] + verts[faces[:, 2]]) / 3.0
    tri_normals = normals[faces[:, 0]] + normals[faces[:, 1]] + normals[faces[:, 2]]
    tri_normals /= np.maximum(np.linalg.norm(tri_normals, axis=1, keepdims=True), 1e-8)

    tc_ix = np.clip(((tri_centers[:, 0] - X_MIN) / WORLD_SIZE * (n_xz - 1)).astype(np.int32), 0, n_xz - 1)
    tc_iz = np.clip(((tri_centers[:, 2] - Z_MIN) / WORLD_SIZE * (n_xz - 1)).astype(np.int32), 0, n_xz - 1)
    tc_h = H[tc_iz, tc_ix]
    tc_cave_sdf = evaluate_cave_void_sdf(tri_centers[:, 0], tri_centers[:, 1], tri_centers[:, 2])

    in_sea_arch_zone = (
        (tri_centers[:, 0] > -30.0) & (tri_centers[:, 0] < 4.0)
        & (tri_centers[:, 2] > 119.0) & (tri_centers[:, 2] < 146.0)
        & (tri_centers[:, 1] > -4.0)
    )
    is_cave_or_overhang = (
        ((tc_h - tri_centers[:, 1] > 2.2) & (tc_cave_sdf < 3.0))
        | ((tri_normals[:, 1] < 0.52) & (tri_centers[:, 1] > 4.5))  # Steep cliffs (>58 deg) & overhangs get crisp Cube-Projected Rock!
        | (tri_normals[:, 1] < 0.15)
        | in_sea_arch_zone
    )

    ext_faces = faces[~is_cave_or_overhang]
    cave_faces = faces[is_cave_or_overhang]

    # Pack Exterior Terrain submesh with clean [0, 1]^2 UVs mapped to 2048x2048 Master Island Wrap Image
    ext_u_idx, ext_inv = np.unique(ext_faces, return_inverse=True)
    ext_v = verts[ext_u_idx]
    ext_n = normals[ext_u_idx]
    ext_c = v_colors[ext_u_idx]
    ext_uv = np.stack([
        np.clip((ext_v[:, 0] - X_MIN) / WORLD_SIZE, 0.0, 1.0),
        np.clip((ext_v[:, 2] - Z_MIN) / WORLD_SIZE, 0.0, 1.0),
    ], axis=1).astype(np.float32)
    ext_f = ext_inv.reshape(-1, 3).astype(np.uint32)

    # Pack Cave & Overhang Cliff submesh with zero-stretch Cube Projection UVs
    cv_v, cv_n, cv_uv, cv_c, cv_f = _box_project_mesh(verts, normals, v_colors, cave_faces, tile_m=13.5)

    return {
        "exterior_terrain": {
            "verts": ext_v,
            "normals": ext_n,
            "uvs": ext_uv,
            "colors": ext_c,
            "faces": ext_f,
        },
        "cave_and_cliffs": {
            "verts": cv_v,
            "normals": cv_n,
            "uvs": cv_uv,
            "colors": cv_c,
            "faces": cv_f,
        },
    }


def sample_height(hf: dict[str, np.ndarray], x: float, z: float) -> float:
    """Bilinearly sample terrain surface elevation H(x, z)."""
    H = hf["H"]
    n = H.shape[0]
    fx = np.clip((x - X_MIN) / WORLD_SIZE * (n - 1), 0.0, n - 1.001)
    fz = np.clip((z - Z_MIN) / WORLD_SIZE * (n - 1), 0.0, n - 1.001)
    x0, z0 = int(fx), int(fz)
    wx, wz = fx - x0, fz - z0
    h00 = H[z0, x0]
    h10 = H[z0, x0 + 1]
    h01 = H[z0 + 1, x0]
    h11 = H[z0 + 1, x0 + 1]
    return float((1.0 - wz) * ((1.0 - wx) * h00 + wx * h10) + wz * ((1.0 - wx) * h01 + wx * h11))


if __name__ == "__main__":
    import time
    t0 = time.time()
    hf = build_heightfield(360)
    meshes = build_island_and_cave_meshes(hf)
    dt = time.time() - t0
    print(f"Built terrain & cave in {dt:.2f}s:")
    for k, m in meshes.items():
        print(f"  {k}: {len(m['verts'])} verts, {len(m['faces'])} tris")
