# Hooks — post-commit rebuild and the project memory file

Use this file only when the user explicitly asks to install the
post-commit auto-rebuild hook or to wire graphify into the project's
memory file. Never install a hook unprompted, and never create a memory
file the project does not already have.

## Post-commit hook

Write `.git/hooks/post-commit` in the scanned repository with this
content:

```bash
#!/bin/sh
# Rebuild the project map after each commit. Never fails the commit.
command -v graphify >/dev/null 2>&1 || exit 0
graphify --update
```

Make the file executable. The hook prints one line when it runs and
never fails the commit: when the tool is absent it exits at once, and
when the update itself fails the commit still stands — the failure is
reported in the hook output, not in the commit.

Removing the hook file removes the auto-rebuild. Say that when the hook
is installed, so the user knows how to take it off.

## Project memory file

When the project already has an `AGENTS.md`, add a short section to it
pointing at `graphify-out/GRAPH_REPORT.md` as the project map and at
the `/graphify` command for questions about the codebase. Keep it to
three lines: where the map lives, how to rebuild it, and how to ask it
a question.

Never create a memory file just for this: when the project has no memory file, skip that part and say so in one line.
