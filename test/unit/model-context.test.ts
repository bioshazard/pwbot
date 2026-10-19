import { expect, test } from "bun:test";

import { ConfigProvider, Effect, Redacted } from "effect";

import { BotConfig } from "../../lib/config";
import { resolveModelContext } from "../../lib/model-context";

const read = (baseUrl: string, values: Record<string, string> = {}) =>
  Effect.runPromise(
    BotConfig.use(Effect.succeed).pipe(
      Effect.provide(BotConfig.resolvedLayer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          OPENAI_API_BASE: baseUrl,
          OPENAI_API_KEY: "test-key",
          OPENAI_API_MODEL: "fixture-model",
          ...values,
        })
      )
    )
  );
const catalog = (window: number) => ({
  data: [
    { model_info: { max_input_tokens: window }, model_name: "fixture-model" },
  ],
});

test("env override wins and never requests model metadata", async () => {
  let requests = 0;
  const server = Bun.serve({
    fetch: () => {
      requests += 1;
      return Response.json(catalog(150_000));
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await read(`${server.url.origin}/v1`, {
      OPENAI_CONTEXT_WINDOW: "16000",
      OPENAI_MAX_TOKENS: "12000",
    });
    expect(config.contextWindow).toBe(16_000);
    expect(config.contextWindowSource).toBe("override");
    expect(config.maxTokens).toBe(12_000);
    expect(config.maxTokensSource).toBe("override");
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("startup resolves the selected alias from proxy metadata, preserving URL prefixes", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      return Response.json(catalog(150_000));
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await read(`${server.url.origin}/proxy/v1`);
    expect(config.contextWindow).toBe(150_000);
    expect(config.contextWindowSource).toBe("upstream");
    expect(config.maxTokens).toBe(8192);
    expect(paths).toEqual(["/proxy/model/info", "/proxy/v1/models"]);
  } finally {
    await server.stop(true);
  }
});

test("models endpoint can announce the context when proxy metadata is unavailable", async () => {
  const server = Bun.serve({
    fetch: (request) =>
      new URL(request.url).pathname === "/v1/models"
        ? Response.json({
            data: [{ context_window: 64_000, id: "fixture-model" }],
          })
        : new Response(null, { status: 404 }),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await read(`${server.url.origin}/v1`);
    expect(config.contextWindow).toBe(64_000);
  } finally {
    await server.stop(true);
  }
});

test("shared aliases use the smallest announced deployment window", async () => {
  const server = Bun.serve({
    fetch: () =>
      Response.json({
        data: [
          {
            model_info: { max_input_tokens: 900_000 },
            model_name: "another-model",
          },
          ...catalog(150_000).data,
          ...catalog(32_000).data,
        ],
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await read(`${server.url.origin}/v1`);
    expect(config.contextWindow).toBe(32_000);
  } finally {
    await server.stop(true);
  }
});

test("missing, malformed and output-only announcements fall back to 32768", async () => {
  const responses = [
    { data: [] },
    {
      data: [
        {
          model_info: { max_output_tokens: 128_000, max_tokens: 128_000 },
          model_name: "fixture-model",
        },
      ],
    },
    {
      data: [
        { model_info: { max_input_tokens: -10 }, model_name: "fixture-model" },
      ],
    },
    {
      data: [
        { model_info: { max_input_tokens: 1.5 }, model_name: "fixture-model" },
      ],
    },
    {
      data: [
        ...catalog(150_000).data,
        {
          model_info: { max_input_tokens: "bad" },
          model_name: "fixture-model",
        },
      ],
    },
    { data: [...catalog(150_000).data, { model_name: "fixture-model" }] },
  ];
  await Promise.all(
    responses.map(async (response) => {
      const server = Bun.serve({
        fetch: () => Response.json(response),
        hostname: "127.0.0.1",
        port: 0,
      });
      try {
        const config = await read(`${server.url.origin}/v1`);
        expect(config.contextWindow).toBe(32_768);
        expect(config.contextWindowSource).toBe("fallback");
      } finally {
        await server.stop(true);
      }
    })
  );
});

test("metadata failures are sanitized and retain the 32768 context fallback", async () => {
  const server = Bun.serve({
    fetch: () => new Response("private upstream payload", { status: 403 }),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await read(`${server.url.origin}/v1`);
    expect(config.contextWindow).toBe(32_768);
  } finally {
    await server.stop(true);
  }
});

test("a stalled metadata response is bounded and falls back", async () => {
  const server = Bun.serve({
    fetch: async () => {
      await Bun.sleep(100);
      return Response.json(catalog(150_000));
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await Effect.runPromise(
      resolveModelContext(
        {
          apiKey: Redacted.make("test-key"),
          baseUrl: `${server.url.origin}/v1`,
          contextWindow: 32_768,
          contextWindowSource: "fallback",
          maxTokens: 8192,
          maxTokensSource: "fallback",
          model: "fixture-model",
        },
        20
      )
    );
    expect(config.contextWindow).toBe(32_768);
    expect(config.contextWindowSource).toBe("fallback");
  } finally {
    await server.stop(true);
  }
});

test("context and output overrides take precedence independently", async () => {
  const server = Bun.serve({
    fetch: () =>
      Response.json({
        data: [
          {
            model_info: {
              max_input_tokens: 150_000,
              max_output_tokens: 24_000,
            },
            model_name: "fixture-model",
          },
        ],
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const [announced, contextOverride, outputOverride] = await Promise.all([
      read(`${server.url.origin}/v1`),
      read(`${server.url.origin}/v1`, { OPENAI_CONTEXT_WINDOW: "64000" }),
      read(`${server.url.origin}/v1`, { OPENAI_MAX_TOKENS: "16000" }),
    ]);
    expect(announced).toMatchObject({
      contextWindow: 150_000,
      contextWindowSource: "upstream",
      maxTokens: 24_000,
      maxTokensSource: "upstream",
    });
    expect(contextOverride).toMatchObject({
      contextWindow: 64_000,
      contextWindowSource: "override",
      maxTokens: 24_000,
      maxTokensSource: "upstream",
    });
    expect(outputOverride).toMatchObject({
      contextWindow: 150_000,
      contextWindowSource: "upstream",
      maxTokens: 16_000,
      maxTokensSource: "override",
    });
  } finally {
    await server.stop(true);
  }
});

test("output-only announcements leave context at 32K and invalid output leaves it at 8K", async () => {
  const responses = [
    { data: [{ id: "fixture-model", max_output_tokens: 24_000 }] },
    {
      data: [
        {
          id: "fixture-model",
          max_input_tokens: 64_000,
          max_output_tokens: "bad",
        },
      ],
    },
  ];
  const results = await Promise.all(
    responses.map(async (response) => {
      const server = Bun.serve({
        fetch: () => Response.json(response),
        hostname: "127.0.0.1",
        port: 0,
      });
      try {
        return await read(`${server.url.origin}/v1`);
      } finally {
        await server.stop(true);
      }
    })
  );
  expect(results[0]).toMatchObject({
    contextWindow: 32_768,
    contextWindowSource: "fallback",
    maxTokens: 24_000,
    maxTokensSource: "upstream",
  });
  expect(results[1]).toMatchObject({
    contextWindow: 64_000,
    contextWindowSource: "upstream",
    maxTokens: 8192,
    maxTokensSource: "fallback",
  });
});

test("metadata endpoints can supply context and output separately", async () => {
  const server = Bun.serve({
    fetch: (request) =>
      Response.json(
        new URL(request.url).pathname === "/model/info"
          ? catalog(64_000)
          : { data: [{ id: "fixture-model", max_output_tokens: 16_000 }] }
      ),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await read(`${server.url.origin}/v1`);
    expect(config).toMatchObject({
      contextWindow: 64_000,
      contextWindowSource: "upstream",
      maxTokens: 16_000,
      maxTokensSource: "upstream",
    });
  } finally {
    await server.stop(true);
  }
});

test("shared aliases use the smallest output limit too", async () => {
  const server = Bun.serve({
    fetch: () =>
      Response.json({
        data: [
          {
            model_info: {
              max_input_tokens: 150_000,
              max_output_tokens: 32_000,
            },
            model_name: "fixture-model",
          },
          {
            model_info: { max_input_tokens: 64_000, max_output_tokens: 16_000 },
            model_name: "fixture-model",
          },
        ],
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await read(`${server.url.origin}/v1`);
    expect(config).toMatchObject({ contextWindow: 64_000, maxTokens: 16_000 });
  } finally {
    await server.stop(true);
  }
});

test("a stalled second endpoint preserves an already announced limit", async () => {
  const server = Bun.serve({
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/model/info") {
        return Response.json(catalog(64_000));
      }
      await Bun.sleep(100);
      return Response.json({ data: [] });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const config = await Effect.runPromise(
      resolveModelContext(
        {
          apiKey: Redacted.make("test-key"),
          baseUrl: `${server.url.origin}/v1`,
          contextWindow: 32_768,
          contextWindowSource: "fallback",
          maxTokens: 8192,
          maxTokensSource: "fallback",
          model: "fixture-model",
        },
        40
      )
    );
    expect(config).toMatchObject({
      contextWindow: 64_000,
      contextWindowSource: "upstream",
      maxTokens: 8192,
      maxTokensSource: "fallback",
    });
  } finally {
    await server.stop(true);
  }
});
