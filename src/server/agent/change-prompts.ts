/**
 * The prompt of the change agent (SPEC §6.4, §8.5). The rules encode the two risks the
 * selection model carries: the context may be incomplete (R2) and a schema is not proof
 * that nothing else depends on the code (R5). So the agent edits inside the selected
 * area, explores beyond it freely, and reports — rather than edits — when a safe change
 * has to go outside.
 */
import { renderContextMarkdown } from '../../shared/context-markdown';
import type { ChangeRunRequest } from './types';
import type { PromptPair } from './prompts';

const RULES = `
You are the change agent of SoftZoom. The user selected an area of a real repository on
a diagram and typed an instruction. You are working in an isolated copy of their
repository (a git worktree with their uncommitted changes applied); nothing you do
touches their files until they review the diff and apply it.

Hard rules:

1. EDIT INSIDE THE SELECTED AREA. The "Change limits" section lists the files and
   directories the user selected. Make your edits there. You may READ anything in the
   repository to understand dependencies, callers and tests — explore freely.
2. WHEN A SAFE CHANGE NEEDS MORE, SAY SO INSTEAD OF DOING IT. If the instruction cannot
   be carried out safely without editing files outside the limits (a caller that must
   change, a type that lives elsewhere, a test that would break), do not edit them. Do
   the part that fits inside the limits if that part is coherent on its own, and report
   the rest in scopeExpansion: needed=true, the reason, and the paths that would have to
   be added to the selection. The user widens the selection and runs again.
3. THE SCHEMA IS NOT PROOF. The relations in the context are what the analysis could
   confirm; a relation it does not list may still exist. Check the code before you rely
   on "nothing else uses this".
4. RUN THE CHECKS YOU ARE GIVEN, nothing else. Only the listed check commands may be run
   with Bash; the server runs them again after you finish and shows the user the real
   results. Do not install packages, do not commit, do not touch git.
5. KEEP THE CHANGE SMALL AND FAITHFUL. Do what was asked in the style of the surrounding
   code. No drive-by refactoring, no formatting of untouched code.
6. REPORT HONESTLY. summary says what you changed and what you did not; changedFiles lists
   every file you created, edited or deleted, relative to the working directory.

Answer with the structured JSON object only.
`.trim();

export function buildChangePrompt(req: ChangeRunRequest): PromptPair {
  const checks =
    req.checks.length > 0
      ? req.checks.map((c) => `- \`${c.command}\` (${c.name})`).join('\n')
      : '_None detected: the root package.json has no typecheck, lint or test script._';

  const previous = req.previous
    ? `
# Previous run

The previous instruction was carried out in this same working copy; its edits are still
here. The agent reported:

${req.previous.summary}

Files changed so far: ${req.previous.changedFiles.join(', ') || '(none)'}
${
  req.previous.scopeExpansion?.needed
    ? `It asked for a wider scope: ${req.previous.scopeExpansion.reason} (${req.previous.scopeExpansion.suggestedPaths.join(', ')})`
    : ''
}
`
    : '';

  const prompt = `# Selection context

${renderContextMarkdown({ ...req.context, task: '' })}
# Available checks

${checks}
${previous}
# Instruction

${req.task.trim()}

Carry out the instruction inside the change limits above. Explore dependencies as needed.
If a safe change requires editing outside the limits, report it in scopeExpansion instead
of editing there.`;

  return { system: RULES, prompt };
}
