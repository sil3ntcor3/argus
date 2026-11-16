import { format, isValid, parse, startOfDay } from 'date-fns';

export const RISK_DATE_FORMAT = 'yyyy-MM-dd';
export const MAX_RISK_ACCEPTANCE_DAYS = 180;

export const latestRiskExpiry = (now: Date, maxDays = MAX_RISK_ACCEPTANCE_DAYS) =>
  new Date(now.getTime() + maxDays * 86_400_000);

/** Resolve a valid date to the start of that day in the user's timezone. */
export function riskExpiryAt(value: string, now = new Date(), maxDays = MAX_RISK_ACCEPTANCE_DAYS): Date | null {
  const date = startOfDay(parse(value, RISK_DATE_FORMAT, now));
  return isValid(date) &&
    format(date, RISK_DATE_FORMAT) === value &&
    date > now &&
    date <= latestRiskExpiry(now, maxDays)
    ? date
    : null;
}
