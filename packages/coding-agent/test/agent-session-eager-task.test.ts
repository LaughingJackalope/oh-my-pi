import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { z } from "zod/v4";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedPromptCall = {
	toolChoice: string | undefined;
	toolNames: string[];
	messageRoles: AgentMessage["role"][];
	messageTexts: string[];
	lastMessageRole: AgentMessage["role"];
	lastMessageText: string;
};

function isTextContentBlock(value: unknown): value is TextContent {
	if (!value || typeof value !== "object") return false;
	return (value as TextContent).type === "text" && typeof (value as TextContent).text === "string";
}

function getToolChoiceName(choice: unknown): string | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	if (typeof choice !== "object" || !("type" in choice)) return undefined;
	const toolChoice = choice as { type?: string; name?: string; function?: { name?: string } };
	if (toolChoice.type === "tool") return toolChoice.name;
	if (toolChoice.type === "function") return toolChoice.name ?? toolChoice.function?.name;
	return undefined;
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(isTextContentBlock)
		.map(content => content.text)
		.join("\n");
}

describe("AgentSession eager task prelude (#2534)", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let scriptedResponses: AssistantMessage[] = [];
	let authStorage: AuthStorage | undefined;
	const observedCalls: ObservedPromptCall[] = [];

	async function buildSession(
		overrides: Partial<AgentSessionConfig> & {
			settingsOverlay?: Record<string, unknown>;
			includeTaskTool?: boolean;
		} = {},
	): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.eager": false,
			"task.eager": true,
			...(overrides.settingsOverlay ?? {}),
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockTaskTool: AgentTool = {
			name: "task",
			label: "Task",
			description: "Mock task tool",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const tools: AgentTool[] = overrides.includeTaskTool === false ? [mockBashTool] : [mockTaskTool, mockBashTool];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: [],
			},
			convertToLlm,
			getToolChoice: () => session?.nextToolChoice(),
			streamFn: (_model, context, options) => {
				const lastMessage = context.messages.at(-1);
				if (!lastMessage) throw new Error("Expected prompt context to include a message");
				observedCalls.push({
					toolChoice: getToolChoiceName(options?.toolChoice),
					toolNames: (context.tools ?? []).map(tool => tool.name),
					messageRoles: context.messages.map(m => m.role),
					messageTexts: context.messages.map(m => getMessageText(m)),
					lastMessageRole: lastMessage.role,
					lastMessageText: getMessageText(lastMessage),
				});
				const response = scriptedResponses.shift() ?? createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		const toolRegistry = new Map<string, AgentTool>(tools.map(t => [t.name, t]));

		return new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			...overrides,
		});
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-eager-task-");
		scriptedResponses = [];
		observedCalls.length = 0;
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("prepends a hidden eager-task reminder without forcing a tool_choice", async () => {
		session = await buildSession();

		await session.prompt("refactor the parser module");

		expect(observedCalls).toHaveLength(1);
		const call = observedCalls[0];
		// Reminder must not force the model to call task — delegation follows design.
		expect(call?.toolChoice).toBeUndefined();
		expect(call?.toolNames).toEqual(["task", "bash"]);
		// Conversation must contain: hidden developer reminder, then the real user prompt.
		expect(call?.messageRoles).toEqual(["developer", "user"]);
		expect(call?.messageTexts[0]).toContain("delegation");
		expect(call?.messageTexts[0]).not.toContain("refactor the parser module");
		expect(call?.lastMessageRole).toBe("user");
		expect(call?.lastMessageText).toBe("refactor the parser module");
	});

	it("uses batch-form delegation wording when task.batch is on", async () => {
		session = await buildSession({ settingsOverlay: { "task.batch": true } });

		await session.prompt("refactor the parser module");

		const reminder = observedCalls[0]?.messageTexts[0] ?? "";
		// Batch shape `{ agent, context, tasks[] }` is the active schema — steer the model toward it.
		expect(reminder).toContain("`tasks[]`");
		expect(reminder).toContain("share `context`");
	});

	it("uses single-spawn wording when task.batch is off (codex-connector#2 on #2537)", async () => {
		// `getTaskSchema({ batchEnabled: false })` exposes only the flat `{ agent, ...item }`
		// shape with no `tasks[]`/`context`. The eager reminder MUST NOT push the model
		// toward batch fields the validator would then reject.
		session = await buildSession({ settingsOverlay: { "task.batch": false } });

		await session.prompt("refactor the parser module");

		const reminder = observedCalls[0]?.messageTexts[0] ?? "";
		expect(reminder).not.toContain("`tasks[]`");
		expect(reminder).not.toContain("share `context`");
		expect(reminder).toContain("multiple `task` calls");
	});

	it("skips the prelude when task.eager is off", async () => {
		session = await buildSession({ settingsOverlay: { "task.eager": false } });

		await session.prompt("refactor the parser module");

		expect(observedCalls).toHaveLength(1);
		const call = observedCalls[0];
		expect(call?.messageRoles).toEqual(["user"]);
		expect(call?.messageTexts).toEqual(["refactor the parser module"]);
	});

	it("skips the prelude when the `task` tool is not active", async () => {
		// Mirrors the bug: under `tools.discoveryMode: "all"` the task tool is hidden
		// unless `forceActive` keeps it. We model that with `includeTaskTool: false`.
		// Without the tool present, even with task.eager=true, the prelude must not fire
		// (a reminder that cannot lead anywhere is noise).
		session = await buildSession({ includeTaskTool: false });

		await session.prompt("refactor the parser module");

		expect(observedCalls).toHaveLength(1);
		const call = observedCalls[0];
		expect(call?.messageRoles).toEqual(["user"]);
		expect(call?.toolNames).toEqual(["bash"]);
	});

	it("skips the prelude for subagent sessions", async () => {
		session = await buildSession({ agentKind: "sub" });

		await session.prompt("refactor the parser module");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["user"]);
	});

	it("skips the prelude for prompts ending in `?` or `!`", async () => {
		session = await buildSession();

		await session.prompt("what does the parser do?");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["user"]);
	});

	it("skips the prelude on subsequent user turns", async () => {
		session = await buildSession();

		await session.prompt("refactor the parser module");
		const firstCallDeveloperCount = observedCalls[0]?.messageRoles.filter(r => r === "developer").length;
		expect(firstCallDeveloperCount).toBe(1);

		observedCalls.length = 0;
		await session.prompt("actually just fix the typo first");

		expect(observedCalls).toHaveLength(1);
		// The prior turn's reminder is still in the transcript (history), but a NEW
		// developer prelude must NOT have been added for the second user turn.
		const secondCallDeveloperCount = observedCalls[0]?.messageRoles.filter(r => r === "developer").length;
		expect(secondCallDeveloperCount).toBe(1);
		expect(observedCalls[0]?.lastMessageText).toBe("actually just fix the typo first");
	});
});
