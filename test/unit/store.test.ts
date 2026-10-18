import { expect, test } from "bun:test";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { Store } from "../../lib/store";
import { once } from "../../slack";

const live = Store.layer.pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
);

test("legacy SQLite migration preserves karma, handled events, polls and votes", async () => {
  const fixture = Layer.effectDiscard(
    Effect.gen(function* prepareLegacyDatabase() {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE karma (user_id TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0)`;
      yield* sql`INSERT INTO karma VALUES ('UTEST', 7.5)`;
      yield* sql`CREATE TABLE handled_events (event_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO handled_events VALUES ('already-handled')`;
      yield* sql`CREATE TABLE polls (id TEXT PRIMARY KEY, channel_id TEXT, message_ts TEXT, question TEXT, creator_id TEXT, status TEXT)`;
      yield* sql`INSERT INTO polls VALUES ('poll', 'C1', '123', 'Lunch?', 'OWNER', 'open')`;
      yield* sql`CREATE TABLE poll_options (id TEXT PRIMARY KEY, poll_id TEXT, label TEXT, position INTEGER)`;
      yield* sql`INSERT INTO poll_options VALUES ('option', 'poll', 'Pizza', 0)`;
      yield* sql`CREATE TABLE poll_votes (poll_id TEXT, user_id TEXT, option_id TEXT, PRIMARY KEY(poll_id, user_id, option_id))`;
      yield* sql`INSERT INTO poll_votes VALUES ('poll', 'VOTER', 'option')`;
    })
  );
  const legacy = Store.layer.pipe(
    Layer.provide(
      fixture.pipe(
        Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))
      )
    )
  );
  await Effect.runPromise(
    Effect.gen(function* verifyMigration() {
      const store = yield* Store;
      expect(yield* store.getKarma("UTEST")).toBe(7.5);
      expect(yield* store.claim("already-handled")).toBe(false);
      const poll = yield* store.getPoll("poll");
      expect(poll?.allowOptions).toBe(false);
      expect(poll?.options[0]?.votes).toBe(1);
      yield* store.vote("poll", "option", "VOTER", 1);
      expect((yield* store.getPoll("poll"))?.options[0]?.votes).toBe(2);
    }).pipe(Effect.provide(legacy))
  );
});
test("karma and event deduplication; failed events can retry", async () => {
  await Effect.runPromise(
    Effect.gen(function* testKarma() {
      const store = yield* Store;
      yield* once(store, "event1", store.changeKarma("UTEST", 1));
      yield* once(store, "event1", store.changeKarma("UTEST", 1));
      expect(yield* store.getKarma("UTEST")).toBe(1);
      yield* once(store, "retry", Effect.fail("failed")).pipe(Effect.ignore);
      yield* once(store, "retry", store.changeKarma("UTEST", 0.1));
      expect(yield* store.getKarma("UTEST")).toBeCloseTo(1.1);
      yield* once(store, "interrupted", Effect.never).pipe(
        Effect.timeout(10),
        Effect.ignore
      );
      expect(yield* store.claim("interrupted")).toBe(true);
    }).pipe(Effect.provide(live))
  );
});
test("poll voting stays within three points under concurrent requests", async () => {
  await Effect.runPromise(
    Effect.gen(function* testPolls() {
      const store = yield* Store;
      const poll = yield* store.createPoll(
        "C1",
        "OWNER",
        "Lunch?",
        ["Pizza", "Sushi"],
        true
      );
      const [option] = poll.options;
      if (option === undefined) {
        throw new Error("Missing poll option");
      }
      yield* Effect.all(
        Array.from({ length: 8 }, () =>
          store.vote(poll.id, option.id, "VOTER", 1)
        ),
        { concurrency: "unbounded" }
      );
      expect((yield* store.getPoll(poll.id))?.options[0]?.votes).toBe(3);
      yield* store.vote(poll.id, option.id, "VOTER", -1);
      expect((yield* store.getPoll(poll.id))?.options[0]?.votes).toBe(2);
      expect(yield* store.closePoll(poll.id, "NOTOWNER")).toBeUndefined();
      yield* store.addPollOption(poll.id, "Tacos");
      expect((yield* store.getPoll(poll.id))?.options).toHaveLength(3);
      yield* store.closePoll(poll.id, "OWNER");
      expect(yield* store.vote(poll.id, option.id, "VOTER", 1)).toBeUndefined();
      expect(yield* store.addPollOption(poll.id, "Soup")).toBeUndefined();
    }).pipe(Effect.provide(live))
  );
});
