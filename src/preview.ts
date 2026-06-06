import type { EditToolInput, WriteToolInput } from "@earendil-works/pi-coding-agent";

import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import {
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	stripBom,
	summarizeDiff,
	type StructuredDiff,
} from "./diff-utils.js";
import { computeHashlinePreview, type HashlineEditInput } from "./hashline.js";

interface MultiEditOperation {
	oldText: string;
	newText: string;
}

interface MultiEditToolInput {
	path: string;
	edits?: MultiEditOperation[];
	oldText?: string;
	newText?: string;
}

type ParsedFreeformEditOperation =
	| { kind: "replace"; start: number; end: number; content: string[] }
	| { kind: "delete"; start: number; end: number }
	| { kind: "insert"; at: number; content: string[] };

interface ParsedFreeformEditInput {
	path: string;
	operations: ParsedFreeformEditOperation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePositiveInt(value: string): number | undefined {
	if (!/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRange(start: string, end?: string): { start: number; end: number } | undefined {
	const parsedStart = parsePositiveInt(start);
	const parsedEnd = end === undefined ? parsedStart : parsePositiveInt(end);
	if (parsedStart === undefined || parsedEnd === undefined || parsedEnd < parsedStart) return undefined;
	return { start: parsedStart, end: parsedEnd };
}

function parseFreeformEditInput(input: unknown): ParsedFreeformEditInput | { error: string; path?: string } | null {
	const patchText = typeof input === "string"
		? input
		: isRecord(input) && typeof input.input === "string"
			? input.input
			: null;
	if (patchText === null) return null;

	const lines = normalizeToLF(patchText).split("\n");
	const headerIndex = lines.findIndex((line) => line.startsWith("¶"));
	if (headerIndex === -1) return { error: "Freeform edit patch is missing a file header." };

	const headerMatch = lines[headerIndex]!.match(/^¶(.+)#[0-9A-Fa-f]{4}$/);
	if (!headerMatch) return { error: "Freeform edit patch has an invalid file header." };
	const filePath = headerMatch[1]!;

	const operations: ParsedFreeformEditOperation[] = [];
	for (let i = headerIndex + 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line || line === "*** End Patch") continue;

		const replaceMatch = line.match(/^replace (\d+)\.\.(\d+):$/);
		const insertMatch = line.match(/^insert (before|after) (\d+):$/);
		const deleteMatch = line.match(/^delete (\d+)(?:\.\.(\d+))?$/);

		if (replaceMatch || insertMatch) {
			const content: string[] = [];
			while (i + 1 < lines.length && lines[i + 1]!.startsWith("+")) {
				i++;
				content.push(lines[i]!.slice(1));
			}

			if (replaceMatch) {
				const range = parseRange(replaceMatch[1]!, replaceMatch[2]!);
				if (!range) return { error: `Invalid replace range: ${line}`, path: filePath };
				operations.push({ kind: "replace", start: range.start, end: range.end, content });
				continue;
			}

			const anchor = parsePositiveInt(insertMatch![2]!);
			if (anchor === undefined) return { error: `Invalid insert anchor: ${line}`, path: filePath };
			operations.push({
				kind: "insert",
				at: insertMatch![1] === "before" ? anchor - 1 : anchor,
				content,
			});
			continue;
		}

		if (deleteMatch) {
			const range = parseRange(deleteMatch[1]!, deleteMatch[2]);
			if (!range) return { error: `Invalid delete range: ${line}`, path: filePath };
			operations.push({ kind: "delete", start: range.start, end: range.end });
			continue;
		}

		if (line.startsWith("replace block ") || line.startsWith("delete block ")) {
			return { error: "Freeform edit preview does not support block operations.", path: filePath };
		}

		return { error: `Unsupported freeform edit operation: ${line}`, path: filePath };
	}

	if (operations.length === 0) return { error: "Freeform edit patch contains no operations.", path: filePath };
	return { path: filePath, operations };
}

export type PreviewToolName = "edit" | "hashline_edit" | "write";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".tif", ".tiff", ".heic", ".avif"]);

export interface ChangePreview {
	toolName: PreviewToolName;
	path: string;
	absolutePath: string;
	diff: string;
	diffModel?: StructuredDiff;
	additions: number;
	deletions: number;
	summaryLines: string[];
	previewError?: string;
	beforeText?: string;
	afterText?: string;
}

function stripAtPrefix(inputPath: string): string {
	return inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
}

function expandTilde(inputPath: string): string {
	if (inputPath === "~") return homedir();
	if (inputPath.startsWith("~/")) return path.join(homedir(), inputPath.slice(2));
	return inputPath;
}

function resolveToCwd(inputPath: string, cwd: string): string {
	const expanded = expandTilde(stripAtPrefix(inputPath));
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function errorPreview(
	toolName: PreviewToolName,
	filePath: string,
	absolutePath: string,
	error: string,
	summaryLines: string[],
	extra?: Partial<Pick<ChangePreview, "diff" | "diffModel" | "additions" | "deletions" | "beforeText" | "afterText">>,
): ChangePreview {
	return {
		toolName,
		path: filePath,
		absolutePath,
		diff: extra?.diff ?? `Preview unavailable\n\n${error}`,
		diffModel: extra?.diffModel,
		additions: extra?.additions ?? 0,
		deletions: extra?.deletions ?? 0,
		summaryLines,
		previewError: error,
		beforeText: extra?.beforeText,
		afterText: extra?.afterText,
	};
}

function createBinaryPreviewMessage(filePath: string, kind: "image" | "binary", detail: string, extraLine?: string): string {
	return [
		`${kind === "image" ? "Image" : "Binary"} diff preview unavailable`,
		"",
		`Path: ${filePath}`,
		`Reason: ${detail}`,
		extraLine,
		"Textual diffs can only be rendered for text files.",
	]
		.filter(Boolean)
		.join("\n");
}

function detectBinaryKind(filePath: string, buffer: Buffer): "image" | "binary" | null {
	const extension = path.extname(filePath).toLowerCase();
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	if (buffer.includes(0)) return "binary";

	const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
	if (sample.length === 0) return null;

	let suspicious = 0;
	for (const byte of sample) {
		const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
		const isPrintableAscii = byte >= 32 && byte <= 126;
		const isExtendedUtf8Byte = byte >= 128;
		if (!isAllowedControl && !isPrintableAscii && !isExtendedUtf8Byte) suspicious++;
	}

	return suspicious / sample.length > 0.15 ? "binary" : null;
}

function createChangePreviewFromTexts(
	toolName: PreviewToolName,
	filePath: string,
	absolutePath: string,
	beforeText: string,
	afterText: string,
	summaryLines: string[],
	previewError?: string,
): ChangePreview {
	const diffResult = generateDiffString(beforeText, afterText);
	const summary = summarizeDiff(diffResult.diff);

	return {
		toolName,
		path: filePath,
		absolutePath,
		diff: diffResult.diff || "(No visible diff)",
		diffModel: diffResult.model,
		additions: summary.additions,
		deletions: summary.deletions,
		summaryLines,
		previewError,
		beforeText,
		afterText,
	};
}

function withReviewEditSummary(summaryLines: string[]): string[] {
	const marker = "Edited in review";
	const filtered = summaryLines.filter((line) => line !== marker);
	return [marker, ...filtered];
}

export function rebuildPreviewAfterManualEdit(preview: ChangePreview, editedAfterText: string): ChangePreview {
	if (preview.beforeText === undefined || preview.afterText === undefined) return preview;

	const normalizedAfterText = normalizeToLF(editedAfterText);
	const nextSummaryLines =
		normalizedAfterText === preview.afterText ? preview.summaryLines : withReviewEditSummary(preview.summaryLines);

	return createChangePreviewFromTexts(
		preview.toolName,
		preview.path,
		preview.absolutePath,
		preview.beforeText,
		normalizedAfterText,
		nextSummaryLines,
		preview.beforeText === normalizedAfterText ? `No changes would be made to ${preview.path}.` : undefined,
	);
}


function applyFreeformEditOperations(normalizedContent: string, operations: ParsedFreeformEditOperation[]): string | { error: string } {
	const lines = normalizedContent.split("\n");
	const planned = operations.map((operation, index) => ({ operation, index })).sort((a, b) => {
		const aAt = a.operation.kind === "insert" ? a.operation.at : a.operation.start - 1;
		const bAt = b.operation.kind === "insert" ? b.operation.at : b.operation.start - 1;
		return bAt - aAt || b.index - a.index;
	});

	for (const { operation } of planned) {
		if (operation.kind === "insert") {
			if (operation.at < 0 || operation.at > lines.length) return { error: "Freeform edit insert anchor is outside the file." };
			lines.splice(operation.at, 0, ...operation.content);
			continue;
		}

		const startIndex = operation.start - 1;
		const deleteCount = operation.end - operation.start + 1;
		if (startIndex < 0 || operation.end > lines.length) return { error: "Freeform edit range is outside the file." };

		if (operation.kind === "replace") {
			lines.splice(startIndex, deleteCount, ...operation.content);
		} else {
			lines.splice(startIndex, deleteCount);
		}
	}

	return lines.join("\n");
}

async function computeFreeformEditPreview(input: ParsedFreeformEditInput, cwd: string): Promise<ChangePreview> {
	const absolutePath = resolveToCwd(input.path, cwd);

	try {
		await access(absolutePath, fsConstants.R_OK);
	} catch {
		return errorPreview("edit", input.path, absolutePath, `File not found: ${input.path}`, ["Freeform edit patch"]);
	}

	try {
		const rawBuffer = await readFile(absolutePath);
		const binaryKind = detectBinaryKind(input.path, rawBuffer);
		if (binaryKind) {
			return errorPreview(
				"edit",
				input.path,
				absolutePath,
				`${binaryKind === "image" ? "Image" : "Binary"} file detected: textual diff preview is not available for ${input.path}.`,
				["Freeform edit patch", binaryKind === "image" ? "Image file" : "Binary file"],
				{
					diff: createBinaryPreviewMessage(
						input.path,
						binaryKind,
						`${binaryKind === "image" ? "Image" : "Binary"} file content cannot be shown as a text diff.`,
						"This edit tool call is likely invalid for this file.",
					),
				},
			);
		}

		const rawContent = rawBuffer.toString("utf-8");
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const afterText = applyFreeformEditOperations(normalizedContent, input.operations);
		if (typeof afterText !== "string") {
			return errorPreview("edit", input.path, absolutePath, afterText.error, ["Freeform edit patch"], {
				beforeText: normalizedContent,
			});
		}

		return createChangePreviewFromTexts(
			"edit",
			input.path,
			absolutePath,
			normalizedContent,
			afterText,
			[`${input.operations.length} freeform edit operation(s)`],
			normalizedContent === afterText ? `No changes would be made to ${input.path}.` : undefined,
		);
	} catch (error) {
		return errorPreview(
			"edit",
			input.path,
			absolutePath,
			error instanceof Error ? error.message : String(error),
			["Freeform edit patch"],
		);
	}
}

function getEditOperations(input: MultiEditToolInput): { operations: MultiEditOperation[]; mode: "single" | "multi" } | { error: string } {
	if (Array.isArray(input.edits)) {
		if (input.edits.length === 0) {
			return { error: "The edit call provided an empty edits array." };
		}
		for (const [index, edit] of input.edits.entries()) {
			if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
				return { error: `Edit ${index + 1} is missing oldText or newText.` };
			}
		}
		return { operations: input.edits, mode: "multi" };
	}

	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		return { operations: [{ oldText: input.oldText, newText: input.newText }], mode: "single" };
	}

	return { error: "The edit call is missing oldText/newText or edits[]." };
}

async function computeEditPreview(input: unknown, cwd: string): Promise<ChangePreview | null> {
	const freeformInput = parseFreeformEditInput(input);
	if (freeformInput) {
		if ("operations" in freeformInput) return computeFreeformEditPreview(freeformInput, cwd);
		const filePath = freeformInput.path ?? "unknown";
		return errorPreview("edit", filePath, resolveToCwd(filePath, cwd), freeformInput.error, ["Freeform edit patch"]);
	}

	if (!isRecord(input) || typeof input.path !== "string") return null;
	const typedInput = input as EditToolInput | MultiEditToolInput;
	const absolutePath = resolveToCwd(typedInput.path, cwd);

	try {
		await access(absolutePath, fsConstants.R_OK);
	} catch {
		return errorPreview("edit", typedInput.path, absolutePath, `File not found: ${typedInput.path}`, ["Replace exact text"]);
	}

	try {
		const rawBuffer = await readFile(absolutePath);
		const binaryKind = detectBinaryKind(typedInput.path, rawBuffer);
		if (binaryKind) {
			return errorPreview(
				"edit",
				typedInput.path,
				absolutePath,
				`${binaryKind === "image" ? "Image" : "Binary"} file detected: textual diff preview is not available for ${typedInput.path}.`,
				["Replace exact text", binaryKind === "image" ? "Image file" : "Binary file"],
				{
					diff: createBinaryPreviewMessage(
						typedInput.path,
						binaryKind,
						`${binaryKind === "image" ? "Image" : "Binary"} file content cannot be shown as a text diff.`,
						"This edit tool call is likely invalid for this file.",
					),
				},
			);
		}
		const rawContent = rawBuffer.toString("utf-8");
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const operationInfo = getEditOperations(typedInput);
		if ("error" in operationInfo) {
			return errorPreview("edit", typedInput.path, absolutePath, operationInfo.error, ["Replace exact text"]);
		}

		const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
		type PlannedEdit = {
			index: number;
			matchLength: number;
			newText: string;
			usedFuzzyMatch: boolean;
		};
		const plannedEdits: PlannedEdit[] = [];
		for (const [editIndex, edit] of operationInfo.operations.entries()) {
			const normalizedOldText = normalizeToLF(edit.oldText);
			const normalizedNewText = normalizeToLF(edit.newText);
			const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);
			const label = operationInfo.mode === "multi" ? `Edit ${editIndex + 1}` : "Replace exact text";

			if (!matchResult.found) {
				return errorPreview(
					"edit",
					typedInput.path,
					absolutePath,
					`${label}: could not find the exact text in ${typedInput.path}. The old text must be unique and match the file.`,
					[`${operationInfo.operations.length} targeted edit(s)`],
				);
			}

			const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
			const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
			if (occurrences > 1) {
				return errorPreview(
					"edit",
					typedInput.path,
					absolutePath,
					`${label}: found ${occurrences} occurrences in ${typedInput.path}. Add more context so the edit is unique.`,
					[`${operationInfo.operations.length} targeted edit(s)`],
				);
			}

			plannedEdits.push({
				index: matchResult.index,
				matchLength: matchResult.matchLength,
				newText: normalizedNewText,
				usedFuzzyMatch: matchResult.usedFuzzyMatch,
			});
		}

		const sortedEdits = [...plannedEdits].sort((a, b) => a.index - b.index);
		for (let i = 1; i < sortedEdits.length; i++) {
			const previous = sortedEdits[i - 1]!;
			const current = sortedEdits[i]!;
			if (current.index < previous.index + previous.matchLength) {
				return errorPreview(
					"edit",
					typedInput.path,
					absolutePath,
					`Some edits in ${typedInput.path} overlap or target the same region. Merge them into one edit.`,
					[`${operationInfo.operations.length} targeted edit(s)`],
				);
			}
		}

		const baseContent = normalizedContent;
		let newContent = baseContent;
		for (const edit of [...sortedEdits].sort((a, b) => b.index - a.index)) {
			newContent = newContent.substring(0, edit.index) + edit.newText + newContent.substring(edit.index + edit.matchLength);
		}

		const fuzzyMatchCount = plannedEdits.filter((edit) => edit.usedFuzzyMatch).length;
		const summaryLines =
			operationInfo.mode === "single"
				? ["Replace exact text", fuzzyMatchCount > 0 ? "Matched using fuzzy normalization" : "Matched exact text"]
				: [
					`${operationInfo.operations.length} targeted edit(s)`,
					fuzzyMatchCount > 0
						? `${fuzzyMatchCount} edit(s) matched using fuzzy normalization`
						: "All edits matched exact text",
				  ];

		if (baseContent === newContent) {
			return createChangePreviewFromTexts(
				"edit",
				typedInput.path,
				absolutePath,
				baseContent,
				newContent,
				summaryLines,
				`No changes would be made to ${typedInput.path}.`,
			);
		}

		return createChangePreviewFromTexts("edit", typedInput.path, absolutePath, baseContent, newContent, summaryLines);
	} catch (error) {
		return errorPreview(
			"edit",
			typedInput.path,
			absolutePath,
			error instanceof Error ? error.message : String(error),
			["Replace exact text"],
		);
	}
}

async function computeWritePreview(input: WriteToolInput, cwd: string): Promise<ChangePreview> {
	const absolutePath = resolveToCwd(input.path, cwd);
	let beforeText = "";
	let existed = true;

	try {
		await access(absolutePath, fsConstants.R_OK);
		const rawBuffer = await readFile(absolutePath);
		const binaryKind = detectBinaryKind(input.path, rawBuffer);
		if (binaryKind) {
			return errorPreview(
				"write",
				input.path,
				absolutePath,
				`Existing ${binaryKind === "image" ? "image" : "binary"} file detected: textual diff preview is not available for ${input.path}.`,
				["Overwrite existing file", binaryKind === "image" ? "Image file" : "Binary file"],
				{
					diff: createBinaryPreviewMessage(
						input.path,
						binaryKind,
						`Existing file content cannot be rendered as text.`,
						`Approving will overwrite it with ${input.content.split("\n").length.toLocaleString()} line(s) of text.`,
					),
				},
			);
		}
		const rawContent = rawBuffer.toString("utf-8");
		beforeText = normalizeToLF(stripBom(rawContent).text);
	} catch {
		existed = false;
	}

	const afterText = normalizeToLF(input.content);
	if (beforeText === afterText) {
		return createChangePreviewFromTexts(
			"write",
			input.path,
			absolutePath,
			beforeText,
			afterText,
			[existed ? "Overwrite existing file" : "Create new file"],
			`No changes would be made to ${input.path}.`,
		);
	}

	return createChangePreviewFromTexts(
		"write",
		input.path,
		absolutePath,
		beforeText,
		afterText,
		[
			existed ? "Overwrite existing file" : "Create new file",
			`${afterText.split("\n").length} output line(s)`,
		],
	);
}

async function computeHashlineEditChangePreview(input: HashlineEditInput, cwd: string): Promise<ChangePreview> {
	const absolutePath = resolveToCwd(input.path, cwd);

	try {
		const preview = await computeHashlinePreview(input, cwd);
		return createChangePreviewFromTexts(
			"hashline_edit",
			input.path,
			preview.absolutePath,
			preview.beforeText,
			preview.afterText,
			[`${preview.operationCount} hashline operation(s)`, ...preview.summaryLines],
		);
	} catch (error) {
		return errorPreview(
			"hashline_edit",
			input.path,
			absolutePath,
			error instanceof Error ? error.message : String(error),
			[`${input.operations.length} hashline operation(s)`],
		);
	}
}

export async function computeChangePreview(
	toolName: PreviewToolName,
	input: unknown,
	cwd: string,
): Promise<ChangePreview | null> {
	if (toolName === "edit") return computeEditPreview(input, cwd);
	if (toolName === "write") return computeWritePreview(input as WriteToolInput, cwd);
	if (toolName === "hashline_edit") return computeHashlineEditChangePreview(input as HashlineEditInput, cwd);
	return null;
}
