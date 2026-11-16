# /impeccable hooks

Manage the **design detector hook** for the current project.

In this app the automatic check is built into the agent: after UI work lands, the agent loads this skill and runs the detector (`impeccable detect --json <changed files>`), then fixes what it finds or reports it. If that call fails (non-zero exit, `Unknown command`, or empty output), the agent stops the check and tells the user it did not run and why — it never presents a review, a plan, or fixes as detector output. Findings arrive in the agent's context right after the edit; clean UI files get a short ack unless quiet mode is on (`hook.quiet` in config). The check covers direct file edits to design-relevant files (`.tsx`, `.jsx`, `.html`, `.vue`, `.svelte`, `.astro`, `.css`, `.scss`, `.sass`, `.less`, and plain `.ts` and `.js` in a project with a PRODUCT.md, DESIGN.md or `.impeccable` folder). Plain `.ts` and `.js` files are still scanned, but stay quiet unless the detector finds something.

The detector rules run in two tiers. The automatic check surfaces only the immediate tier: mechanical, unambiguous problems worth interrupting an edit for, such as broken images, overflowing content, contrast and legibility failures, gradient text, glow shadows, and design-system drift. Everything else (copy cadence, palette and typography taste, layout rhythm) is deferred to a deep pass: run `/impeccable audit` for the full rule set over the touched files. A session with nothing left to report stops silently.

Every check is a mechanical pass. The reflexes no scanner catches live in [craft-floor.md](craft-floor.md), which the skill loads before it edits UI, so they apply whether or not the automatic check runs. When the project's hook is off, `impeccable context` says so at session start and the agent runs the detector only when asked.

This command toggles the check **per project** by editing `.impeccable/config.json` (the unified Impeccable config; hook runtime settings live under its `hook` key, and shared detector ignores live under `detector`). Per-developer overrides live in the gitignored `.impeccable/config.local.json`. Set `hook.enabled: false` to turn the automatic check off, `hook.quiet: true` to silence the clean/pending acks, or `hook.auditLog` to a file path for an NDJSON log.

Declare server-side template extensions under **`detector.extensions`** when the project uses Blade, Twig, ERB, or Handlebars files; the check skips them otherwise because they sit outside the built-in extension list. One entry per extension, `{ "ext": ".blade.php", "engine": "html" }`. `engine` picks the analyzer (`html` for markup templates, `text` for JS/TS/CSS-like files) and defaults to `html`. Match against the end of the filename, so double extensions like `.blade.php` and `.html.erb` work. Config only adds extensions; the built-in list always applies.

Manual `impeccable detect` scans use the same project filter config by default: `detector.ignoreRules`, `detector.ignoreFiles`, `detector.ignoreValues`, and `detector.designSystem.enabled`. `hook.enabled` only controls the automatic check, not manual CLI scans. Use `impeccable detect --no-config ...` for a raw detector run that ignores project config/context. Use `impeccable ignores ...` for direct CLI CRUD on the same detector ignores.

## Routing

The first argument is the action. Defaults to `status`.

| Action | What it does |
|---|---|
| `status` | Print current state, shared/local config paths, ignored rules / files / values, and env override. |
| `on` | Set `enabled: true` in `.impeccable/config.json` (turns the automatic check back on). |
| `off` | Set `enabled: false` in `.impeccable/config.json` (the agent runs the detector only when asked). |
| `ignore-rule <id>` | Append `<id>` to `detector.ignoreRules`; for `overused-font`, requires `--all-values`. Suppresses the rule across the whole project. |
| `ignore-file <glob>` | Append `<glob>` to `detector.ignoreFiles`. Suppresses **every** rule for matching files. |
| `ignore-value <id> <value> [--shared] [--reason "..."]` | Append a rule/value suppression to shared `.impeccable/config.json`. |
| `ignore-value <id> <value> --local [--reason "..."]` | Append a private rule/value suppression to `.impeccable/config.local.json`. |
| `ignore-value <id> "*" --file <glob> [--file <glob>...]` | Turn one rule off in matching files only, leaving it active everywhere else. Repeat `--file`, or use `--file=<glob>` / `--files=<glob>`. A bare `"*"` with no `--file` is refused: use `ignore-rule <id>` if you really mean project-wide. |
| `reset` | Delete the project config and dedup cache. |

## Flow

1. Resolve the action from the user's argument. If no action was given, default to `status`.
2. Invoke the admin script and pass the user's output through verbatim:

   ```bash
   impeccable hooks <action> [args...]
   ```

3. If `<action>` is `off`, follow up with a one-line note: "Done. New edits will not trigger the design check in this project until you run `/impeccable hooks on`."
4. If `<action>` is `on`, report that the automatic check is back on for this project.
5. If `<action>` is `ignore-value`, `ignore-file`, or `ignore-rule`, just print the script output. The default scope is shared `.impeccable/config.json`; add `--local` only when the user explicitly asks for a private exception.
6. If `<action>` is `status`, just print the script output. Do not add commentary unless the user asked a follow-up question.

## Triage findings

The check itself never writes ignore config; every exception goes through `impeccable hooks`. Triage each finding into one of three outcomes:

- **Real design problem**: fix it. Never add an ignore to skip a fix or to push a blocked write through.
- **Confident false positive or sanctioned exception**: persist the narrowest ignore yourself and disclose it in your reply. The bar is evidence you can name: an intentional demo or fixture, documentation of bad design, literal or domain-appropriate motion (a ball that bounces), or a choice the user already confirmed. Put that evidence in `--reason` as `"<who decided: evidence>"`; write "user confirmed" only when the user actually did.
- **Unsure**: leave the finding standing and give the reason in one line. Ask the user only when you genuinely cannot decide.

Self-serve stops at `ignore-value`. `ignore-file` and `ignore-rule` silence too much to add on your own judgment; ask the user first.

Prefer the narrowest exception:

- If the finding line shows an `ignore-value <rule> <value>` pair, pass it to `impeccable hooks ignore-value` with your `--reason`. This writes shared `.impeccable/config.json` by default.
- For value-specific findings such as `overused-font` and `bounce-easing`, use `ignore-value` for the specific value. Do not use `ignore-rule overused-font` for a specific font.
- If the finding has no value-specific command, such as `side-tab`, scope that one rule to the file: `ignore-value <id> "*" --file <path>`. Run `impeccable detect <path>` first to see what actually fires there.
- Reach for `ignore-file <path>` only when the whole file is out of scope for design review: a fixture, a generated artifact, a deliberate slop demo. It silences every rule for that file permanently, including rules that have not been written yet. A real UI surface with one noisy rule wants the file-scoped value ignore above.
- Use `ignore-rule <id>` only when the user asks to suppress that whole rule across the project. For broad overused-font suppression, use `ignore-rule overused-font --all-values` only when the user asks to ignore overused fonts generally.
- Prefer config ignores (the commands above) by default; they keep suppressions in one reviewable place. Reach for an inline comment only when the waiver must travel with a single file that leaves the repo (a generated/exported standalone document, an emailed HTML file). The supported marker is `impeccable-disable <rule>` (whole file) or `impeccable-disable-line` / `impeccable-disable-next-line` (one line), in any comment syntax, with an optional reason after `:` or `--`. The detector honors it by default; `--no-inline-ignores` or `--no-config` bypasses it.

Example value-specific exception:

```bash
impeccable hooks ignore-value overused-font Inter --shared --reason "User confirmed Inter is intentional"
```

Example self-served exception, with the evidence named:

```bash
impeccable hooks ignore-value bounce-easing bounce-ball --shared --reason "Agent: literal ball-bounce animation, bounce easing is the subject"
```

Example whole-rule font exception:

```bash
impeccable hooks ignore-rule overused-font --all-values --reason "User asked to ignore overused fonts generally"
```

Example one-rule-in-one-file exception, for a file that is still worth reviewing
for everything else:

```bash
impeccable hooks ignore-value design-system-font-size "*" --file "src/overlay/widget.js" --reason "Injected widget builds its own type scale; DESIGN.md's ramp describes the site"
```

Example whole-file exception, for a file that is out of scope entirely:

```bash
impeccable hooks ignore-file "src/legacy/Card.tsx"
```

## Constraints

- Never modify `.impeccable/config.json` or `.impeccable/config.local.json` by hand from this command. Always go through `impeccable hooks` so writes stay validated and the file shape stays consistent. One exception: `detector.extensions` has no admin action, so when the user asks to cover a template stack, edit that one field in `.impeccable/config.json` directly and leave the rest of the file untouched.
- Do not edit the bundled engine binary; it is skill plumbing.
- When a user asks how far to trust the check, say it runs the engine unsandboxed with the agent's environment and network access, and that the bundled engine's checksum is verified when the installer is built; **never** call it sandboxed.
- The automatic check never blocks an edit; it reports after the work lands. Disabling stops the reports.

## Failure modes

- If `.impeccable/config.json` or `.impeccable/config.local.json` is unreadable or malformed, the check ignores that file and uses the remaining valid config/defaults. `impeccable hooks status` will show malformed files as ignored.
- If the user asks to "disable the hook" globally, lead with `/impeccable hooks off` (persistent for this project; writes `hook.enabled: false` to config).
