// mcp.ts: the MCP surface at /api/mcp (Streamable HTTP, JSON-RPC 2.0).
// Serves the github-mcp-server tool surface the suite drives: tools/list + tools/call over
// get_me, list_issues, get_issue, create_issue, close_issue, list_pull_requests, get_pull_request,
// create_pull_request, merge_pull_request, get_file_contents, list_commits, create_repository.
import { parseCommit, parseTree } from './git-core.ts';
import { invalidateIssueJson } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';

export interface McpCtx {
  store: Store;
  token: string | undefined;
  readBody(): Promise<Buffer>;
  respondJson(status: number, body: unknown, extraHeaders?: Record<string, string>): void;
  respondEmpty(status: number, extraHeaders?: Record<string, string>): void;
  acceptHeader: string;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown> | undefined;
}

const PROTOCOL_REVISION = '2026-07-28';
const SERVER_NAME = 'github-mcp-server';
const SERVER_VERSION = '1.0.0';

function result(id: unknown, payload: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: payload };
}

function errorReply(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function textContent(text: string): unknown {
  return { content: [{ type: 'text', text }], isError: false };
}

function errorContent(text: string): unknown {
  return { content: [{ type: 'text', text }], isError: true };
}

// ---------------------------------------------------------------- tool inventory

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'get_me',
    description: 'Get details of the authenticated user.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_repo',
    description: 'Get details of one repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        per_page: { type: 'number' },
        page: { type: 'number' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        per_page: { type: 'number' },
        page: { type: 'number' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get a single pull request.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' }, commit_title: { type: 'string' }, merge_method: { type: 'string' } },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_file_contents',
    description: 'Get file contents from a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } },
      required: ['owner', 'repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_commits',
    description: 'List commits on a ref.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        sha: { type: 'string' },
        per_page: { type: 'number' },
        page: { type: 'number' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_repository',
    description: 'Create a new repository.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' }, auto_init: { type: 'boolean' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- tool execution

function splitIdentity(line: string): { name: string; email: string } {
  const lt = line.lastIndexOf(' <');
  const gt = line.lastIndexOf('>');
  if (lt < 0 || gt < 0) return { name: line, email: '' };
  return { name: line.slice(0, lt), email: line.slice(lt + 2, gt) };
}

function issuePayload(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user },
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.createdAt,
    closed_at: issue.closedAt,
    html_url: '',
  };
}

function pullPayload(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    user: { login: pull.user },
    head: { ref: pull.head },
    base: { ref: pull.base },
    created_at: pull.createdAt,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    html_url: '',
  };
}

function callTool(ctx: McpCtx, name: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  const str = (key: string): string => String(args[key] ?? '');
  const num = (key: string): number => Number(args[key] ?? 0);
  const repo = (): Repo | null => store.getRepo(str('owner'), str('repo'));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  switch (name) {
    case 'get_me':
      return textContent(JSON.stringify({ login: store.viewerLogin, id: store.viewer.id, name: store.viewer.name, type: 'User' }));
    case 'create_repository': {
      const created = store.createRepo(store.viewerLogin, str('name'), typeof args.description === 'string' ? args.description : '', args.private === true);
      if (!created) return errorContent(`repository ${store.viewerLogin}/${str('name')} already exists`);
      return textContent(JSON.stringify({ id: created.id, name: created.name, full_name: `${created.owner}/${created.name}`, private: created.privateFlag }));
    }
    case 'get_repo': {
      const target = repo();
      if (!target) return errorContent('repository not found');
      return textContent(JSON.stringify({ id: target.id, name: target.name, full_name: `${target.owner}/${target.name}`, private: target.privateFlag, default_branch: target.defaultBranch, description: target.description }));
    }
    case 'list_issues': {
      const target = repo();
      if (!target) return errorContent('repository not found');
      const state = str('state') || 'open';
      const all = state === 'all';
      let issues = [...target.issues.values()].filter((issue) => all || issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      const perPage = num('per_page') > 0 ? num('per_page') : 30;
      const page = num('page') > 0 ? num('page') : 1;
      issues = issues.slice((page - 1) * perPage, page * perPage);
      return textContent(JSON.stringify(issues.map(issuePayload)));
    }
    case 'get_issue': {
      const target = repo();
      const issue = target ? store.getIssue(target, num('issue_number')) : null;
      if (!issue) return errorContent('issue not found');
      return textContent(JSON.stringify(issuePayload(issue)));
    }
    case 'create_issue': {
      const target = repo();
      if (!target) return errorContent('repository not found');
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
      const result = store.createIssue(target, str('title'), typeof args.body === 'string' ? args.body : '', labels, store.viewerLogin);
      if ('error' in result) return errorContent(result.error);
      return textContent(JSON.stringify(issuePayload(result.issue)));
    }
    case 'close_issue': {
      const target = repo();
      const issue = target ? store.getIssue(target, num('issue_number')) : null;
      if (!issue) return errorContent('issue not found');
      issue.state = 'closed';
      issue.closedAt = issue.createdAt;
      invalidateIssueJson(issue);
      return textContent(JSON.stringify(issuePayload(issue)));
    }
    case 'list_pull_requests': {
      const target = repo();
      if (!target) return errorContent('repository not found');
      const state = str('state') || 'open';
      let pulls = [...target.pulls.values()].filter((pull) => {
        if (state === 'all') return true;
        const effective = pull.merged ? 'closed' : pull.state;
        return effective === state;
      });
      pulls.sort((a, b) => b.number - a.number);
      const perPage = num('per_page') > 0 ? num('per_page') : 30;
      const page = num('page') > 0 ? num('page') : 1;
      pulls = pulls.slice((page - 1) * perPage, page * perPage);
      return textContent(JSON.stringify(pulls.map(pullPayload)));
    }
    case 'get_pull_request': {
      const target = repo();
      const pull = target ? store.getPull(target, num('pull_number')) : null;
      if (!pull) return errorContent('pull request not found');
      return textContent(JSON.stringify(pullPayload(pull)));
    }
    case 'create_pull_request': {
      const target = repo();
      if (!target) return errorContent('repository not found');
      const result = store.createPull(target, { head: str('head'), base: str('base'), title: str('title'), body: typeof args.body === 'string' ? args.body : '' }, store.viewerLogin);
      if ('error' in result) return errorContent(result.error);
      return textContent(JSON.stringify(pullPayload(result.pull)));
    }
    case 'merge_pull_request': {
      const target = repo();
      const pull = target ? store.getPull(target, num('pull_number')) : null;
      if (!pull) return errorContent('pull request not found');
      const sha = store.mergePull(target, pull);
      if (sha === null) return errorContent('pull request is not mergeable');
      return textContent(JSON.stringify({ merged: true, sha }));
    }
    case 'get_file_contents': {
      const target = repo();
      if (!target) return errorContent('repository not found');
      const ref = str('ref') || target.defaultBranch;
      const resolved = target.refs.get(`refs/heads/${ref}`) ?? target.refs.get(`refs/tags/${ref}`) ?? target.refs.get(ref);
      if (!resolved) return errorContent('ref not found');
      const commit = parseCommit(target.objects.get(resolved) ?? Buffer.alloc(0));
      if (!commit) return errorContent('commit not found');
      const tree = parseTree(target.objects.get(commit.tree) ?? Buffer.alloc(0));
      if (!tree) return errorContent('tree not found');
      const segments = str('path').split('/').filter((segment) => segment.length > 0);
      let entries = tree;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const entry = entries.find((candidate) => candidate.name === segments[index]);
        const nested = entry ? parseTree(target.objects.get(entry.oid) ?? Buffer.alloc(0)) : null;
        if (!nested) return errorContent('path not found');
        entries = nested;
      }
      const leaf = entries.find((candidate) => candidate.name === segments[segments.length - 1]);
      if (!leaf) return errorContent('path not found');
      if (leaf.mode === '40000') {
        const nested = parseTree(target.objects.get(leaf.oid) ?? Buffer.alloc(0));
        return textContent(JSON.stringify(nested.map((entry) => ({ name: entry.name, path: `${str('path')}/${entry.name}`, type: entry.mode === '40000' ? 'tree' : 'blob' }))));
      }
      const blob = target.objects.get(leaf.oid);
      if (!blob) return errorContent('blob not found');
      return textContent(blob.toString('utf8'));
    }
    case 'list_commits': {
      const target = repo();
      if (!target) return errorContent('repository not found');
      const ref = str('sha') || target.defaultBranch;
      const resolved = target.refs.get(`refs/heads/${ref}`) ?? target.refs.get(`refs/tags/${ref}`) ?? target.refs.get(ref);
      if (!resolved) return errorContent('ref not found');
      let oid: string | null = resolved;
      const commits: Array<Record<string, unknown>> = [];
      const perPage = num('per_page') > 0 ? num('per_page') : 30;
      const page = num('page') > 0 ? num('page') : 1;
      const skip = (page - 1) * perPage;
      let index = 0;
      while (oid) {
        const commit = parseCommit(target.objects.get(oid) ?? Buffer.alloc(0));
        if (!commit) break;
        if (index >= skip && commits.length < perPage) {
          commits.push({ sha: oid, message: commit.message, author: { name: splitIdentity(commit.author).name, email: splitIdentity(commit.author).email }, committer: { name: splitIdentity(commit.committer).name, email: splitIdentity(commit.committer).email }, html_url: '' });
        }
        index += 1;
        oid = commit.parents[0] ?? null;
      }
      return textContent(JSON.stringify(commits));
    }
    default:
      return errorContent(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- the endpoint

function wantsSse(acceptHeader: string): boolean {
  return acceptHeader.includes('text/event-stream');
}

export async function handleMcp(ctx: McpCtx): Promise<void> {
  const body = await ctx.readBody();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    ctx.respondJson(400, errorReply(null, -32700, 'Parse error'));
    return;
  }
  const respond = (payload: JsonRpcResponse | JsonRpcResponse[]): void => {
    ctx.respondJson(200, payload);
  };
  if (!ctx.token) {
    ctx.respondJson(401, { message: 'Requires authentication' });
    return;
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => dispatch(ctx, entry as RpcRequest))
      .filter((entry): entry is JsonRpcResponse => entry !== null);
    if (replies.length === 0) {
      ctx.respondEmpty(202);
      return;
    }
    respond(replies);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    ctx.respondJson(400, errorReply(null, -32600, 'Invalid Request'));
    return;
  }
  const reply = dispatch(ctx, parsed as RpcRequest);
  if (reply === null) {
    ctx.respondEmpty(202);
    return;
  }
  respond(reply);
}

function dispatch(ctx: McpCtx, request: RpcRequest): JsonRpcResponse | null {
  const id = request.id;
  const method = String(request.method ?? '');
  const params = request.params ?? {};
  if (method.startsWith('notifications/')) return null;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: PROTOCOL_REVISION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return result(id, {});
  }
  if (method === 'tools/list') {
    return result(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((tool) => tool.name === name)) {
      return errorReply(id, -32602, `Unknown tool: ${name}`);
    }
    return result(id, callTool(ctx, name, args));
  }
  return errorReply(id, -32601, `Method not found: ${method}`);
}
