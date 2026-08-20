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

/* Square returns bigint amounts and Date objects that JSON.stringify
   chokes on; normalize before logging or persisting. */
export function plain(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
}
