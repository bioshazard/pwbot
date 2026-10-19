import { expect, test } from "bun:test";

import { validateToolCall } from "@earendil-works/pi-ai";
import { ConfigProvider, Effect, Layer, Schema } from "effect";

import { BotConfig } from "../../lib/config";
import { GatewayMcp } from "../../lib/gateway-mcp";

const Request = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      cursor: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    })
  ),
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
  const calledTools: string[] = [];
  let includeNewServer = false;
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
      if (rpc.method === "tools/call" && rpc.params?.name !== undefined) {
        calledTools.push(rpc.params.name);
      }
      const pageNames =
        rpc.params?.cursor === undefined
          ? names.map((name) => `slack_archive-${name}`)
          : [
              "books-query",
              "books-get",
              "books-multi_get",
              "books-status",
              ...(includeNewServer ? ["new_service-custom_tool"] : []),
            ];
      const catalog = {
        nextCursor: rpc.params?.cursor === undefined ? "books-page" : undefined,
        tools: pageNames.map((name) => ({
          inputSchema: {
            properties: { query: { type: "string" } },
            required: ["query"],
            type: "object",
          },
          name,
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
  const live = GatewayMcp.layer.pipe(Layer.provide(BotConfig.layer));
  try {
    await Effect.runPromise(
      Effect.gen(function* testGatewayMcp() {
        const gateway = yield* GatewayMcp;
        const session = yield* gateway.open;
        const tools = yield* Effect.tryPromise((signal) =>
          session.discover(signal)
        );
        expect(tools).toHaveLength(10);
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
        const books = tools.find((tool) => tool.name === "books-query");
        if (books === undefined) {
          throw new Error("Missing newly granted books tool");
        }
        yield* Effect.tryPromise(
          async (signal) =>
            await books.execute("books-test", { query: "a book" }, signal)
        );
        expect(calledTools).toEqual(["slack_archive-search", "books-query"]);
        // A later reply discovers new grants without an application allowlist or restart.
        includeNewServer = true;
        const nextSession = yield* gateway.open;
        const nextTools = yield* Effect.tryPromise(
          async (signal) => await nextSession.discover(signal)
        );
        expect(nextTools).toHaveLength(11);
        expect(nextTools.map((tool) => tool.name)).toContain(
          "new_service-custom_tool"
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(live),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            LITELLM_MCP_ENABLED: "true",
            OPENAI_API_BASE: `${server.url.origin}/v1`,
            OPENAI_API_KEY: "test-key",
          })
        )
      )
    );
    expect(headers[0]).toBe("Bearer test-key");
  } finally {
    await server.stop(true);
  }
});
