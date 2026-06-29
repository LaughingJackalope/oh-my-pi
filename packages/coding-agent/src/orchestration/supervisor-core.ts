import type { Usage } from "@oh-my-pi/pi-ai";
import type { WorkerResult } from "./types";

export type WorkerKind = "sub" | "rpc";

export interface WorkerEntry {
	id: string;
	kind: WorkerKind;
	busy: boolean;
	currentWorkItemId?: string;
	lastHeartbeat: number;
}

export interface DispatchSuccess {
	workItemId: string;
	status: "dispatched" | "queued";
}

export interface DispatchFailure {
	workItemId: string;
	reason: "no-worker" | "transport-error" | "invalid-item" | "capacity";
	detail?: string;
}

export type DispatchResult = DispatchSuccess | DispatchFailure;
export function isDispatchSuccess(r: DispatchResult): r is DispatchSuccess {
	return "status" in r && (r.status === "dispatched" || r.status === "queued");
}

export interface AssignmentResolution {
	workItemId: string;
	workerId: string;
	outcome: "completed" | "failed" | "timeout" | "worker-died" | "timedOut";
	result?: WorkerResult;
	error?: string;
	durationMs: number;
}

export interface RunReport {
	totalProcessed: number;
	completedCount: number;
	failedCount: number;
	timedOutCount: number;
}

export interface WorkerHealth {
	workerId: string;
	alive: boolean;
	lastHeartbeat: number;
	millisecondsSinceHeartbeat: number;
}
