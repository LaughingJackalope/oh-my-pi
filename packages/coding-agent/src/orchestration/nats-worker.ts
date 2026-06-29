/**
 * NATS worker process entry point (Phase 3).
 *
 * Connects to NATS, subscribes to `tasks.pool.{poolId}.dispatch` in a
 * queue group, receives {@link WorkerAssignment} messages, runs the
 * assignment via {@link RpcClient} (oh-my-pi agent in RPC mode), and
 * publishes the result on `tasks.pool.{poolId}.completion`.
 *
 * Usage:
 *   bun run packages/coding-agent/src/orchestration/nats-worker.ts \
 *     --servers nats://silver.local:4222 \
 *     --pool-id default
 */

import { connect } from "@nats-io/transport-node";
import type { WorkerAssignment } from "./worker-transport";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";

const DEFAULT_TIMEOUT_MS = 60_000;

interface Config {
	servers: string;
	poolId: string;
	queue?: string;
}

const config: Config = { servers: "", poolId: "", queue: "workers" };

for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (!arg.startsWith("--")) continue;
	const eq = arg.indexOf("=");
	const key = eq > -1 ? arg.slice(2, eq) : arg.slice(2);
	const value = eq > -1 ? arg.slice(eq + 1) : "true";
	(config as unknown as Record<string, string>)[key] = value;
}

if (!config.servers || !config.poolId) {
	console.error("Usage: nats-worker --servers=nats://host:4222 --pool-id=my-pool [--queue=workers]");
	process.exit(1);
}

let nc = await connect({
	servers: config.servers,
	name: `nats-worker-${config.poolId}-${process.pid}`,
	reconnect: true,
	waitOnFirstConnect: true,
});

const sub = nc.subscribe(`tasks.pool.${config.poolId}.dispatch`, { queue: config.queue });

console.log(`[nats-worker] connected to ${config.servers}, pool=${config.poolId}, queue=${config.queue}`);

async function runAssignment(assignment: WorkerAssignment): Promise<{
	output: string;
	usage: Usage;
	durationMs: number;
	requests: number;
}> {
	const { RpcClient } = await import("../modes/rpc/rpc-client");
	const client = new RpcClient({ cwd: process.cwd() });
	const start = Date.now();
	let agentUsage: Usage | undefined;
	let settled = false;

	await client.start();

	const unsubscribe = client.onEvent((event: AgentEvent) => {
		if (event.type === "agent_end" && !settled) {
			settled = true;
			const e = event as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: { estimatedUsd?: number } } };
			if (e.usage) {
				agentUsage = {
					input: e.usage.inputTokens ?? 0, output: e.usage.outputTokens ?? 0,
					cacheRead: 0, cacheWrite: 0, totalTokens: e.usage.totalTokens ?? 0,
					premiumRequests: 0, reasoningTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: e.usage.cost?.estimatedUsd ?? 0 },
				};
			}
		}
	});

	await client.prompt(assignment.task);

	while (!settled) await new Promise((r) => setTimeout(r, 50));
	unsubscribe();
	await client.waitForIdle();
	client.stop();
	return {
		output: "",
		usage: agentUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, premiumRequests: 0, reasoningTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		durationMs: Date.now() - start,
		requests: 1,
	};
}

for await (const msg of sub) {
	let assignment: WorkerAssignment;
	try {
		assignment = JSON.parse(new TextDecoder().decode(msg.data)) as WorkerAssignment;
	} catch {
		console.error("[nats-worker] bad assignment:", new TextDecoder().decode(msg.data).slice(0, 100));
		continue;
	}
	try {
		const result = await runAssignment(assignment);
		const payload = { workItemId: assignment.workItemId, output: result.output, usage: result.usage, durationMs: result.durationMs, requests: result.requests };
		await nc.publish(`tasks.pool.${config.poolId}.completion`, Buffer.from(JSON.stringify(payload), "utf-8"));
		console.log(`[nats-worker] completed ${assignment.workItemId} in ${result.durationMs}ms`);
	} catch (err) {
		console.error(`[nats-worker] failed ${assignment.workItemId}:`, err);
	}
}

process.on("SIGTERM", async () => {
	await nc.close();
	process.exit(0);
});
