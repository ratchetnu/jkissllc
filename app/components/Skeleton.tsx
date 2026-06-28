// Lightweight loading skeletons (CSS shimmer defined in globals.css).

export function SkeletonLine({ w = '100%', h = 12 }: { w?: string | number; h?: number }) {
  return <div className="skeleton" style={{ width: w, height: h }} aria-hidden="true" />
}

export function SkeletonCard() {
  return (
    <div className="glass-card p-4" style={{ borderRadius: 14 }} aria-hidden="true">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <SkeletonLine w="42%" h={15} />
        <SkeletonLine w={64} h={18} />
      </div>
      <SkeletonLine w="68%" h={11} />
    </div>
  )
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  )
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="glass-card p-5" style={{ borderRadius: 16 }} aria-hidden="true">
          <SkeletonLine w="50%" h={10} />
          <div style={{ height: 10 }} />
          <SkeletonLine w="70%" h={26} />
        </div>
      ))}
    </div>
  )
}
