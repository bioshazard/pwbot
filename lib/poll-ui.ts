import type { KnownBlock } from "@slack/types";
import { Schema } from "effect";

import { PollMetadataSchema } from "./schemas";

export interface PollMetadata {
  channelId: string;
  creatorId: string;
}
export interface Poll {
  id: string;
  channelId: string;
  question: string;
  creatorId: string;
  allowOptions: boolean;
  status: "draft" | "open" | "closed";
  options: {
    id: string;
    label: string;
    voters: {
      userId: string;
      votes: number;
    }[];
    votes: number;
  }[];
}
interface CheckboxElement {
  action_id: string;
  initial_options?: {
    text: {
      text: string;
      type: "plain_text";
    };
    value: string;
  }[];
  options: {
    text: {
      text: string;
      type: "plain_text";
    };
    value: string;
  }[];
  type: "checkboxes";
}
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
  values: Record<
    string,
    Record<
      string,
      {
        value?: string | null;
      }
    >
  >,
  blockId: string
): string => values[blockId]?.value?.value ?? "";
export const parsePollMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(PollMetadataSchema)
);
export const parsePollCommand = (text: string) => {
  const allowOptions = /(?:^|\s)--allow-options(?:\s|$)/u.test(text);
  const parts = text
    .replaceAll(/(?:^|\s)--allow-options(?=\s|$)/gu, " ")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return { allowOptions, labels: parts.slice(1, 11), question: parts[0] ?? "" };
};
export const pollConfiguration = (
  values: Record<
    string,
    Record<
      string,
      {
        selected_options?: {
          value: string;
        }[];
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
export const pollModal = (
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
export const renderPoll = (poll: Poll): KnownBlock[] => {
  const total = poll.options.reduce((sum, option) => sum + option.votes, 0);
  const voteButtons = poll.options.flatMap((option) => [
    {
      action_id: `poll_vote:${option.id}`,
      style: "primary" as const,
      text: {
        text: `${option.label} + · ${option.votes}`,
        type: "plain_text" as const,
      },
      type: "button" as const,
      value: `${poll.id}:${option.id}`,
    },
    {
      action_id: `poll_remove_vote:${option.id}`,
      text: { text: "−", type: "plain_text" as const },
      type: "button" as const,
      value: `${poll.id}:${option.id}`,
    },
  ]);
  const voteControlBlocks = Array.from(
    { length: Math.ceil(voteButtons.length / 4) },
    (_, index) => ({
      elements: voteButtons.slice(index * 4, index * 4 + 4),
      type: "actions" as const,
    })
  );
  const resultLines = poll.options.map((option) => {
    const voters = option.voters
      .slice(0, 10)
      .map((voter) => `<@${voter.userId}> ×${voter.votes}`)
      .join(" · ");
    const more = option.voters.length - 10;
    const detail =
      voters.length === 0
        ? "_No votes yet_"
        : `${voters}${more > 0 ? ` · +${more} more` : ""}`;
    return `• *${option.label}* — ${detail}`;
  });
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
        text: `*${poll.question}*\n${total} point${total === 1 ? "" : "s"} · 3 per person`,
        type: "mrkdwn" as const,
      },
      type: "section" as const,
    },
    ...(poll.allowOptions && poll.status === "open"
      ? [
          {
            elements: [
              {
                text: "Reply in this thread with *+ your option* to add a choice.",
                type: "mrkdwn" as const,
              },
            ],
            type: "context" as const,
          },
        ]
      : []),
    ...(poll.status === "open" ? voteControlBlocks : []),
    {
      text: {
        text: `*Results*\n${resultLines.join("\n")}`,
        type: "mrkdwn" as const,
      },
      type: "section" as const,
    },
    footer,
  ];
};
