import { expect, test } from "bun:test";

import { ConfigProvider, Effect, Exit, Redacted, Schema } from "effect";

import { AppLive } from "../../lib/layers";
import { Store } from "../../lib/store";
import { karmaTool, Replies, runAgent, runReplyMachine } from "../../reply";

const config = {
  apiKey: Redacted.make("test-key"),
  baseUrl: "",
  contextWindow: 4096,
  maxTokens: 200,
  maxToolCalls: 4,
  maxTurns: 4,
  model: "test-model",
};
interface SseDelta {
  content?: string;
  tool_calls?: {
    index: number;
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
}
const stream = (delta: SseDelta, reason: string) => {
  const chunks = [
    {
      choices: [
        {
          delta: { role: "assistant", ...delta },
          finish_reason: null,
          index: 0,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: reason, index: 0 }] },
  ]
    .map(
      (chunk) =>
        `data: ${JSON.stringify({ ...chunk, id: "test", model: "test-model", object: "chat.completion.chunk" })}\n\n`
    )
    .join("");
  return new Response(`${chunks}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
};

test("Pi executes karma through the real OpenAI-compatible wire protocol", async () => {
  const RequestBody = Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.Unknown),
        role: Schema.String,
      })
    ),
    tools: Schema.optional(
      Schema.Array(
        Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })
      )
    ),
  });
  const requests: (typeof RequestBody.Type)[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      requests.push(
        Schema.decodeUnknownSync(RequestBody)(await request.json())
      );
      return requests.length === 1
        ? stream(
            {
              tool_calls: [
                {
                  function: {
                    arguments: '{"userId":"UTEST"}',
                    name: "getKarma",
                  },
                  id: "call1",
                  index: 0,
                  type: "function",
                },
              ],
            },
            "tool_calls"
          )
        : stream({ content: "Karma is 42." }, "stop");
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const text = await Effect.runPromise(
      Effect.gen(function* verifyReplyStack() {
        const store = yield* Store;
        yield* store.changeKarma("UTEST", 42);
        const replies = yield* Replies;
        return yield* replies.generate("What's my karma?", "UTEST");
      }).pipe(
        Effect.provide(AppLive),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            DATABASE_PATH: ":memory:",
            OPENAI_API_BASE: `${server.url.origin}/v1`,
            OPENAI_API_KEY: "test-key",
            OPENAI_API_MODEL: "test-model",
          })
        )
      )
    );
    expect(text).toBe("Karma is 42.");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.map((tool) => tool.function.name)).toContain(
      "getKarma"
    );
    expect(
      requests[1]?.messages.find((message) => message.role === "tool")?.content
    ).toContain('"score":42');
  } finally {
    await server.stop(true);
  }
});
test("Pi stops repeated model/tool turns at the configured budget", async () => {
  let calls = 0;
  const server = Bun.serve({
    fetch: () => {
      calls += 1;
      return stream(
        {
          tool_calls: [
            {
              function: { arguments: '{"userId":"UTEST"}', name: "getKarma" },
              id: `call${calls}`,
              index: 0,
              type: "function",
            },
          ],
        },
        "tool_calls"
      );
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    await expect(
      runAgent({
        config: { ...config, baseUrl: `${server.url.origin}/v1`, maxTurns: 2 },
        signal: new AbortController().signal,
        thread: "karma",
        tools: [karmaTool(() => Effect.succeed(1))],
        userId: "UTEST",
      })
    ).rejects.toMatchObject({ reason: "limit" });
    expect(calls).toBe(2);
  } finally {
    await server.stop(true);
  }
});
test("Effect interruption stops the XState promise actor", async () => {
  let signal: AbortSignal | undefined;
  const exit = await Effect.runPromiseExit(
    runReplyMachine({
      discover: () => Promise.resolve([]),
      generate: (_tools, currentSignal) => {
        signal = currentSignal;
        // oxlint-disable-next-line promise/avoid-new -- Simulates a stalled external SDK.
        return new Promise<string>(() => {});
      },
    }).pipe(Effect.timeout(20))
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(signal?.aborted).toBe(true);
});
test("discovery failure blocks model execution and returns a sanitized error", async () => {
  let generated = false;
  await expect(
    Effect.runPromise(
      runReplyMachine({
        discover: () => Promise.reject(new Error("private response")),
        generate: () => {
          generated = true;
          return Promise.resolve("bad");
        },
      })
    )
  ).rejects.toMatchObject({ reason: "discovery" });
  expect(generated).toBe(false);
});
