/**
 * Supervisor: orchestrates work across a pool of worker agents.
 *
 * Constructed with a {@link WorkerTransport} and a {@link SupervisorEventLog}.
 * Accepts work via {@link Supervisor.submit}, fans it out through the
 * transport, and persists lifecycle events (dispatched / completed / failed
 * / timeout) to the event log.
 *
 * On boot, call {@link Supervisor.rebuild} with a snapshot + event-tail to
 * hydrate in-flight state and re-dispatch timed-out work.
 *
 * Phase 2: LocalTransport + JsonlEventLog.
 * Phase 3: RpcNatsTransport + NatsEventLog.
 */

import type { EventBus } from "../utils/event-bus";
import type { SupervisorEvent, SupervisorSnapshot, WorkItem, WorkerResult } from "./types";
import type { SupervisorEventLog } from "./types";
import type {
	WorkerEntry,
	DispatchResult,
	AssignmentResolution,
	RunReport,
	WorkerHealth,
} from "./supervisor-core";
import type { WorkerTransport, WorkerAssignment } from "./worker-transport";
import { isDispatchSuccess } from "./supervisor-core";

export type {
	WorkerEntry,
	DispatchResult,
	AssignmentResolution,
	RunReport,
	WorkerHealth,
};
export { isDispatchSuccess };
export type { WorkerTransport, WorkerAssignment };

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;

export interface SupervisorOptions {
	transport: WorkerTransport;
	log: SupervisorEventLog;
	eventBus?: EventBus;
	heartbeatTimeoutMs?: number;
	maxAttemptsPerItem?: number;
}

export interface SupervisorInit {
	workers: WorkerEntry[];
	initialQueue?: WorkItem[];
}

export class Supervisor {
	#transport: WorkerTransport;
	#log: SupervisorEventLog;
	#eventBus?: EventBus;
	#heartbeatTimeoutMs: number;
	#maxAttemptsPerItem: number;
	#workers: Map<string, WorkerEntry>;
	#items: Map<string, WorkItem>;
	#inFlight: Map<string, { workerId: string; assignedAt: number }>;
	#queue: WorkItem[];

	constructor(options: SupervisorOptions, init: SupervisorInit = { workers: [] }) {
		this.#transport = options.transport;
		this.#log = options.log;
		this.#eventBus = options.eventBus;
		this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
		this.#maxAttemptsPerItem = options.maxAttemptsPerItem ?? 3;
		this.#workers = new Map(init.workers.map(w => [w.id, { ...w, busy: w.busy ?? false }]));
		this.#items = new Map();
		this.#inFlight = new Map();
		this.#queue = [];
		for (const item of init.initialQueue ?? []) {
			this.#items.set(item.id, item);
			this.#queue.push(item);
		}
	}

	async rebuild(snapshot: SupervisorSnapshot | null, tail: SupervisorEvent[]): Promise<void> {
		if (snapshot) {
			this.#queue = [...snapshot.queued];
			for (const wf of snapshot.inFlight) {
				this.#items.set(wf.id, wf);
				this.#inFlight.set(wf.id, { workerId: "unknown", assignedAt: Date.now() });
			}
			for (const w of snapshot.workers) {
				if (!this.#workers.has(w.id)) this.#workers.set(w.id, { ...w, busy: false });
			}
		}
		for (const event of tail) {
			this.#apply(event);
		}
		await Promise.allSettled([...this.#workers.keys()].map(id => this.#probeWorker(id)));
	}

	submit(item: Omit<WorkItem, "status" | "attempt"> & { attempt?: number }): DispatchResult {
		const full: WorkItem = { ...item, attempt: Math.max(1, item.attempt ?? 1), status: "queued" };
		if (full.maxAttempts < 1) {
			return { workItemId: full.id, reason: "invalid-item", detail: "maxAttempts must be >= 1" };
		}
		if (this.#items.has(full.id)) {
			return { workItemId: full.id, reason: "invalid-item", detail: `duplicate id ${full.id}` };
		}
		this.#items.set(full.id, full);
		this.#queue.push(full);
		return { workItemId: full.id, status: "queued" };
	}

	async run({ concurrency = Math.max(1, this.#workers.size) } = {}): Promise<RunReport> {
		const report: RunReport = { totalProcessed: 0, completedCount: 0, failedCount: 0, timedOutCount: 0 };
		const inflight = new Map<string, Promise<AssignmentResolution>>();

		while (this.#queue.length > 0 || inflight.size > 0) {
			while (inflight.size < concurrency && this.#queue.length > 0) {
				const item = this.#queue.shift()!;
				const worker = this.#pickWorker();
				if (!worker) {
					this.#queue.unshift(item);
					break;
				}
				inflight.set(item.id, this.#executeAssignment(worker.id, item));
			}
			if (inflight.size > 0) {
				const settled = await Promise.race(inflight.values());
				inflight.delete(settled.workItemId);
				report.totalProcessed++;
				if (settled.outcome === "completed") report.completedCount++;
				else if (settled.outcome === "timedOut") report.timedOutCount++;
				else report.failedCount++;
			}
		}
		return report;
	}

	async #executeAssignment(workerId: string, item: WorkItem): Promise<AssignmentResolution> {
		const session = this.#workers.get(workerId);
		if (!session) return { workItemId: item.id, workerId, outcome: "failed", error: `unknown worker ${workerId}`, durationMs: 0 };
		const assignedAt = Date.now();
		session.busy = true;
		session.currentWorkItemId = item.id;
		this.#inFlight.set(item.id, { workerId, assignedAt });

		await this.#log.append({
			type: "work_dispatched",
			workItemId: item.id, workerId, poolId: item.poolId, attempt: item.attempt,
		});

		try {
			const result = await this.#transport.assign({
				workItemId: item.id, task: item.task,
				attempt: item.attempt, maxAttempts: item.maxAttempts, metadata: item.metadata,
			});
			session.busy = false;
			session.currentWorkItemId = undefined;
			this.#inFlight.delete(item.id);
			await this.#log.append({ type: "work_completed", workItemId: item.id, workerId, result });
			return { workItemId: item.id, workerId, outcome: "completed", result, durationMs: Date.now() - assignedAt };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			session.busy = false;
			session.currentWorkItemId = undefined;
			this.#inFlight.delete(item.id);
			await this.#log.append({ type: "work_failed", workItemId: item.id, workerId, error: message, attempt: item.attempt });
			return { workItemId: item.id, workerId, outcome: "failed", error: message, durationMs: Date.now() - assignedAt };
		}
	}

	getHealth(): WorkerHealth[] {
		const now = Date.now();
		return [...this.#workers.values()].map(w => {
			const ms = now - w.lastHeartbeat;
			return { workerId: w.id, alive: ms < this.#heartbeatTimeoutMs, lastHeartbeat: w.lastHeartbeat, millisecondsSinceHeartbeat: ms };
		});
	}

	async shutdown(): Promise<void> {
		await this.#transport.close();
	}

	getSnapshot(): SupervisorSnapshot {
		const inFlight: WorkItem[] = [];
		for (const [itemId] of this.#inFlight) {
			const item = this.#items.get(itemId);
			if (item) inFlight.push({ ...item, status: "in-flight" });
		}
		return {
			lastSeq: 0, inFlight, queued: [...this.#queue],
			workers: [...this.#workers.values()].map(w => ({ id: w.id, lastHeartbeat: w.lastHeartbeat, kind: w.kind })),
			poolIds: [...new Set([...inFlight, ...this.#queue].map(i => i.poolId).filter((p): p is string => p != null))],
		};
	}

	#pickWorker(): WorkerEntry | null {
		let candidate: WorkerEntry | null = null;
		for (const w of this.#workers.values()) {
			if (w.busy) continue;
			if (!candidate || w.lastHeartbeat < candidate.lastHeartbeat) candidate = w;
		}
		return candidate;
	}

	#apply(event: SupervisorEvent): void {
		switch (event.type) {
			case "work_dispatched": {
				const item = this.#items.get(event.workItemId);
				if (item) item.status = "in-flight";
				const worker = this.#workers.get(event.workerId);
				if (worker) { worker.busy = true; worker.currentWorkItemId = event.workItemId; }
				this.#inFlight.set(event.workItemId, { workerId: event.workerId, assignedAt: event.ts });
				break;
			}
			case "work_completed":
			case "work_failed": {
				const item = this.#items.get(event.workItemId);
				if (item) {
					item.status = event.type === "work_completed"
						? "completed"
						: event.attempt >= this.#maxAttemptsPerItem ? "permanent-failure" : "failed";
				}
				const worker = this.#workers.get(event.workerId);
				if (worker) { worker.busy = false; worker.currentWorkItemId = undefined; }
				this.#inFlight.delete(event.workItemId);
				break;
			}
			case "worker_timeout": {
				const info = this.#inFlight.get(event.workItemId);
				if (info) {
					const worker = this.#workers.get(info.workerId);
					if (worker) { worker.busy = false; worker.currentWorkItemId = undefined; }
					this.#inFlight.delete(event.workItemId);
				}
				const item = this.#items.get(event.workItemId);
				if (item) item.status = "failed";
				break;
			}
			case "log_compacted":
				break;
		}
	}

	async #probeWorker(workerId: string): Promise<void> {
		const alive = await this.#transport.probe(workerId);
		const worker = this.#workers.get(workerId);
		if (!worker) return;
		worker.lastHeartbeat = Date.now();
		if (!alive && worker.busy && worker.currentWorkItemId) {
			const itemId = worker.currentWorkItemId;
			const timeoutEvent = { type: "worker_timeout" as const, workItemId: itemId, workerId, lastHeartbeat: worker!.lastHeartbeat, ts: Date.now() };
			await this.#log.append({ type: "worker_timeout", workItemId: itemId, workerId, lastHeartbeat: worker!.lastHeartbeat });
			this.#apply(timeoutEvent);
			worker.busy = false;
			worker.currentWorkItemId = undefined;
		}
	}
}
