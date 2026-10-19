import { Config, Context, Effect, Layer, Option, Schema } from "effect";

import { optionalSecret, optionalText } from "./optional-config";
import { SlackAppId } from "./slack-mcp-policy";

const make = Effect.gen(function* readSlackMcpSettings() {
  const appId = (yield* optionalText("SLACK_APP_ID")).pipe(
    Option.flatMap(Schema.decodeUnknownOption(SlackAppId))
  );
  const clientId = yield* optionalText("SLACK_CLIENT_ID");
  const clientSecret = yield* optionalSecret("SLACK_CLIENT_SECRET");
  const requested = yield* Config.Boolean("SLACK_LIVE_MCP_ENABLED").pipe(
    Config.withDefault(true)
  );
  const missing = [
    ...(Option.isNone(appId) ? ["SLACK_APP_ID"] : []),
    ...(Option.isNone(clientId) ? ["SLACK_CLIENT_ID"] : []),
    ...(Option.isNone(clientSecret) ? ["SLACK_CLIENT_SECRET"] : []),
  ];
  return {
    appId,
    clientId,
    clientSecret,
    credentialsDirectory: Option.getOrElse(
      yield* optionalText("SLACK_MCP_CREDENTIALS_DIR"),
      () => ".slack-mcp"
    ),
    disabledReason: requested
      ? `Missing ${missing.join(", ")}`
      : "SLACK_LIVE_MCP_ENABLED=false",
    enabled: requested && missing.length === 0,
  };
});

export class SlackMcpSettings extends Context.Service<
  SlackMcpSettings,
  Effect.Success<typeof make>
>()("pwbot/SlackMcpSettings") {
  static readonly layer = Layer.effect(SlackMcpSettings, make);
}
