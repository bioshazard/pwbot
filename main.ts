import { App, LogLevel } from '@slack/bolt';
import { reply, type PromptMessage } from './lib/llm';

type SlackTextMessage = {
  text: string;
  ts: string;
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  user?: string;
};

const isSlackTextMessage = (message: unknown): message is SlackTextMessage => {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const candidate = message as Record<string, unknown>;

  return (
    typeof candidate.text === 'string' &&
    typeof candidate.ts === 'string' &&
    typeof candidate.channel === 'string'
  );
};

/**
 * This sample slack application uses SocketMode.
 * For the companion getting started setup guide, see:
 * https://tools.slack.dev/bolt-js/getting-started/
 */

// Initializes your app with your bot token and app token
const app = new App({
  socketMode: true,
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
	// signingSecret: process.env.SLACK_SIGNING_SECRET,
	logLevel: LogLevel.INFO,
});

// Could also pull from event.context.botUserId
const bot = await app.client.auth.test()

app.message(async (event) => {
  app.logger.debug('Message seen');

  if (!isSlackTextMessage(event.message)) {
    app.logger.info('Ignoring message without readable text');
    return;
  }

  const incoming = event.message;
  const tagged = incoming.text.includes(`<@${bot.user_id}>`);
  const isIM = incoming.channel_type === 'im';

  if (!tagged && !isIM) {
    app.logger.info('Ignoring message');
    return;
  }

  const threadTs = incoming.thread_ts ?? incoming.ts;
  const replies = await app.client.conversations.replies({
    channel: incoming.channel,
    ts: threadTs,
  });

  const transcript =
    replies.messages
      ?.map((reply) => {
        const replyUser =
          typeof reply?.user === 'string' ? `<@${reply.user}>` : 'unknown';
        const replyText =
          typeof reply?.text === 'string' ? reply.text.trim() : '';
        return `${replyUser}: ${replyText}`;
      })
      .join('\n\n') ?? 'No prior messages in the thread.';

  const prompt: PromptMessage[] = [
    {
      role: 'system',
      content: [
        'You help our team by drafting replies inside Slack threads.',
        'Respond with the exact message body we should post, formatted with Slack markdown when it improves clarity.',
        'Adopt a concise, friendly, and action-oriented tone. Ask for clarification only if the request lacks required details.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        'Slack thread transcript (latest message last):',
        '```',
        transcript,
        '```',
        `Compose the next reply in this thread on behalf of <@${bot.user_id}>. Address <@${incoming.user}> when it helps the reader.`,
      ].join('\n'),
    },
  ];

  const out = await reply(prompt);
  await event.say({
    text: out,
    mrkdwn: true,
    thread_ts: incoming.ts,
  });
});

(async () => {
  await app.start();
  app.logger.info('⚡️ Bolt app is running!');
})();
