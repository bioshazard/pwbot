import { expect, test } from "bun:test";

import { ConfigProvider, Effect, Layer, Option } from "effect";

import { BotConfig } from "../../lib/config";
import { ToolSourcesLive } from "../../lib/layers";
import { SlackMcpSettings } from "../../lib/slack-mcp-settings";
import { ToolSources } from "../../lib/tool-sources";

const configured = {
  SLACK_APP_ID: "ATESTAPP",
  SLACK_CLIENT_ID: "test-client",
  SLACK_CLIENT_SECRET: "test-secret",
};
const provider = (values: Record<string, string>) =>
  ConfigProvider.fromUnknown({ OPENAI_API_KEY: "test", ...values });
const settings = (values: Record<string, string>) =>
  Effect.runPromise(
    SlackMcpSettings.use(Effect.succeed).pipe(
      Effect.provide(SlackMcpSettings.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, provider(values))
    )
  );

test("live Slack requires complete app credentials and honors explicit disable", async () => {
  const [absent, partial, blank, invalid, enabled, disabled] =
    await Promise.all([
      settings({}),
      settings({ SLACK_APP_ID: "ATESTAPP" }),
      settings({ ...configured, SLACK_CLIENT_SECRET: "  " }),
      settings({ ...configured, SLACK_APP_ID: "../bad" }),
      settings(configured),
      settings({ ...configured, SLACK_LIVE_MCP_ENABLED: "false" }),
    ]);
  expect(absent.enabled).toBe(false);
  expect(partial.enabled).toBe(false);
  expect(blank.enabled).toBe(false);
  expect(invalid.enabled).toBe(false);
  expect(enabled.enabled).toBe(true);
  expect(Option.getOrUndefined(enabled.appId)).toBe("ATESTAPP");
  expect(disabled.enabled).toBe(false);
});

test("missing optional integrations select empty adapters without requesting credentials", async () => {
  const tools = await Effect.runPromise(
    Effect.gen(function* discoverDisabledTools() {
      const sources = yield* ToolSources;
      const session = yield* sources.open({ teamId: "TTEST", userId: "UTEST" });
      return yield* Effect.tryPromise(
        async (signal) => await session.discover(signal)
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ToolSourcesLive.pipe(Layer.provide(BotConfig.layer))),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        provider({ SLACK_MCP_CREDENTIALS_DIR: "/does-not-exist" })
      )
    )
  );
  expect(tools).toEqual([]);
});

test("an unavailable configured archive omits its tools rather than blocking replies", async () => {
  const server = Bun.serve({
    fetch: () => new Response(null, { status: 503 }),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const tools = await Effect.runPromise(
      Effect.gen(function* discoverUnavailableTools() {
        const sources = yield* ToolSources;
        const session = yield* sources.open({
          teamId: "TTEST",
          userId: "UTEST",
        });
        return yield* Effect.tryPromise(
          async (signal) => await session.discover(signal)
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(ToolSourcesLive.pipe(Layer.provide(BotConfig.layer))),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          provider({ SLACK_ARCHIVE_MCP_URL: `${server.url.origin}/mcp` })
        )
      )
    );
    expect(tools).toEqual([]);
  } finally {
    await server.stop(true);
  }
});
