/**
 * Project memory: the decisions a codebase does not show.
 *
 * Borrowed from firstmate's `/stow` idea - sweep the durable knowledge a session
 * has accumulated into a file, so the next session starts informed instead of
 * re-litigating settled questions. The version that fits an in-browser app is
 * deliberately narrow: one markdown file inside the project, `.bolt/memory.md`,
 * because that is the only place with all four properties we need:
 *
 *   - it is part of the artifact, so it survives a page reload (Bolt replays the
 *     message history into a fresh WebContainer);
 *   - it is part of the exported repo, so a *new* chat on the same project reads
 *     the same notes, and cloning the repo brings them back;
 *   - it is in the system prompt under its own heading, not in the context buffer,
 *     so the request trimmer never discards it (see contextBudget);
 *   - it is a plain file, so the person can open it and delete what is wrong.
 *
 * Everything here is pure: no stores, no browser, so the merge rules - which are
 * the whole risk of the feature, since a bad merge silently loses a decision -
 * are unit tested.
 */

export const MEMORY_PATH = '.bolt/memory.md';
export const MEMORY_TITLE = '# Project memory';

/** ~1.7k tokens at 3.4 chars/token: enough for a project, cheap on every turn. */
export const MAX_MEMORY_CHARS = 6000;
export const MAX_BULLETS_PER_SECTION = 14;
export const MAX_NEW_BULLETS_PER_STOW = 8;

export const MEMORY_SECTIONS = ['Decisions', 'Constraints', 'Gotchas', 'Verified'] as const;

export type MemorySectionName = (typeof MEMORY_SECTIONS)[number];

export interface MemoryDoc {
  preamble: string;
  sections: { name: MemorySectionName; bullets: string[] }[];
}

export interface MemoryMerge {
  /** Canonical file text to write. Unchanged when nothing new was found. */
  text: string;
  added: string[];

  /** Bullets that fell off a cap - reported so the loss is never silent. */
  dropped: string[];
  duplicateCount: number;
  changed: boolean;
}

/**
 * What the model is told, every turn. It has to be in the prompt rather than in a
 * skill file because the memory has to be *merged* by something that can read the
 * whole conversation, and the merge rules are where a naive implementation loses
 * history by rewriting the file.
 */
export const MEMORY_PROTOCOL = `PROJECT MEMORY - \`${MEMORY_PATH}\` in the project records what the code itself does not show: a decision that was made between two viable options, a constraint, a trap that bit once, something verified.

Read it before acting. It outranks your own guesses about the project's preferences.

Maintain it as you go, in the same artifact you are already writing:
- Append bullets under \`## Decisions\`, \`## Constraints\`, \`## Gotchas\` or \`## Verified\`. One line each, starting with \`-\`, under 200 characters, written so they read correctly to someone who was not here.
- Never rewrite, reorder or delete existing bullets, and never restate one that is already there in other words. If a note becomes false, replace its text on the same line and keep the line.
- Record only what outlives the current request. No file paths that move, no narration of what you are doing now, no secrets or API keys.
- When the file would grow past about 40 bullets, drop the least useful ones from the bottom of a section instead of adding new ones on top.

If there is nothing worth recording from this turn, do not touch the file.`;

const PREAMBLE =
  'What the code does not show: decisions made between real alternatives, constraints, traps that already bit once, and things that were checked so nobody re-checks them. Keep it merged and short - do not rewrite history.';

/* ------------------------------------------------------------------ parsing */

/** `## Gotchas` etc. Tolerates a missing space and a stray `#` level. */
const SECTION_HEADING = /^#{1,3}\s*(Decisions|Constraints|Gotchas|Verified)\b/i;
const BULLET = /^\s*[-*+]\s+(.*)$/;

export function parseMemory(text: string | undefined | null): MemoryDoc {
  const sections = new Map<MemorySectionName, string[]>(MEMORY_SECTIONS.map((name) => [name, []]));
  const preambleLines: string[] = [];
  let current: MemorySectionName | undefined;

  for (const raw of (text ?? '').split('\n')) {
    const heading = raw.match(SECTION_HEADING);

    if (heading) {
      current = (heading[1][0]!.toUpperCase() + heading[1].slice(1).toLowerCase()) as MemorySectionName;
      continue;
    }

    if (!raw.trim()) {
      if (current) {
        continue;
      }
    }

    if (!current) {
      if (raw.trim() && !raw.startsWith(MEMORY_TITLE)) {
        preambleLines.push(raw.trim());
      }

      continue;
    }

    const bullet = raw.match(BULLET);

    if (bullet && bullet[1]) {
      sections.get(current)!.push(cleanBullet(bullet[1]));
    } else if (raw.trim() && !raw.trim().startsWith('#')) {
      /*
       * A wrapped or indented continuation of the bullet above it. Bolt's writers
       * wrap long lines; dropping the tail would silently truncate a decision.
       */
      const bucket = sections.get(current)!;
      const last = bucket[bucket.length - 1];

      if (last !== undefined) {
        bucket[bucket.length - 1] = `${last} ${raw.trim()}`;
      }
    }
  }

  return {
    preamble: preambleLines.join(' ').trim() || PREAMBLE,
    sections: MEMORY_SECTIONS.map((name) => ({ name, bullets: sections.get(name)! })).filter(
      (section) => section.bullets.length > 0,
    ),
  };
}

export function formatMemory(doc: MemoryDoc): string {
  const parts = [MEMORY_TITLE, '', doc.preamble || PREAMBLE];

  for (const section of doc.sections) {
    if (section.bullets.length === 0) {
      continue;
    }

    parts.push('', `## ${section.name}`, ...section.bullets.map((bullet) => `- ${bullet}`));
  }

  return `${parts.join('\n')}\n`;
}

/** Case/markdown-insensitive identity, so a rephrased bullet can be spotted. */
export function bulletKey(bullet: string): string {
  return bullet
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const cleanBullet = (value: string) =>
  value
    .replace(/\s+/g, ' ')
    .replace(/\s+`/g, ' `')
    .replace(/` /g, '`')
    .replace(/[.\s]+$/, '')
    .slice(0, 220);

/* --------------------------------------------------------------- classifying */

/*
 * Deliberately keyed on words a writer chooses when filing a note, not on words
 * that merely appear in prose: `because` shows up in most decisions, and a section
 * rule that fires on it turns the file into one big Gotchas bucket. Anything that
 * matches nothing is a decision, which is the honest default.
 */
const SECTION_RULES: { name: MemorySectionName; pattern: RegExp }[] = [
  { name: 'Gotchas', pattern: /\b(gotcha|caveat|careful|watch out|trap|warning:|heads up|do not forget)\b/i },
  { name: 'Verified', pattern: /\b(verified|confirmed|checked|tested|passes|green|works now|fixed)\b/i },
  {
    name: 'Constraints',
    pattern: /\b(must|cannot|can'?t|has to|have to|only works|requires|never|always|constraint)\b/i,
  },
];

export function classifyBullet(bullet: string): MemorySectionName {
  return SECTION_RULES.find(({ pattern }) => pattern.test(bullet))?.name ?? 'Decisions';
}

/* -------------------------------------------------------------------- merging */

/**
 * Add bullets to the doc without losing anything already there. Duplicates are
 * judged on the normalized key, so the same decision phrased twice lands once.
 * Caps drop from the bottom of a section - oldest first - and every drop is
 * reported, because a merge that quietly forgets is worse than no merge.
 */
export function mergeMemory(existingText: string | undefined | null, incoming: string[]): MemoryMerge {
  const doc = parseMemory(existingText);
  const bySection = new Map<MemorySectionName, string[]>(
    MEMORY_SECTIONS.map((name) => [name, doc.sections.find((s) => s.name === name)?.bullets.slice() ?? []]),
  );
  const seen = new Set<string>([...bySection.values()].flat().map((bullet) => bulletKey(bullet)));
  const added: string[] = [];
  const dropped: string[] = [];
  let duplicateCount = 0;

  for (const raw of incoming) {
    const bullet = cleanBullet(raw);

    if (!bullet) {
      continue;
    }

    const key = bulletKey(bullet);

    if (!key || seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    const name = classifyBullet(bullet);
    const bucket = bySection.get(name)!;

    if (bucket.length >= MAX_BULLETS_PER_SECTION) {
      const removed = bucket.shift();

      if (removed) {
        dropped.push(removed);
        seen.delete(bulletKey(removed));
      }
    }

    bucket.push(bullet);
    seen.add(key);
    added.push(bullet);
  }

  let sections = MEMORY_SECTIONS.map((name) => ({ name, bullets: bySection.get(name)! })).filter(
    (section) => section.bullets.length > 0,
  );

  /*
   * The file is re-sent on every turn, so the size cap is the feature's cost
   * control. Squeeze the biggest section first: it has the most to spare, and
   * evenly splitting a trim across sections would eat one bullet from each of
   * four topics instead of the four least relevant in one.
   */
  let text = formatMemory({ preamble: doc.preamble, sections });

  while (text.length > MAX_MEMORY_CHARS) {
    const largest = sections.reduce((a, b) => (b.bullets.length > a.bullets.length ? b : a), sections[0]);

    if (!largest || largest.bullets.length === 0) {
      break;
    }

    const removed = largest.bullets.shift();

    if (removed) {
      dropped.push(removed);
    }

    sections = sections.filter((section) => section.bullets.length > 0);
    text = formatMemory({ preamble: doc.preamble, sections });
  }

  return { text, added, dropped, duplicateCount, changed: added.length > 0 };
}

/** One line for a toast or a log: what the merge actually did. */
export function describeMerge(merge: MemoryMerge): string {
  const bits: string[] = [];

  if (merge.added.length) {
    bits.push(`${merge.added.length} note${merge.added.length === 1 ? '' : 's'} added`);
  }

  if (merge.duplicateCount) {
    bits.push(`${merge.duplicateCount} already there`);
  }

  if (merge.dropped.length) {
    bits.push(`${merge.dropped.length} oldest dropped to stay under the cap`);
  }

  return bits.join(', ') || 'nothing worth adding';
}

/* ----------------------------------------------------------------- extraction */

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z`[])/;

/**
 * Language that means a choice or a limit was made, as opposed to prose about the
 * task at hand. This is a filter, not a classifier: anything it misses stays out
 * of memory, which is the safe direction, and the model is the primary writer.
 */
const DECISION_MARKERS = [
  /\bwe (?:will|'ll|decided|decide|chose|choose|went with|go with|agreed|are going to)\b/i,
  /\b(?:instead of|rather than|in favou?r of)\b/i,
  /\b(?:don't|do not|never|avoid)\b[^.]{0,40}\b(?:use|adding|rely on|import|install)\b/i,
  /\b(?:no longer|not any more|anymore)\b/i,
  /\broot cause\b/i,
  /\bthe fix (?:was|is)\b/i,
  /\b(?:gotcha|caveat|trap|watch out)\b/i,
  /\b(?:has to|must not|must|only works if)\b/i,
  /\b(?:constraint|requirement|preference)\s*:/i,
];

const SKIP_SENTENCES = [
  /^\s*```/,
  /<bolt[A-Za-z]/,
  /\[Model:/,
  /\[Provider:/,
  /\bI(?:'ll| will|'m going to| am going to)\b/i,
  /\bLet me\b/i,
  /\bNext,? (?:I|we)\b/i,
  /\b(?:Do you want|Would you like|Shall I)\b/i,
  /[?!]$/,
  /^\W*$/,
];

/**
 * Pull candidate notes out of a transcript, cheapest path available: no model
 * call, so a person can hit "Stow" a hundred times for free and the outcome is
 * only ever a slightly shorter sentence list.
 */
export function extractCandidateDecisions(text: string, limit = MAX_NEW_BULLETS_PER_STOW): string[] {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, (quote) => quote);
  const found: string[] = [];
  const seen = new Set<string>();

  for (const chunk of withoutCode.split(SENTENCE_SPLIT)) {
    const sentence = chunk.replace(/\s+/g, ' ').trim();

    if (sentence.length < 24 || sentence.length > 220 || SKIP_SENTENCES.some((pattern) => pattern.test(sentence))) {
      continue;
    }

    if (!DECISION_MARKERS.some((pattern) => pattern.test(sentence))) {
      continue;
    }

    const key = bulletKey(sentence);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    found.push(sentence);

    if (found.length >= limit) {
      break;
    }
  }

  return found;
}

/* ------------------------------------------------------------------ prompting */

/** The memory content may be long; it is fenced so the model quotes it, not edits it. */
export function memoryPromptBlock(content: string | undefined): string {
  if (!content) {
    return `${MEMORY_PROTOCOL}`;
  }

  const doc = parseMemory(content);

  return `${MEMORY_PROTOCOL}

The file currently says:
---
${formatMemory(doc).trim()}
---`;
}

/**
 * Discuss mode cannot write to the project, so it gets the notes without the
 * instructions that would ask it to edit a file: reading memory is useful in a
 * discussion, being told to maintain one is noise.
 */
export function memoryReadBlock(content: string): string {
  const doc = parseMemory(content);

  return `PROJECT MEMORY - notes from earlier work on this project, kept in ${MEMORY_PATH}. This chat is in Discuss mode, so read them and do not try to edit the file.
---
${formatMemory(doc).trim()}
---`;
}

/** Message content as plain text, newest few only: the material a stow reads. */
export function transcriptText(messages: any[] | undefined, limitMessages = 10): string {
  if (!Array.isArray(messages)) {
    return '';
  }

  return messages
    .slice(-limitMessages)
    .map((message) => {
      if (typeof message?.content === 'string') {
        return message.content;
      }

      if (Array.isArray(message?.parts)) {
        return message.parts
          .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join('\n');
      }

      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** The client's file map is keyed with a leading slash; artifacts are not. */
export function readMemoryFromFiles(files: Record<string, any> | undefined): string | undefined {
  if (!files) {
    return undefined;
  }

  for (const key of Object.keys(files)) {
    if (!key.replace(/^\/+/, '').endsWith(MEMORY_PATH)) {
      continue;
    }

    const entry = files[key];

    if (entry && entry.type === 'file' && !entry.isBinary && typeof entry.content === 'string') {
      return entry.content;
    }
  }

  return undefined;
}

/** How many notes the file carries, for a progress line and a badge. */
export function countBullets(content: string | undefined): number {
  if (!content) {
    return 0;
  }

  return parseMemory(content).sections.reduce((total, section) => total + section.bullets.length, 0);
}

/* ---------------------------------------------------------------- persistence */

/** localStorage mirror, so a project-less chat and a reload keep the notes. */
export const MEMORY_MIRROR_PREFIX = 'bolt:project-memory:';

export function memoryMirrorKey(chatId: string | undefined | null): string {
  return `${MEMORY_MIRROR_PREFIX}${chatId || 'default'}`;
}

export const MEMORY_SETTING_KEY = 'project_memory';

/** Opt-out key, like the other automation switches: `false` turns memory off. */
export function isMemoryEnabled(storedValue: string | null | undefined): boolean {
  return storedValue !== 'false';
}
