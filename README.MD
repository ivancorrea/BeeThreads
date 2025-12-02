# 🐝 bee-threads

[![npm version](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dm/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![license](https://img.shields.io/npm/l/bee-threads.svg)](https://github.com/samsantosb/BeeThreads/blob/main/LICENSE)

> **Handle threading as promises.**

Run CPU-intensive JavaScript in worker threads. No separate files, just inline functions.

```js
const { beeThreads } = require('bee-threads');

const result = await beeThreads
  .run((a, b) => a + b)
  .usingParams(1, 2)
  .execute();
// → 3
```

## Install

```bash
npm install bee-threads
```

## Features

- **Inline functions** - No worker files needed
- **Closure injection** - `.setContext()` for external variables
- **Generators** - Stream with `stream()`
- **Cancellation** - AbortController support
- **Retry** - Exponential backoff
- **Priority** - `high`, `normal`, `low` queue ordering
- **TypeScript** - Full types included

## Examples

### External Variables

```js
const TAX = 0.2;

await beeThreads
  .run((price) => price * (1 + TAX))
  .usingParams(100)
  .setContext({ TAX })
  .execute();
// → 120
```

### Safe Mode

```js
const result = await beeThreads
  .safeRun(() => JSON.parse('invalid'))
  .execute();

if (result.status === 'rejected') {
  console.error(result.error);
}
```

### Timeout & Cancellation

```js
// Timeout
await beeThreads.withTimeout(5000)(task).execute();

// Cancel
const ctrl = new AbortController();
beeThreads.run(task).signal(ctrl.signal).execute();
ctrl.abort();
```

### Streaming

```js
const stream = beeThreads
  .stream(function* (n) {
    for (let i = 0; i < n; i++) yield i * i;
  })
  .usingParams(5)
  .execute();

for await (const v of stream) console.log(v);
```

### Priority

```js
// Critical - first in queue
beeThreads.run(task).priority('high').execute();

// Background - last in queue
beeThreads.run(task).priority('low').execute();
```

## API

| Method | Description |
|--------|-------------|
| `run(fn)` | Execute in worker |
| `safeRun(fn)` | Never throws |
| `withTimeout(ms)(fn)` | Time limit |
| `stream(fn)` | Generator streaming |

### Executor Chain

| Method | Description |
|--------|-------------|
| `.usingParams(...args)` | Arguments |
| `.setContext(obj)` | Inject variables |
| `.signal(signal)` | Cancellation |
| `.transfer(list)` | Zero-copy buffers |
| `.retry(opts)` | Auto-retry |
| `.priority(level)` | Queue priority |
| `.execute()` | Run |

### Pool

| Method | Description |
|--------|-------------|
| `configure(opts)` | Pool settings |
| `warmup(n)` | Pre-create workers |
| `shutdown()` | Terminate all |
| `getPoolStats()` | Metrics |

## Configuration

```js
beeThreads.configure({
  poolSize: 8,              // Max workers
  minThreads: 2,            // Always-ready workers
  maxQueueSize: 500,        // Queue limit
  workerIdleTimeout: 60000  // Idle cleanup (ms)
});

// Eliminate cold-start
await beeThreads.warmup(4);
```

## Errors

```js
const { TimeoutError, AbortError, QueueFullError, WorkerError } = require('bee-threads');
```

## License

MIT © [samsantosb](https://github.com/samsantosb)
