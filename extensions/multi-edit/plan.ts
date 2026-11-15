/**
 * The editing rules, kept away from the filesystem so they can be tested directly.
 *
 * Every anchor resolves to one of four explicit states - unique, missing, ambiguous, empty - and every
 * file ends its plan in one of two: ready, carrying the bytes it should hold, or rejected, carrying no
 * body at all so a half-edited file cannot be written by accident.
 *
 * Matching runs on a normalised copy of the body, but the change lands on the original bytes by
 * mapping the match back to its raw offsets. A CRLF file keeps every line ending it had, a file with
 * mixed endings stays mixed, and a BOM never takes part in the match.
 */

export type EditCommand = { oldText: string; newText: string };

/** A file as read from disk: BOM split off, body untouched, edits still pending. */
export type Document = { path: string; bom: string; body: string; edits: EditCommand[] };

/** A file whose every anchor matched: the exact bytes to write. */
export type ReadyFile = { kind: "ready"; path: string; bom: string; body: string; applied: number };

/** A file with at least one bad anchor. It carries no body, so it cannot be written. */
export type RejectedFile = { kind: "rejected"; path: string; failures: string[] };

export type FileOutcome = ReadyFile | RejectedFile;

/** Where an anchor stands in the current body. */
export type Anchor =
	| { kind: "unique"; offset: number }
	| { kind: "missing" }
	| { kind: "ambiguous"; count: number }
	| { kind: "empty" };

/** One edit against a body: the body it produces, or why it was refused. */
export type Step = { kind: "applied"; body: string } | { kind: "refused"; reason: string };

export function normalise(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/** Separate a raw file's BOM from its body. The body keeps its own line endings. */
export function decode(raw: string): { bom: string; body: string } {
	const bom = raw.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
	return { bom, body: bom ? raw.slice(1) : raw };
}

/**
 * Locate `oldText` in `body`, counting non-overlapping occurrences - which is what "must be unique"
 * means for an anchor. The offset belongs to the normalised body, so it maps back through `rawOffset`.
 */
export function findAnchor(body: string, oldText: string): Anchor {
	const needle = normalise(oldText);
	if (needle.length === 0) return { kind: "empty" };

	const haystack = normalise(body);
	let offset = -1;
	let count = 0;

	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
		if (count === 0) offset = at;
		count += 1;
	}

	if (count === 0) return { kind: "missing" };
	if (count > 1) return { kind: "ambiguous", count };
	return { kind: "unique", offset };
}

/** The report line for an anchor that cannot be used. */
function refusal(anchor: Exclude<Anchor, { kind: "unique" }>): string {
	switch (anchor.kind) {
		case "empty":
			return "oldText is empty";
		case "missing":
			return "oldText not found";
		case "ambiguous":
			return `oldText appears ${anchor.count} times; make it unique`;
	}
}

/** Map an index in the normalised text back to the index of the raw text it came from. */
function rawOffset(raw: string, normalisedOffset: number): number {
	let at = 0;
	let seen = 0;

	while (seen < normalisedOffset && at < raw.length) {
		at += raw[at] === "\r" && raw[at + 1] === "\n" ? 2 : 1;
		seen += 1;
	}

	return at;
}

/** The line ending to give inserted text: the one it replaces, else the file's, else LF. */
function eolFor(body: string, start: number, end: number): string {
	if (body.slice(start, end).includes("\r\n")) return "\r\n";
	return body.includes("\r\n") ? "\r\n" : "\n";
}

/** Apply one edit, leaving every byte outside the anchor exactly as it was. */
export function applyEdit(body: string, edit: EditCommand): Step {
	const anchor = findAnchor(body, edit.oldText);
	if (anchor.kind !== "unique") return { kind: "refused", reason: refusal(anchor) };

	const start = rawOffset(body, anchor.offset);
	const end = rawOffset(body, anchor.offset + normalise(edit.oldText).length);
	const eol = eolFor(body, start, end);
	const wanted = normalise(edit.newText);
	const inserted = eol === "\n" ? wanted : wanted.replace(/\n/g, eol);

	return { kind: "applied", body: body.slice(0, start) + inserted + body.slice(end) };
}

/**
 * Plan every document, answering in input order. Edits apply in sequence, so two may touch the same
 * region. Every bad anchor is reported, not just the first, and a file with any of them carries no
 * body - nothing downstream can write half of it.
 */
export function planEdits(documents: Document[]): FileOutcome[] {
	return documents.map((document) => {
		const failures: string[] = [];
		let body = document.body;
		let applied = 0;

		for (let i = 0; i < document.edits.length; i++) {
			const step = applyEdit(body, document.edits[i]);

			if (step.kind === "refused") {
				failures.push(`edit ${i + 1}: ${step.reason}`);
				continue;
			}

			body = step.body;
			applied += 1;
		}

		if (failures.length > 0) return { kind: "rejected", path: document.path, failures };
		return { kind: "ready", path: document.path, bom: document.bom, body, applied };
	});
}
