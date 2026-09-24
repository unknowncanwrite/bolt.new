import { atom } from 'nanostores';
import {
  MEMORY_PATH,
  countBullets,
  extractCandidateDecisions,
  memoryMirrorKey,
  mergeMemory,
  readMemoryFromFiles,
} from '~/lib/utils/projectMemory';
import { getCurrentChatId } from '~/utils/fileLocks';
import { WORK_DIR } from '~/utils/constants';
import { workbenchStore } from './workbench';
import { logger } from '~/utils/logger';

/**
 * Client-side glue for project memory.
 *
 * The file itself is the source of truth, because the file is what the server
 * prompt reads and what the repo carries. This store only adds the two things a
 * file cannot do on its own: a localStorage mirror (Bolt rebuilds the project from
 * the message history on reload, and a note written by the app rather than by an
 * artifact would not be in that history) and a badge saying how much is worth
 * filing, so the button is not a mystery.
 */

/** Notes the file currently holds. */
export const memoryBullets = atom<number>(0);

/** Candidates found in the transcript that are not in the file yet. */
export const memoryPending = atom<string[]>([]);

export const memoryBusy = atom<boolean>(false);

/**
 * The text the badge was computed from. Kept here so the button can file notes
 * without the chat plumbing its transcript: the transcript is already read once per
 * message change for the count, and reading it twice would be a second opinion.
 */
export const memoryTranscript = atom<string>('');

/*
 * FilesStore keys are workdir-prefixed (`/home/project/src/App.tsx`), which is the
 * form the editor, the file tree and the context selector all speak - so memory is
 * addressed exactly like any other project file rather than a fourth convention.
 */
const MEMORY_FILE = `${WORK_DIR}/${MEMORY_PATH}`;

/* Same id the file-locking store uses, so "this project's notes" means one thing. */
const mirrorStorageKey = () => memoryMirrorKey(getCurrentChatId());

const store = () => (typeof window === 'undefined' ? undefined : window.localStorage);

export function currentMemoryText(): string | undefined {
  const mirrored = readMemoryFromFiles(workbenchStore.files.get());

  if (mirrored !== undefined) {
    return mirrored;
  }

  try {
    return store()?.getItem(mirrorStorageKey()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Recompute the badge after the file or the transcript moves. */
export function refreshMemoryState(transcriptText = ''): void {
  const content = currentMemoryText();

  memoryTranscript.set(transcriptText);
  memoryBullets.set(countBullets(content));
  memoryPending.set(findUnfiledNotes(transcriptText, content));
}

/**
 * What the transcript knows that the file does not. Merge rules do the dedupe, so
 * a candidate list is only ever a suggestion - filing is one click away, not a
 * rewrite of the file.
 */
export function findUnfiledNotes(transcriptText: string, content: string | undefined): string[] {
  if (!transcriptText) {
    return [];
  }

  const candidates = extractCandidateDecisions(transcriptText);

  if (candidates.length === 0) {
    return [];
  }

  return mergeMemory(content, candidates).added;
}

export interface StowResult {
  filed: number;
  duplicates: number;
  dropped: number;
  created: boolean;
  skipped?: 'no project' | 'nothing to file' | 'failed';
}

/**
 * File what this chat decided. Returns counts rather than a message, so the caller
 * (a button, or a later automatic pass) decides how loud to be.
 */
export async function stowTranscript(transcript?: string, options: { force?: boolean } = {}): Promise<StowResult> {
  const content = currentMemoryText();
  const source = transcript ?? memoryTranscript.get();

  if (!source) {
    return { filed: 0, duplicates: 0, dropped: 0, created: false, skipped: 'nothing to file' };
  }

  const candidates = extractCandidateDecisions(source);

  if (candidates.length === 0) {
    return { filed: 0, duplicates: 0, dropped: 0, created: false, skipped: 'nothing to file' };
  }

  const merge = mergeMemory(content, candidates);

  if (!merge.changed) {
    return {
      filed: 0,
      duplicates: merge.duplicateCount,
      dropped: merge.dropped.length,
      created: false,
      skipped: 'nothing to file',
    };
  }

  memoryBusy.set(true);

  /*
   * No project, no place to file: creating `.bolt/memory.md` on its own would boot a
   * WebContainer to hold one markdown file, which is a strange price for a note. Keep
   * it in the mirror instead - that is what a reload reads back - and say so.
   */
  if (workbenchStore.filesCount === 0) {
    mirror(merge.text);
    refreshMemoryState(source);
    memoryBusy.set(false);

    return {
      filed: merge.added.length,
      duplicates: merge.duplicateCount,
      dropped: merge.dropped.length,
      created: false,
      skipped: 'no project',
    };
  }

  try {
    await workbenchStore.createFile(MEMORY_FILE, merge.text);
    mirror(merge.text);
    refreshMemoryState(source);

    return {
      filed: merge.added.length,
      duplicates: merge.duplicateCount,
      dropped: merge.dropped.length,
      created: content === undefined || options.force === true,
    };
  } catch (error) {
    logger.error('Failed to write project memory', error);

    /*
     * Even when the project cannot be written to (no WebContainer yet, a locked
     * tree), the notes are worth keeping: the mirror is what a reload reads back.
     */
    mirror(merge.text);

    return {
      filed: merge.added.length,
      duplicates: merge.duplicateCount,
      dropped: merge.dropped.length,
      created: true,
      skipped: 'failed',
    };
  } finally {
    memoryBusy.set(false);
  }
}

function mirror(text: string) {
  try {
    store()?.setItem(mirrorStorageKey(), text);
  } catch {
    /* a full or unavailable localStorage is not worth failing a stow over */
  }
}

/**
 * A chat that was reloaded - or a project where the file was deleted - gets its
 * notes back from the mirror. Only creates the file, never overwrites one: if the
 * project has a memory file, that one wins, because it is the copy the model has
 * been editing.
 */
export async function seedMemoryFromMirror(): Promise<boolean> {
  const mirrored = (() => {
    try {
      return store()?.getItem(mirrorStorageKey()) ?? undefined;
    } catch {
      return undefined;
    }
  })();

  if (!mirrored || countBullets(mirrored) === 0) {
    return false;
  }

  if (readMemoryFromFiles(workbenchStore.files.get()) !== undefined) {
    return false;
  }

  /*
   * `createFile` selects the file it writes, which is what a deliberate click
   * wants and what a background restore does not: put the selection back.
   */
  const previousSelection = workbenchStore.selectedFile.get();

  try {
    await workbenchStore.createFile(MEMORY_FILE, mirrored);

    if (previousSelection && previousSelection !== MEMORY_FILE) {
      workbenchStore.setSelectedFile(previousSelection);
    }

    logger.info('Restored project memory for this chat');

    return true;
  } catch (error) {
    logger.debug('Project memory could not be seeded into the project', error);

    return false;
  }
}

/** One line for a toast. */
export function describeStow(result: StowResult): string {
  if (result.skipped === 'nothing to file') {
    return 'Nothing new worth remembering - the file already covers this chat';
  }

  const bits = [`${result.filed} note${result.filed === 1 ? '' : 's'} filed in ${MEMORY_PATH}`];

  if (result.duplicates) {
    bits.push(`${result.duplicates} already there`);
  }

  if (result.dropped) {
    bits.push(`${result.dropped} oldest dropped to stay under the cap`);
  }

  if (result.skipped === 'failed') {
    bits.push('kept for this chat only, the project could not be written');
  }

  if (result.skipped === 'no project') {
    return `${bits.join(' - ')} - this chat has no project to file them in yet`;
  }

  return bits.join(' - ');
}
