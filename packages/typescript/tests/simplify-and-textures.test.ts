import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzlibSync } from 'fflate';
import {
  SkpFile,
  create,
  buildInstancedScene,
  buildScene,
  simplifyInstancedScene,
  toInstancedGLB,
  toGLB,
  decodeTiff,
  encodePng,
  convertTextureToPng,
} from '../src/index';
import type { InstancedScene, InstancedNode } from '../src/index';
import { downscaleImage, isTiff } from '../src/image-convert';
import { parseDimensions } from '../src/pages-dimensions';

const FIXTURES = path.join(__dirname, 'fixtures');

// ── helpers ────────────────────────────────────────────────────────────

function drawnTriangles(scene: InstancedScene): number {
  const per = new Map(scene.meshResources.map((r) => [r.id, r.primitives.reduce((s, p) => s + p.indices.length / 3, 0)]));
  let total = 0;
  const walk = (node: InstancedNode) => {
    if (node.meshResourceId) total += per.get(node.meshResourceId) ?? 0;
    node.children.forEach(walk);
  };
  walk(scene.sceneHierarchy);
  return total;
}

function countPlacements(scene: InstancedScene): number {
  let total = 0;
  const walk = (node: InstancedNode) => {
    if (node.meshResourceId) total++;
    node.children.forEach(walk);
  };
  walk(scene.sceneHierarchy);
  return total;
}

/** A UV sphere, as a face list in inches. */
function sphereFaces(radius: number, segments: number, center: [number, number, number]) {
  const point = (i: number, j: number): [number, number, number] => {
    const theta = (Math.PI * i) / segments;
    const phi = (2 * Math.PI * j) / segments;
    return [
      center[0] + radius * Math.sin(theta) * Math.cos(phi),
      center[1] + radius * Math.sin(theta) * Math.sin(phi),
      center[2] + radius * Math.cos(theta),
    ];
  };
  const faces: [number, number, number][][] = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segments; j++) {
      const a = point(i, j);
      const b = point(i + 1, j);
      const c = point(i + 1, j + 1);
      const d = point(i, j + 1);
      if (i > 0) faces.push([a, b, d]);
      if (i < segments - 1) faces.push([b, c, d]);
    }
  }
  return faces;
}

/** A model with a dense sphere placed four times, one tiny screw-sized
 * part, and a plain 400 inch (10 m) square "floor" - big enough that the
 * presets' tolerances apply as given, not their small-model limit. */
function denseModel(): Uint8Array {
  const builder = create();
  const ball = builder.addComponentDefinition('Ball', (def) => {
    for (const face of sphereFaces(10, 56, [0, 0, 0])) def.addFace(face);
  });
  const screw = builder.addComponentDefinition('Screw', (def) => {
    def.addFace([
      [0, 0, 0],
      [0.1, 0, 0],
      [0.1, 0.1, 0],
      [0, 0.1, 0],
    ]);
  });
  for (let i = 0; i < 4; i++) builder.addInstance(ball, { translation: [i * 40, 0, 20] });
  builder.addInstance(screw, { translation: [0, 60, 0] });
  builder.addFace([
    [0, 0, 0],
    [400, 0, 0],
    [400, 400, 0],
    [0, 400, 0],
  ]);
  return builder.toBytes();
}

/** A minimal little-endian TIFF: 8-bit RGB (or RGBA), one strip. */
function makeTiff(
  width: number,
  height: number,
  pixels: Uint8Array,
  options: { compression?: number; samples?: number; predictor?: number } = {}
): Uint8Array {
  const samples = options.samples ?? 3;
  const compression = options.compression ?? 1;
  const entries: [number, number, number, number][] = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [259, 3, 1, compression],
    [262, 3, 1, 2],
    [277, 3, 1, samples],
    [278, 3, 1, height],
    [284, 3, 1, 1],
  ];
  if (options.predictor) entries.push([317, 3, 1, options.predictor]);
  // BitsPerSample needs `samples` shorts: stored after the IFD when > 2.
  const ifdOffset = 8;
  const entryCount = entries.length + 3; // + bits, strip offsets, strip byte counts
  const afterIfd = ifdOffset + 2 + entryCount * 12 + 4;
  const bitsOffset = afterIfd;
  const dataOffset = bitsOffset + samples * 2;
  entries.push([258, 3, samples, bitsOffset]);
  entries.push([273, 4, 1, dataOffset]);
  entries.push([279, 4, 1, pixels.length]);
  entries.sort((a, b) => a[0] - b[0]);

  const out = new Uint8Array(dataOffset + pixels.length);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0], 0);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const at = ifdOffset + 2 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  for (let i = 0; i < samples; i++) view.setUint16(bitsOffset + i * 2, 8, true);
  out.set(pixels, dataOffset);
  return out;
}

function gradient(width: number, height: number, samples = 3): Uint8Array {
  const pixels = new Uint8Array(width * height * samples);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * samples;
      pixels[i] = (x * 255) / Math.max(1, width - 1);
      pixels[i + 1] = (y * 255) / Math.max(1, height - 1);
      pixels[i + 2] = (x * 7 + y * 3) & 0xff;
      if (samples === 4) pixels[i + 3] = x < width / 2 ? 255 : 128;
    }
  }
  return pixels;
}

/** Read back what encodePng wrote (filter type 0 only). */
function decodeSimplePng(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const channels = png[25] === 6 ? 4 : 3;
  let pos = 8;
  const idat: Uint8Array[] = [];
  while (pos < png.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + length));
    pos += 12 + length;
  }
  const raw = unzlibSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * channels + 1)]).toBe(0);
    rows.push(raw.subarray(y * (width * channels + 1) + 1, (y + 1) * (width * channels + 1)));
  }
  return { width, height, channels, rows };
}

// ── simplification ─────────────────────────────────────────────────────

describe('simplifyInstancedScene', () => {
  const scene = buildInstancedScene(denseModel());

  it('reduces dense components and leaves plain geometry exactly as it was', () => {
    const { scene: light, stats } = simplifyInstancedScene(scene, { detail: 'low' });

    expect(stats.trianglesBefore).toBe(drawnTriangles(scene));
    expect(stats.trianglesAfter).toBe(drawnTriangles(light));
    expect(stats.trianglesAfter).toBeLessThan(stats.trianglesBefore * 0.75);
    expect(stats.componentsSimplified).toBe(1);

    // The wall is the model's own loose geometry: same object, untouched.
    const rootId = scene.sceneHierarchy.meshResourceId!;
    const before = scene.meshResources.find((r) => r.id === rootId)!;
    const after = light.meshResources.find((r) => r.id === rootId)!;
    expect(after).toBe(before);
  });

  it('reduces a component once for all of its placements', () => {
    const { scene: light } = simplifyInstancedScene(scene, { detail: 'low' });
    const ball = light.meshResources.find((r) => r.definitionName === 'Ball')!;
    const uses = light.sceneHierarchy.children.filter((n) => n.meshResourceId === ball.id);
    expect(uses.length).toBe(4);
    expect(light.meshResources.filter((r) => r.definitionName === 'Ball').length).toBe(1);
  });

  it('keeps the reduced shape within the tolerance and its data well formed', () => {
    const tolerance = 0.02;
    const { scene: light } = simplifyInstancedScene(scene, { tolerance, minObjectSize: 0 });
    const ball = light.meshResources.find((r) => r.definitionName === 'Ball')!;
    const radius = 10 * 0.0254;
    for (const prim of ball.primitives) {
      const vertexCount = prim.positions.length / 3;
      expect(prim.normals.length).toBe(vertexCount * 3);
      expect(prim.uvs.length).toBe(vertexCount * 2);
      expect(prim.indices.length % 3).toBe(0);
      for (const index of prim.indices) expect(index).toBeLessThan(vertexCount);
      for (let v = 0; v < vertexCount; v++) {
        const distance = Math.hypot(prim.positions[v * 3], prim.positions[v * 3 + 1], prim.positions[v * 3 + 2]);
        expect(Math.abs(distance - radius)).toBeLessThan(tolerance);
        const normal = Math.hypot(prim.normals[v * 3], prim.normals[v * 3 + 1], prim.normals[v * 3 + 2]);
        expect(normal).toBeCloseTo(1, 4);
      }
      // No triangle has two corners at the same place.
      for (let i = 0; i < prim.indices.length; i += 3) {
        const [a, b, c] = [prim.indices[i], prim.indices[i + 1], prim.indices[i + 2]];
        expect(a !== b && b !== c && a !== c).toBe(true);
      }
    }
  });

  it('leaves out objects below the minimum size, and only those', () => {
    const kept = simplifyInstancedScene(scene, { tolerance: 0, minObjectSize: 0 });
    expect(kept.stats.placementsAfter).toBe(kept.stats.placementsBefore);
    expect(kept.stats.trianglesAfter).toBe(kept.stats.trianglesBefore);

    const dropped = simplifyInstancedScene(scene, { tolerance: 0, minObjectSize: 0.01 });
    expect(dropped.stats.placementsAfter).toBe(dropped.stats.placementsBefore - 1);
    expect(countPlacements(dropped.scene)).toBe(dropped.stats.placementsAfter);
    expect(dropped.scene.meshResources.some((r) => r.definitionName === 'Screw')).toBe(false);
    // The node is still there, with its name and children: only its mesh is gone.
    expect(dropped.scene.sceneHierarchy.children.length).toBe(scene.sceneHierarchy.children.length);
  });

  it('does not change the scene it was given', () => {
    const before = JSON.stringify(scene.sceneHierarchy);
    const positions = scene.meshResources.map((r) => r.primitives.map((p) => p.positions.slice()));
    simplifyInstancedScene(scene, { detail: 'low' });
    expect(JSON.stringify(scene.sceneHierarchy)).toBe(before);
    scene.meshResources.forEach((r, i) => r.primitives.forEach((p, j) => expect(p.positions).toEqual(positions[i][j])));
  });

  it('orders the presets from most to least detail', () => {
    const counts = (['high', 'medium', 'low'] as const).map(
      (detail) => simplifyInstancedScene(scene, { detail }).stats.trianglesAfter
    );
    expect(counts[0]).toBeGreaterThanOrEqual(counts[1]);
    expect(counts[1]).toBeGreaterThanOrEqual(counts[2]);
    expect(counts[2]).toBeLessThan(drawnTriangles(scene));
  });

  it('limits the tolerance on a small model so it keeps its shape', () => {
    // One 20-inch ball on its own: a 2 cm building tolerance would flatten it.
    const builder = create();
    const ball = builder.addComponentDefinition('Ball', (def) => {
      for (const face of sphereFaces(1, 24, [0, 0, 0])) def.addFace(face);
    });
    builder.addInstance(ball);
    const small = buildInstancedScene(builder.toBytes());
    const { stats } = simplifyInstancedScene(small, { detail: 'low' });
    expect(stats.tolerance).toBeLessThan(0.001);
    expect(stats.trianglesAfter).toBeGreaterThan(stats.trianglesBefore * 0.5);
  });

  it('never loses a thin part entirely', () => {
    // A 1 mm thick, finely divided strip: thinner than any preset's grid.
    const builder = create();
    const strip = builder.addComponentDefinition('Strip', (def) => {
      const t = 0.04;
      for (let i = 0; i < 150; i++) {
        const x0 = i * 0.2;
        const x1 = x0 + 0.2;
        def.addFace([[x0, 0, 0], [x1, 0, 0], [x1, 1, 0], [x0, 1, 0]]);
        def.addFace([[x0, 0, t], [x0, 1, t], [x1, 1, t], [x1, 0, t]]);
      }
    });
    builder.addInstance(strip);
    builder.addFace([[0, 0, -400], [4000, 0, -400], [4000, 4000, -400], [0, 4000, -400]]);
    const thin = buildInstancedScene(builder.toBytes());
    const { scene: light } = simplifyInstancedScene(thin, { tolerance: 0.02, minObjectSize: 0 });
    const result = light.meshResources.find((r) => r.definitionName === 'Strip');
    expect(result).toBeDefined();
    expect(result!.primitives.reduce((s, p) => s + p.indices.length, 0)).toBeGreaterThan(0);
  });

  it('rejects settings that make no sense', () => {
    expect(() => simplifyInstancedScene(scene, { detail: 'tiny' as never })).toThrow(/Unknown detail level/);
    expect(() => simplifyInstancedScene(scene, { tolerance: -1 })).toThrow(/zero or positive/);
  });

  it('produces a smaller GLB through SkpFile and still a valid one', () => {
    const file = new SkpFile(denseModel());
    const full = file.toGLB();
    const light = file.toGLB({ detail: 'low' });
    expect(light.length).toBeLessThan(full.length * 0.6);
    expect(Buffer.from(light.subarray(0, 4)).toString('latin1')).toBe('glTF');
    expect(new DataView(light.buffer, light.byteOffset).getUint32(8, true)).toBe(light.length);
  });

  it('works on real fixtures without emptying them', () => {
    for (const name of ['gondola_v20.skp', 'nesting_2021.skp', 'SU_File.skp']) {
      const real = buildInstancedScene(fs.readFileSync(path.join(FIXTURES, name)));
      const { scene: light, stats } = simplifyInstancedScene(real, { detail: 'medium' });
      expect(stats.trianglesAfter).toBeGreaterThan(0);
      expect(stats.trianglesAfter).toBeLessThanOrEqual(stats.trianglesBefore);
      expect(toInstancedGLB(light).length).toBeGreaterThan(0);
    }
  });
});

// ── textures ───────────────────────────────────────────────────────────

describe('TIFF textures', () => {
  const width = 13;
  const height = 9;
  const rgb = gradient(width, height);

  const expectPixels = (decoded: ReturnType<typeof decodeTiff>, source: Uint8Array, samples: number) => {
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBe(width);
    expect(decoded!.height).toBe(height);
    for (let i = 0; i < width * height; i++) {
      expect(decoded!.rgba[i * 4]).toBe(source[i * samples]);
      expect(decoded!.rgba[i * 4 + 1]).toBe(source[i * samples + 1]);
      expect(decoded!.rgba[i * 4 + 2]).toBe(source[i * samples + 2]);
      expect(decoded!.rgba[i * 4 + 3]).toBe(samples === 4 ? source[i * 4 + 3] : 255);
    }
  };

  it('decodes uncompressed RGB', () => {
    const tiff = makeTiff(width, height, rgb);
    expect(isTiff(tiff)).toBe(true);
    const decoded = decodeTiff(tiff);
    expectPixels(decoded, rgb, 3);
    expect(decoded!.hasAlpha).toBe(false);
  });

  // tests/fixtures/tiff/*.tif were written by Pillow (Python Imaging
  // Library), not by this project, so these check the decoder against an
  // independent encoder. Each compressed file holds the same picture as an
  // uncompressed one.
  const tiff = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'tiff', name)));

  it.each([
    ['rgb_lzw.tif', 'rgb_none.tif'],
    ['rgb_deflate.tif', 'rgb_none.tif'],
    ['rgb_packbits.tif', 'rgb_none.tif'],
    // 57,600 bytes of noisy pixels: LZW codes grow to 12 bits and the
    // table is reset several times.
    ['big_lzw.tif', 'big_none.tif'],
    ['big_lzw_predictor.tif', 'big_none.tif'],
    ['rgba_lzw.tif', 'rgba_none.tif'],
    ['palette_lzw.tif', 'palette_expected.tif'],
  ])('decodes %s to the same pixels as %s', (compressed, plain) => {
    const a = decodeTiff(tiff(compressed));
    const b = decodeTiff(tiff(plain));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect([a!.width, a!.height]).toEqual([b!.width, b!.height]);
    expect(Buffer.compare(Buffer.from(a!.rgba), Buffer.from(b!.rgba))).toBe(0);
  });

  it('reads the pixels Pillow wrote, not merely the same ones twice', () => {
    // rgb_none.tif is a 24 x 16 gradient: red rises left to right, green
    // top to bottom.
    const image = decodeTiff(tiff('rgb_none.tif'))!;
    expect([image.width, image.height]).toEqual([24, 16]);
    const at = (x: number, y: number) => Array.from(image.rgba.subarray((y * 24 + x) * 4, (y * 24 + x) * 4 + 4));
    expect(at(0, 0).slice(0, 2)).toEqual([0, 0]);
    expect(at(23, 0).slice(0, 2)).toEqual([255, 0]);
    expect(at(0, 15).slice(0, 2)).toEqual([0, 255]);
    expect(at(23, 15)[3]).toBe(255);
    expect(image.hasAlpha).toBe(false);

    const rgba = decodeTiff(tiff('rgba_none.tif'))!;
    expect(rgba.hasAlpha).toBe(true);
    expect(rgba.rgba[3]).toBe(255);
    expect(rgba.rgba[(23 * 4) + 3]).toBe(96);

    const gray = decodeTiff(tiff('gray_none.tif'))!;
    expect(gray.rgba[0]).toBe(gray.rgba[1]);
    expect(gray.rgba[1]).toBe(gray.rgba[2]);
  });

  it('returns null for JPEG-in-TIFF, which it does not read', () => {
    expect(decodeTiff(tiff('rgb_jpeg.tif'))).toBeNull();
  });

  it('undoes horizontal differencing without touching the source bytes', () => {
    const differenced = rgb.slice();
    for (let y = 0; y < height; y++) {
      for (let i = width * 3 - 1; i >= 3; i--) {
        const at = y * width * 3 + i;
        differenced[at] = (rgb[at] - rgb[at - 3]) & 0xff;
      }
    }
    const tiff = makeTiff(width, height, differenced, { predictor: 2 });
    const copy = tiff.slice();
    expectPixels(decodeTiff(tiff), rgb, 3);
    expect(tiff).toEqual(copy);
  });

  it('keeps an alpha channel', () => {
    const rgba = gradient(width, height, 4);
    const decoded = decodeTiff(makeTiff(width, height, rgba, { samples: 4 }));
    expectPixels(decoded, rgba, 4);
    expect(decoded!.hasAlpha).toBe(true);
  });

  it('returns null for what it does not read, instead of throwing', () => {
    expect(decodeTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    expect(decodeTiff(makeTiff(width, height, rgb).subarray(0, 60))).toBeNull(); // cut short
    expect(decodeTiff(makeTiff(width, height, rgb.subarray(0, 20)))).toBeNull(); // strip too small
    expect(decodeTiff(makeTiff(70000, 70000, rgb))).toBeNull(); // implausible size
    expect(convertTextureToPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // already a PNG
  });

  it('re-encodes as a PNG that reads back to the same pixels', () => {
    const png = convertTextureToPng(makeTiff(width, height, rgb))!;
    const back = decodeSimplePng(png);
    expect(back.width).toBe(width);
    expect(back.height).toBe(height);
    expect(back.channels).toBe(3);
    for (let y = 0; y < height; y++) {
      expect(Array.from(back.rows[y])).toEqual(Array.from(rgb.subarray(y * width * 3, (y + 1) * width * 3)));
    }
    const withAlpha = decodeSimplePng(encodePng(decodeTiff(makeTiff(width, height, gradient(width, height, 4), { samples: 4 }))!));
    expect(withAlpha.channels).toBe(4);
  });

  it('shrinks an oversized image and keeps its proportions', () => {
    const big = decodeTiff(makeTiff(64, 32, gradient(64, 32)))!;
    const small = downscaleImage(big, 16);
    expect([small.width, small.height]).toEqual([16, 8]);
    expect(downscaleImage(big, 64)).toBe(big);
    // Averaging keeps a flat colour flat.
    const flat = { width: 8, height: 8, hasAlpha: false, rgba: new Uint8Array(8 * 8 * 4).fill(200) };
    expect(Array.from(downscaleImage(flat, 4).rgba).every((v) => v === 200)).toBe(true);
  });

  it('gives a TIFF-textured material its image in the scene and in the GLB', () => {
    // The writer accepts PNG and JPEG only, so the file is written with a
    // PNG and a TIFF of the same length is put in its place: the container
    // stores the image bytes as they are, with their length.
    const source = makeTiff(width, height, rgb);
    const png = encodePng({ width: 40, height: 40, hasAlpha: false, rgba: gradient(40, 40, 4) });
    expect(png.length).toBeGreaterThan(source.length);
    const padded = new Uint8Array(png.length); // trailing zeros: ignored by a TIFF reader
    padded.set(source);

    const builder = create();
    const material = builder.addTextureMaterial('Oak', png);
    builder.addFace(
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      { material }
    );
    const bytes = Buffer.from(builder.toBytes());
    const at = bytes.indexOf(Buffer.from(png));
    expect(at).toBeGreaterThan(0);
    bytes.set(padded, at);
    expect(bytes.indexOf(Buffer.from(png.subarray(0, 8)))).toBe(-1);

    // The model still reports the image exactly as stored...
    const stored = SkpFile.fromBuffer(bytes).parse().materials.find((m) => m.texture)!;
    expect(isTiff(stored.texture!.data!)).toBe(true);

    // ...and both scene builders hand it on as a PNG.
    for (const scene of [buildInstancedScene(bytes), buildScene(bytes)]) {
      expect(scene.textures.length).toBe(1);
      expect(scene.textures[0].mimeType).toBe('image/png');
      const back = decodeSimplePng(scene.textures[0].data);
      expect([back.width, back.height]).toEqual([width, height]);
      expect(Array.from(back.rows[0])).toEqual(Array.from(rgb.subarray(0, width * 3)));
      const textured = (scene.gltfMaterials as any[]).filter((m) => m.pbrMetallicRoughness.baseColorTexture);
      expect(textured.length).toBe(1);
    }
    const glb = toInstancedGLB(buildInstancedScene(bytes), { textures: true });
    expect(Buffer.from(glb).includes(Buffer.from('image/png'))).toBe(true);
  });
});

describe('GLB texture coordinates', () => {
  /** TEXCOORD_0 of every primitive, read back out of a GLB. */
  function readUvs(glb: Uint8Array): number[][] {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(Buffer.from(glb.subarray(20, 20 + jsonLength)).toString('utf8'));
    const binStart = 20 + jsonLength + 8;
    const out: number[][] = [];
    for (const mesh of json.meshes) {
      for (const prim of mesh.primitives) {
        const accessor = json.accessors[prim.attributes.TEXCOORD_0];
        const bufferView = json.bufferViews[accessor.bufferView];
        const start = binStart + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const uvs: number[] = [];
        for (let i = 0; i < accessor.count * 2; i++) uvs.push(view.getFloat32(start + i * 4, true));
        out.push(uvs);
      }
    }
    return out;
  }

  it("turns SketchUp's upward V into glTF's downward V", () => {
    // A wall whose texture is pinned bottom-left (0,0) to top-right (1,1).
    const png = encodePng({ width: 2, height: 2, hasAlpha: false, rgba: new Uint8Array(16).fill(255) });
    const builder = create();
    const material = builder.addTextureMaterial('T', png);
    builder.addFace(
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 0, 10],
        [0, 0, 10],
      ],
      {
        material,
        frontUv: [
          [[0, 0, 0], [0, 0]],
          [[10, 0, 0], [1, 0]],
          [[10, 0, 10], [1, 1]],
        ],
      }
    );
    const bytes = builder.toBytes();
    const instanced = buildInstancedScene(bytes);

    // In the scene, as SketchUp has it: V is 1 at the top of the wall.
    const prim = instanced.meshResources[0].primitives.find((p) => {
      const material = (instanced.gltfMaterials as any[])[p.materialIndex];
      return material.pbrMetallicRoughness.baseColorTexture;
    })!;
    const sceneUvAt = new Map<string, number>();
    for (let i = 0; i < prim.positions.length / 3; i++) {
      sceneUvAt.set(`${prim.positions[i * 3].toFixed(3)},${prim.positions[i * 3 + 1].toFixed(3)}`, prim.uvs[i * 2 + 1]);
    }
    expect(sceneUvAt.get('0.000,0.254')).toBeCloseTo(1, 5); // top
    expect(sceneUvAt.get('0.000,0.000')).toBeCloseTo(0, 5); // bottom

    // In the files, as glTF has it: V is 0 at the top of the image. The
    // baked GLB holds the same wall in world space; its V values are the
    // same set, flipped.
    const bakedVs = readUvs(toGLB(buildScene(bytes), { textures: true })).flat().filter((_, i) => i % 2 === 1);
    const sceneVs = instanced.meshResources.flatMap((r) => r.primitives.flatMap((p) => Array.from(p.uvs).filter((_, i) => i % 2 === 1)));
    const sorted = (values: number[]) => values.map((v) => +v.toFixed(5)).sort((x, y) => x - y);
    expect(sorted(bakedVs)).toEqual(sorted(sceneVs.map((v) => 1 - v)));

    const instancedUvs = readUvs(toInstancedGLB(instanced, { textures: true }));
    const sceneUvs = instanced.meshResources.flatMap((r) => r.primitives.map((p) => Array.from(p.uvs)));
    expect(instancedUvs.length).toBe(sceneUvs.length);
    instancedUvs.forEach((uvs, primIndex) => {
      for (let i = 0; i < uvs.length; i += 2) {
        expect(uvs[i]).toBeCloseTo(sceneUvs[primIndex][i], 6);
        expect(uvs[i + 1]).toBeCloseTo(1 - sceneUvs[primIndex][i + 1], 6);
      }
    });
  });
});

describe('dimension lookup tables', () => {
  it('asks for geometry only when a dimension is attached to it', () => {
    // No dimension record at all: nothing to look up.
    const probe = { needsGeometry: false };
    expect(parseDimensions(new Uint8Array([1, 2, 3, 0xcc, 0x5b, 0, 0]), new Map(), new Map(), probe)).toEqual([]);
    expect(probe.needsGeometry).toBe(false);
  });

  it('still places the dimensions of a file that has them', () => {
    // Untitled.skp carries 13 dimensions attached to geometry.
    const model = SkpFile.open(path.join(FIXTURES, 'Untitled.skp')).parse();
    expect(model.dimensions.length).toBe(13);
    // Placed, not merely found: every one has both of its measured points.
    for (const dimension of model.dimensions) {
      expect(dimension.a).not.toBeNull();
      expect(dimension.b).not.toBeNull();
      for (const value of [...dimension.a!, ...dimension.b!]) expect(Number.isFinite(value)).toBe(true);
    }
  });
});
