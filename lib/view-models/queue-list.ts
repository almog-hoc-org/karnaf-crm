import type { QueueRecord } from '../types/crm';

export interface QueueListViewModel {
  total: number;
  highPriorityCount: number;
  grouped: Record<string, QueueRecord[]>;
}

export function buildQueueListViewModel(queueItems: QueueRecord[]): QueueListViewModel {
  const grouped: Record<string, QueueRecord[]> = {};
  for (const item of queueItems) {
    const bucket = grouped[item.queueType] ?? [];
    bucket.push(item);
    grouped[item.queueType] = bucket;
  }

  return {
    total: queueItems.length,
    highPriorityCount: queueItems.filter((item) => item.priorityLevel <= 1).length,
    grouped,
  };
}
