/**
 * Programmatic tool execution bridge for the orchestrator.
 * Mirrors the cursor.ts pattern: invoke AgentTool directly (no LLM round-trip).
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { EventBus } from "../utils/event-bus";

export interface OrchestratorToolBridgeOptions {
	readonly tools: Map<string, AgentTool>;
	readonly cwd: string;
	readonly getToolContext?: () => AgentToolContext | undefined;
	readonly eventBus?: EventBus;
}

export interface OrchestratorInvokeResult {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly result: AgentToolResult<unknown>;
	readonly isError: boolean;
	readonly durationMs: number;
}

function buildToolErrorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: {} };
}

export async function executeToolViaOrchestrator(
	opts: OrchestratorToolBridgeOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
): Promise<OrchestratorInvokeResult> {
	const tool = opts.tools.get(toolName);
	if (!tool) {
		const err = buildToolErrorResult(`Tool "${toolName}" not available in orchestrator bridge`);
		opts.eventBus?.emit("tool_execution_start", { toolCallId, toolName, args });
		opts.eventBus?.emit("tool_execution_end", { toolCallId, toolName, result: err, isError: true });
		return { toolName, toolCallId, result: err, isError: true, durationMs: 0 };
	}
	opts.eventBus?.emit("tool_execution_start", { toolCallId, toolName, args });
	let result: AgentToolResult<unknown>;
	let isError = false;
	const start = performance.now();
	const onUpdate: AgentToolUpdateCallback<unknown> | undefined = opts.eventBus
		? partialResult => {
				opts.eventBus?.emit("tool_execution_update", { toolCallId, toolName, args, partialResult });
			}
		: undefined;
	try {
		result = await tool.execute(toolCallId, args as Record<string, unknown>, undefined, onUpdate, opts.getToolContext?.());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}
	const durationMs = Math.round(performance.now() - start);
	opts.eventBus?.emit("tool_execution_end", { toolCallId, toolName, result, isError });
	return { toolName, toolCallId, result, isError, durationMs };
}
