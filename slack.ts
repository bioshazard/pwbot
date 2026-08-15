import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";

import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { z } from "zod";

import { generateReply } from "./reply";

interface MessageEvent {
  id: string;
  channel: string;
  ts: string;
  text: string;
  user?: string;
  threadTs?: string;
  channelType?: string;
  botId?: string;
}

interface PollMetadata {
  channelId: string;
  creatorId: string;
}

interface Poll {
  id: string;
  channelId: string;
  question: string;
  creatorId: string;
  allowOptions: boolean;
  status: "draft" | "open" | "closed";
  options: {
    id: string;
    label: string;
    voters: { userId: string; votes: number }[];
    votes: number;
  }[];
}

interface PollVoteButton {
  action_id: string;
  style?: "danger";
  text: { text: string; type: "plain_text" };
  type: "button";
  value: string;
}

interface CheckboxElement {
  action_id: string;
  initial_options?: {
    text: { text: string; type: "plain_text" };
    value: string;
  }[];
  options: { text: { text: string; type: "plain_text" }; value: string }[];
  type: "checkboxes";
}

interface EventBodyInput {
  event_id?: string;
}
interface MessageInput {
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
}
interface ActionInput {
  type: string;
  value?: string;
}
type LogDetails =
  | Error
  | Record<string, boolean | null | number | string | undefined>;

const eventBodySchema = z.object({ event_id: z.string().optional() });
const messageSchema = z.object({
  bot_id: z.string().optional(),
  channel: z.string(),
  channel_type: z.string().optional(),
  text: z.string(),
  thread_ts: z.string().optional(),
  ts: z.string(),
  user: z.string().optional(),
});
const pollMetadataSchema = z.object({
  channelId: z.string(),
  creatorId: z.string(),
  draftId: z.string().optional(),
});
const actionSchema = z.object({ value: z.string() });
const pollActionBodySchema = z.object({
  container: z.object({
    channel_id: z.string().optional(),
    message_ts: z.string().optional(),
  }),
  trigger_id: z.string().optional(),
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
});
const karmaRowSchema = z.object({ score: z.number() });
const pollRowSchema = z.object({
  allow_options: z.number(),
  channel_id: z.string(),
  creator_id: z.string(),
  id: z.string(),
  question: z.string(),
  status: z.enum(["draft", "open", "closed"]),
});
const pollOptionRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  voters: z.string(),
  votes: z.number(),
});
const postedMessageSchema = z.object({ ts: z.string() });

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const log = (message: string, details?: LogDetails): void => {
  const suffix = details
    ? ` ${details instanceof Error ? (details.stack ?? details.message) : JSON.stringify(details)}`
    : "";
  const line = `${new Date().toISOString()} ${message}${suffix}`;
  appendFileSync("log.out", `${line}\n`);
  console.log(line);
};

const logAsync = async (
  message: string,
  details?: LogDetails
): Promise<void> => {
  const suffix =
    details === undefined
      ? ""
      : ` ${details instanceof Error ? (details.stack ?? details.message) : JSON.stringify(details)}`;
  const line = `${new Date().toISOString()} ${message}${suffix}`;
  await appendFile("log.out", `${line}\n`);
  console.log(line);
};

const karmaCommand = (text: string): boolean =>
  /^\s*<@[A-Za-z0-9]+>\s*(?:\+\+|--)(?:\s+[^\n]+)?\s*$/u.test(text);

const inputBlock = (
  id: string,
  label: string,
  placeholder: string,
  initialValue = "",
  optional = false
) => ({
  block_id: id,
  element: {
    action_id: "value",
    initial_value: initialValue,
    placeholder: { text: placeholder, type: "plain_text" as const },
    type: "plain_text_input" as const,
  },
  label: { text: label, type: "plain_text" as const },
  optional,
  type: "input" as const,
});

const inputValue = (
  values: Record<string, Record<string, { value?: string | null }>>,
  blockId: string
): string => values[blockId]?.value?.value ?? "";

const parsePollMetadata = (value: string): PollMetadata => {
  const parsed = pollMetadataSchema.safeParse(JSON.parse(value));
  if (!parsed.success) {
    throw new TypeError("Invalid poll metadata");
  }
  return parsed.data;
};

const actionValue = (action: ActionInput): string | undefined =>
  actionSchema.safeParse(action).data?.value;

const parsePollCommand = (text: string) => {
  const allowOptions = /(?:^|\s)--allow-options(?:\s|$)/u.test(text);
  const parts = text
    .replaceAll(/(?:^|\s)--allow-options(?=\s|$)/gu, " ")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return { allowOptions, labels: parts.slice(1, 11), question: parts[0] ?? "" };
};

const pollConfiguration = (
  values: Record<
    string,
    Record<
      string,
      {
        selected_options?: { value: string }[];
        value?: string | null;
      }
    >
  >
) => {
  const labels = Object.keys(values)
    .filter((key) => key.startsWith("poll_option_"))
    .toSorted()
    .map((key) => inputValue(values, key).trim())
    .filter(Boolean);
  const allowOptions =
    values.poll_settings?.allow_options?.selected_options?.some(
      (option) => option.value === "allow-options"
    ) ?? false;
  return {
    allowOptions,
    labels,
    optionCount: Object.keys(values).filter((key) =>
      key.startsWith("poll_option_")
    ).length,
    question: inputValue(values, "poll_question").trim(),
  };
};

const optionCheckbox = (allowOptions: boolean) => {
  const element: CheckboxElement = {
    action_id: "allow_options",
    options: [
      {
        text: { text: "Members can add options", type: "plain_text" as const },
        value: "allow-options",
      },
    ],
    type: "checkboxes" as const,
  };
  if (allowOptions) {
    element.initial_options = element.options;
  }
  return element;
};

const pollModal = (
  metadata: PollMetadata,
  optionCount: number,
  question = "",
  labels: string[] = [],
  allowOptions = false
) => ({
  blocks: [
    inputBlock("poll_question", "Question", "What should we decide?", question),
    ...Array.from({ length: optionCount }, (_, index) =>
      inputBlock(
        `poll_option_${index}`,
        `Option ${index + 1}`,
        "Option",
        labels[index] ?? "",
        index !== 0
      )
    ),
    {
      elements: [
        ...(optionCount < 10
          ? [
              {
                action_id: "poll_add_option",
                text: { text: "Add option", type: "plain_text" as const },
                type: "button" as const,
              },
            ]
          : []),
        ...(optionCount > 1
          ? [
              {
                action_id: "poll_remove_option",
                text: {
                  text: "Remove last option",
                  type: "plain_text" as const,
                },
                type: "button" as const,
              },
            ]
          : []),
      ],
      type: "actions" as const,
    },
    {
      block_id: "poll_settings",
      element: optionCheckbox(allowOptions),
      label: { text: "Options", type: "plain_text" as const },
      optional: true,
      type: "input" as const,
    },
  ],
  callback_id: "poll_create",
  close: { text: "Cancel", type: "plain_text" as const },
  private_metadata: JSON.stringify(metadata),
  submit: { text: "Create poll", type: "plain_text" as const },
  title: { text: "Create poll", type: "plain_text" as const },
  type: "modal" as const,
});

const eventId = (body: EventBodyInput, fallback: string): string =>
  eventBodySchema.safeParse(body).data?.event_id ?? fallback;

const readMessage = (
  value: MessageInput,
  body: EventBodyInput
): MessageEvent | undefined => {
  const parsed = messageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const message = parsed.data;
  const event: MessageEvent = {
    channel: message.channel,
    id: eventId(body, `${message.channel}:${message.ts}`),
    text: message.text,
    ts: message.ts,
  };
  if (message.thread_ts !== undefined) {
    event.threadTs = message.thread_ts;
  }
  if (message.channel_type !== undefined) {
    event.channelType = message.channel_type;
  }
  if (message.user !== undefined) {
    event.user = message.user;
  }
  if (message.bot_id !== undefined) {
    event.botId = message.bot_id;
  }
  return event;
};

const botToken = required("SLACK_BOT_TOKEN");
const appToken = required("SLACK_APP_TOKEN");
const pollCommand = process.env.POLL_COMMAND ?? "/pwpoll";
const db = new Database("pwbot.sqlite");

db.run(`
  CREATE TABLE IF NOT EXISTS handled_events (event_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS karma (user_id TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_ts TEXT,
    question TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    allow_options INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS poll_options (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE(poll_id, position)
  );
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    votes INTEGER NOT NULL DEFAULT 1 CHECK(votes BETWEEN 1 AND 3),
    PRIMARY KEY(poll_id, user_id, option_id)
  );
`);

const voteColumns = db
  .query<unknown, []>("PRAGMA table_info(poll_votes)")
  .all()
  .map((column) => z.object({ name: z.string() }).parse(column).name);
if (!voteColumns.includes("votes")) {
  db.transaction(() => {
    db.run("ALTER TABLE poll_votes RENAME TO poll_votes_legacy");
    db.run(`
      CREATE TABLE poll_votes (
        poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
        votes INTEGER NOT NULL DEFAULT 1 CHECK(votes BETWEEN 1 AND 3),
        PRIMARY KEY(poll_id, user_id, option_id)
      )
    `);
    db.run(
      "INSERT INTO poll_votes(poll_id, user_id, option_id, votes) SELECT poll_id, user_id, option_id, 1 FROM poll_votes_legacy"
    );
    db.run("DROP TABLE poll_votes_legacy");
  })();
}
const pollColumns = db
  .query<unknown, []>("PRAGMA table_info(polls)")
  .all()
  .map((column) => z.object({ name: z.string() }).parse(column).name);
if (!pollColumns.includes("allow_options")) {
  db.run(
    "ALTER TABLE polls ADD COLUMN allow_options INTEGER NOT NULL DEFAULT 0"
  );
}

const app = new App({ appToken, socketMode: true, token: botToken });
const auth = await app.client.auth.test();
if (auth.user_id === undefined || auth.user_id.length === 0) {
  throw new TypeError("Slack did not return a bot user ID");
}
const botUserId = auth.user_id;

const uninitialized = (name: string): never => {
  throw new Error(`${name} was called before initialization`);
};

let answer: (event: MessageEvent) => Promise<void> = () =>
  uninitialized("answer");
let createPoll: (
  channelId: string,
  creatorId: string,
  question: string,
  labels: string[],
  allowOptions: boolean
) => Poll = () => uninitialized("createPoll");
let castVote: (
  pollId: string,
  optionId: string,
  userId: string
) => Poll | undefined = () => uninitialized("castVote");
let closePoll: (pollId: string, userId: string) => Poll | undefined = () =>
  uninitialized("closePoll");
let addPollOption: (pollId: string, label: string) => Poll | undefined = () =>
  uninitialized("addPollOption");
let getPoll: (id: string) => Poll | undefined = () => uninitialized("getPoll");
let getPollByMessageTs: (messageTs: string) => Poll | undefined = () =>
  uninitialized("getPollByMessageTs");
let renderPoll: (poll: Poll) => KnownBlock[] = () =>
  uninitialized("renderPoll");
let applyKarma: (text: string, actor: string) => void = () =>
  uninitialized("applyKarma");
let changeKarma: (userId: string, amount: number) => void = () =>
  uninitialized("changeKarma");
let once: (
  id: string,
  work: () => Promise<void> | void
) => Promise<void> = () => uninitialized("once");
let stop: () => Promise<void> = () => uninitialized("stop");

app.message(async ({ message, body, client }) => {
  const event = readMessage(message, body);
  if (
    event === undefined ||
    event.botId !== undefined ||
    event.user === undefined
  ) {
    return;
  }
  const userId = event.user;

  if (karmaCommand(event.text)) {
    await once(event.id, () => {
      applyKarma(event.text, userId);
    });
    return;
  }

  if (event.threadTs !== undefined && /^\+\s+\S/u.test(event.text)) {
    const parent = getPollByMessageTs(event.threadTs);
    if (parent === undefined) {
      if (event.channelType === "im") {
        await once(event.id, async () => {
          await answer(event);
        });
      }
      return;
    }
    const poll = addPollOption(parent.id, event.text.replace(/^\+\s+/u, ""));
    if (poll !== undefined) {
      await client.chat.update({
        blocks: renderPoll(poll),
        channel: parent.channelId,
        text: poll.question,
        ts: event.threadTs,
      });
    }
    return;
  }

  if (event.channelType === "im") {
    await once(event.id, async () => {
      await answer(event);
    });
  }
});

app.event("app_mention", async ({ event, body }) => {
  const message = readMessage(event, body);
  if (
    message === undefined ||
    message.botId !== undefined ||
    message.user === undefined
  ) {
    return;
  }
  await once(message.id, async () => {
    await answer(message);
  });
});

app.command(pollCommand, async ({ ack, body, client }) => {
  await ack();
  const parsed = parsePollCommand(body.text);
  if (parsed.question.length > 0 && parsed.labels.length >= 1) {
    const poll = createPoll(
      body.channel_id,
      body.user_id,
      parsed.question,
      parsed.labels,
      parsed.allowOptions
    );
    const postMessage = client.chat.postMessage.bind(client.chat);
    const posted = await postMessage({
      blocks: renderPoll(poll),
      channel: body.channel_id,
      text: poll.question,
    });
    db.prepare("UPDATE polls SET message_ts = ? WHERE id = ?").run(
      postedMessageSchema.parse(posted).ts,
      poll.id
    );
    return;
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: pollModal({ channelId: body.channel_id, creatorId: body.user_id }, 3),
  });
});

const updatePollModal = async (
  client: typeof app.client,
  view: {
    hash: string;
    id: string;
    private_metadata: string;
    state: {
      values: Record<
        string,
        Record<
          string,
          { selected_options?: { value: string }[]; value?: string | null }
        >
      >;
    };
  },
  optionCount: number
): Promise<void> => {
  const metadata = parsePollMetadata(view.private_metadata);
  const configuration = pollConfiguration(view.state.values);
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
  });
};

app.action("poll_add_option", async ({ ack, body, client }) => {
  await ack();
  if (body.type !== "block_actions" || body.view === undefined) {
    return;
  }
  const optionCount = Math.min(
    pollConfiguration(body.view.state.values).optionCount + 1,
    10
  );
  await updatePollModal(client, body.view, optionCount);
});

app.action("poll_remove_option", async ({ ack, body, client }) => {
  await ack();
  if (body.type !== "block_actions" || body.view === undefined) {
    return;
  }
  const optionCount = Math.max(
    pollConfiguration(body.view.state.values).optionCount - 1,
    1
  );
  await updatePollModal(client, body.view, optionCount);
});

app.view("poll_create", async ({ ack, body: _body, view, client }) => {
  const metadata = parsePollMetadata(view.private_metadata);
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
  const poll = createPoll(
    metadata.channelId,
    metadata.creatorId,
    configuration.question,
    configuration.labels,
    configuration.allowOptions
  );
  try {
    const postMessage = client.chat.postMessage.bind(client.chat);
    const posted = await postMessage({
      blocks: renderPoll(poll),
      channel: poll.channelId,
      text: poll.question,
    });
    db.prepare("UPDATE polls SET message_ts = ? WHERE id = ?").run(
      postedMessageSchema.parse(posted).ts,
      poll.id
    );
  } catch (error) {
    db.prepare("DELETE FROM polls WHERE id = ?").run(poll.id);
    throw error;
  }
});

app.action("poll_vote", async ({ ack, body, action, client }) => {
  await ack();
  const parsedBody = pollActionBodySchema.safeParse(body);
  const value = actionValue(action);
  if (!parsedBody.success || value === undefined) {
    return;
  }
  const { container, user } = parsedBody.data;
  const [pollId, optionId] = value.split(":");
  if (
    pollId === undefined ||
    pollId.length === 0 ||
    optionId === undefined ||
    optionId.length === 0
  ) {
    return;
  }
  const poll = castVote(pollId, optionId, user.id);
  if (
    poll === undefined ||
    container.channel_id === undefined ||
    container.message_ts === undefined
  ) {
    return;
  }
  await client.chat.update({
    blocks: renderPoll(poll),
    channel: container.channel_id,
    text: poll.question,
    ts: container.message_ts,
  });
});

app.action("poll_close", async ({ ack, body, action, client }) => {
  await ack();
  const parsedBody = pollActionBodySchema.safeParse(body);
  const value = actionValue(action);
  if (!parsedBody.success || value === undefined) {
    return;
  }
  const { container, user } = parsedBody.data;
  const poll = closePoll(value, user.id);
  if (
    poll === undefined ||
    container.channel_id === undefined ||
    container.message_ts === undefined
  ) {
    return;
  }
  await client.chat.update({
    blocks: renderPoll(poll),
    channel: container.channel_id,
    text: `Closed: ${poll.question}`,
    ts: container.message_ts,
  });
});

app.event("reaction_added", async ({ event, body }) => {
  await once(eventId(body, `reaction-added:${event.event_ts}`), () => {
    if (
      event.item.type !== "message" ||
      !event.item_user ||
      event.user === event.item_user ||
      event.item_user === botUserId
    ) {
      return;
    }
    changeKarma(event.item_user, event.reaction === "plusplus" ? 1 : 0.1);
    log("Applied reaction karma", {
      reaction: event.reaction,
      target: event.item_user,
    });
  });
});

app.event("reaction_removed", async ({ event, body }) => {
  await once(eventId(body, `reaction-removed:${event.event_ts}`), () => {
    if (
      event.item.type !== "message" ||
      !event.item_user ||
      event.user === event.item_user ||
      event.item_user === botUserId
    ) {
      return;
    }
    changeKarma(event.item_user, event.reaction === "plusplus" ? -1 : -0.1);
    log("Removed reaction karma", {
      reaction: event.reaction,
      target: event.item_user,
    });
  });
});

process.on("uncaughtException", (error) => {
  log("Uncaught exception", error);
});
process.on("unhandledRejection", (error) => {
  log(
    "Unhandled rejection",
    error instanceof Error ? error : { error: String(error) }
  );
});

// oxlint-disable-next-line promise/prefer-await-to-callbacks
app.error(async (error) => {
  // Bolt's public API requires a Promise-returning error callback.
  // oxlint-disable-next-line promise/no-promise-in-callback
  await logAsync("Bolt error", error);
});

answer = async (event: MessageEvent): Promise<void> => {
  if (event.user === undefined) {
    return;
  }
  log("Received message", {
    channel: event.channel,
    channelType: event.channelType,
    eventId: event.id,
  });
  const replies = await app.client.conversations.replies({
    channel: event.channel,
    ts: event.threadTs ?? event.ts,
  });
  const thread =
    (replies.messages ?? [])
      .map((message) => {
        const parsed = messageSchema.safeParse(message);
        if (!parsed.success) {
          return "unknown: ";
        }
        const { text: messageText, user } = parsed.data;
        return `${user === undefined ? "unknown" : `<@${user}>`}: ${messageText.trim()}`;
      })
      .join("\n") || "No messages.";
  let text: string;
  try {
    text = await generateReply({
      getKarma: (userId) => {
        const row = db
          .query<unknown, [string]>("SELECT score FROM karma WHERE user_id = ?")
          .get(userId);
        return karmaRowSchema.safeParse(row).data?.score ?? 0;
      },
      thread,
      userId: event.user,
    });
  } catch (error) {
    log(
      "Model request failed",
      error instanceof Error ? error : { error: String(error) }
    );
    text =
      "Sorry — the reply service is temporarily unavailable (503). Please try again.";
  }
  const postMessage = app.client.chat.postMessage.bind(app.client.chat);
  await postMessage({
    channel: event.channel,
    mrkdwn: true,
    text,
    thread_ts: event.threadTs ?? event.ts,
  });
  log("Posted reply", { eventId: event.id });
};

createPoll = (
  channelId: string,
  creatorId: string,
  question: string,
  labels: string[],
  allowOptions: boolean
): Poll => {
  const pollId = randomUUID();
  const create = db.transaction(() => {
    db.prepare(
      "INSERT INTO polls(id, channel_id, question, creator_id, status, allow_options) VALUES (?, ?, ?, ?, 'open', ?)"
    ).run(pollId, channelId, question, creatorId, Number(allowOptions));
    const insert = db.prepare(
      "INSERT INTO poll_options(id, poll_id, label, position) VALUES (?, ?, ?, ?)"
    );
    for (const [position, label] of labels.entries()) {
      insert.run(randomUUID(), pollId, label, position);
    }
  });
  create();
  const poll = getPoll(pollId);
  if (poll === undefined) {
    throw new Error("Created poll could not be read");
  }
  return poll;
};

castVote = (
  pollId: string,
  optionId: string,
  userId: string
): Poll | undefined => {
  let updated: Poll | undefined;
  const vote = db.transaction(() => {
    const poll = getPoll(pollId);
    if (
      !poll ||
      poll.status !== "open" ||
      !poll.options.some((option) => option.id === optionId)
    ) {
      return;
    }
    const total = db
      .query<unknown, [string, string]>(
        "SELECT COALESCE(SUM(votes), 0) AS total FROM poll_votes WHERE poll_id = ? AND user_id = ?"
      )
      .get(pollId, userId);
    const used = z.object({ total: z.number() }).parse(total).total;
    if (used >= 3) {
      return;
    }
    db.prepare(
      "INSERT INTO poll_votes(poll_id, user_id, option_id, votes) VALUES (?, ?, ?, 1) ON CONFLICT(poll_id, user_id, option_id) DO UPDATE SET votes = votes + 1"
    ).run(pollId, userId, optionId);
    updated = getPoll(pollId);
  });
  vote();
  return updated;
};

addPollOption = (pollId: string, label: string): Poll | undefined => {
  let updated: Poll | undefined;
  const add = db.transaction(() => {
    const poll = getPoll(pollId);
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
    db.prepare(
      "INSERT INTO poll_options(id, poll_id, label, position) VALUES (?, ?, ?, ?)"
    ).run(randomUUID(), pollId, label, poll.options.length);
    updated = getPoll(pollId);
  });
  add();
  return updated;
};

closePoll = (pollId: string, userId: string): Poll | undefined => {
  let updated: Poll | undefined;
  const close = db.transaction(() => {
    const poll = getPoll(pollId);
    if (!poll || poll.creatorId !== userId || poll.status !== "open") {
      return;
    }
    db.prepare("UPDATE polls SET status = 'closed' WHERE id = ?").run(pollId);
    updated = getPoll(pollId);
  });
  close();
  return updated;
};

getPoll = (id: string): Poll | undefined => {
  const rawRow = db
    .query<unknown, [string]>(
      "SELECT id, channel_id, question, creator_id, status, allow_options FROM polls WHERE id = ?"
    )
    .get(id);
  const pollRow = pollRowSchema.safeParse(rawRow);
  if (!pollRow.success) {
    return undefined;
  }
  const rawOptions = db
    .query<unknown, [string]>(
      "SELECT o.id, o.label, COALESCE(SUM(v.votes), 0) AS votes, COALESCE(GROUP_CONCAT(v.user_id || ':' || v.votes, ','), '') AS voters FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id WHERE o.poll_id = ? GROUP BY o.id ORDER BY o.position"
    )
    .all(id);
  const options = z.array(pollOptionRowSchema).safeParse(rawOptions);
  if (!options.success) {
    throw new TypeError("Invalid poll options in database");
  }
  const row = pollRow.data;
  return {
    allowOptions: row.allow_options === 1,
    channelId: row.channel_id,
    creatorId: row.creator_id,
    id: row.id,
    options: options.data.map((option) => ({
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
  };
};

getPollByMessageTs = (messageTs: string): Poll | undefined => {
  const row = db
    .query<unknown, [string]>("SELECT id FROM polls WHERE message_ts = ?")
    .get(messageTs);
  const parsed = z.object({ id: z.string() }).safeParse(row);
  return parsed.success ? getPoll(parsed.data.id) : undefined;
};

renderPoll = (poll: Poll) => {
  const total = poll.options.reduce((sum, option) => sum + option.votes, 0);
  const heading = `*${poll.question}*`;
  const footer: KnownBlock =
    poll.status === "open"
      ? {
          elements: [
            {
              action_id: "poll_close",
              text: { text: "Close poll", type: "plain_text" },
              type: "button",
              value: poll.id,
            },
          ],
          type: "actions",
        }
      : {
          elements: [{ text: "Poll closed.", type: "mrkdwn" }],
          type: "context",
        };
  return [
    {
      text: {
        text: `${heading}\n${total} point${total === 1 ? "" : "s"} cast · up to 3 per person`,
        type: "mrkdwn" as const,
      },
      type: "section" as const,
    },
    ...(poll.allowOptions && poll.status === "open"
      ? [
          {
            elements: [
              {
                text: "Add an option in this poll's thread with `+ Your option`.",
                type: "mrkdwn" as const,
              },
            ],
            type: "context" as const,
          },
        ]
      : []),
    ...(poll.status === "open"
      ? poll.options.map((option) => {
          const button: PollVoteButton = {
            action_id: "poll_vote",
            text: {
              text: `+ ${option.label} · ${option.votes}`,
              type: "plain_text",
            },
            type: "button",
            value: `${poll.id}:${option.id}`,
          };
          return { elements: [button], type: "actions" as const };
        })
      : []),
    ...poll.options.map((option) => {
      const visibleVoters = option.voters.slice(0, 10);
      const voterNames = visibleVoters
        .map((voter) => `<@${voter.userId}> ×${voter.votes}`)
        .join(" · ");
      const remaining = option.voters.length - visibleVoters.length;
      const text =
        voterNames.length === 0
          ? `*${option.label}* — no votes yet`
          : `*${option.label}* — ${voterNames}${remaining > 0 ? ` · +${remaining} more` : ""}`;
      return {
        elements: [{ text, type: "mrkdwn" as const }],
        type: "context" as const,
      };
    }),
    footer,
  ];
};

applyKarma = (text: string, actor: string): void => {
  const match =
    /^\s*<@(?<target>[A-Za-z0-9]+)>\s*(?<direction>\+\+|--)(?:\s+[^\n]+)?\s*$/u.exec(
      text
    );
  if (!match) {
    return;
  }
  const { groups } = match;
  if (groups === undefined) {
    return;
  }
  const { direction, target } = groups;
  if (target === actor || target === botUserId) {
    return;
  }
  changeKarma(target, direction === "++" ? 1 : -1);
  log("Applied message karma", { direction, target });
};

changeKarma = (userId: string, amount: number): void => {
  db.prepare(
    `INSERT INTO karma(user_id, score) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET score = score + excluded.score`
  ).run(userId, amount);
};

once = async (id: string, work: () => Promise<void> | void): Promise<void> => {
  const claimed =
    db
      .prepare("INSERT OR IGNORE INTO handled_events(event_id) VALUES (?)")
      .run(id).changes === 1;
  if (!claimed) {
    return;
  }
  try {
    await work();
  } catch (error) {
    db.prepare("DELETE FROM handled_events WHERE event_id = ?").run(id);
    log(
      "Event failed",
      error instanceof Error ? error : { error: String(error) }
    );
    throw error;
  }
};

stop = async (): Promise<void> => {
  log("Stopping PW Bot");
  try {
    await app.stop();
  } catch (error) {
    log(
      "Failed to stop PW Bot",
      error instanceof Error ? error : { error: String(error) }
    );
  } finally {
    db.close();
  }
};

// Node signal callbacks discard return values.
// oxlint-disable-next-line eslint/no-void
process.once("SIGINT", () => void stop());
// oxlint-disable-next-line eslint/no-void
process.once("SIGTERM", () => void stop());

await app.start();
log("PW Bot is running", { botUserId });
