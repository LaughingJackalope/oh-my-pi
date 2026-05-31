import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compactAlgorithmically,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

function user(content: string, timestamp = 1): AgentMessage {
	return { role: "user", content, timestamp };
}

function assistant(content: AssistantMessage["content"], timestamp = 2): AgentMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	const fileOps = createFileOps();
	fileOps.read.add("src/config.ts");
	fileOps.written.add("src/feature.ts");
	return {
		firstKeptEntryId: "entry-kept",
		messagesToSummarize: [
			user("Implement deterministic compaction. Always avoid LLM calls for this mode."),
			assistant([
				{ type: "text", text: "I inspected the compaction flow." },
				{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/config.ts" } },
				{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "src/feature.ts" } },
			]),
			user("Use the existing settings surface and keep this as Chunk 1."),
		],
		turnPrefixMessages: [assistant([{ type: "text", text: "Do you want me to open a PR?" }], 3)],
		recentMessages: [user("Proceed with the standalone PR.", 4)],
		isSplitTurn: true,
		tokensBefore: 42_000,
		previousSummary: undefined,
		previousPreserveData: undefined,
		fileOps,
		settings: { ...DEFAULT_COMPACTION_SETTINGS, strategy: "algorithmic", remoteEnabled: false },
		...overrides,
	};
}

describe("compactAlgorithmically", () => {
	test("emits the structured pi-vcc-derived sections with file metadata", () => {
		const result = compactAlgorithmically(makePreparation());

		expect(result.firstKeptEntryId).toBe("entry-kept");
		expect(result.tokensBefore).toBe(42_000);
		expect(result.details).toEqual({
			compactor: "algorithmic",
			version: 1,
			sections: [
				"Session Goal",
				"Files And Changes",
				"Commits",
				"Outstanding Context",
				"User Preferences",
				"Rolling Brief Transcript",
			],
			sourceMessageCount: 4,
			previousSummaryUsed: false,
			derivedFrom: ["pi-vcc", "pi-observational-memory", "pi-blackhole"],
			readFiles: ["src/config.ts"],
			modifiedFiles: ["src/feature.ts"],
		});
		expect(result.summary).toContain("[Session Goal]\nInitial request: Implement deterministic compaction.");
		expect(result.summary).toContain(
			"[Files And Changes]\nModified files:\n- src/feature.ts\nRead-only files:\n- src/config.ts",
		);
		expect(result.summary).toContain(
			"[User Preferences]\n- Implement deterministic compaction. Always avoid LLM calls for this mode.",
		);
		expect(result.summary).toContain("[Rolling Brief Transcript]");
		expect(result.summary).toContain(
			"- Assistant: I inspected the compaction flow. [tool call: read src/config.ts] [tool call: write src/feature.ts]",
		);
	});

	test("preserves previous summary, custom focus, extra context, and hook payload", () => {
		const preserveData = { retained: true };
		const result = compactAlgorithmically(
			makePreparation({ previousSummary: "Prior summary: keep the public API unchanged." }),
			{
				customInstructions: "Focus on settings compatibility.",
				extraContext: ["Memory backend context: user prefers boring changes."],
				preserveData,
			},
		);

		expect(result.preserveData).toBe(preserveData);
		expect(result.details?.previousSummaryUsed).toBe(true);
		expect(result.summary).toContain("Compaction focus: Focus on settings compatibility.");
		expect(result.summary).toContain(
			"Previous compaction summary to preserve:\nPrior summary: keep the public API unchanged.",
		);
		expect(result.summary).toContain("Additional context:\n- Memory backend context: user prefers boring changes.");
		expect(result.summary).toContain("Last assistant question/request: Do you want me to open a PR?");
	});

	test("bounds long transcript text while retaining section shape", () => {
		const longText = `Start ${"x".repeat(2_000)}`;
		const result = compactAlgorithmically(makePreparation({ messagesToSummarize: [user(longText)] }));

		expect(result.summary).toContain("[Session Goal]");
		expect(result.summary).toContain("Start ");
		expect(result.summary).toContain("…");
		expect(result.summary.length).toBeLessThan(4_000);
	});
});
