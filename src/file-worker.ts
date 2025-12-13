/**
 * @fileoverview File-based worker execution for bee-threads.
 *
 * Enables running external worker files with full `require()` access,
 * database connections, and third-party module support.
 *
 * ## Features
 * - **Type-safe**: Full TypeScript inference for arguments and return types
 * - **Worker pooling**: Automatic pool management per file path
 * - **Turbo mode**: Parallel array processing across multiple workers
 * - **Error handling**: Proper error propagation with stack traces
 *
 * ## V8 Optimizations
 * - Monomorphic object shapes (stable property structure)
 * - Raw for loops instead of .find()/.filter()/.map()
 * - Pre-allocated arrays
 * - Avoid property addition after creation
 *
 * ## When to Use
 * Use file workers when your worker needs:
 * - Database connections (PostgreSQL, MongoDB, Redis)
 * - External npm modules (sharp, bcrypt, etc.)
 * - File system access
 * - Environment variables and config files
 *
 * @example Single Execution
 * ```typescript
 * // workers/hash-password.ts
 * import bcrypt from 'bcrypt';
 * export default async function(password: string): Promise<string> {
 *   return bcrypt.hash(password, 12);
 * }
 *
 * // main.ts
 * import type hashPassword from './workers/hash-password';
 * const hash = await beeThreads.worker<typeof hashPassword>('./workers/hash-password')('secret');
 * ```
 *
 * @example Turbo Mode (Parallel Arrays)
 * ```typescript
 * // workers/process-users.ts
 * import { db } from '../database';
 * export default async function(users: User[]): Promise<ProcessedUser[]> {
 *   return Promise.all(users.map(async u => ({
 *     ...u,
 *     score: await db.getScore(u.id)
 *   })));
 * }
 *
 * // main.ts - Process 10,000 users across 8 workers
 * const results = await beeThreads.worker('./workers/process-users').turbo(users, { workers: 8 });
 * ```
 *
 * @module bee-threads/file-worker
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
// AutoPack disabled for now - structuredClone handles TypedArrays well
// import { autoPack, ... } from './autopack';

// ============================================================================
// TYPES
// ============================================================================

/** Any function type for generic constraints */
type AnyFunction = (...args: any[]) => any;

/**
 * Internal worker pool entry tracking state.
 * V8: All properties initialized upfront for stable shape.
 * @internal
 */
interface FileWorkerEntry {
  /** Node.js Worker instance */
  worker: Worker;
  /** Whether worker is currently processing a task */
  busy: boolean;
  /** Absolute path to the worker file */
  path: string;
}

/**
 * Options for turbo mode parallel processing.
 *
 * @example
 * ```typescript
 * await beeThreads.worker('./worker.ts').turbo(data, {
 *   workers: 8  // Use 8 parallel workers
 * });
 * ```
 */
export interface TurboWorkerOptions {
  /**
   * Number of workers to use for parallel processing.
   *
   * @default os.cpus().length - 1
   *
   * @remarks
   * - Higher values increase parallelism but also memory usage
   * - Each worker maintains its own module cache and DB connections
   * - Recommended: Start with default, increase if CPU-bound
   * 
   * **Performance Note:**
   * For maximum performance with arrays, consider using `beeThreads.turbo()`
   * which uses SharedArrayBuffer for TypedArrays. File workers are best
   * suited for tasks that need `require()`, database access, or external modules.
   */
  workers?: number;
}

/**
 * Type-safe executor for file-based workers.
 *
 * Returned by `beeThreads.worker()`. Can be called directly for single
 * execution or use `.turbo()` for parallel array processing.
 *
 * @typeParam T - The worker's default export function type
 *
 * @example Direct Call
 * ```typescript
 * const executor = beeThreads.worker<typeof myWorker>('./workers/my-worker');
 * const result = await executor(arg1, arg2);
 * ```
 *
 * @example Turbo Mode
 * ```typescript
 * const executor = beeThreads.worker('./workers/process-chunk');
 * const results = await executor.turbo(largeArray, { workers: 4 });
 * ```
 */
export interface FileWorkerExecutor<T extends AnyFunction> {
  /**
   * Execute the worker function with the given arguments.
   *
   * @param args - Arguments to pass to the worker function
   * @returns Promise resolving to the worker's return value
   *
   * @example
   * ```typescript
   * // workers/add.ts
   * export default function(a: number, b: number): number {
   *   return a + b;
   * }
   *
   * // main.ts
   * const sum = await beeThreads.worker<typeof add>('./workers/add')(10, 20); // 30
   * ```
   */
  (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>>;

  /**
   * Process an array in parallel across multiple workers (turbo mode).
   *
   * The worker function must accept an array and return an array.
   * The input array is split into chunks, each chunk processed by a
   * separate worker, then results are merged maintaining original order.
   *
   * @typeParam TItem - Type of array elements
   * @param data - Array to process in parallel
   * @param options - Turbo mode options (workers count)
   * @returns Promise resolving to the processed array
   *
   * @remarks
   * **How it works:**
   * 1. Array split into N chunks (one per worker)
   * 2. Each worker processes its chunk in parallel
   * 3. Results merged in original order
   *
   * **Performance:**
   * - Best for CPU-bound operations with external dependencies
   * - Overhead: ~1-5ms per worker for chunk transfer
   * - Recommended minimum: 100+ items per worker
   *
   * @example
   * ```typescript
   * // workers/transform-chunk.ts
   * import { heavyTransform } from '../utils';
   * export default async function(items: Item[]): Promise<TransformedItem[]> {
   *   return items.map(item => heavyTransform(item));
   * }
   *
   * // main.ts
   * const results = await beeThreads
   *   .worker('./workers/transform-chunk')
   *   .turbo(items, { workers: 8 });
   * ```
   */
  turbo<TItem>(
    data: TItem[],
    options?: TurboWorkerOptions
  ): Promise<TItem[]>;
}

// ============================================================================
// WORKER POOL (per file)
// ============================================================================

/** Worker pools indexed by absolute file path */
const workerPools = new Map<string, FileWorkerEntry[]>();

/** Default max workers = CPU cores - 1 (leave one for main thread) */
const cpuCount = os.cpus().length;
const DEFAULT_MAX_WORKERS = cpuCount > 2 ? cpuCount - 1 : 2;

/**
 * Extracts the caller's file path from the error stack.
 * This allows relative paths to be resolved from the caller's directory,
 * not from process.cwd().
 * 
 * @internal
 */
function getCallerDirectory(): string | null {
  const origPrepare = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => stack;
  
  const err = new Error();
  const stack = err.stack as unknown as NodeJS.CallSite[];
  
  Error.prepareStackTrace = origPrepare;
  
  if (!stack || stack.length < 4) return null;
  
  // Stack: [getCallerDirectory, resolvePath, createFileWorker, <caller>]
  // We want the caller (index 3 or higher)
  for (let i = 3; i < stack.length; i++) {
    const fileName = stack[i]?.getFileName?.();
    if (fileName && !fileName.includes('file-worker') && !fileName.includes('index')) {
      // Handle file:// URLs (ESM)
      if (fileName.startsWith('file://')) {
        try {
          const { fileURLToPath } = require('url');
          return path.dirname(fileURLToPath(fileName));
        } catch {
          return path.dirname(fileName.replace('file://', ''));
        }
      }
      return path.dirname(fileName);
    }
  }
  
  return null;
}

/**
 * Resolves a file path to an absolute path.
 * 
 * For relative paths (starting with './' or '../'), resolves from the 
 * caller's directory instead of process.cwd(). This makes the API more
 * intuitive - you can just use './workers/my-worker.js' and it works!
 * 
 * @internal
 */
function resolvePath(filePath: string): string {
  // Already absolute - use as-is
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  
  // Relative path starting with ./ or ../ - resolve from caller's directory
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    const callerDir = getCallerDirectory();
    if (callerDir) {
      return path.resolve(callerDir, filePath);
    }
  }
  
  // Fallback to process.cwd() for bare paths like 'workers/task.js'
  return path.resolve(filePath);
}

/**
 * Creates a new worker thread for the given file path.
 *
 * The worker code:
 * 1. Requires the user's worker file
 * 2. Extracts the default export (or module.exports)
 * 3. Listens for messages and executes the handler
 * 4. Supports both normal calls and turbo chunk processing
 *
 * @internal
 */
function createWorker(absPath: string): Worker {
  // Escape backslashes for Windows paths
  const escapedPath = absPath.replace(/\\/g, '\\\\');
  
  // Simple worker code - uses structuredClone (V8 native, fast for TypedArrays)
  const workerCode = `
    const { parentPort } = require('worker_threads');
    const fn = require('${escapedPath}');
    const handler = fn.default || fn;
    
    parentPort.on('message', async (msg) => {
      const id = msg.id;
      const args = msg.args;
      const isTurboChunk = msg.isTurboChunk;
      
      try {
        let result;
        if (isTurboChunk) {
          // Turbo mode: first arg is the chunk array
          result = await handler(args[0]);
        } else {
          // Normal mode: spread args
          result = await handler(...args);
        }
        parentPort.postMessage({ id: id, success: true, result: result });
      } catch (error) {
        parentPort.postMessage({ 
          id: id, 
          success: false, 
          error: { 
            message: error.message, 
            name: error.name,
            stack: error.stack 
          }
        });
      }
    });
  `;

  return new Worker(workerCode, { eval: true });
}

/**
 * Gets or creates workers for turbo mode processing.
 * Ensures the pool has at least `count` workers available.
 * @internal
 */
function getWorkersForTurbo(filePath: string, count: number): FileWorkerEntry[] {
  const absPath = resolvePath(filePath);

  let pool = workerPools.get(absPath);
  if (!pool) {
    pool = [];
    workerPools.set(absPath, pool);
  }

  // V8: Raw for loop to create missing workers
  const currentLen = pool.length;
  for (let i = currentLen; i < count; i++) {
    const worker = createWorker(absPath);
    // V8: Monomorphic entry shape - all properties initialized
    const entry: FileWorkerEntry = {
      worker: worker,
      busy: false,
      path: absPath
    };
    pool.push(entry);
  }

  // Return first `count` workers
  // V8: slice is efficient here as it's O(count)
  return pool.slice(0, count);
}

/**
 * Gets or creates a single worker from the pool.
 * Returns an idle worker if available, otherwise creates a new one.
 * @internal
 */
function getWorker(filePath: string): FileWorkerEntry {
  const absPath = resolvePath(filePath);

  let pool = workerPools.get(absPath);
  if (!pool) {
    pool = [];
    workerPools.set(absPath, pool);
  }

  // V8: Raw for loop instead of .find()
  const poolLen = pool.length;
  for (let i = 0; i < poolLen; i++) {
    const entry = pool[i];
    if (!entry.busy) {
      entry.busy = true;
      return entry;
    }
  }

  // Create new worker if under default limit
  if (poolLen < DEFAULT_MAX_WORKERS) {
    const worker = createWorker(absPath);
    // V8: Monomorphic entry shape
    const entry: FileWorkerEntry = {
      worker: worker,
      busy: true,
      path: absPath
    };
    pool.push(entry);
    return entry;
  }

  // All workers busy, use first (will queue internally)
  const first = pool[0];
  first.busy = true;
  return first;
}

/**
 * Releases a worker back to the pool for reuse.
 * @internal
 */
function releaseWorker(entry: FileWorkerEntry): void {
  entry.busy = false;
}

// ============================================================================
// EXECUTION
// ============================================================================

/** Auto-incrementing message ID for correlating requests/responses */
let messageId = 0;

/**
 * Worker message response interface.
 * V8: Stable shape for type checking.
 */
interface WorkerResponse {
  id: number;
  success: boolean;
  result?: unknown;
  error?: {
    message: string;
    name: string;
    stack?: string;
  };
}

/**
 * Executes a single call on a worker and returns the result.
 * Handles message correlation and error propagation.
 * @internal
 */
function executeOnWorker<T>(
  entry: FileWorkerEntry,
  args: unknown[],
  isTurboChunk: boolean = false
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const worker = entry.worker;

    const handler = (msg: WorkerResponse): void => {
      // Only process messages for this request
      if (msg.id !== id) return;

      worker.off('message', handler);
      releaseWorker(entry);

      if (msg.success) {
        resolve(msg.result as T);
      } else {
        const msgError = msg.error;
        const error = new Error(msgError?.message || 'Worker error');
        error.name = msgError?.name || 'WorkerError';
        if (msgError?.stack) error.stack = msgError.stack;
        reject(error);
      }
    };

    worker.on('message', handler);
    
    // V8: Monomorphic message shape
    worker.postMessage({ id: id, args: args, isTurboChunk: isTurboChunk });
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Creates a type-safe file worker executor.
 *
 * Use this when your worker needs access to `require()`, database
 * connections, or external modules that aren't available in inline workers.
 *
 * @typeParam T - The worker's default export function type (for type inference)
 * @param filePath - Path to the worker file (relative or absolute)
 * @returns A callable executor with `.turbo()` method
 *
 * @remarks
 * **Worker File Requirements:**
 * - Must export a default function (ESM) or `module.exports` (CJS)
 * - Function can be sync or async
 * - For turbo mode: must accept array and return array
 *
 * **Type Safety:**
 * ```typescript
 * // Get full type inference by importing the worker type
 * import type myWorker from './workers/my-worker';
 * const result = await beeThreads.worker<typeof myWorker>('./workers/my-worker')(args);
 * ```
 *
 * **Pool Behavior:**
 * - Workers are pooled per file path
 * - Max pool size: `os.cpus().length - 1`
 * - Workers are reused across calls
 * - Call `beeThreads.shutdown()` to terminate all workers
 *
 * @example Single Execution
 * ```typescript
 * // workers/find-user.ts
 * import { db } from '../database';
 * export default async function(id: number): Promise<User | null> {
 *   return db.query('SELECT * FROM users WHERE id = ?', [id]);
 * }
 *
 * // main.ts
 * import type findUser from './workers/find-user';
 * const user = await beeThreads.worker<typeof findUser>('./workers/find-user')(123);
 * ```
 *
 * @example Turbo Mode
 * ```typescript
 * // workers/process-batch.ts
 * import { redis } from '../cache';
 * export default async function(ids: number[]): Promise<CachedData[]> {
 *   return Promise.all(ids.map(id => redis.get(`data:${id}`)));
 * }
 *
 * // main.ts - Process 10,000 IDs across 8 workers
 * const results = await beeThreads
 *   .worker('./workers/process-batch')
 *   .turbo(ids, { workers: 8 });
 * ```
 */
export function createFileWorker<T extends AnyFunction>(
  filePath: string
): FileWorkerExecutor<T> {
  const absPath = resolvePath(filePath);

  // Create callable function
  const executor = (async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    const entry = getWorker(absPath);
    return executeOnWorker<Awaited<ReturnType<T>>>(entry, args, false);
  }) as FileWorkerExecutor<T>;

  // Add turbo method - simple structuredClone (V8 native, fast for TypedArrays)
  executor.turbo = async <TItem>(
    data: TItem[],
    options: TurboWorkerOptions = {}
  ): Promise<TItem[]> => {
    const numWorkers = options.workers !== undefined ? options.workers : DEFAULT_MAX_WORKERS;
    const dataLength = data.length;

    // Small array optimization: single worker for tiny arrays
    if (dataLength <= numWorkers) {
      const entry = getWorker(absPath);
      return executeOnWorker<TItem[]>(entry, [data], true);
    }

    // Get workers for parallel processing
    const workers = getWorkersForTurbo(absPath, numWorkers);
    const chunkSize = Math.ceil(dataLength / numWorkers);

    // V8: Pre-allocated promises array
    const promises: Promise<TItem[]>[] = new Array(numWorkers);
    let promiseCount = 0;

    // V8: Raw for loop - chunk and dispatch
    for (let i = 0; i < numWorkers; i++) {
      const start = i * chunkSize;
      if (start >= dataLength) break;

      const end = start + chunkSize;
      const actualEnd = end < dataLength ? end : dataLength;
      const chunk = data.slice(start, actualEnd);
      const entry = workers[i];
      entry.busy = true;

      // Uses structuredClone (V8 native) - fast for TypedArrays
      promises[promiseCount] = executeOnWorker<TItem[]>(entry, [chunk], true);
      promiseCount++;
    }

    // Wait for all workers
    const results = promiseCount === numWorkers 
      ? await Promise.all(promises)
      : await Promise.all(promises.slice(0, promiseCount));

    // V8: Pre-calculate total size for merged array
    let totalSize = 0;
    for (let i = 0; i < promiseCount; i++) {
      totalSize += results[i].length;
    }

    // V8: Pre-allocated merged array with raw for loops
    const merged: TItem[] = new Array(totalSize);
    let offset = 0;
    for (let i = 0; i < promiseCount; i++) {
      const chunk = results[i];
      const chunkLen = chunk.length;
      for (let j = 0; j < chunkLen; j++) {
        merged[offset++] = chunk[j];
      }
    }

    return merged;
  };

  return executor;
}

/**
 * Terminates all file workers and clears the worker pools.
 *
 * Called automatically by `beeThreads.shutdown()`.
 *
 * @returns Promise that resolves when all workers are terminated
 *
 * @example
 * ```typescript
 * // Graceful shutdown
 * await beeThreads.shutdown(); // Also terminates file workers
 *
 * // Or directly
 * import { terminateFileWorkers } from 'bee-threads';
 * await terminateFileWorkers();
 * ```
 */
export async function terminateFileWorkers(): Promise<void> {
  // V8: Pre-count total workers
  let totalWorkers = 0;
  for (const pool of workerPools.values()) {
    totalWorkers += pool.length;
  }

  // V8: Pre-allocated promises array
  const promises: Promise<number>[] = new Array(totalWorkers);
  let idx = 0;

  for (const pool of workerPools.values()) {
    const poolLen = pool.length;
    for (let i = 0; i < poolLen; i++) {
      promises[idx++] = pool[i].worker.terminate();
    }
  }

  await Promise.all(promises);
  workerPools.clear();
}
