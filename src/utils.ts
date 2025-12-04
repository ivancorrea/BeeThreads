/**
 * @fileoverview Utility functions for bee-threads.
 *
 * ## Why This File Exists
 *
 * Contains small, reusable utility functions used across the codebase.
 * Keeping these separate avoids code duplication and makes testing easier.
 *
 * ## What It Does
 *
 * - `deepFreeze()` - recursively freezes objects to prevent mutation
 * - `sleep()` - Promise-based delay utility for retry logic
 * - `calculateBackoff()` - exponential backoff with jitter for retries
 *
 * ## Why Jitter in Backoff?
 *
 * When multiple tasks fail and retry simultaneously, they'd all retry
 * at the same intervals, causing "thundering herd" problems. Adding
 * ±25% jitter spreads out the retries randomly.
 *
 * @module bee-threads/utils
 */

/**
 * Recursively freezes an object to prevent mutation.
 *
 * @param obj - Object to freeze
 * @returns Frozen object
 *
 * @example
 * const frozen = deepFreeze({ a: { b: 1 } });
 * frozen.a.b = 2; // throws in strict mode
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') return obj;
  
  const keys = Object.keys(obj as object);
  for (let i = 0, len = keys.length; i < len; i++) {
    const value = (obj as Record<string, unknown>)[keys[i]];
    if (typeof value === 'object' && value !== null) {
      deepFreeze(value);
    }
  }
  
  return Object.freeze(obj);
}

/**
 * Promise-based sleep utility.
 *
 * @param ms - Milliseconds to wait
 * @returns Promise that resolves after ms milliseconds
 *
 * @example
 * await sleep(1000); // waits 1 second
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calculates exponential backoff delay with jitter.
 *
 * Formula: `min(baseDelay * factor^attempt, maxDelay) ± 25%`
 *
 * Jitter prevents thundering herd when multiple retries happen simultaneously.
 *
 * @param attempt - Current attempt (0-indexed)
 * @param baseDelay - Initial delay in ms
 * @param maxDelay - Maximum delay cap in ms
 * @param factor - Exponential factor
 * @returns Delay in milliseconds
 *
 * @example
 * calculateBackoff(0, 100, 5000, 2); // ~100ms
 * calculateBackoff(1, 100, 5000, 2); // ~200ms
 * calculateBackoff(2, 100, 5000, 2); // ~400ms
 */
export function calculateBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  factor: number
): number {
  const delay = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

