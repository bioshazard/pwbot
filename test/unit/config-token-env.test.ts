import { expect, test } from "bun:test";

import { updateConfigTokenEnv } from "../../lib/config-token-env";

test("rotation replaces both tokens and removes duplicate dotenv assignments", () => {
  const source =
    '# keep\nSLACK_BOT_TOKEN="unchanged"\nexport SLACK_APP_CONFIG_TOKEN="old"\nSLACK_APP_CONFIG_TOKEN=duplicate\nSLACK_APP_CONFIG_REFRESH_TOKEN=old-refresh\n';
  const result = updateConfigTokenEnv(source, "new-access", "new-refresh");
  expect(result).toBe(
    '# keep\nSLACK_BOT_TOKEN="unchanged"\nSLACK_APP_CONFIG_TOKEN="new-access"\nSLACK_APP_CONFIG_REFRESH_TOKEN="new-refresh"\n'
  );
});

test("rotation appends missing keys and preserves Windows line endings", () => {
  const result = updateConfigTokenEnv("# config\r\n", "access", "refresh");
  expect(result).toBe(
    '# config\r\nSLACK_APP_CONFIG_TOKEN="access"\r\nSLACK_APP_CONFIG_REFRESH_TOKEN="refresh"\r\n'
  );
});
