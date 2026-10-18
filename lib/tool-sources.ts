import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ToolSession {
  discover: (signal: AbortSignal) => Promise<AgentTool[]>;
}

export const emptyToolSession: ToolSession = {
  discover: () => Promise.resolve([]),
};

export interface ToolContext {
  teamId?: string;
  userId: string;
}

// Reply generation knows capabilities, never environment variables or MCP adapters.
export class ToolSources extends Context.Service<
  ToolSources,
  {
    open: (
      context: ToolContext
    ) => Effect.Effect<ToolSession, never, Scope.Scope>;
  }
>()("pwbot/ToolSources") {}
