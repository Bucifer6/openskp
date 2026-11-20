import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseSkp, buildScene, buildInstancedScene } from '../src/index';
import type { InstancedNode } from '../src/index';

function load(name: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * A face keeps the tag it was drawn on.
 *
 * A face has a layer of its own, independent of the instance placing it. The reader dropped it, so
 * geometry drawn on a tag inside an untagged component reported "Layer0": a viewer could not hide it
 * with its tag, and its unpainted faces took Layer0's colour instead of the tag's.
 *
 * Fixture legacy_face_layers.skp (the web viewer's chair_and_table sample, written by this project, no
 * private content): every instance is untagged; the table's faces are drawn on "Table" and the chair's
 * on "Chair".
 */
describe('a face drawn on its own tag', () => {
  it('reports the tag on the public model', () => {
    const model = parseSkp(load('legacy_face_layers.skp'));
    const layers = new Set<string>();
    for (const def of model.definitions.values()) for (const f of def.faces) layers.add(f.layer);
    expect([...layers].sort()).toEqual(['Chair', 'Table']);
  });

  it('labels and colours baked meshes by it', () => {
    const scene = buildScene(load('legacy_face_layers.skp'));
    const layers = new Set(Object.values(scene.meshIndex).map((m) => m.layer));
    expect([...layers].sort()).toEqual(['Chair', 'Table']);
    // Unpainted sides take the tag's colour (Chair 120,150,190 / Table 190,150,120), not Layer0's.
    const colours = new Set(
      scene.gltfMaterials.map((m: any) => m.pbrMetallicRoughness.baseColorFactor.map((c: number) => Math.round(c * 255)).join(','))
    );
    expect(colours.has('120,150,190,255')).toBe(true);
    expect(colours.has('190,150,120,255')).toBe(true);
  });

  it('reports it as meshLayer on instanced nodes, leaving the placement layer alone', () => {
    const scene = buildInstancedScene(load('legacy_face_layers.skp'));
    const meshLayers = new Set<string>();
    const walk = (n: InstancedNode) => {
      if (n.meshResourceId !== undefined) {
        expect(n.layer).toBe('Layer0');
        meshLayers.add(n.meshLayer ?? n.layer);
      }
      n.children.forEach(walk);
    };
    walk(scene.sceneHierarchy);
    expect([...meshLayers].sort()).toEqual(['Chair', 'Table']);
  });

  it('leaves meshLayer absent when faces are on the default layer', () => {
    const scene = buildInstancedScene(load('nesting_2017.skp'));
    const walk = (n: InstancedNode) => {
      expect(n.meshLayer).toBeUndefined();
      n.children.forEach(walk);
    };
    walk(scene.sceneHierarchy);
  });
});
