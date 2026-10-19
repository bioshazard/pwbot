import { Config, Context, Effect, Layer, Option, Schema } from "effect";

import { fallbackContextWindow, resolveModelContext } from "./model-context";
import { optionalText } from "./optional-config";

export const pollCommandConfig = Config.schema(
  Schema.String.check(Schema.isPattern(/^\/[a-z0-9_-]+$/u)),
  "POLL_COMMAND"
).pipe(Config.withDefault("/pwpoll"));

const positiveInt = (name: string, fallback: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name).pipe(
    Config.withDefault(fallback)
  );
const readGatewayMcpConfig = (baseUrl: URL) =>
  Effect.gen(function* readGatewaySettings() {
    const enabled = yield* Config.Boolean("LITELLM_MCP_ENABLED").pipe(
      Config.option
    );
    if (Option.isSome(enabled) && !enabled.value) {
      return {
        gatewayMcpDisabledReason: "LITELLM_MCP_ENABLED=false",
        gatewayMcpUrl: undefined,
      };
    }
    const explicitUrl = yield* optionalText("LITELLM_MCP_URL");
    let rawUrl: string | undefined;
    let setting = "LITELLM_MCP_URL";
    if (Option.isSome(explicitUrl)) {
      rawUrl = explicitUrl.value;
    } else if (Option.isSome(enabled) && enabled.value) {
      rawUrl = new URL("/mcp", baseUrl).href;
    } else {
      // Preserve v2's explicitly configured single-server endpoint as a fallback.
      const legacyEnabled = yield* Config.Boolean("SLACK_ARCHIVE_ENABLED").pipe(
        Config.withDefault(true)
      );
      if (legacyEnabled) {
        rawUrl = Option.getOrUndefined(
          yield* optionalText("SLACK_ARCHIVE_MCP_URL")
        );
        setting = "SLACK_ARCHIVE_MCP_URL";
      }
    }
    if (rawUrl === undefined) {
      return {
        gatewayMcpDisabledReason:
          "Set LITELLM_MCP_ENABLED=true or LITELLM_MCP_URL",
        gatewayMcpUrl: undefined,
      };
    }
    const gatewayMcpUrl = yield* Effect.try(() => {
      const url = new URL(rawUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("MCP URL must use HTTP or HTTPS");
      }
      return url;
    }).pipe(Effect.catch(() => Effect.void));
    return {
      gatewayMcpDisabledReason:
        gatewayMcpUrl === undefined
          ? `${setting} must be an HTTP(S) URL`
          : undefined,
      gatewayMcpUrl,
    };
  });
const make = Effect.gen(function* readConfig() {
  const baseUrl = yield* Config.URL("OPENAI_API_BASE").pipe(
    Config.withDefault(new URL("https://api.openai.com/v1"))
  );
  const gateway = yield* readGatewayMcpConfig(baseUrl);
  const contextWindowOverride = yield* Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    "OPENAI_CONTEXT_WINDOW"
  ).pipe(Config.option);
  return {
    apiKey: yield* Config.Redacted("OPENAI_API_KEY"),
    ...gateway,
    baseUrl: baseUrl.href.replace(/\/$/u, ""),
    contextWindow: Option.getOrElse(
      contextWindowOverride,
      () => fallbackContextWindow
    ),
    contextWindowSource: Option.isSome(contextWindowOverride)
      ? ("override" as const)
      : ("fallback" as const),
    databasePath: yield* Config.NonEmptyString("DATABASE_PATH").pipe(
      Config.withDefault("pwbot.sqlite")
    ),
    debug: yield* Config.Boolean("DEBUG").pipe(Config.withDefault(false)),
    maxTokens: yield* positiveInt("OPENAI_MAX_TOKENS", 4096),
    maxToolCalls: yield* positiveInt("AGENT_MAX_TOOL_CALLS", 48),
    maxTurns: yield* positiveInt("AGENT_MAX_TURNS", 16),
    model: yield* Config.NonEmptyString("OPENAI_API_MODEL").pipe(
      Config.withDefault("gpt-4o")
    ),
    modelTimeoutMs: yield* positiveInt("MODEL_CALL_TIMEOUT_MS", 90_000),
    pollCommand: yield* pollCommandConfig,
    timeoutMs: yield* positiveInt("OPENAI_TIMEOUT_MS", 600_000),
    toolTimeoutMs: yield* positiveInt("TOOL_CALL_TIMEOUT_MS", 30_000),
  };
});
const resolved = make.pipe(Effect.flatMap(resolveModelContext));
export class BotConfig extends Context.Service<
  BotConfig,
  Effect.Success<typeof resolved>
>()("pwbot/Config") {
  static readonly layer = Layer.effect(BotConfig, make);
  static readonly resolvedLayer = Layer.effect(BotConfig, resolved);
}
