/**
 * JSONL-file-backed implementation of {@link SupervisorEventLog}.
 *
 * Zero-dependency, human-readable, tail-friendly. Each event is one JSON
 * line; snapshots are a single JSON file checked as the snapshot version
 * advances. Suitable for the single-host default; Phase 3 swaps in the
 * NATS-backed log for cross-host workloads.
 */

import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SupervisorEvent, SupervisorEventLog, SupervisorSnapshot } from "./types";

interface SnapshotEnvelope {
	lastSeq: number;
	snapshot: SupervisorSnapshot;
}

export class JsonlEventLog implements SupervisorEventLog {
	#eventsPath: string;
	#snapshotPath: string;
	#seq: number;
	#initialized: Promise<void>;

	constructor(logPath: string) {
		this.#eventsPath = logPath;
		this.#snapshotPath = `${logPath}.snapshot`;
		this.#seq = 0;
		this.#initialized = this.#init();
	}

	async #init(): Promise<void> {
		await mkdir(dirname(this.#eventsPath), { recursive: true });
		// Count existing event lines to continue the sequence.
		try {
			const content = await readFile(this.#eventsPath, "utf-8");
			const lines = content.split("\n").filter(line => line.trim().length > 0);
			this.#seq = lines.length;
		} catch {
			this.#seq = 0;
		}
	}

	async append(event: { type: string;[key: string]: unknown }): Promise<number> {
		await this.#initialized;
		const ts = Date.now();
		const seq = ++this.#seq;
		const line = JSON.stringify({ seq, ts, ...event }) + "\n";
		await appendFile(this.#eventsPath, line, "utf-8");
		return seq;
	}

	async tail(afterSeq: number): Promise<SupervisorEvent[]> {
		await this.#initialized;
		const content = await readFile(this.#eventsPath, "utf-8");
		const events: SupervisorEvent[] = [];
		for (const line of content.split("\n")) {
			if (line.trim().length === 0) continue;
			const parsed = JSON.parse(line) as { seq: number } & Record<string, unknown>;
			if (parsed.seq > afterSeq) {
				const { seq: _seq, ts, type, ...data } = parsed;
				events.push({ ts, type, ...data } as unknown as SupervisorEvent);
			}
		}
		return events;
	}

	async latestSnapshot(): Promise<SupervisorSnapshot | null> {
		await this.#initialized;
		try {
			const raw = await readFile(this.#snapshotPath, "utf-8");
			const env = JSON.parse(raw) as SnapshotEnvelope;
			return { ...env.snapshot, lastSeq: env.lastSeq };
		} catch {
			return null;
		}
	}

	async writeSnapshot(snapshot: SupervisorSnapshot): Promise<void> {
		await this.#initialized;
		const env: SnapshotEnvelope = { lastSeq: snapshot.lastSeq, snapshot };
		await writeFile(this.#snapshotPath, JSON.stringify(env, null, 2), "utf-8");
	}

	async close(): Promise<void> {
		// No handles to close; JSONL files are flushed after each append.
	}
}
