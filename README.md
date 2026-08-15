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
OPENAI_TIMEOUT_MS=120000
```

`OPENAI_API_BASE`, `OPENAI_API_MODEL`, and `OPENAI_TIMEOUT_MS` are optional.
The model request timeout defaults to 120 seconds. Import or update from
`slack-manifest.json` in Slack, then reinstall the app so DMs are enabled.

Set `POLL_COMMAND` to match a configured Slack slash command; it defaults to
`/pwpoll`. It opens a private configuration modal; submitting it posts the poll
to the channel. The modal starts with three options: only Option 1 is required,
and blank extra options are ignored. Add or remove option fields as needed.
For a faster start, use inline syntax:

```text
/pwpoll Where should we eat? | Nori | Little Goat | Pizza
```

Add `--allow-options` to let members add a choice by replying in the published
poll's thread with `+ Choice name`. Each member can allocate up to three vote
points across the choices.

## Apply the Slack manifest

Create an app configuration token in Slack, then set it with the target app ID:

```sh
SLACK_APP_CONFIG_TOKEN=xoxe.xoxp-...
SLACK_APP_ID=A123ABC
```

Add those values to `.env.dev`, then run:

```sh
bun run manifest:apply
```

This replaces the app's full manifest with `slack-manifest.json`. Reinstall the
app when Slack reports that permissions changed. Configuration tokens expire
after 12 hours.

## Run

```sh
bun start
```

Logs go to `log.out`. Check the code with `bun run typecheck`.
