# Add and watch — grow the corpus, track changes

Use this file only for `/graphify add <url>` and for `--watch`. Neither
is part of the default build.

## `add <url>` — fetch a URL into the corpus

```bash
/graphify add <url>                          # fetch URL, save to ./raw, update graph
/graphify add <url> --author "Name"          # tag who wrote it
/graphify add <url> --contributor "Name"     # tag who added it to the corpus
```

1. Fetch the URL and save the content under `./raw/`. The filename comes
   from the URL's last segment, sanitized to a plain filename. When a
   file with that name already exists, save as `<name>-2` instead —
   never overwrite an existing file in `./raw/`.
2. When `--author` or `--contributor` is given, record the name on the
   file's nodes at extraction time (an `author` / `contributor` field on
   the file node), so the graph remembers who wrote it and who added it.
3. Run `--update` afterwards, so the graph picks up the new file. The
   add itself only fetches and saves; the graph changes in the update.

## `--watch` — auto-rebuild on file changes

```bash
/graphify <path> --watch
```

Watch the scan root (and only the scan root) for file changes. On a
change, re-run the incremental build automatically: detection, AST
re-extraction for changed code, rebuild, and report. Changed docs,
papers, and images are queued for the next run that can do semantic
extraction, and listed as queued in the report — the watch itself never
does semantic extraction on its own.

Stop watching when the user says stop. Watching never touches files
outside the scan root, and never commits, pushes, or publishes anything.
