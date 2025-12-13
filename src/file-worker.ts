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
import { 
  autoPack, 
  canAutoPack, 
  makeTransferable, 
  getTransferablesFromPacked,
  packNumberArray,
  getNumberArrayTransferables,
  unpackNumberArray,
  packStringArray,
  getStringArrayTransferables,
  unpackStringArray,
  AUTOPACK_ARRAY_THRESHOLD,
  GENERIC_UNPACK_CODE,
  GENERIC_PACK_CODE,
  type TransferablePackedData,
  type PackedNumberArray,
  type PackedStringArray
} from './autopack';

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
  
  const workerCode = `
    const { parentPort } = require('worker_threads');
    const fn = require('${escapedPath}');
    const handler = fn.default || fn;
    
    // ========================================================================
    // UNPACK FUNCTIONS - V8 OPTIMIZED
    // ========================================================================
    
    // Unpack number array from Float64Array
    function unpackNumbers(packed) {
      const len = packed.length;
      if (len === 0) return [];
      const data = packed.data;
      const result = new Array(len);
      const blockEnd = len & ~3;
      let i = 0;
      for (; i < blockEnd; i += 4) {
        result[i] = data[i];
        result[i + 1] = data[i + 1];
        result[i + 2] = data[i + 2];
        result[i + 3] = data[i + 3];
      }
      for (; i < len; i++) result[i] = data[i];
      return result;
    }
    
    // Cached decoder for string unpacking
    const stringDecoder = new TextDecoder();
    
    // Unpack string array from UTF-8 bytes
    function unpackStrings(packed) {
      const len = packed.length;
      if (len === 0) return [];
      const data = packed.data;
      const offsets = packed.offsets;
      const lengths = packed.lengths;
      const result = new Array(len);
      const blockEnd = len & ~3;
      let i = 0;
      for (; i < blockEnd; i += 4) {
        const o0 = offsets[i], o1 = offsets[i+1], o2 = offsets[i+2], o3 = offsets[i+3];
        const l0 = lengths[i], l1 = lengths[i+1], l2 = lengths[i+2], l3 = lengths[i+3];
        result[i] = stringDecoder.decode(data.subarray(o0, o0 + l0));
        result[i+1] = stringDecoder.decode(data.subarray(o1, o1 + l1));
        result[i+2] = stringDecoder.decode(data.subarray(o2, o2 + l2));
        result[i+3] = stringDecoder.decode(data.subarray(o3, o3 + l3));
      }
      for (; i < len; i++) {
        const o = offsets[i];
        result[i] = stringDecoder.decode(data.subarray(o, o + lengths[i]));
      }
      return result;
    }
    
    // AutoPack support for object arrays
    ${GENERIC_UNPACK_CODE}
    ${GENERIC_PACK_CODE}
    
    // ========================================================================
    // PACK FUNCTIONS - V8 OPTIMIZED (for results)
    // ========================================================================
    
    // Pack number array into Float64Array
    function packNumbers(arr) {
      const len = arr.length;
      const data = new Float64Array(len);
      const blockEnd = len & ~3;
      let i = 0;
      for (; i < blockEnd; i += 4) {
        data[i] = arr[i];
        data[i + 1] = arr[i + 1];
        data[i + 2] = arr[i + 2];
        data[i + 3] = arr[i + 3];
      }
      for (; i < len; i++) data[i] = arr[i];
      return { length: len, data: data };
    }
    
    // Cached encoder for string packing
    const stringEncoder = new TextEncoder();
    
    // Pack string array into UTF-8 bytes
    function packStrings(arr) {
      const len = arr.length;
      if (len === 0) return { length: 0, data: new Uint8Array(0), offsets: new Uint32Array(0), lengths: new Uint32Array(0) };
      
      // Calculate total bytes needed
      let totalBytes = 0;
      const encodedStrings = new Array(len);
      for (let i = 0; i < len; i++) {
        const encoded = stringEncoder.encode(arr[i]);
        encodedStrings[i] = encoded;
        totalBytes += encoded.length;
      }
      
      const data = new Uint8Array(totalBytes);
      const offsets = new Uint32Array(len);
      const lengths = new Uint32Array(len);
      let offset = 0;
      
      for (let i = 0; i < len; i++) {
        const encoded = encodedStrings[i];
        data.set(encoded, offset);
        offsets[i] = offset;
        lengths[i] = encoded.length;
        offset += encoded.length;
      }
      
      return { length: len, data: data, offsets: offsets, lengths: lengths };
    }
    
    parentPort.on('message', async (msg) => {
      const id = msg.id;
      const args = msg.args;
      const isTurboChunk = msg.isTurboChunk;
      const isPacked = msg.isPacked;
      const packType = msg.packType || 'none';
      
      try {
        let result;
        if (isTurboChunk) {
          // Unpack based on packType
          let chunk;
          if (!isPacked || packType === 'none') {
            chunk = args[0];
          } else if (packType === 'number') {
            chunk = unpackNumbers(args[0]);
          } else if (packType === 'string') {
            chunk = unpackStrings(args[0]);
          } else if (packType === 'object') {
            chunk = genericUnpack(args[0]);
          } else {
            chunk = args[0];
          }
          
          result = await handler(chunk);
          
          // Pack result back based on result type (match input packType when possible)
          if (isPacked && Array.isArray(result) && result.length > 0) {
            const sample = result[0];
            const sampleType = typeof sample;
            
            if (packType === 'number' && sampleType === 'number') {
              const packed = packNumbers(result);
              parentPort.postMessage(
                { id: id, success: true, result: packed, isPacked: true },
                [packed.data.buffer]
              );
              return;
            } else if (packType === 'string' && sampleType === 'string') {
              const packed = packStrings(result);
              parentPort.postMessage(
                { id: id, success: true, result: packed, isPacked: true },
                [packed.data.buffer, packed.offsets.buffer, packed.lengths.buffer]
              );
              return;
            } else if (packType === 'object' && sampleType === 'object' && sample !== null) {
              const packed = genericPack(result);
              parentPort.postMessage({ id: id, success: true, result: packed, isPacked: true });
              return;
            }
          }
        } else {
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
 * Generic unpack for results from worker (main thread side).
 * This is a simplified version that works with TransferablePackedData.
 * @internal
 */
function genericUnpackResult<T>(packed: TransferablePackedData): T[] {
  const { schema, length, numbers, strings, stringOffsets, stringLengths, booleans } = packed;
  const { numericFields, stringFields, booleanFields } = schema;
  
  if (length === 0) return [];
  
  const result: T[] = new Array(length);
  const decoder = new TextDecoder();
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  for (let i = 0; i < length; i++) {
    const obj: Record<string, unknown> = {};
    
    // Numbers (column-oriented)
    for (let f = 0; f < numCount; f++) {
      obj[numericFields[f].name] = numbers[f * length + i];
    }
    
    // Strings
    for (let f = 0; f < strCount; f++) {
      const idx = f * length + i;
      const offset = stringOffsets[idx];
      const len = stringLengths[idx];
      obj[stringFields[f].name] = decoder.decode(strings.subarray(offset, offset + len));
    }
    
    // Booleans (bit-packed)
    for (let f = 0; f < boolCount; f++) {
      const bitIndex = f * length + i;
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;
      obj[booleanFields[f].name] = (booleans[byteIndex] & (1 << bitOffset)) !== 0;
    }
    
    result[i] = obj as T;
  }
  
  return result;
}

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
 * Worker response with optional packed flag
 */
interface WorkerResponseWithPack extends WorkerResponse {
  isPacked?: boolean;
}

/** Pack type for serialization strategy */
type PackType = 'number' | 'string' | 'object' | 'none';

/**
 * Executes a single call on a worker and returns the result.
 * Handles message correlation and error propagation.
 * @internal
 */
function executeOnWorker<T>(
  entry: FileWorkerEntry,
  args: unknown[],
  isTurboChunk: boolean = false,
  isPacked: boolean = false,
  transferables?: ArrayBuffer[]
): Promise<{ result: T; isPacked: boolean }> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const worker = entry.worker;

    const handler = (msg: WorkerResponseWithPack): void => {
      // Only process messages for this request
      if (msg.id !== id) return;

      worker.off('message', handler);
      releaseWorker(entry);

      if (msg.success) {
        resolve({ result: msg.result as T, isPacked: msg.isPacked || false });
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
    const message = { id: id, args: args, isTurboChunk: isTurboChunk, isPacked: isPacked };
    
    if (transferables && transferables.length > 0) {
      worker.postMessage(message, transferables);
    } else {
      worker.postMessage(message);
    }
  });
}

/**
 * Executes a single call on a worker with pack type tracking.
 * Used by turbo mode to properly unpack results based on data type.
 * @internal
 */
function executeOnWorkerWithPackType<T>(
  entry: FileWorkerEntry,
  args: unknown[],
  isTurboChunk: boolean = false,
  isPacked: boolean = false,
  transferables?: ArrayBuffer[],
  packType: PackType = 'none'
): Promise<{ result: T; isPacked: boolean; packType: PackType }> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const worker = entry.worker;

    const handler = (msg: WorkerResponseWithPack): void => {
      // Only process messages for this request
      if (msg.id !== id) return;

      worker.off('message', handler);
      releaseWorker(entry);

      if (msg.success) {
        resolve({ 
          result: msg.result as T, 
          isPacked: msg.isPacked || false,
          packType: packType
        });
      } else {
        const msgError = msg.error;
        const error = new Error(msgError?.message || 'Worker error');
        error.name = msgError?.name || 'WorkerError';
        if (msgError?.stack) error.stack = msgError.stack;
        reject(error);
      }
    };

    worker.on('message', handler);
    
    // V8: Monomorphic message shape - include packType for worker to know how to unpack
    const message = { 
      id: id, 
      args: args, 
      isTurboChunk: isTurboChunk, 
      isPacked: isPacked,
      packType: packType
    };
    
    if (transferables && transferables.length > 0) {
      worker.postMessage(message, transferables);
    } else {
      worker.postMessage(message);
    }
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
    const { result } = await executeOnWorker<Awaited<ReturnType<T>>>(entry, args, false);
    return result;
  }) as FileWorkerExecutor<T>;

  // Add turbo method
  executor.turbo = async <TItem>(
    data: TItem[],
    options: TurboWorkerOptions = {}
  ): Promise<TItem[]> => {
    const numWorkers = options.workers !== undefined ? options.workers : DEFAULT_MAX_WORKERS;
    const dataLength = data.length;
    
    // Determine pack type based on data (same logic as turbo.ts)
    // 'number' | 'string' | 'object' | 'none'
    type PackType = 'number' | 'string' | 'object' | 'none';
    let packType: PackType = 'none';
    
    if (dataLength >= AUTOPACK_ARRAY_THRESHOLD) {
      const sample = data[0];
      const sampleType = typeof sample;
      
      if (sampleType === 'number') {
        packType = 'number';
      } else if (sampleType === 'string') {
        packType = 'string';
      } else if (canAutoPack(data as unknown[])) {
        packType = 'object';
      }
    }

    // Small array optimization: single worker for tiny arrays
    if (dataLength <= numWorkers) {
      const entry = getWorker(absPath);
      const { result } = await executeOnWorker<TItem[]>(entry, [data], true, false);
      return result;
    }

    // Get workers for parallel processing
    const workers = getWorkersForTurbo(absPath, numWorkers);
    const chunkSize = Math.ceil(dataLength / numWorkers);

    // V8: Pre-allocated promises array
    const promises: Promise<{ result: TItem[] | TransferablePackedData | PackedNumberArray | PackedStringArray; isPacked: boolean; packType: PackType }>[] = new Array(numWorkers);
    let promiseCount = 0;

    // V8: Raw for loop
    for (let i = 0; i < numWorkers; i++) {
      const start = i * chunkSize;
      if (start >= dataLength) break;

      const end = start + chunkSize;
      const actualEnd = end < dataLength ? end : dataLength;
      const chunk = data.slice(start, actualEnd);
      const entry = workers[i];
      entry.busy = true;

      if (packType === 'number') {
        // Number array → Float64Array + transferables
        const packed = packNumberArray(chunk as number[]);
        const buffers = getNumberArrayTransferables(packed);
        promises[promiseCount] = executeOnWorkerWithPackType<TItem[] | PackedNumberArray>(
          entry, [packed], true, true, buffers, 'number'
        );
      } else if (packType === 'string') {
        // String array → UTF-8 bytes + transferables
        const packed = packStringArray(chunk as string[]);
        const buffers = getStringArrayTransferables(packed);
        promises[promiseCount] = executeOnWorkerWithPackType<TItem[] | PackedStringArray>(
          entry, [packed], true, true, buffers, 'string'
        );
      } else if (packType === 'object') {
        // Object array → AutoPack columnar
        const packed = autoPack(chunk as Record<string, unknown>[]);
        const transferable = makeTransferable(packed);
        const buffers = getTransferablesFromPacked(transferable);
        promises[promiseCount] = executeOnWorkerWithPackType<TItem[] | TransferablePackedData>(
          entry, [transferable], true, true, buffers, 'object'
        );
      } else {
        // Fallback to structuredClone
        promises[promiseCount] = executeOnWorkerWithPackType<TItem[]>(entry, [chunk], true, false, undefined, 'none');
      }
      promiseCount++;
    }

    // Wait for all workers (avoid slice when array is full)
    const rawResults = promiseCount === numWorkers 
      ? await Promise.all(promises)
      : await Promise.all(promises.slice(0, promiseCount));

    // Process results (unpack based on packType)
    const results: TItem[][] = new Array(promiseCount);
    for (let i = 0; i < promiseCount; i++) {
      const { result, isPacked, packType: resultPackType } = rawResults[i];
      
      if (!isPacked) {
        results[i] = result as TItem[];
      } else if (resultPackType === 'number') {
        // Unpack Float64Array → number[]
        results[i] = unpackNumberArray(result as PackedNumberArray) as TItem[];
      } else if (resultPackType === 'string') {
        // Unpack UTF-8 → string[]
        results[i] = unpackStringArray(result as PackedStringArray) as TItem[];
      } else if (resultPackType === 'object' && result && typeof result === 'object' && 'schema' in result) {
        // Unpack AutoPack columnar → object[]
        results[i] = genericUnpackResult(result as TransferablePackedData) as TItem[];
      } else {
        results[i] = result as TItem[];
      }
    }

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
