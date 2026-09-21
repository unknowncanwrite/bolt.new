import { describe, expect, it } from 'vitest';
import {
  MAX_STALE_CACHE_RESTARTS,
  decideCompileErrorRecovery,
  describeCompileError,
  findBracketImbalance,
  forceRebuildCommand,
  judgeCompileError,
  parseCompileError,
  toProjectPath,
} from './compileError';

/*
 * Fixtures are the real transcript of a `npm run dev` that raced Bolt's file
 * writes - esbuild's frame, then Vite's pre-transform error, then the internal
 * server error it kept replaying on every request - and the file as `cat -n`
 * showed it afterwards: valid, unchanged, and the reason the whole thing was a
 * stale cache rather than broken code.
 */
const ESBUILD_BLOCK = `
  VITE v5.4.8  ready in 5652 ms

  ➜  Local:   http://localhost:5173/

Error:   Failed to scan for dependencies from entries:
  /home/project/index.html

  ✘ [ERROR] Expected ")" but found "}"

    src/components/TodoList.tsx:35:8:
      35 │       ))}
         │         ^
`;

const PRE_TRANSFORM_BLOCK = `11:25:22 PM [vite] Pre-transform error: /home/project/src/components/TodoList.tsx: Unexpected token, expected "," (35:8)

  33 |           />
  34 |         </div>
> 35 |       ))}
     |         ^
  36 |     </div>`;

const INTERNAL_ERROR_BLOCK = `11:25:23 PM [vite] Internal server error: /home/project/src/components/TodoList.tsx: Unexpected token, expected "," (35:8)
  Plugin: vite:react-babel
  File: /home/project/src/components/TodoList.tsx:35:8
  33 |           />
  34 |         </div>
  35 |       ))}
  36 |     </div>
      at constructor (/home/project/node_modules/@babel/parser/lib/index.js:362:19)`;

const VALID_FILE = `import type { Todo } from '../types';
import { TodoItem } from './TodoItem';
import { EmptyState } from './EmptyState';
import type { FilterType } from '../types';

interface TodoListProps {
  todos: Todo[];
  filter: FilterType;
  hasTodos: boolean;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, updates: Partial<Todo>) => void;
}

export function TodoList({ todos, filter, hasTodos, onToggle, onDelete, onEdit }: TodoListProps) {
  if (todos.length === 0) {
    return <EmptyState filter={filter} hasTodos={hasTodos} />;
  }

  return (
    <div className="space-y-2.5">
      {todos.map((todo, i) => (
        <div
          key={todo.id}
          className="opacity-0"
          style={{ animation: \`fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) \${i * 40}ms forwards\` }}
        >
          <TodoItem
            todo={todo}
            onToggle={onToggle}
            onDelete={onDelete}
            onEdit={onEdit}
          />
        </div>
      ))}
    </div>
  );
}
`;

/*
 * the same file with the `(` of the arrow body removed: the quoted line survives,
 * and the braces genuinely no longer close - which must NOT be excused as stale
 */
const BROKEN_FILE = VALID_FILE.replace('(todo, i) => (', '(todo, i) =>');

describe('parseCompileError', () => {
  it("reads esbuild's frame", () => {
    const detail = parseCompileError(ESBUILD_BLOCK);

    expect(detail?.file).toBe('src/components/TodoList.tsx');
    expect(detail?.line).toBe(35);
    expect(detail?.column).toBe(8);
    expect(detail?.message).toContain('Expected ")" but found "}"');
    expect(detail?.quoted).toBe('))}');
  });

  it('reads the pre-transform form with its `>` highlighted line', () => {
    const detail = parseCompileError(PRE_TRANSFORM_BLOCK);

    expect(detail?.file).toBe('src/components/TodoList.tsx');
    expect(detail?.line).toBe(35);
    expect(detail?.message).toContain('Unexpected token');
    expect(detail?.quoted).toBe('))}');
  });

  it("prefers Vite's explicit `File:` line over the stack frames below it", () => {
    const detail = parseCompileError(INTERNAL_ERROR_BLOCK);

    expect(detail?.file).toBe('src/components/TodoList.tsx');
    expect(detail?.line).toBe(35);
    expect(detail?.printedPath).not.toContain('node_modules');
  });

  it('says nothing when the output is not a compile error', () => {
    expect(parseCompileError('Browserslist: caniuse-lite is outdated. Please run:')).toBeUndefined();
    expect(parseCompileError('')).toBeUndefined();
  });
});

describe('toProjectPath', () => {
  it.each([
    ['/home/project/src/components/TodoList.tsx', 'src/components/TodoList.tsx'],
    ['~/project/src/App.tsx', 'src/App.tsx'],
    ['src/App.tsx', 'src/App.tsx'],
    ['/project/src/main.tsx', 'src/main.tsx'],
  ])('%s -> %s', (input, expected) => {
    expect(toProjectPath(input)).toBe(expected);
  });
});

describe('judgeCompileError', () => {
  it('calls the replayed error stale, because the file is fine', () => {
    const detail = parseCompileError(ESBUILD_BLOCK);

    expect(detail?.quoted).toBeTruthy();
    expect(findBracketImbalance(VALID_FILE)).toBeUndefined();
    expect(judgeCompileError(detail, VALID_FILE)).toBe('stale');
  });

  it('calls the same error live when the bracket really is missing', () => {
    const detail = parseCompileError(ESBUILD_BLOCK);

    expect(findBracketImbalance(BROKEN_FILE)).toBeDefined();
    expect(judgeCompileError(detail, BROKEN_FILE)).toBe('live');
  });

  it('calls it stale once the quoted line is gone from the file', () => {
    const detail = parseCompileError(ESBUILD_BLOCK);
    expect(detail).toBeTruthy();

    // the model already rewrote that line: the error on disk is history
    expect(judgeCompileError({ ...detail!, quoted: 'the line nobody wrote any more' }, VALID_FILE)).toBe('stale');
  });

  it('abstains when there is nothing to compare', () => {
    expect(judgeCompileError(undefined, VALID_FILE)).toBe('unknown');
    expect(judgeCompileError({ file: 'a.tsx', printedPath: 'a.tsx', line: 1 }, '')).toBe('unknown');
    expect(judgeCompileError({ file: 'a.tsx', printedPath: 'a.tsx', line: 1, message: 'Resolver error' }, 'x')).toBe(
      'unknown',
    );
  });
});

describe('findBracketImbalance', () => {
  it('ignores brackets inside strings, comments, regexes and template holes', () => {
    const source = `const a = "unmatched ) here";
// a comment with ( and {
const re = /\\}\\)\\[(\\/]/g;
const t = \`tick \${ {x: 1}.x } tock }\`;
export const y = f((x) => x + 1);
`;

    expect(findBracketImbalance(source)).toBeUndefined();
  });

  it('finds the unclosed paren the bundler complained about', () => {
    const source = '{todos.map((todo, i) => (\n  <div/>\n)}\n';
    const imbalance = findBracketImbalance(source);

    expect(imbalance?.kind).toBe('extra');
    expect(imbalance?.char).toBe('}');
  });

  it('treats a lone slash as division, not a regex', () => {
    expect(findBracketImbalance('const ratio = (a / b) + (c % d);\n')).toBeUndefined();
  });
});

describe('forceRebuildCommand', () => {
  it.each([
    ['npm run dev', 'npm run dev -- --force'],
    ['npm install && npm run dev', 'npm install && npm run dev -- --force'],
    ['npx vite', 'npx vite --force'],
    ['pnpm run dev', 'pnpm run dev -- --force'],
    ['vite --port 3000', 'vite --port 3000 --force'],
  ])('%s -> %s', (input, expected) => {
    expect(forceRebuildCommand(input)).toBe(expected);
  });

  it.each([['npm run build'], ['echo hi'], [''], ['node -e "console.log(1)"']] as const)('leaves %s alone', (input) => {
    expect(forceRebuildCommand(input)).toBeUndefined();
  });
});

describe('describeCompileError', () => {
  it('is a single quotable line', () => {
    expect(describeCompileError(parseCompileError(ESBUILD_BLOCK))).toBe(
      'src/components/TodoList.tsx:35:8 - Expected ")" but found "}"',
    );
    expect(describeCompileError(undefined)).toBe('');
  });
});

describe('decideCompileErrorRecovery', () => {
  const detail = parseCompileError(ESBUILD_BLOCK)!;
  const ready = { detail, content: VALID_FILE, attempts: 0, hasDevServer: true };
  const decide = (override: Partial<typeof ready> & { maxAttempts?: number } = {}) =>
    decideCompileErrorRecovery({ ...ready, ...override });

  it('clears the cache instead of spending a model turn on correct code', () => {
    expect(decide().action).toBe('restart');
    expect(decide().reason).toContain('not a problem in src/components/TodoList.tsx');
  });

  it.each([
    ['the file really is broken', { content: BROKEN_FILE }],
    ['nothing is running to restart', { hasDevServer: false }],
    ['the file is not in the tree', { content: undefined }],
    ['the cache was already cleared', { attempts: MAX_STALE_CACHE_RESTARTS }],
  ])('hands %s to the model', (_label, override) => {
    const decision = decide(override as any);

    expect(decision.action).toBe('ask-model');
    expect(decision.reason).toBeTruthy();
  });

  it('gives up on its own after the cap, so a swallowed error stays swallowed for a bounded time', () => {
    expect(decide({ attempts: MAX_STALE_CACHE_RESTARTS - 1 }).action).toBe('restart');
    expect(decide({ attempts: MAX_STALE_CACHE_RESTARTS }).action).toBe('ask-model');
  });
});
