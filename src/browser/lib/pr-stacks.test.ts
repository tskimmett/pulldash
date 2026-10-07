import { test, expect } from "bun:test";
import {
  discoverStacks,
  orderStacked,
  prKey,
  stackRuns,
  stackSlot,
  toStackNode,
  type StackNode,
  type StackProbe,
  type StackSlot,
} from "./pr-stacks";

function node(
  number: number,
  baseRefName: string,
  headRefName: string,
  extra: Partial<StackNode> = {}
): StackNode {
  return {
    owner: "o",
    repo: "r",
    number,
    title: `PR ${number}`,
    state: "open",
    baseRefName,
    headRefName,
    isCrossRepository: false,
    nativeStack: null,
    ...extra,
  };
}

// Answers probes from a fixed set of open PRs, like the GraphQL lookups by
// headRefName (up) and baseRefName (down).
function probeFrom(all: StackNode[], calls: number[][] = []): StackProbe {
  return async (frontier) => {
    calls.push(frontier.map((n) => n.number));
    return frontier.flatMap((f) =>
      all.filter(
        (n) =>
          n !== f &&
          (n.headRefName === f.baseRefName ||
            (!f.isCrossRepository && n.baseRefName === f.headRefName))
      )
    );
  };
}

const members = (
  result: Awaited<ReturnType<typeof discoverStacks>>,
  number: number
) => result.placements.get(prKey("o", "r", number))?.members;

test("pr-stacks: walks a branch chain both ways from a middle PR", async () => {
  const all = [
    node(1, "main", "a"),
    node(2, "a", "b"),
    node(3, "b", "c"),
    node(9, "main", "unrelated"),
  ];
  const calls: number[][] = [];
  const result = await discoverStacks([all[1], all[3]], probeFrom(all, calls));

  expect(members(result, 2)).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
  expect(members(result, 3)).toBe(members(result, 1));
  expect(result.placements.has(prKey("o", "r", 9))).toBe(false);
  // Seeds, then their neighbours; already-seen PRs are not re-probed
  expect(calls).toEqual([
    [2, 9],
    [1, 3],
  ]);
});

test("pr-stacks: native stacks are taken as-is and never probed", async () => {
  const bottom = node(4, "main", "x");
  const top = node(5, "x", "y");
  const stack = { number: 7, members: [bottom, top] };
  const calls: number[][] = [];
  const result = await discoverStacks(
    [{ ...top, nativeStack: stack }],
    probeFrom([], calls)
  );

  expect(members(result, 4)).toEqual(["o/r#4", "o/r#5"]);
  expect(result.placements.get(prKey("o", "r", 4))?.id).toBe("o/r:stack:7");
  expect(calls).toEqual([]);
});

test("pr-stacks: ignores closed PRs and fork heads that share a branch name", async () => {
  const fork = node(1, "main", "feature", { isCrossRepository: true });
  const child = node(2, "feature", "next");
  const merged = node(3, "main", "old", { state: "merged" });
  const result = await discoverStacks(
    [fork, child, merged, node(4, "old", "new")],
    probeFrom([])
  );
  expect(result.placements.size).toBe(0);
});

test("pr-stacks: branching stacks list each branch after its parent", async () => {
  const all = [
    node(1, "main", "a"),
    node(3, "a", "c"),
    node(2, "a", "b"),
    node(4, "b", "d"),
  ];
  const result = await discoverStacks([all[0]], probeFrom(all));
  expect(members(result, 1)).toEqual(["o/r#1", "o/r#2", "o/r#4", "o/r#3"]);
});

type Row = { n: number; stack?: StackSlot };
const slot = (id: string, position: number, size: number): StackSlot => ({
  id,
  position,
  size,
});

test("pr-stacks: orderStacked groups stacks at their first listed member", () => {
  const items: Row[] = [
    { n: 10 },
    { n: 3, stack: slot("s", 3, 3) },
    { n: 11 },
    { n: 1, stack: slot("s", 1, 3) },
  ];
  const extra: Row[] = [{ n: 2, stack: slot("s", 2, 3) }];
  const ordered = orderStacked(items, extra);
  expect(ordered.map((r) => r.n)).toEqual([10, 1, 2, 3, 11]);

  expect(stackRuns(ordered).map((run) => run.items.map((r) => r.n))).toEqual([
    [10],
    [1, 2, 3],
    [11],
  ]);
});

test("pr-stacks: a lone stack member renders as a plain row", () => {
  const items: Row[] = [{ n: 1, stack: slot("s", 2, 3) }];
  expect(orderStacked(items)).toEqual(items);
  expect(stackRuns(items)).toEqual([{ stack: null, items: [items[0]] }]);
});

test("pr-stacks: stackSlot reports 1-based position from the base", () => {
  expect(stackSlot({ id: "s", members: ["a", "b"] }, "b")).toEqual(
    slot("s", 2, 2)
  );
  expect(stackSlot({ id: "s", members: ["a"] }, "z")).toBeUndefined();
});

test("pr-stacks: toStackNode orders native stack entries by position", () => {
  const pr = (number: number, state: "OPEN" | "MERGED" = "OPEN") => ({
    number,
    title: `PR ${number}`,
    state,
    isDraft: false,
    baseRefName: "main",
    headRefName: `b${number}`,
    isCrossRepository: false,
    repository: { name: "r", owner: { login: "o" } },
  });
  const result = toStackNode({
    ...pr(2),
    stack: {
      number: 5,
      entries: {
        nodes: [
          { position: 2, pullRequest: pr(2) },
          { position: 1, pullRequest: pr(1, "MERGED") },
        ],
      },
    },
  });
  expect(result.nativeStack?.number).toBe(5);
  expect(result.nativeStack?.members.map((m) => [m.number, m.state])).toEqual([
    [1, "merged"],
    [2, "open"],
  ]);
});
