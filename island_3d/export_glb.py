import os
import time
import numpy as np
import pygltflib

from island_3d.textures import process_all_base_textures, bake_master_island_texture
from island_3d.terrain_and_cave import build_heightfield, build_island_and_cave_meshes
from island_3d.props_and_flora import (
    build_water_meshes,
    populate_flora,
    build_cave_details_and_boulders,
    build_landmarks_and_structures,
)

# Global export scale: the island is authored on a 360 m grid, then uniformly
# grown 1.4x at pack time so the delivered GLB is physically ~504 m without
# touching any of the tuned feature coordinates.
SCALE = 1.4


def _append_aligned(blob: bytearray, data: bytes) -> tuple[int, int]:
    while len(blob) % 4 != 0:
        blob.append(0)
    offset = len(blob)
    blob.extend(data)
    return offset, len(data)


def build_and_export_glb(output_path: str) -> dict:
    t0 = time.time()
    print("[1/5] Processing seamless PBR image textures + leaf cards + normal maps...")
    tex_paths = process_all_base_textures()

    print("[2/5] Generating 486m x 486m heightfield (360m grid grown 1.4x on export)...")
    hf = build_heightfield(n_xz=448)

    print("[3/5] Baking 2736x2736 Master Wrapped Island Albedo & Normal images...")
    terrain_albedo_path, terrain_norm_path = bake_master_island_texture(
        hf["H"],
        hf["river_dist"],
        hf["river_wy"],
        hf["trail_mask"],
        hf["cave_mouth_mask"],
        tex_paths,
        out_size=2736,
    )
    tex_paths["terrain_albedo"] = terrain_albedo_path
    tex_paths["terrain_normal"] = terrain_norm_path

    print("[4/5] Sculpting 3D Volumetric Island, Hollow Crystal Cavern, Cenote & Sea Arch...")
    terrain_meshes = build_island_and_cave_meshes(hf)

    print("[5/5] Populating 3D River, Waterfall, Ocean, ~360 Trees, Cave Stalactites/Crystals, Village, Bridge, Pier, Boats, Ruins & Lighthouse...")
    river_mesh, ocean_mesh = build_water_meshes(hf)
    trunk_mesh, canopy_mesh, leaf_mesh = populate_flora(hf)
    boulder_stalactite_mesh, crystal_mesh = build_cave_details_and_boulders(hf)
    landmarks = build_landmarks_and_structures(hf)

    # Assemble glTF 2.0 binary structure
    gltf = pygltflib.GLTF2(
        asset=pygltflib.Asset(
            version="2.0",
            generator="Arena 3D Island GLB Builder",
        ),
        scene=0,
    )
    blob = bytearray()

    # Standard repeat sampler & clamp-to-edge sampler (for [0,1]^2 master terrain wrap!)
    sampler_repeat_idx = 0
    sampler_clamp_idx = 1
    gltf.samplers = [
        pygltflib.Sampler(
            magFilter=pygltflib.LINEAR,
            minFilter=pygltflib.LINEAR_MIPMAP_LINEAR,
            wrapS=pygltflib.REPEAT,
            wrapT=pygltflib.REPEAT,
        ),
        pygltflib.Sampler(
            magFilter=pygltflib.LINEAR,
            minFilter=pygltflib.LINEAR_MIPMAP_LINEAR,
            wrapS=pygltflib.CLAMP_TO_EDGE,
            wrapT=pygltflib.CLAMP_TO_EDGE,
        ),
    ]

    tex_cache: dict[tuple[str, int], int] = {}

    def add_texture(img_path: str, sampler_idx: int = sampler_repeat_idx) -> int:
        key = (img_path, sampler_idx)
        if key in tex_cache:
            return tex_cache[key]
        with open(img_path, "rb") as f:
            raw = f.read()
        off, length = _append_aligned(blob, raw)
        bv_idx = len(gltf.bufferViews)
        gltf.bufferViews.append(pygltflib.BufferView(buffer=0, byteOffset=off, byteLength=length))
        img_idx = len(gltf.images)
        mime = "image/png" if img_path.lower().endswith(".png") else "image/jpeg"
        gltf.images.append(pygltflib.Image(bufferView=bv_idx, mimeType=mime, name=os.path.basename(img_path)))
        t_idx = len(gltf.textures)
        gltf.textures.append(pygltflib.Texture(sampler=sampler_idx, source=img_idx, name=os.path.basename(img_path)))
        tex_cache[key] = t_idx
        return t_idx

    def add_material(
        name: str,
        albedo_path: str,
        roughness: float = 0.85,
        metallic: float = 0.02,
        normal_path: str | None = None,
        normal_scale: float = 1.0,
        emissive_path: str | None = None,
        emissive_factor: list[float] | None = None,
        double_sided: bool = False,
        alpha_mode: str = pygltflib.OPAQUE,
        alpha_cutoff: float = 0.5,
        clamp_uv: bool = False,
    ) -> int:
        samp = sampler_clamp_idx if clamp_uv else sampler_repeat_idx
        base_tex_idx = add_texture(albedo_path, samp)
        pbr = pygltflib.PbrMetallicRoughness(
            baseColorTexture=pygltflib.TextureInfo(index=base_tex_idx),
            baseColorFactor=[1.0, 1.0, 1.0, 1.0],
            metallicFactor=metallic,
            roughnessFactor=roughness,
        )
        norm_info = None
        if normal_path is not None:
            n_idx = add_texture(normal_path, samp)
            norm_info = pygltflib.NormalMaterialTexture(index=n_idx, scale=normal_scale)
        emis_info = None
        if emissive_path is not None:
            e_idx = add_texture(emissive_path, samp)
            emis_info = pygltflib.TextureInfo(index=e_idx)

        mat_idx = len(gltf.materials)
        gltf.materials.append(
            pygltflib.Material(
                name=name,
                pbrMetallicRoughness=pbr,
                normalTexture=norm_info,
                emissiveTexture=emis_info,
                emissiveFactor=emissive_factor or [0.0, 0.0, 0.0],
                doubleSided=double_sided,
                alphaMode=alpha_mode,
                alphaCutoff=alpha_cutoff if alpha_mode == pygltflib.MASK else None,
            )
        )
        return mat_idx

    # Create rich image-wrapped PBR materials
    mat_terrain = add_material(
        "Mat_Island_Terrain_Wrap",
        tex_paths["terrain_albedo"],
        roughness=0.88,
        metallic=0.0,
        normal_path=tex_paths["terrain_normal"],
        normal_scale=0.85,
        clamp_uv=True,
    )
    mat_cave = add_material(
        "Mat_Cave_And_Cliffs_Rock",
        tex_paths["rock"],
        roughness=0.84,
        metallic=0.04,
        normal_path=tex_paths["rock_normal"],
        normal_scale=1.1,
        double_sided=True,
    )
    mat_boulders = add_material(
        "Mat_Stalactites_And_Boulders",
        tex_paths["cave_rock"],
        roughness=0.80,
        metallic=0.05,
        normal_path=tex_paths["rock_normal"],
        normal_scale=1.0,
    )
    mat_crystal = add_material(
        "Mat_Glowing_Cave_Crystals",
        tex_paths["crystal"],
        roughness=0.14,
        metallic=0.18,
        emissive_path=tex_paths["crystal"],
        emissive_factor=[0.85, 0.95, 1.0],
    )
    mat_river = add_material(
        "Mat_River_And_Waterfall",
        tex_paths["water"],
        roughness=0.09,
        metallic=0.08,
        double_sided=True,
        alpha_mode=pygltflib.BLEND,
    )
    mat_ocean = add_material(
        "Mat_Tropical_Ocean",
        tex_paths["water"],
        roughness=0.11,
        metallic=0.10,
        alpha_mode=pygltflib.BLEND,
    )
    mat_bark = add_material(
        "Mat_Tree_Bark",
        tex_paths["bark"],
        roughness=0.90,
        metallic=0.0,
        normal_path=tex_paths["bark_normal"],
        normal_scale=0.9,
    )
    mat_foliage = add_material(
        "Mat_Tropical_Foliage_Wrap",
        tex_paths["foliage"],
        roughness=0.76,
        metallic=0.0,
        normal_path=tex_paths["foliage_normal"],
        normal_scale=0.7,
        double_sided=True,
    )
    mat_leaf_cards = add_material(
        "Mat_Leaf_Cards",
        tex_paths["leaf_cards"],
        roughness=0.68,
        metallic=0.0,
        double_sided=True,
        alpha_mode=pygltflib.MASK,
        alpha_cutoff=0.45,
    )
    mat_wood = add_material(
        "Mat_Weathered_Wood_Planks",
        tex_paths["wood"],
        roughness=0.82,
        metallic=0.02,
    )
    mat_thatch = add_material(
        "Mat_Palm_Thatch_And_Sails",
        tex_paths["thatch"],
        roughness=0.88,
        metallic=0.0,
        double_sided=True,
    )
    mat_stone = add_material(
        "Mat_Ancient_Temple_Stone",
        tex_paths["stone"],
        roughness=0.86,
        metallic=0.03,
    )
    mat_fire = add_material(
        "Mat_Glowing_Lanterns_And_Fire",
        tex_paths["fire"],
        roughness=0.25,
        metallic=0.0,
        emissive_path=tex_paths["fire"],
        emissive_factor=[1.0, 0.85, 0.45],
    )

    node_indices = []
    total_verts = 0
    total_tris = 0

    def add_mesh_node(node_name: str, mesh_dict: dict, mat_idx: int):
        nonlocal total_verts, total_tris
        verts = np.ascontiguousarray(mesh_dict["verts"], dtype=np.float32)
        norms = np.ascontiguousarray(mesh_dict["normals"], dtype=np.float32)
        uvs = np.ascontiguousarray(mesh_dict["uvs"], dtype=np.float32)
        cols = np.ascontiguousarray(np.clip(mesh_dict["colors"], 0.0, 1.0), dtype=np.float32)
        faces = np.ascontiguousarray(mesh_dict["faces"], dtype=np.uint32)

        # Uniform global grow: positions x1.4 (normals/UVs/colors untouched —
        # a uniform scale keeps directions valid and textures proportional).
        verts = np.ascontiguousarray(verts * np.float32(SCALE), dtype=np.float32)

        if len(verts) == 0 or len(faces) == 0:
            return

        # Normalize normals strictly to unit length for glTF validator compliance
        nl = np.linalg.norm(norms, axis=1, keepdims=True)
        norms = np.where(nl > 1e-8, norms / np.maximum(nl, 1e-8), np.array([[0.0, 1.0, 0.0]], dtype=np.float32)).astype(np.float32)

        total_verts += len(verts)
        total_tris += len(faces)

        # 1. Indices (ELEMENT_ARRAY_BUFFER = 34963)
        idx_bytes = faces.reshape(-1).tobytes()
        off_i, len_i = _append_aligned(blob, idx_bytes)
        bv_i = len(gltf.bufferViews)
        gltf.bufferViews.append(pygltflib.BufferView(buffer=0, byteOffset=off_i, byteLength=len_i, target=pygltflib.ELEMENT_ARRAY_BUFFER))
        acc_i = len(gltf.accessors)
        gltf.accessors.append(
            pygltflib.Accessor(
                bufferView=bv_i,
                byteOffset=0,
                componentType=pygltflib.UNSIGNED_INT,
                count=faces.size,
                type=pygltflib.SCALAR,
                min=[int(faces.min())],
                max=[int(faces.max())],
            )
        )

        def _add_vec_attr(arr: np.ndarray, gltf_type: str, with_minmax: bool = False) -> int:
            b_data = arr.tobytes()
            off, ln = _append_aligned(blob, b_data)
            bv = len(gltf.bufferViews)
            gltf.bufferViews.append(pygltflib.BufferView(buffer=0, byteOffset=off, byteLength=ln, target=pygltflib.ARRAY_BUFFER))
            acc = len(gltf.accessors)
            gltf.accessors.append(
                pygltflib.Accessor(
                    bufferView=bv,
                    byteOffset=0,
                    componentType=pygltflib.FLOAT,
                    count=len(arr),
                    type=gltf_type,
                    min=arr.min(axis=0).tolist() if with_minmax else None,
                    max=arr.max(axis=0).tolist() if with_minmax else None,
                )
            )
            return acc

        acc_pos = _add_vec_attr(verts, pygltflib.VEC3, with_minmax=True)
        acc_nrm = _add_vec_attr(norms, pygltflib.VEC3)
        acc_uv = _add_vec_attr(uvs, pygltflib.VEC2)
        acc_col = _add_vec_attr(cols, pygltflib.VEC4)

        prim = pygltflib.Primitive(
            attributes=pygltflib.Attributes(
                POSITION=acc_pos,
                NORMAL=acc_nrm,
                TEXCOORD_0=acc_uv,
                COLOR_0=acc_col,
            ),
            indices=acc_i,
            material=mat_idx,
            mode=pygltflib.TRIANGLES,
        )
        mesh_idx = len(gltf.meshes)
        gltf.meshes.append(pygltflib.Mesh(name=node_name, primitives=[prim]))
        node_idx = len(gltf.nodes)
        gltf.nodes.append(pygltflib.Node(name=node_name, mesh=mesh_idx))
        node_indices.append(node_idx)

    # Add all semantic island layers in clean order (opaque first, blended water last)
    add_mesh_node("Island_Terrain_Exterior", terrain_meshes["exterior_terrain"], mat_terrain)
    add_mesh_node("Island_Cave_And_Cliffs", terrain_meshes["cave_and_cliffs"], mat_cave)
    add_mesh_node("Cave_Stalactites_And_Boulders", boulder_stalactite_mesh, mat_boulders)
    add_mesh_node("Cave_Glowing_Crystals", crystal_mesh, mat_crystal)
    add_mesh_node("Trees_Trunks_And_Branches", trunk_mesh, mat_bark)
    add_mesh_node("Trees_Canopy_And_Palms", canopy_mesh, mat_foliage)
    add_mesh_node("Trees_Leaf_Cards", leaf_mesh, mat_leaf_cards)
    add_mesh_node("Village_Bridge_Pier_And_Boats_Wood", landmarks["wood"], mat_wood)
    add_mesh_node("Village_Huts_Thatch_Roofs", landmarks["thatch"], mat_thatch)
    add_mesh_node("Ancient_Ruins_And_Lighthouse_Stone", landmarks["stone"], mat_stone)
    add_mesh_node("Lanterns_Beacon_And_Campfires", landmarks["fire"], mat_fire)
    add_mesh_node("River_Waterfall_And_Lagoon", river_mesh, mat_river)
    add_mesh_node("Ocean_Surrounding_Sea", ocean_mesh, mat_ocean)

    # Root scene node
    root_idx = len(gltf.nodes)
    gltf.nodes.append(pygltflib.Node(name="Nusantara_Giant_Island_Root", children=node_indices))
    gltf.scenes = [pygltflib.Scene(name="Giant_Island_Scene", nodes=[root_idx])]

    gltf.buffers = [pygltflib.Buffer(byteLength=len(blob))]
    gltf.set_binary_blob(bytes(blob))

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    gltf.save_binary(output_path)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    elapsed = time.time() - t0
    stats = {
        "output_path": output_path,
        "size_mb": round(size_mb, 2),
        "total_verts": total_verts,
        "total_tris": total_tris,
        "nodes": len(node_indices),
        "textures": len(gltf.textures),
        "materials": len(gltf.materials),
        "elapsed_s": round(elapsed, 2),
    }
    print("Exported GLB successfully:", stats)
    return stats


if __name__ == "__main__":
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_glb = os.path.join(root_dir, "island.glb")
    build_and_export_glb(out_glb)
