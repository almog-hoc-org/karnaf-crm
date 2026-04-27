interface SummaryCardProps {
  label: string;
  value: number | string;
}

export function SummaryCard({ label, value }: SummaryCardProps) {
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 12, padding: 16, minWidth: 160 }}>
      <div style={{ fontSize: 13, color: '#666' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8 }}>{value}</div>
    </div>
  );
}
