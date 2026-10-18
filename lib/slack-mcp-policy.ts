import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Schema } from "effect";

export const slackMcpUrl = new URL("https://mcp.slack.com/mcp");
export const slackMcpScopes = [
  "channels:history",
  "channels:read",
  "search:read.public",
] as const;
const slackMcpTools = new Set([
  "slack_read_channel",
  "slack_read_thread",
  "slack_search_channels",
  "slack_search_public",
]);
export const acceptsSlackMcpTool = (tool: Pick<Tool, "name" | "annotations">) =>
  slackMcpTools.has(tool.name) && tool.annotations?.readOnlyHint !== false;
export const SlackId = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9]+$/u)
);
export const SlackAppId = Schema.String.check(
  Schema.isPattern(/^A[A-Z0-9]+$/u)
);

const allowedScopes = new Set<string>([...slackMcpScopes, "identify"]);
export const isReadOnlyPublicGrant = (scopes: readonly string[]) =>
  slackMcpScopes.every((scope) => scopes.includes(scope)) &&
  scopes.every((scope) => allowedScopes.has(scope));
