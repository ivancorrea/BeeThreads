# bee-threads - Internal Documentation

> Deep dive into architecture, decisions, and performance optimizations.

**Version:** 3.1.3 (TypeScript)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [File-by-File Breakdown](#file-by-file-breakdown)
3. [Core Decisions & Rationale](#core-decisions--rationale)
4. [Performance Architecture](#performance-architecture)
5. [Data Flow](#data-flow)
6. [Contributing Guide](#contributing-guide)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                             User Code                                   │
│   bee(fn)(args)  or  beeThreads.run(fn).usingParams(...).execute()      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         index.ts (Public API)                           │
│   • bee() - Simple curried API                                          │
│   • beeThreads.run/withTimeout/stream                                   │
│   • configure/shutdown/warmup/getPoolStats                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
           ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
           │ executor.ts  │ │stream-exec.ts│ │   pool.ts    │
           │ Fluent API   │ │Generator API │ │ Worker mgmt  │
           └──────────────┘ └──────────────┘ └──────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        execution.ts (Task Engine)                       │
│   • Worker communication                                                │
│   • Timeout/abort handling (race-condition safe)                        │
│   • Retry with exponential backoff                                      │
│   • Metrics tracking                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
              ┌─────────────────────┴──────────────────────┐
              ▼                                            ▼
┌─────────────────────────────┐             ┌─────────────────────────────┐
│         worker.ts           │             │     generator-worker.ts     │
│  • vm.Script compilation    │             │   • Streaming yields        │
│  • LRU function cache       │             │   • Return value capture    │
│  • Curried fn support       │             │   • Same optimizations      │
│  • Console forwarding       │             │                             │
│  • Error property preserve  │             │                             │
└─────────────────────────────┘             └─────────────────────────────┘
```

---

## File-by-File Breakdown

### `src/index.ts` - Public API

**Purpose:** Single entry point. Hides internal complexity.

**Why it exists:**

-  Users only need `require('bee-threads')` - no deep imports
-  Centralizes all public exports
-  Acts as facade pattern for internal modules

**Key exports:**
| Export | Description |
|--------|-------------|
| `bee(fn)` | Simple curried API for quick tasks |
| `beeThreads` | Full API with all features |
| `AbortError` | Thrown on cancellation |
| `TimeoutError` | Thrown on timeout |
| `QueueFullError` | Thrown when queue limit reached |
| `WorkerError` | Wraps errors from worker (preserves custom properties) |
| `noopLogger` | Silent logger for disabling logs |

---

### `src/types.ts` - TypeScript Type Definitions

**Purpose:** Centralized type definitions for the entire library.

**Key types:**

```typescript
// Message types (const enum for performance)
const enum MessageType {
	SUCCESS = 0,
	ERROR = 1,
	LOG = 2,
	YIELD = 3,
	RETURN = 4,
	END = 5,
}

// Pluggable logger interface
interface Logger {
	log: (...args: unknown[]) => void
	error: (...args: unknown[]) => void
	warn: (...args: unknown[]) => void
	// ...
}

// Pool configuration
interface PoolConfig {
	poolSize: number
	minThreads: number
	debugMode: boolean
	logger: Logger | null
	// ...
}
```

---

### `src/config.ts` - Centralized State

**Purpose:** Single source of truth for ALL mutable state.

**Why it exists:**

-  Debugging: One place to inspect entire library state
-  Testing: Easy to reset state between tests
-  Predictability: No scattered global variables

**State managed:**

```typescript
config // User settings (poolSize, timeout, retry, etc)
pools // Active workers { normal: Worker[], generator: Worker[] }
poolCounters // O(1) counters { busy: N, idle: N }
queues // Pending tasks by priority { high: [], normal: [], low: [] }
metrics // Execution statistics
```

**Why poolCounters exist:**
Instead of `pools.normal.filter(w => !w.busy).length` (O(n)), we maintain counters that update on every state change. This makes `getWorker()` checks O(1).

---

### `src/pool.ts` - Worker Pool Management

**Purpose:** Worker lifecycle management and intelligent task routing.

**Key responsibilities:**

1. Create workers with proper configuration
2. Select best worker for each task (load balancing + affinity)
3. Return workers to pool after use
4. Clean up idle workers
5. Handle overflow with temporary workers
6. Prevent memory leaks (setMaxListeners)

**Selection Strategy (in priority order):**

| Priority | Strategy              | Why                                                 |
| -------- | --------------------- | --------------------------------------------------- |
| 1        | **Affinity match**    | Worker already has function compiled & V8-optimized |
| 2        | **Least-used idle**   | Distributes load evenly across pool                 |
| 3        | **Create new pooled** | Pool not at capacity                                |
| 4        | **Create temporary**  | Overflow handling, terminated after use             |
| 5        | **Queue task**        | No resources available                              |

**Counter Management (v3.1.3 fix):**

```typescript
// New workers only increment busy (not decrement idle)
if (pool.length < config.poolSize) {
	counters.busy++ // Only this, no idle--
}

// Release only updates if worker was actually busy
if (entry.busy) {
	entry.busy = false
	counters.busy--
	counters.idle++
}
```

---

### `src/execution.ts` - Task Engine

**Purpose:** Core execution logic - worker communication and lifecycle.

**Race Condition Prevention (v3.1.2+ fix):**

```typescript
// Timeout handler - set settled BEFORE terminate
timer = setTimeout(() => {
  if (settled) return;
  settled = true;  // FIRST - prevents onExit race

  // Remove listeners before terminate
  worker.removeListener('exit', onExit);
  worker.terminate();

  // Release with terminated=true to remove from pool
  releaseWorker(entry, worker, ..., terminated: true);
  reject(new TimeoutError(timeout));
}, timeout);
```

**Custom Error Properties (v3.1.3):**

```typescript
// Worker errors preserve custom properties
const errorData = errMsg.error as Record<string, unknown>
for (const key of Object.keys(errorData)) {
	if (!['name', 'message', 'stack', '_sourceCode'].includes(key)) {
		;(err as Record<string, unknown>)[key] = errorData[key]
	}
}
```

---

### `src/executor.ts` - Fluent API Builder

**Purpose:** Creates the chainable API users interact with.

**Input Validation (v3.1.2+):**

```typescript
// Priority validation
priority(level: Priority): Executor<T> {
  const validPriorities = ['high', 'normal', 'low'];
  if (!validPriorities.includes(level)) {
    throw new TypeError(`Invalid priority "${level}". Use: ${validPriorities.join(', ')}`);
  }
  // ...
}

// Context validation (no functions/Symbols)
setContext(context: Record<string, unknown>): Executor<T> {
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === 'function') {
      throw new TypeError(`setContext() key "${key}" contains a function which cannot be serialized.`);
    }
  }
  // ...
}
```

---

### `src/cache.ts` - LRU Function Cache

**Purpose:** Avoid repeated function compilation.

**Why this matters (performance numbers):**

| Operation         | Time         |
| ----------------- | ------------ |
| vm.Script compile | ~0.3-0.5ms   |
| Cache lookup      | ~0.001ms     |
| **Speedup**       | **300-500x** |

---

### `src/worker.ts` - Worker Thread Script

**Purpose:** Code that runs inside worker threads.

**Error Serialization (v3.1.3):**

```typescript
function serializeError(e: unknown): SerializedError {
	// Copy custom properties (code, statusCode, etc.)
	for (const key of Object.keys(err)) {
		if (!['name', 'message', 'stack'].includes(key)) {
			const value = err[key]
			if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
				serialized[key] = value
			}
		}
	}

	// Debug mode uses _sourceCode (not code) to avoid conflicts
	if (DEBUG_MODE && currentFnSource) {
		serialized._sourceCode = currentFnSource
	}
}
```

---

### `src/errors.ts` - Typed Errors

**Purpose:** Custom error classes for specific failure modes.

| Error            | Code             | When                                                |
| ---------------- | ---------------- | --------------------------------------------------- |
| `AbortError`     | `ERR_ABORTED`    | Task cancelled via AbortSignal                      |
| `TimeoutError`   | `ERR_TIMEOUT`    | Exceeded time limit                                 |
| `QueueFullError` | `ERR_QUEUE_FULL` | Queue at maxQueueSize                               |
| `WorkerError`    | `ERR_WORKER`     | Error thrown inside worker (preserves custom props) |

---

## Performance Architecture

### Four-Layer Optimization

```
┌────────────────────────────────────────────────────────────────┐
│ Layer 1: vm.Script Compilation                                  │
│ • Compile once, run many times                                 │
│ • produceCachedData enables V8 code caching                    │
│ • 5-15x faster than eval() for context injection               │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 2: LRU Function Cache                                     │
│ • Avoid recompilation of repeated functions                    │
│ • Cache key includes context hash                              │
│ • Bounded size prevents memory bloat                           │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 3: Worker Affinity                                        │
│ • Route same function to same worker                           │
│ • Leverages V8 TurboFan optimization                          │
│ • Function hash → Worker mapping                               │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 4: V8 TurboFan JIT                                        │
│ • Hot functions get compiled to machine code                   │
│ • Affinity ensures functions stay "hot" in same worker         │
│ • Combined effect: near-native performance                     │
└────────────────────────────────────────────────────────────────┘
```

---

## Bug Fixes in v3.1.x

### v3.1.2 - Race Condition Fix

-  **Problem:** `worker.terminate()` fires `exit` event async, causing ~50% wrong error type
-  **Solution:** Set `settled = true` BEFORE calling `terminate()`

### v3.1.3 - Counter & Error Fixes

-  **Problem 1:** Busy counter going negative after timeouts
-  **Solution:** Only decrement if entry was actually busy; remove terminated workers from pool

-  **Problem 2:** Custom error properties lost (e.g., `error.code`)
-  **Solution:** Copy all serializable properties in `serializeError()`

-  **Problem 3:** Memory leak warning with many aborts
-  **Solution:** `worker.setMaxListeners(0)` on worker creation

---

## Contributing Guide

### Running Tests

```bash
npm test  # Builds and runs 198 tests
```

### Code Style

-  TypeScript strict mode
-  JSDoc on all public functions
-  "Why this exists" comments on modules
-  Descriptive names (no abbreviations)
-  Small, focused functions (< 50 lines preferred)
-  Centralized state in config.ts

---

## License

MIT
