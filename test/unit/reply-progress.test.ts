import { expect, test } from "bun:test";

import { Effect, Exit } from "effect";

import { withReplyProgress } from "../../lib/reply-progress";

const target = { channel: "CTEST", timestamp: "123.456" };
const fixture = () => {
  const events: string[] = [];
  const reactions = {
    add: (item: typeof target & { name: string }) => {
      expect(item.channel).toBe(target.channel);
      expect(item.timestamp).toBe(target.timestamp);
      events.push(`add:${item.name}`);
      return Promise.resolve({ ok: true });
    },
    remove: (item: typeof target & { name: string }) => {
      expect(item.channel).toBe(target.channel);
      expect(item.timestamp).toBe(target.timestamp);
      events.push(`remove:${item.name}`);
      return Promise.resolve({ ok: true });
    },
  };
  return { events, reactions };
};

test("eyes precedes work and becomes a check only after a posted reply", async () => {
  const { events, reactions } = fixture();
  await Effect.runPromise(
    withReplyProgress(
      reactions,
      target,
      Effect.sync(() => {
        events.push("posted");
        return true;
      })
    )
  );
  expect(events).toEqual([
    "add:eyes",
    "posted",
    "add:white_check_mark",
    "remove:eyes",
  ]);
});

test("fallback reply clears eyes without a success check", async () => {
  const { events, reactions } = fixture();
  await Effect.runPromise(
    withReplyProgress(reactions, target, Effect.succeed(false))
  );
  expect(events).toEqual(["add:eyes", "remove:eyes"]);
});

test("post failures clear eyes and preserve the failure", async () => {
  const { events, reactions } = fixture();
  const exit = await Effect.runPromiseExit(
    withReplyProgress(reactions, target, Effect.fail("post failed"))
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(events).toEqual(["add:eyes", "remove:eyes"]);
});

test("interruption clears eyes without marking success", async () => {
  const { events, reactions } = fixture();
  await Effect.runPromiseExit(
    withReplyProgress(reactions, target, Effect.never).pipe(Effect.timeout(20))
  );
  expect(events).toEqual(["add:eyes", "remove:eyes"]);
});

test("missing reaction permission still allows the reply", async () => {
  const { events, reactions } = fixture();
  const completed = await Effect.runPromise(
    withReplyProgress(
      {
        ...reactions,
        add: () => Promise.reject(new Error("missing_scope")),
      },
      target,
      Effect.sync(() => {
        events.push("posted");
        return true;
      })
    )
  );
  expect(completed).toBe(true);
  expect(events).toEqual(["posted", "remove:eyes"]);
});
