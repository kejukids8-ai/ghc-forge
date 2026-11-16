// git-core.ts: SHA-1 object hashing, tree/commit/tag build+parse, pkt-line codec, packfile read+write.
// Pure functions over Buffers, node built-ins only. The server side of the smart-HTTP protocol.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);
export const PKT_MAX_PAYLOAD = 65516;

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry { mode: string; name: string; oid: string }

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits / tags

export function identityLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  const head = lines.join('\n');
  return Buffer.from(`${head}\n\n${input.message}`, 'utf8');
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildTag(input: { object: string; type: GitObjectType; tag: string; message: string; tagger: string }): Buffer {
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger}\n\n${input.message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-line

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

export function decodePktLines(bytes: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const hex = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------- packfile write (plain objects, no deltas)

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: ReadonlyArray<{ type: GitObjectType; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    chunks.push(packObjectHeader(TYPE_CODES[object.type], object.data.length));
    chunks.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- packfile read (plain objects; deltas tolerated via inflate of base)

interface RawEntry { typeCode: number; data: Buffer; baseOfs?: number; baseOid?: string }

export function readPackObjects(pack: Buffer): { objects: Map<string, { type: GitObjectType; data: Buffer }>; count: number } {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('bad pack header');
  }
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const byOffset = new Map<number, RawEntry>();
  const order: number[] = [];
  let offset = 12;
  const readVarintSize = (start: number): { size: number; type: number; next: number } => {
    let byte = pack[start]!;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    let cursor = start + 1;
    while (byte & 0x80) {
      byte = pack[cursor++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { size, type, next: cursor };
  };
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(offset);
    offset = header.next;
    const entry: RawEntry = { typeCode: header.type, data: Buffer.alloc(0) };
    if (header.type === 6) {
      // ofs-delta: negative offset varint
      let byte = pack[offset++]!;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOfs = entryOffset - value;
    } else if (header.type === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (header.type < 1 || header.type > 4) {
      throw new Error(`bad pack entry type ${header.type}`);
    }
    // inflate from offset; zlib stream ends where it ends
    const inflated = inflateSync(pack.subarray(offset, trailerStart));
    entry.data = inflated;
    offset += inflated.length ? findDeflateEnd(pack, offset, trailerStart) : 0;
    byOffset.set(entryOffset, entry);
    order.push(entryOffset);
  }
  const resolved = new Map<number, { type: GitObjectType; data: Buffer }>();
  const codeType: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolveOf = (entry: RawEntry): { type: GitObjectType; data: Buffer } => {
    if (entry.typeCode >= 1 && entry.typeCode <= 4) return { type: codeType[entry.typeCode]!, data: entry.data };
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOfs!);
      if (!base) throw new Error('ofs-delta base missing');
      const parent = resolveOf(base);
      return { type: parent.type, data: applyDelta(parent.data, entry.data) };
    }
    const base = resolved.get(entry.baseOid!) ?? findInResolved(entry.baseOid!);
    if (!base) throw new Error('ref-delta base missing');
    return { type: base.type, data: applyDelta(base.data, entry.data) };
  };
  const findInResolved = (oid: string): { type: GitObjectType; data: Buffer } | undefined => {
    for (const entryOffset of order) {
      const entry = byOffset.get(entryOffset)!;
      const object = resolved.get(entryOffset);
      if (object && hashObject(object.type, object.data) === oid) return object;
      if (object) continue;
      const res = resolveOf(entry);
      resolved.set(entryOffset, res);
      if (hashObject(res.type, res.data) === oid) return res;
    }
    return undefined;
  };
  const objects = new Map<string, { type: GitObjectType; data: Buffer }>();
  for (const entryOffset of order) {
    if (resolved.has(entryOffset)) continue;
    const object = resolveOf(byOffset.get(entryOffset)!);
    resolved.set(entryOffset, object);
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, count: declared };
}

/** Walk the zlib stream to find where the deflate data ends (zlib stream length). */
function findDeflateEnd(pack: Buffer, start: number, limit: number): number {
  // Binary search with a decaying-window final pass would still re-inflate; instead inflate once with
  // a growing window that doubles (amortized O(stream length)), then close in linearly on the last step.
  let low = 2;
  let end = Math.min(limit, start + 64);
  for (;;) {
    try {
      inflateSync(pack.subarray(start, end));
      // stream may end before `end` — trim: inflate is tolerant of trailing bytes, so bisect the tail
      let hi = end;
      let lo = low;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        try {
          inflateSync(pack.subarray(start, mid));
          hi = mid;
        } catch {
          lo = mid + 1;
        }
      }
      return hi - start;
    } catch {
      if (end >= limit) throw new Error('truncated deflate stream in pack');
      low = end + 1;
      end = Math.min(limit, end * 2);
    }
  }
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let byte = delta[offset++]!;
    let value = byte & 0x7f;
    let shift = 7;
    while (byte & 0x80) {
      byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return value;
  };
  readSize(); // base size
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** (8 * bit);
      for (let bit = 4; bit < 7; bit += 1) if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** (8 * (bit - 4));
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    }
  }
  return out;
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex') === trailer;
}

// ---------------------------------------------------------------- reachability

export function collectReachable(
  tips: readonly string[],
  lookup: (oid: string) => { type: GitObjectType; data: Buffer } | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree, ...parsed.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}
