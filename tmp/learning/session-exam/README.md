# Session exam

A self-checking walk through `ctx.sessions` from `@deepseek-ai/dsh-session`: the append-only event log, the model-visible surface derived from it, forks, replay, and the store's lifecycle events. Each check prints PASS or FAIL; the process exits 1 if any check fails. It runs keylessly: events are appended by hand in the shapes the agent loop records.

## Run

```sh
cd tmp/learning/session-exam
node --import tsx ../../../vendor/cordis/bin.js
```

Typecheck:

```sh
../../../node_modules/.bin/tsc -p tsconfig.json
```

`tsconfig.json` uses project references to the built `lib/types` declarations. Run `pnpm run build:artifacts` first if they are missing or stale. Check helpers come from `../shared/exam-kit.ts`.

## Files

| File         | Role                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `cordis.yml` | Composition: `dsh-session` (claims `ctx.sessions`) and the exam                                                                              |
| `events.ts`  | Declaration merges (an `exam/note` log-only event and an `exam-summary` message source) plus `appendTurn()`, which records one complete turn |
| `exam.ts`    | Injects `sessions` and runs the checks                                                                                                       |

## The model being examined

```
event log (append-only, seq = log length, frozen JSON)
  ├─ log-only events: turn/*, step/*, tool/call, session/end-seed, exam/note, …
  └─ surface events (carry surfaceOp): system/user/assistant/developer messages, tool/result
        └─ surface: ordered node seqs; `replace` shadows a range
              └─ deriveMessages(): the Message[] the model sees
```

The log is the single source of truth. Model history is never stored; it is re-derived from the surface, so replay and fork are just "seed a new log and derive again".

## What each check covers

1. **Create**: the store fills the header (`id`, `cwd`), lists the session, and emits `session/created`; duplicate ids and relative `cwd` throw.
2. **Append**: `seq` equals the log length; the log stores a frozen snapshot, so mutating your input afterwards changes nothing.
3. **`session/event`**: observers run after commit (the log already includes the event); a throwing observer cannot undo the append.
4. **Validation**: non-JSON data (`NaN`) and a surface event without `surfaceOp` are rejected before the log changes.
5. **`deriveMessages()`**: one turn of 8 events plus a note yields only `user`, `assistant`, `tool` messages, as a fresh array of frozen messages.
6. **Surface replace**: a compaction-style summary replaces two messages; `sourceEventSeqs` must cover every shadowed node; the shadowed events stay in the log.
7. **Merged events**: a plugin-declared `exam/note` is logged with full typing but never reaches the surface.
8. **Fork**: the child copies the parent's events, records `isSeeded` and `inheritedEventCount` but no `parentSession` (ordinary forks are independent since v0.2.1-rc.3; only subagents keep their creator), places a `session/end-seed { inherited: true }` marker at the cut, then diverges independently.
9. **Fork boundaries**: forking at a closed turn adds only the marker; forking an open turn adds the marker and then a synthetic `turn/end { reason: forked }`.
10. **Lifecycle**: a session belongs to the plugin that created it; disposing that plugin removes it and emits `session/disposed`.
11. **`flush()`**: the awaited `session/flush` checkpoint returns `false` with no durability listener, and `true` after awaiting one.
12. **Detached sessions**: `Session.create()` builds a log outside the store that still derives history but publishes no `session/event`.
13. **Replay**: seeding a new session with an old log reproduces the same `deriveMessages()`; a plain `session/end-seed {}` marker follows the seed.

## Why `session/end-seed` exists

Seed history and live work are otherwise identical, so a plugin cannot tell an unmatched "start" event left by a crashed earlier process from one it is writing right now. Everything before the last marker belongs to an ended lifecycle. See "The end-seed boundary" in `docs/subsystems/session.md`.

## Exercises

- Append a `tool/result` whose message has `isError: false` but whose data carries `error: { message: 'nope' }`. It is rejected: an error identity requires `message.isError === true`.
- Fork a parent whose last events are an assistant `tool-call` and its `tool/call`, with no `tool/result`. The child gets the marker, a synthetic failed `tool/result` for the unanswered call, then `step/end` and `turn/end { forked }`, so the provider never sees a call without a result.
- Append `session/end-seed` yourself. The docs say only the constructor and fork seeding create it, but `append()` accepts it: that rule is a convention the store does not enforce.
- Remove the `sessions` entry from `cordis.yml`. The run is silent with exit 0, because `exam` waits `PENDING` for `ctx.sessions`.
- Read `docs/subsystems/persistence.md` and mount a session-log writer, so check 11's `flush()` reaches a real backend.
