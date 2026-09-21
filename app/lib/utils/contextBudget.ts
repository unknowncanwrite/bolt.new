/**
 * Fitting a conversation inside the model's window.
 *
 * Every provider charges the same toll: input tokens plus requested output tokens
 * must fit inside the context window, and Bolt has historically only guarded the
 * second half of that. A long chat - dozens of files, each one quoted in full in
 * an artifact, plus the selected code context - eventually trips
 * `Prompt exceed the maximum length of the model` (DashScope's wording; OpenAI
 * says `context_length_exceeded`, Anthropic `prompt is too long`) and the user
 * gets a red box for arithmetic the app could have done itself.
 *
 * The estimates here are deliberately rough and deliberately conservative: a
 * token is not four characters for code, and a truncation the model never notices
 * is much cheaper than a failed turn. The declared window also gets a safety
 * factor, because a catalogue that rounds up (or a free tier that caps lower than
 * the headline number) otherwise reintroduces the exact failure this prevents.
 */

/** Chars per token for prose and code mixed - code tokenizes denser than 4. */
const CHARS_PER_TOKEN = 3.4;

/** CJK text is roughly one token per character. */
const CJK_CHARS_PER_TOKEN = 1.15;

/** Use only this share of the window the model claims, leaving room for its overstatement. */
const WINDOW_SAFETY_FACTOR = 0.85;

/** Never let the input budget fall below this: a turn needs room for a question and an answer. */
export const MIN_INPUT_TOKENS = 2048;

/** Rough cost of an image part, so a screenshot-heavy chat is not treated as free. */
const IMAGE_PART_TOKENS = 1200;

export const CONTEXT_OVERFLOW_PATTERNS = [
  /exceed(?:ed)? the maximum length/i,
  /maximum (?:context |prompt )?length/i,
  /context_length_exceeded/i,
  /prompt is too long/i,
  /input tokens? .{0,24}(?:exceed|greater|larger)/i,
  /too many tokens/i,
  /range of input length/i,
  /context window/i,
];

export function isContextOverflowError(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }

  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

function countCjk(text: string): number {
  const matches = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return matches ? matches.length : 0;
}

export function estimateTokens(text: string | undefined | null): number {
  if (!text) {
    return 0;
  }

  const cjk = countCjk(text);
  const rest = text.length - cjk;

  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + rest / CHARS_PER_TOKEN);
}

/** Content of a chat message: a plain string, or AI SDK `parts`. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') {
          return part;
        }

        if (part?.type === 'text') {
          return part.text ?? '';
        }

        return '';
      })
      .join('\n');
  }

  return '';
}

export function estimateMessageTokens(message: { role?: string; content?: unknown; parts?: unknown }): number {
  const text = contentToText((message as any).content) || contentToText((message as any).parts);
  const images = Array.isArray((message as any).parts)
    ? (message as any).parts.filter((part: any) => part?.type === 'image').length
    : 0;

  // ~4 tokens of role/framing overhead per message
  return estimateTokens(text) + images * IMAGE_PART_TOKENS + 4;
}

export function estimatePayloadTokens(messages: any[], systemPrompt?: string): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), estimateTokens(systemPrompt));
}

export function inputTokenBudget(options: { maxTokenAllowed?: number; completionTokens?: number }): number {
  const window = options.maxTokenAllowed && options.maxTokenAllowed > 0 ? options.maxTokenAllowed : 128000;
  const usable = Math.floor(window * WINDOW_SAFETY_FACTOR);
  const reserved = options.completionTokens ?? 0;

  return Math.max(MIN_INPUT_TOKENS, usable - reserved);
}

/**
 * Cut the middle out of a long text, because the beginning sets up the problem and
 * the end holds the answer. `keepTokens` is the budget for what survives.
 */
export function truncateMiddle(text: string, keepTokens: number): string {
  const keep = Math.max(256, keepTokens);
  const current = estimateTokens(text);

  if (current <= keep) {
    return text;
  }

  const targetChars = Math.floor(keep * CHARS_PER_TOKEN);
  const headChars = Math.floor(targetChars * 0.6);
  const tailChars = targetChars - headChars;
  const dropped = text.length - headChars - tailChars;

  return `${text.slice(0, headChars)}\n\n[... ${dropped} characters trimmed to fit the model's context ...]\n\n${text.slice(-tailChars)}`;
}

export interface ContextFitReport {
  trimmed: boolean;
  droppedMessages: number;
  truncatedMessages: number;
  contextBufferDropped: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  budget: number;
}

export interface ContextFitResult<Message> {
  messages: Message[];
  systemPrompt: string;
  report: ContextFitReport;
}

const CONTEXT_BUFFER_MARKER = 'CONTEXT BUFFER:';

/** The label, its opening fence, the quoted files, and the closing fence. */
const CONTEXT_BUFFER_BLOCK = /CONTEXT BUFFER:\s*\n\s*---\s*\n[\s\S]*?\n\s*---\s*\n?/;

/**
 * Make the payload fit. Reduction order is the order of least harm:
 *
 *  1. the code-context buffer, which duplicates what the artifacts already say;
 *  2. the oldest messages, which the summary already covers when context
 *     optimization is on;
 *  3. the middle of whatever is still too big, last resort of all.
 *
 * The newest user message is never dropped, and never emptied: it is the thing
 * being answered.
 */
export function fitToContextWindow<Message extends { role?: string; content?: unknown; parts?: unknown }>(
  messages: Message[],
  options: { systemPrompt?: string; maxTokenAllowed?: number; completionTokens?: number } = {},
): ContextFitResult<Message> {
  const budget = inputTokenBudget({
    maxTokenAllowed: options.maxTokenAllowed,
    completionTokens: options.completionTokens,
  });
  let systemPrompt = options.systemPrompt ?? '';
  let kept = [...messages];

  const before = estimatePayloadTokens(kept, systemPrompt);
  const report: ContextFitReport = {
    trimmed: false,
    droppedMessages: 0,
    truncatedMessages: 0,
    contextBufferDropped: false,
    estimatedTokensBefore: before,
    estimatedTokensAfter: before,
    budget,
  };

  if (before <= budget) {
    return { messages: kept, systemPrompt, report };
  }

  /* 1. the context buffer, if the prompt carries one */
  if (systemPrompt.includes(CONTEXT_BUFFER_MARKER)) {
    // the block is `CONTEXT BUFFER:` then a fenced body; drop the whole thing
    const rebuilt = systemPrompt.replace(CONTEXT_BUFFER_BLOCK, '\n').replace(/\n{3,}/g, '\n\n');

    if (estimateTokens(rebuilt) < estimateTokens(systemPrompt)) {
      systemPrompt = rebuilt;
      report.contextBufferDropped = true;
    }

    if (estimatePayloadTokens(kept, systemPrompt) <= budget) {
      return finish(kept, systemPrompt, report);
    }
  }

  /* 2. oldest messages first, always keeping the final one */
  const systemCost = estimateTokens(systemPrompt);
  let roomForHistory = budget - systemCost;

  while (kept.length > 1) {
    const total = estimatePayloadTokens(kept) + systemCost;

    if (total <= budget) {
      break;
    }

    // drop the largest of the older messages: those are the artifacts, not the question
    const victimIndex = kept
      .slice(0, -1)
      .map((message, index) => ({ index, cost: estimateMessageTokens(message) }))
      .sort((a, b) => b.cost - a.cost)[0];

    kept = kept.filter((_, index) => index !== victimIndex!.index);
    report.droppedMessages++;
    roomForHistory = budget - systemCost;
  }

  if (estimatePayloadTokens(kept) + systemCost <= budget) {
    return finish(kept, systemPrompt, report);
  }

  /* 3. shrink what is left, oldest first, and only touch the final message last */
  const ordered = [...kept];

  for (let i = 0; i < ordered.length - 1; i++) {
    const total = estimatePayloadTokens(ordered) + systemCost;

    if (total <= budget) {
      break;
    }

    ordered[i] = shrinkMessage(ordered[i], Math.max(256, Math.floor(roomForHistory / Math.max(1, ordered.length))));
    report.truncatedMessages++;
  }

  const stillOver = estimatePayloadTokens(ordered) + systemCost > budget;

  if (stillOver) {
    const lastIndex = ordered.length - 1;
    const spare = Math.max(MIN_INPUT_TOKENS / 2, budget - systemCost - estimatePayloadTokens(ordered.slice(0, -1)));
    ordered[lastIndex] = shrinkMessage(ordered[lastIndex], Math.floor(spare * 0.6));
    report.truncatedMessages++;
  }

  return finish(ordered, systemPrompt, report);
}

function shrinkMessage<Message extends { content?: unknown; parts?: unknown }>(
  message: Message,
  keepTokens: number,
): Message {
  const target = { ...message };

  if (typeof (target as any).content === 'string') {
    (target as any).content = truncateMiddle((target as any).content, keepTokens);

    return target as Message;
  }

  if (Array.isArray((target as any).parts)) {
    (target as any).parts = (target as any).parts.map((part: any) =>
      part?.type === 'text' ? { ...part, text: truncateMiddle(part.text ?? '', keepTokens) } : part,
    );
  }

  return target as Message;
}

function finish<Message>(
  messages: Message[],
  systemPrompt: string,
  report: ContextFitReport,
): ContextFitResult<Message> {
  report.trimmed = report.droppedMessages > 0 || report.truncatedMessages > 0 || report.contextBufferDropped;
  report.estimatedTokensAfter = estimatePayloadTokens(messages, systemPrompt);

  return { messages, systemPrompt, report };
}

/** One line for a log or a progress chip; enough to explain a changed answer. */
export function describeContextTrim(report: ContextFitReport): string {
  const parts: string[] = [];

  if (report.contextBufferDropped) {
    parts.push('dropped the code context buffer');
  }

  if (report.droppedMessages) {
    parts.push(`left out ${report.droppedMessages} older message${report.droppedMessages === 1 ? '' : 's'}`);
  }

  if (report.truncatedMessages) {
    parts.push(`shortened ${report.truncatedMessages} long message${report.truncatedMessages === 1 ? '' : 's'}`);
  }

  if (!parts.length) {
    return '';
  }

  return `${parts.join(', ')} (~${report.estimatedTokensBefore} → ~${report.estimatedTokensAfter} tokens against a ${report.budget} budget)`;
}
