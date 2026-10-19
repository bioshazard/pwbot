import { randomBytes } from "node:crypto";

import { BunRuntime } from "@effect/platform-bun";
import {
  Clock,
  Config,
  Deferred,
  Effect,
  Layer,
  Option,
  Redacted,
} from "effect";

import { SlackMcpError } from "../lib/errors";
import { makeMcpSession } from "../lib/mcp";
import { SlackMcpCredentials } from "../lib/slack-mcp-credentials";
import {
  SlackAppId,
  acceptsSlackMcpTool,
  slackMcpUrl,
} from "../lib/slack-mcp-policy";
import { SlackMcpSettings } from "../lib/slack-mcp-settings";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackToken,
  readSlackIdentity,
  validatePublicIdentity,
} from "../lib/slack-oauth";
import { createSlackOAuthCallback } from "../lib/slack-oauth-callback";

const program = Effect.gen(function* authorizeSlack() {
  const settings = yield* SlackMcpSettings;
  const credentials = yield* SlackMcpCredentials;
  const appId = yield* Config.schema(SlackAppId, "SLACK_APP_ID");
  const redirect = yield* Config.URL("SLACK_OAUTH_REDIRECT_URI").pipe(
    Config.withDefault(new URL("http://localhost:43931/slack/oauth/callback"))
  );
  if (
    redirect.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
    redirect.port.length === 0 ||
    redirect.username.length > 0 ||
    redirect.password.length > 0 ||
    redirect.hash.length > 0
  ) {
    return yield* new SlackMcpError({
      operation:
        "OAuth CLI requires an HTTP loopback redirect with an explicit port",
    });
  }
  if (
    Option.isNone(settings.clientId) ||
    Option.isNone(settings.clientSecret)
  ) {
    return yield* new SlackMcpError({
      operation: "set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in .env.dev",
    });
  }
  const clientId = settings.clientId.value;
  const clientSecret = Redacted.value(settings.clientSecret.value);
  const bot = yield* Config.Redacted("SLACK_BOT_TOKEN");
  const botIdentity = yield* readSlackIdentity(Redacted.value(bot));
  const state = randomBytes(32).toString("hex");
  const pending = yield* Deferred.make<string, SlackMcpError>();
  const handler = createSlackOAuthCallback(redirect, state, (result) => {
    Effect.runSync(
      result.ok
        ? Deferred.succeed(pending, result.code)
        : Deferred.fail(pending, result.error)
    );
  });
  yield* Effect.acquireRelease(
    Effect.try({
      catch: () =>
        new SlackMcpError({ operation: "OAuth callback port unavailable" }),
      try: () =>
        Bun.serve({
          fetch: handler,
          hostname: "127.0.0.1",
          port: Number(redirect.port),
        }),
    }),
    (server) =>
      Effect.promise(async () => {
        await server.stop(true);
      })
  );
  yield* Effect.logInfo(
    "Open this URL and authorize read-only public Slack access; no bot permissions change:"
  );
  yield* Effect.sync(() => {
    console.log(
      buildSlackAuthorizeUrl(clientId, botIdentity.team_id, redirect, state)
        .href
    );
  });
  const code = yield* Deferred.await(pending).pipe(Effect.timeout("5 minutes"));
  const token = yield* exchangeSlackToken({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirect.href,
  });
  if (token.access_token === undefined) {
    return yield* new SlackMcpError({ operation: "missing user token" });
  }
  const identity = yield* readSlackIdentity(token.access_token).pipe(
    Effect.flatMap((current) =>
      validatePublicIdentity(current, botIdentity.team_id)
    )
  );
  if (
    (token.team !== undefined && token.team.id !== identity.team_id) ||
    (token.authed_user !== undefined &&
      token.authed_user.id !== identity.user_id) ||
    (token.expires_in !== undefined && token.refresh_token === undefined)
  ) {
    return yield* new SlackMcpError({ operation: "OAuth response binding" });
  }
  yield* credentials.save({
    accessToken: Redacted.make(token.access_token),
    appId,
    expiresAt:
      token.expires_in === undefined
        ? undefined
        : (yield* Clock.currentTimeMillis) + token.expires_in * 1000,
    refreshToken:
      token.refresh_token === undefined
        ? undefined
        : Redacted.make(token.refresh_token),
    scopes: identity.scopes,
    teamId: identity.team_id,
    userId: identity.user_id,
  });
  const session = yield* makeMcpSession({
    accept: acceptsSlackMcpTool,
    description: "Read-only live Slack public channels.",
    headers: { Authorization: `Bearer ${token.access_token}` },
    url: slackMcpUrl,
    validate: (tools) => tools.length > 0,
  });
  const tools = yield* Effect.tryPromise(
    async (signal) => await session.discover(signal)
  ).pipe(
    Effect.mapError(
      () =>
        new SlackMcpError({
          operation:
            "credential saved; enable Slack MCP Server under Agents and retry verification",
        })
    )
  );
  yield* Effect.logInfo("Live Slack MCP connected", {
    tools: tools.map((tool) => tool.name),
    userId: identity.user_id,
  });
}).pipe(
  Effect.scoped,
  Effect.provide(
    SlackMcpCredentials.layer.pipe(Layer.provideMerge(SlackMcpSettings.layer))
  )
);

BunRuntime.runMain(program);
