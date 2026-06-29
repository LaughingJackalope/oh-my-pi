/**
 * Peer-agent orchestration barrel export.
 *
 * Stable import surface for the orchestration feature. Implementation
 * files re-export from here so callers don't reach into internals.
 */

export {
	executeToolViaOrchestrator,
	type OrchestratorToolBridgeOptions,
	type OrchestratorInvokeResult,
} from "../orchestrator-tool-bridge";
export type {
	WorkItem,
	WorkerResult,
	WorkItemStatus,
	SupervisorEvent,
	SupervisorSnapshot,
	SupervisorEventLog,
} from "./types";
