/* =====================================================================
   Billing cycle date math.

   All dates here are plain calendar dates in UTC ('YYYY-MM-DD'). Billing
   deliberately does not carry a time-of-day: the cron sweep runs once a
   day and charges everything whose next_charge_on has arrived, so an
   hour's drift never double-charges or skips a cycle.
   ===================================================================== */

export const MIN_PLAN_CHANGE_NOTICE_DAYS = 30;

export function toDateString(d) {
  return d.toISOString().slice(0, 10);
}

export function parseDate(s) {
  return new Date(`${s}T00:00:00.000Z`);
}

/* Adds `months` to a date, clamping to the last day of the target month.
   An anchor on the 31st bills Feb 28 (or 29) rather than rolling forward
   into March, which is what JS Date arithmetic would otherwise do. */
export function addMonthsClamped(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDayOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();

  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDayOfTarget)));
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

/* The next monthly cycle boundary strictly after `from`, walking forward
   from the subscription's original anchor so cycles stay pinned to the
   anchor day rather than drifting by whatever date a change was made. */
export function nextCycleAfter(anchorDate, from) {
  let n = 1;
  let candidate = addMonthsClamped(anchorDate, n);
  // Anchors can be months in the past for a long-running subscription.
  while (candidate <= from) {
    n += 1;
    candidate = addMonthsClamped(anchorDate, n);
  }
  return candidate;
}

/* effective_at for an upgrade/downgrade: the start of the next
   production cycle, but never sooner than 30 days out, per the
   "Client-Managed Upgrades and Downgrades" clause in the portal TOS.
   If the next cycle falls inside the notice window, it slips to the one
   after. */
export function planChangeEffectiveAt(anchorDate, requestedAt) {
  const earliest = addDays(requestedAt, MIN_PLAN_CHANGE_NOTICE_DAYS);
  let candidate = nextCycleAfter(anchorDate, requestedAt);
  while (candidate < earliest) {
    candidate = nextCycleAfter(anchorDate, candidate);
  }
  return candidate;
}
