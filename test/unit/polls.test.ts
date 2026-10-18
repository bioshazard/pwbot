import { expect, test } from "bun:test";

import { Schema } from "effect";

import {
  parsePollCommand,
  pollConfiguration,
  renderPoll,
} from "../../lib/poll-ui";

test("poll rendering preserves distinct action IDs for each option", () => {
  const blocks = renderPoll({
    allowOptions: true,
    channelId: "C1",
    creatorId: "U1",
    id: "poll",
    options: ["one", "two"].map((id) => ({
      id,
      label: id,
      voters: [],
      votes: 0,
    })),
    question: "Lunch?",
    status: "open",
  });
  const actions = blocks.flatMap((block) =>
    block.type === "actions" ? block.elements : []
  );
  const ids = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ action_id: Schema.String }))
  )(actions).map((action) => action.action_id);
  expect(ids).toContain("poll_vote:one");
  expect(ids).toContain("poll_vote:two");
  expect(ids).toContain("poll_remove_vote:one");
  expect(new Set(ids).size).toBe(ids.length);
});

test("poll commands and modal ignore blank extra options", () => {
  expect(parsePollCommand("--allow-options Lunch? | Pizza | | Sushi")).toEqual({
    allowOptions: true,
    labels: ["Pizza", "Sushi"],
    question: "Lunch?",
  });
  const parsed = pollConfiguration({
    poll_option_0: { value: { value: "Pizza" } },
    poll_option_1: { value: { value: "" } },
    poll_question: { value: { value: "Lunch?" } },
  });
  expect(parsed.labels).toEqual(["Pizza"]);
});
