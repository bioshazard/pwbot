import { expect, test } from "bun:test";

import { ConfigProvider, Effect, Exit, Redacted, Schema } from "effect";

import { AppLive } from "../../lib/layers";
import { Store } from "../../lib/store";
import { karmaTool, Replies, runAgent, runReplyMachine } from "../../reply";

const config = {
  apiKey: Redacted.make("test-key"),
  baseUrl: "",
  contextWindow: 16_384,
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

const toolRequest = (args = '{"userId":"UTEST"}') =>
  stream(
    {
      tool_calls: [
        {
          function: { arguments: args, name: "getKarma" },
          id: "call",
          index: 0,
          type: "function",
        },
      ],
    },
    "tool_calls"
  );
const localModel = (fetch: () => Response | Promise<Response>) =>
  Bun.serve({ fetch, hostname: "127.0.0.1", port: 0 });
const agentInput = (baseUrl: string) => ({
  config: { ...config, baseUrl: `${baseUrl}/v1` },
  signal: new AbortController().signal,
  thread: "synthetic question",
  tools: [karmaTool(() => Effect.succeed(1))],
  userId: "UTEST",
});

test("a stalled model settles even when its stream ignores abort", async () => {
  await expect(
    runAgent({
      ...agentInput("http://localhost"),
      config: { ...config, modelTimeoutMs: 20 },
      // oxlint-disable-next-line promise/avoid-new -- An intentionally uncooperative SDK.
      streamFn: () => new Promise(() => {}),
    })
  ).rejects.toMatchObject({ reason: "model_timeout" });
});

test("a stalled tool aborts its signal and prevents further model requests", async () => {
  let requests = 0;
  let toolSignal: AbortSignal | undefined;
  const debugEvents: {
    event: string;
    fields: Readonly<Record<string, string | number | boolean | undefined>>;
  }[] = [];
  const server = localModel(() => {
    requests += 1;
    return toolRequest();
  });
  const input = agentInput(server.url.origin);
  try {
    await expect(
      runAgent({
        ...input,
        config: { ...input.config, toolTimeoutMs: 20 },
        debug: (event, fields = {}) => {
          debugEvents.push({ event, fields });
        },
        tools: [
          {
            ...karmaTool(() => Effect.succeed(1)),
            execute: (_id, _args, signal) => {
              toolSignal = signal;
              // oxlint-disable-next-line promise/avoid-new -- Stalled external tool.
              return new Promise(() => {});
            },
          },
        ],
      })
    ).rejects.toMatchObject({ reason: "tool_timeout" });
    expect(toolSignal?.aborted).toBe(true);
    expect(
      debugEvents.find((item) => item.event === "stage")?.fields.stage
    ).toBe("researching");
    expect(debugEvents.some((item) => item.fields.stage === "composing")).toBe(
      false
    );
    expect(
      debugEvents.find((item) => item.event === "aborting")?.fields.reason
    ).toBe("tool_timeout");
    expect(debugEvents.at(-1)).toMatchObject({
      event: "agent_finished",
      fields: { completed: false, stage: "researching" },
    });
    expect(JSON.stringify(debugEvents)).not.toContain("synthetic question");
    expect(requests).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("invalid calls consume the tool budget before any execution", async () => {
  let requests = 0;
  let executed = false;
  const server = localModel(() => {
    requests += 1;
    return toolRequest("{}");
  });
  const input = agentInput(server.url.origin);
  try {
    await expect(
      runAgent({
        ...input,
        config: { ...input.config, maxToolCalls: 1 },
        tools: [
          karmaTool(() => {
            executed = true;
            return Effect.succeed(1);
          }),
        ],
      })
    ).rejects.toMatchObject({ reason: "limit" });
    expect(requests).toBe(2);
    expect(executed).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("external cancellation settles an uncooperative model", async () => {
  const controller = new AbortController();
  const promise = runAgent({
    ...agentInput("http://localhost"),
    signal: controller.signal,
    // oxlint-disable-next-line promise/avoid-new -- Simulates ignored cancellation.
    streamFn: () => new Promise(() => {}),
  });
  controller.abort();
  await expect(promise).rejects.toMatchObject({ reason: "cancelled" });
});

test("concurrent replies keep budgets and progress isolated", async () => {
  const stages: string[] = [];
  const server = localModel(() => stream({ content: "Complete." }, "stop"));
  try {
    const results = await Promise.all([
      runAgent({
        ...agentInput(server.url.origin),
        onProgress: async (stage) => {
          await Promise.resolve(stages.push(stage));
        },
      }),
      runAgent({
        ...agentInput(server.url.origin),
        config: { ...config, modelTimeoutMs: 10 },
        // oxlint-disable-next-line promise/avoid-new -- Independent stalled request.
        streamFn: () => new Promise(() => {}),
      }).catch(() => "model_timeout"),
    ]);
    expect(results[0]).toBe("Complete.");
    expect(results[1]).toBe("model_timeout");
    expect(stages).toEqual(["composing"]);
  } finally {
    await server.stop(true);
  }
});

test("overall deadline is distinct from an individual call timeout", async () => {
  const server = localModel(async () => {
    await Bun.sleep(50);
    return stream({ content: "Complete." }, "stop");
  });
  try {
    await expect(
      Effect.runPromise(
        Replies.use((replies) => replies.generate("synthetic", "UTEST")).pipe(
          Effect.provide(AppLive),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              DATABASE_PATH: ":memory:",
              MODEL_CALL_TIMEOUT_MS: "1000",
              OPENAI_API_BASE: `${server.url.origin}/v1`,
              OPENAI_API_KEY: "test-key",
              OPENAI_TIMEOUT_MS: "20",
            })
          )
        )
      )
    ).rejects.toMatchObject({ reason: "timeout" });
  } finally {
    await server.stop(true);
  }
});

test("truncated model output has a distinct failure and is never delivered", async () => {
  const server = localModel(() =>
    stream({ content: "Incomplete synthetic answer" }, "length")
  );
  try {
    await expect(runAgent(agentInput(server.url.origin))).rejects.toMatchObject(
      { reason: "output_limit" }
    );
  } finally {
    await server.stop(true);
  }
});

test("context pressure cannot silently send a one-token model request", async () => {
  let requests = 0;
  const server = localModel(() => {
    requests += 1;
    return toolRequest();
  });
  const input = agentInput(server.url.origin);
  try {
    await expect(
      runAgent({
        ...input,
        config: { ...input.config, contextWindow: 32_768 },
        tools: [
          {
            ...karmaTool(() => Effect.succeed(1)),
            execute: async () =>
              await Promise.resolve({
                content: [
                  { text: "synthetic evidence ".repeat(7000), type: "text" },
                ],
                details: {},
              }),
          },
        ],
      })
    ).rejects.toMatchObject({ reason: "context_limit" });
    expect(requests).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("the same large research context completes with an accurately configured window", async () => {
  let requests = 0;
  const budgets: number[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      const payload = Schema.decodeUnknownSync(
        Schema.Struct({ max_tokens: Schema.Number })
      )(await request.json());
      budgets.push(payload.max_tokens);
      requests += 1;
      return requests === 1
        ? toolRequest()
        : stream({ content: "Research complete." }, "stop");
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const input = agentInput(server.url.origin);
  try {
    const text = await runAgent({
      ...input,
      config: { ...input.config, contextWindow: 150_000 },
      tools: [
        {
          ...karmaTool(() => Effect.succeed(1)),
          execute: async () =>
            await Promise.resolve({
              content: [
                { text: "synthetic evidence ".repeat(7000), type: "text" },
              ],
              details: {},
            }),
        },
      ],
    });
    expect(text).toBe("Research complete.");
    expect(budgets).toEqual([config.maxTokens, config.maxTokens]);
  } finally {
    await server.stop(true);
  }
});
