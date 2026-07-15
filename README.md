# pwbot

Slack bot powered by the Vercel AI SDK and an OpenAI-compatible chat endpoint.

## Setup

Install dependencies:

```bash
bun install
```

Configure:

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
OPENAI_API_KEY=...
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_MODEL=gpt-4o
```

`OPENAI_API_BASE` and `OPENAI_API_MODEL` are optional. The defaults are the
OpenAI API and `gpt-4o`.

Run:

```bash
bun start
```

Validate:

```bash
bun test
bun run typecheck
```
