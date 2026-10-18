FROM oven/bun:1.3.14 AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=bun:bun package.json main.ts slack.ts reply.ts ./
COPY --chown=bun:bun lib ./lib

RUN mkdir -p /data && chown bun:bun /app /data

ENV DATABASE_PATH=/data/pwbot.sqlite
ENV SLACK_MCP_CREDENTIALS_DIR=/data/slack-mcp

USER bun
CMD ["bun", "main.ts"]
