import { expect, test } from "bun:test";

import { generateReply } from "../reply";

test("incoming greeting receives a model reply", async () => {
  const startedAt = performance.now();
  const reply = await generateReply({
    getKarma: () => 0,
    thread: "<@U_TEST>: Hello, PW Bot!",
    userId: "U_TEST",
  });
  const elapsedMs = Math.round(performance.now() - startedAt);

  console.log(`Reply (${elapsedMs}ms): ${reply}`);
  expect(reply.trim()).not.toBeEmpty();
}, 125_000);
