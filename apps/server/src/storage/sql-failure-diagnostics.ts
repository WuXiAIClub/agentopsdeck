import { types } from 'node:util';
import type { PerformanceTrace } from '../diagnostics/performance.js';

/** Numeric evidence only. Never inspect exception text, inherited properties,
 * getters or Proxy traps; classification is not transaction/recovery authority. */
export function sqlFailureCode(error: unknown): number | undefined {
  let result: number | undefined;
  try {
    if (error !== null && typeof error === 'object' && !types.isProxy(error)) {
      const code = Object.getOwnPropertyDescriptor(error, 'code');
      const number = Object.getOwnPropertyDescriptor(error, 'errcode');
      if (code && 'value' in code && code.value === 'ERR_SQLITE_ERROR'
        && number && 'value' in number && Number.isInteger(number.value) && number.value > 0 && number.value <= 0xffff) {
        result = number.value;
      }
    }
  } catch { /* Unknown remains unknown; never replace the original outcome. */ }
  return result;
}

export function addSqlFailure(trace: PerformanceTrace, error: unknown,
  metric: 'sqlErrorCode' | 'rollbackErrorCode' = 'sqlErrorCode'): void {
  const result = sqlFailureCode(error);
  if (result === undefined) trace.add('classificationUnknown', 1);
  else trace.add(metric, result);
}
