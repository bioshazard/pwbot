import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

export const migrate = Effect.gen(function* migrateDatabase() {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS handled_events (event_id TEXT PRIMARY KEY)`;
  yield* sql`CREATE TABLE IF NOT EXISTS karma (user_id TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_ts TEXT,
    question TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    allow_options INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS poll_options (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE(poll_id, position)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    votes INTEGER NOT NULL DEFAULT 1 CHECK(votes BETWEEN 1 AND 3),
    PRIMARY KEY(poll_id, user_id, option_id)
  )`;
  const columns = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ name: Schema.String }))
  );
  const voteColumns = columns(yield* sql`PRAGMA table_info(poll_votes)`);
  if (!voteColumns.some((column) => column.name === "votes")) {
    yield* sql`ALTER TABLE poll_votes RENAME TO poll_votes_legacy`;
    yield* sql`CREATE TABLE poll_votes (
      poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      votes INTEGER NOT NULL DEFAULT 1 CHECK(votes BETWEEN 1 AND 3),
      PRIMARY KEY(poll_id, user_id, option_id)
    )`;
    yield* sql`INSERT INTO poll_votes(poll_id, user_id, option_id, votes)
      SELECT poll_id, user_id, option_id, 1 FROM poll_votes_legacy`;
    yield* sql`DROP TABLE poll_votes_legacy`;
  }
  const pollColumns = columns(yield* sql`PRAGMA table_info(polls)`);
  if (!pollColumns.some((column) => column.name === "allow_options")) {
    yield* sql`ALTER TABLE polls ADD COLUMN allow_options INTEGER NOT NULL DEFAULT 0`;
  }
}).pipe(Effect.flatMap(() => Effect.void));
