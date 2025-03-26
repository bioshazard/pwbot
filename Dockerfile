# https://bun.sh/guides/ecosystem/docker
# https://hub.docker.com/r/oven/bun

FROM oven/bun:latest

COPY package.json ./
COPY bun.lock ./
COPY . .

RUN bun install

# run the app
USER bun
ENTRYPOINT [ "bun", "run", "main.ts" ]