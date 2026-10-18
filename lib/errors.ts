/* oxlint-disable eslint/max-classes-per-file -- Related domain error variants share one module. */
import { Schema } from "effect";

const taggedError = Schema.TaggedError;
// Deliberately omit raw SDK errors: gateway responses can contain private data.
export class ReplyError extends taggedError<ReplyError>()("ReplyError", {
  reason: Schema.Literals(["discovery", "model", "limit", "empty", "timeout"]),
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
