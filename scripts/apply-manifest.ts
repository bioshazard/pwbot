import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { pollCommandConfig } from "../lib/config";
import { SlackError } from "../lib/errors";
import { optionalText } from "../lib/optional-config";
import { configureSlackManifest } from "../lib/slack-manifest";

const Result = Schema.Struct({
  error: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z_]+$/u))),
  ok: Schema.optional(Schema.Boolean),
  permissions_updated: Schema.optional(Schema.Boolean),
});
const program = Effect.gen(function* applyManifest() {
  const token = yield* Config.Redacted("SLACK_APP_CONFIG_TOKEN");
  const appId = yield* Config.NonEmptyString("SLACK_APP_ID");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Config.NonEmptyString("SLACK_MANIFEST_PATH").pipe(
    Config.withDefault("slack-manifest.json")
  );
  const source = yield* fs.readFileString(path);
  const pollCommand = yield* pollCommandConfig;
  const appName = Option.getOrUndefined(yield* optionalText("SLACK_APP_NAME"));
  const manifest = yield* Effect.try(() =>
    configureSlackManifest(source, { appName, pollCommand })
  );
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const validation = yield* HttpClientRequest.post(
    "https://slack.com/api/apps.manifest.validate"
  ).pipe(
    HttpClientRequest.setHeader(
      "Authorization",
      `Bearer ${Redacted.value(token)}`
    ),
    HttpClientRequest.bodyJsonUnsafe({ app_id: appId, manifest }),
    client.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Result))
  );
  if (validation.ok !== true) {
    yield* Effect.logError("Slack manifest validation rejected", {
      error: validation.error ?? "invalid_manifest",
    });
    return yield* new SlackError({ operation: "apps.manifest.validate" });
  }
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
    yield* Effect.logError("Slack manifest update rejected", {
      error: result.error ?? "unknown",
    });
    return yield* new SlackError({
      operation: "apps.manifest.update rejected manifest",
    });
  }
  yield* Effect.logInfo("Applied Slack manifest", {
    appId,
    appName,
    permissionsUpdated: result.permissions_updated ?? false,
    pollCommand,
  });
}).pipe(
  Effect.timeout("30 seconds"),
  Effect.mapError(() => new SlackError({ operation: "apps.manifest.update" })),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(BunServices.layer)
);
BunRuntime.runMain(program);
