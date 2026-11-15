# pi-multi-edit

A [pi](https://pi.dev) extension that adds `multi_edit`: one tool call that changes several files, and
writes nothing unless every anchor in every file matches.

## Why

The built-in `edit` tool already takes several edits, but only for one file. A change that touches an
implementation, its caller and its docs is three calls, and a bad anchor in the third leaves the first
two applied. This tool reads every file, checks every `oldText`, and only then writes.

Files come back the way they went in: a UTF-8 BOM survives, a CRLF file stays CRLF even when the
`oldText` was written with `\n`, and a file with mixed endings keeps them mixed - edits are applied to
the original bytes, never to a re-encoded copy.

## Install

```bash
git clone https://github.com/jalbarrang/pi-multi-edit
pi install ./pi-multi-edit
```

## Use

The agent reaches for it on its own. To force it, name the tool:

```bash
pi -t multi_edit -e ./pi-multi-edit
```

```
multi_edit({
  files: [
    { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] },
    { path: "README.md", edits: [{ oldText: "before", newText: "after" }] },
  ],
  preview: false,
})
```

- Each `oldText` must appear exactly once in its file, after the earlier edits in that file have been
  applied, so two edits may touch the same region in sequence. An empty `oldText` is refused.
- `preview: true` runs every check and reports what it would do, without writing.
- Any failure reports every problem at once and writes nothing. A write that still fails after the
  checks - the disk is full, the file became read-only - leaves the files that already landed in place,
  and the result says which ones and what the failure left on that file.

## Layout

```
extensions/multi-edit/
├── index.ts   the tool: read, report, write
└── plan.ts    the rules: matching, uniqueness, BOM and line endings
test/spec.ts   both, driven through the registered tool
```

## Develop

```bash
bun install
bun run typecheck
bun test/spec.ts
```

`test/spec.ts` calls the tool through a fake `ExtensionAPI`, so it exercises registration, the
all-or-nothing promise, and what a written file keeps.
