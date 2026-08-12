// Lightweight skeleton primitives. Rendered while a query is pending so
// pages feel responsive instead of flashing a generic spinner. Use the
// page-shaped variants below to match the eventual layout — keeps CLS low.

export function SkeletonLine({
  className = '',
  width = 'w-full',
}: { className?: string; width?: string }) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={`h-3 animate-pulse rounded bg-slate-200 ${width} ${className}`}
    />
  );
}

export function LeadsTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="kf-card p-4" data-testid="leads-skeleton">
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-3">
            <SkeletonLine className="col-span-3" />
            <SkeletonLine className="col-span-2" />
            <SkeletonLine className="col-span-2" />
            <SkeletonLine className="col-span-1" />
            <SkeletonLine className="col-span-2" />
            <SkeletonLine className="col-span-2" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function LeadDetailSkeleton() {
  return (
    <div className="space-y-4" data-testid="lead-detail-skeleton">
      <div className="kf-card p-4 space-y-3">
        <SkeletonLine width="w-60" className="h-5" />
        <div className="flex gap-2">
          <SkeletonLine width="w-16" className="h-5 rounded-full" />
          <SkeletonLine width="w-16" className="h-5 rounded-full" />
          <SkeletonLine width="w-20" className="h-5 rounded-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="kf-card p-4 space-y-3 lg:col-span-2">
          <SkeletonLine width="w-32" className="h-4" />
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonLine key={i} className="h-12 rounded-xl" />
          ))}
        </div>
        <div className="kf-card p-4 space-y-3">
          <SkeletonLine width="w-32" className="h-4" />
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonLine key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="kf-card p-4 space-y-2">
            <SkeletonLine width="w-20" className="h-3" />
            <SkeletonLine width="w-14" className="h-6" />
          </div>
        ))}
      </div>
      <div className="kf-card p-4 space-y-3">
        <SkeletonLine width="w-40" className="h-4" />
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonLine key={i} />
        ))}
      </div>
    </div>
  );
}
