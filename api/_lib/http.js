/* Shared HTTP plumbing for the portal's serverless functions. */

/* Reads a required secret. Throws at call time rather than defaulting to
   a placeholder, so a missing Vercel env var fails the request loudly
   instead of silently charging against the wrong Square account. */
export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function json(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.status(status).send(JSON.stringify(body));
}

export function methodGuard(req, res, allowed) {
  if (req.method !== allowed) {
    res.setHeader("Allow", allowed);
    json(res, 405, { error: `Method ${req.method} not allowed` });
    return false;
  }
  return true;
}

/* Vercel parses JSON bodies automatically, but not when the caller omits
   or misstates Content-Type. Handle both shapes. */
export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error("Request body is not valid JSON");
    }
  }
  return {};
}

export function bearerToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

/* Errors surfaced to the browser must never leak a Square or Supabase
   error body — those can contain internal ids and key fragments. Log the
   real thing, return a generic message plus a correlation id. */
export function fail(res, status, publicMessage, internalError) {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`[${ref}] ${publicMessage}:`, internalError);
  json(res, status, { error: publicMessage, ref });
}
