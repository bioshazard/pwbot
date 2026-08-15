export {};

const token = required("SLACK_APP_CONFIG_TOKEN");
const appId = required("SLACK_APP_ID");
const manifest = await Bun.file("slack-manifest.json").text();

const response = await fetch("https://slack.com/api/apps.manifest.update", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  },
  body: JSON.stringify({ app_id: appId, manifest }),
});
const result = await response.json() as {
  ok?: boolean;
  error?: string;
  errors?: Array<{ message?: string; pointer?: string }>;
  permissions_updated?: boolean;
};

if (!response.ok || !result.ok) {
  const details = result.errors?.map((error) => `${error.pointer ?? "manifest"}: ${error.message ?? "invalid"}`).join("; ");
  throw new Error(`Slack manifest update failed: ${result.error ?? response.statusText}${details ? ` (${details})` : ""}`);
}

console.log(JSON.stringify({ appId, permissionsUpdated: result.permissions_updated ?? false }));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
