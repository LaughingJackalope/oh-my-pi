/**
 * Local (in-process) worker transport for Phase 2.
 *
 * Each "worker" is an AgentSession that has already been dispatching turns.
 * The supervisor submits a {@link WorkerAssignment}; the transport picks an
 * idle worker, runs the task via session.prompt(), waits for idle, then
 * assembles a {@link WorkerResult} from the session's final state.
 *
 * No network, no subprocesses. Phase 3 introduces RpcNatsTransport for
 * cross-host workers.
 */

import type { Usage } from "@oh-my-pi/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { WorkerTransport, WorkerAssignment, WorkerResult } from "./worker-transport";

export interface LocalWorker {
	id: string;
	session: AgentSession;
}

const ZERO_USAGE: Usage = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
	totalTokens: 0, premiumRequests: 0, reasoningTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function extractUsage(event: AgentSessionEvent): Usage {
	if (event.type !== "agent_end") return ZERO_USAGE;
	const src = (event as { usage?: Usage }).usage;
	if (!src) return ZERO_USAGE;
	return {
		input: src.input ?? 0, output: src.output ?? 0,
		cacheRead: src.cacheRead ?? 0, cacheWrite: src.cacheWrite ?? 0,
		totalTokens: src.totalTokens ?? 0, premiumRequests: src.premiumRequests ?? 0,
		reasoningTokens: src.reasoningTokens ?? 0,
		cost: {
			input: src.cost?.input ?? 0, output: src.cost?.output ?? 0,
			cacheRead: src.cost?.cacheRead ?? 0, cacheWrite: src.cost?.cacheWrite ?? 0,
			total: src.cost?.total ?? 0,
		},
	};
}

export class LocalTransport implements WorkerTransport {
	#workers: Map<string, LocalWorker>;
	#busy = new Set<string>();

	readonly workerIds: string[];

	constructor(workers: LocalWorker[]) {
		this.#workers = new Map(workers.map(w => [w.id, w]));
		this.workerIds = workers.map(w => w.id);
	}

	async assign(assignment: WorkerAssignment): Promise<WorkerResult> {
		const worker = this.#findIdleWorker();
		if (!worker) throw new Error(`no idle worker for ${assignment.workItemId}`);
		const startMs = Date.now();
		this.#busy.add(worker.id);
		let latestUsage = ZERO_USAGE;
		const unsubscribe = worker.session.subscribe(event => {
			if (event.type === "agent_end") latestUsage = extractUsage(event);
		});
		try {
			await worker.session.prompt(assignment.task, { attribution: "agent" });
			await this.#waitForIdle(worker.session);
			return {
				output: worker.session.getLastAssistantText() ?? "",
				usage: latestUsage,
				durationMs: Date.now() - startMs,
				requests: 1,
			};
		} finally {
			unsubscribe();
			this.#busy.delete(worker.id);
		}
	}

	async probe(workerId: string): Promise<boolean> {
		const worker = this.#workers.get(workerId);
		if (!worker) return false;
		return !this.#busy.has(worker.id) && !worker.session.isStreaming;
	}

	async close(): Promise<void> {
		this.#busy.clear();
	}

	#findIdleWorker(): LocalWorker | undefined {
		for (const worker of this.#workers.values()) {
			if (!this.#busy.has(worker.id) && !worker.session.isStreaming) return worker;
		}
		return undefined;
	}

	async #waitForIdle(session: AgentSession): Promise<void> {
		while (session.isStreaming) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		await session.waitForIdle();
	}
}
