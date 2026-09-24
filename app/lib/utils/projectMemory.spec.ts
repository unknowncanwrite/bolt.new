import { describe, expect, it } from 'vitest';
import { fitToContextWindow } from './contextBudget';
import {
  MAX_BULLETS_PER_SECTION,
  MAX_MEMORY_CHARS,
  MEMORY_PATH,
  bulletKey,
  classifyBullet,
  countBullets,
  describeMerge,
  extractCandidateDecisions,
  formatMemory,
  isMemoryEnabled,
  memoryMirrorKey,
  memoryPromptBlock,
  mergeMemory,
  parseMemory,
  readMemoryFromFiles,
} from './projectMemory';

const sample = `# Project memory

What the code does not show.

## Decisions
- We went with localStorage instead of a cookie because the value must survive a hard reload
- Styling stays Tailwind; no CSS modules

## Constraints
- The free tier caps the runtime at 512 MB, so no in-memory cache of uploads
`;

describe('parseMemory / formatMemory', () => {
  it('keeps sections and bullets in order', () => {
    const doc = parseMemory(sample);

    expect(doc.sections.map((section) => section.name)).toEqual(['Decisions', 'Constraints']);
    expect(doc.sections[0]!.bullets).toHaveLength(2);
    expect(doc.sections[1]!.bullets[0]).toContain('512 MB');
    expect(formatMemory(doc)).not.toContain('## Gotchas');
  });

  it('repairs a wrapped bullet instead of truncating it', () => {
    const wrapped = '## Decisions\n- the proxy needs the port to be read from\n  the environment, not hardcoded';
    const doc = parseMemory(wrapped);

    expect(doc.sections[0]!.bullets[0]).toBe('the proxy needs the port to be read from the environment, not hardcoded');
  });

  it('handles a missing file, an empty file and a file with no headings', () => {
    for (const text of [undefined, null, '', '# Project memory\n']) {
      expect(parseMemory(text).sections).toEqual([]);
      expect(formatMemory(parseMemory(text))).toContain('# Project memory');
    }
  });

  it('round-trips through the file format', () => {
    const once = formatMemory(parseMemory(sample));

    expect(parseMemory(once).sections.flatMap((s) => s.bullets)).toEqual(
      parseMemory(sample).sections.flatMap((s) => s.bullets),
    );
  });
});

describe('bulletKey', () => {
  it('treats the same decision in different words as the same note', () => {
    expect(bulletKey('Use **pnpm**, not npm!')).toBe(bulletKey('use pnpm, not npm.'));
  });
});

describe('classifyBullet', () => {
  it.each([
    ['We went with pnpm because npm corrupts the lockfile', 'Decisions'],
    ['The runtime must read the port from the environment', 'Constraints'],
    ['Careful: Vite scans the tree at boot, before writes land', 'Gotchas'],
    ['Confirmed: the build passes with 239 tests', 'Verified'],
  ])('%s -> %s', (bullet, name) => {
    expect(classifyBullet(bullet)).toBe(name);
  });
});

describe('mergeMemory', () => {
  it('adds new notes to their section and leaves the rest alone', () => {
    const merge = mergeMemory(sample, ['Gotcha: the preview host is a proxy, so no localhost calls from the browser']);

    expect(merge.changed).toBe(true);
    expect(merge.added).toHaveLength(1);
    expect(merge.text).toContain('## Gotchas');
    expect(merge.text).toContain('- We went with localStorage');
    expect(merge.text.indexOf('## Decisions')).toBeLessThan(merge.text.indexOf('## Gotchas'));
  });

  it('skips notes that are already there, however they are phrased', () => {
    const merge = mergeMemory(sample, ['styling stays tailwind; no css modules.', 'a genuinely new note here']);

    expect(merge.duplicateCount).toBe(1);
    expect(merge.added).toEqual(['a genuinely new note here']);
  });

  it('reports when the merge did nothing', () => {
    const merge = mergeMemory(sample, ['Styling stays Tailwind; no CSS modules']);

    expect(merge.changed).toBe(false);
    expect(describeMerge(merge)).toContain('already there');
    expect(describeMerge(mergeMemory(sample, []))).toBe('nothing worth adding');
  });

  it('trims the oldest bullet when a section is full, never the newest', () => {
    const full = formatMemory({
      preamble: '',
      sections: [
        { name: 'Decisions', bullets: Array.from({ length: MAX_BULLETS_PER_SECTION }, (_, i) => `note ${i}`) },
      ],
    });
    const merge = mergeMemory(full, ['the one that matters most']);

    expect(merge.text).toContain('note 1');
    expect(merge.text).not.toContain('- note 0');
    expect(merge.dropped).toEqual(['note 0']);
    expect(merge.text).toContain('the one that matters most');
  });

  it('stays under the size cap and says what it sacrificed', () => {
    const fat = Array.from({ length: 60 }, (_, i) => `decision ${i}: ${'x'.repeat(90)}`);
    const merge = mergeMemory(undefined, fat);

    expect(merge.text.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS);
    expect(merge.dropped.length).toBeGreaterThan(0);
    expect(describeMerge(merge)).toContain('oldest dropped');
  });

  it('creates a file from scratch when there is none', () => {
    const merge = mergeMemory(undefined, ['We ship without a database because the free tier has none']);

    expect(merge.text.startsWith('# Project memory')).toBe(true);
    expect(merge.text).toContain('## Decisions');
  });
});

describe('extractCandidateDecisions', () => {
  const transcript = `I looked at the repo and the tests were failing.
We went with an in-memory store instead of a database because the free tier has none.
Root cause: the scan parsed the file while it was still being written.
\`\`\`ts
we will never ship this code by the way
\`\`\`
I'll now update the component.
Do you want me to push it?
The dev server must read the port from the environment, or Render returns 502.`;
  const found = extractCandidateDecisions(transcript);

  it('keeps the sentences that record a decision or a limit', () => {
    expect(found.some((line) => line.includes('in-memory store'))).toBe(true);
    expect(found.some((line) => line.includes('Root cause'))).toBe(true);
    expect(found.some((line) => line.includes('read the port'))).toBe(true);
  });

  it('drops narration, prose inside code fences, and questions', () => {
    expect(found.some((line) => line.includes('I will never ship'))).toBe(false);
    expect(found.some((line) => line.includes('by the way'))).toBe(false);
    expect(found.some((line) => line.includes('push it'))).toBe(false);
    expect(found.some((line) => line.startsWith("I'll"))).toBe(false);
  });

  it('is capped, and its output survives a merge round trip', () => {
    const many = Array.from({ length: 30 }, (_, i) => `We chose option ${i} instead of option ${i - 1}.`).join(' ');
    const capped = extractCandidateDecisions(many, 4);

    expect(capped.length).toBeLessThanOrEqual(4);
    expect(mergeMemory(undefined, capped).added.length).toBe(capped.length);
  });

  it('returns nothing for a transcript with no decisions in it', () => {
    expect(extractCandidateDecisions('Here is the file you asked for. Let me know if you want changes!')).toEqual([]);
  });
});

describe('memoryPromptBlock', () => {
  it('teaches the protocol on the first turn, without a fake file', () => {
    const block = memoryPromptBlock(undefined);

    expect(block).toContain(MEMORY_PATH);
    expect(block).toContain('Never rewrite');
    expect(block).not.toContain('The file currently says');
  });

  it('carries the notes verbatim once, and never looks like a context buffer', () => {
    const block = memoryPromptBlock(sample);

    expect(block).toContain('- Styling stays Tailwind; no CSS modules');
    expect(block.match(/Styling stays Tailwind/g)).toHaveLength(1);
    expect(block).not.toContain('CONTEXT BUFFER');
  });
});

describe('readMemoryFromFiles', () => {
  const content = '## Decisions\n- keep it simple';

  it('finds the file under any of the key shapes the app produces', () => {
    for (const files of [
      { [`/${MEMORY_PATH}`]: { type: 'file', content, isBinary: false } },
      { [MEMORY_PATH]: { type: 'file', content, isBinary: false } },
      { [`/home/project/${MEMORY_PATH}`]: { type: 'file', content, isBinary: false } },
      {
        '/home/project/src/App.tsx': { type: 'file', content: 'x', isBinary: false },
        [`/home/project/${MEMORY_PATH}`]: { type: 'file', content, isBinary: false },
      },
    ]) {
      expect(readMemoryFromFiles(files)).toBe(content);
    }
  });

  it('ignores folders, binaries and an absent file', () => {
    expect(readMemoryFromFiles({ [`/${MEMORY_PATH}`]: { type: 'folder' } })).toBeUndefined();
    expect(
      readMemoryFromFiles({ [`/${MEMORY_PATH}`]: { type: 'file', isBinary: true, content: 'x' } }),
    ).toBeUndefined();
    expect(readMemoryFromFiles(undefined)).toBeUndefined();
  });

  it('counts notes for the badge and the progress line', () => {
    expect(countBullets(sample)).toBe(3);
    expect(countBullets(undefined)).toBe(0);
  });
});

describe('memory stays in the request', () => {
  it('survives a trim that discards everything disposable', () => {
    const block = memoryPromptBlock(sample);
    const huge = [{ role: 'user', content: 'pasted log\n'.repeat(40000) }];
    const result = fitToContextWindow(huge as any, {
      systemPrompt: `You are Bolt.\n\n${block}`,
      maxTokenAllowed: 16000,
      completionTokens: 4096,
    });

    expect(result.systemPrompt).toContain('- Styling stays Tailwind; no CSS modules');
    expect(result.systemPrompt).toContain('Never rewrite');
    expect(result.report.contextBufferDropped).toBe(false);
  });
});

describe('preferences', () => {
  it('is on unless the escape hatch says otherwise', () => {
    expect(isMemoryEnabled(null)).toBe(true);
    expect(isMemoryEnabled('true')).toBe(true);
    expect(isMemoryEnabled('false')).toBe(false);
  });

  it('mirrors per chat so a reload keeps the notes', () => {
    expect(memoryMirrorKey('abc')).toBe('bolt:project-memory:abc');
    expect(memoryMirrorKey(undefined)).toBe('bolt:project-memory:default');
  });
});
