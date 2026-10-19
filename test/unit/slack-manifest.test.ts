import { expect, test } from "bun:test";

import { Schema } from "effect";

import { configureSlackManifest } from "../../lib/slack-manifest";

const manifest = {
  display_information: { description: "Keep this", name: "PW Bot" },
  features: {
    assistant_view: { suggested_prompts: [] },
    bot_user: { always_online: true, display_name: "PW Bot" },
    slash_commands: [
      {
        command: "/pwpoll",
        description: "Create a poll",
        should_escape: false,
      },
    ],
  },
  oauth_config: { scopes: { bot: ["commands"], user: ["channels:read"] } },
  settings: { socket_mode_enabled: true },
};

test("development manifest overrides name and command without losing other configuration", () => {
  const result = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    configureSlackManifest(JSON.stringify(manifest), {
      appName: "PW Bot JS Dev",
      pollCommand: "/dev-pwpoll",
    })
  );
  expect(result).toEqual({
    ...manifest,
    display_information: {
      ...manifest.display_information,
      name: "PW Bot JS Dev",
    },
    features: {
      ...manifest.features,
      bot_user: {
        ...manifest.features.bot_user,
        display_name: "PW Bot JS Dev",
      },
      slash_commands: [
        { ...manifest.features.slash_commands[0], command: "/dev-pwpoll" },
      ],
    },
  });
});

test("production manifest preserves its name when only the command is supplied", () => {
  const result = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    configureSlackManifest(JSON.stringify(manifest), { pollCommand: "/pwpoll" })
  );
  expect(result).toEqual(manifest);
});

test("manifest command override rejects an ambiguous command list", () => {
  const source = JSON.stringify({
    ...manifest,
    features: { ...manifest.features, slash_commands: [] },
  });
  expect(() =>
    configureSlackManifest(source, { pollCommand: "/dev-pwpoll" })
  ).toThrow("exactly one");
});
