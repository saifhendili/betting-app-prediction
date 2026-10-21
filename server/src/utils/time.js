/** Date helpers. All "day" strings are YYYY-MM-DD in the configured timezone. */
import { env } from '../config/env.js';

export function dayString(date = new Date(), tz = env.timezone) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function todayString(tz = env.timezone) {
  return dayString(new Date(), tz);
}

export function tomorrowString(tz = env.timezone) {
  return dayString(new Date(Date.now() + 24 * 3600 * 1000), tz);
}

/** Only today + tomorrow are ever requested — the app is deliberately short-horizon. */
export function allowedDays(tz = env.timezone) {
  return [todayString(tz), tomorrowString(tz)];
}

export const minutesUntil = (iso) => (new Date(iso).getTime() - Date.now()) / 60000;
