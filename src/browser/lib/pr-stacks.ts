// Stacked PR detection. GitHub-native stacks come straight from the
// PullRequest.stack field; anything else (Graphite, spr, hand-chained
// branches) is inferred from open PRs whose base branch is another open PR's
// head branch in the same repo.

export type StackPRState = "open" | "draft" | "merged" | "closed";

export interface StackNode {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: StackPRState;
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  /** GitHub-native stack, members ordered from the base branch up. */
  nativeStack: { number: number; members: StackNode[] } | null;
}

export interface StackPlacement {
  id: string;
  /** Member PR keys ordered from the base branch up. */
  members: string[];
}

/** One PR's slot in a stack, as stored on list rows. */
export interface StackSlot {
  id: string;
  /** 1 is closest to the base branch. */
  position: number;
  size: number;
}

export interface StackDiscovery {
  nodes: Map<string, StackNode>;
  /** Keyed by member PR key; members of one stack share a placement. */
  placements: Map<string, StackPlacement>;
}

/** Looks up open PRs stacked directly above or below each frontier PR. */
export type StackProbe = (frontier: StackNode[]) => Promise<StackNode[]>;

/** More open PRs than this on one branch makes it an integration branch. */
export const MAX_STACK_CHILDREN = 4;
const MAX_ROUNDS = 8;
const MAX_NODES = 200;

export function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`.toLowerCase();
}

function nodeKey(node: StackNode): string {
  return prKey(node.owner, node.repo, node.number);
}

function repoKey(node: StackNode): string {
  return `${node.owner}/${node.repo}`.toLowerCase();
}

const isOpen = (node: StackNode) =>
  node.state === "open" || node.state === "draft";

export async function discoverStacks(
  seeds: StackNode[],
  probe: StackProbe
): Promise<StackDiscovery> {
  const nodes = new Map<string, StackNode>();
  const placements = new Map<string, StackPlacement>();

  // Returns true when the node still needs heuristic exploration
  const add = (node: StackNode): boolean => {
    const key = nodeKey(node);
    if (nodes.has(key) || placements.has(key)) return false;
    nodes.set(key, node);
    if (node.nativeStack) {
      const members = [...node.nativeStack.members];
      const placement: StackPlacement = {
        id: `${repoKey(node)}:stack:${node.nativeStack.number}`,
        members: members.map(nodeKey),
      };
      for (const member of members) {
        const memberKey = nodeKey(member);
        if (!nodes.has(memberKey)) nodes.set(memberKey, member);
        placements.set(memberKey, placement);
      }
      return false;
    }
    return isOpen(node);
  };

  let frontier = seeds.filter(add);
  for (let round = 0; round < MAX_ROUNDS && frontier.length > 0; round++) {
    const found = await probe(frontier);
    frontier = nodes.size < MAX_NODES ? found.filter(add) : [];
  }

  // Chain the remaining open PRs: a PR whose base is another same-repo PR's
  // head sits on top of it.
  const chained = [...nodes.values()].filter(
    (n) => isOpen(n) && !placements.has(nodeKey(n))
  );
  const byHead = new Map<string, StackNode>();
  for (const node of chained) {
    if (node.isCrossRepository) continue;
    byHead.set(`${repoKey(node)}:${node.headRefName}`, node);
  }
  const children = new Map<StackNode, StackNode[]>();
  for (const node of chained) {
    const parent = byHead.get(`${repoKey(node)}:${node.baseRefName}`);
    if (!parent || parent === node) continue;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }
  for (const [parent, kids] of children) {
    if (kids.length > MAX_STACK_CHILDREN) children.delete(parent);
  }
  const parentOf = new Map<StackNode, StackNode>();
  for (const [parent, kids] of children) {
    for (const kid of kids) parentOf.set(kid, parent);
  }

  const visited = new Set<StackNode>();
  const walk = (node: StackNode, out: StackNode[]) => {
    if (visited.has(node)) return;
    visited.add(node);
    out.push(node);
    const kids = children.get(node) ?? [];
    kids.sort((a, b) => a.number - b.number);
    for (const kid of kids) walk(kid, out);
  };
  for (const node of chained) {
    if (parentOf.has(node) || visited.has(node)) continue;
    const members: StackNode[] = [];
    walk(node, members);
    if (members.length < 2) continue;
    const placement: StackPlacement = {
      id: `${repoKey(node)}:chain:${node.headRefName}`,
      members: members.map(nodeKey),
    };
    for (const member of members) placements.set(nodeKey(member), placement);
  }

  return { nodes, placements };
}

export interface PRStack {
  /** 1 is closest to the base branch. */
  position: number;
  members: StackNode[];
}

export function stackFromDiscovery(
  { nodes, placements }: StackDiscovery,
  key: string
): PRStack | null {
  const placement = placements.get(key);
  if (!placement) return null;
  return {
    position: placement.members.indexOf(key) + 1,
    members: placement.members.flatMap((k) => nodes.get(k) ?? []),
  };
}

export function stackSlot(
  placement: StackPlacement,
  key: string
): StackSlot | undefined {
  const index = placement.members.indexOf(key);
  if (index < 0) return undefined;
  return {
    id: placement.id,
    position: index + 1,
    size: placement.members.length,
  };
}

/**
 * Keep the list's order, but pull every stack together at the slot of its
 * first-listed member, ordered from the base branch up. `extra` holds stack
 * members that only appear because a stack-mate is listed.
 */
export function orderStacked<T extends { stack?: StackSlot }>(
  items: T[],
  extra: T[] = []
): T[] {
  const byStack = new Map<string, T[]>();
  for (const item of [...items, ...extra]) {
    if (!item.stack) continue;
    const group = byStack.get(item.stack.id) ?? [];
    group.push(item);
    byStack.set(item.stack.id, group);
  }

  const ordered: T[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    const group = item.stack && byStack.get(item.stack.id);
    if (!item.stack || !group || group.length < 2) {
      ordered.push(item);
      continue;
    }
    if (emitted.has(item.stack.id)) continue;
    emitted.add(item.stack.id);
    ordered.push(
      ...group.sort((a, b) => a.stack!.position - b.stack!.position)
    );
  }
  return ordered;
}

export type StackRun<T> =
  | { stack: null; items: [T] }
  | { stack: StackSlot; items: T[] };

/** Split an ordered list into single rows and runs of one stack. */
export function stackRuns<T extends { stack?: StackSlot }>(
  items: T[]
): StackRun<T>[] {
  const runs: StackRun<T>[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (item.stack && last?.stack?.id === item.stack.id) {
      last.items.push(item);
    } else if (item.stack) {
      runs.push({ stack: item.stack, items: [item] });
    } else {
      runs.push({ stack: null, items: [item] });
    }
  }
  // A lone stack member (stack-mates filtered out elsewhere) renders plainly
  return runs.map((run) =>
    run.stack && run.items.length < 2
      ? { stack: null, items: [run.items[0]] }
      : run
  );
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

const STACK_PR_FIELDS = `
  number
  title
  state
  isDraft
  baseRefName
  headRefName
  isCrossRepository
  repository { name owner { login } }`;

/** Selection on a PullRequest that `toStackNode` parses. */
export const STACK_NODE_FIELDS = `
  ${STACK_PR_FIELDS}
  stack {
    number
    entries(first: 50) {
      nodes { position pullRequest { ${STACK_PR_FIELDS} } }
    }
  }`;

interface GqlStackPR {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
  repository: { name: string; owner: { login: string } };
}

export interface GqlStackNode extends GqlStackPR {
  stack: {
    number: number;
    entries: {
      nodes: Array<{ position: number; pullRequest: GqlStackPR | null }>;
    };
  } | null;
}

function toPlainNode(pr: GqlStackPR): StackNode {
  return {
    owner: pr.repository.owner.login,
    repo: pr.repository.name,
    number: pr.number,
    title: pr.title,
    state:
      pr.state === "MERGED"
        ? "merged"
        : pr.state === "CLOSED"
          ? "closed"
          : pr.isDraft
            ? "draft"
            : "open",
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    isCrossRepository: pr.isCrossRepository,
    nativeStack: null,
  };
}

export function toStackNode(pr: GqlStackNode): StackNode {
  const node = toPlainNode(pr);
  const entries = pr.stack?.entries.nodes ?? [];
  if (!pr.stack || entries.length < 2) return node;
  const members = [...entries]
    .sort((a, b) => a.position - b.position)
    .flatMap((e) => (e.pullRequest ? [toPlainNode(e.pullRequest)] : []));
  return { ...node, nativeStack: { number: pr.stack.number, members } };
}
