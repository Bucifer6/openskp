import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseSkp } from '../src/index';

/**
 * A guide line that is the last entity of a component definition.
 *
 * The length of a guide line's trailing block depends on the writing build, so the reader calibrates it
 * on the first guide of the file. When that guide is the last entity in a definition, what follows is
 * the definition's zero relationship count, which looks like a null tag at every candidate length; a
 * SketchUp 2017 file then took the 7-byte guess, swallowed three bytes of the definition's tail and
 * failed with "expected a string record". The null-anchored pass now prefers the 4-byte trailer.
 *
 * Fixture legacy_guide_last_in_definition.skp (the Rust writer's guide_options.skp reference, written
 * by this project, no private content): two guides at the root and one inside "GuideDef".
 */
describe('a guide line that ends a component definition', () => {
  it('parses, with every guide in place', () => {
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_guide_last_in_definition.skp'));
    const model = parseSkp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    expect(model.root.constructionLines).toEqual([
      { point: [0, 0, 0], direction: [1, 0, 0], start: [0, 0, 0], end: [10, 0, 0] },
      { point: [0, 0, 4], direction: [0, 0, 1], start: null, end: null },
    ]);
    const defs = [...model.definitions.values()];
    expect(defs.map((d) => d.name)).toEqual(['GuideDef']);
    expect(defs[0].constructionLines).toEqual([
      { point: [0, 0, 0], direction: [1, 0, 0], start: [0, 0, 0], end: [5, 0, 0] },
    ]);
  });
});
