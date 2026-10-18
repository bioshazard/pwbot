import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { SlackError } from "../lib/errors";

const Result = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
  permissions_updated: Schema.optional(Schema.Boolean),
});
const program = Effect.gen(function* applyManifest() {
  const token = yield* Config.Redacted("SLACK_APP_CONFIG_TOKEN");
  const appId = yield* Config.NonEmptyString("SLACK_APP_ID");
  const fs = yield* FileSystem.FileSystem;
  const manifest = yield* fs.readFileString("slack-manifest.json");
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const result = yield* HttpClientRequest.post(
    "https://slack.com/api/apps.manifest.update"
  ).pipe(
    HttpClientRequest.setHeader(
      "Authorization",
      `Bearer ${Redacted.value(token)}`
    ),
    HttpClientRequest.bodyJsonUnsafe({ app_id: appId, manifest }),
    client.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Result))
  );
  if (result.ok !== true) {
    return yield* new SlackError({
      operation: "apps.manifest.update rejected manifest",
    });
  }
  yield* Effect.logInfo("Applied Slack manifest", {
    appId,
    permissionsUpdated: result.permissions_updated ?? false,
  });
}).pipe(
  Effect.timeout("30 seconds"),
  Effect.mapError(() => new SlackError({ operation: "apps.manifest.update" })),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(BunServices.layer)
);
BunRuntime.runMain(program);
