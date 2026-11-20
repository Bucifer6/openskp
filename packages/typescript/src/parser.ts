import { SkpParseError } from './errors';

export interface TlvNode {
  offset: number;
  tag: string;
  size: number;
  children: TlvNode[];
  payload: Uint8Array;
}

/**
 * VFF (2021+) model.dat binary structure uses Type-Length-Value (TLV) records.
 * Most TLV tags carry raw leaf binary/string payloads, but container tags contain
 * nested sub-TLV nodes (e.g. definitions, drawing elements, component instances).
 * CONTAINER_TAGS lists every tag hex ID that the TLV parser must recursively traverse.
 */
export const CONTAINER_TAGS = new Set<string>([
  'F401', 'F701', 'D430', 'D530', 'C832',
  '7C15', '8813', '8913', '8A13', '8B13', '8C13', '8D13', '4C1D', '6419',
  'F901', '7017', '7117', 'D007', 'C409', '9411', '9511', '0F01',
  '384A', 'B80B', '9713', '2C4C', 'AC0D', 'AE0D', 'F601', 'F801',
  '983A', '993A', '8C3C', '8D3C',
  // Image-entity placement: an Image placed in the model wraps a standard
  // 6419 instance node inside 9013 -> 401F. Without these two containers,
  // that inner instance stays buried in an opaque payload and the image
  // definition looks "never placed".
  '9013', '401F',
  // VFF per-definition guide lines/points and their entity/drawbase wrappers.
  '9113', '9213', '6942', '6C42', '6842',
]);

// Plain byte arithmetic rather than a DataView per call: these two are the
// hottest functions of a VFF parse (one call per TLV record), and the
// throwaway DataView was a measurable share of both the time and the
// garbage on a real 126 MB model.
export function readU32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) {
    throw new Error('Out of bounds readU32');
  }
  return (
    (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0
  );
}

const F64_SCRATCH = new Float64Array(1);
const F64_SCRATCH_BYTES = new Uint8Array(F64_SCRATCH.buffer);
// Whether this machine stores numbers little-endian, as the file does.
// Every platform JavaScript realistically runs on does; the DataView
// fallback below keeps the result right on one that does not.
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function readF64(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 8 > data.length) {
    throw new Error('Out of bounds readF64');
  }
  if (!HOST_IS_LITTLE_ENDIAN) {
    return new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(0, true);
  }
  // Eight byte copies into a reused buffer: a model has one of these per
  // vertex coordinate, and a DataView allocated for each was measurable.
  const b = F64_SCRATCH_BYTES;
  b[0] = data[offset];
  b[1] = data[offset + 1];
  b[2] = data[offset + 2];
  b[3] = data[offset + 3];
  b[4] = data[offset + 4];
  b[5] = data[offset + 5];
  b[6] = data[offset + 6];
  b[7] = data[offset + 7];
  return F64_SCRATCH[0];
}

export function readI32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) {
    throw new Error('Out of bounds readI32');
  }
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
}

export function parseVarInt(data: Uint8Array, offset: number, length: number): number {
  let val = 0;
  let scale = 1;
  for (let i = 0; i < length; i++) {
    val += data[offset + i] * scale;
    scale *= 256;
  }
  return val;
}

/**
 * Deepest container nesting the parser follows. A real model.dat nests about
 * a dozen levels (the deepest file checked reaches 11); a hostile file can
 * nest tens of thousands, which would overflow the call stack before any
 * error could be reported, so deeper input throws a {@link SkpParseError}.
 */
export const MAX_TLV_DEPTH = 64;

function nestingError(tag: string, offset: number): SkpParseError {
  return new SkpParseError(`TLV records nest deeper than ${MAX_TLV_DEPTH} levels`, {
    stage: 'tlv_walk',
    tag,
    offset,
  });
}

const HEX_BYTE: string[] = [];
for (let i = 0; i < 256; i++) HEX_BYTE.push((i < 16 ? '0' : '') + i.toString(16).toUpperCase());
const TAG_NAMES: (string | undefined)[] = new Array(65536);

/** The record tag at `pos` as its 4-character uppercase hex name. Names
 * are interned per tag value, so a file with millions of records builds a
 * few hundred strings instead of one per record. */
export function tagAt(data: Uint8Array, pos: number): string {
  const key = (data[pos] << 8) | data[pos + 1];
  let name = TAG_NAMES[key];
  if (name === undefined) {
    name = HEX_BYTE[data[pos]] + HEX_BYTE[data[pos + 1]];
    TAG_NAMES[key] = name;
  }
  return name;
}

const EMPTY_PAYLOAD = new Uint8Array(0);
/** Shared by every leaf record. Frozen so that an accidental push fails
 * loudly instead of quietly adding a child to every leaf in the file. */
const NO_CHILDREN = Object.freeze([]) as unknown as TlvNode[];

/** A leaf record whose `payload` view is only created when first read.
 *
 * Most walkers match records by tag and never look at the bytes of the
 * records they skip, so creating one `Uint8Array` view per record up front
 * was pure allocation: on a real 126 MB model it was millions of views,
 * nearly all of them thrown away unread. */
class LeafNode implements TlvNode {
  readonly children: TlvNode[] = NO_CHILDREN;
  private view: Uint8Array | undefined = undefined;

  constructor(
    private readonly data: Uint8Array,
    readonly offset: number,
    readonly tag: string,
    readonly size: number
  ) {}

  get payload(): Uint8Array {
    let view = this.view;
    if (view === undefined) {
      view =
        this.size === 0
          ? EMPTY_PAYLOAD
          : this.data.subarray(this.offset + 6, this.offset + 6 + this.size);
      this.view = view;
    }
    return view;
  }
}

export function parseTlvRecursive(
  data: Uint8Array,
  start: number,
  end: number,
  containerTags: Set<string> = CONTAINER_TAGS,
  depth: number = 0
): TlvNode[] {
  let pos = start;
  const elements: TlvNode[] = [];

  while (pos <= end - 6) {
    const size = readU32(data, pos + 2);

    if (pos + 6 + size > end) {
      break;
    }

    const tagHex = tagAt(data, pos);

    if (size > 0 && containerTags.has(tagHex)) {
      if (depth >= MAX_TLV_DEPTH) throw nestingError(tagHex, pos);
      const children = parseTlvRecursive(data, pos + 6, pos + 6 + size, containerTags, depth + 1);
      if (children.length > 0) {
        elements.push({ offset: pos, tag: tagHex, size, children, payload: EMPTY_PAYLOAD });
      } else {
        // A container whose bytes hold no complete record keeps them as a
        // payload, exactly as a leaf does.
        elements.push(new LeafNode(data, pos, tagHex, size));
      }
    } else {
      elements.push(new LeafNode(data, pos, tagHex, size));
    }

    pos += 6 + size;
  }

  return elements;
}

/** Scan [start, end) for direct-child (tag, offset, size) headers only,
 * without recursing into any container - O(sibling count), not O(total
 * node count). Used by iterTopLevelLazy to locate top-level records one at
 * a time. */
function flatHeaders(data: Uint8Array, start: number, end: number): [string, number, number][] {
  const headers: [string, number, number][] = [];
  let pos = start;
  while (pos <= end - 6) {
    const size = readU32(data, pos + 2);
    if (pos + 6 + size > end) break;
    headers.push([tagAt(data, pos), pos, size]);
    pos += 6 + size;
  }
  return headers;
}

/** Throw if a top-level record declares more bytes than the data holds.
 *
 * `flatHeaders` stops quietly at such a record, so a model.dat cut short
 * anywhere inside its single F401 record would parse as a model with no
 * geometry and no error. Real files end exactly where their last top-level
 * record does. Records nested inside it are deliberately left lenient: in
 * real files some container payloads end with bytes that are not records,
 * and a strict check there would reject valid models. */
function requireCompleteTopLevel(data: Uint8Array, start: number, end: number): void {
  let pos = start;
  while (pos <= end - 6) {
    const size = readU32(data, pos + 2);
    if (pos + 6 + size > end) {
      const tag = ((data[pos] << 8) | data[pos + 1]).toString(16).toUpperCase().padStart(4, '0');
      throw new SkpParseError(
        `model.dat is truncated: the top-level record declares ${size} bytes but only ${end - pos - 6} remain`,
        { stage: 'tlv_walk', tag, offset: pos }
      );
    }
    pos += 6 + size;
  }
}

export interface TopLevelRecord {
  index: number;
  total: number;
  node: TlvNode;
}

/** Pure wrapper containers on the path to the component definitions:
 * "F901" > "7017" > "7117" > one "7C15" per definition. In real files this
 * chain holds nearly the whole model (a 297 MB model.dat had 100% of its
 * bytes under a single F901), so yielding F901 as one record built the
 * entire definitions tree at once. No consumer of iterTopLevelLazy matches
 * these three tags - every walker searches by tag at any depth - so
 * yielding their children one at a time instead is equivalent. */
const PASS_THROUGH_WRAPPERS = new Set<string>(['F901', '7017', '7117']);

/** Replace each pass-through wrapper header with its children's headers,
 * recursively, keeping file order. Header scans only - no subtree is
 * built. */
function expandWrappers(
  data: Uint8Array,
  headers: [string, number, number][],
  containerTags: Set<string>,
  depth: number = 0
): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const header of headers) {
    const [tag, offset, size] = header;
    if (PASS_THROUGH_WRAPPERS.has(tag) && containerTags.has(tag)) {
      if (depth >= MAX_TLV_DEPTH) throw nestingError(tag, offset);
      out.push(
        ...expandWrappers(data, flatHeaders(data, offset + 6, offset + 6 + size), containerTags, depth + 1)
      );
    } else {
      out.push(header);
    }
  }
  return out;
}

/** Yield `{index, total, node}` for each top-level TLV record's
 * fully-recursed node one at a time, transparently unwrapping a lone "F401"
 * wrapper and the F901 > 7017 > 7117 definitions chain (so each "7C15"
 * definition is its own record) - without ever materializing more than one
 * record subtree simultaneously. `total` (the record count) comes for free
 * from the same cheap header scan that drives the loop, so callers can
 * report "N of total" progress with no extra pass over the file. Each
 * yielded node is safe to discard (drop all references) once the caller is
 * done with it, before the next one is produced - that's what keeps peak
 * memory bounded by the size of the single largest record instead of the
 * whole file (real production files can have 100k+ separate definitions). */
export function* iterTopLevelLazy(
  data: Uint8Array,
  start: number,
  end: number,
  containerTags: Set<string> = CONTAINER_TAGS
): Generator<TopLevelRecord> {
  requireCompleteTopLevel(data, start, end);
  let headers = flatHeaders(data, start, end);
  if (headers.length === 1 && headers[0][0] === 'F401') {
    const [, f401Offset, f401Size] = headers[0];
    headers = flatHeaders(data, f401Offset + 6, f401Offset + 6 + f401Size);
  }
  headers = expandWrappers(data, headers, containerTags);

  const total = headers.length;
  let index = 0;
  for (const [, offset, size] of headers) {
    const recordEnd = offset + 6 + size;
    const nodes = parseTlvRecursive(data, offset, recordEnd, containerTags);
    if (nodes.length > 0) {
      yield { index, total, node: nodes[0] };
    }
    index++;
  }
}
