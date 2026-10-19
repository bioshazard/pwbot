import { Schema } from "effect";

export const MessageSchema = Schema.Struct({
  bot_id: Schema.optional(Schema.String),
  channel: Schema.String,
  channel_type: Schema.optional(Schema.String),
  text: Schema.String,
  thread_ts: Schema.optional(Schema.String),
  ts: Schema.String,
  user: Schema.optional(Schema.String),
});
export const PollMetadataSchema = Schema.Struct({
  channelId: Schema.String,
  creatorId: Schema.String,
});
export const ActionBodySchema = Schema.Struct({
  container: Schema.Struct({
    channel_id: Schema.optional(Schema.String),
    message_ts: Schema.optional(Schema.String),
  }),
  type: Schema.Literal("block_actions"),
  user: Schema.Struct({ id: Schema.String }),
});
export const ActionSchema = Schema.Struct({ value: Schema.String });
export const EventBodySchema = Schema.Struct({
  event_id: Schema.optional(Schema.String),
});
export const PollRowSchema = Schema.Struct({
  allow_options: Schema.Int,
  channel_id: Schema.String,
  creator_id: Schema.String,
  id: Schema.String,
  question: Schema.String,
  status: Schema.Literals(["draft", "open", "closed"]),
});
export const PollOptionRowSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  voters: Schema.String,
  votes: Schema.Number,
});
