import { expect, test } from "bun:test";
import { Octokit } from "@octokit/core";
import { addConditionalRequests } from "./conditional-requests";
import { MemoryPersistentStore } from "./persistent-cache";

test("replays the stored body when GitHub answers 304", async () => {
  const sent: Array<string | null> = [];
  const cacheModes: Array<RequestCache | undefined> = [];
  const fetch = async (_url: string, init: RequestInit) => {
    const ifNoneMatch = new Headers(init.headers).get("if-none-match");
    sent.push(ifNoneMatch);
    cacheModes.push(init.cache);
    if (ifNoneMatch === '"v1"') return new Response(null, { status: 304 });
    return Response.json({ title: "cached" }, { headers: { etag: '"v1"' } });
  };
  const octokit = new Octokit({ request: { fetch } });
  addConditionalRequests(octokit, new MemoryPersistentStore());

  const route = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
  const params = { owner: "o", repo: "r", pull_number: 1 };
  const first = await octokit.request(route, params);
  const second = await octokit.request(route, params);

  expect(sent).toEqual([null, '"v1"']);
  // The browser's HTTP cache must never answer for GitHub
  expect(cacheModes).toEqual(["no-store", "no-store"]);
  expect(second.status).toBe(200);
  expect(second.data).toEqual(first.data);
});
