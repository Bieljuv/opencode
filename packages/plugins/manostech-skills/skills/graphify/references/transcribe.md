# Transcribe — video and audio to text

Use this file only in Step 2.5, when detection found video or audio
files. A corpus with no media never reads this file.

## What to produce

For each media file detection found, produce one text transcript: same
basename with a `.txt` extension, written under
`graphify-out/transcripts/`. The transcript is the text the rest of the
pipeline reads — the original media file is not re-read in Step 3.

## How to transcribe

1. First check what the graphify tool offers: run
   `graphify transcribe --help` and use the transcription it documents.
   Discover the options from its help output; never guess flags.
2. When the tool offers no transcription, use the session's own audio
   transcription capability for the file.
3. When neither is available, do not stop the run: list the file as
   skipped-with-reason in the report ("no transcription available for
   <file>") and continue with the rest of the corpus. A missing transcript
   never blocks the graph.

Transcription uses default quality settings, and never waits on a setting before transcribing.

## What goes into the transcript

Keep speaker and time markers when the transcription provides them —
they become part of the text the extraction subagents read. Keep the
transcript next to the media it came from in name only: the transcript
file carries the media file's path in its first line
(`Source: <path to the media file>`), so every node extracted from it
can cite the media file as its `source_location`.

## After transcription

Treat every transcript as a doc file in Step 3: transcripts enter the
semantic chunking as documents, in the same chunks as the other docs.
Code-only corpora have no transcripts, so this step changes nothing
for them.
