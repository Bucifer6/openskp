"""A pre-2021 component instance's own tag and paint reach the baked scenes.

The classic-format walker records an instance's layer and material ids on the instance itself
(``layer_id`` / ``material_id``); it has no TLV children. Both scene builders only looked for those ids
in the D007 record a 2021+ instance carries, so in a classic file a painted component kept its unpainted
faces in the default colour and every placement reported "Layer0".

Fixture ``legacy_painted_tagged_instance.skp`` (the Rust writer's ``components.skp`` reference, written
by this project, no private content): a "Chair" definition with one face painted Red and the rest
unpainted, placed three times; the placement named "Second Chair" is painted Red and sits on the
"Furniture" tag.
"""
from __future__ import annotations

import pathlib

from openskp import SkpFile

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "legacy_painted_tagged_instance.skp"
RED = [1.0, 0.0, 0.0, 1.0]


def _find(node, name):
    if node.name == name:
        return node
    for child in node.children:
        hit = _find(child, name)
        if hit is not None:
            return hit
    return None


def test_baked_scene_uses_the_instances_own_tag_and_paint():
    scene = SkpFile.open(str(FIXTURE)).build_scene()
    assert _find(scene.scene_hierarchy, "Second Chair").layer == "Furniture"
    meshes = [g for g in scene.glb_primitives if scene.mesh_index[g.geom_name].name == "Second Chair"]
    assert meshes
    for g in meshes:
        assert scene.mesh_index[g.geom_name].layer == "Furniture"
        assert scene.gltf_materials[g.material_index]["pbrMetallicRoughness"]["baseColorFactor"] == RED
    # An unpainted placement of the same definition is untouched.
    plain = [g for g in scene.glb_primitives if scene.mesh_index[g.geom_name].name == "Chair"]
    colours = {tuple(scene.gltf_materials[g.material_index]["pbrMetallicRoughness"]["baseColorFactor"])
               for g in plain}
    assert len(colours) > 1


def test_instanced_scene_uses_the_instances_own_tag_and_paint():
    scene = SkpFile.open(str(FIXTURE)).build_instanced_scene()
    node = _find(scene.scene_hierarchy, "Second Chair")
    assert node.layer == "Furniture"
    resource = next(r for r in scene.mesh_resources if r.id == node.mesh_resource_id)
    for prim in resource.primitives:
        assert scene.gltf_materials[prim.material_index]["pbrMetallicRoughness"]["baseColorFactor"] == RED
