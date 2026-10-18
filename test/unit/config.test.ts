import { expect, test } from "bun:test";

import { ConfigProvider, Effect } from "effect";

import { BotConfig } from "../../lib/config";

const read = (values: Record<string, string>) =>
  Effect.runPromise(
    BotConfig.use(Effect.succeed).pipe(
      Effect.provide(BotConfig.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ OPENAI_API_KEY: "test", ...values })
      )
    )
  );
test("config accepts positive numeric environment strings", async () => {
  const config = await read({
    AGENT_MAX_TURNS: "3",
    OPENAI_TIMEOUT_MS: "1000",
  });
  expect(config.timeoutMs).toBe(1000);
  expect(config.maxTurns).toBe(3);
  await expect(read({ AGENT_MAX_TURNS: "0" })).rejects.toBeDefined();
  await expect(read({ OPENAI_TIMEOUT_MS: "garbage" })).rejects.toBeDefined();
});
test("archive requires an explicit URL even on a known gateway hostname", async () => {
  const config = await read({
    OPENAI_API_BASE: "http://litellm.ops.svc.cluster.local:4000/v1",
  });
  expect(config.archiveUrl).toBeUndefined();
  expect(config.archiveDisabledReason).toContain("SLACK_ARCHIVE_MCP_URL");
  const local = await read({});
  expect(local.archiveUrl).toBeUndefined();
  const explicit = await read({
    SLACK_ARCHIVE_MCP_URL: "https://example.test/slack_archive/mcp",
  });
  expect(explicit.archiveUrl?.href).toBe(
    "https://example.test/slack_archive/mcp"
  );
});

test("missing, empty and invalid optional archive configuration disables the feature", async () => {
  const configurations = await Promise.all(
    ["", "  ", "not a URL", "file:///tmp/archive"].map((url) =>
      read({ SLACK_ARCHIVE_MCP_URL: url })
    )
  );
  for (const config of configurations) {
    expect(config.archiveUrl).toBeUndefined();
  }
  const disabled = await read({
    SLACK_ARCHIVE_ENABLED: "false",
    SLACK_ARCHIVE_MCP_URL: "https://example.test/mcp",
  });
  expect(disabled.archiveUrl).toBeUndefined();
  const incomplete = await read({ SLACK_ARCHIVE_ENABLED: "true" });
  expect(incomplete.archiveUrl).toBeUndefined();
});
