/**
 * Focused checks for the multi_edit tool: the all-or-nothing promise, and what a written file keeps.
 * Run with: bun test/spec.ts
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const { default: multiEditExtension } = await import("../extensions/multi-edit/index.ts");
const { planEdits } = await import("../extensions/multi-edit/plan.ts");

const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
	if (!ok) failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
};

let registered: ToolDefinition | undefined;
multiEditExtension({
	registerTool(tool: ToolDefinition) {
		registered = tool;
	},
} as unknown as ExtensionAPI);

if (!registered) throw new Error("the extension registered no tool");
const tool = registered;

const run = (cwd: string, files: unknown[], preview?: boolean) =>
	tool.execute("call", { files, preview } as never, undefined, undefined, { cwd } as ExtensionToolContext);

const message = (result: AgentToolResult<unknown>) =>
	result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

const workspace = mkdtempSync(join(tmpdir(), "multi-edit-"));
const dir = (name: string) => {
	const target = join(workspace, name);
	mkdirSync(target, { recursive: true });
	return target;
};

/** Every check starts from its own directory, so one case cannot see another's writes. */
const seed = (name: string, files: Record<string, string>) => {
	const root = dir(name);
	for (const [file, body] of Object.entries(files)) writeFileSync(join(root, file), body);
	return root;
};

// --- several files, one call -------------------------------------------------

{
	const root = seed("happy", { "a.txt": "alpha\n", "b.txt": "beta\n" });
	const result = await run(root, [
		{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
		{ path: "b.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
	]);

	check("happy: a.txt written", readFileSync(join(root, "a.txt"), "utf8") === "ALPHA\n");
	check("happy: b.txt written", readFileSync(join(root, "b.txt"), "utf8") === "BETA\n");
	check("happy: reports both files", message(result).includes("a.txt: 1 edit(s)") && message(result).includes("b.txt: 1 edit(s)"), message(result));
}

// --- the promise: a failure anywhere writes nothing --------------------------

{
	const root = seed("atomic", { "a.txt": "alpha\n", "b.txt": "beta\n" });
	const result = await run(root, [
		{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
		{ path: "b.txt", edits: [{ oldText: "missing", newText: "x" }] },
	]);

	check("atomic: first file untouched", readFileSync(join(root, "a.txt"), "utf8") === "alpha\n", readFileSync(join(root, "a.txt"), "utf8"));
	check("atomic: says nothing written", message(result).startsWith("Nothing written."), message(result));
	check("atomic: names the bad anchor", message(result).includes("b.txt: edit 1: oldText not found"), message(result));
}

// --- what a written file keeps ----------------------------------------------

{
	const root = dir("encoding");
	const crlf = "\uFEFFfirst\r\nsecond\r\n";
	writeFileSync(join(root, "crlf.txt"), crlf, "utf8");
	writeFileSync(join(root, "lf.txt"), "first\nsecond\n", "utf8");

	await run(root, [
		{ path: "crlf.txt", edits: [{ oldText: "second", newText: "SECOND" }] },
		{ path: "lf.txt", edits: [{ oldText: "second", newText: "SECOND" }] },
	]);

	const written = readFileSync(join(root, "crlf.txt"), "utf8");
	check("encoding: BOM kept", written.charCodeAt(0) === 0xfeff, JSON.stringify(written));
	check("encoding: CRLF kept", written.includes("first\r\nSECOND\r\n"), JSON.stringify(written));
	check("encoding: no bare LF", !/(?<!\r)\n/.test(written), JSON.stringify(written));
	check("encoding: LF file stayed LF", readFileSync(join(root, "lf.txt"), "utf8") === "first\nSECOND\n");
}

// --- anchors -----------------------------------------------------------------

{
	const root = seed("anchors", { "a.txt": "one\ntwo\nthree\n", "dup.txt": "x\nx\n" });

	const sequential = await run(root, [
		{
			path: "a.txt",
			edits: [
				{ oldText: "one\ntwo", newText: "1\nTWO" },
				{ oldText: "TWO", newText: "2" },
			],
		},
	]);
	check("anchors: edits apply in sequence", readFileSync(join(root, "a.txt"), "utf8") === "1\n2\nthree\n", readFileSync(join(root, "a.txt"), "utf8"));
	check("anchors: counts both edits", message(sequential).includes("2 edit(s)"), message(sequential));

	const duplicate = await run(root, [{ path: "dup.txt", edits: [{ oldText: "x", newText: "y" }] }]);
	check("anchors: duplicate reported", message(duplicate).includes("appears 2 times"), message(duplicate));
	check("anchors: duplicate wrote nothing", readFileSync(join(root, "dup.txt"), "utf8") === "x\nx\n");
}

// --- preview, and a file that is not there ----------------------------------

{
	const root = seed("preview", { "a.txt": "alpha\n" });

	const result = await run(root, [{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }], true);
	check("preview: says preview", message(result).includes("Preview only"), message(result));
	check("preview: wrote nothing", readFileSync(join(root, "a.txt"), "utf8") === "alpha\n");

	const missing = await run(root, [{ path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }]);
	check("missing: reported as unreadable", message(missing).includes("cannot read"), message(missing));
	check("missing: wrote nothing", readFileSync(join(root, "a.txt"), "utf8") === "alpha\n");
}

// --- paths resolve from the session cwd -------------------------------------

{
	const root = seed("cwd", { "a.txt": "alpha\n" });
	await run(root, [{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }]);
	check("cwd: relative path resolved from ctx.cwd", readFileSync(join(root, "a.txt"), "utf8") === "ALPHA\n");
}

// --- line endings the file already had --------------------------------------

{
	const root = seed("mixed", { "mixed.txt": "a\r\nb\nc\n" });
	await run(root, [{ path: "mixed.txt", edits: [{ oldText: "c", newText: "C" }] }]);
	const written = readFileSync(join(root, "mixed.txt"), "utf8");
	check("endings: a mixed file stays mixed", written === "a\r\nb\nC\n", JSON.stringify(written));
}

// --- a failed write says exactly what landed --------------------------------

{
	const root = seed("partial", { "a.txt": "alpha\n" });
	const locked = seed("partial-locked", { "b.txt": "beta\n" });
	chmodSync(join(locked, "b.txt"), 0o444);

	const result = await run(root, [
		{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
		{ path: join(locked, "b.txt"), edits: [{ oldText: "beta", newText: "BETA" }] },
	]);

	chmodSync(join(locked, "b.txt"), 0o644);
	check("partial: the write that landed stays", readFileSync(join(root, "a.txt"), "utf8") === "ALPHA\n", readFileSync(join(root, "a.txt"), "utf8"));
	check("partial: the failed file is untouched", readFileSync(join(locked, "b.txt"), "utf8") === "beta\n");
	check("partial: says one of two landed", message(result).includes("Wrote 1 of 2 file(s)"), message(result));
	check("partial: reads back what the failure left", message(result).includes("file unchanged"), message(result));
}

// --- the rules on their own --------------------------------------------------

{
	const [nothing] = planEdits([{ path: "a.txt", bom: "", body: "x\n", edits: [] }]);
	check("plan: no edits, ready with nothing applied", nothing.kind === "ready" && nothing.applied === 0, JSON.stringify(nothing));

	const [empty] = planEdits([{ path: "a.txt", bom: "", body: "abc\n", edits: [{ oldText: "", newText: "X" }] }]);
	check("plan: an empty anchor is refused", empty.kind === "rejected" && empty.failures[0].includes("oldText is empty"), JSON.stringify(empty));
}

rmSync(workspace, { recursive: true, force: true });

if (failures.length > 0) {
	console.error(`\n${failures.length} failure(s):\n- ${failures.join("\n- ")}\n`);
	process.exit(1);
}
console.log("all multi_edit checks passed");
