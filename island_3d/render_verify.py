import io
import os
import math
import numpy as np
from PIL import Image
import pygltflib


def load_glb_renderables(glb_path: str) -> list[dict]:
    """Load all mesh primitives & embedded JPEG/PNG textures directly from the exported .glb binary."""
    gltf = pygltflib.GLTF2().load(glb_path)
    blob = gltf.binary_blob()

    def get_accessor_array(acc_idx: int) -> np.ndarray:
        acc = gltf.accessors[acc_idx]
        bv = gltf.bufferViews[acc.bufferView]
        offset = (bv.byteOffset or 0) + (acc.byteOffset or 0)
        comp_map = {
            pygltflib.UNSIGNED_INT: np.uint32,
            pygltflib.UNSIGNED_SHORT: np.uint16,
            pygltflib.FLOAT: np.float32,
        }
        dt = comp_map[acc.componentType]
        n_comp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc.type]
        arr = np.frombuffer(blob, dtype=dt, count=acc.count * n_comp, offset=offset)
        return arr.reshape(acc.count, n_comp) if n_comp > 1 else arr

    # Decode textures
    tex_arrays = []
    for tex in gltf.textures:
        img_def = gltf.images[tex.source]
        bv = gltf.bufferViews[img_def.bufferView]
        raw = blob[bv.byteOffset : bv.byteOffset + bv.byteLength]
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        tex_arrays.append((np.asarray(im, dtype=np.float32) / 255.0, gltf.samplers[tex.sampler].wrapS == pygltflib.CLAMP_TO_EDGE))

    items = []
    for mesh in gltf.meshes:
        for prim in mesh.primitives:
            verts = get_accessor_array(prim.attributes.POSITION)
            norms = get_accessor_array(prim.attributes.NORMAL)
            uvs = get_accessor_array(prim.attributes.TEXCOORD_0)
            cols = get_accessor_array(prim.attributes.COLOR_0)
            faces = get_accessor_array(prim.indices).reshape(-1, 3)
            mat = gltf.materials[prim.material]
            t_idx = mat.pbrMetallicRoughness.baseColorTexture.index
            tex_arr, clamp_uv = tex_arrays[t_idx]
            emissive = np.array(mat.emissiveFactor or [0.0, 0.0, 0.0], dtype=np.float32)
            items.append({
                "name": mesh.name,
                "verts": verts,
                "norms": norms,
                "uvs": uvs,
                "cols": cols,
                "faces": faces,
                "tex": tex_arr,
                "clamp_uv": clamp_uv,
                "double_sided": bool(mat.doubleSided),
                "blend": (mat.alphaMode == pygltflib.BLEND),
                "mask": (mat.alphaMode == pygltflib.MASK),
                "cutoff": float(mat.alphaCutoff or 0.5),
                "emissive": emissive,
            })
    return items


def render_camera_view(
    items: list[dict],
    eye: tuple[float, float, float],
    target: tuple[float, float, float],
    width: int = 800,
    height: int = 500,
    fov_deg: float = 58.0,
    cave_mode: bool = False,
) -> Image.Image:
    """Fast perspective Z-buffer + UV-textured + Sun/Sky/Point-light software verifier."""
    eye_v = np.array(eye, dtype=np.float32)
    tgt_v = np.array(target, dtype=np.float32)
    fwd = tgt_v - eye_v
    fwd /= np.linalg.norm(fwd)
    up_ref = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    right = np.cross(fwd, up_ref)
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)

    f_len = 0.5 * height / math.tan(math.radians(fov_deg) * 0.5)
    cx, cy = width * 0.5, height * 0.5

    # Tropical sky gradient background
    yy = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    if cave_mode:
        sky_top = np.array([0.08, 0.14, 0.22], dtype=np.float32)
        sky_bot = np.array([0.16, 0.28, 0.36], dtype=np.float32)
    else:
        sky_top = np.array([0.24, 0.58, 0.92], dtype=np.float32)
        sky_bot = np.array([0.72, 0.88, 0.96], dtype=np.float32)
    frame = ((1.0 - yy) * sky_top[None, :] + yy * sky_bot[None, :])
    frame = np.broadcast_to(frame[:, None, :], (height, width, 3)).copy()
    zbuf = np.full((height, width), 1e9, dtype=np.float32)

    sun_dir = np.array([-0.48, 0.74, 0.47], dtype=np.float32)
    sun_dir /= np.linalg.norm(sun_dir)

    # Render opaque items first, blended water items second!
    ordered = [it for it in items if not it["blend"]] + [it for it in items if it["blend"]]

    for it in ordered:
        verts = it["verts"]
        faces = it["faces"]
        norms = it["norms"]
        uvs = it["uvs"]
        cols = it["cols"]
        tex = it["tex"]
        th, tw = tex.shape[0], tex.shape[1]
        clamp_uv = it["clamp_uv"]
        is_blend = it["blend"]
        is_mask = it["mask"]
        mask_cutoff = it["cutoff"]
        emis = it["emissive"]

        rel = verts - eye_v[None, :]
        xc = rel @ right
        yc = rel @ up
        zc = rel @ fwd

        f0, f1, f2 = faces[:, 0], faces[:, 1], faces[:, 2]
        z0, z1, z2 = zc[f0], zc[f1], zc[f2]
        valid = (z0 > 0.5) & (z1 > 0.5) & (z2 > 0.5)
        if not np.any(valid):
            continue

        f_sub = faces[valid]
        f0, f1, f2 = f_sub[:, 0], f_sub[:, 1], f_sub[:, 2]

        sx0 = cx + (xc[f0] / zc[f0]) * f_len
        sy0 = cy - (yc[f0] / zc[f0]) * f_len
        sx1 = cx + (xc[f1] / zc[f1]) * f_len
        sy1 = cy - (yc[f1] / zc[f1]) * f_len
        sx2 = cx + (xc[f2] / zc[f2]) * f_len
        sy2 = cy - (yc[f2] / zc[f2]) * f_len

        # Screen-space signed area (Note: +Y screen is DOWN, so CCW 3D has negative 2D cross product (sx1-sx0)*(sy2-sy0) - (sy1-sy0)*(sx2-sx0) < 0)
        area2 = (sx1 - sx0) * (sy2 - sy0) - (sy1 - sy0) * (sx2 - sx0)
        if not it["double_sided"]:
            front = area2 < -1e-4
        else:
            front = np.abs(area2) > 1e-4

        bx0 = np.maximum(np.floor(np.minimum(np.minimum(sx0, sx1), sx2)).astype(np.int32), 0)
        bx1 = np.minimum(np.ceil(np.maximum(np.maximum(sx0, sx1), sx2)).astype(np.int32), width - 1)
        by0 = np.maximum(np.floor(np.minimum(np.minimum(sy0, sy1), sy2)).astype(np.int32), 0)
        by1 = np.minimum(np.ceil(np.maximum(np.maximum(sy0, sy1), sy2)).astype(np.int32), height - 1)

        in_screen = front & (bx0 <= bx1) & (by0 <= by1)
        if not np.any(in_screen):
            continue

        idx_vis = np.where(in_screen)[0]
        # Precompute per-vertex lighting (sun + sky hemisphere + subterranean crystal fill light)
        ndotl = np.maximum(norms @ sun_dir, 0.0)
        hemi = 0.36 + 0.22 * (0.5 + 0.5 * norms[:, 1])
        # Point light inside Crystal Cavern (scaled 1.4x with the island) so interior cave views look richly lit!
        cave_vec = np.array([81.2, 14.0, -44.8], dtype=np.float32)[None, :] - verts
        cave_d2 = np.sum(cave_vec * cave_vec, axis=1) + 68.0
        cave_fill = (314.0 / cave_d2)[:, None] * np.array([[0.45, 0.88, 1.0]], dtype=np.float32)

        v_light = (hemi + 0.72 * ndotl)[:, None] * np.array([[1.02, 0.99, 0.94]], dtype=np.float32) + cave_fill

        for k in idx_vis:
            x_lo, x_hi = int(bx0[k]), int(bx1[k])
            y_lo, y_hi = int(by0[k]), int(by1[k])
            i0, i1, i2 = int(f0[k]), int(f1[k]), int(f2[k])

            px = np.arange(x_lo, x_hi + 1, dtype=np.float32)[None, :] + 0.5
            py = np.arange(y_lo, y_hi + 1, dtype=np.float32)[:, None] + 0.5

            ax, ay = sx0[k], sy0[k]
            bx, by = sx1[k], sy1[k]
            cx_t, cy_t = sx2[k], sy2[k]
            denom = area2[k]

            w0 = ((bx - px) * (cy_t - py) - (by - py) * (cx_t - px)) / denom
            w1 = ((cx_t - px) * (ay - py) - (cy_t - py) * (ax - px)) / denom
            w2 = 1.0 - w0 - w1

            mask = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
            if not np.any(mask):
                continue

            inv_z = w0 / zc[i0] + w1 / zc[i1] + w2 / zc[i2]
            z_pix = 1.0 / np.maximum(inv_z, 1e-6)

            z_slice = zbuf[y_lo : y_hi + 1, x_lo : x_hi + 1]
            vis_m = mask & (z_pix < z_slice)
            if not np.any(vis_m):
                continue

            # Perspective-correct UV & lighting interpolation!
            u_p = (w0 * (uvs[i0, 0] / zc[i0]) + w1 * (uvs[i1, 0] / zc[i1]) + w2 * (uvs[i2, 0] / zc[i2])) * z_pix
            v_p = (w0 * (uvs[i0, 1] / zc[i0]) + w1 * (uvs[i1, 1] / zc[i1]) + w2 * (uvs[i2, 1] / zc[i2])) * z_pix

            um = u_p[vis_m]
            vm = v_p[vis_m]
            if clamp_uv:
                tx = np.clip((um * (tw - 1)).astype(np.int32), 0, tw - 1)
                ty = np.clip((vm * (th - 1)).astype(np.int32), 0, th - 1)
            else:
                tx = np.mod((um * tw).astype(np.int32), tw)
                ty = np.mod((vm * th).astype(np.int32), th)

            texel = tex[ty, tx]  # RGBA (leaf cards are alpha-cutout)

            if is_mask:
                keep = texel[:, 3] >= mask_cutoff
                if not keep.all():
                    vis_m[vis_m] = keep  # discard texels below alpha cutoff
                    if not vis_m.any():
                        continue
                    tx, ty, texel = tx[keep], ty[keep], texel[keep]
            tex_rgb = texel[:, :3]

            w0m, w1m, w2m = w0[vis_m][:, None], w1[vis_m][:, None], w2[vis_m][:, None]
            col_interp = w0m * cols[i0, :3] + w1m * cols[i1, :3] + w2m * cols[i2, :3]
            alpha_interp = (w0m[:, 0] * cols[i0, 3] + w1m[:, 0] * cols[i1, 3] + w2m[:, 0] * cols[i2, 3])
            lit_interp = w0m * v_light[i0] + w1m * v_light[i1] + w2m * v_light[i2]

            shaded = tex_rgb * col_interp * lit_interp + tex_rgb * emis[None, :] * 0.85

            # Subtle atmospheric distance haze (scaled 1.4x with the island)
            fog_t = np.clip((z_pix[vis_m] - 196.0) / 476.0, 0.0, 0.55)[:, None]
            haze_col = sky_bot[None, :]
            shaded = (1.0 - fog_t) * shaded + fog_t * haze_col

            f_slice = frame[y_lo : y_hi + 1, x_lo : x_hi + 1]
            if is_blend:
                a_val = np.clip(alpha_interp, 0.0, 1.0)[:, None]
                # Add subtle sky specular reflection on water!
                shaded = shaded + 0.14 * np.array([[0.75, 0.92, 1.0]], dtype=np.float32)
                f_slice[vis_m] = (1.0 - a_val) * f_slice[vis_m] + a_val * np.clip(shaded, 0.0, 1.0)
                z_slice[vis_m] = z_pix[vis_m]
            else:
                f_slice[vis_m] = np.clip(shaded, 0.0, 1.0)
                z_slice[vis_m] = z_pix[vis_m]

    # Reinhard gentle tone curve / gamma polish
    out = np.clip(frame, 0.0, 1.0)
    return Image.fromarray((out * 255.0).astype(np.uint8))


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    glb_p = os.path.join(root, "island.glb")
    out_dir = os.path.join(os.path.dirname(__file__), "renders")
    os.makedirs(out_dir, exist_ok=True)

    print("Loading island.glb for visual verification...")
    items = load_glb_renderables(glb_p)

    cameras = [
        # view1 = the user's very first screen (viewer initial camera), island now 1.4x
        ("view1_aerial_overview.jpg", (340.0, 240.0, 340.0), (0.0, 12.0, 0.0), 55.0, False),
        # views 2-6: original cameras x1.4 to track the grown island (village eye +6 y margin)
        ("view2_river_bridge_waterfall.jpg", (30.8, 38.6, 95.2), (-22.4, 25.2, -14.0), 58.0, False),
        ("view3_valley_cave_entrance.jpg", (21.7, 32.0, 17.5), (47.6, 25.2, -14.0), 62.0, False),
        ("view4_inside_crystal_cavern.jpg", (56.0, 17.5, -33.6), (106.4, 8.4, -46.2), 68.0, True),
        ("view5_village_pier_boats.jpg", (-201.6, 30.8, 78.4), (-123.2, 8.4, 28.0), 56.0, False),
        ("view6_ancient_temple_ruins.jpg", (75.6, 58.8, 67.2), (102.2, 47.6, 53.2), 58.0, False),
    ]

    for fname, eye, tgt, fov, cmode in cameras:
        im = render_camera_view(items, eye, tgt, width=800, height=500, fov_deg=fov, cave_mode=cmode)
        p = os.path.join(out_dir, fname)
        im.save(p, quality=92)
        print("Saved", p)
