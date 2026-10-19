import { randomUUID } from "node:crypto";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { BotConfig } from "./config";
import { StoreError } from "./errors";
import { migrate } from "./migrations";
import type { Poll } from "./poll-ui";
import { PollOptionRowSchema, PollRowSchema } from "./schemas";

const make = Effect.gen(function* makeStore() {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(migrate);
  const getPoll = Effect.fn("Store.getPoll")(
    function* readPoll(id: string) {
      const rows =
        yield* sql`SELECT id, channel_id, question, creator_id, status, allow_options FROM polls WHERE id = ${id}`;
      if (rows.length === 0) {
        return;
      }
      const row = yield* Schema.decodeUnknownEffect(PollRowSchema)(rows[0]);
      const options = yield* Schema.decodeUnknownEffect(
        Schema.Array(PollOptionRowSchema)
      )(
        yield* sql`SELECT o.id, o.label, COALESCE(SUM(v.votes), 0) AS votes,
        COALESCE(GROUP_CONCAT(v.user_id || ':' || v.votes, ','), '') AS voters
        FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id
        WHERE o.poll_id = ${id} GROUP BY o.id ORDER BY o.position`
      );
      return {
        allowOptions: row.allow_options === 1,
        channelId: row.channel_id,
        creatorId: row.creator_id,
        id: row.id,
        options: options.map((option) => ({
          ...option,
          voters: option.voters
            .split(",")
            .filter(Boolean)
            .map((voter) => {
              const [userId, votes] = voter.split(":");
              return { userId: userId ?? "", votes: Number(votes) };
            }),
        })),
        question: row.question,
        status: row.status,
      } satisfies Poll;
    },
    Effect.mapError(() => new StoreError({ operation: "getPoll" }))
  );
  const createPoll = Effect.fn("Store.createPoll")(
    function* insertPoll(
      channelId: string,
      creatorId: string,
      question: string,
      labels: string[],
      allowOptions: boolean
    ) {
      const id = randomUUID();
      yield* sql`INSERT INTO polls(id, channel_id, question, creator_id, status, allow_options)
      VALUES (${id}, ${channelId}, ${question}, ${creatorId}, 'open', ${Number(allowOptions)})`;
      for (const [position, label] of labels.entries()) {
        yield* sql`INSERT INTO poll_options(id, poll_id, label, position) VALUES (${randomUUID()}, ${id}, ${label}, ${position})`;
      }
      const poll = yield* getPoll(id);
      if (!poll) {
        return yield* new StoreError({ operation: "createPoll" });
      }
      return poll;
    },
    sql.withTransaction,
    Effect.mapError(() => new StoreError({ operation: "createPoll" }))
  );
  const vote = Effect.fn("Store.vote")(
    function* castVote(
      id: string,
      optionId: string,
      userId: string,
      direction: 1 | -1
    ) {
      const poll = yield* getPoll(id);
      if (
        !poll ||
        poll.status !== "open" ||
        !poll.options.some((option) => option.id === optionId)
      ) {
        return;
      }
      if (direction === 1) {
        const [total] = yield* sql<{
          total: number;
        }>`SELECT COALESCE(SUM(votes), 0) AS total FROM poll_votes WHERE poll_id = ${id} AND user_id = ${userId}`;
        if (!total || total.total >= 3) {
          return;
        }
        yield* sql`INSERT INTO poll_votes(poll_id, user_id, option_id, votes) VALUES (${id}, ${userId}, ${optionId}, 1)
        ON CONFLICT(poll_id, user_id, option_id) DO UPDATE SET votes = votes + 1`;
      } else {
        yield* sql`DELETE FROM poll_votes WHERE poll_id = ${id} AND user_id = ${userId} AND option_id = ${optionId} AND votes = 1`;
        yield* sql`UPDATE poll_votes SET votes = votes - 1 WHERE poll_id = ${id} AND user_id = ${userId} AND option_id = ${optionId} AND votes > 1`;
      }
      return yield* getPoll(id);
    },
    sql.withTransaction,
    Effect.mapError(() => new StoreError({ operation: "vote" }))
  );
  const addPollOption = Effect.fn("Store.addPollOption")(
    function* addOption(id: string, label: string) {
      const poll = yield* getPoll(id);
      if (
        !poll ||
        poll.status !== "open" ||
        !poll.allowOptions ||
        poll.options.length >= 10 ||
        label.length === 0 ||
        poll.options.some(
          (option) => option.label.toLowerCase() === label.toLowerCase()
        )
      ) {
        return;
      }
      yield* sql`INSERT INTO poll_options(id, poll_id, label, position) VALUES (${randomUUID()}, ${id}, ${label}, ${poll.options.length})`;
      return yield* getPoll(id);
    },
    sql.withTransaction,
    Effect.mapError(() => new StoreError({ operation: "addPollOption" }))
  );
  const closePoll = Effect.fn("Store.closePoll")(
    function* closePoll(id: string, userId: string) {
      const poll = yield* getPoll(id);
      if (!poll || poll.creatorId !== userId || poll.status !== "open") {
        return;
      }
      yield* sql`UPDATE polls SET status = 'closed' WHERE id = ${id}`;
      return yield* getPoll(id);
    },
    sql.withTransaction,
    Effect.mapError(() => new StoreError({ operation: "closePoll" }))
  );
  const getPollByMessageTs = Effect.fn("Store.getPollByMessageTs")(
    function* findPollByMessage(ts: string) {
      const [row] = yield* sql<{
        id: string;
      }>`SELECT id FROM polls WHERE message_ts = ${ts}`;
      return row ? yield* getPoll(row.id) : undefined;
    },
    Effect.mapError(() => new StoreError({ operation: "getPollByMessageTs" }))
  );
  const getKarma = Effect.fn("Store.getKarma")(
    function* readKarma(userId: string) {
      const [row] = yield* sql<{
        score: number;
      }>`SELECT score FROM karma WHERE user_id = ${userId}`;
      return row?.score ?? 0;
    },
    Effect.mapError(() => new StoreError({ operation: "getKarma" }))
  );
  const changeKarma = Effect.fn("Store.changeKarma")(
    (userId: string, amount: number) =>
      sql`INSERT INTO karma(user_id, score) VALUES (${userId}, ${amount}) ON CONFLICT(user_id) DO UPDATE SET score = score + excluded.score`.pipe(
        Effect.asVoid,
        Effect.mapError(() => new StoreError({ operation: "changeKarma" }))
      )
  );
  return {
    addPollOption,
    changeKarma,
    claim: (id: string) =>
      sql`INSERT OR IGNORE INTO handled_events(event_id) VALUES (${id}) RETURNING event_id`.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(() => new StoreError({ operation: "claim" }))
      ),
    closePoll,
    createPoll,
    deletePoll: (id: string) =>
      sql
        .withTransaction(
          Effect.gen(function* deletePollRows() {
            yield* sql`DELETE FROM poll_votes WHERE poll_id = ${id}`;
            yield* sql`DELETE FROM poll_options WHERE poll_id = ${id}`;
            yield* sql`DELETE FROM polls WHERE id = ${id}`;
          })
        )
        .pipe(
          Effect.mapError(() => new StoreError({ operation: "deletePoll" }))
        ),
    getKarma,
    getPoll,
    getPollByMessageTs,
    release: (id: string) =>
      sql`DELETE FROM handled_events WHERE event_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(() => new StoreError({ operation: "release" }))
      ),
    setPollMessage: (id: string, ts: string) =>
      sql`UPDATE polls SET message_ts = ${ts} WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(() => new StoreError({ operation: "setPollMessage" }))
      ),
    vote,
  };
});
export class Store extends Context.Service<
  Store,
  Effect.Success<typeof make>
>()("pwbot/Store") {
  static readonly layer = Layer.effect(Store, make);
  static readonly sqlLayer = Layer.unwrap(
    Effect.gen(function* makeSqlLayer() {
      const config = yield* BotConfig;
      return SqliteClient.layer({ filename: config.databasePath });
    })
  );
}
