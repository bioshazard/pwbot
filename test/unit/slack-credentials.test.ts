import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigProvider, Effect, Layer, Redacted } from "effect";

import { SlackMcpCredentials } from "../../lib/slack-mcp-credentials";
import { slackMcpScopes } from "../../lib/slack-mcp-policy";
import { SlackMcpSettings } from "../../lib/slack-mcp-settings";

const account = {
  accessToken: Redacted.make("test-user-token"),
  appId: "ATESTAPP",
  scopes: [...slackMcpScopes],
  teamId: "TTEST",
  userId: "UTEST",
};

test("credentials persist privately and are bound to app, workspace and user", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pwbot-credentials-"));
  const layer = SlackMcpCredentials.layer.pipe(
    Layer.provide(SlackMcpSettings.layer)
  );
  const values = {
    SLACK_APP_ID: "ATESTAPP",
    SLACK_MCP_CREDENTIALS_DIR: directory,
  };
  try {
    await Effect.runPromise(
      Effect.gen(function* verifyAccountBinding() {
        const credentials = yield* SlackMcpCredentials;
        yield* credentials.save(account);
        const loaded = yield* credentials.get("TTEST", "UTEST");
        expect(loaded?.appId).toBe("ATESTAPP");
        expect(
          loaded === undefined ? undefined : Redacted.value(loaded.accessToken)
        ).toBe("test-user-token");
        expect(yield* credentials.get("TTEST", "UOTHER")).toBeUndefined();
        expect(yield* credentials.get("TOTHER", "UTEST")).toBeUndefined();
        const wrongApp = yield* Effect.exit(
          credentials.save({ ...account, appId: "AOTHERAPP" })
        );
        expect(wrongApp._tag).toBe("Failure");
        const writeGrant = yield* Effect.exit(
          credentials.save({
            ...account,
            scopes: [...account.scopes, "chat:write"],
          })
        );
        expect(writeGrant._tag).toBe("Failure");
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(values)
        )
      )
    );
    const filename = path.join(directory, "ATESTAPP-TTEST-UTEST.json");
    const directoryStat = await stat(directory);
    const fileStat = await stat(filename);
    expect(directoryStat.mode.toString(8).slice(-3)).toBe("700");
    expect(fileStat.mode.toString(8).slice(-3)).toBe("600");
    // Tampered file metadata must not escape binding checks.
    const serialized = await readFile(filename, "utf-8");
    await writeFile(filename, serialized.replace('"ATESTAPP"', '"AOTHERAPP"'));
    await expect(
      Effect.runPromise(
        SlackMcpCredentials.use((credentials) =>
          credentials.get("TTEST", "UTEST")
        ).pipe(
          Effect.provide(layer),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(values)
          )
        )
      )
    ).rejects.toBeDefined();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("earlier local filenames load only when the saved app matches configuration", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "pwbot-legacy-account-")
  );
  try {
    await writeFile(
      path.join(directory, "TTEST-UTEST.json"),
      JSON.stringify({ ...account, accessToken: "test-user-token" })
    );
    const read = (appId: string) =>
      Effect.runPromise(
        SlackMcpCredentials.use((credentials) =>
          credentials.get("TTEST", "UTEST")
        ).pipe(
          Effect.provide(
            SlackMcpCredentials.layer.pipe(
              Layer.provide(SlackMcpSettings.layer)
            )
          ),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              SLACK_APP_ID: appId,
              SLACK_MCP_CREDENTIALS_DIR: directory,
            })
          )
        )
      );
    const loaded = await read("ATESTAPP");
    expect(loaded?.userId).toBe("UTEST");
    await expect(read("AOTHERAPP")).rejects.toBeDefined();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
