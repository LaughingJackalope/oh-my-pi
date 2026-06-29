import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlEventLog } from "../src/orchestration/jsonl-event-log";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "smoke-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("JsonlEventLog", () => {
	it("appends, tails, and round-trips snapshots.", async () => {
		const log = new JsonlEventLog(join(tmp, "events.jsonl"));
		const seq1 = await log.append({
			type: "work_dispatched",
			workItemId: "w1",
			workerId: "v1",
			poolId: "p1",
			attempt: 1,
		});
		const seq2 = await log.append({
			type: "work_completed",
			workItemId: "w1",
			workerId: "v1",
			result: {
				output: "done",
				usage: {
					input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
					premiumRequests: 0, reasoningTokens: 0,
					cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
				},
				durationMs: 5000,
				requests: 2,
			},
		});

		expect(seq1).toBe(1);
		expect(seq2).toBe(2);

		const tail = await log.tail(1);
		expect(tail).toHaveLength(1);
		expect(tail[0]?.type).toBe("work_completed");

		await log.writeSnapshot({
			lastSeq: 2, inFlight: [], queued: [],
			workers: [{ id: "v1", lastHeartbeat: Date.now(), kind: "sub" }],
			poolIds: ["p1"],
		});

		const snap = await log.latestSnapshot();
		expect(snap).not.toBeNull();
		expect(snap?.lastSeq).toBe(2);
		expect(snap?.poolIds[0]).toBe("p1");

		// Recovery: new instance reads snapshot + tail
		const log2 = new JsonlEventLog(join(tmp, "events.jsonl"));
		const recovered = await log2.latestSnapshot();
		expect(recovered?.lastSeq).toBe(2);
		const missed = await log2.tail(recovered!.lastSeq);
		expect(missed).toHaveLength(0);

		await log.close();
		await log2.close();
	});
});
