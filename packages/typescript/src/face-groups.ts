import { triangulateFace3D } from './triangulator';
import { reconstructLoopVertices } from './geometry';
import type { GeometryBuilder } from './geometry';
import { SkpParseError } from './errors';
import { faceUvBasis, computeFaceUv } from './model';
import type { Material, Texture } from './model';

/**
 * One group of faces sharing a single resolved (colour, doubleSided,
 * texture) identity, still in DEFINITION-LOCAL space (inches, SketchUp
 * Z-up) - i.e. exactly what the baked scene builder assembles just before
 * it applies an instance's world matrix.
 *
 * Shared by the baked path (`buildSceneFromParsed`, which then transforms
 * these into world space) and the instanced path
 * (`buildInstancedSceneFromParsed`, which keeps them local and puts the
 * transform on the node instead). Keeping one implementation is what makes
 * the two paths agree on triangulation, UV seams, normals and front/back
 * handling by construction rather than by parallel maintenance.
 */
export interface LocalFaceGroup {
  color: { r: number; g: number; b: number };
  /** The resolved material's opacity: `1.0` fully opaque, `0.0` fully
   * invisible. Carried through so the exported glTF material can declare a
   * real alpha instead of always claiming fully opaque. */
  transparency: number;
  doubleSided: boolean;
  /** Local-space vertex positions, inches, SketchUp Z-up. */
  localVerts: [number, number, number][];
  localUvs: [number, number][];
  /** Un-normalised summed face normals per vertex, local space. A corner
   * on a smoothed surface carries that surface's averaged normal instead
   * (see {@link smoothCornerNormals}). */
  normalsAccum: number[][];
  localFaces: number[][];
  /** Source vertex id -> the output vertices already made from it. One
   * source vertex becomes several output vertices when the faces around it
   * disagree on UV or on which smoothed surface they belong to; the list
   * is searched for one that matches before a new one is added. */
  vertexIndex: Map<number, number[]>;
  /** Per output vertex: the smoothed surface it belongs to, or -1. */
  smoothRoots: number[];
  textureIndex: number | null;
}

/** Equality as `${a}` === `${b}` had it: NaN equals NaN. */
function sameNumber(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

/** Everything the grouping needs from its caller that isn't the builder
 * itself: how a material id resolves, how a texture maps to a scene
 * texture index, and the colour to fall back to for an unpainted face. */
export interface FaceGroupContext {
  resolveMaterial: (matId: number | null | undefined) => Material | undefined;
  textureIndexFor: (tex: Texture | null | undefined) => number | null;
  /** Painted-instance material inherited from the enclosing instance, if any. */
  inheritedMaterial?: Material;
  /** Colour an unpainted face falls back to when nothing is inherited
   * (the effective layer's colour). */
  fallbackLayerColor: { r: number; g: number; b: number };
  /** Identifies the definition in a triangulation failure. */
  definitionId: number | string;
  /** Skip faces SketchUp itself would not draw (see
   * {@link SceneOptions.respectEdgeVisibility}). Off by default, matching
   * the behaviour every existing consumer already relies on. */
  respectVisibility?: boolean;
  /** Emit each face once with its front material (see
   * {@link SceneOptions.frontSideOnly}). */
  frontSideOnly?: boolean;
}

/** A corner (vertex of one face) on a smoothed surface: the surface it
 * belongs to and that surface's unit normal at the vertex. */
interface SmoothCorner {
  root: number;
  n: [number, number, number];
}

/** Edge display-flag bit SketchUp sets on an edge whose faces render as one
 * smooth surface (Soften/Smooth Edges' "Smooth normals"). */
const SMOOTH_EDGE = 0x10;

/**
 * Per-corner normals across smooth edges.
 *
 * SketchUp renders the faces either side of an edge flagged smooth as one
 * continuous surface: their shared vertices get the average of the faces'
 * normals, while a hard edge keeps a crease. Corners (vertex, face) joined
 * through a smooth edge between two faces that face the same way are merged
 * into one surface, and each surface's normal at a vertex is the normalised
 * sum of its faces' normals. Returns null when the definition has no smooth
 * edge, so a faceted model pays nothing.
 */
function smoothCornerNormals(
  builder: GeometryBuilder,
  ctx: FaceGroupContext
): ((vId: number, fId: number) => SmoothCorner | null) | null {
  const edgeFaces = new Map<number, number[]>();
  for (const [fId, face] of builder.faces.entries()) {
    if (ctx.respectVisibility && face.hidden) continue;
    for (const loop of face.loops) {
      for (const { edgeId } of loop) {
        if (((builder.edgeFlags.get(edgeId) ?? 0) & SMOOTH_EDGE) === 0) continue;
        let faces = edgeFaces.get(edgeId);
        if (!faces) edgeFaces.set(edgeId, (faces = []));
        if (!faces.includes(fId)) faces.push(fId);
      }
    }
  }
  if (edgeFaces.size === 0) return null;

  // Corners are numbered as they are first seen and the union-find runs
  // over those numbers. Keying it by a "vertex:face" string, as this used
  // to, built and hashed a string for every corner of every face on every
  // lookup - a large share of the time spent building a curved model.
  const cornerIndex = new Map<number, Map<number, number>>();
  const parent: number[] = [];
  const cornerFace: number[] = [];
  const touch = (vId: number, fId: number): number => {
    let byFace = cornerIndex.get(vId);
    if (!byFace) cornerIndex.set(vId, (byFace = new Map()));
    let index = byFace.get(fId);
    if (index === undefined) {
      index = parent.length;
      parent.push(index);
      cornerFace.push(fId);
      byFace.set(fId, index);
    }
    return index;
  };
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  for (const [edgeId, faces] of edgeFaces) {
    if (faces.length !== 2) continue;
    const ends = builder.edges.get(edgeId);
    if (!ends) continue;
    const a = builder.faces.get(faces[0])!.normal;
    const b = builder.faces.get(faces[1])!.normal;
    // Faces that face opposite ways across the edge (a fold or a reversed
    // face) would cancel each other's normal out.
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] <= 0) continue;
    for (const vId of ends) {
      if (vId === null) continue;
      const left = find(touch(vId, faces[0]));
      const right = find(touch(vId, faces[1]));
      if (left !== right) parent[left] = right;
    }
  }

  // Summed in the order the corners were first seen, as before, so the
  // floating-point result is bit-for-bit what it was.
  const sums = new Map<number, [number, number, number]>();
  for (let index = 0; index < parent.length; index++) {
    const normal = builder.faces.get(cornerFace[index])!.normal;
    const root = find(index);
    const sum = sums.get(root);
    if (sum) {
      sum[0] += normal[0];
      sum[1] += normal[1];
      sum[2] += normal[2];
    } else {
      sums.set(root, [normal[0], normal[1], normal[2]]);
    }
  }
  // One result per surface, shared by all its corners: callers only read it.
  const corners = new Map<number, SmoothCorner>();
  return (vId, fId) => {
    const index = cornerIndex.get(vId)?.get(fId);
    if (index === undefined) return null;
    const root = find(index);
    let corner = corners.get(root);
    if (!corner) {
      const sum = sums.get(root)!;
      const length = Math.hypot(sum[0], sum[1], sum[2]) || 1;
      corner = { root, n: [sum[0] / length, sum[1] / length, sum[2] / length] };
      corners.set(root, corner);
    }
    return corner;
  };
}

/**
 * Group a definition's faces by resolved material identity, in local space.
 *
 * A face whose front/back resolve to the SAME colour is emitted once with
 * `doubleSided` set; a face whose sides genuinely differ is emitted as two
 * single-sided triangle sets (one normal-wound front, one reverse-wound
 * back) so each side keeps its own colour - unless `ctx.frontSideOnly`,
 * which always takes the first branch with the front material.
 *
 * Vertices on a surface SketchUp smooths take that surface's normal, so
 * curved geometry shades smoothly instead of faceted.
 */
export function buildLocalFaceGroups(
  builder: GeometryBuilder,
  ctx: FaceGroupContext
): Map<string, LocalFaceGroup> {
  const faceGroups = new Map<string, LocalFaceGroup>();
  const smoothCorner = smoothCornerNormals(builder, ctx);

  const addSide = (
    triangles: number[][],
    fn: [number, number, number],
    color: { r: number; g: number; b: number; a?: number },
    doubleSided: boolean,
    reverse: boolean,
    mat: Material | undefined,
    uvTransform: number[] | null | undefined,
    xr: [number, number, number],
    yr: [number, number, number],
    fId: number
  ) => {
    // faces are batched per emitted material, so the texture has to be
    // part of the key too - otherwise two differently-textured faces with
    // the same average colour end up in one primitive with one image
    const texIndex = ctx.textureIndexFor(mat?.texture);
    // Two independent SketchUp mechanisms can reduce a material's opacity:
    // the plain RGBA colour record's alpha byte (older/simple materials,
    // and what the writer's addMaterial(rgba) sets), and the newer XML
    // material definition's own `trans`/`useTrans` attribute (surfaced as
    // Material.transparency, already resolved - see parser.test.ts's
    // "useTrans gating" tests). A real file only ever populates one of the
    // two for a given material, but multiplying both is safe either way:
    // the untouched one defaults to fully-opaque (255 / 1.0), so it never
    // silently darkens a material that only used the other mechanism.
    const colorAlpha = color.a !== undefined ? color.a / 255 : 1.0;
    const transparency = colorAlpha * (mat?.transparency ?? 1.0);
    const colorKey = `${color.r},${color.g},${color.b},${doubleSided},${texIndex ?? -1},${transparency}`;
    let group = faceGroups.get(colorKey);
    if (!group) {
      group = {
        color,
        transparency,
        doubleSided,
        textureIndex: texIndex,
        localVerts: [],
        localUvs: [],
        normalsAccum: [],
        localFaces: [],
        vertexIndex: new Map<number, number[]>(),
        smoothRoots: [],
      };
      faceGroups.set(colorKey, group);
    }

    const tex = mat?.texture;
    const tileW = tex && tex.width > 1e-9 ? tex.width : 1;
    const tileH = tex && tex.height > 1e-9 ? tex.height : 1;
    const sideNormal: [number, number, number] = reverse
      ? [-fn[0], -fn[1], -fn[2]]
      : fn;

    // Vertices are deduped per (vId, uv) rather than just vId: UVs are
    // inherently per-face, so a vertex position shared by two faces
    // that disagree on texture mapping must become two distinct
    // output vertices (glTF requires position/normal/uv aligned per
    // index).
    const faceLocalMap = new Map<number, number>();
    for (const tri of triangles) {
      const triIds = reverse ? [tri[0], tri[2], tri[1]] : tri;
      const faceIndices: number[] = [];
      for (const vId of triIds) {
        if (!builder.vertices.has(vId)) continue;
        let idx = faceLocalMap.get(vId);
        if (idx === undefined) {
          const p = builder.vertices.get(vId)!;
          const [u, v] = computeFaceUv(p, xr, yr, uvTransform, tileW, tileH);
          // A smoothed corner shares its vertex only with corners of the
          // same surface: a hard edge between two smoothed surfaces still
          // splits the vertex so each side keeps its own normal.
          const smooth = smoothCorner?.(vId, fId) ?? null;
          const normal: [number, number, number] = smooth
            ? reverse
              ? [-smooth.n[0], -smooth.n[1], -smooth.n[2]]
              : smooth.n
            : sideNormal;
          // An output vertex is reused only by a corner with the same
          // source vertex, the same UV and the same smoothed surface.
          // Compared as numbers: this used to format all of them into a
          // string key for every corner of every triangle.
          const root = smooth ? smooth.root : -1;
          let candidates = group.vertexIndex.get(vId);
          if (!candidates) group.vertexIndex.set(vId, (candidates = []));
          idx = undefined;
          for (let c = 0; c < candidates.length; c++) {
            const candidate = candidates[c];
            const uv = group.localUvs[candidate];
            if (group.smoothRoots[candidate] === root && sameNumber(uv[0], u) && sameNumber(uv[1], v)) {
              idx = candidate;
              break;
            }
          }
          if (idx === undefined) {
            group.localVerts.push(p);
            group.localUvs.push([u, v]);
            group.normalsAccum.push([normal[0], normal[1], normal[2]]);
            group.smoothRoots.push(root);
            idx = group.localVerts.length - 1;
            candidates.push(idx);
          } else {
            const accum = group.normalsAccum[idx];
            accum[0] += normal[0];
            accum[1] += normal[1];
            accum[2] += normal[2];
          }
          faceLocalMap.set(vId, idx);
        }
        faceIndices.push(idx);
      }
      if (faceIndices.length === 3) {
        group.localFaces.push(faceIndices);
      }
    }
  };

  for (const [fId, fData] of builder.faces.entries()) {
    // A face explicitly hidden in SketchUp. Skipped only on request: the
    // baked output every existing consumer reads includes these, so
    // filtering by default would silently change what they render.
    if (ctx.respectVisibility && fData.hidden) continue;

    const fallbackColor = ctx.inheritedMaterial?.color ?? ctx.fallbackLayerColor;

    // A face with no material of its own is painted by the instance
    // (SketchUp's "paint the component"). Inheriting the whole material -
    // not just its colour - is what gives computeFaceUv the texture's tile
    // size: without it tileW/tileH fall back to 1 and the UVs come out in
    // raw inches, so a 1.9 m decor sheet tiles ~150 times across a 600 mm
    // panel instead of covering a third of it.
    const frontMat = ctx.resolveMaterial((fData as any).materialId) ?? ctx.inheritedMaterial;
    const backMat = ctx.resolveMaterial((fData as any).backMaterialId) ?? ctx.inheritedMaterial;
    const frontColor = frontMat?.color ?? fallbackColor;
    const backColor = backMat?.color ?? fallbackColor;

    const loops: number[][] = [];
    for (const loop of fData.loops) {
      const loopVerts = reconstructLoopVertices(loop, builder.edges);
      if (loopVerts.length > 0) {
        loops.push(loopVerts);
      }
    }
    if (loops.length === 0) continue;

    let triangles;
    try {
      triangles = triangulateFace3D(builder.vertices, loops, fData.normal);
    } catch (e) {
      throw new SkpParseError(`Failed to triangulate face: ${(e as Error).message}`, {
        stage: 'build_scene',
        definitionId: ctx.definitionId,
        cause: e,
      });
    }

    const fn = fData.normal as [number, number, number];
    const { xr, yr } = faceUvBasis(fn);
    const uvTransform = (fData as any).uvTransform as number[] | null | undefined;
    const uvTransformBack = (fData as any).uvTransformBack as number[] | null | undefined;

    const sameColor =
      frontColor.r === backColor.r && frontColor.g === backColor.g && frontColor.b === backColor.b;
    if (sameColor || ctx.frontSideOnly) {
      addSide(triangles, fn, frontColor, true, false, frontMat, uvTransform, xr, yr, fId);
    } else {
      addSide(triangles, fn, frontColor, false, false, frontMat, uvTransform, xr, yr, fId);
      addSide(triangles, fn, backColor, false, true, backMat, uvTransformBack, xr, yr, fId);
    }
  }

  return faceGroups;
}
