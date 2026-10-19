import { App } from "@slack/bolt";
import {
  Config,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";

import { BotConfig } from "./lib/config";
import { SlackError } from "./lib/errors";
import {
  parsePollCommand,
  parsePollMetadata,
  pollConfiguration,
  pollModal,
  renderPoll,
} from "./lib/poll-ui";
import type { Poll } from "./lib/poll-ui";
import { withReplyProgress } from "./lib/reply-progress";
import {
  ActionBodySchema,
  ActionSchema,
  EventBodySchema,
  MessageSchema,
} from "./lib/schemas";
import { Store } from "./lib/store";
import { Replies } from "./reply";

const decodeMessage = Schema.decodeUnknownOption(MessageSchema);
const decodeBody = Schema.decodeUnknownOption(EventBodySchema);
const decodeActionBody = Schema.decodeUnknownOption(ActionBodySchema);
const decodeAction = Schema.decodeUnknownOption(ActionSchema);
const Posted = Schema.Struct({ ts: Schema.String });
const Validation = Schema.Struct({
  error: Schema.optional(Schema.String),
  ok: Schema.Boolean,
});
const ThreadMessage = Schema.Struct({
  text: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
});
const karmaCommand = (text: string) =>
  /^\s*<@[A-Za-z0-9]+>\s*(?:\+\+|--)(?:\s+[^\n]+)?\s*$/u.test(text);
const eventId = (
  body: {
    event_id?: string;
  },
  fallback: string
) => Option.getOrUndefined(decodeBody(body))?.event_id ?? fallback;
const call = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    catch: () => new SlackError({ operation }),
    try: work,
  });
export const once = <A, E, R>(
  store: Store["Service"],
  id: string,
  work: Effect.Effect<A, E, R>
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* deduplicateEvent() {
      const claimed = yield* store.claim(id);
      if (!claimed) {
        return;
      }
      return yield* restore(work).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? store
                .release(id)
                .pipe(
                  Effect.catch(() =>
                    Effect.logError("Could not release failed event")
                  )
                )
            : Effect.void
        )
      );
    })
  );
export const SlackLive = Layer.effectDiscard(
  Effect.gen(function* startSlack() {
    const config = yield* BotConfig;
    const store = yield* Store;
    const replies = yield* Replies;
    const scope = yield* Effect.scope;
    const botToken = yield* Config.Redacted("SLACK_BOT_TOKEN");
    const appToken = yield* Config.Redacted("SLACK_APP_TOKEN");
    const app = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new App({
            appToken: Redacted.value(appToken),
            socketMode: true,
            token: Redacted.value(botToken),
          })
      ),
      (resource) =>
        call("stop", async () => await resource.stop()).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(() => Effect.logWarning("Slack stop failed"))
        )
    );
    const auth = yield* call(
      "auth.test",
      async () => await app.client.auth.test()
    );
    if (auth.user_id === undefined || auth.user_id.length === 0) {
      return yield* new SlackError({
        operation: "auth.test missing bot user ID",
      });
    }
    const botUserId = auth.user_id;
    const teamId = auth.team_id;
    if (teamId === undefined) {
      return yield* new SlackError({ operation: "auth.test missing team ID" });
    }
    // Bolt's Promise callbacks are the boundary. Every event fiber belongs to the app scope.
    const postMessage = app.client.chat.postMessage.bind(app.client.chat);
    const run = async <A, E>(work: Effect.Effect<A, E>) =>
      await Effect.runPromise(
        work.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join))
      );
    const validatePoll = Effect.fn("Slack.validatePoll")(
      function* validatePollBlocks(poll: Poll) {
        const response = yield* call(
          "blocks.validate",
          async () =>
            await app.client.apiCall("blocks.validate", {
              message: JSON.stringify({ blocks: renderPoll(poll) }),
            })
        );
        const validation =
          yield* Schema.decodeUnknownEffect(Validation)(response);
        if (!validation.ok) {
          return yield* new SlackError({
            operation: "blocks.validate rejected poll",
          });
        }
      }
    );
    const updatePoll = Effect.fn("Slack.updatePoll")(
      function* updatePollMessage(poll: Poll, channel: string, ts: string) {
        yield* validatePoll(poll);
        yield* call(
          "chat.update",
          async () =>
            await app.client.chat.update({
              blocks: renderPoll(poll),
              channel,
              text: poll.question,
              ts,
            })
        );
      }
    );
    const publishPoll = Effect.fn("Slack.publishPoll")(
      function* publishPollMessage(poll: Poll) {
        yield* validatePoll(poll);
        const response = yield* call(
          "chat.postMessage",
          async () =>
            await postMessage({
              blocks: renderPoll(poll),
              channel: poll.channelId,
              text: poll.question,
            })
        );
        const posted = yield* Schema.decodeUnknownEffect(Posted)(response);
        yield* store.setPollMessage(poll.id, posted.ts);
      },
      Effect.onError(() => Effect.logError("Poll publication failed"))
    );
    const answer = Effect.fn("Slack.answer")(function* answerMessage(
      event: typeof MessageSchema.Type
    ) {
      if (event.user === undefined || event.user.length === 0) {
        return;
      }
      const userId = event.user;
      return yield* withReplyProgress(
        {
          add: async (target) => await app.client.reactions.add(target),
          remove: async (target) => await app.client.reactions.remove(target),
        },
        { channel: event.channel, timestamp: event.ts },
        Effect.gen(function* generateAndPostReply() {
          const lines: string[] = [];
          let cursor: string | undefined;
          let pages = 0;
          do {
            const currentCursor = cursor;
            const response = yield* call(
              "conversations.replies",
              async () =>
                await app.client.conversations.replies({
                  channel: event.channel,
                  cursor: currentCursor,
                  limit: 100,
                  ts: event.thread_ts ?? event.ts,
                })
            );
            for (const message of response.messages ?? []) {
              const parsed =
                yield* Schema.decodeUnknownEffect(ThreadMessage)(message);
              lines.push(
                `${parsed.user === undefined ? "unknown" : `<@${parsed.user}>`}: ${parsed.text ?? ""}`
              );
            }
            cursor = response.response_metadata?.next_cursor;
          } while (
            cursor !== undefined &&
            cursor.length > 0 &&
            (pages += 1) < 10
          );
          const thread =
            lines.join("\n").slice(-48_000) || `${event.user}: ${event.text}`;
          const result = yield* replies
            .generate(thread, userId, {
              channelId: event.channel,
              teamId,
              threadTs: event.thread_ts ?? event.ts,
            })
            .pipe(
              Effect.map((text) => ({ completed: true, text })),
              Effect.catchTag("ReplyError", (error) =>
                Effect.logWarning("Reply failed", {
                  reason: error.reason,
                }).pipe(
                  Effect.as({
                    completed: false,
                    text: "Sorry — the reply service is temporarily unavailable. Please try again.",
                  })
                )
              )
            );
          yield* call(
            "chat.postMessage",
            async () =>
              await postMessage({
                channel: event.channel,
                mrkdwn: true,
                text: result.text,
                thread_ts: event.thread_ts ?? event.ts,
              })
          );
          yield* Effect.logInfo("Posted reply", {
            completed: result.completed,
          });
          return result.completed;
        })
      );
    });
    app.message(async ({ message, body }) => {
      await run(
        Effect.gen(function* receiveMessage() {
          const event = Option.getOrUndefined(decodeMessage(message));
          if (
            !event ||
            event.bot_id !== undefined ||
            event.user === undefined ||
            event.user.length === 0 ||
            event.user === botUserId
          ) {
            return;
          }
          const userId = event.user;
          if (
            event.channel_type !== "im" &&
            !karmaCommand(event.text) &&
            !(event.thread_ts !== undefined && /^\+\s+\S/u.test(event.text))
          ) {
            return;
          }
          const id = eventId(body, `${event.channel}:${event.ts}`);
          yield* once(
            store,
            id,
            Effect.gen(function* handleMessage() {
              if (karmaCommand(event.text)) {
                const match =
                  /^\s*<@(?<target>[A-Za-z0-9]+)>\s*(?<direction>\+\+|--)/u.exec(
                    event.text
                  );
                const target = match?.groups?.target;
                if (
                  target !== undefined &&
                  target !== userId &&
                  target !== botUserId
                ) {
                  yield* store.changeKarma(
                    target,
                    match?.groups?.direction === "++" ? 1 : -1
                  );
                }
                return;
              }
              if (
                event.thread_ts !== undefined &&
                /^\+\s+\S/u.test(event.text)
              ) {
                const parent = yield* store.getPollByMessageTs(event.thread_ts);
                if (parent) {
                  const poll = yield* store.addPollOption(
                    parent.id,
                    event.text.replace(/^\+\s+/u, "")
                  );
                  if (poll) {
                    yield* updatePoll(poll, parent.channelId, event.thread_ts);
                  }
                  return;
                }
              }
              if (event.channel_type === "im") {
                yield* answer(event);
              }
            })
          );
        })
      );
    });
    app.event("app_mention", async ({ event, body }) => {
      await run(
        Effect.gen(function* receiveMention() {
          const message = Option.getOrUndefined(decodeMessage(event));
          if (
            !message ||
            message.bot_id !== undefined ||
            message.user === undefined ||
            message.user === botUserId
          ) {
            return;
          }
          yield* once(
            store,
            eventId(body, `${message.channel}:${message.ts}`),
            answer(message)
          );
        })
      );
    });
    app.command(config.pollCommand, async ({ ack, body, client }) => {
      await ack();
      await run(
        Effect.gen(function* handlePollCommand() {
          const parsed = parsePollCommand(body.text);
          if (parsed.question.length > 0 && parsed.labels.length > 0) {
            const poll = yield* store.createPoll(
              body.channel_id,
              body.user_id,
              parsed.question,
              parsed.labels,
              parsed.allowOptions
            );
            yield* publishPoll(poll).pipe(
              Effect.onError(() => store.deletePoll(poll.id).pipe(Effect.orDie))
            );
          } else {
            yield* call(
              "views.open",
              async () =>
                await client.views.open({
                  trigger_id: body.trigger_id,
                  view: pollModal(
                    { channelId: body.channel_id, creatorId: body.user_id },
                    3
                  ),
                })
            );
          }
        })
      );
    });
    for (const [name, direction] of [
      ["poll_add_option", 1],
      ["poll_remove_option", -1],
    ] as const) {
      app.action(name, async ({ ack, body, client }) => {
        await ack();
        if (body.type !== "block_actions" || !body.view) {
          return;
        }
        const { view } = body;
        await run(
          Effect.gen(function* updatePollModal() {
            const metadata = yield* Effect.try({
              catch: () => new SlackError({ operation: "poll metadata" }),
              try: () => parsePollMetadata(view.private_metadata),
            });
            const configuration = pollConfiguration(view.state.values);
            const optionCount = Math.max(
              1,
              Math.min(10, configuration.optionCount + direction)
            );
            yield* call(
              "views.update",
              async () =>
                await client.views.update({
                  hash: view.hash,
                  view: pollModal(
                    metadata,
                    optionCount,
                    configuration.question,
                    configuration.labels,
                    configuration.allowOptions
                  ),
                  view_id: view.id,
                })
            );
          })
        );
      });
    }
    app.view("poll_create", async ({ ack, view }) => {
      const configuration = pollConfiguration(view.state.values);
      if (
        configuration.question.length === 0 ||
        configuration.labels.length === 0
      ) {
        await ack({
          errors: { poll_option_0: "Enter the first option." },
          response_action: "errors",
        });
        return;
      }
      await ack();
      await run(
        Effect.gen(function* createPollFromModal() {
          const metadata = yield* Effect.try({
            catch: () => new SlackError({ operation: "poll metadata" }),
            try: () => parsePollMetadata(view.private_metadata),
          });
          const poll = yield* store.createPoll(
            metadata.channelId,
            metadata.creatorId,
            configuration.question,
            configuration.labels,
            configuration.allowOptions
          );
          yield* publishPoll(poll).pipe(
            Effect.onError(() => store.deletePoll(poll.id).pipe(Effect.orDie))
          );
        })
      );
    });
    for (const [pattern, direction] of [
      [/^poll_vote:/u, 1],
      [/^poll_remove_vote:/u, -1],
      ["poll_close", 0],
    ] as const) {
      app.action(pattern, async ({ ack, body, action }) => {
        await ack();
        await run(
          Effect.gen(function* handlePollAction() {
            const parsedBody = Option.getOrUndefined(decodeActionBody(body));
            const parsedAction = Option.getOrUndefined(decodeAction(action));
            if (!parsedBody || !parsedAction) {
              return;
            }
            const { container, user } = parsedBody;
            if (
              container.channel_id === undefined ||
              container.message_ts === undefined
            ) {
              return;
            }
            const [pollId, optionId] = parsedAction.value.split(":");
            if (pollId === undefined || pollId.length === 0) {
              return;
            }
            let poll: Poll | undefined;
            if (direction === 0) {
              poll = yield* store.closePoll(pollId, user.id);
            } else if (optionId !== undefined && optionId.length > 0) {
              poll = yield* store.vote(pollId, optionId, user.id, direction);
            }
            if (poll) {
              yield* updatePoll(
                poll,
                container.channel_id,
                container.message_ts
              );
            }
          })
        );
      });
    }
    for (const [name, direction] of [
      ["reaction_added", 1],
      ["reaction_removed", -1],
    ] as const) {
      app.event(name, async ({ event, body }) => {
        await run(
          Effect.gen(function* handleReaction() {
            if (
              event.item.type !== "message" ||
              !event.item_user ||
              event.user === botUserId ||
              event.user === event.item_user ||
              event.item_user === botUserId
            ) {
              return;
            }
            const target = event.item_user;
            yield* once(
              store,
              eventId(body, `${name}:${event.event_ts}`),
              store.changeKarma(
                target,
                direction * (event.reaction === "plusplus" ? 1 : 0.1)
              )
            );
          })
        );
      });
    }
    app.error(async () => {
      await run(Effect.logError("Slack event handler failed"));
    });
    yield* call("start", async () => await app.start());
    yield* Effect.logInfo("PW Bot is running", {
      botUserId,
      gatewayMcpEnabled: Boolean(config.gatewayMcpUrl),
    });
  })
);
