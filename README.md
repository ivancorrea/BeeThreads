# 🐝 bee-threads

[![npm](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dw/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/bee-threads)

<div align="center">

### ⚡ THE BEST THREADS DX IN NODE.JS ⚡

**Parallel programming made simple. Zero boilerplate. Zero dependencies.**

</div>

---

## Install

```bash
npm install bee-threads
```

```ts
import { bee, beeThreads } from 'bee-threads'

const result = await bee((x: number) => x * 2)(21) // 42
```

---

## API Overview

### `bee()` - Simple Curried API

```ts
// No arguments
await bee(() => 42)()

// With arguments
await bee((a: number, b: number) => a + b)(10, 20) // 30

// With closures
const TAX = 0.2
await bee((price: number) => price * (1 + TAX))(100, { beeClosures: { TAX } }) // 120
```

### `beeThreads.run()` - Full Fluent API

```ts
await beeThreads
	.run((a: number, b: number) => a + b)
	.usingParams(10, 20)
	.setContext({ multiplier: 2 })
	.priority('high')
	.execute() // 30
```

### `beeThreads.turbo()` - Parallel Arrays

```ts
const numbers = [1, 2, 3, 4, 5, 6, 7, 8]

const squares = await beeThreads.turbo(numbers).map((x: number) => x * x)
const evens = await beeThreads.turbo(numbers).filter((x: number) => x % 2 === 0)
const sum = await beeThreads.turbo(numbers).reduce((a: number, b: number) => a + b, 0)
```

### `beeThreads.worker()` - File Workers

```ts
// workers/find-user.ts
import { db } from '../database'
export default async function (id: number): Promise<User> {
	return db.query('SELECT * FROM users WHERE id = ?', [id])
}

// main.ts
import type findUser from './workers/find-user'
const user = await beeThreads.worker<typeof findUser>('./workers/find-user')(123)
```

### `beeThreads.stream()` - Generators

```ts
const stream = beeThreads
	.stream(function* (n: number) {
		for (let i = 1; i <= n; i++) yield i * i
	})
	.usingParams(5)
	.execute()

for await (const value of stream) console.log(value) // 1, 4, 9, 16, 25
```

---

## File Workers

When you need **`require()`**, **database connections**, or **external modules** in workers.

### Single Execution

```ts
// workers/hash-password.ts
import bcrypt from 'bcrypt'
export default async function (password: string): Promise<string> {
	return bcrypt.hash(password, 12)
}

// main.ts
import type hashPassword from './workers/hash-password'
const hash = await beeThreads.worker<typeof hashPassword>('./workers/hash-password')('secret123')
```

### Turbo Mode (Parallel Arrays)

```ts
// workers/process-users.ts
import { db } from '../database'
import { calculateScore } from '../utils'

export default async function (users: User[]): Promise<ProcessedUser[]> {
	return Promise.all(
		users.map(async user => ({
			...user,
			score: await calculateScore(user),
			data: await db.fetch(user.id),
		}))
	)
}

// main.ts - 10,000 users across 8 workers
const results = await beeThreads.worker('./workers/process-users').turbo(users, { workers: 8 })
```

### When to Use

| Need                   | Use                |
| ---------------------- | ------------------ |
| Pure computation       | `bee()` / `turbo()` |
| Database/Redis         | `worker()`         |
| External modules       | `worker()`         |
| Large array + DB       | `worker().turbo()` |

---

## Fluent API Methods

### `.setContext()` - Inject Variables

```ts
const TAX = 0.2
await beeThreads
	.run((price: number) => price * (1 + TAX))
	.usingParams(100)
	.setContext({ TAX })
	.execute() // 120
```

### `.signal()` - Cancellation

```ts
const controller = new AbortController()

const promise = beeThreads
	.run(() => heavyComputation())
	.signal(controller.signal)
	.execute()

controller.abort() // Cancel anytime
```

### `.retry()` - Auto-retry

```ts
await beeThreads
	.run(() => fetchFromFlakyAPI())
	.retry({ maxAttempts: 5, baseDelay: 100, backoffFactor: 2 })
	.execute()
```

### `.priority()` - Queue Priority

```ts
await beeThreads.run(() => processPayment()).priority('high').execute()
await beeThreads.run(() => generateReport()).priority('low').execute()
```

### `.transfer()` - Zero-copy

```ts
const buffer = new Uint8Array(10_000_000)
await beeThreads
	.run((buf: Uint8Array) => processImage(buf))
	.usingParams(buffer)
	.transfer([buffer.buffer])
	.execute()
```

### `.reconstructBuffers()` - Buffer Reconstruction

```ts
const buffer = await beeThreads
	.run((img: Buffer) => require('sharp')(img).resize(100).toBuffer())
	.usingParams(imageBuffer)
	.reconstructBuffers()
	.execute()

Buffer.isBuffer(buffer) // true
```

---

## Configuration

```ts
beeThreads.configure({
	poolSize: 8,
	minThreads: 2,
	maxQueueSize: 1000,
	workerIdleTimeout: 30000,
	debugMode: true,
	logger: console,
})

await beeThreads.warmup(4)
await beeThreads.shutdown()
```

---

## Error Handling

```ts
import { TimeoutError, AbortError, QueueFullError, WorkerError } from 'bee-threads'

try {
	await beeThreads.run(fn).execute()
} catch (err) {
	if (err instanceof TimeoutError) { /* timeout */ }
	if (err instanceof AbortError) { /* cancelled */ }
	if (err instanceof WorkerError) { /* worker error */ }
}

// Safe mode - never throws
const result = await beeThreads.run(fn).safe().execute()
if (result.status === 'fulfilled') console.log(result.value)
```

---

## Benchmarks

```bash
bun benchmarks.js   # Bun
node benchmarks.js  # Node
```

### Results (1M items, 12 CPUs)

| Runtime | Mode       | Time    | vs Main | Main Thread |
| ------- | ---------- | ------- | ------- | ----------- |
| Bun     | main       | 285ms   | 1.00x   | ❌ blocked   |
| Bun     | turbo(12)  | **156ms** | **1.83x** | ✅ free      |
| Node    | main       | 368ms   | 1.00x   | ❌ blocked   |
| Node    | turbo(12)  | 1017ms  | 0.36x   | ✅ free      |

**Key:** Bun + turbo = real speedup. Node + turbo = non-blocking I/O.

---

## Why bee-threads?

- **Zero dependencies** - Lightweight and secure
- **Inline functions** - No separate worker files
- **Worker pool** - Auto-managed, no cold-start
- **Function caching** - LRU cache, 300-500x faster
- **Worker affinity** - V8 JIT optimization
- **Request coalescing** - Deduplicates identical calls
- **Turbo mode** - Parallel array processing
- **File workers** - External files with `require()` + turbo
- **Full TypeScript** - Complete type inference

---

MIT © [Samuel Santos](https://github.com/samsantosb)
