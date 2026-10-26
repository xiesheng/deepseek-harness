# Tools exam

A self-checking walk through the `ctx.tools` pipeline from `@deepseek-ai/dsh-tools`: registration, execution, every policy hook, lifecycle, scheduling, and cancellation. Each check prints PASS or FAIL; the process exits 1 if any check fails. It runs keylessly: no model and no agent, so the exam hands `ctx.tools.execute()` the same raw call batches the agent loop passes after a model step.

## Run

```sh
cd tmp/learning/tools-exam
node --import tsx ../../../vendor/cordis/bin.js
```

Typecheck:

```sh
../../../node_modules/.bin/tsc -p tsconfig.json
```

`tsconfig.json` uses project references, so `tsc` reads the built `lib/types` declarations of Cordis and the dsh packages. Run `pnpm run build:artifacts` first if those declarations are missing or stale. Check helpers come from `../shared/exam-kit.ts`.

## Files

| File          | Role                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cordis.yml`  | Composition: `dsh-system-prompt` (required by `dsh-tools`), `dsh-tools`, the native executor that runs calls (required since v0.2.1-rc.2), the `add` tool plugin, and the exam |
| `add-tool.ts` | A function plugin that registers an `add` tool built with `defineTool`                                                                                                         |
| `exam.ts`     | Injects `tools` and `systemPrompt`, mounts fixture plugins from code, and runs the checks                                                                                      |

## The pipeline being examined

```
ctx.tools.execute({ calls, signal })   batch of raw model call blocks
  → selected executor (dsh-tool-executor-native): parses JSON arguments, schedules the batch
  per call:
  → args frozen, UNKNOWN_TOOL / ABORTED_BEFORE_DISPATCH checks
  → tools/pre-execute   waterfall: allow | deny | ask | cancel
  → guards              monotonic: may only deny
  → tools/execute       waterfall: around-dispatch wrappers
  → body                argument validation, execute(), output.schema validation, render()
  → tools/post-execute  waterfall: accept (replace content or value) | block
  → tools/result        emit: frozen final outcome, observers cannot change it
```

## What each check covers

1. **Registration**: `schemas()` exposes only `name`, `description`, and `parameters`; `required: true` compiles into the JSON Schema `required` list; schemas reach `ctx.systemPrompt.assemble()`.
2. **Success**: the result carries the canonical `value` and the `render()` content, and is frozen.
3. **`tools/result`**: an observer sees the final outcome with the same `callId`.
4. **Arguments**: invalid input becomes `INVALID_ARGS` and the body never runs.
5. **Output**: a value outside `output.schema` (3 / 2 for an integer) becomes `INVALID_TOOL_OUTPUT`.
6. **Failures**: an unknown tool (`UNKNOWN_TOOL`) and a throwing body both resolve as error results; `execute()` never rejects.
7. **`tools/pre-execute`**: `deny` stops the call; `ask` with no approval service mounted becomes a denial.
8. **Guards**: a guard denies even when a pre-execute listener answers `allow`, and it unregisters with its plugin.
9. **`tools/execute`**: a wrapper runs before and after the body and sees the result.
10. **`tools/post-execute`**: replacing content keeps the value; replacing the value re-renders content; `block` turns the call into an error with the feedback as content.
11. **Lifecycle**: duplicate names throw; `register()`'s disposer and plugin disposal both unregister; each change emits `tools/change`.
12. **Scheduling**: two calls in one batch overlap when their tool's `isConcurrencySafe` returns `true`, and run one after another when it returns `false`.
13. **Cancellation**: an already-aborted signal yields `ABORTED_BEFORE_DISPATCH` without running the body.

## Exercises

- Remove the `system-prompt` entry from `cordis.yml`. Nothing prints: `dsh-tools` waits `PENDING` for `systemPrompt`, so `add-tool` and `exam` wait too.
- In check 8, replace the guard with a second `tools/pre-execute` listener that returns `{ kind: 'deny', reason: 'late deny' }`. The call now succeeds: the earlier listener answers `allow` without calling `next()`, so the later deny never runs. A guard runs after the whole waterfall, which is why listener order cannot bypass it.
- In check 10, return both `content` and `value` from one `accept`. TypeScript rejects it: the decision type allows replacing one projection, never both.
- Mount `@deepseek-ai/dsh-user-approval` and see how check 7's `ask` result changes (read `packages/interaction/user-approval/README.md` first).
- Give `add` a `timeoutMs` and mount `@deepseek-ai/dsh-tool-call-timeout-policy`; make the body sleep past the deadline and observe the result code.
