/**
 * Did the model stop before it was done?
 *
 * The stream ends politely either way: an artifact cut in half by a token cap and
 * a model that decided to "install dependencies first, write the files next turn"
 * both look like a normal, successful end of message. Only the first one is
 * reported by the provider (`finish_reason: 'length'`), so without reading the
 * text there is no way to notice the second - and the user is left with one file
 * where an app should be.
 *
 * This is deliberately narrow. A one-file turn is normal (a small edit, a fix),
 * so it only calls a build incomplete when the output itself could not be run:
 * an artifact left open, or a scaffold that stopped at the install step with
 * nothing ever started.
 */

/** A `<boltAction type="file">` in the assistant's own words. */
const FILE_ACTION = /<boltAction\b[^>]*type=["']file["']/g;

/** The action that launches the preview - if this exists, the app was built. */
const START_ACTION = /<boltAction\b[^>]*type=["']start["']/g;

/** `npm install` / `pnpm add` and friends, run as a shell action. */
const INSTALL_ACTION = /<boltAction\b[^>]*type=["']shell["'][^>]*>\s*(?:[\s\S]{0,200}?)npm (?:install|i|add|ci)\b/i;

/** Opening of a project scaffold rather than an edit. */
const SCAFFOLD_MARKER =
  /<boltAction\b[^>]*type=["']file["'][^>]*path=["'](?:\/?package\.json|config\/package\.json)["']/;

/** How much of an artifact counts as "barely started". */
const SCAFFOLD_FILE_LIMIT = 2;

export type IncompleteBuildReason = 'artifact-open' | 'scaffold-stalled';

export interface IncompleteBuild {
  reason: IncompleteBuildReason;

  /** One line for logs and for the person reading the progress panel. */
  detail: string;

  /**
   * Extra instruction for the continuation. The generic "continue where you left
   * off" is right for a cut-off stream; a model that stopped by choice needs to
   * be told that stopping is not an option here, and what "done" looks like.
   */
  nudge: string;
}

function countMatches(content: string, pattern: RegExp): number {
  const matches = content.match(pattern);
  return matches ? matches.length : 0;
}

export function detectIncompleteBuild(
  content: string,
  options: { existingFileCount?: number } = {},
): IncompleteBuild | null {
  const opens = countMatches(content, /<boltArtifact\b/g);
  const closes = countMatches(content, /<\/boltArtifact>/g);

  if (opens === 0) {
    // prose only: not our business to turn a discussion into a build
    return null;
  }

  if (opens > closes) {
    return {
      reason: 'artifact-open',
      detail: 'the response ended inside an unfinished artifact',
      nudge: [
        'Your previous message ended in the middle of the artifact, so the files after that point were never',
        'written. Carry on from exactly where the text stopped: finish the open action, then the remaining',
        'files, and close the artifact with </boltArtifact> once the app is complete.',
      ].join('\n'),
    };
  }

  const fileActions = countMatches(content, FILE_ACTION);
  const startActions = countMatches(content, START_ACTION);

  if (startActions > 0) {
    return null;
  }

  /*
   * A stopped scaffold: at most a couple of files, an install that nothing
   * follows, and no server ever started. Requiring the install (or a
   * `package.json`) keeps an ordinary one-file edit from being read as a
   * half-finished app.
   */
  const alreadyHasAProject = (options.existingFileCount ?? 0) > SCAFFOLD_FILE_LIMIT;

  if (alreadyHasAProject || fileActions > SCAFFOLD_FILE_LIMIT) {
    return null;
  }

  const installing = INSTALL_ACTION.test(content) || SCAFFOLD_MARKER.test(content);

  if (!installing) {
    return null;
  }

  return {
    reason: 'scaffold-stalled',
    detail: `the app was only ${fileActions} file${fileActions === 1 ? '' : 's'} deep and nothing was ever started`,
    nudge: [
      'That was the whole response: a package manifest and an install, with no application files and no dev',
      'server, so there is nothing to preview and the user is looking at an empty screen.',
      '',
      'If the request asked for an app, write the rest of it now: the entry HTML, the config the manifest',
      'references, every component and style file, then `npm run dev` as a start action. Your previous artifact',
      'is already closed, so open a new <boltArtifact> for these files, and do not repeat the files you already',
      'wrote. If the request was only to install or configure something, say it is done and stop - do not invent',
      'features.',
    ].join('\n'),
  };
}
