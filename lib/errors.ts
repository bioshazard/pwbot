/* oxlint-disable eslint/max-classes-per-file -- Related domain error variants share one module. */
import { Schema } from "effect";

const taggedError = Schema.TaggedError;
// Deliberately omit raw SDK errors: gateway responses can contain private data.
export class ReplyError extends taggedError<ReplyError>()("ReplyError", {
  reason: Schema.Literals([
    "discovery",
    "model",
    "limit",
    "output_limit",
    "context_limit",
    "empty",
    "timeout",
    "model_timeout",
    "tool_timeout",
    "cancelled",
  ]),
}) {}
export class SlackError extends taggedError<SlackError>()("SlackError", {
  operation: Schema.String,
}) {}
export class StoreError extends taggedError<StoreError>()("StoreError", {
  operation: Schema.String,
}) {}
export class SlackMcpError extends taggedError<SlackMcpError>()(
  "SlackMcpError",
  {
    operation: Schema.String,
  }
) {}

export const replyFailureText = (reason: ReplyError["reason"]): string => {
  // oxlint-disable-next-line eslint/default-case -- Exhaustive domain union; typechecker enforces new cases.
  switch (reason) {
    case "timeout": {
      return "The reply reached its overall deadline. Please narrow the question and try again.";
    }
    case "model_timeout": {
      return "The model took too long to respond. Please try again.";
    }
    case "tool_timeout": {
      return "A source took too long to respond. Please try a narrower question.";
    }
    case "context_limit": {
      return "The research filled the configured model context. Please narrow the question or have the model context setting checked.";
    }
    case "output_limit": {
      return "The model reached its output limit before finishing. Please narrow the question and try again.";
    }
    case "limit": {
      return "The reply reached its research budget. Please narrow the question and try again.";
    }
    case "cancelled": {
      return "The reply was cancelled.";
    }
    case "discovery":
    case "empty":
    case "model": {
      return "The reply could not be completed because a source or model was unavailable. Please try again.";
    }
  }
};
