// graphql.ts: GitHub GraphQL v4 at /api/graphql. A small document executor covering the fields the
// suite's documents read (gh + github-mcp-server shapes), with introspection via __type.
import type { Store, Repo, Issue, Pull } from './store.ts';
import { parseCommit, parseTree } from './git-core.ts';

export interface GqlCtx {
  store: Store;
  token: string | undefined;
  readBody(): Promise<Buffer>;
  respondJson(status: number, body: unknown, extraHeaders?: Record<string, string>): void;
}

// ---------------------------------------------------------------- schema metadata (for __type)

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'state', 'merged', 'body', 'headRefName', 'baseRefName', 'mergeable', 'mergeCommit', 'files', 'author', 'createdAt', 'url', 'repository'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'description', 'createdAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION', 'PULL_REQUEST'];
const ISSUE_STATE_VALUES = ['OPEN', 'CLOSED'];
const PULL_REQUEST_STATE_VALUES = ['OPEN', 'CLOSED', 'MERGED'];

// ---------------------------------------------------------------- global ids

function globalId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), value: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- minimal parser

interface Selection { name: string; alias: string; args: Record<string, unknown>; selections: Selection[]; fragmentOn?: string }
interface Operation { type: 'query' | 'mutation'; name: string; selections: Selection[]; variableDefs: Array<{ name: string; type: string }> }

/** Tokenize + parse enough GraphQL to walk the suite's documents. */
export function parseDocument(text: string): Operation[] {
  let pos = 0;
  const skip = (): void => {
    for (;;) {
      while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
      if (pos < text.length && text[pos] === '#') {
        while (pos < text.length && text[pos] !== '\n') pos += 1;
        continue;
      }
      if (text[pos] === ',') {
        pos += 1;
        continue;
      }
      break;
    }
  };
  const peek = (): string => {
    skip();
    return text[pos] ?? '';
  };
  const eat = (token: string): boolean => {
    skip();
    if (text.startsWith(token, pos)) {
      pos += token.length;
      return true;
    }
    return false;
  };
  const readName = (): string => {
    skip();
    const start = pos;
    while (pos < text.length && /[A-Za-z0-9_]/.test(text[pos]!)) pos += 1;
    return text.slice(start, pos);
  };
  const readValue = (): unknown => {
    skip();
    const ch = text[pos];
    if (ch === '"') {
      pos += 1;
      let out = '';
      while (pos < text.length && text[pos] !== '"') {
        if (text[pos] === '\\') {
          pos += 1;
          const escape = text[pos];
          if (escape === 'n') out += '\n';
          else if (escape === 't') out += '\t';
          else if (escape === '"') out += '"';
          else if (escape === '\\') out += '\\';
          else out += escape ?? '';
          pos += 1;
        } else {
          out += text[pos];
          pos += 1;
        }
      }
      pos += 1;
      return out;
    }
    if (ch === '$') {
      pos += 1;
      return { __var: readName() };
    }
    if (ch === '[') {
      pos += 1;
      const items: unknown[] = [];
      while (peek() !== ']') items.push(readValue());
      pos += 1;
      return items;
    }
    if (ch === '{') {
      pos += 1;
      const object: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (text[pos] === '}') {
          pos += 1;
          break;
        }
        const key = readName();
        eat(':');
        object[key] = readValue();
      }
      return object;
    }
    // enum or int
    const start = pos;
    while (pos < text.length && /[A-Za-z0-9_.-]/.test(text[pos]!)) pos += 1;
    const raw = text.slice(start, pos);
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    if (raw === 'null') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return { __enum: raw };
  };
  const readArguments = (): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    if (!eat('(')) return args;
    for (;;) {
      skip();
      if (text[pos] === ')') {
        pos += 1;
        break;
      }
      const name = readName();
      eat(':');
      args[name] = readValue();
    }
    return args;
  };
  const readSelections = (): Selection[] => {
    const out: Selection[] = [];
    eat('{');
    for (;;) {
      skip();
      if (text[pos] === '}') {
        pos += 1;
        break;
      }
      if (eat('...')) {
        skip();
        if (text.slice(pos, pos + 2) === 'on') {
          pos += 2;
          const on = readName();
          out.push({ name: '', alias: '', args: {}, selections: readSelections(), fragmentOn: on });
        } else {
          // named fragment spread: resolve later via fragments map — treat inline as skip for now
          readName();
        }
        continue;
      }
      const nameOrAlias = readName();
      let alias = nameOrAlias;
      let name = nameOrAlias;
      if (eat(':')) {
        name = readName();
      }
      const args = readArguments();
      // directives
      for (;;) {
        skip();
        if (text[pos] === '@') {
          pos += 1;
          readName();
          readArguments();
          continue;
        }
        break;
      }
      let sub: Selection[] = [];
      skip();
      if (text[pos] === '{') sub = readSelections();
      out.push({ name, alias, args, selections: sub, fragmentOn: undefined });
    }
    return out;
  };
  const operations: Operation[] = [];
  for (;;) {
    skip();
    if (pos >= text.length) break;
    if (eat('fragment')) {
      readName();
      eat('on');
      readName();
      readSelections();
      continue;
    }
    let type: 'query' | 'mutation' = 'query';
    if (eat('mutation')) type = 'mutation';
    else eat('query');
    skip();
    let name = '';
    if (peek() !== '(' && peek() !== '{') {
      name = readName();
    }
    // variable definitions
    const variableDefs: Array<{ name: string; type: string }> = [];
    if (eat('(')) {
      for (;;) {
        skip();
        if (text[pos] === ')') {
          pos += 1;
          break;
        }
        eat('$');
        const varName = readName();
        eat(':');
        // type: [Type!]! etc
        let typeText = '';
        skip();
        if (text[pos] === '[') {
          typeText += '[';
          pos += 1;
          typeText += readName();
          eat('!');
          typeText += ']';
        } else {
          typeText = readName();
        }
        eat('!');
        variableDefs.push({ name: varName, type: typeText });
      }
    }
    const selections = readSelections();
    operations.push({ type, name, selections, variableDefs });
  }
  return operations;
}

// ---------------------------------------------------------------- execution

type Json = Record<string, unknown>;

function resolveVar(value: unknown, variables: Readonly<Record<string, unknown>>): unknown {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.__var === 'string') return variables[record.__var];
    if (typeof record.__enum === 'string') return record.__enum;
    if (Array.isArray(value)) return value.map((item) => resolveVar(item, variables));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = resolveVar(item, variables);
    return out;
  }
  return value;
}

interface RepoCtx {
  store: Store;
  repo: Repo;
}

function repositoryObject(ctx: GqlCtx, repo: Repo): Json {
  return {
    id: globalId('repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __kind: 'RepositoryOwner', login: repo.owner },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.privateFlag,
    description: repo.description,
    createdAt: repo.createdAt,
    url: '',
  };
}

function issueObject(issue: Issue): Json {
  return {
    id: globalId('issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.closedAt ?? issue.createdAt,
    closedAt: issue.closedAt,
    author: { __kind: 'RepositoryOwner', login: issue.user },
    labels: { nodes: issue.labels.map((name) => ({ name, color: 'ededed' })) },
    url: '',
  };
}

function pullObject(pull: Pull): Json {
  return {
    id: globalId('pullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: 'MERGEABLE',
    createdAt: pull.createdAt,
    author: { __kind: 'RepositoryOwner', login: pull.user },
    url: '',
  };
}

function executeSelections(ctx: GqlCtx, scope: unknown, selections: readonly Selection[], variables: Readonly<Record<string, unknown>>, errors: string[]): Json | null {
  if (scope === null || scope === undefined) return null;
  const out: Json = {};
  for (const selection of selections) {
    if (selection.fragmentOn !== undefined && selection.selections.length > 0) {
      const inline = executeSelections(ctx, scope, selection.selections, variables, errors);
      if (inline) Object.assign(out, inline);
      continue;
    }
    const field = selection.name;
    if (field === '') continue;
    const alias = selection.alias || field;
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(selection.args)) args[key] = resolveVar(value, variables);
    const handler = fieldHandler(ctx, scope, field, args, selection, variables, errors);
    out[alias] = handler;
  }
  return out;
}

function fieldHandler(ctx: GqlCtx, scope: unknown, field: string, args: Readonly<Record<string, unknown>>, selection: Selection, variables: Readonly<Record<string, unknown>>, errors: string[]): unknown {
  const store = ctx.store;
  const sub = (value: unknown): unknown => {
    if (selection.selections.length === 0) return value === undefined ? null : value;
    if (Array.isArray(value)) return value.map((item) => executeSelections(ctx, item, selection.selections, variables, errors));
    return executeSelections(ctx, value, selection.selections, variables, errors);
  };
  const scalar = (value: unknown): unknown => (selection.selections.length === 0 ? (value === undefined ? null : value) : sub(value));

  // root fields
  if (scope === null || (typeof scope === 'object' && (scope as Json).__kind !== undefined && ['QueryRoot', 'MutationRoot'].includes(String((scope as Json).__kind)))) {
    const root = scope as Json | null;
    if (root !== null && root.__kind === 'QueryRoot') {
      if (field === 'viewer') return sub({ __kind: 'User', login: store.viewerLogin, id: globalId('user', store.viewer.id), name: store.viewer.name });
      if (field === '__typename') return 'Query';
      if (field === '__schema') return sub(schemaObject());
      if (field === '__type') return sub(typeObject(String(args.name ?? '')));
      if (field === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'repository') {
          const repo = [...store.repos.values()].find((candidate) => String(candidate.id) === decoded.value);
          return repo ? sub({ __kind: 'Repository', ...repositoryObject(ctx, repo) }) : null;
        }
        if (decoded.kind === 'issue') {
          for (const repo of store.repos.values()) {
            const issue = [...repo.issues.values()].find((candidate) => String(candidate.id) === decoded.value);
            if (issue) return sub({ __kind: 'Issue', ...issueObject(issue) });
          }
        }
        if (decoded.kind === 'pullRequest') {
          for (const repo of store.repos.values()) {
            const pull = [...repo.pulls.values()].find((candidate) => String(candidate.id) === decoded.value);
            if (pull) return sub({ __kind: 'PullRequest', ...pullObject(pull) });
          }
        }
        return null;
      }
      if (field === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo) return null;
        return sub({ __kind: 'Repository', ...repositoryObject(ctx, repo) });
      }
      errors.push(`Field '${field}' does not exist on type 'Query'.`);
      return null;
    }
    if (root !== null && root.__kind === 'MutationRoot') {
      return mutationField(ctx, field, args, selection, variables, errors);
    }
    errors.push(`Field '${field}' is not valid on this type.`);
    return null;
  }

  const node = scope as Json;
  const kind = node.__kind as string;
  switch (kind) {
    case 'User':
      if (field === 'login') return scalar(node.login);
      if (field === 'name') return scalar(node.name);
      if (field === 'id') return scalar(node.id);
      if (field === '__typename') return 'User';
      break;
    case 'Repository': {
      const repo = store.getRepo(String(node.nameWithOwner).split('/')[0] ?? '', String(node.nameWithOwner).split('/')[1] ?? '');
      if (field === '__typename') return 'Repository';
      if (field === 'id') return scalar(node.id);
      if (field === 'databaseId') return scalar(node.databaseId);
      if (field === 'name') return scalar(node.name);
      if (field === 'nameWithOwner') return scalar(node.nameWithOwner);
      if (field === 'owner') return sub(node.owner);
      if (field === 'defaultBranchRef') return sub(node.defaultBranchRef ? { __kind: 'Ref', name: (node.defaultBranchRef as Json).name } : null);
      if (field === 'viewerPermission') return scalar(node.viewerPermission);
      if (field === 'hasIssuesEnabled') return scalar(node.hasIssuesEnabled);
      if (field === 'isPrivate') return scalar(node.isPrivate);
      if (field === 'description') return scalar(node.description);
      if (field === 'createdAt') return scalar(node.createdAt);
      if (field === 'url') return scalar(node.url);
      if (!repo) return null;
      if (field === 'issue') {
        const issue = store.getIssue(repo, Number(args.number ?? 0));
        return issue ? sub({ __kind: 'Issue', ...issueObject(issue) }) : null;
      }
      if (field === 'issues') {
        return sub(issueConnection(repo, args));
      }
      if (field === 'pullRequest') {
        const pull = store.getPull(repo, Number(args.number ?? 0));
        if (!pull) return null;
        return sub({ __kind: 'PullRequest', ...pullObject(pull), files: { nodes: pull.files.map((file) => ({ __kind: 'PullRequestChangedFile', path: file.filename })) } });
      }
      if (field === 'pullRequests') {
        const nodes = [...repo.pulls.values()].map((pull) => ({ __kind: 'PullRequest', ...pullObject(pull) }));
        return sub({ nodes });
      }
      if (field === 'defaultBranch') return scalar(repo.defaultBranch);
      break;
    }
    case 'Ref':
      if (field === 'name') return scalar(node.name);
      break;
    case 'Issue': {
      if (field === '__typename') return 'Issue';
      if (field === 'id') return scalar(node.id);
      if (field === 'number') return scalar(node.number);
      if (field === 'title') return scalar(node.title);
      if (field === 'body') return scalar(node.body);
      if (field === 'state') return scalar(node.state);
      if (field === 'createdAt') return scalar(node.createdAt);
      if (field === 'updatedAt') return scalar(node.updatedAt);
      if (field === 'closedAt') return scalar(node.closedAt);
      if (field === 'author') return sub(node.author);
      if (field === 'labels') return sub(node.labels);
      if (field === 'url') return scalar(node.url);
      if (field === 'repository') {
        // the issue's repository is not tracked on the node; resolve via a parent hint when present
        return sub(null);
      }
      break;
    }
    case 'PullRequest': {
      if (field === '__typename') return 'PullRequest';
      if (field === 'id') return scalar(node.id);
      if (field === 'number') return scalar(node.number);
      if (field === 'title') return scalar(node.title);
      if (field === 'body') return scalar(node.body);
      if (field === 'state') return scalar(node.state);
      if (field === 'merged') return scalar(node.merged);
      if (field === 'headRefName') return scalar(node.headRefName);
      if (field === 'baseRefName') return scalar(node.baseRefName);
      if (field === 'mergeable') return scalar(node.mergeable);
      if (field === 'createdAt') return scalar(node.createdAt);
      if (field === 'author') return sub(node.author);
      if (field === 'url') return scalar(node.url);
      if (field === 'files') return sub(node.files);
      break;
    }
    case 'PullRequestChangedFile':
      if (field === 'path') return scalar(node.path);
      break;
    case 'IssueConnection':
      if (field === 'nodes') return sub(node.nodes);
      if (field === 'pageInfo') return sub(node.pageInfo);
      if (field === 'totalCount') return scalar(node.totalCount);
      break;
    case 'PageInfo':
      if (field === 'hasNextPage') return scalar(node.hasNextPage);
      if (field === 'endCursor') return scalar(node.endCursor);
      break;
    case 'Labels':
      if (field === 'nodes') return sub(node.nodes);
      break;
    case 'Label':
      if (field === 'name') return scalar(node.name);
      if (field === 'color') return scalar(node.color);
      break;
    case 'PullRequestConnection':
      if (field === 'nodes') return sub(node.nodes);
      if (field === 'totalCount') return scalar(node.totalCount);
      break;
    case 'PullRequestFiles':
      if (field === 'nodes') return sub(node.nodes);
      break;
    case 'RepositoryOwner':
      if (field === 'login') return scalar(node.login);
      break;
    case 'Comment':
      if (field === '__typename') return 'Comment';
      if (field === 'id') return scalar(node.id);
      if (field === 'body') return scalar(node.body);
      break;
    case 'MutationPayload':
      if (field in node) {
        const value = (node as Json)[field];
        return sub(value === null ? null : (typeof value === 'object' && value !== null && !Array.isArray(value) ? { __kind: 'MutationPayload', ...value as Json } : value));
      }
      errors.push(`Field '${field}' does not exist on type 'MutationPayload'.`);
      return null;
    case '__Type':
      if (field === '__typename') return '__Type';
      if (field === 'name') return scalar(node.name);
      if (field === 'kind') return scalar(node.kind);
      if (field === 'fields') return sub(node.fields);
      if (field === 'enumValues') return sub(node.enumValues);
      if (field === 'inputFields') return sub(node.inputFields);
      break;
    case '__Field':
      if (field === 'name') return scalar(node.name);
      break;
    case '__EnumValue':
      if (field === 'name') return scalar(node.name);
      break;
    case '__Schema':
      if (field === 'queryType') return sub(node.queryType);
      if (field === 'mutationType') return sub(node.mutationType);
      if (field === 'types') return sub(node.types);
      break;
  }
  if (kind === undefined && typeof node === 'object' && node !== null) {
    // plain JSON passthrough
    if (field in node) return scalar((node as Json)[field]);
  }
  errors.push(`Field '${field}' does not exist on type '${kind === 'Repository' ? 'Repository' : kind}'.`);
  return null;
}

function issueConnection(repo: Repo, args: Readonly<Record<string, unknown>>): Json {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const field = String(orderBy?.field ?? 'CREATED_AT');
  const direction = String(orderBy?.direction ?? 'ASC');
  issues.sort((a, b) => {
    let compare = 0;
    if (field === 'CREATED_AT') compare = a.createdAt.localeCompare(b.createdAt) || a.number - b.number;
    else if (field === 'UPDATED_AT') compare = (a.closedAt ?? a.createdAt).localeCompare(b.closedAt ?? b.createdAt) || a.number - b.number;
    else compare = a.number - b.number;
    return direction === 'DESC' ? -compare : compare;
  });
  const first = typeof args.first === 'number' ? args.first : null;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = decodeGlobalId(args.after);
    if (decoded) start = issues.findIndex((issue) => String(issue.number) === decoded.value || String(issue.id) === decoded.value) + 1;
  }
  const page = first === null ? issues.slice(start) : issues.slice(start, start + first);
  const hasNextPage = first !== null && start + first < issues.length;
  const endCursor = page.length > 0 ? globalId('issue-cursor', page[page.length - 1]!.number) : null;
  return {
    __kind: 'IssueConnection',
    nodes: page.map((issue) => ({ __kind: 'Issue', ...issueObject(issue) })),
    totalCount: issues.length,
    pageInfo: { __kind: 'PageInfo', hasNextPage, endCursor },
  };
}

function mutationField(ctx: GqlCtx, field: string, args: Readonly<Record<string, unknown>>, selection: Selection, variables: Readonly<Record<string, unknown>>, errors: string[]): unknown {
  const store = ctx.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repoById = (repositoryId: unknown): Repo | null => {
    const decoded = decodeGlobalId(String(repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'repository') return null;
    return [...store.repos.values()].find((candidate) => String(candidate.id) === decoded.value) ?? null;
  };
  const respond = (payload: Json | null): unknown => {
    if (selection.selections.length === 0) return payload;
    return executeSelections(ctx, payload === null ? null : { __kind: 'MutationPayload', ...payload }, selection.selections, variables, errors);
  };
  if (field === 'createIssue') {
    const repo = repoById(input.repositoryId);
    if (!repo) return respond(null);
    const result = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', [], store.viewerLogin);
    if ('error' in result) return respond(null);
    return respond({ issue: { __kind: 'Issue', ...issueObject(result.issue) } });
  }
  if (field === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'issue') return respond(null);
    for (const repo of store.repos.values()) {
      const issue = [...repo.issues.values()].find((candidate) => String(candidate.id) === decoded.value);
      if (issue) {
        issue.state = 'closed';
        issue.closedAt = issue.createdAt;
        return respond({ issue: { __kind: 'Issue', ...issueObject(issue) } });
      }
    }
    return respond(null);
  }
  if (field === 'createPullRequest') {
    const repo = repoById(input.repositoryId);
    if (!repo) return respond(null);
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const result = store.createPull(repo, { head, base, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' }, store.viewerLogin);
    if ('error' in result) return respond(null);
    return respond({ pullRequest: { __kind: 'PullRequest', ...pullObject(result.pull) } });
  }
  if (field === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'pullRequest') return respond(null);
    for (const repo of store.repos.values()) {
      const pull = [...repo.pulls.values()].find((candidate) => String(candidate.id) === decoded.value);
      if (pull) {
        const sha = store.mergePull(repo, pull);
        if (sha === null) return respond(null);
        return respond({ pullRequest: { __kind: 'PullRequest', ...pullObject(pull) } });
      }
    }
    return respond(null);
  }
  if (field === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'issue') return respond(null);
    const body = String(input.body ?? '');
    for (const repo of store.repos.values()) {
      const issue = [...repo.issues.values()].find((candidate) => String(candidate.id) === decoded.value);
      if (issue) {
        const comment = { id: ++repo.commentCounter, body, createdAt: issue.createdAt };
        issue.comments.push(comment);
        return respond({ commentEdge: { node: { __kind: 'Comment', id: globalId('issue-comment', comment.id), body } } });
      }
    }
    return respond(null);
  }
  errors.push(`Field '${field}' does not exist on type 'Mutation'.`);
  return null;
}

// ---------------------------------------------------------------- introspection

function typeObject(name: string): Json | null {
  const wrap = (typeName: string, fields: readonly string[]): Json => ({
    __kind: '__Type',
    name: typeName,
    kind: 'OBJECT',
    fields: fields.map((fieldName) => ({ __kind: '__Field', name: fieldName })),
    enumValues: null,
    inputFields: null,
  });
  const enumWrap = (typeName: string, values: readonly string[]): Json => ({
    __kind: '__Type',
    name: typeName,
    kind: 'ENUM',
    fields: null,
    enumValues: values.map((value) => ({ __kind: '__EnumValue', name: value })),
    inputFields: null,
  });
  switch (name) {
    case 'Issue': return wrap('Issue', ISSUE_FIELDS);
    case 'PullRequest': return wrap('PullRequest', PULL_REQUEST_FIELDS);
    case 'Repository': return wrap('Repository', REPOSITORY_FIELDS);
    case 'SearchType': return enumWrap('SearchType', SEARCH_TYPE_VALUES);
    case 'IssueState': return enumWrap('IssueState', ISSUE_STATE_VALUES);
    case 'PullRequestState': return enumWrap('PullRequestState', PULL_REQUEST_STATE_VALUES);
    case 'MergeableState': return enumWrap('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
    case 'PullRequestMergeMethod': return enumWrap('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']);
    case 'RepositoryPermission': return enumWrap('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']);
    case 'IssueOrderField': return enumWrap('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']);
    case 'OrderDirection': return enumWrap('OrderDirection', ['ASC', 'DESC']);
    case 'Query': return wrap('Query', ['viewer', 'repository', 'node', '__schema', '__type']);
    case 'Mutation': return wrap('Mutation', ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']);
    case 'User': return wrap('User', ['id', 'login', 'name']);
    case 'IssueConnection': return wrap('IssueConnection', ['nodes', 'pageInfo', 'totalCount']);
    case 'PageInfo': return wrap('PageInfo', ['hasNextPage', 'endCursor']);
    case 'PullRequestConnection': return wrap('PullRequestConnection', ['nodes', 'totalCount']);
    case 'PullRequestChangedFile': return wrap('PullRequestChangedFile', ['path']);
    case 'Ref': return wrap('Ref', ['name']);
    default: return null;
  }
}

function schemaObject(): Json {
  return {
    __kind: '__Schema',
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [typeObject('Issue'), typeObject('PullRequest'), typeObject('Repository'), typeObject('SearchType')].filter(Boolean),
  };
}

// ---------------------------------------------------------------- the endpoint

export async function handleGraphQL(ctx: GqlCtx): Promise<void> {
  const authed = ctx.token !== undefined && ctx.token !== '';
  const body = await ctx.readBody();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    ctx.respondJson(400, { message: 'Problems parsing JSON' });
    return;
  }
  if (!authed) {
    ctx.respondJson(401, { message: 'Requires authentication' });
    return;
  }
  const runOne = (operation: { query?: unknown; variables?: unknown }): Json => {
    const queryText = typeof operation.query === 'string' ? operation.query : '';
    const variables = (operation.variables ?? {}) as Record<string, unknown>;
    const errors: string[] = [];
    let data: Json | null = null;
    try {
      const operations = parseDocument(queryText);
      const op = operations[0];
      if (!op) {
        errors.push('the document holds no operation');
      } else {
        const root = { __kind: op.type === 'mutation' ? 'MutationRoot' : 'QueryRoot' };
        data = executeSelections(ctx, root, op.selections, variables, errors);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    return {
      data,
      ...(errors.length > 0 ? { errors: errors.map((message) => ({ message })) } : {}),
    };
  };
  if (Array.isArray(parsed)) {
    ctx.respondJson(200, parsed.map((operation) => runOne(operation as { query?: unknown; variables?: unknown })));
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    ctx.respondJson(400, { message: 'Problems parsing JSON' });
    return;
  }
  ctx.respondJson(200, runOne(parsed as { query?: unknown; variables?: unknown }));
}
