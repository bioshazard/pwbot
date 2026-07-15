import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type LanguageModel } from 'ai';

export type PromptMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export const provider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_BASE,
});

export const stripThinkTags = (content: string) =>
  content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

export const createReply =
  (model: LanguageModel) => async (prompt: PromptMessage[]) => {
    const { text } = await generateText({
      model,
      messages: prompt,
      allowSystemInMessages: true,
    });

    return stripThinkTags(text);
  };

export const reply = createReply(
  provider.chat(process.env.OPENAI_API_MODEL || 'gpt-4o'),
);
