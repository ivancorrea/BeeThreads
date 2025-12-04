/**
 * @fileoverview Worker thread script for executing generator functions.
 *
 * ## Why This File Exists
 *
 * Generator functions have a fundamentally different execution model than
 * regular functions - they yield multiple values over time. This requires
 * a separate worker script with streaming message protocol instead of the
 * single request-response pattern used by `worker.ts`.
 *
 * ## What It Does
 *
 * - Receives generator function source + arguments + context from main thread
 * - Validates function source (with caching for performance)
 * - Compiles using vm.Script with LRU caching
 * - Executes generator and streams yields back to main thread
 * - Handles async generators (yields that return Promises)
 * - Captures return value and sends END message
 * - Forwards console.log/warn/error to main thread
 *
 * ## Message Protocol
 *
 * ```
 * Main Thread                    Worker Thread
 *      |                              |
 *      |-------- { fn, args } ------->|
 *      |                              | (execute generator)
 *      |<------ { type: YIELD } ------|  (for each yield)
 *      |<------ { type: YIELD } ------|
 *      |<------ { type: RETURN } -----|  (return value)
 *      |<------ { type: END } --------|  (completion)
 * ```
 *
 * ## Technical Details
 *
 * - Uses `setImmediate()` between yields to prevent blocking
 * - Handles async yields by awaiting Promises before continuing
 * - Cleans up generator with `gen.return?.()` on errors
 *
 * @module bee-threads/generator-worker
 */

import { parentPort, workerData } from 'worker_threads';
import { createFunctionCache } from './cache';
import { MessageType, LogLevel } from './types';
import type { WorkerMessage, SerializedError, FunctionCache } from './types';

// Type guard for parentPort
if (!parentPort) {
  throw new Error('This file must be run as a worker thread');
}

const port = parentPort;

// ============================================================================
// WORKER DATA TYPES
// ============================================================================

interface WorkerConfig {
  functionCacheSize?: number;
  functionCacheTTL?: number;
  lowMemoryMode?: boolean;
  debugMode?: boolean;
}

const workerConfig = (workerData as WorkerConfig) || {};
const DEBUG_MODE = workerConfig.debugMode ?? false;

/** Current function being executed (for debug) */
let currentFnSource: string | null = null;

// ============================================================================
// GLOBAL ERROR HANDLERS - Prevent worker crash without response
// ============================================================================

/**
 * Creates a serialized error with optional debug info.
 */
function createSerializedError(err: Error, source?: string | null): SerializedError {
  // Monomorphic object shape - all properties declared upfront to avoid hidden class transitions
  const serialized: SerializedError = {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack,
    _sourceCode: (DEBUG_MODE && source) ? source : undefined,
    cause: undefined,
    errors: undefined
  };
  
  // Copy custom error properties (code, statusCode, etc.)
  const errKeys = Object.keys(err);
  for (let i = 0, len = errKeys.length; i < len; i++) {
    const key = errKeys[i];
    if (key !== 'name' && key !== 'message' && key !== 'stack') {
      const value = (err as unknown as Record<string, unknown>)[key];
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        (serialized as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  
  return serialized;
}

process.on('uncaughtException', (err: Error) => {
  try {
    port.postMessage({
      type: MessageType.ERROR,
      error: createSerializedError(err, currentFnSource)
    });
  } catch {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason: unknown) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    port.postMessage({
      type: MessageType.ERROR,
      error: createSerializedError(err, currentFnSource)
    });
  } catch {
    process.exit(1);
  }
});

// ============================================================================
// FUNCTION CACHE
// ============================================================================

const cacheSize = workerConfig.functionCacheSize || 100;
const cacheTTL = workerConfig.functionCacheTTL ?? 0;
const fnCache: FunctionCache = createFunctionCache(cacheSize, cacheTTL);

/** Expose cache for debugging */
(globalThis as Record<string, unknown>).BeeCache = fnCache;

// ============================================================================
// CONSOLE REDIRECTION
// ============================================================================

// Helper to convert args to strings without .map() overhead
function argsToStrings(args: unknown[]): string[] {
  const result = new Array<string>(args.length);
  for (let i = 0, len = args.length; i < len; i++) {
    result[i] = String(args[i]);
  }
  return result;
}

console.log = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.LOG, args: argsToStrings(args) });
};

console.warn = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.WARN, args: argsToStrings(args) });
};

console.error = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.ERROR, args: argsToStrings(args) });
};

console.info = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.INFO, args: argsToStrings(args) });
};

console.debug = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.DEBUG, args: argsToStrings(args) });
};

// ============================================================================
// ERROR SERIALIZATION
// ============================================================================

function serializeError(e: unknown): SerializedError {
  // Monomorphic object shape - all properties declared upfront
  const serialized: SerializedError = {
    name: 'Error',
    message: '',
    stack: undefined,
    _sourceCode: (DEBUG_MODE && currentFnSource) ? currentFnSource : undefined,
    cause: undefined,
    errors: undefined
  };
  
  if (e && typeof e === 'object' && 'name' in e && 'message' in e) {
    const err = e as Record<string, unknown>;
    serialized.name = String(err.name);
    serialized.message = String(err.message);
    serialized.stack = err.stack as string | undefined;
    
    // Preserve Error.cause (ES2022) - serialize recursively
    if ('cause' in err && err.cause != null) {
      serialized.cause = serializeError(err.cause);
    }
    
    // Preserve AggregateError.errors - serialize each error
    if ('errors' in err && Array.isArray(err.errors)) {
      const errArray = err.errors;
      const serializedErrors = new Array(errArray.length);
      for (let j = 0, jlen = errArray.length; j < jlen; j++) {
        serializedErrors[j] = serializeError(errArray[j]);
      }
      serialized.errors = serializedErrors;
    }
    
    // Copy custom properties (like code, statusCode, etc.)
    const errObjKeys = Object.keys(err);
    for (let i = 0, len = errObjKeys.length; i < len; i++) {
      const key = errObjKeys[i];
      if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause' && key !== 'errors') {
        const value = err[key];
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          (serialized as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
  else if (e instanceof Error) {
    serialized.name = e.name;
    serialized.message = e.message;
    serialized.stack = e.stack;
    
    // Preserve cause
    if (e.cause != null) {
      serialized.cause = serializeError(e.cause);
    }
    
    // Preserve AggregateError.errors
    if (e instanceof AggregateError) {
      const errArray = e.errors;
      const serializedErrors = new Array(errArray.length);
      for (let j = 0, jlen = errArray.length; j < jlen; j++) {
        serializedErrors[j] = serializeError(errArray[j]);
      }
      serialized.errors = serializedErrors;
    }
    
    const errorKeys = Object.keys(e);
    for (let i = 0, len = errorKeys.length; i < len; i++) {
      const key = errorKeys[i];
      if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause' && key !== 'errors') {
        const value = (e as unknown as Record<string, unknown>)[key];
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          (serialized as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
  else {
    serialized.message = String(e);
  }
  
  return serialized;
}

// ============================================================================
// FUNCTION SOURCE VALIDATION (with caching)
// ============================================================================

const VALID_FUNCTION_PATTERNS: RegExp[] = [
  /^function\s*\*?\s*\w*\s*\(/,
  /^async\s+function\s*\*?\s*\w*\s*\(/,
  /^\(.*\)\s*=>/,
  /^\w+\s*=>/,
  /^async\s*\(.*\)\s*=>/,
  /^async\s+\w+\s*=>/,
  /^\(\s*\[/,
  /^\(\s*\{/,
];

const validatedSources = new Set<string>();
const MAX_VALIDATION_CACHE = 200;

function validateFunctionSource(src: unknown): asserts src is string {
  if (typeof src !== 'string') {
    throw new TypeError('Function source must be a string');
  }

  if (validatedSources.has(src)) {
    return;
  }

  const trimmed = src.trim();

  // Manual loop with early return (faster than .some())
  let isValid = false;
  for (let i = 0, len = VALID_FUNCTION_PATTERNS.length; i < len; i++) {
    if (VALID_FUNCTION_PATTERNS[i].test(trimmed)) {
      isValid = true;
      break;
    }
  }
  if (!isValid) {
    throw new TypeError('Invalid function source - does not appear to be a function');
  }

  if (validatedSources.size >= MAX_VALIDATION_CACHE) {
    const iterator = validatedSources.values();
    for (let i = 0, len = 50; i < len; i++) {
      const value = iterator.next().value;
      if (value) validatedSources.delete(value);
    }
  }
  validatedSources.add(src);
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

interface GeneratorLike {
  next(): IteratorResult<unknown, unknown>;
  return?(): IteratorResult<unknown, unknown>;
}

port.on('message', (message: WorkerMessage) => {
  const { fn: src, args, context } = message;

  // Store current function source for debug error messages
  currentFnSource = src;

  try {
    validateFunctionSource(src);

    const fn = fnCache.getOrCompile(src, context);

    if (typeof fn !== 'function') {
      throw new TypeError('Evaluated source did not produce a function');
    }

    const gen = fn(...args) as GeneratorLike;

    if (!gen || typeof gen.next !== 'function') {
      throw new TypeError('Function must return a generator/iterator');
    }

    function step(next: IteratorResult<unknown, unknown>): void {
      if (next.done) {
        if (next.value !== undefined) {
          port.postMessage({ type: MessageType.RETURN, value: next.value });
        }
        port.postMessage({ type: MessageType.END });
        currentFnSource = null;
        return;
      }

      const value = next.value;

      if (value && value instanceof Promise) {
        value
          .then(v => {
            port.postMessage({ type: MessageType.YIELD, value: v });
            step(gen.next());
          })
          .catch(e => {
            port.postMessage({ type: MessageType.ERROR, error: serializeError(e) });
            currentFnSource = null;
            try { gen.return?.(); } catch { /* ignore */ }
          });
      } else {
        port.postMessage({ type: MessageType.YIELD, value });
        setImmediate(() => step(gen.next()));
      }
    }

    step(gen.next());
  } catch (e) {
    port.postMessage({ type: MessageType.ERROR, error: serializeError(e) });
    currentFnSource = null;
  }
});

