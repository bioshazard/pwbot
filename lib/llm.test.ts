import { describe, expect, test } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import { createReply, stripThinkTags } from './llm';

describe('stripThinkTags', () => {
  test('removes hidden reasoning and trims the reply', () => {
    expect(stripThinkTags(' <think>private\nreasoning</think> Hello! ')).toBe(
      'Hello!',
    );
  });

  test('removes every reasoning block case-insensitively', () => {
    expect(stripThinkTags('<THINK>one</THINK>A<think>two</think>B')).toBe('AB');
  });
});

describe('createReply', () => {
  test('generates a sanitized reply through an AI SDK model', async () => {
    const mockFetch = Object.assign(
      async (..._args: Parameters<typeof fetch>) =>
        Response.json({
          id: 'chatcmpl_test',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<think>hidden</think> Ship it.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 4,
            total_tokens: 7,
          },
        }),
      { preconnect: () => {} },
    );
    const provider = createOpenAI({
      apiKey: 'test-key',
      fetch: mockFetch,
    });

    const reply = createReply(provider.chat('test-model'));

    await expect(
      reply([{ role: 'user', content: 'Should we ship?' }]),
    ).resolves.toBe('Ship it.');
  });
});
