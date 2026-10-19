import { expect, test } from "bun:test";

import { Effect } from "effect";

import { AppLive } from "../lib/layers";
import { Replies } from "../reply";

test.skipIf(process.env.RUN_LIVE_TESTS !== "1")(
  "incoming greeting receives a model reply",
  async () => {
    const reply = await Effect.runPromise(
      Effect.gen(function* testConfig() {
        const replies = yield* Replies;
        return yield* replies.generate("<@UTEST>: Hello, PW Bot!", "UTEST");
      }).pipe(Effect.provide(AppLive))
    );
    expect(reply.trim()).not.toBeEmpty();
  },
  125_000
);
