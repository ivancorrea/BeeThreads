/**
 * @fileoverview Worker thread for executing functions.
 * 
 * Supports:
 * - Regular functions
 * - Async functions
 * - Curried functions (auto-applies args)
 * - Context injection for closures
 * 
 * @module bee-threads/worker
 */

'use strict';

const { parentPort } = require('worker_threads');
const { createFunctionCache } = require('./cache');

// ============================================================================
// FUNCTION CACHE
// ============================================================================

/**
 * LRU cache for compiled functions.
 * Avoids repeated eval() calls for the same function.
 * Also allows V8 to optimize hot functions.
 */
const fnCache = createFunctionCache(100);

// ============================================================================
// CONSOLE REDIRECTION
// ============================================================================

/**
 * Redirects console.log/warn/error to main thread.
 * 
 * Worker threads don't share stdout with main thread by default.
 * This intercepts console methods and sends logs via postMessage.
 */
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console)
};

console.log = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'log', args: args.map(String) });
};

console.warn = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'warn', args: args.map(String) });
};

console.error = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'error', args: args.map(String) });
};

console.info = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'info', args: args.map(String) });
};

console.debug = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'debug', args: args.map(String) });
};

// ============================================================================
// ERROR SERIALIZATION
// ============================================================================

/**
 * Serializes error for transmission to main thread.
 * 
 * @param {Error|any} e - Error to serialize
 * @returns {{ name: string, message: string, stack?: string }}
 */
function serializeError(e) {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { name: 'Error', message: String(e) };
}

// ============================================================================
// FUNCTION VALIDATION
// ============================================================================

/**
 * Validates source looks like a valid function.
 * 
 * @param {string} src - Function source
 * @throws {TypeError} If invalid
 */
function validateFunctionSource(src) {
  if (typeof src !== 'string') {
    throw new TypeError('Function source must be a string');
  }
  
  const trimmed = src.trim();
  const validPatterns = [
    /^function\s*\w*\s*\(/,
    /^async\s+function\s*\w*\s*\(/,
    /^\(.*\)\s*=>/,
    /^\w+\s*=>/,
    /^async\s*\(.*\)\s*=>/,
    /^async\s+\w+\s*=>/,
    /^\(\s*\[/,
    /^\(\s*\{/,
  ];
  
  if (!validPatterns.some(p => p.test(trimmed))) {
    throw new TypeError('Invalid function source');
  }
}

// ============================================================================
// CURRIED FUNCTION SUPPORT
// ============================================================================

/**
 * Applies arguments to a function, handling curried functions.
 * 
 * If the function returns another function, continues applying
 * remaining arguments until all are consumed or result is not a function.
 * 
 * @param {Function} fn - Function to apply
 * @param {Array} args - Arguments to apply
 * @returns {*} Final result
 * 
 * @example
 * applyCurried((a, b) => a + b, [1, 2]);     // → 3
 * applyCurried(a => b => c => a+b+c, [1,2,3]); // → 6
 * applyCurried(() => 42, []);                // → 42
 */
function applyCurried(fn, args) {
  // No args - just call the function
  if (!args || args.length === 0) {
    return fn();
  }
  
  // Try normal function call first (multi-arg)
  // If fn expects multiple args, this works: fn(a, b, c)
  // If fn is curried and returns function, we continue below
  let result = fn(...args);
  
  // If result is still a function, we might have a curried function
  // that needs sequential application: fn(a)(b)(c)
  if (typeof result === 'function' && args.length > 1) {
    // Try curried application
    result = fn;
    for (const arg of args) {
      if (typeof result !== 'function') break;
      result = result(arg);
    }
  }
  
  return result;
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

parentPort.on('message', ({ fn: src, args, context }) => {
  try {
    validateFunctionSource(src);
    
    // Get compiled function from cache (or compile and cache it)
    const fn = fnCache.getOrCompile(src, context);
    
    if (typeof fn !== 'function') {
      throw new TypeError('Evaluated source did not produce a function');
    }
    
    // Apply arguments (handles curried functions)
    const ret = applyCurried(fn, args);

    // Handle async results
    if (ret && typeof ret.then === 'function') {
      ret
        .then(v => parentPort.postMessage({ ok: true, value: v }))
        .catch(e => parentPort.postMessage({ ok: false, error: serializeError(e) }));
    } else {
      parentPort.postMessage({ ok: true, value: ret });
    }
  } catch (e) {
    parentPort.postMessage({ ok: false, error: serializeError(e) });
  }
});
