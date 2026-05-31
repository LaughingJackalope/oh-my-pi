import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession algorithmic compaction", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-algorithmic-compaction-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.strategy": "algorithmic",
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		sessionManager.appendMessage({ role: "user", content: "Ship Chunk 1", timestamp: Date.now() - 2 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "I will implement algorithmic compaction." }],
			api: "mock",
			provider: "mock",
			model: "mock",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
		sessionManager.appendMessage({ role: "user", content: "Keep it standalone.", timestamp: Date.now() });
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		await tempDir.remove();
		vi.restoreAllMocks();
	});

	it("manual compaction does not require a selected model or LLM call", async () => {
		const llmCompactSpy = vi.spyOn(compactionModule, "compact");

		const result = await session.compact("preserve settings compatibility");

		expect(llmCompactSpy).not.toHaveBeenCalled();
		expect(result.summary).toContain("[Session Goal]");
		expect(result.summary).toContain("Compaction focus: preserve settings compatibility");
		expect(result.details).toMatchObject({ compactor: "algorithmic", version: 1 });
	});
});
