# Kubernetes preparation

`kubernetes.yaml` is a generic example, not the source of truth for an existing
cluster. No cluster changes are made by builds or tests. Reconcile the example
with your existing infrastructure source of truth before cutover.

Before applying anything:

1. Publish the checked image and replace `pwbot:release` with its verified digest.
2. Keep one replica and `Recreate`; preserve an existing pod's SQLite with a
   consistent SQLite backup before replacing it. Restore and verify that backup
   on the PVC before starting the new version. Preserve the PVC for rollback.
3. Supply `pwbot-secrets` in the target namespace with `SLACK_BOT_TOKEN`,
   `SLACK_APP_TOKEN`, and `OPENAI_API_KEY`. Add `OPENAI_API_BASE` and
   `OPENAI_API_MODEL` for a compatible gateway. These tokens choose the Slack
   app and workspace; no app or workspace ID is built into the runtime.
4. For unified gateway tools, add `LITELLM_MCP_ENABLED=true` to that Secret.
   The endpoint derives as `/mcp` on `OPENAI_API_BASE`'s origin. Alternatively set
   `LITELLM_MCP_URL` explicitly. The existing `OPENAI_API_KEY` determines which
   servers/tools are available; discovery refreshes for each reply. Legacy
   `SLACK_ARCHIVE_MCP_URL` remains a scoped-endpoint fallback. Unconfigured
   gateway tools are disabled with a startup warning.
5. Optionally supply `pwbot-slack-mcp` with `SLACK_APP_ID`, `SLACK_CLIENT_ID`,
   and `SLACK_CLIENT_SECRET`, all belonging to the same app as the bot token.
   Missing credentials disable live MCP with a startup warning. Do not copy
   local configuration/refresh tokens into the runtime Secret.
6. For live MCP, enable Slack's MCP Server feature on that app, register the
   OAuth redirect, and authorize each user with `bun run slack:authorize` on a
   trusted workstation. Provision the resulting private JSON account files on
   the PVC at `/data/slack-mcp`, owned by UID/GID 1000, directory mode `0700`
   and files `0600`. Keep this directory writable for refresh-token rotation;
   mounting rotating credentials directly from a read-only Secret will fail.
   Credentials are bound to app, workspace, and requesting user. An existing grant
   cannot be used with another Slack app's bot token; authorize that app separately.
7. Confirm the selected Slack app has the manifest's bot scopes, including
   `reactions:write`, and has been reinstalled after scope changes. Avoid two
   active runtimes using the same Slack app credentials.

The image runs as UID/GID 1000. Both SQLite and OAuth account files persist under
`/data`; the example uses a PVC and a read-only root filesystem. Socket Mode
requires outbound Slack HTTPS/WebSocket access, gateway access, and DNS, but no
Service or public ingress. Preserve your cluster's existing network policy.
Allow outbound `mcp.slack.com` and Slack OAuth endpoints when live MCP is enabled.

Missing per-user grants and unavailable optional MCP servers produce warnings
and omit those tools; normal replies, polls, and karma continue. Invalid required
configuration, unusable SQLite storage, and Slack authentication errors still
fail startup. Startup feature logs describe configured adapters; they do not
claim that every user has granted OAuth or that an external server is healthy.

Run `bun run check` and `bun run test`, build the image, and verify it using a
writable `/data` mount before cutover. After a deliberate deployment, check the
Slack identity and startup logs, persisted state, gateway/tool calls, and an
actual reply. This repository does not automatically deploy to Kubernetes.
