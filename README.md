# PW Bot

Socket Mode Slack bot: DMs, mentions, karma, and polls.

DMs and mentions receive 👀 before thread retrieval and generation. Tool execution
adds 🔍; streamed answer text switches to ✍️. Research may resume after text.
Repeated stages do not repeat reaction calls. After a successful reply posts, the
bot adds ✅. Every terminal path removes active reactions; failure responses do
not mark success. Reaction errors never prevent replies. Grant the
bot `reactions:write` and reinstall the Slack app after updating its manifest.
The bot ignores its own reactions when updating karma.

## Application architecture

Effect **4.0.5** owns configuration, services, typed errors, SQLite transactions,
and resource scopes. XState **5.33.3** runs each reply through discovery → generation
→ success/failure. Pi agent-core and Pi AI **1.3.0** own the model/tool loop and
OpenAI-compatible transport, using the current `@earendil-works` packages.

- `main.ts`: BunRuntime entry point and layer composition.
- `slack.ts`: Bolt adapter; event fibers belong to the application scope.
- `reply.ts`, `lib/reply-machine.ts`: per-reply Pi agent and XState lifecycle.
- `lib/tool-sources.ts`: capability port consumed by reply generation.
- `lib/layers.ts`: selects and composes enabled/disabled tool-source adapters.
- `lib/gateway-mcp.ts`, `lib/live-slack.ts`: optional MCP adapters; core reply logic
  does not import either adapter or read their environment configuration.
- `lib/store.ts`, `lib/migrations.ts`: Effect SQL repository and SQLite migration.
- `lib/poll-ui.ts`: poll blocks and modal helpers.

SIGINT/SIGTERM interrupt event fibers, stop agents, close MCP sessions, stop Bolt,
and close SQLite. Logs go to stdout. Provider errors are sanitized; keys and
private tool responses are not logged.

## Setup

```sh
bun install --frozen-lockfile
```

Copy [.env.example](.env.example) to `.env.dev` and set `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`, and `OPENAI_API_KEY`. These are required. Missing or empty
optional integration settings disable that adapter with a startup warning.
Optional configuration:

| Variable | Default |
| --- | --- |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` |
| `OPENAI_API_MODEL` | `gpt-4o` |
| `OPENAI_TIMEOUT_MS` | `600000`, discovery and the entire agent run |
| `MODEL_CALL_TIMEOUT_MS` | `90000`, each model request including streaming |
| `TOOL_CALL_TIMEOUT_MS` | `30000`, each tool execution |
| `OPENAI_MAX_TOKENS` | `4096` |
| `OPENAI_CONTEXT_WINDOW` | `32768`; set to actual gateway/model limit (including for dev) |
| `AGENT_MAX_TURNS` | `16` provider requests per reply |
| `AGENT_MAX_TOOL_CALLS` | `48` attempted tools per reply, including invalid calls |
| `DEBUG` | `false`; set `1` for correlated reply lifecycle/tool/stage diagnostics |
| `DATABASE_PATH` | `pwbot.sqlite` |
| `POLL_COMMAND` | `/pwpoll` |
| `LITELLM_MCP_ENABLED` | Unset; `true` derives `/mcp` from the model gateway origin, `false` disables gateway tools |
| `LITELLM_MCP_URL` | Optional explicit MCP endpoint; enables tools unless explicitly disabled |
| `SLACK_ARCHIVE_MCP_URL`, `SLACK_ARCHIVE_ENABLED` | Legacy scoped-endpoint fallback when new gateway settings are absent |
| `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | All three required to enable live Slack MCP |
| `SLACK_LIVE_MCP_ENABLED` | `false` disables live Slack MCP even when configured |
| `SLACK_MCP_CREDENTIALS_DIR` | `.slack-mcp` locally; image uses `/data/slack-mcp` |
| `SLACK_OAUTH_REDIRECT_URI` | Local OAuth CLI only: `http://localhost:43931/slack/oauth/callback` |

```sh
bun start
bun run check
bun run test
```

Tests use local protocol servers and in-memory databases; no credentials or Slack
messages. `bun run test:greeting` explicitly opts into a real completion using
`.env.dev`, with an in-memory database. It does not send a Slack message. `bun run verify:gateway` uses explicitly supplied
environment configuration to check read-only archive status and a model-driven
karma call against an in-memory fixture, without loading dotenv or writing Slack.

## Long replies and recovery

Release one of issue #4 covers bounded in-process replies and progress. The
10-minute deadline includes discovery and generation; thread retrieval and Slack
posting use their transport defaults. Model requests have a separate 90-second
wall-clock limit; tool executions have a 30-second limit. MCP discovery/calls also
retain the SDK's 30-second limit, so raising the tool limit cannot extend MCP's
own deadline. The first limit reached wins. Configure `OPENAI_CONTEXT_WINDOW` to
match the actual model behind the gateway alias. Pi estimates input size and reserves
4096 safety tokens, then clamps the request's output budget to remaining context.
Before sending, the bot requires room for at least `min(OPENAI_MAX_TOKENS, 1024)`
answer tokens. Smaller budgets fail distinctly as context exhaustion instead of
silently requesting a one-token answer. `DEBUG=1` logs configured/effective output
budgets for each request. A provider's `length` stop remains output exhaustion;
it is not automatically retried because tool arguments may be incomplete. Tool
batches that exceed the remaining budget stop before executing that batch. Sixteen turns and 48 attempted calls
allow multi-step research while bounding repeated invalid requests. Narrow the
question or explicitly raise the relevant limit when a legitimate run exhausts it.

Deadline, model stall, tool stall, output-token exhaustion, research budget
exhaustion and upstream failure produce distinct safe outcomes. Raw upstream errors never enter logs or failure
replies. With `DEBUG=1`, correlated diagnostics record the original
channel/message/thread IDs, discovery, tool starts/completion, progress stages,
delivery, cleanup, model
duration, stop reason, token counts and call count. Message bodies and tool
arguments/results are excluded. Set `DEBUG=1` in `.env.dev` and restart the process
after changing it. Upstream error diagnostics retain only a fixed category and
numeric HTTP status; error text is discarded. MCP argument rejection gives
schema-oriented correction guidance without echoing private error payloads. Partial findings are not published on failure;
they may be incomplete. Cancellation is currently process shutdown or scoped
interruption; there is no user cancellation command. It aborts supported SDK work,
blocks further calls, and clears active reactions. An SDK that ignores abort may
continue its in-flight operation; the bot does not wait indefinitely for it.

Bolt acknowledges ordinary Events API messages before invoking listeners
(verified against the installed `App.processEvent` implementation). That transport
acknowledgement does not mean the reply completed or that work is durable. Event
claims suppress duplicates while work is active and after successful handling;
failed/interrupted handlers release their claims. Concurrent replies run
independently; there is no global concurrency cap or per-thread queue yet.

No durable job queue is included in this release. A hard crash can leave a claimed
event without a reply or leave an active reaction behind. On restart, work is not
resumed; do not replay events or clear claims blindly. Check the original thread
for delivery, remove a stale bot status reaction if needed, then submit a fresh
request. A crash after posting but before recording completion can cause a retry
to post a duplicate. No exactly-once delivery guarantee is made.

Before a durable-job release, persist a job ID/event ID, original thread and
explicit queued/running/ready/delivering/delivered/failed/cancelled state in SQLite
before announcing acceptance. Add unique event constraints, bounded workers and
per-thread ordering. Recovery must mark interrupted model/tool work as failed or
ambiguous; never automatically replay tools whose side effects are unknown.
Persist the result before delivery, and reconcile jobs found in delivering state
against Slack before deciding whether to resend. If delivery cannot be verified,
retain an ambiguous state for operator action. Test crashes during calls and on
both sides of Slack posting/state commits before enabling automatic recovery.

Fast checks use `bun run test`. An explicit local-only wall-clock check runs three
41-second model turns and completes after two minutes without using credentials
or posting Slack messages:

```sh
bun --no-env-file test test/long-reply.integration.test.ts
```

## Tools and MCP gateway

`getKarma` reads current local SQLite karma. Archive history never replaces it.
Pi validates arguments and executes tools sequentially. Replies have bounded
provider turns, tool executions, output tokens, and total duration.

For an OpenAI-compatible gateway, configure its base URL and model explicitly.
For MCP tools exposed through LiteLLM, a typical configuration is:

```dotenv
OPENAI_API_BASE=https://gateway.example.com/v1
OPENAI_API_MODEL=your-model-alias
LITELLM_MCP_ENABLED=true
```

The MCP endpoint is outside `/v1`: this example derives
`https://gateway.example.com/mcp`. Set `LITELLM_MCP_URL` for an explicit endpoint,
including a scoped server or access group. The adapter uses **Streamable HTTP**
with `x-litellm-api-key: Bearer <OPENAI_API_KEY>`.

Each reply opens a scoped session, follows `tools/list` pagination, and exposes
all tools the gateway returns for that key. Server-prefixed names and JSON
schemas are preserved; no per-server URLs, tool counts, or application allowlists
are required. Granting another server/tool to the same key takes effect on the
next reply. Replacing the key in the environment requires a process restart.

LiteLLM controls server/tool access through key policy. Gateway tools are not
assumed read-only; restrict the key's grants to the capabilities you intend to
expose. The bot's direct live-Slack integration retains its separate read-only
allowlist and per-user OAuth grants.

Missing/invalid gateway configuration logs a startup warning and selects the
disabled adapter. Unavailable discovery logs a warning and omits gateway tools,
allowing normal replies to continue without implying a search occurred. An empty
catalog is valid when the key has no tool grants. `LITELLM_MCP_ENABLED=false`
disables gateway tools even when a URL is set. Legacy `SLACK_ARCHIVE_MCP_URL`
remains a fallback when new gateway settings are absent; it stays scoped to that
endpoint. The model hostname alone never enables MCP access.

Tool results retain structured data, generation guards, citations, and metadata.
Oversized results ask the model to narrow retrieval. Tool content is untrusted;
Slack archive tools represent a historical snapshot, while other gateway tools
retain their own source semantics. Pi sends the discovered declarations to the
model and dispatches selected calls through MCP.

## Live Slack MCP

The runtime and OAuth CLI support any Slack app/workspace configured through
credentials. App and workspace identities are supplied through configuration. The generic
`slack-manifest.json` uses the display name **PW Bot**; customize the template
before applying it to an existing app.

Set `SLACK_APP_ID`, `SLACK_CLIENT_ID`, and `SLACK_CLIENT_SECRET` for the same
app as your bot token, enable **Slack Model Context Protocol (MCP) Server** under
that app's **Agents** settings, register the CLI callback URL, and run
`bun run slack:authorize`. Each invoking user authorizes public-channel read/search.
Only four read tools and public read scopes are accepted. The bot's normal replies,
reactions, and polls use its separate bot token.

OAuth files are private, app/workspace/user-bound, and must remain writable for
refresh rotation. Earlier local filenames still load only when the saved app
matches the configured app. Neither grants nor user tokens are shared between
apps or users. Missing per-user authorization omits live tools with a warning.
See [Kubernetes preparation](deploy/README.md) for durable storage and Secret wiring.

## Polls

Import/update `slack-manifest.json` and reinstall after permission changes. The
slash command opens a private modal; submission posts the poll. Option 1 is
required; blank extra options are ignored. Members have three vote points.
Only the creator can close a poll.

```text
/pwpoll Where should we eat? | Nori | Little Goat | Pizza
/pwpoll --allow-options Lunch? | Pizza | Sushi
```

With `--allow-options`, thread replies `+ Choice name` add a choice. Distinct
per-option vote action IDs preserve the existing local poll fixes.

## Deployment preparation

The generic [Kubernetes example](deploy/kubernetes.yaml) includes a single
`Recreate` replica, persistent `/data`, optional live-MCP Secret wiring, and a
non-root container with a read-only root filesystem. See the
[cutover checklist](deploy/README.md); no automated deployment runs from this repo.
The image defaults SQLite to `/data/pwbot.sqlite`. Mount `/data` to retain state.

## Manifest and release

Set `SLACK_APP_CONFIG_TOKEN` and `SLACK_APP_ID`, then run
`bun run manifest:apply` to replace the full manifest. Configuration tokens expire
after 12 hours. Store the matching refresh token as
`SLACK_APP_CONFIG_REFRESH_TOKEN` in `.env.dev`. Run
`bun run slack:config:refresh` to rotate and atomically save both tokens to that
file with mode `0600`; token values are never printed. Rotation is explicit,
not scheduled automatically. Then run `bun run manifest:apply` as needed.

The publish workflow validates and tests before building. The image includes all
application modules and runs `bun main.ts` as the unprivileged Bun user, with a
writable application directory. It contains no dotenv or database.

Before replacing an existing deployment, take a consistent SQLite backup and
restore it onto durable storage. Keep one replica, verify migrated karma/polls,
and retain the previous image digest and state backup for rollback. Preserve
credentials and key policy through the release. User OAuth grants belong to a
specific Slack app; switching apps requires new grants.

The publish workflow runs on pushes to `master` and tags. It publishes a GHCR
image after checks pass; it does not update a Kubernetes workload. Select and pin
the intended image digest explicitly in your deployment source of truth.

References: [Effect LLM guide](https://github.com/Effect-TS/effect/blob/effect%404.0.5/LLMS.md),
[Pi agent core](https://github.com/earendil-works/pi/blob/v1.3.0/packages/agent/README.md),
[Pi AI](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/README.md),
[XState actors](https://stately.ai/docs/actors).
