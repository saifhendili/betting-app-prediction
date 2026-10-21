import * as football from './football.js';
import * as basketball from './basketball.js';
import * as hockey from './hockey.js';
import { SPORTS } from '../../config/env.js';

const adapters = { football, basketball, hockey };

export function adapter(sport) {
  const a = adapters[sport];
  if (!a) throw new Error(`Unsupported sport "${sport}". Use one of: ${SPORTS.join(', ')}`);
  return a;
}

export { football, basketball, hockey, SPORTS };
export { sportsKeys, sportsUsage, SportsApiError, PlanRestrictionError, planRestrictions } from './client.js';
