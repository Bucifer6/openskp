import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseSkp, buildScene } from '../src/index';

function load(name: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Tags with a line style in SketchUp 2019 and 2020 files.
 *
 * Since SketchUp 2019 a tag can carry a line style ("Dash", "Dot", ...). A tag that has one points at a
 * CCustomLineStyle object right after its own fields: nothing for a tag without a line style, the style
 * written in full the first time a tag uses it, a class-ref for a second style, and a back-ref for a
 * style an earlier tag already wrote. The style takes a store-map slot like any other object. Without a
 * reader for it any such model failed with "no reader for class CCustomLineStyle".
 *
 * Fixtures (shared with the Python package, saved through SketchUp's own library, one face per tag, no
 * private content): a 2020 model with no materials (slot-base probe), the same saved as 2019 (which
 * writes the style's entity preamble twice), and a 2020 model with three materials.
 */
const MODELS: Record<string, string[]> = {
  'sdk_saved_tag_line_styles_2020.skp': ['Tag 0 ', 'Tag 1 Dash', 'Tag 2 ', 'Tag 3 Dash', 'Tag 4 Dot', 'Tag 5 Dash'],
  'sdk_saved_tag_line_styles_2019.skp': ['Tag 0 ', 'Tag 1 Dash', 'Tag 2 ', 'Tag 3 Dash', 'Tag 4 Dot', 'Tag 5 Dash'],
  'sdk_saved_tag_line_styles_materials_2020.skp': ['Tag 0 Dash', 'Tag 1 ', 'Tag 2 Dot', 'Tag 3 Dash', 'Tag 4 Dot'],
};

describe('a legacy model whose tags have line styles', () => {
  for (const [name, tags] of Object.entries(MODELS)) {
    it(`${name} opens with every tag and face`, () => {
      const model = parseSkp(load(name));
      expect(model.layers.map((l) => l.name)).toEqual(['Layer0', ...tags]);
      expect(model.root.faces.length).toBe(tags.length);
    });

    it(`${name} bakes one triangle per face`, () => {
      const scene = buildScene(load(name));
      const triangles = scene.glbPrimitives.reduce((n, p) => n + p.indices.length / 3, 0);
      expect(triangles).toBe(tags.length);
    });
  }
});
