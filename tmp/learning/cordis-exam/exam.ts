import {
  FiberState,
  Service,
  type Context,
  type Fiber,
} from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { check, expect, report, until } from "../shared/exam-kit.ts";
import type {} from "./counter.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    greeter: GreeterService;
  }
  interface Events {
    "exam/parallel"(log: string[]): Promise<void>;
    "exam/serial"(log: string[]): Promise<string | undefined>;
    "exam/bail"(log: string[]): string | undefined;
  }
}

class GreeterService extends Service {
  constructor(
    ctx: Context,
    public greeting: string,
  ) {
    super(ctx, "greeter");
  }
}

export const name = "exam";
export const inject = ["counter"];

// FiberState is a const enum, so it has no reverse name lookup under tsc.
const STATE_NAMES: Record<FiberState, string> = {
  [FiberState.PENDING]: "PENDING",
  [FiberState.LOADING]: "LOADING",
  [FiberState.ACTIVE]: "ACTIVE",
  [FiberState.FAILED]: "FAILED",
  [FiberState.DISPOSED]: "DISPOSED",
  [FiberState.UNLOADING]: "UNLOADING",
};

const stateName = (fiber: Fiber) => STATE_NAMES[fiber.state];

export function apply(ctx: Context) {
  void runExam(ctx);
}

async function runExam(ctx: Context) {
  await check(
    "1. service: cordis.yml config reaches the service through its schema",
    () => {
      expect(ctx.counter.config.step, 2, "step from cordis.yml");
      expect(ctx.counter.bump("a"), { name: "a", value: 2 }, "first bump");
    },
  );

  await check(
    "2. config: invalid config fails the fiber, defaults fill omitted fields",
    async () => {
      const plugin = {
        name: "strict",
        Config: Schema.object({ size: Schema.natural().default(3) }),
        apply(_: Context, config: { size: number }) {
          seen.push(config.size);
        },
      };
      const seen: number[] = [];
      const good = ctx.plugin(plugin, {});
      await good.await();
      expect(seen, [3], "default applied");
      // Parsed like a cordis.yml row, so the wrong type reaches the schema untyped.
      const bad = ctx.plugin(plugin, JSON.parse('{ "size": "big" }'));
      let threw = false;
      await bad.await().catch(() => {
        threw = true;
      });
      expect([threw, stateName(bad)], [true, "FAILED"], "bad config");
      await good.dispose();
      await bad.dispose();
    },
  );

  await check(
    "3. inject: a consumer waits PENDING, then follows its provider in and out",
    async () => {
      const log: string[] = [];
      const consumer = ctx.plugin({
        name: "greeter-consumer",
        inject: ["greeter"],
        apply(ctx: Context) {
          log.push(`load:${ctx.greeter.greeting}`);
          ctx.effect(() => () => log.push("unload"));
        },
      });
      await until(
        () => consumer.state === FiberState.PENDING,
        "consumer PENDING",
      );

      const first = ctx.plugin(GreeterService, "hi");
      await until(
        () => consumer.state === FiberState.ACTIVE,
        "consumer ACTIVE",
      );
      await first.dispose();
      await until(
        () => consumer.state === FiberState.PENDING,
        "consumer back to PENDING",
      );
      expect(
        ctx.get("greeter"),
        undefined,
        "service gone after provider dispose",
      );

      const second = ctx.plugin(GreeterService, "hello");
      await until(
        () => consumer.state === FiberState.ACTIVE,
        "consumer ACTIVE again",
      );
      expect(log, ["load:hi", "unload", "load:hello"], "consumer lifecycle");
      await consumer.dispose();
      await second.dispose();
    },
  );

  await check(
    "4. effects: disposers run in reverse order, listeners leave with their plugin",
    async () => {
      const log: string[] = [];
      const fiber = ctx.plugin({
        name: "effects",
        apply(ctx: Context) {
          ctx.effect(() => () => log.push("first"));
          ctx.effect(() => () => log.push("second"));
          ctx.on("counter/changed", (name) => log.push(`saw:${name}`));
        },
      });
      await fiber.await();
      ctx.counter.bump("b");
      await fiber.dispose();
      ctx.counter.bump("c");
      expect(
        log,
        ["saw:b", "second", "first"],
        "teardown order and listener removal",
      );
    },
  );

  await check(
    "5. emit: synchronous broadcast that does not await async listeners",
    async () => {
      const log: string[] = [];
      const fiber = ctx.plugin({
        name: "emit-listener",
        apply(ctx: Context) {
          ctx.on("counter/changed", async () => {
            await Promise.resolve();
            log.push("async listener finished");
          });
        },
      });
      await fiber.await();
      ctx.counter.bump("d");
      log.push("emit returned");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(log, ["emit returned", "async listener finished"], "ordering");
      await fiber.dispose();
    },
  );

  await check(
    "6. parallel / serial / bail: concurrent, ordered with first-bail-wins, sync bail",
    async () => {
      const fiber = ctx.plugin({
        name: "modes",
        apply(ctx: Context) {
          const delay = (ms: number) =>
            new Promise((resolve) => setTimeout(resolve, ms));
          ctx.on("exam/parallel", async (log) => {
            await delay(20);
            log.push("slow");
          });
          ctx.on("exam/parallel", async (log) => {
            await delay(1);
            log.push("fast");
          });
          ctx.on("exam/serial", async (log) => {
            log.push("s1");
            return undefined;
          });
          ctx.on("exam/serial", async (log) => {
            log.push("s2");
            return "winner";
          });
          ctx.on("exam/serial", async (log) => {
            log.push("s3");
            return "never";
          });
          ctx.on("exam/bail", (log) => {
            log.push("b1");
            return "stop";
          });
          ctx.on("exam/bail", (log) => {
            log.push("b2");
            return "never";
          });
        },
      });
      await fiber.await();

      const parallelLog: string[] = [];
      await ctx.parallel("exam/parallel", parallelLog);
      expect(
        parallelLog,
        ["fast", "slow"],
        "parallel finishes fast first, awaits both",
      );

      const serialLog: string[] = [];
      expect(
        await ctx.serial("exam/serial", serialLog),
        "winner",
        "serial result",
      );
      expect(serialLog, ["s1", "s2"], "serial stops at first bail value");

      const bailLog: string[] = [];
      expect(ctx.bail("exam/bail", bailLog), "stop", "bail result");
      expect(bailLog, ["b1"], "bail stops synchronously");
      await fiber.dispose();
    },
  );

  await check(
    "7. waterfall: listeners wrap next(), and one that skips next() vetoes the default",
    async () => {
      const fiber = ctx.plugin({
        name: "policy",
        apply(ctx: Context) {
          // Registered first, so it runs outermost and wraps everything below.
          ctx.on("counter/validate", (_name, next) => next().toLowerCase());
          // Owns the decision for blocked names: returns without calling next().
          ctx.on("counter/validate", (name, next) =>
            name.startsWith("Spam") ? "BLOCKED" : next(),
          );
        },
      });
      await fiber.await();
      expect(ctx.counter.bump("Hello").name, "hello", "wrapped default");
      expect(
        ctx.counter.bump("SpamBot").name,
        "blocked",
        "veto, still wrapped by the outer listener",
      );
      await fiber.dispose();
      expect(
        ctx.counter.bump("Hello").name,
        "Hello",
        "policy gone after dispose",
      );
    },
  );

  report();
}
