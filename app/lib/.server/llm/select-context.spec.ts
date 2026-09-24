import { describe, expect, it } from 'vitest';
import { getFilePaths } from './select-context';
import { WORK_DIR } from '~/utils/constants';

const file = (content = 'x') => ({ type: 'file' as const, content, isBinary: false });

/**
 * `getFilePaths` decides which files are eligible for the prompt context, and it is
 * a filter that a *single* oddly-keyed entry used to be able to turn into a failed
 * request: `ignore` rejects absolute paths, and any key that arrived without the
 * workdir prefix threw straight out of `api.chat`.
 */
describe('getFilePaths', () => {
  it('keeps workdir-prefixed project files', () => {
    const files = {
      [`${WORK_DIR}/src/App.tsx`]: file(),
      [`${WORK_DIR}/index.html`]: file(),
    };

    expect(getFilePaths(files)).toEqual([`${WORK_DIR}/src/App.tsx`, `${WORK_DIR}/index.html`]);
  });

  it('survives a key that is not workdir-prefixed instead of failing the request', () => {
    const files = {
      '/.bolt/memory.md': file(),
      'src/main.tsx': file(),
      [`${WORK_DIR}/src/App.tsx`]: file(),
    };
    const paths = getFilePaths(files);

    expect(paths).toContain('src/main.tsx');
    expect(paths).toContain(`${WORK_DIR}/src/App.tsx`);
    expect(paths).not.toContain('/.bolt/memory.md');
  });

  it('leaves project memory out of the file context, since it is injected separately', () => {
    const files = {
      [`${WORK_DIR}/.bolt/memory.md`]: file('- a note'),
      [`${WORK_DIR}/src/App.tsx`]: file(),
    };

    expect(getFilePaths(files)).toEqual([`${WORK_DIR}/src/App.tsx`]);
  });

  it('still drops the noise, whatever the key shape', () => {
    const files = {
      [`${WORK_DIR}/node_modules/react/index.js`]: file(),
      [`${WORK_DIR}/dist/bundle.js`]: file(),
      [`${WORK_DIR}/debug.log`]: file(),
      [`${WORK_DIR}/src/App.tsx`]: file(),
    };

    expect(getFilePaths(files)).toEqual([`${WORK_DIR}/src/App.tsx`]);
  });

  it('ignores a key that is the workdir itself', () => {
    expect(getFilePaths({ [WORK_DIR]: file(), [`${WORK_DIR}/a.ts`]: file() })).toEqual([`${WORK_DIR}/a.ts`]);
  });
});
