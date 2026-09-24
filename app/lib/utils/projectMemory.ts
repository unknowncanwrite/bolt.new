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

/**
 * One heading and what sat under it. `raw` is the text that was not a bullet —
 * a paragraph, a table, a code fence — kept so a rewrite cannot silently drop it.
 */
export interface MemorySection {
  name: string;
  bullets: string[];
  raw?: string[];
}

export interface MemoryDoc {
  preamble: string;

  /** Known sections come back in canonical order; anything else keeps its name. */
  sections: MemorySection[];
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
- Keep each section under 14 bullets: past that, drop the least useful ones from the top of the section rather than adding to the bottom.
- Bullets may start with \`-\` or a number, and your own extra \`## Headings\` are allowed: they are preserved as written.

If there is nothing worth recording from this turn, do not touch the file.`;

const PREAMBLE =
  'What the code does not show: decisions made between real alternatives, constraints, traps that already bit once, and things that were checked so nobody re-checks them. Keep it merged and short - do not rewrite history.';

/* ------------------------------------------------------------------ parsing */

/*
 * A memory file is written by a model *and* by a person, so the reader has to be
 * forgiving in every direction: any heading name, numbered or dashed bullets, CRLF
 * line endings from a Windows clone, prose between the bullets. Anything it does not
 * recognise is carried through `formatMemory` verbatim, because a merge that quietly
 * forgets a line the model wrote is worse than a merge that does nothing at all.
 */
const KNOWN_HEADING = /^#{1,4}\s*(Decisions|Constraints|Gotchas|Verified)\b/i;
const ANY_HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/;

export function parseMemory(text: string | undefined | null): MemoryDoc {
  const preambleLines: string[] = [];
  const sections: { name: string; bullets: string[]; raw: string[] }[] = [];
  let current: { name: string; bullets: string[]; raw: string[] } | undefined;
  let sawHeading = false;

  const pushSection = (name: string) => {
    const known = name.toLowerCase();
    const existing = sections.find((section) => section.name.toLowerCase() === known);

    if (existing) {
      current = existing;
      return;
    }

    current = { name: canonicalName(name), bullets: [], raw: [] };
    sections.push(current);
  };

  /*
   * Whether the line above was blank: a paragraph that starts after an empty line is
   * its own thought, not the tail of the bullet before it. The formatter writes that
   * blank line on purpose, so ignoring it would fuse prose into a note on every rewrite.
   */
  let afterBlank = false;

  for (const raw of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      afterBlank = true;
      continue;
    }

    const followsBlank = afterBlank;
    afterBlank = false;

    const anyHeading = line.match(ANY_HEADING);

    if (anyHeading) {
      const title = anyHeading[2] ?? '';

      /* The file's own `# Project memory` is chrome, not a section. */
      if (anyHeading[1] === '#' && /project memory/i.test(title)) {
        sawHeading = true;
        current = undefined;
        continue;
      }

      sawHeading = true;
      pushSection(title);
      continue;
    }

    if (!current) {
      if (!sawHeading) {
        preambleLines.push(line.trim());
      }

      continue;
    }

    const bullet = line.match(BULLET);

    if (bullet?.[1]) {
      current.bullets.push(cleanBullet(bullet[1]));
    } else if (bullet) {
      /* an empty bullet (`-` alone): nothing to keep */
    } else if (line.trim().startsWith('#')) {
      current.raw.push(line.trim());
    } else {
      const last = current.bullets[current.bullets.length - 1];

      /*
       * A wrapped continuation of the bullet above it - Bolt's writers wrap long
       * lines, and dropping the tail would silently truncate a decision - otherwise
       * a stray paragraph, kept verbatim so a merge cannot lose it.
       */
      if (last !== undefined && !followsBlank && !/[:.]$/.test(line.trim())) {
        current.bullets[current.bullets.length - 1] = cleanBullet(`${last} ${line.trim()}`);
      } else {
        current.raw.push(line.trim());
      }
    }
  }

  return {
    preamble: preambleLines.join(' ').trim() || PREAMBLE,
    sections: sections
      .map((section) => ({ name: section.name, bullets: section.bullets.filter(Boolean), raw: section.raw ?? [] }))
      .filter((section) => section.bullets.length > 0 || (section.raw ?? []).length > 0),
  };
}

function canonicalName(name: string): string {
  const match = KNOWN_HEADING.exec(`## ${name}`);

  if (match) {
    return match[1]!;
  }

  return name.replace(/\s+/g, ' ').slice(0, 60) || 'Notes';
}

export function formatMemory(doc: MemoryDoc): string {
  const parts = [MEMORY_TITLE, '', doc.preamble || PREAMBLE];

  const ordered = [
    ...MEMORY_SECTIONS.map((name) => doc.sections.find((section) => section.name === name)).filter(Boolean),
    ...doc.sections.filter((section) => !(MEMORY_SECTIONS as readonly string[]).includes(section.name)),
  ] as MemoryDoc['sections'];

  for (const section of ordered) {
    if (!section || (section.bullets.length === 0 && (section.raw ?? []).length === 0)) {
      continue;
    }

    parts.push('', `## ${section.name}`);

    for (const bullet of section.bullets) {
      parts.push(`- ${bullet}`);
    }

    const rawLines = (section.raw ?? []).filter((line) => line.trim() !== '');

    if (section.bullets.length > 0 && rawLines.length > 0) {
      // Without the blank line, the next read folds this paragraph into the bullet above it.
      parts.push('');
    }

    parts.push(...rawLines);
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

/**
 * One shape for every note, whoever wrote it: a leading `-`, `*` or `3.` is the
 * file's list syntax rather than part of the note, so keeping it produced `- - use
 * pnpm` after a merge. Long notes are cut at a word with an ellipsis instead of
 * being dropped, because a dropped decision is a decision nobody knows about.
 */
export function cleanBullet(value: string): string {
  const text = value
    .replace(/\r/g, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+`/g, ' `')
    .replace(/` /g, '`')
    .replace(/[.\s]+$/, '')
    .trim();

  if (text.length <= 220) {
    return text;
  }

  const cut = text.slice(0, 216);

  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 120)).trim()}…`;
}

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
  const bullets = new Map<string, string[]>();

  for (const section of doc.sections) {
    bullets.set(section.name, section.bullets.slice());
  }

  const known = (name: MemorySectionName) => {
    if (!bullets.has(name)) {
      bullets.set(name, []);
    }

    return bullets.get(name)!;
  };

  const seen = new Set<string>();

  for (const list of bullets.values()) {
    for (const bullet of list) {
      seen.add(bulletKey(bullet));
    }
  }

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

    const bucket = known(classifyBullet(bullet));

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

  /*
   * Sections the model invented are copied through untouched - only the known four
   * are subject to the caps, since trimming a heading nobody asked us to own would
   * be editing someone's prose.
   */
  const assemble = () =>
    [
      ...MEMORY_SECTIONS.map((name) => ({
        name,
        bullets: bullets.get(name) ?? [],
        raw: doc.sections.find((section) => section.name === name)?.raw ?? [],
      })).filter((section) => section.bullets.length > 0 || section.raw.length > 0),
      ...doc.sections.filter((section) => !isKnown(section.name)),
    ] as MemoryDoc['sections'];

  const sections = assemble();
  const text = trimToBudget(sections, doc.preamble, MAX_MEMORY_CHARS, (bullet) => dropped.push(bullet));

  return { text, added, dropped, duplicateCount, changed: added.length > 0 };
}

/**
 * Squeeze an over-budget memory doc by dropping its *oldest* bullets first, and return
 * the formatted text. Shared by the merge that writes the file and the embed that sends
 * it, so the two can never disagree about what "too big" means.
 */
const isKnown = (name: string) => (MEMORY_SECTIONS as readonly string[]).includes(name);

function trimToBudget(
  sections: MemoryDoc['sections'],
  preamble: string,
  cap: number,
  onDropped?: (bullet: string) => void,
): string {
  let text = formatMemory({ preamble, sections });
  let guard = 0;

  /*
   * Squeeze the biggest known section: it has the most to spare, and splitting a trim
   * evenly across four topics would eat one bullet from each instead of the several
   * least relevant in one. Unknown sections are never touched - trimming a heading
   * nobody asked us to own would be editing someone's prose.
   */
  while (text.length > cap && guard++ < 400) {
    const candidates = sections.filter((section) => isKnown(section.name) && (section.bullets?.length ?? 0) > 0);

    if (candidates.length === 0) {
      break;
    }

    const largest = candidates.reduce((a, b) => (b.bullets.length > a.bullets.length ? b : a));
    const removed = largest.bullets.shift();

    if (removed) {
      onDropped?.(removed);
    }

    text = formatMemory({ preamble, sections });
  }

  return text;
}

/** Last resort when bullets alone cannot pay for the budget: keep the newest whole lines. */
function keepNewestLines(text: string, cap: number): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length + 1 > cap - 2) {
      break;
    }

    kept.unshift(lines[i]);
    used += lines[i].length + 1;
  }

  return kept.length > 0 ? `…\n${kept.join('\n')}` : `…${text.slice(-Math.max(0, cap - 1))}`;
}

const TRIM_NOTE = '(older notes were trimmed to fit this turn; the file itself still holds them all)';

/**
 * Fit memory text into what a prompt can pay for.
 *
 * The file is re-sent on every turn, so this cap is the feature's cost control. A project
 * whose notes outgrew it loses its oldest bullets *from the view*, never from the file,
 * and is told so - silently showing half the memory would be worse than saying it.
 */
export function clampMemoryForPrompt(content: string | undefined, cap = MAX_MEMORY_CHARS): string {
  const text = (content ?? '').trim();

  if (!text || text.length <= cap - TRIM_NOTE.length - 2) {
    return text;
  }

  const doc = parseMemory(text);
  const budget = cap - TRIM_NOTE.length - 2;

  /*
   * Fold same-name sections together first: the formatter keeps one section per name, so
   * a file that repeated a heading would otherwise lose its second half right here.
   */
  const byName = new Map<string, { name: string; bullets: string[]; raw: string[] }>();

  for (const section of doc.sections) {
    const entry = byName.get(section.name) ?? { name: section.name, bullets: [], raw: [] };

    entry.bullets.push(...(section.bullets ?? []));
    entry.raw.push(...(section.raw ?? []));
    byName.set(section.name, entry);
  }

  let body = trimToBudget([...byName.values()], doc.preamble, budget);

  if (body.length > budget) {
    body = keepNewestLines(body, budget);
  }

  return `${body}\n\n${TRIM_NOTE}`;
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

/*
 * What is *not* the assistant's own prose. An artifact body is generated code, a
 * thought block is private reasoning, and a markdown table is formatting - none of
 * them are decisions about this project, and any of them will otherwise be filed as
 * if they were. The pattern list is ordered so the big wrappers go first; a turn cut
 * off mid-artifact (still streaming) has its remainder dropped by the tail rule in
 * `extractCandidateDecisions`, because half a file is a great source of fake notes.
 */
const NON_PROSE = [
  /<boltArtifact[\s\S]*?<\/boltArtifact>/g,
  /<boltAction[^>]*>[\s\S]*?<\/boltAction>/g,
  /<boltTitle>[\s\S]*?<\/boltTitle>/g,
  /<ToolInvocation[\s\S]*?<\/ToolInvocation>/g,
  /<boltThought>[\s\S]*?<\/boltThought>/g,
  /<think>[\s\S]*?<\/think>/g,
  /<div[^>]*class=["'][^"']*__boltThought__[^"']*["'][^>]*>[\s\S]*?<\/div>/g,
  /```[^`]*```/g,
  /^\s*\|.*\|\s*$/gm,
];

const NON_PROSE_TAIL = /<bolt(?:Artifact|Action|FileModification)/;

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
  /[;{}]$/,
  /^\s*(?:\/\/|\/\*|\*|#define|\s*\|)/,
  /^\s*(?:const|let|var|function|class|import|export|return|if|for|while)\b/,
  /^https?:\/\//,
  /__boltThought__/,
];

/**
 * Pull candidate notes out of a transcript, cheapest path available: no model
 * call, so a person can hit "Stow" a hundred times for free and the outcome is
 * only ever a slightly shorter sentence list.
 */
export function extractCandidateDecisions(text: string, limit = MAX_NEW_BULLETS_PER_STOW): string[] {
  let prose = text ?? '';

  for (const pattern of NON_PROSE) {
    prose = prose.replace(pattern, ' ');
  }

  const unclosed = prose.search(NON_PROSE_TAIL);

  if (unclosed >= 0) {
    prose = prose.slice(0, unclosed);
  }

  const found: string[] = [];
  const seen = new Set<string>();

  for (const chunk of prose.split(SENTENCE_SPLIT)) {
    const sentence = chunk.replace(/\s+/g, ' ').trim();

    if (sentence.length < 24 || SKIP_SENTENCES.some((pattern) => pattern.test(sentence)) || /[<>]/.test(sentence)) {
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
    found.push(cleanBullet(sentence));

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

  return `${MEMORY_PROTOCOL}

The file currently says:
---
${clampMemoryForPrompt(content)}
---`;
}

/**
 * Discuss mode cannot write to the project, so it gets the notes without the
 * instructions that would ask it to edit a file: reading memory is useful in a
 * discussion, being told to maintain one is noise.
 */
export function memoryReadBlock(content: string): string {
  return `PROJECT MEMORY - notes from earlier work on this project, kept in ${MEMORY_PATH}. This chat is in Discuss mode, so read them and do not try to edit the file.
---
${clampMemoryForPrompt(content)}
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
