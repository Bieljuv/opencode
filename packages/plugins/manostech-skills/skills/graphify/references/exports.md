# Exports — wiki, graph databases, SVG, GraphML, MCP, benchmark

Use this file only in Steps 6b–8, when one of these flags is present
(`--wiki`, `--neo4j` / `--neo4j-push`, `--falkordb` / `--falkordb-push`,
`--svg`, `--graphml`, `--mcp`) or when `total_words` exceeds 5,000 (the
token-reduction benchmark). A default run with no export flags never
reads this file. Run any `--wiki` export before Step 9 cleanup, while
`.graphify_labels.json` is still available.

Exports read `graphify-out/graph.json`; they never modify it.

## Wiki (`--wiki`)

Build an agent-crawlable wiki from the labeled graph:

```bash
graphify export wiki
```

It writes `index.md` (one entry per community, with its label and its
god nodes) plus one article per community under `graphify-out/wiki/`.
Each article lists the community's nodes, its edges to other
communities, and the `source_location` of each claim, so the wiki stays
traceable to the files it came from.

## Neo4j (`--neo4j`, `--neo4j-push`)

```bash
graphify export neo4j            # writes graphify-out/cypher.txt
graphify export neo4j --push bolt://localhost:7687
```

`--neo4j` generates `graphify-out/cypher.txt` (CREATE statements for the
nodes and edges) for a later import. `--neo4j-push` pushes directly to
the address the user gave — use exactly that address, and only when the
user gave one. Never push to an address the user did not name.

## FalkorDB (`--falkordb`, `--falkordb-push`)

```bash
graphify export falkordb            # writes graphify-out/cypher.txt
graphify export falkordb --push falkordb://localhost:6379
```

Same shape as Neo4j: a `cypher.txt` file, or a direct push to the
address the user gave. When both a Neo4j and a FalkorDB export are
requested, generate each `cypher.txt` in turn — the second run overwrites
the file, so copy the first one aside under a distinct name first.

## SVG (`--svg`)

```bash
graphify export svg
```

Writes `graphify-out/graph.svg`. The SVG is a static picture of the
graph for embedding in a document; it does not replace the interactive
HTML from Step 6.

## GraphML (`--graphml`)

```bash
graphify export graphml
```

Writes `graphify-out/graph.graphml` for graph tools that read GraphML
(Gephi, yEd). Node and edge attributes (label, type, relation,
`source_location`) travel in the file.

## MCP (`--mcp`)

```bash
graphify --mcp
```

Starts the MCP stdio server for agent access to the built graph. The
server serves the graph in `graphify-out/` and nothing else. It runs in
the foreground until stopped; stopping it changes nothing on disk.

## Token-reduction benchmark (`total_words` above 5,000)

When the corpus is large, measure whether the graph actually saves
reading. Pick 3 sample questions about the corpus and answer each one
twice: once from the graph (`graphify query`), once by reading the raw
files directly. Record the input tokens each path used and write the
comparison into `GRAPH_REPORT.md` under a "Token reduction" section,
with the three questions, both token counts, and which path used less.
When the graph path uses more tokens, say so plainly — the benchmark
reports the result, it never justifies the graph.
