import { test, expect } from "bun:test";
import api from "./api";

function providers(headers: Record<string, string>, init: RequestInit = {}) {
  return api.request("http://localhost:3002/api/semantic/providers", {
    ...init,
    headers,
  });
}

test("api: allows same-origin requests from loopback hosts", async () => {
  for (const host of ["localhost:3002", "127.0.0.1:3002", "[::1]:3002"]) {
    const res = await providers({ host, "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
  }
  const res = await providers({
    host: "localhost:3002",
    origin: "http://localhost:3002",
  });
  expect(res.status).toBe(200);
});

test("api: rejects rebinding, cross-site, and non-JSON POST requests", async () => {
  const cases: Array<[Record<string, string>, RequestInit?]> = [
    [{ host: "evil.example:3002" }],
    [{ host: "192.168.1.5:3002" }],
    [{ host: "localhost:3002", origin: "https://evil.example" }],
    [{ host: "localhost:3002", "sec-fetch-site": "cross-site" }],
    [
      { host: "localhost:3002", "content-type": "text/plain" },
      { method: "POST", body: "{}" },
    ],
  ];
  for (const [headers, init] of cases) {
    const res = await api.request(
      "http://localhost:3002/api/semantic/analyze",
      {
        method: "POST",
        ...init,
        headers: { "content-type": "application/json", ...headers },
      }
    );
    expect(res.status).toBe(403);
  }
  expect((await providers({ host: "evil.example" })).status).toBe(403);
});
