# Clone and merge — repositories and multi-path runs

Use this file only when Step 0 applies: the user gave one or more
repository URLs, or several local subfolders to merge into one graph.
A plain local path never reads this file.

## Clone one repository

For each repository URL the user gave, clone it exactly as given — never
build a URL from parts, and never change the address the user typed:

```bash
git clone -- <repo-url> graphify-repos/<name>
# with a branch: git clone --branch <branch> -- <repo-url> graphify-repos/<name>
```

`<name>` is a short folder name derived from the last segment of the URL
(without a trailing `.git`). Clone under `graphify-repos/` in the current
working directory so the clone stays visible and out of the scanned
project. A clone is read-only use: never push, never commit, never change
branches inside it after the clone.

## Build each repository, then merge

1. Run Steps 1–9 inside each cloned directory (or each local subfolder),
   so every repo gets its own `graphify-out/` with its own `graph.json`
   and `GRAPH_REPORT.md`.
2. Merge the per-repo graphs into one. Use the detected interpreter to
   load each `graph.json`, union the nodes (same `id` in two repos is one
   node; keep the first copy and note the second source in the report)
   and union the edges, then write the merged graph to the main
   `graphify-out/graph.json` in the current working directory.
3. Write the merged `GRAPH_REPORT.md` in the same directory: one section
   per repository (its own God Nodes, Surprising Connections and Suggested
   Questions, copied from its report), plus a final section
   "Cross-repo connections" listing the edges whose endpoints live in
   different repositories. When there are no cross-repo edges, say so in
   one line instead of leaving the section empty.

## Monorepo flow

Several local subfolders of one project merge the same way: build each
subfolder (Steps 1–9, run from that subfolder), then merge as above, with
paths relativized to the common project root so the merged graph stays
portable. The scan root saved in Step 1 (`.graphify_root`) is the common
root; every subfolder build reads it.
