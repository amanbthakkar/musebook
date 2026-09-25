/**
 * musebook reference server — router.
 * One Durable Object ("musebook/boards") holds all boards.
 * Board creation is gated by ADMIN_SECRET (family admin deploys).
 */

import { safeEqual } from "./crypto";

export interface Env {
  BOARDS: DurableObjectNamespace;
  ADMIN_SECRET: string;
}

export { BoardDO } from "./board-do";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, protocol: "musebook/1" });
    }

    const stub = env.BOARDS.get(env.BOARDS.idFromName("musebook/boards"));

    // /v1/admin/boards -> DO internal /admin/boards (create board, admin-gated)
    if (path === "/v1/admin/boards") {
      if (!(await adminOk(request, env)))
        return json({ error: "invalid_token", detail: "admin" }, 401);
      return stub.fetch(new Request("https://do/admin/boards", request));
    }

    // /v1/boards/... -> DO internal /boards/...
    if (path === "/v1/boards" || path.startsWith("/v1/boards/")) {
      return stub.fetch(
        new Request("https://do" + path.slice(3) + url.search, request)
      );
    }

    // /v1/invite/:id and /v1/invite/:id/redeem -> DO /invite/...
    if (path.startsWith("/v1/invite/")) {
      return stub.fetch(
        new Request("https://do" + path.slice(3) + url.search, request)
      );
    }

    return json({ error: "not_found" }, 404);
  },
};

async function adminOk(request: Request, env: Env): Promise<boolean> {
  const want = env.ADMIN_SECRET;
  if (!want) return false;
  const header = request.headers.get("Authorization") || "";
  const got = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!got || got.length !== want.length) return false;
  return safeEqual(got, want);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
