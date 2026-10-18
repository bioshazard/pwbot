import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";

import { BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { updateConfigTokenEnv } from "../lib/config-token-env";
import { SlackError } from "../lib/errors";

const Rotation = Schema.Struct({
  ok: Schema.Boolean,
  refresh_token: Schema.optional(
    Schema.RedactedFromValue(Schema.NonEmptyString)
  ),
  token: Schema.optional(Schema.RedactedFromValue(Schema.NonEmptyString)),
});
const program = Effect.gen(function* refreshSlackConfig() {
  const refresh = yield* Config.Redacted("SLACK_APP_CONFIG_REFRESH_TOKEN");
  const lock = ".env.dev.slack-config.lock";
  yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const file = await open(lock, "wx", 0o600);
      await file.close();
    }),
    () =>
      Effect.promise(async () => {
        await rm(lock, { force: true });
      })
  );
  // Confirm the destination exists before consuming the single-use refresh token.
  yield* Effect.tryPromise(async () => {
    await readFile(".env.dev", "utf-8");
  });
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const result = yield* HttpClientRequest.post(
    "https://slack.com/api/tooling.tokens.rotate"
  ).pipe(
    HttpClientRequest.bodyUrlParams({ refresh_token: Redacted.value(refresh) }),
    client.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Rotation))
  );
  if (
    !result.ok ||
    result.token === undefined ||
    result.refresh_token === undefined
  ) {
    return yield* new SlackError({
      operation: "configuration token refresh rejected",
    });
  }
  const accessToken = result.token;
  const refreshToken = result.refresh_token;
  yield* Effect.tryPromise(async () => {
    const source = await readFile(".env.dev", "utf-8");
    const updated = updateConfigTokenEnv(
      source,
      Redacted.value(accessToken),
      Redacted.value(refreshToken)
    );
    const temporary = `.env.dev.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
      await rename(temporary, ".env.dev");
    } finally {
      await rm(temporary, { force: true });
    }
  });
  yield* Effect.logInfo("Refreshed Slack configuration tokens in .env.dev");
}).pipe(
  Effect.scoped,
  Effect.timeout("30 seconds"),
  Effect.mapError(
    () =>
      new SlackError({
        operation:
          "refresh configuration tokens; check .env.dev and whether another refresh is running",
      })
  ),
  Effect.provide(FetchHttpClient.layer)
);

BunRuntime.runMain(program);
