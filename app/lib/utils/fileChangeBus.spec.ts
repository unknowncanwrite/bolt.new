import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetFileChangeBus, flushFileChanges, notifyFileChange, onFileChanges } from './fileChangeBus';

describe('fileChangeBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetFileChangeBus();
  });

  afterEach(() => {
    __resetFileChangeBus();
    vi.useRealTimers();
  });

  it('coalesces a burst of writes into one decision', () => {
    const seen: string[][] = [];
    onFileChanges((paths) => seen.push(paths));

    // the model writes a project file by file; that is one restart, not 40
    notifyFileChange('package.json', 1000);
    notifyFileChange('src/App.tsx', 1000);
    notifyFileChange('vite.config.ts', 1000);

    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(1000);

    expect(seen).toEqual([['package.json', 'src/App.tsx', 'vite.config.ts']]);
  });

  it('does not restart per file even when writes are spread over time', () => {
    const seen: string[][] = [];
    onFileChanges((paths) => seen.push(paths));

    notifyFileChange('package.json', 1000);
    vi.advanceTimersByTime(400);
    notifyFileChange('pnpm-lock.yaml', 1000);
    vi.advanceTimersByTime(1000);

    expect(seen).toEqual([['package.json', 'pnpm-lock.yaml']]);
  });

  it('stops listening once unsubscribed', () => {
    const seen: string[][] = [];
    const unsubscribe = onFileChanges((paths) => seen.push(paths));

    unsubscribe();
    notifyFileChange('package.json', 10);
    vi.advanceTimersByTime(50);

    expect(seen).toEqual([]);
  });

  it('ignores an empty path and an empty batch', () => {
    const seen: string[][] = [];
    onFileChanges((paths) => seen.push(paths));

    notifyFileChange('', 10);
    vi.advanceTimersByTime(50);
    expect(seen).toEqual([]);
    expect(flushFileChanges()).toEqual([]);
  });
});
