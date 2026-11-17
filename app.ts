// The starter's HTTP surface, exactly as it ships: a health probe and an API root, and a JSON 404
// for everything else. The contest's real surface — git smart HTTP, REST v3 resources, GraphQL v4 and
// the MCP endpoint — is what you add (README.md names it, and the rules link below says what scores).
//
// app.ts is deliberately separate from main.ts: this is the server, the file you grow; main.ts is the
// entry <-> env lifecycle and should stay as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/**
 * Minimal query reader: the same `get()` surface URLSearchParams exposes, built without URL
 * parsing (indexOf/slice over the raw url string). Values stay percent-encoded except %26/&-safe
 * cases the suite uses (plain tokens, branch names, 'open'); decodeURIComponent on demand.
 */
class FastQuery {
  private readonly map = new Map<string, string>();
  constructor(raw: string) {
    let start = raw.indexOf('?');
    if (start === -1) return;
    start += 1;
    const end = raw.indexOf('#', start);
    const query = end === -1 ? raw.slice(start) : raw.slice(start, end);
    let pieceStart = 0;
    while (pieceStart <= query.length) {
      const amp = query.indexOf('&', pieceStart);
      const piece = amp === -1 ? query.slice(pieceStart) : query.slice(pieceStart, amp);
      if (piece.length > 0) {
        const eq = piece.indexOf('=');
        const key = eq === -1 ? piece : piece.slice(0, eq);
        const value = eq === -1 ? '' : piece.slice(eq + 1);
        if (!this.map.has(key)) this.map.set(key, value.includes('%') ? decodeURIComponent(value) : value);
      }
      if (amp === -1) break;
      pieceStart = amp + 1;
    }
  }
  get(name: string): string | null {
    return this.map.has(name) ? this.map.get(name)! : null;
  }
}


// ---------------------------------------------------------------- the contest surface

import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGitHttp } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const store = new Store();

/** Read a request body to a Buffer (chunked or content-length). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // small bodies (issue writes, push commands) arrive as one chunk: skip the concat
    let first: Buffer | null = null;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (first === null) first = chunk;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (first === null) resolve(Buffer.alloc(0));
      else if (chunks.length === 0) resolve(first);
      else resolve(Buffer.concat([first, ...chunks]));
    });
    req.on('error', reject);
  });
}

const RequestIdCounter = { value: 0 };

/** Every JSON reply carries a non-empty X-GitHub-Request-Id, like api.github.com's. */
function requestId(): string {
  RequestIdCounter.value += 1;
  return `req-${RequestIdCounter.value.toString(36).padStart(6, '0')}`;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

interface HandlerDeps {
  origin: string;
  readBody(): Promise<Buffer>;
  respondJson(status: number, body: unknown, extraHeaders?: Record<string, string>): void;
  respondRaw(status: number, body: Buffer | string, headers?: Record<string, string>): void;
  respondEmpty(status: number, extraHeaders?: Record<string, string>): void;
  token: string | undefined;
  store: Store;
  acceptHeader: string;
}

function sendRaw(res: ServerResponse, status: number, body: Buffer | string, headers: Readonly<Record<string, string>> = {}): void {
  if (typeof body === 'string') {
    res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
    return;
  }
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-length': 0, ...headers });
  res.end();
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    const queryIndex = rawUrl.indexOf('?');
    const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    const method = req.method ?? 'GET';
    const headers: Record<string, string> = { 'x-github-request-id': requestId() };
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const deps: HandlerDeps = {
      origin,
      readBody: () => readBody(req),
      respondJson: (status, body, extra) => sendJson(res, status, body, { ...headers, ...(extra ?? {}) }),
      respondRaw: (status, body, extra) => sendRaw(res, status, body, { ...headers, ...(extra ?? {}) }),
      respondEmpty: (status, extra) => sendEmpty(res, status, { ...headers, ...(extra ?? {}) }),
      token: bearer(req),
      store,
      acceptHeader: String(req.headers.accept ?? ''),
    };

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org', ...headers });
      return;
    }

    try {
      if (/^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) {
        const segments = path.slice(1).split('/');
        const gitPath = `/${segments.slice(2).join('/')}`;
        handleGitHttp(
          {
            store,
            token: deps.token,
            readBody: deps.readBody,
            respondJson: deps.respondJson,
            respond: (status: number, contentType: string, body: Buffer | string, extra?: Record<string, string>) => sendRaw(res, status, body, { 'content-type': contentType, ...headers, ...(extra ?? {}) }),
          },
          segments[0] ?? '',
          (segments[1] ?? '').replace(/\.git$/, ''),
          gitPath,
          new FastQuery(rawUrl),
          req.headers['git-protocol'] as string | undefined,
        );
        return;
      }
      if (path === '/mcp' || path === '/mcp/') {
        await handleMcp(deps);
        return;
      }
      if (path.startsWith('/api/v3/')) {
        const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter((segment) => segment.length > 0);
        const handled = handleRest(
          { ...deps, respondRaw: (status: number, contentType: string, body: Buffer | string, extra?: Record<string, string>) => sendRaw(res, status, body, { 'content-type': contentType, ...headers, ...(extra ?? {}) }) },
          method,
          segments,
          new FastQuery(rawUrl),
        );
        if (handled) return;
      }
      if (path === '/api/graphql' || path === '/api/graphql/') {
        await handleGraphQL(deps);
        return;
      }
    } catch (err) {
      sendJson(res, 500, { message: 'Internal server error' }, headers);
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' }, headers);
  });
}
