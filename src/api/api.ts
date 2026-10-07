import { Hono } from "hono";
import semantic from "./semantic";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostname(host: string): string {
  return host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0]!;
}

/**
 * The API drives local agents on the user's subscription, so only the app
 * itself may call it: the Host must be loopback (defeats DNS rebinding), any
 * Origin must be that same host (defeats cross-site requests), and POST bodies
 * must be JSON (forces a CORS preflight for cross-origin callers).
 */
export function isTrustedApiRequest(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host || !LOOPBACK_HOSTS.has(hostname(host.toLowerCase()))) return false;

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (originHost.toLowerCase() !== host.toLowerCase()) return false;
  }

  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;

  if (req.method === "POST") {
    const type = req.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) return false;
  }
  return true;
}

const api = new Hono()
  .basePath("/api")
  .use(async (c, next) => {
    if (!isTrustedApiRequest(c.req.raw)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  })

  // Semantic review (local-agent-powered)
  .route("/semantic", semantic);

export default api;
export type AppType = typeof api;
