/**
 * glTF index-buffer narrowing.
 *
 * Both GLB exporters previously wrote every index as UNSIGNED_INT (4
 * bytes), regardless of how small the primitive was. glTF 2.0 also allows
 * UNSIGNED_SHORT, and every renderer supports it - it is in fact what GPUs
 * prefer, since a 16-bit index buffer halves the bandwidth of the most
 * frequently-fetched buffer in a draw call.
 *
 * Real primitives sit far below the 65,536-vertex limit: across this
 * repository's fixtures the largest is 2,742 vertices, so every primitive
 * qualifies and the index data halves.
 *
 * This is purely an encoding choice at the export boundary. The in-memory
 * `GlbPrimitive.indices` / `LocalPrimitive.indices` stay `Uint32Array`, so
 * no public type changes and no consumer has to care.
 */

/** Largest vertex index addressable by UNSIGNED_SHORT. */
export const UINT16_INDEX_LIMIT = 65535;

/** glTF `componentType` for UNSIGNED_SHORT. */
export const COMPONENT_TYPE_UNSIGNED_SHORT = 5123;
/** glTF `componentType` for UNSIGNED_INT. */
export const COMPONENT_TYPE_UNSIGNED_INT = 5125;

/**
 * The narrowest glTF index encoding that represents `indices` losslessly.
 *
 * Keyed on the largest VALUE present, not on the primitive's vertex count:
 * narrowing is only safe if every index actually stored fits, and keying on
 * the value is correct even if a caller hands over indices that don't start
 * at zero.
 *
 * Returns the componentType alongside a view ready to copy into the binary
 * chunk. When narrowing isn't possible the original array is returned
 * as-is, so the 32-bit path costs no extra allocation.
 */
export function encodeIndices(indices: Uint32Array): {
  componentType: number;
  data: Uint16Array | Uint32Array;
  bytesPerIndex: number;
} {
  let max = 0;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] > max) max = indices[i];
  }

  if (max <= UINT16_INDEX_LIMIT) {
    const narrowed = new Uint16Array(indices.length);
    narrowed.set(indices);
    return {
      componentType: COMPONENT_TYPE_UNSIGNED_SHORT,
      data: narrowed,
      bytesPerIndex: 2,
    };
  }

  return {
    componentType: COMPONENT_TYPE_UNSIGNED_INT,
    data: indices,
    bytesPerIndex: 4,
  };
}

/**
 * Copy a primitive's texture coordinates into a GLB buffer in glTF's
 * convention.
 *
 * The scene's UVs are SketchUp's: V runs UP the image, (0, 0) at its
 * bottom-left corner. glTF's V runs DOWN, (0, 0) at the top-left. Written
 * unchanged - as they were until this was added - every textured face in
 * an exported GLB showed its image upside down in any reader that follows
 * the specification. A tiling wood or brick hides that; a label, a poster
 * or a sign does not.
 *
 * @param target - The GLB's binary buffer
 * @param byteOffset - Where the UVs go; a multiple of 4
 */
export function writeGltfUvs(target: Uint8Array, byteOffset: number, uvs: Float32Array): void {
  const view = new DataView(target.buffer, target.byteOffset + byteOffset, uvs.byteLength);
  for (let i = 0; i < uvs.length; i += 2) {
    view.setFloat32(i * 4, uvs[i], true);
    view.setFloat32(i * 4 + 4, 1 - uvs[i + 1], true);
  }
}
