// Pure decision logic for the queue "refresh" mode: when a signal fires
// again for a lead that already has a pending work_queue row of the same
// type, which fields should be updated so the row reflects the LATEST
// signal instead of silently no-op'ing (the old behavior — a customer's
// 5th message never bumped the row's due date or urgency).
//
// created_at is never touched: it is the historical truth and is
// load-bearing for the pending-dedupe unique index. last_signal_at
// carries "when did this last fire".
//
// Byte-identical mirror: lib/runtime/queue-refresh.ts (vitest).

export interface ExistingQueueRow {
  priority_level: number;
  due_at: string | null;
  reason: string | null;
  queue_summary: string | null;
}

export interface RefreshSignal {
  priorityLevel: number;
  dueAt?: string | null;
  reason: string;
  queueSummary?: string | null;
  nowIso: string;
}

/**
 * Build the UPDATE patch for a refreshed pending row. Priority can only
 * escalate (numerically decrease); due_at/reason always follow the new
 * signal; queue_summary only when the new signal carries one.
 */
export function buildQueueRefreshPatch(
  existing: ExistingQueueRow,
  signal: RefreshSignal,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    last_signal_at: signal.nowIso,
    reason: signal.reason,
  };
  if (signal.dueAt !== undefined && signal.dueAt !== null) patch.due_at = signal.dueAt;
  if (signal.queueSummary !== undefined && signal.queueSummary !== null) {
    patch.queue_summary = signal.queueSummary;
  }
  if (signal.priorityLevel < existing.priority_level) {
    patch.priority_level = signal.priorityLevel;
  }
  return patch;
}
