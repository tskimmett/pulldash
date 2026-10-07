import { Hono } from "hono";
import semantic from "./semantic";

const api = new Hono()
  .basePath("/api")

  // Semantic review (local-agent-powered)
  .route("/semantic", semantic);

export default api;
export type AppType = typeof api;
