import { describe, expect, it } from 'vitest';
import {
  isAlwaysRestartEnabled,
  isDevServerCommand,
  requiresDevServerRestart,
  shouldRestartOnChanges,
} from './devServerRestart';

describe('requiresDevServerRestart', () => {
  it.each([
    ['vite.config.ts', true],
    ['package.json', true],
    ['pnpm-lock.yaml', true],
    ['.env.local', true],
    ['tsconfig.json', true],
    ['next.config.mjs', true],
    ['src/App.tsx', false],
    ['src/components/Header.module.css', false],
    ['index.html', false],
  ])('%s -> restart=%s', (filePath, expected) => {
    expect(requiresDevServerRestart(filePath)).toBe(expected);
  });

  it('ignores bolt bookkeeping and installed packages', () => {
    expect(requiresDevServerRestart('.bolt/history/package.json')).toBe(false);
    expect(requiresDevServerRestart('node_modules/vite/package.json')).toBe(false);
  });

  it('treats a nested config file as the config it is', () => {
    expect(requiresDevServerRestart('apps/web/vite.config.ts')).toBe(true);
  });
});

describe('isDevServerCommand', () => {
  it.each([
    ['npm run dev', true],
    ['npm install && npm run dev', true],
    ['pnpm dev', true],
    ['yarn start', true],
    ['npx vite', true],
    ['bun run serve', true],
    ['npm run build', false],
    ['npm install', false],
    ['echo done', false],
  ])('%s -> dev=%s', (command, expected) => {
    expect(isDevServerCommand(command)).toBe(expected);
  });
});

describe('shouldRestartOnChanges', () => {
  it('does nothing for an empty batch', () => {
    expect(shouldRestartOnChanges([])).toBe(false);
  });

  it('restarts when any file in the batch needs it', () => {
    expect(shouldRestartOnChanges(['src/App.tsx', 'package.json'])).toBe(true);
    expect(shouldRestartOnChanges(['src/App.tsx', 'src/main.tsx'])).toBe(false);
  });

  it('restarts for everything when the distrust-hmr escape hatch is on', () => {
    expect(shouldRestartOnChanges(['src/App.tsx'], { alwaysRestart: true })).toBe(true);
  });

  it('is opt-in', () => {
    expect(isAlwaysRestartEnabled(null)).toBe(false);
    expect(isAlwaysRestartEnabled('false')).toBe(false);
    expect(isAlwaysRestartEnabled('true')).toBe(true);
  });
});
