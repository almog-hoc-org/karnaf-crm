interface LeadDetailPanelProps {
  lead: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
  queueItems: Array<Record<string, unknown>>;
}

export function LeadDetailPanel({ lead, messages, queueItems }: LeadDetailPanelProps) {
  if (!lead) {
    return <p style={{ color: '#666' }}>בחר ליד כדי לראות פרטים</p>;
  }

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 12, padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>{String(lead.full_name || 'ליד')}</h3>
      <p>טלפון: {String(lead.phone || '—')}</p>
      <p>סטטוס: {String(lead.lead_status || '—')}</p>
      <p>חום: {String(lead.lead_heat || '—')}</p>
      <p>בעלות: {String(lead.ownership_mode || '—')}</p>

      <h4>הודעות אחרונות</h4>
      <div style={{ maxHeight: 240, overflow: 'auto', display: 'grid', gap: 8 }}>
        {messages.slice(-8).map((message) => (
          <div key={String(message.id)} style={{ background: '#fafafa', borderRadius: 8, padding: 8 }}>
            <strong>{String(message.sender_type || '—')}</strong>
            <div>{String(message.content_text || '—')}</div>
          </div>
        ))}
      </div>

      <h4>Queue</h4>
      <div style={{ display: 'grid', gap: 8 }}>
        {queueItems.map((item) => (
          <div key={String(item.id)} style={{ background: '#fafafa', borderRadius: 8, padding: 8 }}>
            <strong>{String(item.queue_type || 'queue')}</strong>
            <div>{String(item.reason || '—')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
