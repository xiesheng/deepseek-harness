import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Calls observed by the `add` body, so the exam can tell whether policy stopped it before dispatch. */
export const addCalls: unknown[] = [];

export const addTool = defineTool({
  name: "add",
  description: "Add two integers.",
  parameters: {
    a: { type: "integer", required: true, description: "First addend" },
    b: { type: "integer", required: true, description: "Second addend" },
  },
  output: {
    schema: { type: "integer" },
    render: (args, value) => [
      { type: "text", text: `${args.a} + ${args.b} = ${value}` },
    ],
  },
  isConcurrencySafe: () => true,
  async execute(args) {
    addCalls.push(args);
    return args.a + args.b;
  },
});

export const name = "add-tool";
export const inject = ["tools"];

export function apply(ctx: Context) {
  // register() returns a disposer that is also attached to this plugin's fiber.
  ctx.tools.register(addTool);
}
