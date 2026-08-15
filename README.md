# PW Bot

Small Socket Mode Slack bot.

It replies to DMs and `@mentions`, records `++` / `--` karma, and stores only
karma plus processed event IDs in `pwbot.sqlite`.

## Setup

```sh
bun install
```

Create `.env.dev`:

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
OPENAI_API_KEY=...
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_MODEL=gpt-4o
```

`OPENAI_API_BASE` and `OPENAI_API_MODEL` are optional. Import or update from
`slack-manifest.json` in Slack, then reinstall the app so DMs are enabled.

Set `POLL_COMMAND` to match a configured Slack slash command; it defaults to
`/pwpoll`. Run it to open a poll-creation modal.

## Run

```sh
bun start
```

Logs go to `log.out`. Check the code with `bun run typecheck`.
