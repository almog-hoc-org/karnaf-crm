interface QueueListProps {
  queueItems: Array<Record<string, unknown>>;
}

export function QueueList({ queueItems }: QueueListProps) {
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
      {queueItems.map((item) => (
        <div key={String(item.id)} style={{ border: '1px solid #ddd', borderRadius: 12, padding: 12 }}>
          <div><strong>{String(item.queue_type || 'queue')}</strong></div>
          <div>סיבה: {String(item.reason || '—')}</div>
          <div>עדיפות: {String(item.priority_level || '—')}</div>
          <div>סטטוס: {String(item.status || '—')}</div>
        </div>
      ))}
    </div>
  );
}
