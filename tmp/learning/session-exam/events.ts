import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContextFormed,
} from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";

// SessionEventMap and MessageSourceMap are merge-extensible: plugins add their own members.
declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    /** A log-only note: recorded durably, never part of the model-visible surface. */
    "exam/note": { text: string };
  }
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    /** Producer of the compaction-style summary in the surface-replacement check. */
    "exam-summary": { kind: "exam-summary" } & ContextFormed;
  }
}

export const userMessage = (text: string) =>
  createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });

export const summaryMessage = (text: string) =>
  createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "exam-summary" },
  });

/**
 * Appends one complete turn the way the agent loop records it: turn and step
 * boundaries, the user prompt, an assistant message that calls a tool, the
 * tool call and its result, and the closers.
 */
export function appendTurn(session: Session, turn: number, prompt: string) {
  const callId = ToolCallId(`call-${turn}`);
  session.append("turn/start", { turn });
  session.append("user/message", userMessage(prompt), { surfaceOp: "append" });
  session.append("step/start", { turn, step: 1 });
  session.append(
    "assistant/message",
    {
      turn,
      step: 1,
      stream: [],
      message: createMessage({
        role: "assistant",
        content: [
          { type: "text", text: `answering ${prompt}` },
          { type: "tool-call", id: callId, name: "echo", arguments: "{}" },
        ],
        source: { kind: "model", provider: "mock", model: "mock" },
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("tool/call", {
    turn,
    step: 1,
    callId,
    name: "echo",
    arguments: "{}",
  });
  session.append(
    "tool/result",
    {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn, step: 1 });
  session.append("turn/end", { turn, reason: { kind: "completed" } });
}
