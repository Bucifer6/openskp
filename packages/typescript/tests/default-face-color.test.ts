import { describe, it, expect } from 'vitest';
import { buildSceneFromParsed, type ParsedDefinition } from '../src/model';
import { buildInstancedSceneFromParsed } from '../src/instanced';
import { panelDefinition, makeParsed, translation } from './helpers/instanced-fixtures';

// Two unpainted panels on layers with different colours, as a 3D Warehouse model often is.
const parsed = () =>
  makeParsed({
    defs: new Map<number | string, ParsedDefinition>([[1, panelDefinition()]]),
    rootInstances: [
      { refIdx: 1, name: 'OnA', matrix: translation(0, 0, 0), layerId: 10 },
      { refIdx: 1, name: 'OnB', matrix: translation(50, 0, 0), layerId: 20 },
    ],
    layerIdToName: new Map([
      [10, 'LayerA'],
      [20, 'LayerB'],
    ]),
    layerColors: new Map<string, [number, number, number]>([
      ['Layer0', [255, 84, 84]],
      ['LayerA', [255, 0, 0]],
      ['LayerB', [0, 0, 255]],
    ]),
  });

const colours = (materials: unknown[]) =>
  (materials as { pbrMetallicRoughness: { baseColorFactor: number[] } }[]).map((m) =>
    m.pbrMetallicRoughness.baseColorFactor.slice(0, 3).map((v) => Math.round(v * 255)).join(',')
  );

describe('defaultFaceColor', () => {
  it('leaves unpainted faces in their layer colour when not set', () => {
    const scene = buildSceneFromParsed(parsed());
    expect(colours(scene.gltfMaterials).sort()).toEqual(['0,0,255', '255,0,0']);
  });

  it('draws unpainted faces in the given colour, as SketchUp does without "Color by tag"', () => {
    const white = { r: 255, g: 255, b: 255 };
    const baked = buildSceneFromParsed(parsed(), { defaultFaceColor: white });
    expect(colours(baked.gltfMaterials)).toEqual(['255,255,255']);
    const instanced = buildInstancedSceneFromParsed(parsed(), { defaultFaceColor: white });
    expect(colours(instanced.gltfMaterials)).toEqual(['255,255,255']);
    // one colour, so the two placements share one mesh resource again
    expect(instanced.meshResources.length).toBe(1);
  });
});
