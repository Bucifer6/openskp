import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SkpFile,
  parseSkp,
  buildInstancedScene,
  loadSkp,
  extractThumbnail,
  exportOBJ,
  exportSTL,
  create,
  openExisting,
} from '../src/index';
import { toBytes, nodeBuiltin } from '../src/node-io';
import { extractSkpEntries } from '../src/vff';
import { parseTlvRecursive, readU32, readI32, parseVarInt } from '../src/parser';

const FIXTURES = path.join(__dirname, 'fixtures');
const MODERN = path.join(FIXTURES, 'nesting_2021.skp');
const LEGACY = path.join(FIXTURES, 'nesting_2017.skp');
/** A file saved by SketchUp itself, so it carries the stored preview. */
const WITH_THUMBNAIL = path.join(FIXTURES, 'SU_File.skp');
/** A real model with enough curved geometry for simplification to bite. */
const GONDOLA = path.join(FIXTURES, 'gondola_v20.skp');
const DIST_CJS = path.join(__dirname, '..', 'dist', 'index.js');
const DIST_ESM = path.join(__dirname, '..', 'dist', 'index.mjs');
const CLI = path.join(__dirname, '..', 'bin', 'openskp.cjs');
const hasDist = fs.existsSync(DIST_CJS) && fs.existsSync(DIST_ESM);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openskp-test-'));
}

/** Definition/vertex/face counts, enough to tell two parses apart. */
function shape(model: ReturnType<typeof parseSkp>) {
  let vertices = model.root.vertices.length;
  let faces = model.root.faces.length;
  for (const def of model.definitions.values()) {
    vertices += def.vertices.length;
    faces += def.faces.length;
  }
  return { version: model.version, definitions: model.definitions.size, vertices, faces, layers: model.layers.length };
}

describe('binary input', () => {
  it('views a typed array in place instead of copying it', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const window = backing.subarray(2, 5);
    const bytes = toBytes(window);
    expect(bytes).toBe(window);
    expect(Array.from(toBytes(new DataView(backing.buffer, 2, 3)))).toEqual([1, 2, 3]);
    expect(toBytes(backing.buffer).length).toBe(6);
    expect(() => toBytes('nope' as unknown as ArrayBuffer)).toThrow(TypeError);
  });

  it('parses a Buffer that is a window into a larger ArrayBuffer', () => {
    // fs.readFileSync of a small file hands back exactly this: a Buffer at
    // a non-zero byteOffset inside Node's shared pool. Reading `.buffer`
    // whole would parse the pool's unrelated bytes.
    const file = fs.readFileSync(MODERN);
    const padded = Buffer.alloc(file.length + 64, 0xab);
    file.copy(padded, 32);
    const windowed = padded.subarray(32, 32 + file.length);
    expect(windowed.byteOffset).toBe(32);

    const fromWindow = shape(parseSkp(windowed));
    const fromArrayBuffer = shape(
      parseSkp(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer)
    );
    expect(fromWindow).toEqual(fromArrayBuffer);
    expect(fromWindow.vertices).toBeGreaterThan(0);
  });

  it('accepts a Buffer for a legacy file and for openExisting', () => {
    const file = fs.readFileSync(LEGACY);
    expect(shape(parseSkp(file)).vertices).toBeGreaterThan(0);
    const { builder } = openExisting(file);
    expect(builder.toBytes().length).toBeGreaterThan(0);
  });
});

describe('SkpFile on Node', () => {
  it('opens a file synchronously and asynchronously with the same result', async () => {
    const sync = SkpFile.open(MODERN);
    const asynchronous = await SkpFile.openAsync(MODERN);
    expect(sync.byteLength).toBe(fs.statSync(MODERN).size);
    expect(shape(asynchronous.parse())).toEqual(shape(sync.parse()));
  });

  it('rejects a missing file and a wrong extension', async () => {
    expect(() => SkpFile.open(path.join(FIXTURES, 'missing.skp'))).toThrow(/File not found/);
    expect(() => SkpFile.open(__filename)).toThrow(/Expected a \.skp file/);
    await expect(SkpFile.openAsync(path.join(FIXTURES, 'missing.skp'))).rejects.toThrow(/File not found/);
  });

  it('writes a GLB, instanced by default and baked on request', () => {
    const dir = tempDir();
    try {
      const file = SkpFile.open(MODERN);
      const instancedPath = path.join(dir, 'nested', 'out.glb');
      const written = file.exportGLB(instancedPath);
      const onDisk = fs.readFileSync(instancedPath);
      expect(onDisk.length).toBe(written);
      expect(onDisk.subarray(0, 4).toString('latin1')).toBe('glTF');

      const baked = file.toGLB({ instanced: false });
      expect(Buffer.from(baked.subarray(0, 4)).toString('latin1')).toBe('glTF');
      expect(Buffer.compare(Buffer.from(baked), onDisk)).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes exports and saved models into directories that do not exist yet', () => {
    const dir = tempDir();
    try {
      const scene = SkpFile.open(MODERN).buildScene();
      exportOBJ(scene, path.join(dir, 'a', 'model.obj'));
      expect(fs.existsSync(path.join(dir, 'a', 'model.obj'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'a', 'model.mtl'))).toBe(true);
      exportSTL(scene, path.join(dir, 'b', 'model.stl'), { binary: true });
      expect(fs.statSync(path.join(dir, 'b', 'model.stl')).size).toBeGreaterThan(84);

      const builder = create();
      builder.addFace([
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ]);
      const saved = path.join(dir, 'made.skp');
      builder.save(saved);
      expect(shape(SkpFile.open(saved).parse()).faces).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads Node built-ins without a require in scope', () => {
    expect(typeof nodeBuiltin('fs', 'test').readFileSync).toBe('function');
    expect(typeof nodeBuiltin('path', 'test').join).toBe('function');
  });
});

describe('loadSkp', () => {
  it.each([MODERN, LEGACY])('matches a separate parse and scene build for %s', (fixture) => {
    const bytes = fs.readFileSync(fixture);
    const { model, scene } = loadSkp(bytes);
    const separateScene = buildInstancedScene(bytes);

    expect(shape(model)).toEqual(shape(parseSkp(bytes)));
    expect(scene.meshResources.length).toBe(separateScene.meshResources.length);
    expect(scene.bounds).toEqual(separateScene.bounds);
    expect(scene.gltfMaterials).toEqual(separateScene.gltfMaterials);
    for (let i = 0; i < scene.meshResources.length; i++) {
      const a = scene.meshResources[i];
      const b = separateScene.meshResources[i];
      expect(a.variantKey).toBe(b.variantKey);
      expect(a.primitives.length).toBe(b.primitives.length);
      for (let j = 0; j < a.primitives.length; j++) {
        expect(a.primitives[j].positions).toEqual(b.primitives[j].positions);
        expect(a.primitives[j].indices).toEqual(b.primitives[j].indices);
      }
    }
  });
});

describe('thumbnail extraction', () => {
  it('reads only the entries it was asked for', () => {
    const bytes = new Uint8Array(fs.readFileSync(WITH_THUMBNAIL));
    const entries = extractSkpEntries(bytes, ['meta/model_thumbnail.png', 'META/PREVIEW_THUMBNAIL.PNG', 'no/such.entry']);
    const names = Object.keys(entries).sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name.startsWith('meta/')).toBe(true);
    }
    expect(names).not.toContain('model.dat');
  });

  it('still returns a PNG with its real dimensions', () => {
    const thumbnail = extractThumbnail(fs.readFileSync(WITH_THUMBNAIL));
    expect(thumbnail).not.toBeNull();
    expect(thumbnail!.mimeType).toBe('image/png');
    expect(thumbnail!.width).toBeGreaterThan(0);
    expect(thumbnail!.height).toBeGreaterThan(0);
    expect(extractThumbnail(fs.readFileSync(LEGACY))).toBeNull();
    // A modern file written by another tool has no preview: null, not an error.
    expect(extractThumbnail(fs.readFileSync(MODERN))).toBeNull();
  });
});

describe('TLV reader', () => {
  function tlv(tag: [number, number], payload: number[]): number[] {
    const n = payload.length;
    return [tag[0], tag[1], n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, ...payload];
  }

  it('reads little-endian integers, including values above 2^31', () => {
    const data = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x80]);
    expect(readU32(data, 0)).toBe(0xffffffff);
    expect(readI32(data, 0)).toBe(-1);
    expect(readU32(data, 4)).toBe(0x80000001);
    expect(readI32(data, 4)).toBe(-0x7fffffff);
    expect(() => readU32(data, 5)).toThrow(/Out of bounds/);
    expect(() => readI32(data, 6)).toThrow(/Out of bounds/);
    expect(parseVarInt(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]), 0, 6)).toBe(0x060504030201);
  });

  it('gives leaves their payload on demand and shares nothing between them', () => {
    const leafA = tlv([0xab, 0x01], [1, 2, 3]);
    const leafB = tlv([0x0a, 0xff], []);
    const container = tlv([0xf6, 0x01], [...leafA, ...leafB]);
    const data = new Uint8Array([0xee, ...container]).subarray(1);

    const [root] = parseTlvRecursive(data, 0, data.length);
    expect(root.tag).toBe('F601');
    expect(root.payload.length).toBe(0);
    expect(root.children.map((c) => c.tag)).toEqual(['AB01', '0AFF']);

    const [a, b] = root.children;
    expect(Array.from(a.payload)).toEqual([1, 2, 3]);
    expect(a.payload).toBe(a.payload);
    expect(a.offset).toBe(6);
    expect(a.size).toBe(3);
    expect(b.payload.length).toBe(0);
    expect(a.children.length).toBe(0);
    expect(() => a.children.push(b)).toThrow();
  });

  it('keeps the bytes of a container that holds no complete record', () => {
    const data = new Uint8Array(tlv([0xf6, 0x01], [7, 7, 7]));
    const [node] = parseTlvRecursive(data, 0, data.length);
    expect(node.children.length).toBe(0);
    expect(Array.from(node.payload)).toEqual([7, 7, 7]);
  });
});

describe.skipIf(!hasDist)('built package', () => {
  it('opens a file from an ES module import', () => {
    // The ES module build has no `require`; SkpFile.open used to throw
    // 'Dynamic require of "fs" is not supported' here.
    const script =
      `import { SkpFile } from ${JSON.stringify(pathToFileURL(DIST_ESM).href)};` +
      `const m = SkpFile.open(${JSON.stringify(MODERN)}).parse();` +
      `process.stdout.write(String(m.definitions.size));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(Number(out)).toBe(parseSkp(fs.readFileSync(MODERN)).definitions.size);
  });

  it('opens a file from a CommonJS require', () => {
    const script =
      `const { SkpFile } = require(${JSON.stringify(DIST_CJS)});` +
      `process.stdout.write(String(SkpFile.open(${JSON.stringify(MODERN)}).parse().definitions.size));`;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(Number(out)).toBe(parseSkp(fs.readFileSync(MODERN)).definitions.size);
  });

  describe('command line', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

    it('prints model information as JSON', () => {
      const result = run('info', MODERN, '--json');
      expect(result.status).toBe(0);
      const info = JSON.parse(result.stdout);
      expect(info.definitions).toBe(parseSkp(fs.readFileSync(MODERN)).definitions.size);
      expect(info.size_bytes).toBe(fs.statSync(MODERN).size);
      expect(Array.isArray(info.layers)).toBe(true);
    });

    it('converts to each format by extension', () => {
      const dir = tempDir();
      try {
        for (const ext of ['glb', 'obj', 'stl', 'ply', 'dxf', 'ifc', 'json', 'frag']) {
          const out = path.join(dir, `model.${ext}`);
          const result = run('convert', MODERN, out, '--quiet');
          expect(result.stderr).toBe('');
          expect(result.status).toBe(0);
          expect(fs.statSync(out).size).toBeGreaterThan(0);
        }
        expect(fs.readFileSync(path.join(dir, 'model.glb')).subarray(0, 4).toString('latin1')).toBe('glTF');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')).format_version).toBe('1.0');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writes a lighter GLB at a detail level', () => {
      const dir = tempDir();
      try {
        const full = path.join(dir, 'full.glb');
        const light = path.join(dir, 'light.glb');
        expect(run('convert', GONDOLA, full, '--quiet').status).toBe(0);
        const result = run('convert', GONDOLA, light, '--detail', 'low');
        expect(result.status).toBe(0);
        expect(result.stderr).toMatch(/triangles kept/);
        expect(fs.statSync(light).size).toBeLessThan(fs.statSync(full).size);
        expect(fs.readFileSync(light).subarray(0, 4).toString('latin1')).toBe('glTF');

        expect(run('convert', GONDOLA, light, '--detail', 'tiny').status).toBe(2);
        expect(run('convert', GONDOLA, path.join(dir, 'x.obj'), '--detail', 'low').status).toBe(2);
        expect(run('convert', GONDOLA, light, '--detail', 'low', '--baked').status).toBe(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('saves the stored thumbnail', () => {
      const dir = tempDir();
      try {
        const out = path.join(dir, 'preview.png');
        expect(run('thumbnail', WITH_THUMBNAIL, out).status).toBe(0);
        expect(fs.readFileSync(out).subarray(1, 4).toString('latin1')).toBe('PNG');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('explains bad usage with exit code 2 and failures with exit code 1', () => {
      expect(run('convert', MODERN).status).toBe(2);
      expect(run('convert', MODERN, 'out.xyz').status).toBe(2);
      expect(run('convert', MODERN, MODERN, '--format', 'glb').status).toBe(2);
      expect(run('frobnicate').status).toBe(2);
      expect(run('info', MODERN, '--nope').status).toBe(2);
      const missing = run('info', path.join(FIXTURES, 'missing.skp'));
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/File not found/);
      expect(run('--help').stdout).toMatch(/Usage:/);
      expect(run('--version').stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
