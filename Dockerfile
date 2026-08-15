FROM oven/bun:1.3.14 AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=bun:bun slack.ts ./

USER bun
CMD ["bun", "slack.ts"]
