# Extraction spec — the exact subagent prompt for semantic extraction

Use this file only in Step B2, when at least one chunk holds a doc, paper,
or image. A pure-code corpus skips Part B and never reads this file.

Load this file, substitute FILE_LIST, CHUNK_NUM, TOTAL_CHUNKS, DEEP_MODE,
and CHUNK_PATH, and hand the result verbatim to each subagent — one call
per chunk, all calls in the same message, `subagent_type="general-purpose"`
(a read-only subagent cannot write its chunk file, and the result is
silently lost).

## The subagent prompt

```
You are extracting a knowledge graph from the files below. Read every file
to its last line — a file you only partly read still writes a well-formed
chunk, and the missing half is lost silently. Write exactly one JSON file
to CHUNK_PATH and nothing else (no prose outside the JSON).

Files (chunk CHUNK_NUM of TOTAL_CHUNKS):
FILE_LIST

Deep mode: DEEP_MODE (true or false). When true, also add INFERRED edges
between files in this chunk and second-order relations (A relates to C
through B). When false, extract only what each file states or clearly
implies on its own.

## Output schema

{
  "nodes": [
    {
      "id": "doc:authentication-flow",
      "label": "Authentication flow",
      "type": "concept",
      "source_location": "docs/auth.md#login-sequence",
      "confidence": "high",
      "tier": "EXTRACTED"
    }
  ],
  "edges": [
    {
      "source": "doc:authentication-flow",
      "target": "doc:session-token",
      "relation": "issues",
      "confidence": "high",
      "tier": "EXTRACTED"
    }
  ],
  "hyperedges": [
    {
      "id": "he:login-pipeline",
      "nodes": ["doc:authentication-flow", "doc:session-token", "doc:login-page"],
      "label": "Login pipeline",
      "source_location": "docs/auth.md#login-sequence"
    }
  ],
  "coverage": { "docs/auth.md": 214 },
  "input_tokens": 0,
  "output_tokens": 0
}

`input_tokens` and `output_tokens` stay 0 here — the caller fills in the
real counts from the subagent result before merging. Never estimate them.

## Node-ID rules

- A node `id` is a lowercase kebab-case slug of its label, prefixed by
  its kind: `doc:` for a document, `paper:` for a paper, `image:` for an
  image, `concept:` for an idea that spans files.
- The `id` must be unique inside the chunk. When two different things
  would get the same `id`, append `-2`, `-3`, and so on. Never reuse one
  `id` for two different things.
- `type` is one of: `concept`, `module`, `person`, `decision`, `event`,
  `file`, `diagram`. Pick the closest; when unsure, use `concept`.
- `source_location` is the file path plus the section it came from
  (`docs/auth.md#login-sequence`). For a doc, paper, or image node, never
  use a bare line number as the location: the build reads a `L<line>`
  shape as a code node, and the next incremental run deletes it along
  with the code file it seems to belong to.

## Confidence rubric and tiers

Every node and edge carries both a `confidence` and a `tier`:

- `EXTRACTED` — stated in the file, in so many words. Confidence `high`.
- `INFERRED` — implied by two or more passages, but not stated outright.
  Confidence `medium`. In deep mode, cross-file INFERRED edges are
  expected; outside deep mode, keep them only when the implication is
  direct.
- `AMBIGUOUS` — unclear, contradicted by another passage, or readable two
  ways. Confidence `low`. Record both readings on the edge or node, and
  never resolve the contradiction silently.

Never invent an edge. When unsure, use AMBIGUOUS.

## Frontmatter

When a Markdown file carries YAML frontmatter, record its fields on the
file's nodes: title, author, and date when present, plus any tags. The
frontmatter is part of the file — a tag or a date there is EXTRACTED,
not INFERRED.

## Hyperedges

A hyperedge groups three or more nodes that only make sense together
(a pipeline, a decision with its alternatives, a diagram with its parts).
Give it a short label and the `source_location` the group came from.
Two nodes are an edge, never a hyperedge.

## Vision rules (images)

Describe only what is visible: shapes, labels, arrows, and text that can
actually be read in the image. Extract entities from visible labels and
from the arrows between them. Never invent text that is not visible, and
never guess a label you cannot read. Anything read off a diagram that
could be misread is AMBIGUOUS. When the image is a screenshot of text,
transcribe the visible text as the node's label source and mark the node
EXTRACTED only for the words that are legible.

## Coverage

`coverage` maps every file in FILE_LIST to the last line number you read
in it. A file you did not report at all is not counted as partial — there
is nothing to compare against — which is why this count is required. Read
each file to its end: a file longer than 2000 lines already has a chunk to
itself, so there is no reason to stop early.
```

## Cache attribution

The caller passes this file's absolute path as SPEC_PATH to the cache
check (Step B0) and the cache save (Step B3). Cache entries are stamped
with the prompt that produced them: when this file changes, entries
produced by the old prompt are re-extracted instead of replayed. Pass
the same path to both steps, and never drop the argument.
