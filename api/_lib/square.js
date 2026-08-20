import { createHash } from "node:crypto";
import { SquareClient, SquareEnvironment } from "square";
import { requireEnv } from "./http.js";

/* SQUARE_ENV must be 'sandbox' or 'production'. There is deliberately no
   default: an unset value must not silently resolve to production. */
export function squareClient() {
  const env = requireEnv("SQUARE_ENV");
  if (env !== "sandbox" && env !== "production") {
    throw new Error(`SQUARE_ENV must be 'sandbox' or 'production', got '${env}'`);
  }
  return new SquareClient({
    token: requireEnv("SQUARE_ACCESS_TOKEN"),
    environment: env === "production" ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
  });
}

export const locationId = () => requireEnv("SQUARE_LOCATION_ID");

/* Square's Money.amount is a bigint in the current Node SDK; passing a
   plain number is a type error at runtime. Every amount crossing into
   Square goes through here. */
export function money(cents) {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`money() expects a non-negative integer of cents, got ${cents}`);
  }
  return { amount: BigInt(cents), currency: "USD" };
}

/* Square rejects an idempotency_key longer than 45 characters with
   VALUE_TOO_LONG. A bare UUID (36) plus any prefix and an ISO date runs
   straight past that, so keys are built here and length-checked — the
   failure otherwise only shows up as a rejected API call at charge time.

   Deterministic for the same inputs, which is the point: a duplicate
   invocation must reuse the key so Square returns the original payment
   instead of charging twice. */
export function idempotencyKey(prefix, ...parts) {
  const key = [prefix, ...parts.map((p) => String(p).replace(/-/g, ""))].join("-");
  if (key.length > 45) {
    throw new Error(`Square idempotency key too long (${key.length} > 45): ${key}`);
  }
  return key;
}

/* Key for one recurring cycle charge.

   Keying on (subscription, cycle) alone is wrong in two ways:

   1. An idempotency key is bound to the request parameters. If a plan
      change becomes effective while a cycle is being retried, the amount
      differs and Square rejects the whole charge with
      IDEMPOTENCY_KEY_REUSED — the subscription then sticks at past_due
      and can never be billed for that cycle.

   2. A key is consumed by the attempt, not by its success. Reusing it
      the next day to retry a declined card returns the original failed
      payment rather than making a fresh attempt, so a recoverable
      decline would never recover.

   Including the attempt date and the amount fixes both while keeping the
   guarantee that matters: two runs on the SAME day for the SAME cycle at
   the SAME price collapse to one charge. sha256 keeps it inside 45 chars
   regardless of input length; sub.id is also sent as referenceId and the
   cycle as the note, so payments stay traceable in the Square dashboard. */
export function cycleIdempotencyKey({ subscriptionId, cycleDate, attemptDate, cents }) {
  const digest = createHash("sha256")
    .update(`${subscriptionId}|${cycleDate}|${attemptDate}|${cents}`)
    .digest("hex")
    .slice(0, 40);
  return `c-${digest}`; // 42 chars
}

/* Square returns bigint amounts and Date objects that JSON.stringify
   chokes on; normalize before logging or persisting. */
export function plain(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
}
