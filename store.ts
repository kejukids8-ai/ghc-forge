// store.ts: the in-memory forge store. Objects, refs, repositories, issues, pulls, labels, users.
// Deterministic: no clock in stored data beyond what the suite's fixtures demand (MAKEFUN_TRIAL_NOW
// style determinism is preserved because the suite supplies every timestamp).
import { hashObject, parseCommit, parseTree, buildTree, collectReachable, isObjectId, ZERO_OID } from './git-core.ts';
import type { GitObjectType, TreeEntry } from './git-core.ts';

export interface GitObject { type: GitObjectType; data: Buffer }

export interface Refs {
  /** ref name -> oid */
  refs: Map<string, string>;
}

export interface Label { name: string; color: string }

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  closedAt: string | null;
  comments: Array<{ id: number; body: string; createdAt: string }>;
  user: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  createdAt: string;
  user: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  privateFlag: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  issueCounter: number;
  commentCounter: number;
  pulls: Map<number, Pull>;
  pullCounter: number;
  createdAt: string;
}

const FIXED_DATE = '2026-01-01T00:00:00Z';
const FIXED_EPOCH = 1767225600;

export class Store {
  repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  nextRepoId = 50000;
  nextUserId = 20000;
  /** The login every bearer token maps to (the scenario viewer; one token per trial). */
  viewerLogin = 'adaiversen';
  viewer = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

  key(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  createRepo(owner: string, name: string, description = '', privateFlag = false): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      privateFlag,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueCounter: 0,
      commentCounter: 0,
      pulls: new Map(),
      pullCounter: 0,
      createdAt: FIXED_DATE,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, repo: string): Repo | null {
    const found = this.repos.get(this.key(owner, repo));
    return found ?? null;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Fast-forward guard: is `newOid` a descendant of `oldOid`? Unknown oldOid (unborn) is allowed. */
  isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    if (!isObjectId(oldOid) || !isObjectId(newOid)) return false;
    if (oldOid === newOid) return false;
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const reachable = collectReachable([newOid], lookup);
    return reachable.has(oldOid);
  }

  /** Squash-merge a pull request: build the merged tree from head commit onto the base branch. */
  mergePull(repo: Repo, pull: Pull): string | null {
    const headCommit = repo.objects.get(pull.headSha);
    if (!headCommit || headCommit.type !== 'commit') return null;
    const headParsed = parseCommit(headCommit.data);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
    const parent = baseTip ?? ZERO_OID;
    const message = `${pull.title} (#${pull.number})\n\nSquash-merge of ${pull.head} into ${pull.base}\n`;
    const commitData = Buffer.from(
      [
        `tree ${headParsed.tree}`,
        ...(parent === ZERO_OID ? [] : [`parent ${parent}`]),
        `author ${pull.user} <${this.viewer.email}> ${FIXED_EPOCH} +0000`,
        `committer ${pull.user} <${this.viewer.email}> ${FIXED_EPOCH} +0000`,
        ``,
        message,
      ].join('\n'),
      'utf8',
    );
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_DATE;
    pull.mergeCommitSha = sha;
    return sha;
  }

  /** Files changed between two commits (paths that differ). */
  changedFiles(repo: Repo, fromOid: string, toOid: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const flatten = (oid: string): Map<string, { oid: string; size: number }> => {
      const files = new Map<string, { oid: string; size: number }>();
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') return files;
      const walk = (treeOid: string, prefix: string): void => {
        const tree = repo.objects.get(treeOid);
        if (!tree || tree.type !== 'tree') return;
        for (const entry of parseTree(tree.data)) {
          const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          if (entry.mode === '40000') walk(entry.oid, path);
          else {
            const blob = repo.objects.get(entry.oid);
            files.set(path, { oid: entry.oid, size: blob ? blob.data.length : 0 });
          }
        }
      };
      walk(parseCommit(object.data).tree, '');
      return files;
    };
    const before = flatten(fromOid);
    const after = flatten(toOid);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const [path, entry] of after) {
      const previous = before.get(path);
      if (!previous) files.push({ filename: path, status: 'added', additions: Math.max(1, entry.size), deletions: 0, changes: Math.max(1, entry.size) });
      else if (previous.oid !== entry.oid) files.push({ filename: path, status: 'modified', additions: Math.max(1, entry.size), deletions: Math.max(1, previous.size), changes: Math.max(1, entry.size) + Math.max(1, previous.size) });
    }
    return files;
  }

  // ---------------------------------------------------------------- REST helpers

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[], user: string): { issue: Issue } | { error: string } {
    for (const label of labels) if (!repo.labels.has(label)) return { error: `Labels ${JSON.stringify(label)} do not exist` };
    const number = ++repo.issueCounter;
    const issue: Issue = {
      id: this.nextUserId++ * 7 + number,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: FIXED_DATE,
      closedAt: null,
      comments: [],
      user,
    };
    repo.issues.set(number, issue);
    return { issue };
  }

  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.get(number) ?? null;
  }

  createPull(repo: Repo, input: { head: string; base: string; title: string; body: string }, user: string): { pull: Pull } | { error: string; status: number } {
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    if (!headSha) return { error: `Head branch ${JSON.stringify(input.head)} does not exist`, status: 422 };
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (!baseSha) return { error: `Base branch ${JSON.stringify(input.base)} does not exist`, status: 422 };
    const number = ++repo.pullCounter;
    const pull: Pull = {
      id: this.nextUserId++ * 9 + number,
      number,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: input.head,
      base: input.base,
      headSha,
      baseSha,
      files: this.changedFiles(repo, baseSha, headSha),
      createdAt: FIXED_DATE,
      user,
    };
    repo.pulls.set(number, pull);
    return { pull };
  }

  getPull(repo: Repo, number: number): Pull | null {
    return repo.pulls.get(number) ?? null;
  }
}
