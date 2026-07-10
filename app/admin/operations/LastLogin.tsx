'use client'

import type { LoginRecord } from '../useAdminSession'

// Account-wide "Last Login" signal shown once, at the top of every authenticated
// page (rendered inside OperationsShell's <main>). Formatted in the company's
// timezone; device is shown only when the User-Agent parsed reliably. Never shows
// an IP address.
const TZ = 'America/Chicago' // company timezone (DFW / Central); see lib/dates.ts

function fmt(at: number): { date: string; time: string } {
  const d = new Date(at)
  return {
    date: d.toLocaleDateString('en-US', { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }),
  }
}

export default function LastLogin({ record }: { record: LoginRecord | null }) {
  const base: React.CSSProperties = { fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }

  if (!record) {
    return (
      <div style={{ textAlign: 'right', marginBottom: 6 }}>
        <span style={base}><span style={{ fontWeight: 700 }}>First recorded login</span></span>
      </div>
    )
  }

  const { date, time } = fmt(record.at)
  const full = `Last login: ${date} at ${time}${record.device ? ` · ${record.device}` : ''}`
  return (
    <div style={{ textAlign: 'right', marginBottom: 6 }} title={full}>
      <span style={base}>
        <span style={{ fontWeight: 700 }}>Last login</span> · {date}, {time}
        {record.device && <span className="hidden sm:inline"> · {record.device}</span>}
      </span>
    </div>
  )
}
