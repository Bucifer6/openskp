/**
 * The one place this package reaches for Node.js built-in modules.
 *
 * The file helpers (`SkpFile.open`, `exportOBJ`, `SkpBuilder.save`, ...)
 * used to call a bare `require('fs')`. That works in the CommonJS build
 * only: in the ES module build there is no `require`, so every one of them
 * threw "Dynamic require of "fs" is not supported" under `import`, which is
 * how the README itself tells Node users to load the package.
 *
 * `process.getBuiltinModule` (Node 20.16+/22.3+) returns a built-in module
 * synchronously in both module systems, and it is a plain property lookup,
 * so a browser bundler has no `fs` import to resolve or stub out.
 */

declare const process: any;
declare const require: any;

/** Whether this code is running under Node.js (or a runtime that presents
 * itself as Node closely enough to load its built-in modules). */
export function isNode(): boolean {
  return typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
}

/**
 * Load a Node.js built-in module, or throw a plain error naming `feature`
 * when this is not Node.
 *
 * @param name - The built-in's name without the `node:` prefix
 * @param feature - What the caller was doing, for the error message
 */
export function nodeBuiltin(name: 'fs' | 'path', feature: string): any {
  if (!isNode()) {
    throw new Error(`${feature} is only supported in Node.js environment`);
  }
  if (typeof process.getBuiltinModule === 'function') {
    const mod = process.getBuiltinModule(`node:${name}`);
    if (mod) return mod;
  }
  // Older Node: the CommonJS build still has a real require.
  try {
    return require(name);
  } catch (e) {
    const err = new Error(
      `${feature} needs the Node.js "${name}" module, which this runtime could not load. ` +
        'Use Node.js 22.12 or newer, or read and write the bytes yourself.'
    );
    (err as Error & { cause?: unknown }).cause = e;
    throw err;
  }
}

/** Bytes accepted wherever a file's contents are passed in: an
 * `ArrayBuffer`, or any view over one - a Node.js `Buffer` included. */
export type BinaryInput = ArrayBuffer | ArrayBufferView;

/**
 * View `input` as bytes without copying it.
 *
 * `new Uint8Array(buffer)` is only a view when given an `ArrayBuffer`; given
 * a `Uint8Array` or `Buffer` it copies every byte. A Node `Buffer` is also
 * frequently a window into a larger pooled `ArrayBuffer`, so its
 * `byteOffset`/`byteLength` have to be honoured rather than taking
 * `.buffer` whole.
 */
export function toBytes(input: BinaryInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  // An ArrayBuffer from another realm (an iframe, a vm context, a worker
  // transfer in some runtimes) fails instanceof; accept it by shape.
  const tag = Object.prototype.toString.call(input);
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
    return new Uint8Array(input as ArrayBuffer);
  }
  throw new TypeError('Expected an ArrayBuffer, a typed array or a Buffer');
}

/** Read a whole file as bytes. Node.js only. */
export function readFileBytes(filePath: string, feature: string): Uint8Array {
  const fs = nodeBuiltin('fs', feature);
  const buffer = fs.readFileSync(filePath);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** Write `data` to `filePath`, creating the directory if it is missing.
 * Node.js only. */
export function writeFileEnsuringDir(filePath: string, data: string | Uint8Array, feature: string): void {
  const fs = nodeBuiltin('fs', feature);
  const path = nodeBuiltin('path', feature);
  const dir = path.dirname(filePath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (typeof data === 'string') fs.writeFileSync(filePath, data, 'utf-8');
  else fs.writeFileSync(filePath, data);
}
