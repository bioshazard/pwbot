import { App, LogLevel } from '@slack/bolt';
import { reply } from './lib/llm';

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

app.message( async( event ) => {

  app.logger.debug("Message seen")
  const msg = event.message.text
  const isIM = event.message.channel_type === "im"
  const tagged = msg.includes(`<@${bot.user_id}>`)

  // Return early if not directed at me
  if(!tagged && !isIM) {
    app.logger.info("Ignoring message")
    return
  }

  const threadTs = event.message.thread_ts || event.message.ts;
  const replies = await app.client.conversations.replies({
    channel: event.message.channel,
    ts: threadTs,
  });

  const history = replies.messages?.map(
    reply => `${reply.user}: ${reply.text}`
  ).join("\n\n")


  const prompt = [
    { role: 'system', content: "You are a helpful assistant." },
    {
      role: "user",
      content: [
        "So I was talking to my buddies earlier. Here is what they said...",
        [
          "```",
          history,
          "```",
        ].join("\n"),
        `I am ${bot.user_id}. Provide a thoughtful concise reply.`,
      ].join("\n\n")
    },
    { role: "assistant", content: `${event.message.user}:` }
  ]

  const out = await reply(prompt)
  await event.say({
    text: `${out}`,
    mrkdwn: true,
    thread_ts: event.message.ts,
  })
});

(async () => {
  await app.start();
  app.logger.info('⚡️ Bolt app is running!');
})();

