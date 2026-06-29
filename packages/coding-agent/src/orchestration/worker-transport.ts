/**
 * Worker Transport abstraction.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import type { WorkerResult } from "./types";

export interface WorkerAssignment {
	workItemId: string;
	task: string;
	attempt: number;
	maxAttempts: number;
	metadata?: Record<string, unknown>;
}

export interface WorkerTransport {
	readonly workerIds: string[];

	/**
	 * Assign work to a specific worker. Resolves with the worker's result
	 * when the worker completes. Rejects on worker death or transport error.
	 */
	assign(assignment: WorkerAssignment): Promise<WorkerResult>;

	/**
	 * Probe liveness for a worker. Returns false if unreachable.
	 */
	probe(workerId: string): Promise<boolean>;

	/** Release any held worker connections. */
	close(): Promise<void>;
}
