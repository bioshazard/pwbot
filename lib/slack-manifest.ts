import { Schema } from "effect";

const ObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownSync(ObjectSchema);
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ObjectSchema)
);

export const configureSlackManifest = (
  source: string,
  settings: { appName?: string; pollCommand: string }
) => {
  const manifest = decodeManifest(source);
  const features = decodeObject(manifest.features);
  const commands = Schema.decodeUnknownSync(Schema.Array(ObjectSchema))(
    features.slash_commands
  );
  if (commands.length !== 1) {
    throw new Error("Expected exactly one poll command in the manifest");
  }
  const configuredFeatures = {
    ...features,
    slash_commands: commands.map((command) => ({
      ...command,
      command: settings.pollCommand,
    })),
  };
  if (settings.appName === undefined) {
    return JSON.stringify({ ...manifest, features: configuredFeatures });
  }
  return JSON.stringify({
    ...manifest,
    display_information: {
      ...decodeObject(manifest.display_information),
      name: settings.appName,
    },
    features: {
      ...configuredFeatures,
      bot_user: {
        ...decodeObject(features.bot_user),
        display_name: settings.appName,
      },
    },
  });
};
