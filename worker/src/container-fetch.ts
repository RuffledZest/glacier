/** Default cap for quick container HTTP polls (logs, status). */
export const CONTAINER_POLL_TIMEOUT_MS = 45_000

type FetchableContainer = {
  fetch(input: Request | URL, init?: RequestInit): Promise<Response>
}

/**
 * `container.fetch` with an optional timeout. Use `timeoutMs: 0` for long-running
 * calls (e.g. POST /deploy) or streaming responses.
 */
export async function timedContainerFetch(
  container: FetchableContainer,
  input: Request,
  timeoutMs: number = CONTAINER_POLL_TIMEOUT_MS,
): Promise<Response> {
  if (timeoutMs <= 0) {
    return container.fetch(input)
  }
  const signal = AbortSignal.timeout(timeoutMs)
  return container.fetch(new Request(input, { signal }))
}
