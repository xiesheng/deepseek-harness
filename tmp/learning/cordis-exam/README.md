# Cordis exam

A self-checking Cordis app: each check exercises one framework rule and prints PASS or FAIL. The process exits 1 if any check fails.

## Run

```sh
cd tmp/learning/cordis-exam
node --import tsx ../../../vendor/cordis/bin.js
```

Typecheck:

```sh
../../../node_modules/.bin/tsc -p tsconfig.json
```

`tsconfig.json` lists the vendor packages as project references, so `tsc` reads their built `lib/types` declarations instead of compiling vendor source under the root's stricter flags. Run `pnpm run build:artifacts` first if those declarations are missing or stale. Check helpers come from `../shared/exam-kit.ts`.

## Files

| File         | Role                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------- |
| `cordis.yml` | Composition: mounts `exam.ts` and `counter.ts` (with `step: 2`)                              |
| `counter.ts` | A `Service` claiming `ctx.counter`, a `Config` schema, and two events (`emit` + `waterfall`) |
| `exam.ts`    | Injects `counter`, mounts child plugins from code, and runs the checks                       |

## What each check covers

1. **Service + config**: the `cordis.yml` value reaches the service through its schema.
2. **Config validation**: omitted fields get defaults; a wrong type moves the fiber to `FAILED`.
3. **`inject`**: a consumer waits in `PENDING`, loads when the provider appears, unloads when it leaves, and reloads against a new provider.
4. **Effects**: disposers run in reverse registration order; `ctx.on` listeners leave with their plugin.
5. **`emit`**: returns before async listeners finish.
6. **`parallel` / `serial` / `bail`**: concurrent and awaited; ordered and stops at the first bail value; synchronous bail.
7. **`waterfall`**: the outer listener wraps `next()`; an inner one vetoes the default by not calling `next()`.

## Exercises

- Swap the two entries in `cordis.yml`. The result does not change: `inject`, not file order, decides load order.
- Delete the `counter` entry. Nothing prints, because `exam` stays `PENDING` forever (tutorial chapter 6 shows how to diagnose that).
- Set `step: 0`. The counter fiber fails schema validation (`min(1)`) and goes `FAILED`, so `exam` stays `PENDING` and the run is silent with exit 0. A config error under the Loader goes to the Cordis logger, not the console; list fiber states with the `diagnose.ts` plugin from tutorial chapter 6 to see it.
- In check 7, make the outer listener return `'x'` without calling `next()`. Every name becomes `x`: this is the bug the repo's "waterfall listeners MUST call `next()`" rule prevents.
- In check 4, make both disposers async with different delays, and observe that they run concurrently.
