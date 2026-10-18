# PW Bot

Socket Mode Slack bot: DMs, mentions, karma, and polls.

DMs and mentions receive 👀 before thread retrieval and generation. After a
successful reply posts, the bot adds ✅ and removes 👀. Failure responses clear
👀 without marking success. Reaction errors never prevent replies. Grant the
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
- `lib/archive.ts`, `lib/live-slack.ts`: optional MCP adapters; core reply logic
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
| `OPENAI_TIMEOUT_MS` | `120000`, whole reply including tools |
| `OPENAI_MAX_TOKENS` | `4096` |
| `OPENAI_CONTEXT_WINDOW` | `32768`; set to actual model limit |
| `AGENT_MAX_TURNS` | `8` provider requests per reply |
| `AGENT_MAX_TOOL_CALLS` | `24` executed tools per reply |
| `DATABASE_PATH` | `pwbot.sqlite` |
| `POLL_COMMAND` | `/pwpoll` |
| `SLACK_ARCHIVE_ENABLED` | `false` overrides an archive URL and disables this adapter |
| `SLACK_ARCHIVE_MCP_URL` | Unset; setting an HTTP(S) URL enables archive tools |
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

## Tools and archive gateway

`getKarma` reads current local SQLite karma. Archive history never replaces it.
Pi validates arguments and executes tools sequentially. Replies have bounded
provider turns, tool executions, output tokens, and total duration.

For an OpenAI-compatible gateway, configure its base URL and model explicitly.
For an archive exposed through LiteLLM, a typical configuration is:

```dotenv
OPENAI_API_BASE=https://gateway.example.com/v1
OPENAI_API_MODEL=your-model-alias
SLACK_ARCHIVE_MCP_URL=https://gateway.example.com/slack_archive/mcp
```

The archive endpoint is outside `/v1`. This adapter uses **Streamable HTTP**
with `x-litellm-api-key: Bearer <OPENAI_API_KEY>`. Configure the gateway key to
allow the intended inference routes and archive MCP server. Permission alone
does not advertise tools. The gateway hostname does not automatically enable
archive tools; the MCP URL must be set. `SLACK_ARCHIVE_ENABLED=false` overrides it.

Each reply opens a scoped session, follows `tools/list` pagination, and exposes
only archive_status, list_channels, search, get_message, get_thread, get_context.
Gateway prefixes and discovered JSON schemas are preserved. Pi sends these tool
declarations to the model and dispatches calls through MCP. Key permission alone
does not advertise or execute tools. Missing/invalid archive configuration logs
a startup warning and selects the disabled adapter. Unavailable optional discovery logs a warning and omits its
tools, allowing normal replies to continue without implying a search occurred.

Tools retain structured data, generation guards, citations, and metadata.
Oversized results ask the model to narrow retrieval. Historical content is
untrusted; the archive is a snapshot, not live Slack or complete history.

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
