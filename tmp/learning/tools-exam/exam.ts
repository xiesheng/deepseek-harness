import type { Context } from "@deepseek-ai/cordis";
import { ToolCallId, type ToolCallBlock } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-system-prompt";
import {
  defineTool,
  TOOL_ABORTED_BEFORE_DISPATCH,
  type ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import { check, expect, report, until } from "../shared/exam-kit.ts";
import { addCalls } from "./add-tool.ts";

export const name = "tools-exam";
export const inject = ["tools", "systemPrompt"];

let nextId = 0;

/** One model-shaped call block: the executor receives `arguments` as the raw JSON string the model produced. */
function callBlock(name: string, args: unknown): ToolCallBlock {
  return {
    type: "tool-call",
    id: ToolCallId(`exam-${++nextId}`),
    name,
    arguments: JSON.stringify(args),
  };
}

/** Runs a one-call batch the way the agent loop would, minus the model and the agent. */
async function call(
  ctx: Context,
  name: string,
  args: unknown,
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    calls: [callBlock(name, args)],
    signal,
  });
  const only = batch.results[0];
  if (!only) throw new Error("batch returned no result");
  return only.result;
}

const text = (result: ToolExecutionResult) =>
  result.content
    .map((block) => (block.type === "text" ? block.text : `<${block.type}>`))
    .join("");

/** Mounts `setup` as a child plugin, runs `body`, then disposes it so its listeners and tools unwind. */
async function withPlugin(
  ctx: Context,
  setup: (ctx: Context) => void,
  body: () => Promise<void>,
) {
  const fiber = ctx.plugin({ name: "exam-fixture", apply: setup });
  await fiber.await();
  try {
    await body();
  } finally {
    await fiber.dispose();
  }
}

/** A tool whose integer output contract the body can break: 3 / 2 is not an integer. */
const halfTool = defineTool({
  name: "half",
  description: "Halve an integer.",
  parameters: { n: { type: "integer", required: true } },
  output: {
    schema: { type: "integer" },
    render: (_args, value) => [{ type: "text", text: String(value) }],
  },
  async execute(args) {
    return args.n / 2;
  },
});

const boomTool = defineTool({
  name: "boom",
  description: "Always throws.",
  parameters: {},
  output: { schema: { type: "null" }, render: () => [] },
  async execute() {
    throw new Error("kaboom");
  },
});

export function apply(ctx: Context) {
  void runExam(ctx);
}

async function runExam(ctx: Context) {
  await check(
    "1. register: the model sees only name/description/parameters, compiled to JSON Schema",
    async () => {
      const schema = ctx.tools.schemas().find((tool) => tool.name === "add");
      if (!schema) throw new Error("add is not visible");
      expect(
        Object.keys(schema).sort(),
        ["description", "name", "parameters"],
        "model-facing keys",
      );
      // `required: true` per property compiles to the JSON Schema `required` list.
      expect(
        schema.parameters,
        {
          type: "object",
          properties: {
            a: { type: "integer", description: "First addend" },
            b: { type: "integer", description: "Second addend" },
          },
          required: ["a", "b"],
        },
        "compiled parameters",
      );
      const assembled = await ctx.systemPrompt.assemble();
      expect(
        assembled.tools.map((tool) => tool.name),
        ["add"],
        "schemas reach system-prompt assembly",
      );
    },
  );

  await check(
    "2. execute: success carries the canonical value and the rendered content",
    async () => {
      const result = await call(ctx, "add", { a: 2, b: 3 });
      expect(
        [result.isError, result.value, text(result)],
        [false, 5, "2 + 3 = 5"],
        "success",
      );
      expect(Object.isFrozen(result), true, "result is frozen");
    },
  );

  await check(
    "3. tools/result: an emit observer sees the same frozen outcome and call identity",
    async () => {
      const seen: string[] = [];
      await withPlugin(
        ctx,
        (child) => {
          child.on("tools/result", (exec, result) => {
            seen.push(
              `${exec.callId}:${exec.name}:${result.isError ? "error" : result.value}`,
            );
          });
        },
        async () => {
          await call(ctx, "add", { a: 1, b: 1 });
        },
      );
      expect(seen, [`exam-${nextId}:add:2`], "observer log");
    },
  );

  await check(
    "4. arguments: invalid input is INVALID_ARGS and the body never runs",
    async () => {
      const before = addCalls.length;
      const result = await call(ctx, "add", { a: "two", b: 3 });
      expect(
        [result.isError, result.error?.info?.code],
        [true, "INVALID_ARGS"],
        "error identity",
      );
      expect(addCalls.length, before, "body calls");
    },
  );

  await check(
    "5. output: a value outside output.schema becomes INVALID_TOOL_OUTPUT",
    async () => {
      await withPlugin(
        ctx,
        (child) => {
          child.tools.register(halfTool);
        },
        async () => {
          const ok = await call(ctx, "half", { n: 4 });
          const bad = await call(ctx, "half", { n: 3 });
          expect(ok.value, 2, "integer result");
          expect(
            [bad.isError, bad.error?.info?.code],
            [true, "INVALID_TOOL_OUTPUT"],
            "non-integer result",
          );
        },
      );
    },
  );

  await check(
    "6. failures: unknown tools and throwing bodies resolve as error results, never rejections",
    async () => {
      const unknown = await call(ctx, "ghost", {});
      expect(
        [unknown.isError, unknown.error?.info?.code],
        [true, "UNKNOWN_TOOL"],
        "unknown tool",
      );
      await withPlugin(
        ctx,
        (child) => {
          child.tools.register(boomTool);
        },
        async () => {
          const thrown = await call(ctx, "boom", {});
          expect(
            [thrown.isError, thrown.error?.message, text(thrown)],
            [true, "kaboom", "Error: kaboom"],
            "thrown body",
          );
        },
      );
    },
  );

  await check(
    "7. tools/pre-execute: deny short-circuits, and ask without an approval service denies",
    async () => {
      const before = addCalls.length;
      await withPlugin(
        ctx,
        (child) => {
          child.on("tools/pre-execute", async (exec, next) => {
            const args = exec.arguments as { a: number };
            if (args.a === 13)
              return { kind: "deny", reason: "unlucky number" };
            if (args.a === 7) return { kind: "ask", reason: "needs a human" };
            return next();
          });
        },
        async () => {
          const denied = await call(ctx, "add", { a: 13, b: 1 });
          const asked = await call(ctx, "add", { a: 7, b: 1 });
          const allowed = await call(ctx, "add", { a: 1, b: 1 });
          expect(
            [text(denied), text(asked), allowed.value],
            ["Error: unlucky number", "Error: needs a human", 2],
            "decisions",
          );
        },
      );
      expect(
        addCalls.length,
        before + 1,
        "only the allowed call reached the body",
      );
    },
  );

  await check(
    "8. guard: a monotonic guard denies even after pre-execute explicitly allows",
    async () => {
      await withPlugin(
        ctx,
        (child) => {
          // Answers `allow` without next(): the strongest permission a waterfall listener can give.
          child.on("tools/pre-execute", async () => ({ kind: "allow" }));
          child.tools.guard((exec) =>
            exec.name === "add" ? "add is frozen" : undefined,
          );
        },
        async () => {
          expect(
            text(await call(ctx, "add", { a: 1, b: 2 })),
            "Error: add is frozen",
            "guarded call",
          );
        },
      );
      expect(
        (await call(ctx, "add", { a: 1, b: 2 })).value,
        3,
        "guard gone with its plugin",
      );
    },
  );

  await check(
    "9. tools/execute: an around-dispatch wrapper runs before and after the body",
    async () => {
      const log: string[] = [];
      await withPlugin(
        ctx,
        (child) => {
          child.on("tools/execute", async (exec, next) => {
            log.push(`before:${exec.name}`);
            const result = await next();
            log.push(`after:${result.isError ? "error" : result.value}`);
            return result;
          });
        },
        async () => {
          await call(ctx, "add", { a: 4, b: 4 });
        },
      );
      expect(log, ["before:add", "after:8"], "wrapper order");
    },
  );

  await check(
    "10. tools/post-execute: replace content (value kept), replace value (re-rendered), or block",
    async () => {
      let mode: "content" | "value" | "block" = "content";
      await withPlugin(
        ctx,
        (child) => {
          child.on("tools/post-execute", async (_exec, _result, next) => {
            if (mode === "content")
              return {
                kind: "accept",
                content: [{ type: "text", text: "redacted" }],
              };
            if (mode === "value") return { kind: "accept", value: 100 };
            if (mode === "block")
              return {
                kind: "block",
                feedback: [{ type: "text", text: "try smaller numbers" }],
              };
            return next();
          });
        },
        async () => {
          const content = await call(ctx, "add", { a: 1, b: 2 });
          mode = "value";
          const value = await call(ctx, "add", { a: 1, b: 2 });
          mode = "block";
          const blocked = await call(ctx, "add", { a: 1, b: 2 });
          expect(
            [content.value, text(content)],
            [3, "redacted"],
            "content replacement",
          );
          expect(
            [value.value, text(value)],
            [100, "1 + 2 = 100"],
            "value replacement",
          );
          expect(
            [blocked.isError, blocked.value, text(blocked)],
            [true, undefined, "try smaller numbers"],
            "block",
          );
        },
      );
    },
  );

  await check(
    "11. lifecycle: duplicates fail, and plugin disposal unregisters and emits tools/change",
    async () => {
      const unregister = ctx.tools.register(halfTool);
      let threw = false;
      try {
        ctx.tools.register(halfTool);
      } catch {
        threw = true;
      }
      unregister();
      expect(
        [threw, ctx.tools.get("half")],
        [true, undefined],
        "duplicate throws; register()'s disposer unregisters",
      );

      let changes = 0;
      const listener = ctx.plugin({
        name: "change-counter",
        apply: (child) => {
          child.on("tools/change", () => {
            changes++;
          });
        },
      });
      await listener.await();
      const owner = ctx.plugin({
        name: "boom-owner",
        apply: (child) => {
          child.tools.register(boomTool);
        },
      });
      await until(() => ctx.tools.get("boom") !== undefined, "boom registered");
      await owner.dispose();
      expect(
        [ctx.tools.get("boom"), changes],
        [undefined, 2],
        "unregistered with its plugin",
      );
      await listener.dispose();
    },
  );

  await check(
    "12. scheduling: calls in one batch overlap only when isConcurrencySafe returns true",
    async () => {
      const log: string[] = [];
      const sleepy = (name: string, safe: boolean) =>
        defineTool({
          name,
          description: "Sleep briefly, logging start and end.",
          parameters: { tag: { type: "string", required: true } },
          output: { schema: { type: "null" }, render: () => [] },
          isConcurrencySafe: () => safe,
          async execute(args) {
            log.push(`start:${args.tag}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            log.push(`end:${args.tag}`);
            return null;
          },
        });
      const runBatch = (name: string) =>
        ctx.tools.execute({
          calls: [callBlock(name, { tag: "1" }), callBlock(name, { tag: "2" })],
          signal: new AbortController().signal,
        });
      await withPlugin(
        ctx,
        (child) => {
          child.tools.register(sleepy("sleepy-safe", true));
          child.tools.register(sleepy("sleepy-exclusive", false));
        },
        async () => {
          await runBatch("sleepy-safe");
          expect(
            log,
            ["start:1", "start:2", "end:1", "end:2"],
            "safe calls overlap",
          );
          log.length = 0;
          await runBatch("sleepy-exclusive");
          expect(
            log,
            ["start:1", "end:1", "start:2", "end:2"],
            "exclusive calls run alone",
          );
        },
      );
    },
  );

  await check(
    "13. cancellation: an already-aborted signal stops the call before dispatch",
    async () => {
      const before = addCalls.length;
      const controller = new AbortController();
      controller.abort();
      const result = await call(ctx, "add", { a: 1, b: 1 }, controller.signal);
      expect(
        [result.isError, result.error?.info?.code],
        [true, TOOL_ABORTED_BEFORE_DISPATCH],
        "abort identity",
      );
      expect(addCalls.length, before, "body calls");
    },
  );

  report();
}
