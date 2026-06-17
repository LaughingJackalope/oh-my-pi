/**
 * Creates a fetch signal whose timeout only covers the pre-response phase.
 *
 * Streaming providers disable Bun's native fetch timeout and rely on iterator-level
 * first-event/idle watchdogs after headers arrive. A plain `AbortSignal.timeout()`
 * keeps running after `fetch()` resolves and can abort a healthy response body, so
 * callers must clear the timer immediately after the response is received.
 */
export function createPreResponseTimeoutSignal(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; clear: () => void } {
	if (timeoutMs === undefined || timeoutMs <= 0) {
		return { signal: callerSignal, clear: () => {} };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();

	return {
		signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
		clear: () => clearTimeout(timer),
	};
}
