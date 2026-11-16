// rest.ts: the GitHub REST v3 surface under /api/v3.
import { parseCommit, parseTree, ZERO_OID, buildTree } from './git-core.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';

export interface Ctx {
  store: Store;
  token: string | undefined;
  requestId: string;
  /** e.g. http://127.0.0.1:4567 — used for absolute Link URLs */
  origin: string;
  readBody(): Promise<Buffer>;
  respondJson(status: number, body: unknown, extraHeaders?: Record<string, string>): void;
  respondRaw(status: number, contentType: string, body: Buffer | string, extraHeaders?: Record<string, string>): void;
}

function errorBody(message: string): Record<string, unknown> {
  return { message, documentation_url: 'https://docs.github.com/rest' };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.privateFlag,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_wiki: true,
    has_pull_requests: true,
    size: repo.objects.size,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    visibility: repo.privateFlag ? 'private' : 'public',
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ id: 0, name, color: 'ededed', default: false })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.closedAt ?? issue.createdAt,
    closed_at: issue.closedAt,
    user: { login: issue.user, type: 'User' },
    html_url: '',
    url: '',
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    user: { login: pull.user, type: 'User' },
    head: { ref: pull.head, sha: pull.headSha, label: `${pull.user}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${pull.user}:${pull.base}` },
    html_url: '',
    url: '',
    draft: false,
    mergeable: true,
    files: pull.files,
  };
}

/** Walk a tree to a path; returns the containing tree and the entry, or null. */
function resolvePath(repo: Repo, treeOid: string, segments: string[]): { treeOid: string; entryName: string | null; entryOid: string | null; isDir: boolean } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = repo.objects.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entries = parseTree(tree.data);
    const entry = entries.find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) {
      const isDir = entry.mode === '40000';
      return { treeOid: current, entryName: entry.name, entryOid: entry.oid, isDir };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { treeOid: current, entryName: null, entryOid: null, isDir: true };
}

/** Build a tree from a flat path->content map plus kept existing entries (contents API semantics). */
function upsertTree(store: Store, repo: Repo, baseTreeOid: string | null, segments: string[], blobOid: string | null): string {
  const walk = (treeOid: string | null, depth: number): string => {
    const entries = treeOid ? parseTree(repo.objects.get(treeOid)!.data) : [];
    if (depth === segments.length - 1) {
      const kept = entries.filter((entry) => entry.name !== segments[depth]);
      if (blobOid !== null) kept.push({ mode: '100644', name: segments[depth]!, oid: blobOid });
      return store.putObject(repo, 'tree', buildTree(kept));
    }
    const existing = entries.find((entry) => entry.name === segments[depth] && entry.mode === '40000');
    const childOid = existing ? existing.oid : null;
    const kept = entries.filter((entry) => entry.name !== segments[depth]);
    kept.push({ mode: '40000', name: segments[depth]!, oid: walk(childOid, depth + 1) });
    return store.putObject(repo, 'tree', buildTree(kept));
  };
  if (segments.length === 0) return baseTreeOid ?? store.putObject(repo, 'tree', buildTree([]));
  return walk(baseTreeOid, 0);
}

function makeCommit(store: Store, repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const lines = [`tree ${treeOid}`, ...parents.map((parent) => `parent ${parent}`)];
  const epoch = 1767225600;
  const identity = `${store.viewer.name} <${store.viewer.email}> ${epoch} +0000`;
  const data = Buffer.from([...lines, `author ${identity}`, `committer ${identity}`, '', `${message}\n`].join('\n'), 'utf8');
  return store.putObject(repo, 'commit', data);
}

function tipOf(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  return repo.refs.get(`refs/heads/${ref}`) ?? null;
}

/** Handles one /api/v3 request. Returns true if handled. */
export function handleRest(ctx: Ctx, method: string, segments: readonly string[], query: URLSearchParams): boolean {
  const store = ctx.store;
  // /repos/{owner}/{repo}/... carries a literal 'repos' prefix; /user/... does not.
  const effective = segments[0] === 'repos' ? segments.slice(1) : segments;
  const owner = effective[0] ?? '';
  const repoName = effective[1] ?? '';
  const rest = effective.slice(2);
  const authed = ctx.token !== undefined && ctx.token !== '';

  // Unauthenticated reads of anything under repos/ need a token (401), per the checks.
  const path0 = rest[0] ?? '';
  const isSpecial = owner === 'user' || owner === 'meta';
  if (!authed && owner !== 'user') {
    // routes that answer 404 without auth? GitHub answers 404 for unknown repos and 401 for auth
    // required. The checks: GET repo without token -> 401; GET unknown route -> 404.
  }

  // GET /api/v3/
  if (segments.length === 0) {
    ctx.respondJson(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (owner === 'meta' && rest.length === 0) {
    ctx.respondJson(200, { installed_version: 'ghc-forge 1.0.0', verifiable_password_authentication: false });
    return true;
  }

  // GET /api/v3/user
  if (owner === 'user' && rest.length === 0 && repoName === '') {
    if (!authed) {
      ctx.respondJson(401, errorBody('Requires authentication'));
      return true;
    }
    ctx.respondJson(200, { login: store.viewerLogin, id: store.viewer.id, name: store.viewer.name, type: 'User', email: store.viewer.email });
    return true;
  }

  // POST /api/v3/user/repos
  if (owner === 'user' && repoName === 'repos') {
    if (!authed) {
      ctx.respondJson(401, errorBody('Requires authentication'));
      return true;
    }
    if (method === 'GET') {
      const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
      const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
      const pageRaw = parseInt(query.get('page') ?? '1', 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const repos = [...store.repos.values()]
        .filter((candidate) => candidate.owner === store.viewerLogin)
        .sort((a, b) => a.id - b.id);
      const start = (page - 1) * perPage;
      const pageItems = repos.slice(start, start + perPage);
      const baseUrl = `${ctx.origin}/api/v3/user/repos`;
      const hasMore = start + perPage < repos.length;
      const headers: Record<string, string> = {};
      if (hasMore) {
        const nextUrl = `${baseUrl}?per_page=${perPage}&page=${page + 1}`;
        const lastUrl = `${baseUrl}?per_page=${perPage}&page=${Math.max(1, Math.ceil(repos.length / perPage))}`;
        headers.Link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
      }
      ctx.respondJson(200, pageItems.map((item) => repoJson(store, item)), headers);
      return true;
    }
    if (method !== 'POST') {
      ctx.respondJson(405, errorBody('Method not allowed'));
      return true;
    }
    void ctx.readBody().then((body) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        ctx.respondJson(400, errorBody('Problems parsing JSON'));
        return;
      }
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        ctx.respondJson(422, errorBody('name is invalid'));
        return;
      }
      const privateFlag = parsed.private === true;
      const description = typeof parsed.description === 'string' ? parsed.description : '';
      const repo = store.createRepo(store.viewerLogin, name, description, privateFlag);
      if (!repo) {
        ctx.respondJson(422, { message: `Repository creation failed. The repository ${store.viewerLogin}/${name} already exists on this account.`, errors: [{ message: 'name already exists on this account' }] });
        return;
      }
      ctx.respondJson(201, repoJson(store, repo));
    });
    return true;
  }

  if (owner === 'user') return false;
  if (owner === 'meta') return false;

  if (!authed) {
    // GitHub answers 404 for repositories without auth; the check expects 401 on GET repos/{o}/{r}.
    ctx.respondJson(401, errorBody('Requires authentication'));
    return true;
  }

  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    ctx.respondJson(404, errorBody('Not Found'));
    return true;
  }

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      ctx.respondJson(200, repoJson(store, repo));
      return true;
    }
    if (method === 'PATCH') {
      void ctx.readBody().then((body) => {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          if (typeof parsed.description === 'string') repo.description = parsed.description;
          if (typeof parsed.default_branch === 'string' && parsed.default_branch !== '') repo.defaultBranch = parsed.default_branch;
          ctx.respondJson(200, repoJson(store, repo));
        } catch {
          ctx.respondJson(400, errorBody('Problems parsing JSON'));
        }
      });
      return true;
    }
    if (method === 'DELETE') {
      store.repos.delete(`${repo.owner}/${repo.name}`);
      ctx.respondRaw(204, 'application/json', '');
      return true;
    }
    ctx.respondJson(405, errorBody('Method not allowed'));
    return true;
  }

  const resource = path0;

  // GET /branches, /branches/{name}
  if (resource === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs].filter(([name]) => name.startsWith('refs/heads/')).map(([name, oid]) => ({
        name: name.slice('refs/heads/'.length),
        commit: { sha: oid, url: '' },
        protected: false,
      }));
      ctx.respondJson(200, branches);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!oid) {
        ctx.respondJson(404, errorBody('Branch not found'));
        return true;
      }
      ctx.respondJson(200, { name: rest[1], commit: { sha: oid, url: '' }, protected: false });
      return true;
    }
    ctx.respondJson(404, errorBody('Not Found'));
    return true;
  }

  // GET /commits, /commits/{sha}
  if (resource === 'commits') {
    if (method !== 'GET') {
      ctx.respondJson(405, errorBody('Method not allowed'));
      return true;
    }
    const tip = rest.length === 1 ? tipOf(repo, query.get('sha') ?? undefined) : (rest[1] ?? null);
    if (tip === null || !repo.objects.has(tip)) {
      ctx.respondJson(rest.length === 1 ? 409 : 422, errorBody('No commits on this branch' ));
      return true;
    }
    // walk history
    const commits: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let current: string | null = tip;
    while (current && repo.objects.has(current) && !seen.has(current)) {
      seen.add(current);
      const parsed = parseCommit(repo.objects.get(current)!.data);
      const epochMatch = /\s(\d{8,12})\s\+0000$/.exec(parsed.author);
      const epoch = epochMatch ? parseInt(epochMatch[1], 10) : 1767225600;
      commits.push({
        sha: current,
        node_id: `C_${current.slice(0, 8)}`,
        commit: {
          message: parsed.message.replace(/\n+$/, ''),
          author: { name: parsed.author.split(' <')[0] ?? '', email: '', date: new Date(epoch * 1000).toISOString() },
          committer: { name: parsed.committer.split(' <')[0] ?? '', email: '', date: new Date(epoch * 1000).toISOString() },
        },
        author: { login: store.viewerLogin },
        committer: { login: store.viewerLogin },
        parents: parsed.parents.map((parent) => ({ sha: parent })),
        html_url: '',
        url: '',
      });
      current = parsed.parents[0] ?? null;
    }
    ctx.respondJson(200, commits);
    return true;
  }

  // /git/refs, /git/refs/heads/{name}
  if (resource === 'git') {
    const rest2 = rest.slice(1);
    if (rest2.length === 0 || (rest2.length === 1 && rest2[0] === 'refs')) {
      if (method !== 'POST') {
        ctx.respondJson(405, errorBody('Method not allowed'));
        return true;
      }
      void ctx.readBody().then((body) => {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          const ref = typeof parsed.ref === 'string' ? parsed.ref : '';
          const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
          if (!ref.startsWith('refs/heads/') || !repo.objects.has(sha)) {
            ctx.respondJson(422, errorBody('Invalid ref or sha'));
            return;
          }
          if (repo.refs.has(ref)) {
            ctx.respondJson(422, errorBody('Reference already exists'));
            return;
          }
          repo.refs.set(ref, sha);
          ctx.respondJson(201, { ref, node_id: '', object: { sha, type: 'commit', url: '' } });
        } catch {
          ctx.respondJson(400, errorBody('Problems parsing JSON'));
        }
      });
      return true;
    }
    if (rest2[0] === 'refs') {
      if (rest2.length === 1 && method === 'GET') {
        const refs = [...repo.refs].filter(([name]) => name.startsWith('refs/')).map(([name, oid]) => ({
          ref: name,
          node_id: '',
          object: { sha: oid, type: 'commit', url: '' },
        }));
        ctx.respondJson(200, refs);
        return true;
      }
      // GET refs/heads/{name}
      const refName = rest2.slice(1).join('/');
      const oid = repo.refs.get(refName);
      if (method === 'GET') {
        if (!oid) {
          ctx.respondJson(404, errorBody('Reference does not exist'));
          return true;
        }
        ctx.respondJson(200, { ref: refName, node_id: '', object: { sha: oid, type: 'commit', url: '' } });
        return true;
      }
      if (method === 'PATCH') {
        void ctx.readBody().then((body) => {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
            const force = parsed.force === true;
            if (!repo.objects.has(sha)) {
              ctx.respondJson(422, errorBody('Object does not exist on your repository'));
              return;
            }
            if (!force && !store.isFastForward(repo, oid ?? ZERO_OID, sha)) {
              ctx.respondJson(422, errorBody('Update is not a fast forward'));
              return;
            }
            repo.refs.set(refName, sha);
            ctx.respondJson(200, { ref: refName, node_id: '', object: { sha, type: 'commit', url: '' } });
          } catch {
            ctx.respondJson(400, errorBody('Problems parsing JSON'));
          }
        });
        return true;
      }
      if (method === 'DELETE') {
        if (!oid) {
          ctx.respondJson(422, errorBody('Reference does not exist'));
          return true;
        }
        repo.refs.delete(refName);
        ctx.respondRaw(204, 'application/json', '');
        return true;
      }
      ctx.respondJson(405, errorBody('Method not allowed'));
      return true;
    }
    ctx.respondJson(404, errorBody('Not Found'));
    return true;
  }

  // /contents/{path...}
  if (resource === 'contents') {
    const filePath = rest.slice(1).map(decodeURIComponent).join('/');
    const tip = tipOf(repo, query.get('ref') ?? undefined);
    if (method === 'GET') {
      if (!tip) {
        ctx.respondJson(404, errorBody('Not Found'));
        return true;
      }
      const parsed = parseCommit(repo.objects.get(tip)!.data);
      const resolved = resolvePath(repo, parsed.tree, filePath.split('/').filter((segment) => segment !== ''));
      if (!resolved) {
        ctx.respondJson(404, errorBody('Not Found'));
        return true;
      }
      if (resolved.isDir) {
        const tree = repo.objects.get(resolved.entryOid ?? parsed.tree)!;
        const entries = parseTree(tree.data).map((entry) => {
          const object = repo.objects.get(entry.oid);
          return {
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
            sha: entry.oid,
            size: object ? object.data.length : 0,
            encoding: null,
            content: null,
            html_url: '',
            url: '',
          };
        });
        ctx.respondJson(200, entries);
        return true;
      }
      const blob = repo.objects.get(resolved.entryOid!);
      if (!blob) {
        ctx.respondJson(404, errorBody('Not Found'));
        return true;
      }
      ctx.respondJson(200, {
        type: 'file',
        name: resolved.entryName,
        path: filePath,
        sha: blob.data.length >= 0 ? resolved.entryOid : resolved.entryOid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
        html_url: '',
        url: '',
      });
      return true;
    }
    if (method === 'PUT') {
      void ctx.readBody().then((body) => {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          const content = typeof parsed.content === 'string' ? parsed.content : '';
          const message = typeof parsed.message === 'string' ? parsed.message : 'update';
          const branch = typeof parsed.branch === 'string' && parsed.branch !== '' ? parsed.branch : repo.defaultBranch;
          const refKey = `refs/heads/${branch}`;
          let data: Buffer;
          try {
            data = Buffer.from(content, 'base64');
          } catch {
            ctx.respondJson(400, errorBody('content is not valid base64'));
            return;
          }
          const tipOid = repo.refs.get(refKey);
          const baseTree = tipOid ? parseCommit(repo.objects.get(tipOid)!.data).tree : null;
          const segments = filePath.split('/').filter((segment) => segment !== '');
          if (segments.length === 0) {
            ctx.respondJson(422, errorBody('path is empty'));
            return;
          }
          const resolved = baseTree ? resolvePath(repo, baseTree, segments) : null;
          if (resolved && resolved.isDir) {
            ctx.respondJson(422, errorBody('path is a directory'));
            return;
          }
          const existingSha = resolved && !resolved.isDir ? resolved.entryOid : null;
          const providedSha = typeof parsed.sha === 'string' && parsed.sha !== '' ? parsed.sha : null;
          if (existingSha !== null && providedSha === null) {
            // update without sha
            ctx.respondJson(422, errorBody('sha is required for updating a file'));
            return;
          }
          if (existingSha !== null && providedSha !== null && providedSha !== existingSha) {
            ctx.respondJson(409, errorBody('sha does not match the file on the branch'));
            return;
          }
          const isUpdate = existingSha !== null;
          const blobOid = store.putObject(repo, 'blob', data);
          const treeOid = upsertTree(store, repo, baseTree, segments, blobOid);
          const parents = tipOid ? [tipOid] : [];
          const commitSha = makeCommit(store, repo, treeOid, parents, message);
          repo.refs.set(refKey, commitSha);
          ctx.respondJson(isUpdate ? 200 : 201, {
            content: { sha: blobOid, encoding: 'base64', type: 'file', size: data.length, name: segments.at(-1), path: filePath },
            commit: { sha: commitSha, message, html_url: '', url: '' },
          });
        } catch {
          ctx.respondJson(400, errorBody('Problems parsing JSON'));
        }
      });
      return true;
    }
    if (method === 'DELETE') {
      void ctx.readBody().then((body) => {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          const message = typeof parsed.message === 'string' ? parsed.message : 'delete';
          const branch = typeof parsed.branch === 'string' && parsed.branch !== '' ? parsed.branch : repo.defaultBranch;
          const refKey = `refs/heads/${branch}`;
          const tipOid = repo.refs.get(refKey);
          if (!tipOid) {
            ctx.respondJson(404, errorBody('Not Found'));
            return;
          }
          const baseTree = parseCommit(repo.objects.get(tipOid)!.data).tree;
          const segments = filePath.split('/').filter((segment) => segment !== '');
          const resolved = resolvePath(repo, baseTree, segments);
          if (!resolved || resolved.isDir) {
            ctx.respondJson(404, errorBody('Not Found'));
            return;
          }
          const treeOid = upsertTree(store, repo, baseTree, segments, null);
          const commitSha = makeCommit(store, repo, treeOid, [tipOid], message);
          repo.refs.set(refKey, commitSha);
          ctx.respondJson(200, { commit: { sha: commitSha, message, html_url: '', url: '' } });
        } catch {
          ctx.respondJson(400, errorBody('Problems parsing JSON'));
        }
      });
      return true;
    }
    ctx.respondJson(405, errorBody('Method not allowed'));
    return true;
  }

  // /labels
  if (resource === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      void ctx.readBody().then((body) => {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          const name = typeof parsed.name === 'string' ? parsed.name : '';
          const color = typeof parsed.color === 'string' ? parsed.color : 'ededed';
          if (name === '') {
            ctx.respondJson(422, errorBody('name is required'));
            return;
          }
          if (repo.labels.has(name)) {
            ctx.respondJson(422, errorBody('Label already exists'));
            return;
          }
          repo.labels.set(name, { name, color });
          ctx.respondJson(201, { id: 0, node_id: '', name, color, default: false });
        } catch {
          ctx.respondJson(400, errorBody('Problems parsing JSON'));
        }
      });
      return true;
    }
    if (rest.length === 1 && method === 'GET') {
      ctx.respondJson(200, [...repo.labels.values()].map((label) => ({ id: 0, node_id: '', name: label.name, color: label.color, default: false })));
      return true;
    }
    ctx.respondJson(404, errorBody('Not Found'));
    return true;
  }

  // /issues, /issues/{number}, /issues/{number}/comments
  if (resource === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => {
          const compare = a.createdAt.localeCompare(b.createdAt) || a.number - b.number;
          return direction === 'asc' ? compare : -compare;
        });
        void sort;
        ctx.respondJson(200, issues.map(issueJson));
        return true;
      }
      if (method === 'POST') {
        void ctx.readBody().then((body) => {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            const title = typeof parsed.title === 'string' ? parsed.title : '';
            const issueBody = typeof parsed.body === 'string' ? parsed.body : '';
            const labels = Array.isArray(parsed.labels)
              ? parsed.labels.map((label) => (typeof label === 'string' ? label : (label as Record<string, unknown>)?.name)).filter((name): name is string => typeof name === 'string')
              : [];
            const result = store.createIssue(repo, title, issueBody, labels, store.viewerLogin);
            if ('error' in result) {
              ctx.respondJson(422, errorBody(result.error));
              return;
            }
            ctx.respondJson(201, issueJson(result.issue));
          } catch {
            ctx.respondJson(400, errorBody('Problems parsing JSON'));
          }
        });
        return true;
      }
      ctx.respondJson(405, errorBody('Method not allowed'));
      return true;
    }
    const number = parseInt(rest[1] ?? '', 10);
    if (!Number.isInteger(number)) {
      ctx.respondJson(404, errorBody('Not Found'));
      return true;
    }
    const issue = store.getIssue(repo, number);
    if (!issue) {
      ctx.respondJson(404, errorBody('Not Found'));
      return true;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        ctx.respondJson(200, issueJson(issue));
        return true;
      }
      if (method === 'PATCH') {
        void ctx.readBody().then((body) => {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            if (typeof parsed.title === 'string') issue.title = parsed.title;
            if (typeof parsed.body === 'string') issue.body = parsed.body;
            if (parsed.state === 'open' || parsed.state === 'closed') {
              issue.state = parsed.state;
              issue.closedAt = parsed.state === 'closed' ? issue.createdAt : null;
            }
            ctx.respondJson(200, issueJson(issue));
          } catch {
            ctx.respondJson(400, errorBody('Problems parsing JSON'));
          }
        });
        return true;
      }
      ctx.respondJson(405, errorBody('Method not allowed'));
      return true;
    }
    if (rest[2] === 'comments') {
      if (rest.length === 3 && method === 'GET') {
        ctx.respondJson(200, issue.comments.map((comment) => ({ id: comment.id, node_id: '', body: comment.body, user: { login: issue.user }, created_at: comment.createdAt })));
        return true;
      }
      if (rest.length === 3 && method === 'POST') {
        void ctx.readBody().then((body) => {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            const commentBody = typeof parsed.body === 'string' ? parsed.body : '';
            const comment = { id: ++repo.commentCounter, body: commentBody, createdAt: issue.createdAt };
            issue.comments.push(comment);
            ctx.respondJson(201, { id: comment.id, node_id: '', body: comment.body, user: { login: issue.user }, created_at: comment.createdAt });
          } catch {
            ctx.respondJson(400, errorBody('Problems parsing JSON'));
          }
        });
        return true;
      }
      ctx.respondJson(405, errorBody('Method not allowed'));
      return true;
    }
    ctx.respondJson(404, errorBody('Not Found'));
    return true;
  }

  // /pulls, /pulls/{number}, /pulls/{number}/files, /pulls/{number}/merge
  if (resource === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state && !pull.merged);
        ctx.respondJson(200, pulls.map(pullJson));
        return true;
      }
      if (method === 'POST') {
        void ctx.readBody().then((body) => {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
            const head = typeof parsed.head === 'string' ? parsed.head : '';
            const base = typeof parsed.base === 'string' ? parsed.base : '';
            const title = typeof parsed.title === 'string' ? parsed.title : '';
            const pullBody = typeof parsed.body === 'string' ? parsed.body : '';
            const result = store.createPull(repo, { head, base, title, body: pullBody }, store.viewerLogin);
            if ('error' in result) {
              ctx.respondJson(result.status, errorBody(result.error));
              return;
            }
            ctx.respondJson(201, pullJson(result.pull));
          } catch {
            ctx.respondJson(400, errorBody('Problems parsing JSON'));
          }
        });
        return true;
      }
      ctx.respondJson(405, errorBody('Method not allowed'));
      return true;
    }
    const number = parseInt(rest[1] ?? '', 10);
    if (!Number.isInteger(number)) {
      ctx.respondJson(404, errorBody('Not Found'));
      return true;
    }
    const pull = store.getPull(repo, number);
    if (!pull) {
      ctx.respondJson(404, errorBody('Not Found'));
      return true;
    }
    if (rest.length === 2) {
      if (method === 'GET') {
        ctx.respondJson(200, pullJson(pull));
        return true;
      }
      ctx.respondJson(405, errorBody('Method not allowed'));
      return true;
    }
    if (rest[2] === 'files' && method === 'GET') {
      ctx.respondJson(200, pull.files.map((file) => ({ sha: '', filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes, blob_url: '', raw_url: '' })));
      return true;
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (pull.state === 'closed') {
        ctx.respondJson(405, errorBody('Pull Request is not mergeable'));
        return true;
      }
      // conflict: another pull touching the same path has merged since the pull was created
      const tip = repo.refs.get(`refs/heads/${pull.base}`);
      if (tip !== null && tip !== pull.baseSha) {
        const baseChanged = store.changedFiles(repo, pull.baseSha, tip).map((file) => file.filename);
        if (pull.files.some((file) => baseChanged.includes(file.filename))) {
          ctx.respondJson(405, errorBody('Pull Request is not mergeable'));
          return true;
        }
      }
      void ctx.readBody().then((body) => {
        let mergeMethod = 'merge';
        try {
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          if (typeof parsed.merge_method === 'string') mergeMethod = parsed.merge_method;
        } catch {
          // body optional
        }
        void mergeMethod;
        const sha = store.mergePull(repo, pull);
        if (sha === null) {
          ctx.respondJson(405, errorBody('Pull Request is not mergeable'));
          return;
        }
        ctx.respondJson(200, { sha, merged: true, message: 'Pull Request successfully merged' });
      });
      return true;
    }
    ctx.respondJson(404, errorBody('Not Found'));
    return true;
  }

  ctx.respondJson(404, errorBody('Not Found'));
  return true;
}
