import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armDevServerBootWatch,
  ingestTerminalChunk,
  isBootWatchArmed,
  raiseTerminalSignal,
  recentTerminalOutput,
  resetTerminalWatch,
  terminalSignal,
} from './terminalWatch';

/**
 * These are the guarantees the terminal reading depends on: a failure that never
 * exits is still seen, the same failure is only ever reported once, and a dev
 * server that says nothing before its deadline counts as broken.
 */

const devCommand = '$ npm run dev\n';

describe('ingestTerminalChunk', () => {
  beforeEach(() => {
    resetTerminalWatch();
  });

  it('ignores output while no command is attached to the shell', () => {
    ingestTerminalChunk("Cannot find module 'react-dom'\n", { commandActive: false });

    expect(terminalSignal.get()).toBeUndefined();
  });

  it('reports a failure printed by a command that keeps running', () => {
    ingestTerminalChunk(devCommand, { commandActive: true });
    ingestTerminalChunk('[vite] Internal server error: Failed to resolve import "./Chart" from "src/App.jsx".\n', {
      commandActive: true,
    });

    const signal = terminalSignal.get();

    expect(signal?.id).toBe('module-missing');
    expect(signal?.line).toContain('Failed to resolve import');
    expect(signal?.tail).toContain('[vite] Internal server error');
  });

  it('reports a repeating failure once, however many times it is printed', () => {
    const error = "Cannot find module 'framer-motion'\n";

    ingestTerminalChunk(devCommand, { commandActive: true });
    ingestTerminalChunk(error, { commandActive: true });

    const first = terminalSignal.get();

    for (let i = 0; i < 5; i++) {
      ingestTerminalChunk(error, { commandActive: true });
    }

    expect(terminalSignal.get()).toBe(first);
  });

  it('keeps the recent transcript so a fix request can quote it', () => {
    ingestTerminalChunk('vite v5.4.8  building for production...\n'.repeat(400), { commandActive: true });

    expect(recentTerminalOutput()).toContain('building for production');
    expect(recentTerminalOutput(80).length).toBeLessThanOrEqual(120);
  });

  it('stands the alert down once the server reports itself ready again', () => {
    ingestTerminalChunk(devCommand, { commandActive: true });
    ingestTerminalChunk('[vite] Internal server error: Failed to resolve import "./Chart" from "src/App.jsx".\n', {
      commandActive: true,
    });

    expect(terminalSignal.get()).toBeDefined();

    ingestTerminalChunk('\n  VITE v5.4.8  ready in 243 ms\n  ➜  Local:   http://localhost:5173/\n', {
      commandActive: true,
    });

    expect(terminalSignal.get()).toBeUndefined();
  });
});

describe('raiseTerminalSignal', () => {
  beforeEach(() => {
    resetTerminalWatch();
  });

  it('shares the repeat guard with the line scanner', () => {
    const match = {
      id: 'dev-server-interrupted',
      label: 'the dev server is no longer running',
      line: 'The `npm run dev` process ended.',
    };

    expect(raiseTerminalSignal(match)).toBeDefined();
    expect(raiseTerminalSignal(match)).toBeUndefined();
    expect(
      raiseTerminalSignal({ id: 'port-in-use', label: 'port busy', line: 'EADDRINUSE: address already in use' }),
    ).toBeDefined();
  });
});

describe('armDevServerBootWatch', () => {
  beforeEach(() => {
    resetTerminalWatch();
    vi.useFakeTimers();

    return () => {
      vi.useRealTimers();
    };
  });

  it('arms itself as soon as a dev command is echoed', () => {
    ingestTerminalChunk(devCommand, { commandActive: true });

    expect(isBootWatchArmed()).toBe(true);
  });

  it('waits out a dev server that prints nothing and never comes up', async () => {
    const pending = armDevServerBootWatch(5_000);

    // ordinary npm chatter: not a failure, and not proof of a server either
    ingestTerminalChunk('npm warn deprecated sourcemap-codec@1.4.8\n', { commandActive: true });

    await vi.advanceTimersByTimeAsync(5_001);

    await expect(pending).resolves.toMatchObject({ ready: false, timedOut: true });
  });

  it('settles as ready when the output proves the server is listening', async () => {
    const pending = armDevServerBootWatch(5_000);

    ingestTerminalChunk('\n  VITE v5.4.8  ready in 412 ms\n', { commandActive: true });

    await expect(pending).resolves.toMatchObject({ ready: true, timedOut: false });
    expect(isBootWatchArmed()).toBe(false);
  });

  it('settles with the error instead of timing out when one explains the failure', async () => {
    const pending = armDevServerBootWatch(5_000);

    ingestTerminalChunk('error when starting dev server:\nError: Port 5173 is already in use\n', {
      commandActive: true,
    });

    const outcome = await pending;

    expect(outcome.ready).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.signal?.id).toBe('vite-start');
    expect(terminalSignal.get()).toBeDefined();

    // and the deadline is gone, so the runner is the only one left to speak
    await vi.advanceTimersByTimeAsync(6_000);
    expect(isBootWatchArmed()).toBe(false);
  });

  it('lets a second waiter share the outcome of the first', async () => {
    const first = armDevServerBootWatch(5_000);
    const second = armDevServerBootWatch(5_000);

    ingestTerminalChunk('\n  VITE v5.4.8  ready in 412 ms\n', { commandActive: true });

    const [a, b] = await Promise.all([first, second]);

    expect(a.ready).toBe(true);
    expect(b.ready).toBe(true);
    expect(a).toBe(b);
  });
});
