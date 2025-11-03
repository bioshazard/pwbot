import OpenAI from 'openai';

export type PromptMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_BASE,
});

const stripThinkTags = (content: string) =>
  content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

export const reply = async (prompt: PromptMessage[]) => {
  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_API_MODEL || 'gpt-4o',
    messages: prompt,
  });

  const message = completion.choices[0]?.message?.content ?? '';
  return stripThinkTags(message);
};
