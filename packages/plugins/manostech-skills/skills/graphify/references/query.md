# Query — answer from the graph

Use this file for `/graphify query`, `/graphify path`, and
`/graphify explain`, and whenever the fast path applies (a graph already
exists and the user asks about the corpus). Never rebuild the graph to
answer a question the existing graph can answer.

## Vocabulary expansion

Before traversal, expand the question against the graph's own
vocabulary: read the node labels from `graphify-out/graph.json` and
rewrite the question's terms to the labels that match (synonyms from
the graph, not from outside it). When no label matches, say so and
answer from the closest labels instead of guessing.

## Query modes

```bash
graphify query "<question>"              # BFS traversal — broad context
graphify query "<question>" --dfs        # DFS — trace a specific path
graphify query "<question>" --budget 1500   # cap the answer at N tokens
```

- **BFS (default):** gather the matching nodes and their neighbors up
  to 2 hops out, ranked by edge count, and answer from that subgraph.
  Use it for "how does X work" and "what connects to Y".
- **DFS:** follow one chain from the start node toward the target,
  printing each hop with its relation. Use it for "trace the flow
  through Z" and "how does A reach B".
- **`--budget N`:** cap the answer at N tokens. When the subgraph is
  larger than the budget, keep the highest-ranked nodes and say in one
  line that the answer was capped.

## Fallbacks when the CLI is unavailable

- When the tool is missing but the detected interpreter exists, traverse
  `graphify-out/graph.json` inline: load the JSON, run the same BFS or
  DFS over its nodes and edges, and print the matched subgraph.
- When the graph was built by the native lightweight map (no tool at
  all), answer from `GRAPH_REPORT.md` and `graph.json` directly — the
  same traversal, by reading the files. Never run `graphify query` in
  that case: the command does not exist here.

## Answering rules

Answer using only what the graph output contains. Quote
`source_location` when citing a specific fact. Anything not in the
graph is "not in the graph" — never invent it, and never fill the gap
from general knowledge. When the graph contradicts itself on a point,
show both sides and mark the answer AMBIGUOUS.

## Feedback (`save-result`)

When the user corrects an answer ("that edge is wrong", "X does not
call Y"), record the correction: append it to
`graphify-out/feedback.md` with the question, the wrong claim, and the
correction, each on its own line. The next build reads that file first
and applies the corrections to the extraction. Never edit `graph.json`
by hand to apply a correction — the file is rebuilt from the
extraction, and a hand edit is overwritten by the next run.

## `/graphify path` — shortest path between two concepts

```bash
graphify path "AuthModule" "Database"
```

Run a BFS over the edges from the first concept to the second and print
the chain with each hop's relation (`A —issues→ B —stores in→ C`). When
no path exists, say so in one line — never invent a hop to connect them.

## `/graphify explain` — plain-language explanation of a node

```bash
graphify explain "SwinTransformer"
```

Print the node's label, type, and neighbors (what points at it, what it
points at), its `source_location`, and a 3–5 line explanation in plain
language. When the node is not in the graph, say so and offer the
closest labels.
