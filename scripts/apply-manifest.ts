import { env } from "node:process";

import { z } from "zod";

const required = (name: string): string => {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const manifestResultSchema = z.object({
  error: z.string().optional(),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        pointer: z.string().optional(),
      })
    )
    .optional(),
  ok: z.boolean().optional(),
  permissions_updated: z.boolean().optional(),
});

const token = required("SLACK_APP_CONFIG_TOKEN");
const appId = required("SLACK_APP_ID");
const manifest = await Bun.file("slack-manifest.json").text();

const response = await fetch("https://slack.com/api/apps.manifest.update", {
  body: JSON.stringify({ app_id: appId, manifest }),
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  },
  method: "POST",
});
const result = manifestResultSchema.parse(await response.json());

if (!response.ok || result.ok !== true) {
  const details = result.errors
    ?.map(
      (error) => `${error.pointer ?? "manifest"}: ${error.message ?? "invalid"}`
    )
    .join("; ");
  throw new Error(
    `Slack manifest update failed: ${result.error ?? response.statusText}${details === undefined || details.length === 0 ? "" : ` (${details})`}`
  );
}

console.log(
  JSON.stringify({
    appId,
    permissionsUpdated: result.permissions_updated ?? false,
  })
);
