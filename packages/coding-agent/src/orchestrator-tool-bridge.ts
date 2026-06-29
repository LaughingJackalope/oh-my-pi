/**
 * Programmatic tool execution bridge for the orchestrator.
 *
 * Mirrors the cursor.ts tool-bridge pattern: invoke an AgentTool directly
 * (no LLM round-trip) while emitting lifecycle events to a caller-provided
 * sink. Unlike the cursor bridge, this returns the raw AgentToolResult so
 * the orchestrator can log, store, or forward it without a terminal UI
 * sanitization pass.
 *
 * See packages/coding-agent/src/cursor.ts (executeTool) for the original
 * single-call bridge that inspired this.
 */

import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { EventBus } from "../utils/event-bus";

export interface OrchestratorToolBridgeOptions {
	/** Tool registry to dispatch against. */
	readonly tools: Map<string, AgentTool>;
	/** Working directory for the executed tools. */
	readonly cwd: string;
	/** Supplies the AgentToolContext for the invoked tool (UI handles, hasUI). */
	readonly getToolContext?: () => AgentToolContext | undefined;
	/**
	 * EventBus for tool lifecycle events. The orchestrator passes the same
	 * bus the task system uses so extensions see orchestrator-driven events
	 * on the standard channels (e.g. TASK_SUBAGENT_LIFECYCLE_CHANNEL).
	 */
	readonly eventBus?: EventBus;
}

export interface OrchestratorInvokeResult {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly result: AgentToolResult<unknown>;
	readonly isError: boolean;
	/** Wall-clock milliseconds spent inside tool.execute(). */
	readonly durationMs: number;
}

function buildToolErrorResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

/**
 * Invoke a single tool programmatically. Emits tool_execution_start,
 * tool_execution_update (if the tool reports partial progress), and
 * tool_execution_end to `opts.eventBus` using the canonical event types.
 */
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
				opts.eventBus?.emit("tool_execution_update", {
					toolCallId,
					toolName,
					args,
					partialResult,
				});
			}
		: undefined;

	try {
		result = await tool.execute(
			toolCallId,
			args as Record<string, unknown>,
			undefined,
			onUpdate,
			opts.getToolContext?.(),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}

	const durationMs = Math.round(performance.now() - start);

	opts.eventBus?.emit("tool_execution_end", { toolCallId, toolName, result, isError });

	return { toolName, toolCallId, result, isError, durationMs };
}
