# Update and cluster-only — incremental runs

Use this file only for the `--update` and `--cluster-only` subcommands.
Both are non-default: a plain `/graphify` run never reads this file.

Both subcommands use the saved interpreter (`graphify-out/.graphify_python`)
and the saved scan root (`graphify-out/.graphify_root`). When either file
is missing (for example, the user deleted `graphify-out/`), re-run the
Step 1 detection first and continue from there.

## `--update` — re-extract only what changed

1. Compare the current files against the manifest Step 9 saved (hashes
   per file). New files and files whose hash changed are the changed
   subset; everything else is reused as-is.
2. Re-extract only the changed subset: AST extraction (Part A) for
   changed code, semantic extraction (Part B) for changed docs, papers,
   and images. Unchanged files reuse their cached semantic entries —
   the cache is keyed by the extraction prompt file, so entries produced
   by an older prompt are re-extracted instead of replayed.
3. Files that came up partial in the last run (listed in
   `.graphify_partial.txt`) are re-queued even when their hash did not
   change: a partial extraction covers only the head of the file, and
   stamping it done would keep the truncated graph live.
4. Files deleted since the last run drop out of the graph. The build
   still honors the shrink guard: when the new graph is smaller than the
   stored `graph.json`, the write is refused and the run stops with the
   guard message. A shrink the user intended (files deleted on purpose)
   needs a full rebuild with `--force`.
5. Rebuild the graph, re-cluster, re-label, and regenerate the report
   (Steps 4–5 and 9) from the merged extraction. The manifest is saved
   again, with only the files that actually produced output stamped —
   a file whose chunk failed stays unstamped so the next `--update`
   re-queues it.

## `--cluster-only` — rerun clustering on the existing graph

Rebuild the graph from the stored extraction, rerun clustering
(Step 4), and regenerate the report (Step 5). No file is re-extracted
and no cache entry is touched. Labels from `.graphify_labels.json` are
kept unless the user asks for new ones.

Use `--cluster-only` when the graph exists and only the grouping looks
wrong — for example, after editing community labels by hand, or when a
first clustering split a topic that belongs together.

## The manifest

The manifest is written by Step 9 and read by `--update`. Never edit it
by hand: a hand-edited manifest makes the next update skip files it
should re-extract, or re-extract files it should reuse.
