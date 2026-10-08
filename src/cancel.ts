/** Cancellation is a host operation, never an LLM prompt. A failed RPC is not proof of stopping. */
export async function cancelRun(
  request: (
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number },
  ) => Promise<unknown>,
  wait: (params: {
    runId: string;
    timeoutMs: number;
  }) => Promise<{ status: string; endedAt?: number }>,
  sessionKey: string,
  runId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10000;
  options.signal?.throwIfAborted();
  let response: { aborted?: boolean; runIds?: unknown } | undefined;
  try {
    response = (await request(
      "chat.abort",
      { sessionKey, runId },
      { timeoutMs },
    )) as typeof response;
  } catch {
    // The RPC response can be lost while the abort itself still succeeds. Do
    // not turn that transport uncertainty into a permanent session block;
    // reconcile against the durable run lifecycle below.
  }
  options.signal?.throwIfAborted();
  // The Gateway's exact-run response is authoritative. An empty run list means
  // the old run is no longer active; a matching run means it was just aborted.
  if (
    (response?.aborted === true &&
      (!response.runIds ||
        (Array.isArray(response.runIds) && response.runIds.includes(runId)))) ||
    (response?.aborted === false &&
      Array.isArray(response.runIds) &&
      response.runIds.length === 0)
  )
    return true;
  try {
    // A terminal observation also handles an abort racing normal completion.
    const terminal = await wait({ runId, timeoutMs });
    options.signal?.throwIfAborted();
    return Boolean(
      terminal.endedAt ||
        terminal.status === "ok" ||
        terminal.status === "error",
    );
  } catch {
    options.signal?.throwIfAborted();
    return false;
  }
}
