import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Schema } from "effect";

import packageJson from "../package.json";

type McpArguments = NonNullable<Parameters<Client["callTool"]>[0]["arguments"]>;

interface McpOptions {
  url: URL;
  headers: Readonly<Record<string, string>>;
  description: string;
  accept: (tool: Tool) => boolean;
  validate: (tools: AgentTool[]) => boolean;
}

export const makeMcpSession = Effect.fn("Mcp.open")(function* openMcp(
  options: McpOptions
) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () => new Client({ name: packageJson.name, version: packageJson.version })
    ),
    (resource) =>
      Effect.tryPromise(async () => {
        await resource.close();
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.catch(() => Effect.logWarning("MCP close failed"))
      )
  );
  const lifetime = yield* Effect.abortSignal;
  return {
    discover: async (signal: AbortSignal): Promise<AgentTool[]> => {
      const transport = new StreamableHTTPClientTransport(options.url, {
        fetch: async (input, init) =>
          await fetch(input, {
            ...init,
            signal: AbortSignal.any([
              lifetime,
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
        requestInit: { headers: options.headers },
      });
      await client.connect(transport, { signal, timeout: 30_000 });
      const tools: AgentTool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        // Each cursor comes from the preceding page.
        // oxlint-disable-next-line eslint/no-await-in-loop
        const page = await client.listTools(
          cursor !== undefined && cursor.length > 0 ? { cursor } : undefined,
          {
            signal,
            timeout: 30_000,
          }
        );
        for (const tool of page.tools) {
          if (!options.accept(tool)) {
            continue;
          }
          tools.push({
            description: `${tool.description ?? tool.name}\n${options.description}`,
            execute: async (_id, args, toolSignal) => {
              const result = await client
                .callTool(
                  {
                    arguments: Schema.decodeUnknownSync(
                      Schema.Record(Schema.String, Schema.Unknown)
                    )(args),
                    name: tool.name,
                  },
                  undefined,
                  {
                    signal: AbortSignal.any([
                      lifetime,
                      ...(toolSignal ? [toolSignal] : []),
                    ]),
                    timeout: 30_000,
                  }
                )
                .catch(() => {
                  throw new Error("MCP request failed");
                });
              if (result.isError === true) {
                throw new TypeError(
                  "MCP tool failed; refine the request or report the source unavailable"
                );
              }
              const text = JSON.stringify(result);
              if (text.length > 65_536) {
                throw new Error("MCP result too large; narrow retrieval");
              }
              return { content: [{ text, type: "text" }], details: {} };
            },
            label: tool.name,
            name: tool.name,
            parameters: Type.Unsafe<McpArguments>(tool.inputSchema),
          });
        }
        cursor = page.nextCursor;
        if (cursor !== undefined && cursor.length > 0) {
          if (cursors.has(cursor) || cursors.size >= 10) {
            throw new Error("Invalid MCP tool pagination");
          }
          cursors.add(cursor);
        }
      } while (cursor !== undefined && cursor.length > 0);
      if (
        !options.validate(tools) ||
        new Set(tools.map((tool) => tool.name)).size !== tools.length
      ) {
        throw new Error("Invalid MCP tool catalog");
      }
      return tools;
    },
  };
});
