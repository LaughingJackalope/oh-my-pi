/**
 * Core types for the peer-agent orchestration system.
 */

import type { Usage } from "@oh-my-pi/pi-ai";

/**
 * Status of a WorkItem through its lifecycle.
 */
export type WorkItemStatus =
	| "queued"
	| "dispatched"
	| "in-flight"
	| "completed"
	| "failed"
	| "permanent-failure"
	| "dead-lettered";

/**
 * Every unit of dispatched work carries one of these.
 */
export interface WorkItem {
	/** Supervisor-generated UUID. Serves as the agent id and toolCallId. */
	readonly id: string;
	/** Pool this work belongs to. */
	readonly poolId: string;
	/** Caller-supplied key for idempotent redeliveries. Optional. */
	readonly correlationId?: string;
	/** The prompt / input for the worker. */
	readonly task: string;
	/** Carry-through metadata (priority, source request id, etc.). */
	readonly metadata?: Record<string, unknown>;
	/** Set when the work was dispatched to a worker. */
	readonly dispatchedAt?: number;
	/** Current attempt number (1-based). Default 1. */
	readonly attempt?: number;
	/** Maximum attempts before dead-lettering. Default 3. */
	readonly maxAttempts?: number;
	/** Current lifecycle status. Default 'queued'. */
	status?: WorkItemStatus;
	/** Last failure reason if status is 'failed'. */
	readonly lastError?: string;
}

/**
 * Result returned by a worker after successful completion.
 */
export interface WorkerResult {
	/** Final tool-call output. */
	readonly output: string;
	/** Token usage for the worker run (from SingleResult.usage). */
	readonly usage: Usage;
	/** Wall-clock run duration in ms. */
	readonly durationMs: number;
	/** Number of assistant requests (turns) the worker made. */
	readonly requests: number;
}

/**
 * Event-sourced log entry for the supervisor's event log.
 * All supervisor-visible state mutations append one of these.
 */
export type SupervisorEvent =
	| {
			type: "work_dispatched";
			workItemId: string;
			workerId: string;
			poolId: string;
			attempt: number;
			ts: number;
	  }
	| {
			type: "work_completed";
			workItemId: string;
			workerId: string;
			result: WorkerResult;
			ts: number;
	  }
	| {
			type: "work_failed";
			workItemId: string;
			workerId: string;
			error: string;
			attempt: number;
			ts: number;
	  }
	| {
			type: "worker_timeout";
			workItemId: string;
			workerId: string;
			lastHeartbeat?: number;
			ts: number;
	  }
	| {
			type: "log_compacted";
			snapshotSeq: number;
			finalSeq: number;
			ts: number;
	  };

/**
 * Persisted snapshot of supervisor state. Read on boot to reconstruct
 * in-flight work and worker roster without full log replay.
 */
export interface SupervisorSnapshot {
	/** Event-log sequence number captured by this snapshot. */
	readonly lastSeq: number;
	/** Currently in-flight or queued work items. */
	readonly inFlight: WorkItem[];
	/** Work items waiting for a free worker. */
	readonly queued: WorkItem[];
	/** Currently registered worker ids and their last heartbeat. */
	readonly workers: ReadonlyArray<{
		id: string;
		lastHeartbeat: number;
		kind: "sub" | "rpc";
	}>;
	/** Pool ids this supervisor owns. */
	readonly poolIds: readonly string[];
}

/**
 * Input for event-log append calls (no `ts` field — the log stamps it).
 * Replaces `Omit<SupervisorEvent, "ts">` because TypeScript cannot
 * narrow object literals against `Omit` of a discriminated union.
 */
export type SupervisorEventInput =
	| { type: "work_dispatched"; workItemId: string; workerId: string; poolId: string; attempt: number }
	| { type: "work_completed"; workItemId: string; workerId: string; result: WorkerResult }
	| { type: "work_failed"; workItemId: string; workerId: string; error: string; attempt: number }
	| { type: "worker_timeout"; workItemId: string; workerId: string; lastHeartbeat?: number }
	| { type: "log_compacted"; snapshotSeq: number; finalSeq: number };

/**
 * A consumer interface the Supervisor uses to persist events.
 * Implementations: SQLiteEventLog (Phase 2), NatsEventLog (Phase 3).
 */
export interface SupervisorEventLog {
	/** Append an event and return its sequence number. */
	append(event: SupervisorEventInput): Promise<number>;
	/** Read events with seq > afterSeq, in order. Read tail on boot. */
	tail(afterSeq: number): Promise<SupervisorEvent[]>;
	/** Read the latest snapshot if one exists. */
	latestSnapshot(): Promise<SupervisorSnapshot | null>;
	/** Persist a snapshot (idempotent on lastSeq). */
	writeSnapshot(snapshot: SupervisorSnapshot): Promise<void>;
	/** Close the log (e.g. on shutdown). */
	close(): Promise<void>;
}
