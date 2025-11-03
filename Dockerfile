# https://bun.sh/guides/ecosystem/docker
# https://hub.docker.com/r/oven/bun

FROM oven/bun:latest

WORKDIR /app

COPY package.json ./
COPY bun.lock ./
RUN bun install
COPY . .

# run the app
USER bun
ENTRYPOINT [ "bun", "run", "main.ts" ]