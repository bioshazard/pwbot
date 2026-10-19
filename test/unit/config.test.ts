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
test("development command is explicit and production keeps its default", async () => {
  const production = await read({});
  const development = await read({ POLL_COMMAND: "/dev-pwpoll" });
  expect(production.pollCommand).toBe("/pwpoll");
  expect(development.pollCommand).toBe("/dev-pwpoll");
  await expect(read({ POLL_COMMAND: "dev pwpoll" })).rejects.toBeDefined();
});
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
  expect(config.gatewayMcpUrl).toBeUndefined();
  expect(config.gatewayMcpDisabledReason).toContain("LITELLM_MCP");
  const local = await read({});
  expect(local.gatewayMcpUrl).toBeUndefined();
  const explicit = await read({
    SLACK_ARCHIVE_MCP_URL: "https://example.test/slack_archive/mcp",
  });
  expect(explicit.gatewayMcpUrl?.href).toBe(
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
    expect(config.gatewayMcpUrl).toBeUndefined();
  }
  const disabled = await read({
    SLACK_ARCHIVE_ENABLED: "false",
    SLACK_ARCHIVE_MCP_URL: "https://example.test/mcp",
  });
  expect(disabled.gatewayMcpUrl).toBeUndefined();
  const incomplete = await read({ SLACK_ARCHIVE_ENABLED: "true" });
  expect(incomplete.gatewayMcpUrl).toBeUndefined();
});

test("unified gateway endpoint derives from the model origin only when opted in", async () => {
  const enabled = await read({
    LITELLM_MCP_ENABLED: "true",
    OPENAI_API_BASE: "https://gateway.example.test/v1",
    SLACK_ARCHIVE_MCP_URL: "https://old.example.test/slack_archive/mcp",
  });
  expect(enabled.gatewayMcpUrl?.href).toBe("https://gateway.example.test/mcp");
  const explicit = await read({
    LITELLM_MCP_URL: "https://another.example.test/shared/mcp",
  });
  expect(explicit.gatewayMcpUrl?.href).toBe(
    "https://another.example.test/shared/mcp"
  );
  const disabled = await read({
    LITELLM_MCP_ENABLED: "false",
    LITELLM_MCP_URL: "https://gateway.example.test/mcp",
    SLACK_ARCHIVE_MCP_URL: "https://old.example.test/mcp",
  });
  expect(disabled.gatewayMcpUrl).toBeUndefined();
  const invalid = await read({
    LITELLM_MCP_URL: "not a URL",
    SLACK_ARCHIVE_MCP_URL: "https://old.example.test/mcp",
  });
  expect(invalid.gatewayMcpUrl).toBeUndefined();
  expect(invalid.gatewayMcpDisabledReason).toContain("LITELLM_MCP_URL");
});

test("research defaults and call deadlines are positive and independently configurable", async () => {
  const defaults = await read({});
  expect(defaults.timeoutMs).toBe(600_000);
  expect(defaults.modelTimeoutMs).toBe(90_000);
  expect(defaults.toolTimeoutMs).toBe(30_000);
  expect(defaults.maxTurns).toBe(16);
  expect(defaults.maxToolCalls).toBe(48);
  const overrides = await read({
    MODEL_CALL_TIMEOUT_MS: "100",
    TOOL_CALL_TIMEOUT_MS: "200",
  });
  expect(overrides.modelTimeoutMs).toBe(100);
  expect(overrides.toolTimeoutMs).toBe(200);
  await expect(read({ MODEL_CALL_TIMEOUT_MS: "0" })).rejects.toBeDefined();
  await expect(read({ TOOL_CALL_TIMEOUT_MS: "-1" })).rejects.toBeDefined();
});

test("DEBUG=1 enables dev tracing; default and zero keep it disabled", async () => {
  const defaults = await read({});
  const enabled = await read({ DEBUG: "1" });
  const disabled = await read({ DEBUG: "0" });
  expect(defaults.debug).toBe(false);
  expect(enabled.debug).toBe(true);
  expect(disabled.debug).toBe(false);
});

test("context defaults to 8192 and explicit overrides must be positive integers", async () => {
  const defaults = await read({});
  const override = await read({ OPENAI_CONTEXT_WINDOW: "64000" });
  expect(defaults.contextWindow).toBe(8192);
  expect(defaults.contextWindowSource).toBe("fallback");
  expect(override.contextWindow).toBe(64_000);
  expect(override.contextWindowSource).toBe("override");
  await expect(read({ OPENAI_CONTEXT_WINDOW: "0" })).rejects.toBeDefined();
  await expect(read({ OPENAI_CONTEXT_WINDOW: "1.5" })).rejects.toBeDefined();
});
