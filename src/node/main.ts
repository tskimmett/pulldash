import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import api from "@/api/api";
import { resolve } from "path";
import { Hono } from "hono";
import { readFileSync } from "fs";

const app = new Hono();

const distDir = resolve(__dirname, "..", "..", "dist", "browser");

console.log("distDir", distDir);

// Same security headers (CSP etc.) as the hosted build; written by
// build:browser. Read lazily so a server started mid-build picks them up.
let securityHeaders: Record<string, string> | null = null;
app.use(async (c, next) => {
  await next();
  if (!securityHeaders) {
    try {
      const config = JSON.parse(
        readFileSync(resolve(distDir, "staticwebapp.config.json"), "utf-8")
      );
      securityHeaders = config.globalHeaders;
    } catch {
      return;
    }
  }
  for (const [name, value] of Object.entries(securityHeaders!)) {
    c.header(name, value);
  }
});

// API routes first
app.route("/", api);

// Static files
app.use("/*", serveStatic({ root: distDir }));

// SPA fallback - serve index.html for client-side routing
app.get("*", (c) => {
  if (c.req.path === "/favicon.ico") {
    return c.body(null, 404);
  }
  const indexPath = resolve(distDir, "index.html");
  const html = readFileSync(indexPath, "utf-8");
  return c.html(html.replaceAll("./", "/"));
});

serve(
  {
    fetch: app.fetch,
    // Loopback only: the API runs local agents and has no auth of its own.
    hostname: "127.0.0.1",
    port: Number(process.env.PORT) || 3002,
  },
  (address) => {
    console.log(`🚀 better pr running at http://localhost:${address.port}`);
  }
);
