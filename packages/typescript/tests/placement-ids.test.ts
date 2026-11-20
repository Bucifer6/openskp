import { describe, it, expect } from 'vitest';
import { buildSceneFromParsed, type ParsedDefinition } from '../src/model';
import { panelDefinition, makeParsed, translation } from './helpers/instanced-fixtures';

describe('placementIds', () => {
  it('tells two placements of the same component apart, where the path does not', () => {
    const scene = buildSceneFromParsed(
      makeParsed({
        defs: new Map<number | string, ParsedDefinition>([[1, panelDefinition()]]),
        rootInstances: [
          { refIdx: 1, name: '', matrix: translation(0, 0, 0) },
          { refIdx: 1, name: '', matrix: translation(50, 0, 0) },
        ],
      })
    );
    const metas = scene.glbPrimitives.map((p) => scene.meshIndex[p.geomName]);
    expect(metas).toHaveLength(2);
    expect(metas[0].path).toBe(metas[1].path);
    expect(metas[0].placementIds).toHaveLength(1);
    expect(metas[0].placementIds[0]).not.toBe(metas[1].placementIds[0]);
    // the scene tree carries the same numbers, for a placement's name
    const ids = scene.sceneHierarchy.children.map((c) => c.placementId);
    expect(ids.sort()).toEqual(metas.map((m) => m.placementIds[0]).sort());
  });
});
