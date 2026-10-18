import { Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { SlackMcpError } from "./errors";
import {
  isReadOnlyPublicGrant,
  SlackId,
  SlackAppId,
  slackMcpScopes,
} from "./slack-mcp-policy";

const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.NonEmptyString),
  authed_user: Schema.optional(
    Schema.Struct({ id: SlackId, scope: Schema.optional(Schema.String) })
  ),
  expires_in: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  ok: Schema.optional(Schema.Boolean),
  refresh_token: Schema.optional(Schema.NonEmptyString),
  scope: Schema.optional(Schema.String),
  team: Schema.optional(Schema.Struct({ id: SlackId })),
  token_type: Schema.optional(Schema.String),
});

const Identity = Schema.Struct({
  bot_id: Schema.optional(Schema.String),
  ok: Schema.Boolean,
  team_id: SlackId,
  user_id: SlackId,
});

export const SlackMcpAccount = Schema.Struct({
  accessToken: Schema.RedactedFromValue(Schema.NonEmptyString),
  appId: SlackAppId,
  expiresAt: Schema.optional(Schema.Number),
  refreshToken: Schema.optional(
    Schema.RedactedFromValue(Schema.NonEmptyString)
  ),
  scopes: Schema.Array(Schema.String),
  teamId: SlackId,
  userId: SlackId,
});
export type SlackMcpAccount = typeof SlackMcpAccount.Type;

export const readSlackIdentity = Effect.fn("SlackOAuth.identity")(
  function* readSlackIdentity(token: string) {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk
    );
    const response = yield* client.post("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const identity =
      yield* HttpClientResponse.schemaBodyJson(Identity)(response);
    if (!identity.ok) {
      return yield* new SlackMcpError({ operation: "identity rejected" });
    }
    return {
      ...identity,
      scopes: (response.headers["x-oauth-scopes"] ?? "")
        .split(/[ ,]+/u)
        .filter(Boolean),
    };
  },
  Effect.timeout("30 seconds"),
  Effect.mapError(() => new SlackMcpError({ operation: "identity" })),
  Effect.provide(FetchHttpClient.layer)
);

export const exchangeSlackToken = Effect.fn("SlackOAuth.exchange")(
  function* exchangeSlackToken(params: Readonly<Record<string, string>>) {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk
    );
    const response = yield* HttpClientRequest.post(
      "https://slack.com/api/oauth.v2.user.access"
    ).pipe(HttpClientRequest.bodyUrlParams(params), client.execute);
    const token =
      yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response);
    if (
      token.ok !== true ||
      token.access_token === undefined ||
      (token.token_type !== "user" &&
        token.token_type?.toLowerCase() !== "bearer")
    ) {
      return yield* new SlackMcpError({ operation: "token exchange rejected" });
    }
    return token;
  },
  Effect.timeout("30 seconds"),
  Effect.mapError(() => new SlackMcpError({ operation: "token exchange" })),
  Effect.provide(FetchHttpClient.layer)
);

export const validatePublicIdentity = (
  identity: Effect.Success<ReturnType<typeof readSlackIdentity>>,
  expectedTeam: string,
  expectedUser?: string
) => {
  if (
    identity.bot_id !== undefined ||
    identity.team_id !== expectedTeam ||
    (expectedUser !== undefined && identity.user_id !== expectedUser) ||
    !isReadOnlyPublicGrant(identity.scopes)
  ) {
    return Effect.fail(
      new SlackMcpError({
        operation: "user, workspace or read-only scopes mismatch",
      })
    );
  }
  return Effect.succeed(identity);
};

export const buildSlackAuthorizeUrl = (
  clientId: string,
  teamId: string,
  redirect: URL,
  state: string
) => {
  const url = new URL("https://slack.com/oauth/v2_user/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect.href,
    response_type: "code",
    scope: slackMcpScopes.join(","),
    state,
    team: teamId,
  }).toString();
  return url;
};
