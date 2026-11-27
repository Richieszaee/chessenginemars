import os
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, sobel


RAW_DIR = os.path.join(os.path.dirname(__file__), "textures_raw")
OUT_DIR = os.path.join(os.path.dirname(__file__), "textures_processed")


def _smoothstep(edge0, edge1, x: np.ndarray) -> np.ndarray:
    diff = edge1 - edge0
    denom = np.where(np.abs(diff) < 1e-6, 1e-6, diff)
    t = np.clip((x - edge0) / denom, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def make_seamless_square(img: Image.Image, size: int = 1024, equalize_sigma: float = 140.0) -> np.ndarray:
    """
    Convert an input RGB image into a 100% toroidal seamless (size x size x 3) uint8 texture
    without aspect-ratio squishing or interior seam artifacts.
    """
    img = img.convert("RGB")
    w, h = img.size

    # If rectangular (e.g. 1376x768), blend two square crops along width to preserve 1:1 aspect ratio
    if abs(w - h) > 8:
        side = min(w, h)
        if w > h:
            left = np.asarray(img.crop((0, 0, side, side)), dtype=np.float32)
            right = np.asarray(img.crop((w - side, 0, w, side)), dtype=np.float32)
            alpha = np.linspace(0.0, 1.0, side, dtype=np.float32)[None, :, None]
            alpha = _smoothstep(0.25, 0.75, alpha)
            arr = (1.0 - alpha) * left + alpha * right
        else:
            top = np.asarray(img.crop((0, 0, side, side)), dtype=np.float32)
            bot = np.asarray(img.crop((0, h - side, side, h)), dtype=np.float32)
            alpha = np.linspace(0.0, 1.0, side, dtype=np.float32)[:, None, None]
            alpha = _smoothstep(0.25, 0.75, alpha)
            arr = (1.0 - alpha) * top + alpha * bot
        sq_img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    else:
        sq_img = img

    if sq_img.size != (size, size):
        sq_img = sq_img.resize((size, size), Image.Resampling.LANCZOS)

    arr = np.asarray(sq_img, dtype=np.float32)

    # Gentle low-frequency illumination equalization so tiling has no light/dark macro grid
    if equalize_sigma > 0:
        lum = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
        low = gaussian_filter(lum, sigma=equalize_sigma, mode="reflect")
        mean_lum = max(float(np.mean(lum)), 1.0)
        scale = np.clip(mean_lum / np.maximum(low, 12.0), 0.72, 1.35)
        arr = np.clip(arr * (0.35 + 0.65 * scale[:, :, None]), 0.0, 255.0)

    # Two-pass 1D toroidal seamless synthesis (Pass 1: X, Pass 2: Y)
    t = np.linspace(0.0, 1.0, size, endpoint=False, dtype=np.float32)
    # dist_center is 0 at t=0.5, and 0.5 at t=0 or t=1
    dist_center = np.abs(t - 0.5)
    # Weight is 1 near center [0.32..0.68] (uses unshifted image) and 0 near outer borders (uses rolled image)
    w1d = 1.0 - _smoothstep(0.16, 0.34, dist_center)

    # Pass 1: X seamless
    bx = np.roll(arr, size // 2, axis=1)
    wx = w1d[None, :, None]
    ax = (1.0 - wx) * bx + wx * arr

    # Pass 2: Y seamless
    bxy = np.roll(ax, size // 2, axis=0)
    wy = w1d[:, None, None]
    out = (1.0 - wy) * bxy + wy * ax

    return np.clip(out, 0, 255).astype(np.uint8)


def generate_normal_map(rgb: np.ndarray, strength: float = 2.6, blur_sigma: float = 0.6) -> np.ndarray:
    """Create a seamless tangent-space normal map (uint8 RGB) from an RGB albedo array."""
    gray = (0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]) / 255.0
    if blur_sigma > 0:
        gray = gaussian_filter(gray, sigma=blur_sigma, mode="wrap")
    dx = sobel(gray, axis=1, mode="wrap") * strength
    dy = sobel(gray, axis=0, mode="wrap") * strength
    nz = np.ones_like(gray)
    norm = np.sqrt(dx * dx + dy * dy + nz * nz) + 1e-8
    nx = -dx / norm
    ny = -dy / norm
    nz = nz / norm
    out = np.stack([(nx * 0.5 + 0.5) * 255.0, (ny * 0.5 + 0.5) * 255.0, (nz * 0.5 + 0.5) * 255.0], axis=-1)
    return np.clip(out, 0, 255).astype(np.uint8)


def make_crystal_texture(size: int = 512) -> np.ndarray:
    """Create a rich faceted glowing cyan-violet-emerald crystal texture."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    stripes = 0.5 + 0.5 * np.sin(2.0 * np.pi * (x * 7.0 + 0.15 * np.sin(2.0 * np.pi * y * 3.0)))
    facets = np.abs(np.sin(np.pi * (x * 11.0 - y * 5.0))) * 0.45 + np.abs(np.cos(np.pi * (x * 5.0 + y * 9.0))) * 0.55
    glow = np.clip(0.45 + 0.55 * (0.5 * stripes + 0.5 * facets), 0.0, 1.0)
    # Gradient along Y (v=0 base violet-blue -> v=1 bright cyan-aqua tip)
    r = np.clip((0.18 * (1.0 - y) + 0.32 * (glow ** 2.2)) * 255.0, 0, 255)
    g = np.clip((0.68 * y + 0.35 * (1.0 - y) + 0.35 * glow) * 255.0, 0, 255)
    b = np.clip((0.88 + 0.12 * glow) * 255.0, 0, 255)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def make_fire_lantern_texture(size: int = 256) -> np.ndarray:
    """Create a warm golden-amber lantern/campfire glow texture."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    flicker = 0.5 + 0.5 * np.sin(2.0 * np.pi * x * 5.0) * np.cos(2.0 * np.pi * y * 4.0)
    core = np.clip(1.0 - 0.7 * np.abs(y - 0.5), 0.2, 1.0)
    r = np.full_like(x, 255.0)
    g = np.clip((155.0 + 85.0 * core * flicker), 0, 255)
    b = np.clip((35.0 + 110.0 * (core ** 2.0) * flicker), 0, 255)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def make_leaf_card_texture(size: int = 1024) -> np.ndarray:
    """RGBA cutout card of ~115 individually shaded leaves on transparent background (for alpha-MASK foliage cards)."""
    from PIL import ImageDraw

    ss = size * 2  # draw at 2x then downscale for free anti-aliased leaf edges
    rng = np.random.default_rng(777)
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    palette = np.array([
        [58, 126, 44], [78, 152, 52], [98, 172, 60], [44, 104, 38],
        [122, 186, 70], [146, 196, 78], [168, 204, 88], [88, 140, 46],
    ], dtype=np.float32)

    cx0, cy0 = 0.50 * ss, 0.52 * ss
    n_pts = 12
    for _ in range(115):
        lx = float(np.clip(cx0 + rng.normal(0.0, 0.27 * ss), 0.03 * ss, 0.97 * ss))
        ly = float(np.clip(cy0 + rng.normal(0.0, 0.27 * ss), 0.03 * ss, 0.97 * ss))
        ang = float(rng.uniform(0.0, 2.0 * np.pi))
        L = float(rng.uniform(0.09, 0.21)) * ss
        W = L * float(rng.uniform(0.26, 0.36))
        col = palette[int(rng.integers(0, len(palette)))].copy()
        col *= float(np.interp(ly / ss, [0.0, 1.0], [1.16, 0.80]))  # sunlit top / shaded bottom
        col = np.clip(col, 30.0, 240.0)
        curve = float(rng.uniform(-0.20, 0.20)) * L

        right, left = [], []
        for i in range(n_pts + 1):
            t = i / n_pts
            w = W * (np.sin(np.pi * t) ** 0.75)
            y = curve * (t * t)
            right.append((t * L, y - w))
            left.append((t * L, y + w))
        poly = right + left[::-1]
        ca, sa = np.cos(ang), np.sin(ang)
        poly = [(lx + x * ca - y * sa, ly + x * sa + y * ca) for (x, y) in poly]
        rgb = tuple(int(c) for c in col)
        draw.polygon(poly, fill=rgb + (255,))
        # darker central midrib for depth
        tb = (lx, ly)
        tt = (lx + L * ca - curve * sa, ly + L * sa + curve * ca)
        dark = tuple(int(c * 0.55) for c in col)
        draw.line([tb, tt], fill=dark + (255,), width=max(2, int(W * 0.14)))

    out = img.resize((size, size), Image.Resampling.LANCZOS)
    return np.asarray(out, dtype=np.uint8)


def process_all_base_textures() -> dict[str, str]:
    """Process all raw textures into 1024x1024 seamless JPEGs and return path dictionary."""
    os.makedirs(OUT_DIR, exist_ok=True)
    specs = {
        "grass": ("grass_tropical.jpg", 1024, 140.0),
        "rock": ("rock_cliff.jpg", 1024, 160.0),
        "sand": ("sand_beach.jpg", 1024, 130.0),
        "water": ("water_tropical.jpg", 1024, 180.0),
        "bark": ("tree_bark_wood.jpg", 1024, 140.0),
        "foliage": ("foliage_leaves.jpg", 1024, 150.0),
        "wood": ("wood_planks.jpg", 1024, 160.0),
        "stone": ("ancient_stone.jpg", 1024, 150.0),
        "thatch": ("thatch_roof.jpg", 1024, 150.0),
    }
    paths = {}
    arrays = {}
    for key, (fname, sz, sig) in specs.items():
        raw_path = os.path.join(RAW_DIR, fname)
        im = Image.open(raw_path)
        seamless = make_seamless_square(im, size=sz, equalize_sigma=sig)
        out_path = os.path.join(OUT_DIR, f"{key}_seamless.jpg")
        Image.fromarray(seamless).save(out_path, quality=91, optimize=True)
        paths[key] = out_path
        arrays[key] = seamless

    # Cave rock variant: slightly cooler damp cavern rock with mineral sheen for cave interior
    cave_rock = arrays["rock"].astype(np.float32)
    cave_rock[:, :, 0] *= 0.76
    cave_rock[:, :, 1] *= 0.82
    cave_rock[:, :, 2] *= 0.88
    cave_rock_u8 = np.clip(cave_rock, 0, 255).astype(np.uint8)
    cave_path = os.path.join(OUT_DIR, "cave_rock_seamless.jpg")
    Image.fromarray(cave_rock_u8).save(cave_path, quality=90, optimize=True)
    paths["cave_rock"] = cave_path

    # Rock normal map
    rock_norm = generate_normal_map(arrays["rock"], strength=2.8, blur_sigma=0.5)
    rock_norm_path = os.path.join(OUT_DIR, "rock_normal.jpg")
    Image.fromarray(rock_norm).save(rock_norm_path, quality=90, optimize=True)
    paths["rock_normal"] = rock_norm_path

    # Foliage & bark normal maps for extra leaf/bark relief realism
    fol_norm = generate_normal_map(arrays["foliage"], strength=2.0, blur_sigma=0.5)
    fol_norm_path = os.path.join(OUT_DIR, "foliage_normal.jpg")
    Image.fromarray(fol_norm).save(fol_norm_path, quality=90, optimize=True)
    paths["foliage_normal"] = fol_norm_path

    bark_norm = generate_normal_map(arrays["bark"], strength=2.8, blur_sigma=0.4)
    bark_norm_path = os.path.join(OUT_DIR, "bark_normal.jpg")
    Image.fromarray(bark_norm).save(bark_norm_path, quality=90, optimize=True)
    paths["bark_normal"] = bark_norm_path

    # Alpha-cutout leaf-card texture (real leaf shapes merged into tree meshes)
    leaf_rgba = make_leaf_card_texture(1024)
    leaf_path = os.path.join(OUT_DIR, "leaf_cards.png")
    Image.fromarray(leaf_rgba).save(leaf_path, optimize=True)
    paths["leaf_cards"] = leaf_path

    # Crystal & fire/lantern textures
    cryst = make_crystal_texture(512)
    cryst_path = os.path.join(OUT_DIR, "crystal_glow.jpg")
    Image.fromarray(cryst).save(cryst_path, quality=92, optimize=True)
    paths["crystal"] = cryst_path

    fire = make_fire_lantern_texture(256)
    fire_path = os.path.join(OUT_DIR, "fire_lantern.jpg")
    Image.fromarray(fire).save(fire_path, quality=92, optimize=True)
    paths["fire"] = fire_path

    return paths


def _tile_sample(tex: np.ndarray, u: np.ndarray, v: np.ndarray, repeats: float) -> np.ndarray:
    """Fast vectorized bilinear tile sampling of a seamless (N, N, 3) texture."""
    n = tex.shape[0]
    fx = (u * repeats * n) % n
    fy = (v * repeats * n) % n
    x0 = np.floor(fx).astype(np.int32) % n
    y0 = np.floor(fy).astype(np.int32) % n
    x1 = (x0 + 1) % n
    y1 = (y0 + 1) % n
    wx = (fx - np.floor(fx))[:, :, None]
    wy = (fy - np.floor(fy))[:, :, None]
    c00 = tex[y0, x0].astype(np.float32)
    c10 = tex[y0, x1].astype(np.float32)
    c01 = tex[y1, x0].astype(np.float32)
    c11 = tex[y1, x1].astype(np.float32)
    return (1.0 - wy) * ((1.0 - wx) * c00 + wx * c10) + wy * ((1.0 - wx) * c01 + wx * c11)


def bake_master_island_texture(
    heightmap: np.ndarray,
    river_dist: np.ndarray,
    river_water_y: np.ndarray,
    trail_mask: np.ndarray,
    cave_mouth_mask: np.ndarray,
    tex_paths: dict[str, str],
    out_size: int = 2048,
) -> tuple[str, str]:
    """
    Bake a high-resolution (2048x2048) Master Wrapped Island Albedo Image + Normal Map
    precisely aligned to the island's elevation, slope, river channel, beaches, trails,
    jungle zones, ancient plaza, and cliffs ("di wrap image aja").
    """
    from scipy.ndimage import zoom

    gh, gw = heightmap.shape
    scale_y = out_size / gh
    scale_x = out_size / gw

    H = zoom(heightmap, (scale_y, scale_x), order=1)
    R_dist = zoom(river_dist, (scale_y, scale_x), order=1)
    R_wy = zoom(river_water_y, (scale_y, scale_x), order=1)
    T_mask = np.clip(zoom(trail_mask, (scale_y, scale_x), order=1), 0.0, 1.0)
    C_mask = np.clip(zoom(cave_mouth_mask, (scale_y, scale_x), order=1), 0.0, 1.0)

    # Compute world-space slope (domain is 360m x 360m)
    pixel_m = 360.0 / out_size
    dHdx = np.gradient(H, pixel_m, axis=1)
    dHdz = np.gradient(H, pixel_m, axis=0)
    slope = np.sqrt(dHdx * dHdx + dHdz * dHdz)

    # Normalized UV grids [0, 1)
    vv, uu = np.mgrid[0:out_size, 0:out_size].astype(np.float32) / out_size

    # Load seamless source tiles
    t_sand = np.asarray(Image.open(tex_paths["sand"]), dtype=np.uint8)
    t_grass = np.asarray(Image.open(tex_paths["grass"]), dtype=np.uint8)
    t_rock = np.asarray(Image.open(tex_paths["rock"]), dtype=np.uint8)
    t_jungle = np.asarray(Image.open(tex_paths["foliage"]), dtype=np.uint8)
    t_stone = np.asarray(Image.open(tex_paths["stone"]), dtype=np.uint8)
    t_water = np.asarray(Image.open(tex_paths["water"]), dtype=np.uint8)

    # Multi-scale tile sampling to eliminate any macro repetition across the 360m island!
    sand_col = 0.65 * _tile_sample(t_sand, uu, vv, 26.0) + 0.35 * _tile_sample(t_sand, uu + 0.37, vv + 0.19, 9.0)
    grass_col = 0.65 * _tile_sample(t_grass, uu, vv, 28.0) + 0.35 * _tile_sample(t_grass, uu + 0.21, vv + 0.43, 10.0)
    jungle_col = 0.55 * _tile_sample(t_jungle, uu, vv, 22.0) + 0.45 * grass_col * 0.82
    rock_col = 0.68 * _tile_sample(t_rock, uu, vv, 22.0) + 0.32 * _tile_sample(t_rock, uu + 0.41, vv + 0.13, 7.5)
    stone_col = _tile_sample(t_stone, uu, vv, 30.0)
    river_bed_col = 0.55 * _tile_sample(t_water, uu, vv, 24.0) + 0.45 * rock_col * 0.78

    # Organic variation noise
    macro_noise = (
        0.5
        + 0.28 * np.sin(2.0 * np.pi * (uu * 5.0 + 0.4 * np.cos(2.0 * np.pi * vv * 4.0)))
        + 0.22 * np.cos(2.0 * np.pi * (vv * 6.0 - 0.3 * np.sin(2.0 * np.pi * uu * 5.0)))
    )

    # Start with shallow coral seabed -> golden beach sand -> lush grass
    seabed_tint = sand_col * np.array([0.48, 0.82, 0.88], dtype=np.float32)
    wet_sand = sand_col * np.array([0.76, 0.72, 0.64], dtype=np.float32)

    albedo = seabed_tint.copy()

    # Transition from underwater (-3.5m .. -0.2m) to wet shoreline sand
    w_wet = _smoothstep(-3.8, -0.15, H)[:, :, None]
    albedo = (1.0 - w_wet) * albedo + w_wet * wet_sand

    # Dry golden beach sand (0.0m .. +4.2m)
    w_dry_sand = _smoothstep(-0.1, 1.3, H)[:, :, None]
    albedo = (1.0 - w_dry_sand) * albedo + w_dry_sand * sand_col

    # Coastal white surf foam line right around Y = 0.0m .. 0.45m!
    foam_band = np.exp(-(((H - 0.18) / 0.38) ** 2)) * (1.0 - _smoothstep(1.2, 2.2, slope))
    albedo = albedo * (1.0 - 0.45 * foam_band[:, :, None]) + 245.0 * (0.45 * foam_band[:, :, None])

    # Lush tropical meadow grass starting above beach (+3.2m .. +7.0m, modulated by noise)
    grass_start = 3.2 + 1.8 * (macro_noise - 0.5)
    w_grass = _smoothstep(0.0, 3.2, H - grass_start)[:, :, None]
    albedo = (1.0 - w_grass) * albedo + w_grass * grass_col

    # Deep jungle canopy floor richness in mid-elevations (+11m .. +38m)
    w_jungle = (_smoothstep(9.0, 17.0, H) * (1.0 - _smoothstep(34.0, 48.0, H)) * np.clip(macro_noise, 0.0, 1.0))[:, :, None]
    albedo = (1.0 - 0.62 * w_jungle) * albedo + (0.62 * w_jungle) * jungle_col

    # Highland alpine moss & rocky peak tint (+52m .. +84m)
    w_peak = _smoothstep(50.0, 68.0, H)[:, :, None]
    alpine_col = 0.65 * rock_col + 0.35 * grass_col * np.array([0.85, 0.95, 0.78], dtype=np.float32)
    albedo = (1.0 - w_peak) * albedo + w_peak * alpine_col

    # Winding walking trails & Ancient Ruins stone plaza
    dirt_trail_col = 0.58 * sand_col * np.array([0.82, 0.70, 0.56], dtype=np.float32) + 0.42 * stone_col
    w_trail = (T_mask * (1.0 - _smoothstep(0.65, 1.1, slope)))[:, :, None]
    albedo = (1.0 - 0.85 * w_trail) * albedo + (0.85 * w_trail) * dirt_trail_col

    # Riverbed & riverbanks! Smooth pebbles, wet stones & vibrant turquoise river water in channel
    in_river_bank = (1.0 - _smoothstep(5.5, 14.5, R_dist)) * _smoothstep(-0.5, 1.5, H)
    river_bank_pebbles = 0.55 * rock_col + 0.45 * wet_sand
    albedo = (1.0 - 0.72 * in_river_bank[:, :, None]) * albedo + (0.72 * in_river_bank[:, :, None]) * river_bank_pebbles

    water_tile_vivid = _tile_sample(t_water, uu, vv, 28.0)
    submerged_river = _smoothstep(-0.15, 0.9, R_wy - H) * (1.0 - _smoothstep(7.0, 16.5, R_dist)) * _smoothstep(-0.4, 0.5, H)
    albedo = (1.0 - 0.90 * submerged_river[:, :, None]) * albedo + (0.90 * submerged_river[:, :, None]) * water_tile_vivid

    # Steep cliffs & cave entrances -> 100% crisp rocky cliff texture so cave mouth transitions seamlessly!
    w_cliff = np.maximum(_smoothstep(0.55, 1.05, slope), C_mask)[:, :, None]
    albedo = (1.0 - w_cliff) * albedo + w_cliff * rock_col

    # Subtle baked topographic hillshade & valley ambient occlusion so the wrapped image looks super 3D!
    laplacian = gaussian_filter(H, sigma=6.0) - H
    ao = np.clip(1.0 - 0.032 * np.maximum(laplacian, 0.0), 0.74, 1.06)
    albedo = np.clip(albedo * ao[:, :, None], 0.0, 255.0).astype(np.uint8)

    albedo_path = os.path.join(OUT_DIR, "island_terrain_wrap.jpg")
    Image.fromarray(albedo).save(albedo_path, quality=92, optimize=True)

    # Bake matching tangent-space normal map combining macro terrain micro-relief + material normal detail
    terr_norm = generate_normal_map(albedo, strength=2.2, blur_sigma=0.4)
    norm_path = os.path.join(OUT_DIR, "island_terrain_normal.jpg")
    Image.fromarray(terr_norm).save(norm_path, quality=88, optimize=True)

    return albedo_path, norm_path


if __name__ == "__main__":
    p = process_all_base_textures()
    print("Processed textures:", list(p.keys()))
