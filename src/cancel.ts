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
): Promise<boolean> {
  let response: { aborted?: boolean; runIds?: unknown } | undefined;
  try {
    response = (await request(
      "chat.abort",
      { sessionKey, runId },
      { timeoutMs: 10000 },
    )) as typeof response;
  } catch {
    return false;
  }
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
    const terminal = await wait({ runId, timeoutMs: 10000 });
    return Boolean(
      terminal.endedAt ||
        terminal.status === "ok" ||
        terminal.status === "error",
    );
  } catch {
    return false;
  }
}
