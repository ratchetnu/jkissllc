'use client'

// Catches errors thrown in the root layout itself. Must render its own <html>/<body>.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: '#0b0b0c', color: '#f3f4f6', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', margin: 0 }}>
        <main style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
          <div style={{ maxWidth: 420 }}>
            <h1 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 8px' }}>Something went wrong</h1>
            <p style={{ color: '#b5b7bd', fontSize: 14, lineHeight: 1.6 }}>
              {error?.digest ? `Reference: ${error.digest}. ` : ''}Please try again.
            </p>
            <button onClick={reset} style={{ marginTop: 20, background: '#E0002A', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 24px', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>
              Try Again
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
