import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Supervisor } from "../src/orchestration/supervisor";
import { JsonlEventLog } from "../src/orchestration/jsonl-event-log";
import type { WorkerTransport, WorkerAssignment, WorkerResult } from "../src/orchestration/worker-transport";
import type { WorkerEntry } from "../src/orchestration/supervisor-core";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "smoke-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

class FakeTransport implements WorkerTransport {
	workerIds = ["w1"];
	assignments: WorkerAssignment[] = [];
	constructor(private result: WorkerResult = {
		output: "done",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, premiumRequests: 0, reasoningTokens: 0, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
		durationMs: 100,
		requests: 1,
	}) {}
	async assign(assignment: WorkerAssignment): Promise<WorkerResult> {
		this.assignments.push(assignment);
		return this.result;
	}
	async probe(): Promise<boolean> { return true; }
	async close(): Promise<void> {}
}

function log(tmpDir: string) { return new JsonlEventLog(join(tmpDir, "l.jsonl")); }
function worker(id: string): WorkerEntry { return { id, kind: "sub", busy: false, lastHeartbeat: Date.now() }; }

describe("Supervisor", () => {
	it("runs a single task end-to-end", async () => {
		const sup = new Supervisor({ log: log(tmp), transport: new FakeTransport() }, { workers: [worker("w1")] });
		const r = await sup.submit({ id: "t1", poolId: "p1", task: "do X" });
		expect(r.status).toBe("queued");
		const report = await sup.run();
		expect(report.totalProcessed).toBe(1);
		expect(report.completedCount).toBe(1);
		expect((await log(tmp).tail(0)).map(e => e.type)).toContain("work_completed");
		await sup.shutdown();
	});

	it("runs three tasks", async () => {
		const sup = new Supervisor({ log: log(tmp), transport: new FakeTransport() }, { workers: [worker("w1")] });
		await sup.submit({ id: "a", poolId: "p1", task: "X" });
		await sup.submit({ id: "b", poolId: "p1", task: "Y" });
		await sup.submit({ id: "c", poolId: "p1", task: "Z" });
		const report = await sup.run();
		expect(report.totalProcessed).toBe(3);
		await sup.shutdown();
	});

	it("records failure for worker-crashing assignments", async () => {
		const transport = new FakeTransport();
		const sup = new Supervisor({ log: log(tmp), transport }, { workers: [worker("w1")] });
		const err = new Error("boom");
		transport.assign = async (a) => { transport.assignments.push(a); throw err; };
		await sup.submit({ id: "f1", poolId: "p1", task: "fail" });
		const report = await sup.run();
		expect(report.failedCount).toBe(1);
		const events = await log(tmp).tail(0);
		expect(events.some(e => e.type === "work_failed")).toBe(true);
		await sup.shutdown();
	});

	it("rejects duplicate ids", async () => {
		const sup = new Supervisor({ log: log(tmp), transport: new FakeTransport() }, { workers: [worker("w1")] });
		const r1 = await sup.submit({ id: "dup", poolId: "p1", task: "first" });
		const r2 = await sup.submit({ id: "dup", poolId: "p1", task: "second" });
		expect(r1.status).toBe("queued");
		expect((r2 as { reason?: string }).reason).toBe("invalid-item");
		await sup.shutdown();
	});

	it("rebuilds from snapshot", async () => {
		const sup = new Supervisor({ log: log(tmp), transport: new FakeTransport() }, { workers: [worker("w1")] });
		await sup.submit({ id: "x1", poolId: "p1", task: "X" });
		await sup.run();
		const snapshot = sup.getSnapshot();
		const tail = await log(tmp).tail(0);
		expect(snapshot.inFlight.length + snapshot.queued.length).toBe(0); // all processed
		const log2 = new JsonlEventLog(join(tmp, "l2.jsonl"));
		const sup2 = new Supervisor({ log: log2, transport: new FakeTransport() }, { workers: [worker("w1")] });
		await sup2.rebuild(snapshot, tail);
		expect(sup2.getSnapshot().workers).toHaveLength(1);
		await sup2.shutdown();
	});
});
