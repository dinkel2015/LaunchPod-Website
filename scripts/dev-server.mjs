/* =====================================================================
   Local dev server: serves the static site and mounts the real /api
   handlers behind a Vercel-compatible req/res shim.

     node --env-file=.env scripts/dev-server.mjs

   This is what makes it possible to click through portal.html against
   real Supabase, real Square sandbox and real ClickUp before deploying.
   ===================================================================== */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT || 4012);

const routes = {
  "/api/config": (await import("../api/config.js")).default,
  "/api/checkout": (await import("../api/checkout.js")).default,
  "/api/plan-change": (await import("../api/plan-change.js")).default,
  "/api/promo/validate": (await import("../api/promo/validate.js")).default,
  "/api/clickup/provision": (await import("../api/clickup/provision.js")).default,
  "/api/billing/charge-cycle": (await import("../api/billing/charge-cycle.js")).default,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handler = routes[url.pathname];

  if (handler) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    req.body = raw ? JSON.parse(raw) : {};

    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => { res.end(b); return res; };

    try {
      await handler(req, res);
    } catch (e) {
      console.error(`${url.pathname} threw:`, e);
      if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
    }
    console.log(`${req.method} ${url.pathname} -> ${res.statusCode}`);
    return;
  }

  // Static, with Vercel's cleanUrls behaviour so /portal serves portal.html
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!extname(path)) path += ".html";

  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`portal:  http://localhost:${PORT}/portal`);
  console.log(`square:  ${process.env.SQUARE_ENV}`);
});
