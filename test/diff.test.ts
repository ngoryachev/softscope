import { describe, expect, it } from 'vitest';
import { countChanges, isUnderPaths, parseUnifiedDiff } from '../src/shared/diff';

const modified = `diff --git a/src/util/log.ts b/src/util/log.ts
index 1111111..2222222 100644
--- a/src/util/log.ts
+++ b/src/util/log.ts
@@ -1,3 +1,4 @@
 export function log(msg: string) {
-  console.log(msg);
+  console.log(\`[app] \${msg}\`);
+  // softscope: add a prefix
 }
`;

const added = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const fresh = 1;
+export const other = 2;
\\ No newline at end of file
`;

const deleted = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const gone = 1;
`;

const renamed = `diff --git a/src/a.ts b/src/b.ts
similarity index 90%
rename from src/a.ts
rename to src/b.ts
index 5555555..6666666 100644
--- a/src/a.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-export const name = 'a';
+export const name = 'b';
 export const keep = true;
`;

const binary = `diff --git a/img/logo.png b/img/logo.png
new file mode 100644
index 0000000..7777777
GIT binary patch
literal 8
PcmZQzU|?i\`00000
literal 0
HcmV?d00001

`;

describe('parseUnifiedDiff', () => {
  it('parses a modified file into hunks with typed lines', () => {
    const [file] = parseUnifiedDiff(modified);
    expect(file).toMatchObject({ path: 'src/util/log.ts', oldPath: 'src/util/log.ts', status: 'modified', binary: false });
    expect(file!.hunks).toHaveLength(1);
    expect(file!.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, header: '@@ -1,3 +1,4 @@' });
    expect(file!.hunks[0]!.lines.map((l) => l.type)).toEqual([' ', '-', '+', '+', ' ']);
    expect(file!.hunks[0]!.lines[3]!.text).toBe('  // softscope: add a prefix');
    expect(countChanges(file!)).toEqual({ added: 2, removed: 1 });
  });

  it('recognises added and deleted files and skips the no-newline marker', () => {
    const [add] = parseUnifiedDiff(added);
    expect(add).toMatchObject({ path: 'src/new.ts', oldPath: 'src/new.ts', status: 'added' });
    expect(add!.hunks[0]!.lines).toEqual([
      { type: '+', text: 'export const fresh = 1;' },
      { type: '+', text: 'export const other = 2;' },
    ]);
    const [del] = parseUnifiedDiff(deleted);
    expect(del).toMatchObject({ path: 'src/old.ts', status: 'deleted' });
    expect(del!.hunks[0]!.lines).toEqual([{ type: '-', text: 'export const gone = 1;' }]);
  });

  it('keeps both paths of a rename', () => {
    const [file] = parseUnifiedDiff(renamed);
    expect(file).toMatchObject({ path: 'src/b.ts', oldPath: 'src/a.ts', status: 'renamed' });
    expect(countChanges(file!)).toEqual({ added: 1, removed: 1 });
  });

  it('flags a binary patch and gives it no hunks', () => {
    const [file] = parseUnifiedDiff(binary);
    expect(file).toMatchObject({ path: 'img/logo.png', status: 'added', binary: true, hunks: [] });
  });

  it('splits a multi-file patch and tolerates an empty one', () => {
    const files = parseUnifiedDiff([modified, added, deleted, renamed, binary].join(''));
    expect(files.map((f) => f.path)).toEqual(['src/util/log.ts', 'src/new.ts', 'src/old.ts', 'src/b.ts', 'img/logo.png']);
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('reads a quoted header for paths with spaces', () => {
    const patch = `diff --git "a/src/my file.ts" "b/src/my file.ts"
index 1..2 100644
--- "a/src/my file.ts"
+++ "b/src/my file.ts"
@@ -1 +1 @@
-a
+b
`;
    expect(parseUnifiedDiff(patch)[0]).toMatchObject({ path: 'src/my file.ts', status: 'modified' });
  });
});

describe('isUnderPaths', () => {
  it('matches a file itself, a file under a directory, and everything under "."', () => {
    expect(isUnderPaths('src/util/log.ts', ['src/util'])).toBe(true);
    expect(isUnderPaths('src/util/log.ts', ['src/util/log.ts'])).toBe(true);
    expect(isUnderPaths('src/util/log.ts', ['src/util/'])).toBe(true);
    expect(isUnderPaths('src/utility.ts', ['src/util'])).toBe(false);
    expect(isUnderPaths('README.md', ['src'])).toBe(false);
    expect(isUnderPaths('README.md', ['.'])).toBe(true);
    expect(isUnderPaths('README.md', [])).toBe(false);
    expect(isUnderPaths('./src/a.ts', ['./src'])).toBe(true);
  });
});
