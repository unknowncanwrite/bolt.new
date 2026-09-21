import { describe, expect, it } from 'vitest';
import {
  DEV_BOOT_TIMEOUT_MS,
  errorTail,
  isDevServerCommandLine,
  isReadyEvidence,
  matchErrorLine,
  stripAnsi,
  terminalErrorSignature,
} from './terminalSignals';

describe('matchErrorLine', () => {
  it.each([
    [
      'failed import',
      '[vite] Internal server error: Failed to resolve import "react" from "src/App.tsx". Does the file exist?',
      'module-missing',
    ],
    ['missing package', "Error: Cannot find module 'express'", 'module-missing'],
    ['missing binary', 'sh: 1: vite: not found', 'binary-missing'],
    ['port busy', 'EADDRINUSE: address already in use :::5173', 'port-in-use'],
    ['dependency conflict', 'npm ERR! code ERESOLVE', 'npm-eresolve'],
    ['type error', "src/App.tsx(12,5): error TS2304: Cannot find name 'foo'.", 'type-error'],
    ['transform failure', 'Transform failed with 1 error:', 'vite-transform'],
  ])('reads %s out of terminal output', (_label, line, id) => {
    expect(matchErrorLine(line)?.id).toBe(id);
  });

  it('does not treat normal startup chatter as a failure', () => {
    const healthy = [
      '  VITE v5.4.19  ready in 412 ms',
      '  ➜  Local:   http://localhost:5173/',
      'npm warn deprecated inflight@1.0.6: This module is not supported',
      'added 148 packages in 3s',
      '> vite --host',
      '0 errors found',
    ];

    for (const line of healthy) {
      expect(matchErrorLine(line), line).toBeUndefined();
    }
  });

  it('survives the ANSI codes xterm strips later', () => {
    expect(matchErrorLine("\u001b[31mCannot find module 'react'\u001b[39m")?.id).toBe('module-missing');
  });

  it('is undefined for blank input', () => {
    expect(matchErrorLine('')).toBeUndefined();
    expect(matchErrorLine('   ')).toBeUndefined();
  });
});

describe('terminalErrorSignature', () => {
  it('treats a re-print of the same failure as the same error', () => {
    const first = matchErrorLine('[vite] Internal server error: Failed to resolve import "x" from "src/a.tsx".');
    const second = matchErrorLine('[vite] Internal server error: Failed to resolve import "x" from "src/a.tsx".');
    expect(terminalErrorSignature(first!)).toBe(terminalErrorSignature(second!));
  });

  it('separates two different missing modules', () => {
    const a = matchErrorLine("Cannot find module 'react'");
    const b = matchErrorLine("Cannot find module 'lodash'");
    expect(terminalErrorSignature(a!)).not.toBe(terminalErrorSignature(b!));
  });
});

describe('ready + dev-command detection', () => {
  it('recognises the lines that mean a server is up', () => {
    expect(isReadyEvidence('  VITE v5.4.19  ready in 412 ms')).toBe(true);
    expect(isReadyEvidence('➜  Local:   http://localhost:5173/')).toBe(true);
    expect(isReadyEvidence('✓ Ready in 2.3s')).toBe(true); // Next.js phrasing
    expect(isReadyEvidence('  ➜  Network: use --host to expose')).toBe(false);
    expect(isReadyEvidence('webpack 5.89.0 compiled successfully in 1204 ms')).toBe(true);
    expect(isReadyEvidence('watching for file changes...')).toBe(false);
    expect(isReadyEvidence('compiling...')).toBe(false);
    expect(isReadyEvidence('ready to deploy to production? [y/N]')).toBe(false);
  });

  it('recognises the echoed command that started the server', () => {
    expect(isDevServerCommandLine('$ npm run dev')).toBe(true);
    expect(isDevServerCommandLine('npm install && npm run dev')).toBe(true);
    expect(isDevServerCommandLine('vite --host')).toBe(true);
    expect(isDevServerCommandLine('sh -c "npm run dev"')).toBe(true);
    expect(isDevServerCommandLine('pnpm dev')).toBe(true);
  });

  it('does not mistake the server talking about itself for someone starting it', () => {
    // Vite's own banner and status lines mention `vite` in caps or in brackets
    expect(isDevServerCommandLine('  VITE v5.4.8  ready in 412 ms')).toBe(false);
    expect(isDevServerCommandLine('[vite] hmr update /src/App.jsx')).toBe(false);
    expect(isDevServerCommandLine('[vite] Internal server error: Failed to resolve import')).toBe(false);
    expect(isDevServerCommandLine('> vite build')).toBe(false);
    expect(isDevServerCommandLine('- vite v5.4.8')).toBe(false);
    expect(isDevServerCommandLine('vite v5.4.8 building for production...')).toBe(false);
    expect(isDevServerCommandLine('vite v5.4.8 preview server ready in 90 ms')).toBe(false);
  });

  it('does not mistake an install for a server boot', () => {
    expect(isDevServerCommandLine('$ npm install')).toBe(false);
    expect(isDevServerCommandLine('$ npm run build')).toBe(false);
    expect(isDevServerCommandLine('')).toBe(false);
  });

  it('ignores a pasted wall of text that merely contains the words', () => {
    expect(isDevServerCommandLine(`cat big-file.txt | grep "${'npm run dev '.repeat(40)}"`)).toBe(false);
  });
});

describe('errorTail', () => {
  it('keeps the end of the transcript on a line boundary', () => {
    const buffer = `${'noise '.repeat(20)}\nfirst line here\nlast line here`;
    const tail = errorTail(buffer, 24);
    expect(tail.endsWith('last line here')).toBe(true);
    expect(tail).not.toContain('\nnoise');
  });

  it('returns everything when it already fits', () => {
    expect(errorTail('short', 100)).toBe('short');
  });

  it('strips escape codes so the model is not fed ANSI junk', () => {
    expect(stripAnsi('\u001b[31mboom\u001b[39m')).toBe('boom');
    expect(errorTail('\u001b[31mboom\u001b[39m', 100)).toBe('boom');
  });
});

describe('DEV_BOOT_TIMEOUT_MS', () => {
  it('is long enough for a cold install on a fractional CPU', () => {
    expect(DEV_BOOT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
  describe('matchErrorLine against the transcript that hid a broken preview', () => {
    it.each([
      ['Error:   Failed to scan for dependencies from entries:', 'vite-dep-scan'],
      ['  ✘ [ERROR] Expected ")" but found "}"', 'bundler-syntax'],
      [
        '11:25:23 PM [vite] Internal server error: /home/project/src/components/TodoList.tsx: Unexpected token, expected "," (35:8)',
        'vite-internal',
      ],
    ])('%s -> %s', (line, id) => {
      expect(matchErrorLine(line)?.id).toBe(id);
    });

    it('leaves the noise alone', () => {
      for (const line of [
        'Browserslist: caniuse-lite is outdated. Please run:',
        '  npx update-browserslist-db@latest',
        '  Why you should do it regularly: https://github.com/browserslist/update-db#readme',
        'Registry latest:         1.0.30001810',
        'caniuse-lite has been successfully updated',
        'No target browser changes',
        '  Plugin: vite:react-babel',
        '  File: /home/project/src/components/TodoList.tsx:35:8',
        '      at constructor (/home/project/node_modules/@babel/parser/lib/index.js:362:19)',
        'jsh: command not found: Browserslist:',
      ]) {
        expect(matchErrorLine(line), line).toBeUndefined();
      }
    });
  });
});
