/**
 * multi_edit — apply several exact-text edits across several files in one call, all or nothing.
 *
 * Why this exists next to the built-in `edit` tool: `edit` already takes several edits, but only for
 * one file. A change that touches an implementation, its caller and its docs is three calls, and a bad
 * anchor in the third leaves the first two applied. This tool validates every anchor in every file
 * first and only then writes, so a failure at the end changes nothing at all - the failure mode that
 * shell heredocs and one-shot replacement scripts produce, where the call looks like it worked.
 *
 * The run has four phases:
 *   read    -> every file loaded, or the whole call refused
 *   plan    -> every anchor matched, or the whole call refused (see plan.ts)
 *   preview -> the plan reported, nothing written
 *   commit  -> every file written, or the result naming exactly which landed
 *
 * Commit never rolls back. A write that fails after others have landed is reported by name, together
 * with what the failure left on disk, because an honest partial report beats a guessed clean one.
 *
 * The rules themselves are in `plan.ts`; this file is the read, report and write around them.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decode, planEdits, type Document, type FileOutcome, type ReadyFile } from "./plan.ts";

const EDIT = Type.Object({
	oldText: Type.String({ description: "Exact text to replace. Must appear exactly once in the file, and cannot be empty." }),
	newText: Type.String({ description: "Replacement text. May be empty to delete." }),
});

const FILE_EDITS = Type.Object({
	path: Type.String({ description: "File path, absolute or relative to the working directory." }),
	edits: Type.Array(EDIT, { description: "Edits for this file, applied in order." }),
});

const PARAMS = Type.Object({
	files: Type.Array(FILE_EDITS, {
		description: "Files to edit. Nothing is written unless every edit in every file validates.",
	}),
	preview: Type.Optional(Type.Boolean({ description: "Validate and report without writing." })),
});

/** A file as it was found: its bytes are kept so a failed commit can put them back. */
type Loaded = { absolute: string; raw: string; document: Document };

/** A file paired with what the plan decided about it. */
type Paired = { file: Loaded; outcome: FileOutcome };

/** A file the plan accepted whose contents actually change. */
type Write = { file: Loaded; outcome: ReadyFile };

/** What became of one write: it landed, or why it did not and what it left behind. */
type Attempt = { write: Write } & ({ kind: "written" } | { kind: "failed"; reason: string });

function text(body: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text: body }], details };
}

/** The bytes a ready file should hold: its BOM, then its edited body. */
function bytes({ outcome }: { outcome: ReadyFile }): string {
	return outcome.bom + outcome.body;
}

/** The writes worth making: ready files whose contents differ from what is on disk. */
function writes(pairs: Paired[]): Write[] {
	const pending: Write[] = [];

	for (const { file, outcome } of pairs) {
		if (outcome.kind !== "ready") continue;

		const write = { file, outcome };
		if (bytes(write) === file.raw) continue;

		pending.push(write);
	}

	return pending;
}

/**
 * Write each file and record what happened. One failure does not stop the rest: the point is to leave
 * as much of the change in place as the disk allows and report all of it in one pass.
 */
async function commit(pending: Write[]): Promise<Attempt[]> {
	const attempts: Attempt[] = [];

	for (const write of pending) {
		try {
			await writeFile(write.file.absolute, bytes(write), "utf8");
			attempts.push({ kind: "written", write });
		} catch (error) {
			attempts.push({ kind: "failed", write, reason: await aftermath(write, error) });
		}
	}

	return attempts;
}

/**
 * What a failed write left behind, read back rather than assumed: the file untouched, the new text
 * already on disk, or a body damaged by a failure that hit after truncation.
 */
async function aftermath(write: Write, error: unknown): Promise<string> {
	const { file } = write;
	const line = `${file.document.path}: write failed (${(error as Error).message})`;

	try {
		const now = await readFile(file.absolute, "utf8");
		if (now === file.raw) return `${line}; file unchanged`;
		if (now === bytes(write)) return `${line}; the new text is already on disk`;
		return `${line}; file was left partially written`;
	} catch {
		return line;
	}
}

export default function multiEditExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "multi_edit",
		label: "Multi-file edit",
		description:
			"Apply exact-text edits across several files atomically: every anchor is validated in every file first, and nothing is written if any edit fails. Preserves BOM and line endings.",
		promptSnippet: "Change several files in one all-or-nothing operation",
		promptGuidelines: [
			"Prefer multi_edit over separate edit calls when one change touches several files, so a failed anchor cannot leave the earlier files modified.",
		],
		parameters: PARAMS,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			const failures: string[] = [];
			const loaded: Loaded[] = [];

			for (const entry of params.files) {
				const absolute = path.isAbsolute(entry.path) ? entry.path : path.resolve(ctx.cwd, entry.path);

				try {
					const raw = await readFile(absolute, "utf8");
					const { bom, body } = decode(raw);
					loaded.push({ absolute, raw, document: { path: entry.path, bom, body, edits: entry.edits } });
				} catch (error) {
					failures.push(`${entry.path}: cannot read (${(error as Error).message})`);
				}
			}

			// planEdits answers in input order, so outcome i describes the file read at i.
			const outcomes = planEdits(loaded.map((file) => file.document));
			const pairs = loaded.map((file, index) => ({ file, outcome: outcomes[index] }));

			for (const { file, outcome } of pairs) {
				if (outcome.kind !== "rejected") continue;
				failures.push(...outcome.failures.map((line) => `${file.document.path}: ${line}`));
			}

			if (failures.length > 0) {
				const list = failures.map((line) => `- ${line}`).join("\n");
				return text(`Nothing written. ${failures.length} problem(s):\n${list}`, { phase: "plan", written: 0, failures });
			}

			const pending = writes(pairs);
			const edits = pending.reduce((sum, write) => sum + write.outcome.applied, 0);

			if (params.preview) {
				return text(`Preview only, nothing written. ${pending.length} file(s) would change, ${edits} edit(s).`, {
					phase: "preview",
					written: 0,
					failures: [],
				});
			}

			if (pending.length === 0) {
				return text("Nothing to write: every file already holds the requested text.", {
					phase: "committed",
					written: 0,
					failures: [],
				});
			}

			const landed: Write[] = [];
			const failed: string[] = [];

			for (const attempt of await commit(pending)) {
				if (attempt.kind === "written") landed.push(attempt.write);
				else failed.push(attempt.reason);
			}

			if (failed.length === 0) {
				const summary = landed.map((write) => `- ${write.file.document.path}: ${write.outcome.applied} edit(s)`);
				return text(`Applied:\n${summary.join("\n")}`, { phase: "committed", written: landed.length, failures: [] });
			}

			const list = [
				...landed.map((write) => `- ${write.file.document.path}: ${write.outcome.applied} edit(s) written`),
				...failed.map((line) => `- ${line}`),
			];

			return text(
				`Wrote ${landed.length} of ${pending.length} file(s); ${failed.length} failed. The tree is now partially changed:\n${list.join("\n")}`,
				{ phase: "commit", written: landed.length, failures: failed },
			);
		},
	});
}
