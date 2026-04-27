interface LeadsTableProps {
  leads: Array<Record<string, unknown>>;
  onSelectLead?: (leadId: string) => void;
}

export function LeadsTable({ leads, onSelectLead }: LeadsTableProps) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
      <thead>
        <tr style={{ textAlign: 'right', borderBottom: '1px solid #ddd' }}>
          <th style={{ padding: 8 }}>שם</th>
          <th style={{ padding: 8 }}>טלפון</th>
          <th style={{ padding: 8 }}>סטטוס</th>
          <th style={{ padding: 8 }}>חום</th>
          <th style={{ padding: 8 }}>בעלות</th>
        </tr>
      </thead>
      <tbody>
        {leads.map((lead) => {
          const id = String(lead.id || '');
          return (
            <tr
              key={id}
              onClick={() => id && onSelectLead?.(id)}
              style={{ borderBottom: '1px solid #f0f0f0', cursor: onSelectLead ? 'pointer' : 'default' }}
            >
              <td style={{ padding: 8 }}>{String(lead.full_name || '—')}</td>
              <td style={{ padding: 8 }}>{String(lead.phone || '—')}</td>
              <td style={{ padding: 8 }}>{String(lead.lead_status || '—')}</td>
              <td style={{ padding: 8 }}>{String(lead.lead_heat || '—')}</td>
              <td style={{ padding: 8 }}>{String(lead.ownership_mode || '—')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
