import { expect, test } from "bun:test";

import { validateToolCall } from "@earendil-works/pi-ai";
import { ConfigProvider, Effect, Layer, Schema } from "effect";

import { Archive } from "../../lib/archive";
import { BotConfig } from "../../lib/config";

const Request = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
});
const names = [
  "archive_status",
  "list_channels",
  "search",
  "get_message",
  "get_thread",
  "get_context",
];
test("MCP discovers gateway-prefixed schemas and preserves generation/citations", async () => {
  const headers: (string | null)[] = [];
  const result = {
    content: [{ text: "snapshot evidence", type: "text" }],
    structuredContent: { citations: ["slack://C1/123"], generation: "g1" },
  };
  const server = Bun.serve({
    fetch: async (request) => {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      headers.push(request.headers.get("x-litellm-api-key"));
      const rpc = Schema.decodeUnknownSync(Request)(await request.json());
      if (rpc.id === undefined) {
        return new Response(null, { status: 202 });
      }
      const initialize = {
        capabilities: { tools: {} },
        protocolVersion: "2025-03-26",
        serverInfo: { name: "archive", version: "1" },
      };
      const catalog = {
        tools: names.map((name) => ({
          inputSchema: {
            properties: { query: { type: "string" } },
            required: ["query"],
            type: "object",
          },
          name: `slack_archive-${name}`,
        })),
      };
      const responses = new Map<
        string,
        typeof initialize | typeof catalog | typeof result
      >([
        ["initialize", initialize],
        ["tools/list", catalog],
        ["tools/call", result],
      ]);
      const body = responses.get(rpc.method);
      return Response.json({ id: rpc.id, jsonrpc: "2.0", result: body });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const live = Archive.layer.pipe(Layer.provide(BotConfig.layer));
  try {
    await Effect.runPromise(
      Effect.gen(function* testArchive() {
        const archive = yield* Archive;
        const session = yield* archive.open;
        const tools = yield* Effect.tryPromise((signal) =>
          session.discover(signal)
        );
        expect(tools).toHaveLength(6);
        const search = tools.find(
          (tool) => tool.name === "slack_archive-search"
        );
        if (!search) {
          throw new Error("Missing search tool");
        }
        const call = {
          arguments: { query: "lunch" },
          id: "test",
          name: search.name,
          type: "toolCall" as const,
        };
        validateToolCall(tools, call);
        expect(() => {
          validateToolCall(tools, { ...call, arguments: {} });
        }).toThrow();
        const response = yield* Effect.tryPromise((signal) =>
          search.execute("test", { query: "lunch" }, signal)
        );
        const parsed = Schema.decodeUnknownSync(
          Schema.Struct({
            content: Schema.Array(Schema.Struct({ text: Schema.String })),
          })
        )(response);
        const [block] = parsed.content;
        if (block === undefined) {
          throw new Error("Missing archive result");
        }
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
            block.text
          )
        ).toEqual(result);
      }).pipe(
        Effect.scoped,
        Effect.provide(live),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            OPENAI_API_KEY: "test-key",
            SLACK_ARCHIVE_MCP_URL: `${server.url.origin}/slack_archive/mcp`,
          })
        )
      )
    );
    expect(headers[0]).toBe("Bearer test-key");
  } finally {
    await server.stop(true);
  }
});
