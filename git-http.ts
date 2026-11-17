// git-http.ts: the git smart-HTTP surface. Protocol v2 upload-pack (ls-refs, fetch with shallow),
// v0 upload-pack fallback, v0 receive-pack with report-status + side-band-64k + delete-refs.
import {
  ZERO_OID, encodePktLines, decodePktLines, encodePktLine, PKT_FLUSH, PKT_DELIM,
  writePack, readPackObjects, parseCommit, parseTree, isObjectId,
} from './git-core.ts';
import type { Store, Repo, GitObject } from './store.ts';

const SERVICE_UPLOAD = 'git-upload-pack';
const SERVICE_RECEIVE = 'git-receive-pack';

/** Per-repo response caches: upload-pack answers are pure functions of (request, repo state). */
interface RepoCache {
  version: number;
  v2Fetch: Map<string, Buffer>;
  lsRefs: Map<string, Buffer>;
}
const repoCaches = new WeakMap<Repo, RepoCache>();
function cacheOf(repo: Repo): RepoCache {
  let cache = repoCaches.get(repo);
  if (!cache || cache.version !== repo.stateVersion) {
    cache = { version: repo.stateVersion, v2Fetch: new Map(), lsRefs: new Map() };
    repoCaches.set(repo, cache);
  }
  return cache;
}

interface Ctx {
  store: Store;
  token: string | undefined;
  readBody(): Promise<Buffer>;
  /** raw response writer; returns once written */
  respond(status: number, contentType: string, body: Buffer | string, extraHeaders?: Record<string, string>): void;
}

function advertisement(repo: Repo, service: string): Buffer {
  // v0 ref advertisement with capabilities on the first line (cached per repo state + service)
  const cache = cacheOf(repo);
  const cacheKey = `adv|${service}`;
  const hit = cache.lsRefs.get(cacheKey);
  if (hit) return hit;
  const built = buildAdvertisement(repo, service);
  if (cache.lsRefs.size < 64) cache.lsRefs.set(cacheKey, built);
  return built;
}

function buildAdvertisement(repo: Repo, service: string): Buffer {
  // v0 ref advertisement with capabilities on the first line
  const caps = service === SERVICE_RECEIVE
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta shallow'
    : 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=ghc-forge/1.0';
  const lines: string[] = [];
  let first = true;
  const headSymref = repo.refs.get('HEAD') ?? `refs/heads/${repo.defaultBranch}`;
  const entries: Array<[string, string]> = [];
  for (const [name, oid] of [...repo.refs].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (name === 'HEAD') entries.push([name, oid]);
    else if (name.startsWith('refs/')) entries.push([name, oid]);
  }
  for (const [name, oid] of entries) {
    if (first) {
      first = false;
      const symref = name === 'HEAD' ? ` symref=HEAD:${headSymref}` : '';
      lines.push(`${oid} ${name}\0${caps}${symref}\n`);
    } else {
      lines.push(`${oid} ${name}\n`);
    }
  }
  // peeled tags
  for (const [name, oid] of entries) {
    if (!name.startsWith('refs/tags/')) continue;
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})/m.exec(text);
      if (match) lines.push(`${match[1]} ${name}^{}\n`);
    }
  }
  if (first) lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'agent=ghc-forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'server-option\n',
    'object-format=sha1\n',
    PKT_FLUSH,
  ]);
}

/** Respond with the smart-HTTP advertisement framing: service preamble + advertisement bytes. */
function advertisementResponse(ctx: Ctx, service: string, body: Buffer, protocol: 0 | 2): void {
  if (protocol === 0) {
    const preamble = encodePktLine(`# service=${service}\n`);
    ctx.respond(200, `application/x-${service}-advertisement`, Buffer.concat([preamble, PKT_FLUSH, body]));
  } else {
    ctx.respond(200, `application/x-${service}-advertisement`, body);
  }
}

interface LsRefsRequest { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }

function parseLsRefsRequest(packets: ReturnType<typeof decodePktLines>): LsRefsRequest {
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').trim();
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice('ref-prefix '.length));
  }
  return request;
}

function lsRefsResponse(repo: Repo, request: LsRefsRequest): Buffer {
  const key = `${repo.stateVersion}|${request.peel}|${request.symrefs}|${request.unborn}|${request.prefixes.join(',')}`;
  const cache = cacheOf(repo);
  const hit = cache.lsRefs.get(key);
  if (hit) return hit;
  const built = buildLsRefsResponse(repo, request);
  if (cache.lsRefs.size < 64) cache.lsRefs.set(key, built);
  return built;
}

function buildLsRefsResponse(repo: Repo, request: LsRefsRequest): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean => request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  if (!request.prefixes.length || request.prefixes.some((p) => 'HEAD'.startsWith(p) || p === '')) {
    const headOid = repo.refs.get(headTarget);
    if (headOid) {
      const tokens = [headOid, 'HEAD'];
      if (request.symrefs) tokens.push(`symref-target:${headTarget}`);
      lines.push(`${tokens.join(' ')}\n`);
    } else if (request.unborn) {
      lines.push(`unborn HEAD${request.symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    }
  }
  const sorted = [...repo.refs].filter(([name]) => name.startsWith('refs/')).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, oid] of sorted) {
    if (!keep(name)) continue;
    const tokens = [oid, name];
    const object = repo.objects.get(oid);
    if (request.peel && object && object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match) tokens.push(`peeled:${match[1]}`);
    }
    lines.push(`${tokens.join(' ')}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------- v2 fetch

interface FetchRequestV2 {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseV2Fetch(packets: ReturnType<typeof decodePktLines>): FetchRequestV2 {
  const request: FetchRequestV2 = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || !inArgs) continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) request.wants.push(line.slice(5));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7), 10);
    else if (line === 'done') request.done = true;
  }
  return request;
}

function ancestors(repo: Repo, oid: string, lookup: (oid: string) => GitObject | undefined): string[] {
  const chain: string[] = [];
  let current = oid;
  while (isObjectId(current)) {
    chain.push(current);
    const object = lookup(current);
    if (!object || object.type !== 'commit') break;
    const parents = parseCommit(object.data).parents;
    current = parents[0] ?? ZERO_OID;
  }
  return chain;
}

/** The pack for a v2/v0 fetch: objects reachable from wants minus those reachable from haves, honoring depth. */
function fetchPack(repo: Repo, request: FetchRequestV2): { pack: Buffer; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const havesSet = new Set(request.haves.filter(isObjectId));
  const acks: string[] = [];
  for (const have of request.haves) {
    if (isObjectId(have) && repo.objects.has(have)) acks.push(have);
  }
  const nak = acks.length === 0;
  const depth = request.depth;
  const send = new Set<string>(); // commits to send
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const want of request.wants) {
    if (!isObjectId(want) || !repo.objects.has(want)) continue;
    const object = lookup(want)!;
    if (object.type !== 'commit') {
      send.add(want);
      continue;
    }
    // Commit walk from the want, generation-tracked; cut at commits the client holds.
    const visited = new Set<string>();
    const queue: Array<{ oid: string; gen: number }> = [{ oid: want, gen: 1 }];
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (visited.has(oid)) continue;
      const commit = lookup(oid);
      if (!commit || commit.type !== 'commit') continue;
      visited.add(oid);
      const held = havesSet.has(oid);
      if (depth == null) {
        if (held) continue; // full fetch: cut at the commits the client holds
        send.add(oid);
      } else if (!held) {
        send.add(oid); // shallow/deepen: only the generations the client lacks are sent
      }
      const parsed = parseCommit(commit.data);
      const existingParents = parsed.parents.filter((parent) => repo.objects.has(parent));
      if (depth != null && gen >= depth) {
        if (existingParents.length > 0) {
          if (!shallow.includes(oid)) shallow.push(oid);
        } else if (!unshallow.includes(oid)) {
          unshallow.push(oid);
        }
        continue; // history beyond depth is never sent
      }
      for (const parent of existingParents) queue.push({ oid: parent, gen: gen + 1 });
    }
    // Tree/blob closure of the sent commits only (never via parents the client may lack).
    const treeQueue: string[] = [];
    for (const oid of send) {
      const commit = lookup(oid);
      if (commit && commit.type === 'commit') treeQueue.push(parseCommit(commit.data).tree);
    }
    // The client's held commits' tree/blob closure: objects under them must not be re-sent.
    const haveClosure = new Set<string>();
    if (havesSet.size > 0 && depth == null) {
      for (const have of havesSet) {
        const held = lookup(have);
        if (!held || held.type !== 'commit') continue;
        const tree = parseCommit(held.data).tree;
        const stack = [tree];
        while (stack.length > 0) {
          const oid = stack.pop()!;
          if (haveClosure.has(oid)) continue;
          haveClosure.add(oid);
          const object = lookup(oid);
          if (object && object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
        }
      }
    }
    const seenTrees = new Set<string>();
    while (treeQueue.length > 0) {
      const oid = treeQueue.pop()!;
      if (seenTrees.has(oid) || haveClosure.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      seenTrees.add(oid);
      send.add(oid);
      if (object.type === 'tree') for (const entry of parseTree(object.data)) treeQueue.push(entry.oid);
    }
    if (depth != null) {
      // shallow: skip the haveClosure filter, but still never re-send the client's held commit trees
    }
  }
  const objects: Array<{ type: GitObject['type']; data: Buffer }> = [];
  for (const oid of send) {
    const object = lookup(oid);
    if (object) objects.push({ type: object.type, data: object.data });
  }
  if (process.env.GHC_DEBUG) process.stderr.write(`fetchPack wants=${JSON.stringify(request.wants)} haves=${JSON.stringify(request.haves)} depth=${depth} send=${[...send].join(',')} shallow=${shallow} unshallow=${unshallow}\n`);
  return { pack: writePack(objects), shallow, unshallow, acks, nak };
}

function v2FetchResponse(repo: Repo, request: FetchRequestV2): Buffer {
  const key = `${repo.stateVersion}|w:${request.wants.join(',')}|h:${request.haves.join(',')}|d:${request.depth}`;
  const cache = cacheOf(repo);
  const hit = cache.v2Fetch.get(key);
  if (hit) return hit;
  const built = buildV2FetchResponse(repo, request);
  if (cache.v2Fetch.size < 64) cache.v2Fetch.set(key, built);
  return built;
}

function buildV2FetchResponse(repo: Repo, request: FetchRequestV2): Buffer {
  const result = fetchPack(repo, request);
  const sections: Buffer[] = [];
  const ackLines: string[] = [];
  if (result.nak) ackLines.push('NAK\n');
  else for (const ack of result.acks) ackLines.push(`ACK ${ack} last\n`);
  sections.push(encodePktLine('acknowledgments\n'), ...ackLines.map((line) => encodePktLine(line)), PKT_FLUSH);
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    const lines = [
      encodePktLine('shallow-info\n'),
      ...result.shallow.map((oid) => encodePktLine(`shallow ${oid}\n`)),
      ...result.unshallow.map((oid) => encodePktLine(`unshallow ${oid}\n`)),
      PKT_FLUSH,
    ];
    sections.push(...lines);
  }
  sections.push(encodePktLine('packfile\n'));
  const pack = result.pack;
  // side-band-64k framing: band 1, max 65519 bytes a frame
  const FRAME = 65515;
  for (let offset = 0; offset < pack.length; offset += FRAME) {
    const chunk = pack.subarray(offset, Math.min(offset + FRAME, pack.length));
    const frame = Buffer.allocUnsafe(chunk.length + 1);
    frame[0] = 1;
    chunk.copy(frame, 1);
    sections.push(encodePktLine(frame));
  }
  sections.push(PKT_FLUSH);
  return Buffer.concat(sections);
}

// ---------------------------------------------------------------- v0 upload-pack fetch

function v0FetchResponse(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body.subarray(0, body.length));
  // split: wants section (before first flush), then negotiation
  let section = 0;
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        if (space >= 0) {
          wants.push(rest.slice(0, space));
          capabilities = rest.slice(space + 1);
        } else wants.push(rest);
      } else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5));
    }
  }
  const request: FetchRequestV2 = { wants, haves, shallow: [], depth, done: true };
  const result = fetchPack(repo, request);
  const parts: Buffer[] = [];
  const sideband = capabilities.includes('side-band-64k');
  const control: string[] = [];
  if (result.acks.length > 0) control.push(`ACK ${result.acks[0]} last\n`);
  else control.push('NAK\n');
  for (const oid of result.shallow) control.push(`shallow ${oid}\n`);
  for (const oid of result.unshallow) control.push(`unshallow ${oid}\n`);
  if (sideband) {
    for (const line of control) {
      const frame = Buffer.from(`\u0001${line}`, 'utf8');
      parts.push(encodePktLine(frame));
    }
    const pack = result.pack;
    const FRAME = 65515;
    for (let offset = 0; offset < pack.length; offset += FRAME) {
      const chunk = pack.subarray(offset, Math.min(offset + FRAME, pack.length));
      const frame = Buffer.allocUnsafe(chunk.length + 1);
      frame[0] = 1;
      chunk.copy(frame, 1);
      parts.push(encodePktLine(frame));
    }
  } else {
    for (const line of control) parts.push(encodePktLine(line));
    parts.push(result.pack);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

function receivePackResponse(repo: Repo, body: Buffer, store: Store): Buffer {
  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  let capabilities = '';
  let packBytes: Buffer | null = null;
  // one pass: the command section is pkt-framed; the packfile follows the first flush as raw bytes
  let offset = 0;
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    let length = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = body[offset + i]!;
      if (byte < 0x30 || byte > 0x66) { length = -1; break; }
      const nibble = byte <= 0x39 ? byte - 0x30 : (byte & 0xdf) - 0x37;
      if (nibble < 0 || nibble > 15) { length = -1; break; }
      length = (length << 4) | nibble;
    }
    if (length <= 0) {
      if (length === 0) { offset += 4; sawFlush = true; continue; }
      break;
    }
    if (offset + length > body.length) break;
    if (!sawFlush) {
      let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length >= 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      }
    }
    offset += length;
  }
  if (sawFlush && offset < body.length) packBytes = body.subarray(offset);

  // unpack
  let unpackOk = true;
  let unpackDetail = 'ok';
  const received = new Map<string, GitObject>();
  if (packBytes !== null && packBytes.length > 0) {
    try {
      const read = readPackObjects(packBytes);
      for (const [oid, object] of read.objects) {
        store.putObject(repo, object.type, object.data, oid);
        received.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpacker error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // apply commands with fast-forward enforcement
  const reportLines: string[] = [];
  if (unpackOk) {
    for (const command of commands) {
      if (command.newOid === ZERO_OID) {
        repo.refs.delete(command.ref);
        repo.stateVersion += 1;
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} missing necessary objects\n`);
        continue;
      }
      if (!store.isFastForward(repo, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      repo.stateVersion += 1;
      reportLines.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  }

  const sideband = capabilities.includes('side-band-64k');
  // report-status (v1 format) is fine for both report-status and report-status-v2 requests here
  const report = encodePktLines([`${unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`}\n`, ...reportLines]);

  if (sideband) {
    const parts: Buffer[] = [];
    for (let offset2 = 0; offset2 < report.length; offset2 += 65515) {
      const chunk = report.subarray(offset2, Math.min(offset2 + 65515, report.length));
      const frame = Buffer.allocUnsafe(chunk.length + 1);
      frame[0] = 1;
      chunk.copy(frame, 1);
      parts.push(encodePktLine(frame));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return report;
}

// ---------------------------------------------------------------- the dispatcher

export function handleGitHttp(
  ctx: Ctx,
  owner: string,
  repoName: string,
  path: string,
  query: URLSearchParams,
  gitProtocolHeader: string | undefined,
): void {
  const service = query.get('service');
  const repo = ctx.store.getRepo(owner, repoName.replace(/\.git$/, ''));

  if (path === '/info/refs') {
    if (!repo) {
      ctx.respond(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
      return;
    }
    if (service === SERVICE_UPLOAD) {
      const wantsV2 = gitProtocolHeader?.includes('version=2') ?? false;
      if (wantsV2) {
        advertisementResponse(ctx, service, v2Advertisement(), 2);
        return;
      }
      advertisementResponse(ctx, service, advertisement(repo, service), 0);
      return;
    }
    if (service === SERVICE_RECEIVE) {
      advertisementResponse(ctx, service, advertisement(repo, service), 0);
      return;
    }
    ctx.respond(400, 'application/json', JSON.stringify({ message: 'service parameter required' }));
    return;
  }

  // POST service endpoints
  const isUploadPost = path === `/${SERVICE_UPLOAD}`;
  const isReceivePost = path === `/${SERVICE_RECEIVE}`;
  if (!isUploadPost && !isReceivePost) {
    ctx.respond(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
    return;
  }
  if (!repo) {
    ctx.respond(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
    return;
  }
  void ctx.readBody().then((body) => {
    try {
      if (isReceivePost) {
        const report = receivePackResponse(repo, body, ctx.store);
        ctx.respond(200, `application/x-${SERVICE_RECEIVE}-result`, report);
        return;
      }
      // upload-pack POST: v2 command request or v0 fetch
      const packets = decodePktLines(body);
      const firstData = packets.find((packet) => packet.kind === 'data');
      const firstLine = firstData && firstData.kind === 'data' ? firstData.payload.toString('utf8').trim() : '';
      if (firstLine.startsWith('command=')) {
        const command = firstLine.slice('command='.length).trim();
        if (command === 'ls-refs') {
          const request = parseLsRefsRequest(packets);
          ctx.respond(200, `application/x-${SERVICE_UPLOAD}-result`, lsRefsResponse(repo, request));
          return;
        }
        if (command === 'fetch') {
          const request = parseV2Fetch(packets);
          ctx.respond(200, `application/x-${SERVICE_UPLOAD}-result`, v2FetchResponse(repo, request));
          return;
        }
        ctx.respond(400, `application/x-${SERVICE_UPLOAD}-result`, encodePktLines(['ERR unknown command\n']));
        return;
      }
      // v0 fetch
      ctx.respond(200, `application/x-${SERVICE_UPLOAD}-result`, v0FetchResponse(repo, body));
    } catch (err) {
      if (process.env.GHC_DEBUG) process.stderr.write(`git-http error: ${err instanceof Error ? err.stack : String(err)}\n`);
      ctx.respond(500, 'application/json', JSON.stringify({ message: 'internal error' }));
    }
  });
}
