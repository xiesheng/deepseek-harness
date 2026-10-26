import type { Context } from "@deepseek-ai/cordis";
import {
  Session,
  SessionId,
  SessionSeq,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { check, expect, report } from "../shared/exam-kit.ts";
import { appendTurn, summaryMessage, userMessage } from "./events.ts";

export const name = "session-exam";
export const inject = ["sessions"];

let nextId = 0;
const freshId = (label: string) => SessionId(`${label}-${++nextId}`);

/** Mounts `setup` as a child plugin, runs `body`, then disposes it. */
async function withPlugin(
  ctx: Context,
  setup: (ctx: Context) => void,
  body: () => void | Promise<void>,
) {
  const fiber = ctx.plugin({ name: "exam-fixture", apply: setup });
  await fiber.await();
  try {
    await body();
  } finally {
    await fiber.dispose();
  }
}

function throws(run: () => unknown) {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}

const types = (events: readonly SessionEvent[]) =>
  events.map((event) => event.type);

export function apply(ctx: Context) {
  void runExam(ctx);
}

async function runExam(ctx: Context) {
  await check(
    "1. create: the store mints a header, lists the session, and announces session/created",
    async () => {
      const announced: string[] = [];
      await withPlugin(
        ctx,
        (child) => {
          child.on("session/created", (session) => {
            announced.push(session.id);
          });
        },
        () => {
          const id = freshId("create");
          const session = ctx.sessions.create(id, {
            meta: { cwd: "/workspace" },
          });
          expect(
            [session.id, session.header.id, session.header.cwd],
            [id, id, "/workspace"],
            "header",
          );
          expect(
            [
              ctx.sessions.get(id) === session,
              ctx.sessions.list().includes(session),
            ],
            [true, true],
            "store lookup",
          );
          expect(announced, [id], "announcement");
          expect(
            throws(() => ctx.sessions.create(id)),
            true,
            "duplicate id throws",
          );
          expect(
            throws(() =>
              ctx.sessions.create(freshId("rel"), {
                meta: { cwd: "relative/dir" },
              }),
            ),
            true,
            "relative cwd throws",
          );
        },
      );
    },
  );

  await check(
    "2. append: seq is the log length, and the log keeps a frozen snapshot of the data",
    () => {
      const session = ctx.sessions.create(freshId("append"));
      const data = { text: "original" };
      const first = session.append("exam/note", data);
      data.text = "mutated after append";
      const second = session.append("turn/start", { turn: 1 });
      expect(
        [first.seq, second.seq, session.seq],
        [0, 1, 2],
        "contiguous seqs",
      );
      expect(
        session.snapshotEvents()[0]?.data,
        { text: "original" },
        "log is not aliased to caller input",
      );
      expect(
        [Object.isFrozen(first), Object.isFrozen(first.data)],
        [true, true],
        "events are frozen",
      );
    },
  );

  await check(
    "3. session/event: a post-commit feed, where a throwing observer cannot undo the append",
    async () => {
      const session = ctx.sessions.create(freshId("feed"));
      const seen: string[] = [];
      await withPlugin(
        ctx,
        (child) => {
          child.on("session/event", (owner, event) => {
            seen.push(
              `${event.seq}:${event.type}:committed=${owner.seq === event.seq + 1}`,
            );
          });
          child.on("session/event", () => {
            throw new Error("observer bug");
          });
        },
        () => {
          session.append("turn/start", { turn: 1 });
          session.append("turn/end", {
            turn: 1,
            reason: { kind: "completed" },
          });
        },
      );
      expect(
        seen,
        ["0:turn/start:committed=true", "1:turn/end:committed=true"],
        "feed",
      );
      expect(session.seq, 2, "both appends committed");
    },
  );

  await check(
    "4. validation: non-JSON data and a missing surfaceOp are rejected before the log changes",
    () => {
      const session = ctx.sessions.create(freshId("validate"));
      expect(
        throws(() => session.append("turn/start", { turn: Number.NaN })),
        true,
        "NaN is not lossless JSON",
      );
      // The typed signature already requires surfaceOp for surface events; erase it to reach the runtime guard.
      const untypedAppend = session.append.bind(session) as (
        type: string,
        data: unknown,
      ) => SessionEvent;
      expect(
        throws(() => untypedAppend("user/message", userMessage("no marker"))),
        true,
        "surface event without surfaceOp",
      );
      expect(session.seq, 0, "nothing was appended");
    },
  );

  await check(
    "5. deriveMessages: only surface events become model history, as a fresh array of frozen messages",
    () => {
      const session = ctx.sessions.create(freshId("derive"));
      appendTurn(session, 1, "hello");
      session.append("exam/note", { text: "log-only" });
      const messages = session.deriveMessages();
      expect(types(session.snapshotEvents()).length, 9, "events in the log");
      expect(
        messages.map((message) => message.role),
        ["user", "assistant", "tool"],
        "derived roles",
      );
      expect(
        [session.deriveMessages() === messages, Object.isFrozen(messages[0])],
        [false, true],
        "fresh array, frozen messages",
      );
    },
  );

  await check(
    "6. surface replace: a summary shadows earlier nodes, but the append-only log keeps them",
    () => {
      const session = ctx.sessions.create(freshId("compact"));
      const a = session.append("user/message", userMessage("a"), {
        surfaceOp: "append",
      });
      const b = session.append("user/message", userMessage("b"), {
        surfaceOp: "append",
      });
      const c = session.append("user/message", userMessage("c"), {
        surfaceOp: "append",
      });
      expect(
        throws(() =>
          session.append("user/message", summaryMessage("bad"), {
            surfaceOp: { op: "replace", startSeq: a.seq, endSeq: b.seq },
            sourceEventSeqs: [a.seq],
          }),
        ),
        true,
        "sourceEventSeqs must cover every shadowed node",
      );
      const summary = session.append(
        "user/message",
        summaryMessage("summary of a, b"),
        {
          surfaceOp: { op: "replace", startSeq: a.seq, endSeq: b.seq },
          sourceEventSeqs: [a.seq, b.seq],
        },
      );
      expect(session.surface.nodes, [summary.seq, c.seq], "surface order");
      expect(session.surface.replaceGeneration, 1, "replace generation");
      const texts = session
        .deriveMessages()
        .map((message) =>
          message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join(""),
        );
      expect(texts, ["summary of a, b", "c"], "derived history");
      expect(session.seq, 4, "shadowed events remain in the log");
    },
  );

  await check(
    "7. merged events: a plugin event type is logged durably but never reaches the model",
    () => {
      const session = ctx.sessions.create(freshId("note"));
      session.append("user/message", userMessage("hi"), {
        surfaceOp: "append",
      });
      const note = session.append("exam/note", {
        text: "for humans and tools, not the model",
      });
      expect(
        [note.type, note.data.text],
        ["exam/note", "for humans and tools, not the model"],
        "logged event",
      );
      expect(
        [session.surface.nodes, session.deriveMessages().length],
        [[0], 1],
        "surface ignores it",
      );
    },
  );

  await check(
    "8. fork: the child copies a frozen prefix without recording its source, then diverges independently",
    () => {
      const parentId = freshId("parent");
      const parent = ctx.sessions.create(parentId, {
        meta: { cwd: "/workspace" },
      });
      appendTurn(parent, 1, "first");
      const child = ctx.sessions.fork(parent, undefined, freshId("child"));
      // Since v0.2.1-rc.3 ordinary forks are independent: only subagents record a parent.
      expect(child.header.parentSession, undefined, "no source recorded");
      expect(ctx.sessions.get(parentId) === parent, true, "parent untouched");
      expect(
        [child.header.isSeeded, child.header.cwd, child.inheritedEventCount],
        [true, "/workspace", parent.seq],
        "header",
      );
      const childEvents = child.snapshotEvents();
      expect(
        childEvents.slice(0, child.inheritedEventCount),
        parent.snapshotEvents(),
        "copied prefix",
      );
      // The marker separates inherited history from this session's own work.
      const marker = childEvents[child.inheritedEventCount];
      expect(
        [marker?.type, marker?.data],
        ["session/end-seed", { inherited: true }],
        "end-seed marker at the cut",
      );
      appendTurn(child, 2, "only in child");
      expect(
        [parent.deriveMessages().length, child.deriveMessages().length],
        [3, 6],
        "independent histories",
      );
      expect(
        [
          child.isOwnSeq(SessionSeq(0)),
          child.isOwnSeq(SessionSeq(child.seq - 1)),
        ],
        [false, true],
        "inherited vs own events",
      );
    },
  );

  await check(
    "9. fork boundaries: an explicit earlier boundary, and synthetic closers for an open turn",
    () => {
      const parent = ctx.sessions.create(freshId("boundary"));
      appendTurn(parent, 1, "first");
      const afterFirstTurn = SessionSeq(parent.seq - 1);
      appendTurn(parent, 2, "second");
      parent.append("turn/start", { turn: 3 });

      const early = ctx.sessions.fork(parent, afterFirstTurn, freshId("early"));
      expect(
        [early.inheritedEventCount, early.deriveMessages().length],
        [afterFirstTurn + 1, 3],
        "fork from turn 1",
      );
      expect(
        types(early.snapshotEvents().slice(early.inheritedEventCount)),
        ["session/end-seed"],
        "a closed boundary needs no closers",
      );

      const open = ctx.sessions.fork(parent, undefined, freshId("open"));
      const childWork = open.snapshotEvents().slice(open.inheritedEventCount);
      expect(
        types(childWork),
        ["session/end-seed", "turn/end"],
        "marker first, then the closer",
      );
      expect(
        childWork[1]?.data,
        { turn: 3, reason: { kind: "forked" } },
        "synthetic closer",
      );
      expect(
        open.inheritedEventCount,
        parent.seq,
        "the closer is child work, not inherited",
      );
    },
  );

  await check(
    "10. lifecycle: a session lives as long as the plugin that created it",
    async () => {
      const id = freshId("owned");
      const disposed: string[] = [];
      const listener = ctx.plugin({
        name: "disposed-listener",
        apply: (child) => {
          child.on("session/disposed", (s) => {
            disposed.push(s.id);
          });
        },
      });
      await listener.await();
      const owner = ctx.plugin({
        name: "session-owner",
        apply: (child) => {
          child.sessions.create(id);
        },
      });
      await owner.await();
      expect(ctx.sessions.get(id)?.id, id, "live while the owner is active");
      await owner.dispose();
      expect(
        [ctx.sessions.get(id), disposed],
        [undefined, [id]],
        "removed and announced on dispose",
      );
      await listener.dispose();
    },
  );

  await check(
    "11. flush: a parallel durability checkpoint that reports whether anyone persisted",
    async () => {
      const session = ctx.sessions.create(freshId("flush"));
      expect(
        await ctx.sessions.flush(session),
        false,
        "no durability listener",
      );
      const flushed: string[] = [];
      await withPlugin(
        ctx,
        (child) => {
          child.on("session/flush", async (s) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            flushed.push(s.id);
          });
        },
        async () => {
          expect(
            await ctx.sessions.flush(session),
            true,
            "a listener participated",
          );
        },
      );
      expect(flushed, [session.id], "flush awaited the slow listener");
    },
  );

  await check(
    "12. detached sessions: Session.create builds a log outside the store, with no feed",
    async () => {
      const seen: number[] = [];
      await withPlugin(
        ctx,
        (child) => {
          child.on("session/event", (_s, event) => {
            seen.push(event.seq);
          });
        },
        () => {
          const detached = Session.create(freshId("detached"));
          appendTurn(detached, 1, "offline");
          expect(
            [ctx.sessions.get(detached.id), detached.deriveMessages().length],
            [undefined, 3],
            "not in store, still derives",
          );
        },
      );
      expect(seen, [], "no session/event for a detached session");
    },
  );

  await check(
    "13. replay: seeding a new session with an old log reproduces the same history",
    () => {
      const original = ctx.sessions.create(freshId("original"));
      appendTurn(original, 1, "replay me");
      const replayed = ctx.sessions.create(freshId("replayed"), {
        seed: original.snapshotEvents(),
      });
      expect(
        replayed.deriveMessages(),
        original.deriveMessages(),
        "derived history",
      );
      // A non-fork seed ends with a plain marker; live appends start after it.
      const marker = replayed.snapshotEvents()[original.seq];
      expect(
        [marker?.type, marker?.data],
        ["session/end-seed", {}],
        "plain end-seed marker",
      );
      expect(
        [replayed.firstLiveSeq, replayed.seq],
        [original.seq, original.seq + 1],
        "seed length, then the marker",
      );
    },
  );

  report();
}
