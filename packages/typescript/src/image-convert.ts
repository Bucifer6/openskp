import { zlibSync, unzlibSync } from 'fflate';

/**
 * Turning a texture image no browser or glTF reader can show into one they
 * can.
 *
 * SketchUp stores a material's image exactly as the author imported it, and
 * some authors import TIFF. glTF carries PNG and JPEG only and browsers
 * decode neither TIFF nor anything like it, so such a material used to lose
 * its image and fall back to a flat colour - on a real architectural model,
 * a wood floor rendered as a plain brown rectangle. This reads the common
 * kinds of TIFF and re-encodes them as PNG.
 */

/** Decoded pixels: 8 bits per channel, RGBA, rows top to bottom. */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Whether any pixel is less than fully opaque. */
  hasAlpha: boolean;
}

/** Refuse anything larger: a header can claim any size it likes. */
const MAX_PIXELS = 1 << 28;

/** Whether `data` starts with a TIFF header, either byte order. */
export function isTiff(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const little = data[0] === 0x49 && data[1] === 0x49 && data[2] === 42 && data[3] === 0;
  const big = data[0] === 0x4d && data[1] === 0x4d && data[2] === 0 && data[3] === 42;
  return little || big;
}

/** TIFF's LZW: codes from 9 to 12 bits, most significant bit first, with
 * the "early change" every TIFF writer uses. Stops quietly at the end of
 * the data or at a code that cannot be valid. */
function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }

  let outPos = 0;
  let pos = 0;
  let bits = 0;
  let bitCount = 0;
  let codeSize = 9;
  let next = 258;
  let prev = -1;

  while (outPos < expected) {
    while (bitCount < codeSize) {
      if (pos >= src.length) return out;
      bits = ((bits << 8) | src[pos++]) >>> 0;
      bitCount += 8;
    }
    const code = (bits >>> (bitCount - codeSize)) & ((1 << codeSize) - 1);
    bitCount -= codeSize;
    bits &= bitCount === 0 ? 0 : (1 << bitCount) - 1;

    if (code === 257) break;
    if (code === 256) {
      codeSize = 9;
      next = 258;
      prev = -1;
      continue;
    }
    if (prev === -1) {
      if (code > 255) break;
      out[outPos++] = code;
      prev = code;
      continue;
    }
    if (code > next || next >= 4096) break;

    // The new table entry is the previous string plus the first byte of
    // this one - which, when this code IS the new entry, is the previous
    // string's own first byte.
    prefix[next] = prev;
    first[next] = first[prev];
    length[next] = length[prev] + 1;
    suffix[next] = code === next ? first[prev] : first[code];
    next++;

    const len = length[code];
    let write = outPos + len - 1;
    let walk = code;
    for (let i = 0; i < len; i++) {
      if (write < expected) out[write] = suffix[walk];
      write--;
      walk = prefix[walk];
    }
    outPos += len;

    if (next >= (1 << codeSize) - 1 && codeSize < 12) codeSize++;
    prev = code;
  }
  return out;
}

function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let pos = 0;
  let outPos = 0;
  while (pos < src.length && outPos < expected) {
    const n = src[pos++];
    if (n < 128) {
      const count = Math.min(n + 1, src.length - pos, expected - outPos);
      out.set(src.subarray(pos, pos + count), outPos);
      pos += n + 1;
      outPos += count;
    } else if (n > 128) {
      const count = Math.min(257 - n, expected - outPos);
      if (pos >= src.length) break;
      out.fill(src[pos++], outPos, outPos + count);
      outPos += count;
    }
  }
  return out;
}

/**
 * Decode a TIFF image, or return null for one this reader does not cover.
 *
 * Covers what image editors write by default: 8 or 16 bits per channel;
 * greyscale, RGB or palette colour, with or without alpha; stored
 * uncompressed or with LZW, Deflate or PackBits; in strips or in tiles.
 * JPEG-in-TIFF, CMYK, separate colour planes and the fax encodings are not
 * covered: for those the caller keeps the material's flat colour, as it
 * always did.
 */
export function decodeTiff(data: Uint8Array): DecodedImage | null {
  if (!isTiff(data)) return null;
  const little = data[0] === 0x49;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);

  try {
    const ifd = u32(4);
    const entryCount = u16(ifd);
    const tags = new Map<number, number[]>();
    for (let i = 0; i < entryCount; i++) {
      const entry = ifd + 2 + i * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      // Only SHORT (3) and LONG (4) values matter to this reader.
      if (type !== 3 && type !== 4) continue;
      // The layout tags never need more values than an image has rows.
      if (count > 1 << 22) return null;
      const size = type === 3 ? 2 : 4;
      const base = count * size <= 4 ? entry + 8 : u32(entry + 8);
      const values: number[] = [];
      for (let j = 0; j < count; j++) {
        values.push(type === 3 ? u16(base + j * 2) : u32(base + j * 4));
      }
      tags.set(tag, values);
    }
    const one = (tag: number, fallback: number) => tags.get(tag)?.[0] ?? fallback;

    const width = one(256, 0);
    const height = one(257, 0);
    if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) return null;

    const bitsList = tags.get(258) ?? [1];
    const bits = bitsList[0];
    if ((bits !== 8 && bits !== 16) || bitsList.some((b) => b !== bits)) return null;
    const bytesPerSample = bits / 8;
    const compression = one(259, 1);
    const photometric = one(262, 1);
    const samples = one(277, 1);
    const predictor = one(317, 1);
    if (one(284, 1) !== 1) return null; // separate colour planes
    if (photometric > 3) return null; // CMYK, YCbCr, ...
    if (samples < 1 || samples > 5) return null;
    if (photometric === 2 && samples < 3) return null;
    const colorMap = photometric === 3 ? tags.get(320) : undefined;
    if (photometric === 3 && (!colorMap || bits !== 8 || colorMap.length < 768)) return null;

    const tiled = tags.has(322) && tags.has(324);
    const blockWidth = tiled ? one(322, width) : width;
    const blockHeight = tiled ? one(323, height) : Math.min(one(278, height), height);
    const offsets = tags.get(tiled ? 324 : 273);
    const byteCounts = tags.get(tiled ? 325 : 279);
    if (!offsets || !byteCounts || blockWidth <= 0 || blockHeight <= 0) return null;
    const blocksAcross = Math.ceil(width / blockWidth);
    const blocksDown = Math.ceil(height / blockHeight);
    if (offsets.length < blocksAcross * blocksDown) return null;

    const pixelBytes = samples * bytesPerSample;
    const rgba = new Uint8Array(width * height * 4);
    let hasAlpha = false;
    // 16-bit samples: the high byte is the 8-bit value.
    const highByte = bytesPerSample === 2 ? (little ? 1 : 0) : 0;
    // Extra samples beyond the colour ones: the first is taken as alpha.
    const colourSamples = photometric === 2 ? 3 : 1;
    const alphaSample = samples > colourSamples ? colourSamples : -1;

    for (let blockIndex = 0; blockIndex < blocksAcross * blocksDown; blockIndex++) {
      const blockX = (blockIndex % blocksAcross) * blockWidth;
      const blockY = Math.floor(blockIndex / blocksAcross) * blockHeight;
      // A strip may be shorter than the others at the bottom; a tile is
      // always full size and simply hangs over the edge.
      const rows = tiled ? blockHeight : Math.min(blockHeight, height - blockY);
      const rowBytes = blockWidth * pixelBytes;
      const expected = rows * rowBytes;

      const start = offsets[blockIndex];
      const end = start + byteCounts[blockIndex];
      if (start >= data.length || end > data.length) return null;
      const raw = data.subarray(start, end);

      let block: Uint8Array;
      if (compression === 1) block = raw;
      else if (compression === 5) block = lzwDecode(raw, expected);
      else if (compression === 8 || compression === 32946) block = unzlibSync(raw);
      else if (compression === 32773) block = packBitsDecode(raw, expected);
      else return null;
      if (block.length < expected) {
        if (compression !== 1) {
          const padded = new Uint8Array(expected);
          padded.set(block);
          block = padded;
        } else {
          return null;
        }
      }

      if (predictor === 2) {
        // Each sample is stored as the difference from the one to its left.
        // The decoders above return a fresh buffer, but uncompressed data
        // is a view of the file: never change that in place.
        if (compression === 1) block = block.slice(0, expected);
        for (let row = 0; row < rows; row++) {
          const rowStart = row * rowBytes;
          if (bytesPerSample === 1) {
            for (let i = pixelBytes; i < rowBytes; i++) {
              block[rowStart + i] = (block[rowStart + i] + block[rowStart + i - pixelBytes]) & 0xff;
            }
          } else {
            for (let i = pixelBytes; i < rowBytes; i += 2) {
              const a = rowStart + i;
              const b = a - pixelBytes;
              const sum = little
                ? (block[a] | (block[a + 1] << 8)) + (block[b] | (block[b + 1] << 8))
                : ((block[a] << 8) | block[a + 1]) + ((block[b] << 8) | block[b + 1]);
              if (little) {
                block[a] = sum & 0xff;
                block[a + 1] = (sum >> 8) & 0xff;
              } else {
                block[a] = (sum >> 8) & 0xff;
                block[a + 1] = sum & 0xff;
              }
            }
          }
        }
      }

      const copyWidth = Math.min(blockWidth, width - blockX);
      const copyRows = Math.min(rows, height - blockY);
      for (let row = 0; row < copyRows; row++) {
        let src = row * rowBytes + highByte;
        let dst = ((blockY + row) * width + blockX) * 4;
        for (let col = 0; col < copyWidth; col++) {
          let r: number;
          let g: number;
          let b: number;
          const value = block[src];
          if (photometric === 2) {
            r = value;
            g = block[src + bytesPerSample];
            b = block[src + 2 * bytesPerSample];
          } else if (photometric === 3) {
            // Palette entries are 16-bit, all reds, then greens, then blues.
            const entries = colorMap!.length / 3;
            r = colorMap![value] >> 8;
            g = colorMap![entries + value] >> 8;
            b = colorMap![2 * entries + value] >> 8;
          } else {
            r = g = b = photometric === 0 ? 255 - value : value;
          }
          const a = alphaSample >= 0 ? block[src + alphaSample * bytesPerSample] : 255;
          if (a !== 255) hasAlpha = true;
          rgba[dst] = r;
          rgba[dst + 1] = g;
          rgba[dst + 2] = b;
          rgba[dst + 3] = a;
          src += pixelBytes;
          dst += 4;
        }
      }
    }

    return { width, height, rgba, hasAlpha };
  } catch {
    // A truncated or inconsistent file: reads past the end throw.
    return null;
  }
}

/**
 * Shrink an image so neither side exceeds `maxSize`, averaging the source
 * pixels each output pixel covers. Returns the image itself when it
 * already fits.
 */
export function downscaleImage(image: DecodedImage, maxSize: number): DecodedImage {
  const largest = Math.max(image.width, image.height);
  if (largest <= maxSize) return image;
  const scale = maxSize / largest;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const out = new Uint8Array(width * height * 4);
  const src = image.rgba;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * image.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          i += 4;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, rgba: out, hasAlpha: image.hasAlpha };
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, seed: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = seed;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

/** Encode pixels as a PNG: RGB when the image is opaque, RGBA otherwise. */
export function encodePng(image: DecodedImage): Uint8Array {
  const { width, height, rgba, hasAlpha } = image;
  const channels = hasAlpha ? 4 : 3;
  const rowBytes = width * channels + 1;
  const raw = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    let dst = y * rowBytes + 1; // byte 0 of each row: filter type 0 (none)
    let src = y * width * 4;
    for (let x = 0; x < width; x++) {
      raw[dst++] = rgba[src];
      raw[dst++] = rgba[src + 1];
      raw[dst++] = rgba[src + 2];
      if (hasAlpha) raw[dst++] = rgba[src + 3];
      src += 4;
    }
  }
  const compressed = zlibSync(raw, { level: 6 });

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bits per channel
  header[9] = hasAlpha ? 6 : 2; // colour type: RGBA or RGB

  const chunks: [string, Uint8Array][] = [
    ['IHDR', header],
    ['IDAT', compressed],
    ['IEND', new Uint8Array(0)],
  ];
  const total = 8 + chunks.reduce((sum, [, body]) => sum + 12 + body.length, 0);
  const png = new Uint8Array(total);
  const pngView = new DataView(png.buffer);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let pos = 8;
  for (const [name, body] of chunks) {
    pngView.setUint32(pos, body.length);
    const type = new Uint8Array([name.charCodeAt(0), name.charCodeAt(1), name.charCodeAt(2), name.charCodeAt(3)]);
    png.set(type, pos + 4);
    png.set(body, pos + 8);
    const crc = (crc32(body, crc32(type, 0xffffffff)) ^ 0xffffffff) >>> 0;
    pngView.setUint32(pos + 8 + body.length, crc);
    pos += 12 + body.length;
  }
  return png;
}

/** Texture images are capped at this size when they have to be converted:
 * it is what a GPU is guaranteed to take, and a wall-sized scan at full
 * resolution would otherwise be re-encoded into tens of megabytes. */
export const CONVERTED_TEXTURE_MAX_SIZE = 2048;

/**
 * Convert a texture image glTF cannot carry into a PNG, or return null when
 * its format is not one this package reads (the caller then falls back to
 * the material's flat colour). Images that are already PNG or JPEG are not
 * this function's business and also return null.
 */
export function convertTextureToPng(data: Uint8Array, maxSize: number = CONVERTED_TEXTURE_MAX_SIZE): Uint8Array | null {
  const decoded = decodeTiff(data);
  if (!decoded) return null;
  return encodePng(downscaleImage(decoded, maxSize));
}
