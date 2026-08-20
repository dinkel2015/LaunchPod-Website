import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsClamped, nextCycleAfter, planChangeEffectiveAt,
  parseDate, toDateString, MIN_PLAN_CHANGE_NOTICE_DAYS,
} from "./billing.js";

const d = parseDate;
const s = toDateString;

test("addMonthsClamped pins to month end instead of overflowing", () => {
  assert.equal(s(addMonthsClamped(d("2026-01-31"), 1)), "2026-02-28");
  assert.equal(s(addMonthsClamped(d("2028-01-31"), 1)), "2028-02-29", "leap year");
  assert.equal(s(addMonthsClamped(d("2026-03-31"), 1)), "2026-04-30");
  assert.equal(s(addMonthsClamped(d("2026-01-15"), 1)), "2026-02-15");
  assert.equal(s(addMonthsClamped(d("2026-12-31"), 1)), "2027-01-31", "year rollover");
});

test("a 31st anchor returns to the 31st after a short month", () => {
  // The bug this guards: clamping to Feb 28 and then treating Feb 28 as
  // the new anchor would permanently walk the billing date backwards.
  const anchor = d("2026-01-31");
  assert.equal(s(addMonthsClamped(anchor, 1)), "2026-02-28");
  assert.equal(s(addMonthsClamped(anchor, 2)), "2026-03-31");
  assert.equal(s(addMonthsClamped(anchor, 3)), "2026-04-30");
  assert.equal(s(addMonthsClamped(anchor, 4)), "2026-05-31");
});

test("nextCycleAfter always moves strictly forward", () => {
  const anchor = d("2026-01-15");
  assert.equal(s(nextCycleAfter(anchor, d("2026-01-15"))), "2026-02-15");
  assert.equal(s(nextCycleAfter(anchor, d("2026-02-15"))), "2026-03-15");
  // A subscription whose anchor is a year in the past still lands on the
  // next upcoming cycle, not on an already-passed one.
  assert.equal(s(nextCycleAfter(anchor, d("2026-08-20"))), "2026-09-15");
});

test("plan changes never take effect sooner than the 30-day notice", () => {
  const anchor = d("2026-01-10");

  // Requested Aug 20; next cycle is Sep 10, only 21 days out -> slips to Oct 10.
  const soon = planChangeEffectiveAt(anchor, d("2026-08-20"));
  assert.equal(s(soon), "2026-10-10");

  // Requested Aug 1; next cycle Sep 10 is 40 days out -> stands.
  const fine = planChangeEffectiveAt(anchor, d("2026-08-01"));
  assert.equal(s(fine), "2026-09-10");
});

test("effective_at is always at least 30 days out, for every request date in a year", () => {
  const anchor = d("2026-01-10");
  for (let i = 0; i < 365; i++) {
    const requested = new Date(d("2026-01-01").getTime() + i * 86_400_000);
    const effective = planChangeEffectiveAt(anchor, requested);
    const gapDays = (effective - requested) / 86_400_000;
    assert.ok(
      gapDays >= MIN_PLAN_CHANGE_NOTICE_DAYS,
      `only ${gapDays}d notice for a change requested ${s(requested)} (effective ${s(effective)})`,
    );
    assert.equal(effective.getUTCDate(), 10, "effective date must stay on the anchor day");
  }
});
