# Startup recovery

The service initializes local state and returns without waiting for interrupted
runs. A background readiness probe waits for a successful Gateway `health` RPC
before starting the job worker and restoring old run bindings. Incoming webhooks
can be persisted while readiness is pending.

Only bindings captured when the service starts are recovery candidates. Their
sessions are marked blocked before the worker starts; unrelated sessions remain
available once the Gateway is ready.

Recovery uses at most four concurrent checks, a 30-second budget per pass, and a
two-second timeout for each cancellation/terminal observation. An exact-run abort
response or a terminal observation confirms recovery. A missing run or a failed
request never counts as confirmation. Before changing state, recovery verifies
that the active binding still has the same run ID and session key.

Confirmed bindings are removed and their session blocks cleared. Unconfirmed
bindings remain blocked. The `recovery:<sessionId>` metadata records attempts,
status and the next retry time; retries back off from five minutes to one hour,
including across restarts. Retry scheduling checks once a minute. A pass that
exhausts its budget pauses five minutes before checking again.

Stopping the service aborts readiness checks and background waits before closing
the store. APIs without waiter cancellation may finish later, but their results
cannot update state after recovery stops.

Rebuild and cold-restart the Gateway to apply a source change. Do not delete old
active bindings just because the run is absent from a live registry. Preserve
state and investigate unconfirmed runs.
