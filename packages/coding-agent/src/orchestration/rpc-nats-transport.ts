/**
 * Remote (NATS-bridged) worker transport for Phase 3.
 *
 * Architecture:
 *
 *   Supervisor                                Worker(s)
 *   ──────────                                ────────
 *   publish → tasks.pool.{id}.dispatch ──────→ subscribe (queue group)
 *                                             ↓ do work
 *   subscribe ← tasks.pool.{id}.completion ←── publish
 *
 * Each worker runs as a standalone process running the oh-my-pi agent.
 * The worker connects to NATS, subscribes to the pool's dispatch subject
 * in a queue group (load balanced), does the work via the agent loop, and
 * publishes the result on the completion subject.
 *
 * The supervisor publishes a {@link WorkerAssignment} as JSON and waits
 * for a single completion message. Correlation is by work item id, not
 * by NATS reply-to, so multiple supervisors (or late completions) are
 * safe — the first matching completion wins.
 */

import { connect, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import type { WorkerAssignment } from "./worker-transport";
import type { WorkerTransport, WorkerResult } from "./worker-transport";

const DISPATCH_SUBJECT = (poolId: string) => `tasks.pool.${poolId}.dispatch`;
const COMPLETION_SUBJECT = (poolId: string) => `tasks.pool.${poolId}.completion`;
const DEFAULT_QUEUE = "workers";

interface PendingRequest {
	resolve: (r: WorkerResult) => void;
	reject: (e: Error) => void;
}

export interface RpcNatsTransportOptions {
	/** NATS URL, e.g. "nats://silver.local:4222". */
	servers: string;
	/** Pool id — forms the subject prefix. */
	poolId: string;
	/** Queue group for load balancing. Defaults to "workers". */
	queue?: string;
	/** Timeout (ms) for a single assignment. */
	timeoutMs?: number;
}

export class RpcNatsTransport implements WorkerTransport {
	#nc: NatsConnection | null = null;
	#pending = new Map<string, PendingRequest>();
	#subscription: Subscription | null = null;
	#poolId: string;
	#queue: string;
	#timeoutMs: number;
	#initialized = false;

	constructor(private options: RpcNatsTransportOptions) {
		this.#poolId = options.poolId;
		this.#queue = options.queue ?? DEFAULT_QUEUE;
		this.#timeoutMs = options.timeoutMs ?? 60_000;
	}

	get workerIds(): string[] {
		// In NATS mode we don't enumerate workers; report "remote" so the
		// supervisor transport abstraction is consistent.
		return ["remote"];
	}

	async init(): Promise<void> {
		if (this.#initialized) return;

		this.#nc = await connect({
			servers: this.options.servers,
			name: `oh-my-pi-worker-${this.#poolId}`,
			reconnect: true,
			maxReconnectAttempts: 10,
			waitOnFirstConnect: true,
		});

		// Subscribe to completion messages, route by work item id in payload.
		this.#subscription = this.#nc.subscribe(COMPLETION_SUBJECT(this.#poolId));
		this.#consumeCompletions();

		this.#initialized = true;
	}

	async assign(assignment: WorkerAssignment): Promise<WorkerResult> {
		if (!this.#nc) await this.init();
		return new Promise<WorkerResult>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(assignment.workItemId);
				reject(new Error(`timeout waiting for ${assignment.workItemId}`));
			}, this.#timeoutMs);
			this.#pending.set(assignment.workItemId, {
				resolve: (r) => { clearTimeout(timeout); resolve(r); },
				reject: (e) => { clearTimeout(timeout); reject(e); },
			});
			const data = Buffer.from(JSON.stringify(assignment), "utf-8");
			this.#nc!.publish(DISPATCH_SUBJECT(this.#poolId), data);
		});
	}

	async probe(workerId: string): Promise<boolean> {
		return this.#nc !== null && !this.#nc.isClosed();
	}

	async close(): Promise<void> {
		if (this.#nc && !this.#nc.isClosed()) {
			await this.#nc.close();
		}
		this.#pending.clear();
		this.#initialized = false;
	}

	async #consumeCompletions(): Promise<void> {
		if (!this.#subscription) return;
		for await (const msg of this.#subscription) {
			try {
				const payload = JSON.parse(new TextDecoder().decode(msg.data)) as { workItemId: string } & WorkerResult;
				const pending = this.#pending.get(payload.workItemId);
				if (pending) {
					this.#pending.delete(payload.workItemId);
					pending.resolve({
						output: payload.output ?? "",
						usage: payload.usage ?? {
							input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
							totalTokens: 0, premiumRequests: 0, reasoningTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						durationMs: payload.durationMs ?? 0,
						requests: payload.requests ?? 1,
					});
				}
			} catch (e) {
				// Malformed completion — ignore, let timeout handle it.
				console.error("rpc-nats: completion parse error:", e);
			}
		}
	}
}
