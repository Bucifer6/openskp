import type { InstancedScene, InstancedNode, InstancedMeshResource, LocalPrimitive } from './instanced';

/**
 * Making a model lighter to draw.
 *
 * A SketchUp model is as heavy as its heaviest downloaded component. On a
 * real 120 MB interior, 15 of 1,218 components held 80% of the triangles
 * drawn, and one of them - a cell of expanded steel mesh, 1,024 triangles,
 * placed 1,113 times - held half the model on its own. None of that detail
 * is visible from across the room, and all of it is drawn every frame.
 *
 * {@link simplifyInstancedScene} reduces such geometry and leaves the rest
 * alone: a wall is already two triangles and comes out unchanged.
 */

/** How much to take away. See {@link SimplifyOptions.detail}. */
export type DetailLevel = 'high' | 'medium' | 'low';

export interface SimplifyOptions {
  /**
   * A preset for the two settings below.
   *
   * - `'high'`: 2 mm tolerance, nothing removed. Close to indistinguishable.
   * - `'medium'` (default): 6 mm tolerance, objects under 1 cm removed.
   * - `'low'`: 2 cm tolerance, objects under 3 cm removed. For overviews
   *   and weak devices.
   */
  detail?: DetailLevel;
  /**
   * The largest distance, in metres, a surface may move. Features smaller
   * than this merge together or disappear. Overrides the preset.
   *
   * Never applied at more than 1/400 of the scene's own size, so a small
   * object modelled on its own (a chair, a watch) keeps its shape under a
   * tolerance meant for buildings.
   */
  tolerance?: number;
  /**
   * Placed objects whose largest extent is under this many metres are left
   * out: screws, handles' fixings, the contents of drawers. Overrides the
   * preset; 0 keeps everything.
   */
  minObjectSize?: number;
  /**
   * Components with fewer triangles than this are not touched at all
   * (default 200): there is nothing to gain, and plain architecture -
   * walls, slabs, panels - stays exactly as modelled.
   */
  minTriangles?: number;
}

/** What {@link simplifyInstancedScene} did. Triangle counts are of what is
 * drawn: a component's triangles times the number of times it is placed. */
export interface SimplifyStats {
  trianglesBefore: number;
  trianglesAfter: number;
  placementsBefore: number;
  placementsAfter: number;
  /** Components whose geometry was reduced. */
  componentsSimplified: number;
  /** The tolerance actually used, metres, after the scene-size limit. */
  tolerance: number;
}

const PRESETS: Record<DetailLevel, { tolerance: number; minObjectSize: number }> = {
  high: { tolerance: 0.002, minObjectSize: 0 },
  medium: { tolerance: 0.006, minObjectSize: 0.01 },
  low: { tolerance: 0.02, minObjectSize: 0.03 },
};

/** Column-major 4x4 product `a * b`, as glTF and {@link InstancedNode.matrix} use. */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** The largest factor by which the matrix stretches a length. */
function maxScale(m: number[]): number {
  return Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
}

interface ResourceInfo {
  min: [number, number, number];
  max: [number, number, number];
  diagonal: number;
  triangles: number;
}

function measure(resource: InstancedMeshResource): ResourceInfo {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const prim of resource.primitives) {
    const p = prim.positions;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < min[0]) min[0] = p[i];
      if (p[i] > max[0]) max[0] = p[i];
      if (p[i + 1] < min[1]) min[1] = p[i + 1];
      if (p[i + 1] > max[1]) max[1] = p[i + 1];
      if (p[i + 2] < min[2]) min[2] = p[i + 2];
      if (p[i + 2] > max[2]) max[2] = p[i + 2];
    }
    triangles += prim.indices.length / 3;
  }
  const diagonal = triangles > 0 ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
  return { min, max, diagonal, triangles };
}

function surfaceArea(primitives: LocalPrimitive[]): number {
  let area = 0;
  for (const prim of primitives) {
    const p = prim.positions;
    const idx = prim.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3;
      const b = idx[i + 1] * 3;
      const c = idx[i + 2] * 3;
      const ux = p[b] - p[a];
      const uy = p[b + 1] - p[a + 1];
      const uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a];
      const vy = p[c + 1] - p[a + 1];
      const vz = p[c + 2] - p[a + 2];
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
  }
  return area;
}

/**
 * Reduce one component by vertex clustering: lay a grid of `cell`-sized
 * cubes over it, merge the vertices that share a cube into one at their
 * average position, and drop the triangles that collapse.
 *
 * The grid and the merged positions are shared by all the component's
 * primitives, so a seam between two materials stays closed. Within a cube,
 * vertices facing clearly different ways stay separate, which keeps a hard
 * edge hard instead of shading it round.
 */
function clusterResource(primitives: LocalPrimitive[], info: ResourceInfo, cell: number): LocalPrimitive[] {
  const nx = Math.floor((info.max[0] - info.min[0]) / cell) + 1;
  const ny = Math.floor((info.max[1] - info.min[1]) / cell) + 1;

  // Pass 1: every vertex of every primitive, to find each cube's average.
  const cellSlot = new Map<number, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  const vertexCells: Int32Array[] = [];
  for (const prim of primitives) {
    const p = prim.positions;
    const slots = new Int32Array(p.length / 3);
    for (let v = 0; v < slots.length; v++) {
      const x = p[v * 3];
      const y = p[v * 3 + 1];
      const z = p[v * 3 + 2];
      const key =
        Math.floor((x - info.min[0]) / cell) +
        nx * (Math.floor((y - info.min[1]) / cell) + ny * Math.floor((z - info.min[2]) / cell));
      let slot = cellSlot.get(key);
      if (slot === undefined) {
        slot = counts.length;
        cellSlot.set(key, slot);
        counts.push(0);
        sums.push(0, 0, 0);
      }
      counts[slot]++;
      sums[slot * 3] += x;
      sums[slot * 3 + 1] += y;
      sums[slot * 3 + 2] += z;
      slots[v] = slot;
    }
    vertexCells.push(slots);
  }

  const out: LocalPrimitive[] = [];
  for (let primIndex = 0; primIndex < primitives.length; primIndex++) {
    const prim = primitives[primIndex];
    const slots = vertexCells[primIndex];
    const hasUvs = prim.uvs.length === (prim.positions.length / 3) * 2;

    // Pass 2: one output vertex per (cube, facing direction).
    const outSlot = new Map<number, number>();
    const remap = new Int32Array(slots.length);
    const outCell: number[] = [];
    const normalSum: number[] = [];
    const uvSum: number[] = [];
    const members: number[] = [];
    for (let v = 0; v < slots.length; v++) {
      const nxv = prim.normals[v * 3];
      const nyv = prim.normals[v * 3 + 1];
      const nzv = prim.normals[v * 3 + 2];
      // Facing direction in steps of about 30 degrees: 5 levels per axis.
      const facing = (Math.round(nxv * 2) + 2) * 25 + (Math.round(nyv * 2) + 2) * 5 + (Math.round(nzv * 2) + 2);
      const key = slots[v] * 125 + facing;
      let index = outSlot.get(key);
      if (index === undefined) {
        index = outCell.length;
        outSlot.set(key, index);
        outCell.push(slots[v]);
        normalSum.push(0, 0, 0);
        uvSum.push(0, 0);
        members.push(0);
      }
      normalSum[index * 3] += nxv;
      normalSum[index * 3 + 1] += nyv;
      normalSum[index * 3 + 2] += nzv;
      if (hasUvs) {
        uvSum[index * 2] += prim.uvs[v * 2];
        uvSum[index * 2 + 1] += prim.uvs[v * 2 + 1];
      }
      members[index]++;
      remap[v] = index;
    }

    // Triangles: gone when two corners landed in one cube, and kept once
    // when several became the same triangle.
    const seen = new Set<string>();
    const indices: number[] = [];
    const src = prim.indices;
    for (let i = 0; i < src.length; i += 3) {
      const a = remap[src[i]];
      const b = remap[src[i + 1]];
      const c = remap[src[i + 2]];
      const ca = outCell[a];
      const cb = outCell[b];
      const cc = outCell[c];
      if (ca === cb || cb === cc || ca === cc) continue;
      // Rotated to start at its smallest corner: the same triangle with
      // the same winding always produces the same key.
      const key = a < b && a < c ? `${a},${b},${c}` : b < c ? `${b},${c},${a}` : `${c},${a},${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      indices.push(a, b, c);
    }
    if (indices.length === 0) continue;

    // Only the vertices some surviving triangle still uses.
    const finalIndex = new Int32Array(outCell.length).fill(-1);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    for (let i = 0; i < indices.length; i++) {
      const old = indices[i];
      let index = finalIndex[old];
      if (index === -1) {
        index = positions.length / 3;
        finalIndex[old] = index;
        const slot = outCell[old];
        positions.push(sums[slot * 3] / counts[slot], sums[slot * 3 + 1] / counts[slot], sums[slot * 3 + 2] / counts[slot]);
        const sx = normalSum[old * 3];
        const sy = normalSum[old * 3 + 1];
        const sz = normalSum[old * 3 + 2];
        const length = Math.hypot(sx, sy, sz);
        if (length > 1e-9) normals.push(sx / length, sy / length, sz / length);
        else normals.push(0, 1, 0);
        if (hasUvs) uvs.push(uvSum[old * 2] / members[old], uvSum[old * 2 + 1] / members[old]);
        else uvs.push(0, 0);
      }
      indices[i] = index;
    }

    out.push({
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
      materialIndex: prim.materialIndex,
    });
  }
  return out;
}

/**
 * Return a lighter copy of an instanced scene. The scene passed in is not
 * changed, and anything not reduced is shared with it rather than copied.
 *
 * Two things are done, both controlled by {@link SimplifyOptions}:
 *
 * - **Dense components are reduced** by vertex clustering to the given
 *   tolerance. This is what a heavy model needs: its weight is in a few
 *   detailed components placed many times, and reducing one reduces every
 *   placement of it.
 * - **Very small objects are left out.**
 *
 * What it does not do, stated plainly: this is not a quality-preserving
 * decimator. At a loose tolerance, curved surfaces show facets and small
 * parts turn into blocks; texture mapping on reduced components is
 * approximate. A thin part that would vanish altogether (a cable, a mesh
 * sheet) is reduced less instead, or kept as it was, rather than lost.
 * It is meant for viewing a model, not for measuring or re-editing it.
 */
export function simplifyInstancedScene(
  scene: InstancedScene,
  options?: SimplifyOptions
): { scene: InstancedScene; stats: SimplifyStats } {
  const preset = PRESETS[options?.detail ?? 'medium'];
  if (!preset) throw new Error(`Unknown detail level: ${String(options?.detail)}`);
  const requestedTolerance = options?.tolerance ?? preset.tolerance;
  const minObjectSize = options?.minObjectSize ?? preset.minObjectSize;
  const minTriangles = options?.minTriangles ?? 200;
  if (!(requestedTolerance >= 0) || !(minObjectSize >= 0)) {
    throw new Error('tolerance and minObjectSize must be zero or positive');
  }

  const sceneDiagonal = scene.bounds ? Math.hypot(scene.bounds.size[0], scene.bounds.size[1], scene.bounds.size[2]) : 0;
  const tolerance = sceneDiagonal > 0 ? Math.min(requestedTolerance, sceneDiagonal / 400) : requestedTolerance;

  const infos = new Map<string, ResourceInfo>();
  for (const resource of scene.meshResources) infos.set(resource.id, measure(resource));

  // Walk the placed tree once: how often each component is placed and at
  // what scale, and which placements are too small to keep.
  const useCount = new Map<string, number>();
  const largestScale = new Map<string, number>();
  let placementsBefore = 0;
  let placementsAfter = 0;
  let trianglesBefore = 0;

  const copyNode = (node: InstancedNode, parentMatrix: number[] | null, isRoot: boolean): InstancedNode => {
    const world = parentMatrix ? multiply(parentMatrix, node.matrix) : node.matrix;
    const copy: InstancedNode = { ...node, children: [] };
    const info = node.meshResourceId !== undefined ? infos.get(node.meshResourceId) : undefined;
    if (info && node.meshResourceId !== undefined) {
      placementsBefore++;
      trianglesBefore += info.triangles;
      const scale = maxScale(world);
      // The model's own loose geometry is not "an object": it stays.
      if (!isRoot && minObjectSize > 0 && info.diagonal * scale < minObjectSize) {
        delete copy.meshResourceId;
      } else {
        placementsAfter++;
        useCount.set(node.meshResourceId, (useCount.get(node.meshResourceId) ?? 0) + 1);
        largestScale.set(node.meshResourceId, Math.max(largestScale.get(node.meshResourceId) ?? 0, scale));
      }
    }
    for (const child of node.children) copy.children.push(copyNode(child, world, false));
    return copy;
  };
  const sceneHierarchy = copyNode(scene.sceneHierarchy, null, true);

  let componentsSimplified = 0;
  let trianglesAfter = 0;
  const emptied = new Set<string>();
  const meshResources: InstancedMeshResource[] = [];
  for (const resource of scene.meshResources) {
    const uses = useCount.get(resource.id) ?? 0;
    if (uses === 0) continue; // every placement was removed
    const info = infos.get(resource.id)!;
    let primitives = resource.primitives;

    if (tolerance > 0 && info.triangles >= minTriangles) {
      // The tolerance is a distance in the scene; a component placed at
      // twice its size may only move half as far in its own space.
      const scale = largestScale.get(resource.id) || 1;
      let cell = tolerance / scale;
      const areaBefore = surfaceArea(primitives);
      // A thin part can lose nearly all its surface to a grid coarser than
      // it is thick. Rather than let it vanish, try a finer grid, and
      // failing that leave the component as it was.
      for (let attempt = 0; attempt < 4; attempt++) {
        // A grid finer than the part's own vertices changes nothing.
        if (info.diagonal / cell > 4096) break;
        const reduced = clusterResource(primitives, info, cell);
        const reducedTriangles = reduced.reduce((sum, prim) => sum + prim.indices.length / 3, 0);
        if (reducedTriangles > 0 && surfaceArea(reduced) >= 0.5 * areaBefore) {
          if (reducedTriangles < info.triangles) {
            primitives = reduced;
            componentsSimplified++;
          }
          break;
        }
        cell /= 2;
      }
    }

    const triangles = primitives.reduce((sum, prim) => sum + prim.indices.length / 3, 0);
    if (triangles === 0) {
      emptied.add(resource.id);
      continue;
    }
    trianglesAfter += triangles * uses;
    meshResources.push(primitives === resource.primitives ? resource : { ...resource, primitives });
  }

  if (emptied.size > 0) {
    const strip = (node: InstancedNode) => {
      if (node.meshResourceId !== undefined && emptied.has(node.meshResourceId)) {
        delete node.meshResourceId;
        placementsAfter--;
      }
      node.children.forEach(strip);
    };
    strip(sceneHierarchy);
  }

  return {
    scene: { ...scene, sceneHierarchy, meshResources },
    stats: { trianglesBefore, trianglesAfter, placementsBefore, placementsAfter, componentsSimplified, tolerance },
  };
}
