import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { BotConfig } from "../lib/config";
import { ReplyError } from "../lib/errors";
import { GatewayMcp } from "../lib/gateway-mcp";
import { karmaTool, runAgent, runReplyMachine } from "../reply";

// Explicit smoke check: model + read-only archive status, never Slack messages or live karma writes.
const program = Effect.gen(function* verifyGateway() {
  const config = yield* BotConfig;
  const archive = yield* GatewayMcp;
  const session = yield* archive.open;
  let karmaCalls = 0;
  let archiveCalls = 0;
  const text = yield* runReplyMachine({
    discover: session.discover,
    generate: async (tools, signal) => {
      const status = tools.find((tool) => tool.name.endsWith("archive_status"));
      if (status === undefined) {
        throw new ReplyError({ reason: "discovery" });
      }
      return await runAgent({
        config,
        signal,
        thread: `First use ${status.name} to check archive status. Then use getKarma for <@UTEST> and reply with the karma score. Do not search or retrieve messages.`,
        tools: [
          karmaTool(() =>
            Effect.sync(() => {
              karmaCalls += 1;
              return 17;
            })
          ),
          {
            ...status,
            execute: async (id, args, toolSignal, onUpdate) => {
              const result = await status.execute(
                id,
                args,
                toolSignal,
                onUpdate
              );
              archiveCalls += 1;
              return result;
            },
          },
        ],
        userId: "UTEST",
      });
    },
  }).pipe(
    Effect.timeout("120 seconds"),
    Effect.tapError((error) =>
      Effect.logWarning("Gateway smoke failed", {
        archiveCalls,
        karmaCalls,
        reason: error._tag,
      })
    )
  );
  if (archiveCalls === 0 || karmaCalls === 0 || !text.includes("17")) {
    return yield* new ReplyError({ reason: "model" });
  }
  yield* Effect.logInfo("Gateway verified", {
    archiveStatus: true,
    karmaTool: true,
    modelReply: true,
  });
}).pipe(
  Effect.scoped,
  Effect.mapError(() => new ReplyError({ reason: "model" })),
  Effect.provide(
    GatewayMcp.layer.pipe(Layer.provideMerge(BotConfig.resolvedLayer))
  )
);

BunRuntime.runMain(program);
