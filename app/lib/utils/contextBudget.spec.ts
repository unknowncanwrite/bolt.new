import { describe, expect, it } from 'vitest';
import {
  MIN_INPUT_TOKENS,
  describeContextTrim,
  estimateMessageTokens,
  estimateTokens,
  fitToContextWindow,
  inputTokenBudget,
  isContextOverflowError,
  truncateMiddle,
} from './contextBudget';

const artifact = (files: number) =>
  `<boltArtifact id="a" title="t">${Array.from({ length: files }, (_, i) => `<boltAction type="file" filePath="src/f${i}.tsx">${'export const x = 1;\n'.repeat(60)}</boltAction>`).join('')}</boltArtifact>`;

describe('estimateTokens', () => {
  it('treats empty input as free', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('is conservative about code and honest about CJK', () => {
    const code = 'const value = compute(a, b);'.repeat(100);

    // code tokenizes worse than "4 chars per token" would suggest
    expect(estimateTokens(code)).toBeGreaterThan(code.length / 4);

    const chinese = '构建完整的全栈应用程序'.repeat(20);
    expect(estimateTokens(chinese)).toBeGreaterThan(chinese.length / 2);
  });

  it('charges for images and for message framing', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'hi' })).toBeGreaterThan(4);
    expect(
      estimateMessageTokens({
        role: 'user',
        parts: [
          { type: 'text', text: 'look' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
        ],
      }),
    ).toBeGreaterThan(1000);
  });
});

describe('isContextOverflowError', () => {
  it.each([
    'Prompt exceed the maximum length of the model', // DashScope, as seen in the wild
    "This model's maximum context length is 8192 tokens",
    'context_length_exceeded',
    'prompt is too long: 215000 tokens > 200000 maximum',
    'Range of input length should be [1, 258048]',
  ])('recognizes %s', (message) => {
    expect(isContextOverflowError(message)).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isContextOverflowError('Missing API key for DashScope provider')).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError('Rate limit exceeded')).toBe(false);
  });
});

describe('inputTokenBudget', () => {
  it('reserves the reply and distrusts the headline window', () => {
    expect(inputTokenBudget({ maxTokenAllowed: 200000, completionTokens: 16384 })).toBe(
      Math.floor(200000 * 0.85) - 16384,
    );
  });

  it('keeps a floor for tiny or unknown windows', () => {
    expect(inputTokenBudget({ maxTokenAllowed: 4096, completionTokens: 4096 })).toBe(MIN_INPUT_TOKENS);
    expect(inputTokenBudget({})).toBeGreaterThan(0);
  });
});

describe('truncateMiddle', () => {
  it('keeps the beginning and the end, which is where the answer is', () => {
    const text = `${'START '.repeat(400)}MIDDLE${' END'.repeat(400)}`;
    const out = truncateMiddle(text, 200);

    expect(out).toContain('START');
    expect(out).toContain('END');
    expect(out).toContain('trimmed to fit');
    expect(estimateTokens(out)).toBeLessThanOrEqual(300);
  });

  it('leaves short text exactly alone', () => {
    expect(truncateMiddle('a sentence', 1000)).toBe('a sentence');
  });
});

describe('fitToContextWindow', () => {
  it('changes nothing when the request already fits', () => {
    const messages = [
      { role: 'user', content: 'build me a todo app' },
      { role: 'assistant', content: 'here you go' },
    ];
    const result = fitToContextWindow(messages, { systemPrompt: 'You are Bolt.', maxTokenAllowed: 200000 });

    expect(result.messages).toEqual(messages);
    expect(result.systemPrompt).toBe('You are Bolt.');
    expect(result.report.trimmed).toBe(false);
    expect(describeContextTrim(result.report)).toBe('');
  });

  it('drops the code-context buffer before it drops any conversation', () => {
    const hugeContext = `${'index.ts | export const app = 1;\n'.repeat(3000)}`;
    const systemPrompt = `You are Bolt.\n\nBelow is the context.\nCONTEXT BUFFER:\n---\n${hugeContext}\n---\n`;
    const messages = [{ role: 'user', content: 'fix the header' }];

    const result = fitToContextWindow(messages, { systemPrompt, maxTokenAllowed: 32000, completionTokens: 8192 });

    expect(result.report.contextBufferDropped).toBe(true);
    expect(result.systemPrompt).not.toContain('CONTEXT BUFFER');
    expect(result.systemPrompt).toContain('You are Bolt.');
    expect(result.messages).toEqual(messages);
  });

  it('leaves out the old artifacts, never the question being answered', () => {
    const messages = [
      { role: 'user', content: 'create a fullstack todo app' },
      { role: 'assistant', content: artifact(40) },
      { role: 'user', content: 'now add dark mode' },
      { role: 'assistant', content: artifact(40) },
      { role: 'user', content: 'and make the list persist' },
    ];

    const result = fitToContextWindow(messages, {
      systemPrompt: 'You are Bolt.',
      maxTokenAllowed: 32000,
      completionTokens: 8192,
    });

    expect(result.report.droppedMessages).toBeGreaterThan(0);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.messages.at(-1)!.content).toBe('and make the list persist');
    expect(estimateMessageTokens(result.messages[0]) + estimateMessageTokens(result.messages[1])).toBeLessThan(32000);
  });

  it('shrinks a single enormous message instead of sending nothing', () => {
    const messages = [{ role: 'user', content: `${'pasted build log\n'.repeat(20000)}the actual error is here` }];

    const result = fitToContextWindow(messages, {
      systemPrompt: 'You are Bolt.',
      maxTokenAllowed: 16000,
      completionTokens: 4096,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toContain('the actual error is here');
    expect(result.report.truncatedMessages).toBeGreaterThan(0);
    expect(estimateMessageTokens(result.messages[0])).toBeLessThan(result.report.budget);
    expect(describeContextTrim(result.report)).toContain('shortened');
  });
});
