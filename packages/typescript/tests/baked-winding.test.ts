import { describe, it, expect } from 'vitest';
import { buildSceneFromParsed, type ParsedDefinition } from '../src/model';
import { panelDefinition, makeParsed, translation, scaleMatrix } from './helpers/instanced-fixtures';

/** Triangles whose corner order disagrees with their normals (the side back-face culling shows). */
function disagreeing(scene: ReturnType<typeof buildSceneFromParsed>) {
  let bad = 0;
  let all = 0;
  for (const p of scene.glbPrimitives) {
    const { positions: v, normals: n, indices: ix } = p;
    for (let t = 0; t < ix.length; t += 3) {
      const [a, b, c] = [ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3];
      const u = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
      const w = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
      const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      all++;
      if (cr[0] * n[a] + cr[1] * n[a + 1] + cr[2] * n[a + 2] < 0) bad++;
    }
  }
  return { bad, all };
}

describe('baked triangles face the way their normals do', () => {
  it('for a placement as drawn and for a mirrored one', () => {
    const scene = buildSceneFromParsed(
      makeParsed({
        defs: new Map<number | string, ParsedDefinition>([[1, panelDefinition()]]),
        rootInstances: [
          { refIdx: 1, name: 'AsDrawn', matrix: translation(0, 0, 0) },
          { refIdx: 1, name: 'Mirrored', matrix: scaleMatrix(-1, 1, 1, [100, 0, 0]) },
        ],
      })
    );
    const r = disagreeing(scene);
    expect(r.all).toBeGreaterThan(0);
    expect(r.bad).toBe(0);
  });
});
