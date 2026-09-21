import { describe, expect, it } from 'vitest';
import { detectIncompleteBuild } from './buildCompleteness';

/** The exact shape reported by a user: an artifact with a manifest and an install, then silence. */
const STALLED_SCAFFOLD = `
Sure, I'll build that now.

<boltArtifact id="todo-app" title="Full-Stack Todo Application">
<boltAction type="file" filePath="package.json">
{ "name": "todo-app", "scripts": { "dev": "vite" } }
</boltAction>

<boltAction type="shell">
npm install
</boltAction>
</boltArtifact>
`;

/** Same thing cut off mid-write, which is what a token limit looks like. */
const UNCLOSED_SCAFFOLD = STALLED_SCAFFOLD.replace('</boltArtifact>', '');

const COMPLETE_APP = `
<boltArtifact id="todo-app" title="Full-Stack Todo Application">
<boltAction type="file" filePath="package.json">
{}
</boltAction>
<boltAction type="file" filePath="src/App.tsx">
export default function App() { return null; }
</boltAction>
<boltAction type="file" filePath="index.html">
<html></html>
</boltAction>
<boltAction type="shell">
npm install
</boltAction>
<boltAction type="start">
npm run dev
</boltAction>
</boltArtifact>
`;

describe('detectIncompleteBuild', () => {
  it('catches a build that stopped right after the install step', () => {
    const result = detectIncompleteBuild(STALLED_SCAFFOLD);

    expect(result?.reason).toBe('scaffold-stalled');
    expect(result?.nudge).toContain('do not invent');
    expect(result?.nudge).toContain('open a new <boltArtifact>');
    expect(result?.detail).toContain('nothing was ever started');
  });

  it('catches an artifact that was cut off mid-stream', () => {
    const result = detectIncompleteBuild(
      '<boltArtifact id="a" title="t"><boltAction type="file" filePath="src/App.tsx">export default',
    );

    expect(result?.reason).toBe('artifact-open');
    expect(result?.nudge).toContain('middle of the artifact');
  });

  it('leaves a finished app alone', () => {
    expect(detectIncompleteBuild(COMPLETE_APP)).toBeNull();
  });

  it('leaves prose alone', () => {
    expect(detectIncompleteBuild('Here is how you would add authentication to that app.')).toBeNull();
  });

  it('leaves a small edit alone, even with no start action', () => {
    const edit = `
<boltArtifact id="fix" title="Make the button red">
<boltAction type="file" filePath="src/Button.tsx">
export const Button = () => <button className="red" />;
</boltAction>
</boltArtifact>
`;

    expect(detectIncompleteBuild(edit, { existingFileCount: 24 })).toBeNull();
  });

  it('does not treat an install-only turn in a real project as a stalled build', () => {
    const installOnly = `
<boltArtifact id="deps" title="Add the icon library">
<boltAction type="shell">
npm install lucide-react
</boltAction>
</boltArtifact>
`;

    expect(detectIncompleteBuild(installOnly, { existingFileCount: 30 })).toBeNull();
    expect(detectIncompleteBuild(installOnly, { existingFileCount: 0 })?.reason).toBe('scaffold-stalled');
  });

  it('counts a closed artifact inside a longer reply correctly', () => {
    const twoArtifacts = `${COMPLETE_APP}\n\nAnd a follow-up:\n\n${UNCLOSED_SCAFFOLD}`;

    expect(detectIncompleteBuild(twoArtifacts)?.reason).toBe('artifact-open');

    // ...and two closed artifacts that both ended cleanly is not a problem
    expect(detectIncompleteBuild(`${COMPLETE_APP}\n\n${STALLED_SCAFFOLD}`)).toBeNull();
  });
});
