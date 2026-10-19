import { expect, test } from "bun:test";

import { ConfigProvider, Effect } from "effect";

import { AppLive } from "../lib/layers";
import { Replies } from "../reply";

// Explicit local-only slow check: bun --no-env-file test test/long-reply.integration.test.ts
// Three 41-second model calls exceed the former two-minute whole-run deadline.
test("multi-step research completes after two minutes within its configured deadline", async () => {
  let requests = 0;
  const stages: string[] = [];
  const server = Bun.serve({
    fetch: async () => {
      requests += 1;
      const researching = requests <= 3;
      if (researching) {
        await Bun.sleep(41_000);
      }
      const delta = researching
        ? {
            tool_calls: [
              {
                function: { arguments: '{"userId":"UTEST"}', name: "getKarma" },
                id: `call${requests}`,
                index: 0,
                type: "function",
              },
            ],
          }
        : { content: "Synthetic research complete." };
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
        {
          choices: [
            {
              delta: {},
              finish_reason: researching ? "tool_calls" : "stop",
              index: 0,
            },
          ],
        },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("");
      return new Response(`${chunks}data: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const started = performance.now();
  try {
    const result = await Effect.runPromise(
      Replies.use((replies) =>
        replies.generate("Synthetic multi-step question", "UTEST", {
          channelId: "CTEST",
          onProgress: async (stage) => {
            await Promise.resolve(stages.push(stage));
          },
          teamId: "TTEST",
          threadTs: "123.456",
        })
      ).pipe(
        Effect.provide(AppLive),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            DATABASE_PATH: ":memory:",
            MODEL_CALL_TIMEOUT_MS: "60000",
            OPENAI_API_BASE: `${server.url.origin}/v1`,
            OPENAI_API_KEY: "test-key",
            OPENAI_TIMEOUT_MS: "140000",
          })
        )
      )
    );
    expect(result).toBe("Synthetic research complete.");
    expect(performance.now() - started).toBeGreaterThan(120_000);
    expect(performance.now() - started).toBeLessThan(140_000);
    expect(requests).toBe(4);
    expect(stages).toEqual([
      "researching",
      "researching",
      "researching",
      "composing",
    ]);
  } finally {
    await server.stop(true);
  }
}, 150_000);
