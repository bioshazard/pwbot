import { Config, Context, Effect, Layer, Option, Schema } from "effect";

import { optionalText } from "./optional-config";

const positiveInt = (name: string, fallback: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name).pipe(
    Config.withDefault(fallback)
  );
const make = Effect.gen(function* readConfig() {
  const baseUrl = yield* Config.URL("OPENAI_API_BASE").pipe(
    Config.withDefault(new URL("https://api.openai.com/v1"))
  );
  const archiveEnabled = yield* Config.Boolean("SLACK_ARCHIVE_ENABLED").pipe(
    Config.withDefault(true)
  );
  const archiveUrl = archiveEnabled
    ? yield* optionalText("SLACK_ARCHIVE_MCP_URL")
    : Option.none<string>();
  const resolvedArchiveUrl = Option.isSome(archiveUrl)
    ? yield* Effect.try(() => {
        const url = new URL(archiveUrl.value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new TypeError("MCP URL must use HTTP or HTTPS");
        }
        return url;
      }).pipe(Effect.catch(() => Effect.void))
    : undefined;
  let archiveDisabledReason: string | undefined;
  if (!archiveEnabled) {
    archiveDisabledReason = "SLACK_ARCHIVE_ENABLED=false";
  } else if (Option.isNone(archiveUrl)) {
    archiveDisabledReason = "SLACK_ARCHIVE_MCP_URL is not set";
  } else if (resolvedArchiveUrl === undefined) {
    archiveDisabledReason = "SLACK_ARCHIVE_MCP_URL must be an HTTP(S) URL";
  }
  return {
    apiKey: yield* Config.Redacted("OPENAI_API_KEY"),
    archiveDisabledReason,
    archiveUrl: resolvedArchiveUrl,
    baseUrl: baseUrl.href.replace(/\/$/u, ""),
    contextWindow: yield* positiveInt("OPENAI_CONTEXT_WINDOW", 32_768),
    databasePath: yield* Config.NonEmptyString("DATABASE_PATH").pipe(
      Config.withDefault("pwbot.sqlite")
    ),
    maxTokens: yield* positiveInt("OPENAI_MAX_TOKENS", 4096),
    maxToolCalls: yield* positiveInt("AGENT_MAX_TOOL_CALLS", 24),
    maxTurns: yield* positiveInt("AGENT_MAX_TURNS", 8),
    model: yield* Config.NonEmptyString("OPENAI_API_MODEL").pipe(
      Config.withDefault("gpt-4o")
    ),
    pollCommand: yield* Config.NonEmptyString("POLL_COMMAND").pipe(
      Config.withDefault("/pwpoll")
    ),
    timeoutMs: yield* positiveInt("OPENAI_TIMEOUT_MS", 120_000),
  };
});
export class BotConfig extends Context.Service<
  BotConfig,
  Effect.Success<typeof make>
>()("pwbot/Config") {
  static readonly layer = Layer.effect(BotConfig, make);
}
