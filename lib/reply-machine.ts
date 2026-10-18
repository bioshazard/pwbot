import type { AgentTool } from "@earendil-works/pi-agent-core";
import { assign, fromPromise, setup } from "xstate";

import { ReplyError } from "./errors";

export interface ReplyInput {
  discover: (signal: AbortSignal) => Promise<AgentTool[]>;
  generate: (tools: AgentTool[], signal: AbortSignal) => Promise<string>;
}
export type ReplyOutput =
  | {
      ok: true;
      text: string;
    }
  | {
      ok: false;
      error: ReplyError;
    };
interface ReplyTypes {
  context: {
    input: ReplyInput;
    tools: AgentTool[];
    text: string;
    error: ReplyError;
  };
  input: ReplyInput;
  output: ReplyOutput;
}
export const replyMachine = setup({
  actors: {
    discover: fromPromise<AgentTool[], ReplyInput>(
      async ({ input, signal }) => await input.discover(signal)
    ),
    generate: fromPromise<
      string,
      {
        input: ReplyInput;
        tools: AgentTool[];
      }
    >(
      async ({ input, signal }) =>
        await input.input.generate(input.tools, signal)
    ),
  },
  // SAFETY: XState uses this declaration only for type inference, never at runtime.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion
  types: {} as ReplyTypes,
}).createMachine({
  context: ({ input }) => ({
    error: new ReplyError({ reason: "model" }),
    input,
    text: "",
    tools: [],
  }),
  id: "reply",
  initial: "discovering",
  output: ({ context }) =>
    context.text.length > 0
      ? { ok: true, text: context.text }
      : { error: context.error, ok: false },
  states: {
    discovering: {
      invoke: {
        input: ({ context }) => context.input,
        onDone: {
          actions: assign({ tools: ({ event }) => event.output }),
          target: "generating",
        },
        onError: {
          actions: assign({
            error: () => new ReplyError({ reason: "discovery" }),
          }),
          target: "failed",
        },
        src: "discover",
      },
    },
    failed: { type: "final" },
    generating: {
      invoke: {
        input: ({ context }) => ({
          input: context.input,
          tools: context.tools,
        }),
        onDone: {
          actions: assign({ text: ({ event }) => event.output }),
          target: "succeeded",
        },
        onError: {
          actions: assign({
            error: ({ event }) =>
              event.error instanceof ReplyError
                ? event.error
                : new ReplyError({ reason: "model" }),
          }),
          target: "failed",
        },
        src: "generate",
      },
    },
    succeeded: { type: "final" },
  },
});
