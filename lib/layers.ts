import { Effect, Layer } from "effect";

import { Replies } from "../reply";
import { BotConfig } from "./config";
import { GatewayMcp } from "./gateway-mcp";
import { LiveSlack } from "./live-slack";
import { SlackMcpCredentials } from "./slack-mcp-credentials";
import { SlackMcpSettings } from "./slack-mcp-settings";
import { Store } from "./store";
import { ToolSources } from "./tool-sources";
import type { ToolContext } from "./tool-sources";

const StorageLive = Store.layer.pipe(Layer.provide(Store.sqlLayer));
export const LiveSlackServices = Layer.unwrap(
  Effect.gen(function* selectLiveSlackAdapter() {
    const settings = yield* SlackMcpSettings;
    if (!settings.enabled) {
      yield* Effect.logWarning("Live Slack MCP disabled", {
        reason: settings.disabledReason,
      });
      return LiveSlack.disabled;
    }
    yield* Effect.logInfo(
      "Read-only live Slack MCP enabled; per-user authorization required"
    );
    return LiveSlack.layer.pipe(Layer.provide(SlackMcpCredentials.layer));
  })
).pipe(Layer.provide(SlackMcpSettings.layer));
export const ToolSourcesLive = Layer.effect(
  ToolSources,
  Effect.gen(function* composeToolSources() {
    const gateway = yield* GatewayMcp;
    const liveSlack = yield* LiveSlack;
    return {
      open: Effect.fn("ToolSources.open")(function* openToolSources(
        context: ToolContext
      ) {
        const gatewaySession = yield* gateway.open;
        const live = yield* liveSlack.open(context.teamId, context.userId);
        return {
          discover: async (signal: AbortSignal) => {
            const [gatewayTools, liveTools] = await Promise.all([
              gatewaySession.discover(signal),
              live.discover(signal),
            ]);
            return [...gatewayTools, ...liveTools];
          },
        };
      }),
    };
  })
).pipe(Layer.provide(Layer.mergeAll(GatewayMcp.layer, LiveSlackServices)));
const ServicesLive = Layer.mergeAll(StorageLive, ToolSourcesLive);
const RepliesLive = Replies.layer.pipe(Layer.provideMerge(ServicesLive));
export const AppLive = RepliesLive.pipe(
  Layer.provideMerge(BotConfig.resolvedLayer)
);
