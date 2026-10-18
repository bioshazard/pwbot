import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
} from "effect";

import { SlackMcpError } from "./errors";
import { SlackAppId, SlackId, isReadOnlyPublicGrant } from "./slack-mcp-policy";
import { SlackMcpSettings } from "./slack-mcp-settings";
import {
  exchangeSlackToken,
  readSlackIdentity,
  SlackMcpAccount,
  validatePublicIdentity,
} from "./slack-oauth";

const fileError = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.String })
);
const make = Effect.gen(function* makeSlackMcpCredentials() {
  const settings = yield* SlackMcpSettings;
  const mutex = yield* Semaphore.make(1);
  const pathFor = (appId: string, teamId: string, userId: string) =>
    nodePath.resolve(
      settings.credentialsDirectory,
      `${Schema.decodeUnknownSync(SlackAppId)(appId)}-${Schema.decodeUnknownSync(SlackId)(teamId)}-${Schema.decodeUnknownSync(SlackId)(userId)}.json`
    );
  const readCredential = (path: string) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await readFile(path, "utf-8"),
    }).pipe(
      // oxlint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- Effect's typed error channel handles filesystem failures.
      Effect.catch((error) =>
        Option.getOrUndefined(fileError(error))?.code === "ENOENT"
          ? Effect.void
          : Effect.fail(new SlackMcpError({ operation: "read credential" }))
      )
    );
  const load = Effect.fn("SlackMcpCredentials.load")(
    function* loadAccount(teamId: string, userId: string) {
      if (Option.isNone(settings.appId)) {
        return yield* new SlackMcpError({
          operation: "SLACK_APP_ID is required",
        });
      }
      const appId = settings.appId.value;
      const path = yield* Effect.try({
        catch: () => new SlackMcpError({ operation: "account identity" }),
        try: () => pathFor(appId, teamId, userId),
      });
      const current = yield* readCredential(path);
      // Earlier local credentials omitted app ID from filenames. Binding is still checked below.
      const raw =
        current ??
        (yield* readCredential(
          nodePath.resolve(
            settings.credentialsDirectory,
            `${teamId}-${userId}.json`
          )
        ));
      if (raw === undefined) {
        return;
      }
      const account = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(SlackMcpAccount)
      )(raw);
      if (
        account.appId !== appId ||
        account.teamId !== teamId ||
        account.userId !== userId ||
        !isReadOnlyPublicGrant(account.scopes)
      ) {
        return yield* new SlackMcpError({ operation: "credential binding" });
      }
      return account;
    },
    Effect.mapError(() => new SlackMcpError({ operation: "read credential" }))
  );

  const save = Effect.fn("SlackMcpCredentials.save")(
    function* saveAccount(account: SlackMcpAccount) {
      if (
        Option.isNone(settings.appId) ||
        account.appId !== settings.appId.value
      ) {
        return yield* new SlackMcpError({
          operation: "credential app binding",
        });
      }
      if (!isReadOnlyPublicGrant(account.scopes)) {
        return yield* new SlackMcpError({ operation: "credential scopes" });
      }
      const path = yield* Effect.try({
        catch: () => new SlackMcpError({ operation: "account identity" }),
        try: () => pathFor(account.appId, account.teamId, account.userId),
      });
      const serialized = yield* Schema.encodeEffect(
        Schema.fromJsonString(SlackMcpAccount)
      )(account);
      yield* Effect.tryPromise(async () => {
        await mkdir(settings.credentialsDirectory, {
          mode: 0o700,
          recursive: true,
        });
        await chmod(settings.credentialsDirectory, 0o700);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
    Effect.mapError(() => new SlackMcpError({ operation: "save credential" }))
  );

  const get = Effect.fn("SlackMcpCredentials.get")(function* getAccount(
    teamId: string,
    userId: string
  ) {
    const account = yield* load(teamId, userId);
    if (account === undefined) {
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    if (account.expiresAt === undefined || account.expiresAt > now + 60_000) {
      return account;
    }
    if (
      account.refreshToken === undefined ||
      Option.isNone(settings.clientId) ||
      Option.isNone(settings.clientSecret)
    ) {
      return yield* new SlackMcpError({
        operation: "reauthorization required",
      });
    }
    const token = yield* exchangeSlackToken({
      client_id: settings.clientId.value,
      client_secret: Redacted.value(settings.clientSecret.value),
      grant_type: "refresh_token",
      refresh_token: Redacted.value(account.refreshToken),
    });
    if (
      token.access_token === undefined ||
      token.expires_in === undefined ||
      token.refresh_token === undefined
    ) {
      return yield* new SlackMcpError({
        operation: "invalid rotated credential",
      });
    }
    const identity = yield* readSlackIdentity(token.access_token).pipe(
      Effect.flatMap((current) =>
        validatePublicIdentity(current, teamId, userId)
      )
    );
    const refreshed: SlackMcpAccount = {
      ...account,
      accessToken: Redacted.make(token.access_token),
      expiresAt: (yield* Clock.currentTimeMillis) + token.expires_in * 1000,
      refreshToken: Redacted.make(token.refresh_token),
      scopes: identity.scopes,
    };
    yield* save(refreshed);
    return refreshed;
  }, Semaphore.withPermit(mutex));
  return { get, save };
});

export class SlackMcpCredentials extends Context.Service<
  SlackMcpCredentials,
  Effect.Success<typeof make>
>()("pwbot/SlackMcpCredentials") {
  static readonly layer = Layer.effect(SlackMcpCredentials, make);
}
