import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageDir, "../..");
const cliPath = path.join(packageDir, "dist", "cli.js");
const clientIndexPath = path.join(packageDir, "dist", "client", "index.html");

async function waitForStatsIndex(port: number, proc: Bun.Subprocess): Promise<boolean> {
	for (let attempt = 0; attempt < 80; attempt++) {
		const exitCode = await Promise.race([proc.exited, Bun.sleep(0).then(() => undefined)]);
		if (exitCode !== undefined) return false;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			const text = await response.text();
			if (response.status === 200 && text.includes('<div id="root"></div>')) return true;
		} catch {}

		await Bun.sleep(100);
	}
	return false;
}

describe("stats dashboard bundle", () => {
	it("serves the copied client assets from the bundled CLI", async () => {
		const build = Bun.spawn([process.execPath, "scripts/bundle-dist.ts"], {
			cwd: packageDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [buildStdout, buildStderr, buildExitCode] = await Promise.all([
			new Response(build.stdout).text(),
			new Response(build.stderr).text(),
			build.exited,
		]);
		expect(`${buildStdout}${buildStderr}`).toContain("Bundled coding-agent CLI to dist/cli.js");
		expect(buildExitCode).toBe(0);
		expect(await Bun.file(clientIndexPath).exists()).toBe(true);

		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-bundle-"));
		const port = 48_700 + Math.floor(Math.random() * 1_000);
		const server = Bun.spawn([process.execPath, cliPath, "stats", "--port", String(port)], {
			cwd: repoRoot,
			env: {
				...Bun.env,
				HOME: path.join(tempRoot, "home"),
				OMP_HOME: path.join(tempRoot, "omp"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		try {
			const servedIndex = await waitForStatsIndex(port, server);
			if (!servedIndex) {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(server.stdout).text(),
					new Response(server.stderr).text(),
					server.exited,
				]);
				throw new Error(`stats server did not serve index.html; exit=${exitCode}\n${stdout}${stderr}`);
			}
		} finally {
			server.kill();
			await server.exited;
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
