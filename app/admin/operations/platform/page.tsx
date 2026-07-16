'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import OperationsShell from '../OperationsShell'
import { fmtTs } from '../ui'
import { parseRepoName } from '../../../lib/platform/automation/repo-identity'
import type {
  PlatformBusiness, PlatformUpdate, UpdateCompatibility, DeploymentRecord, UpdateStatus, CheckStatus,
} from '../../../lib/platform/updates/types'
import type { UpdateKpis, AttentionItem } from '../../../lib/platform/updates/policy'

// ── Shared style tokens (reuse the CSS vars the admin theme already defines) ──
const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 16 }
const field: React.CSSProperties = { width: '100%', padding: '8px 10px', background: 'color-mix(in srgb, var(--card) 90%, transparent)', border: '1px solid var(--line)', borderRadius: 9, color: 'var(--text)', fontSize: 13, outline: 'none' }
const btn = (kind: 'primary' | 'ghost' | 'danger' = 'ghost'): React.CSSProperties => ({
  fontSize: 12.5, fontWeight: 700, padding: '7px 13px', borderRadius: 9, cursor: 'pointer', whiteSpace: 'nowrap',
  border: '1px solid ' + (kind === 'primary' ? 'var(--red)' : kind === 'danger' ? 'rgba(224,0,42,.4)' : 'var(--line)'),
  background: kind === 'primary' ? 'var(--red)' : 'transparent',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? '#ff6680' : 'var(--text)',
})
const lab: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', marginBottom: 3 }
const SEV: Record<string, string> = { high: '#f87171', med: '#fbbf24', info: '#93c5fd' }
const CHECK_COLORS: Record<CheckStatus, string> = { passed: '#34d399', failed: '#f87171', unknown: 'var(--muted)', skipped: '#93c5fd', not_applicable: 'var(--muted)' }
const nice = (s: string) => s.replace(/_/g, ' ')

async function pf(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error ?? 'Request failed')
  return j
}

type Overview = { businesses: PlatformBusiness[]; updates: PlatformUpdate[]; deployments: DeploymentRecord[]; kpis: UpdateKpis; attention: AttentionItem[] }

export default function PlatformPage() {
  const [data, setData] = useState<Overview | null>(null)
  const [err, setErr] = useState('')
  const [denied, setDenied] = useState(false)
  const [view, setView] = useState<{ kind: 'overview' } | { kind: 'update'; key: string } | { kind: 'business'; id: string }>({ kind: 'overview' })

  const load = useCallback(async () => {
    try { setData(await pf('/api/admin/platform')) } catch (e) { const m = e instanceof Error ? e.message : 'Failed'; if (/forbidden|unauthorized/i.test(m)) setDenied(true); setErr(m) }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount load; state is set post-await
  useEffect(() => { load() }, [load])

  if (denied) return <OperationsShell><div style={{ ...card, maxWidth: 480, margin: '40px auto' }}><p style={{ fontWeight: 800 }}>Platform — owner only</p><p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>This area is restricted to the platform owner.</p></div></OperationsShell>

  return (
    <OperationsShell>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '4px 2px 90px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-.02em' }}>🚀 Operion Update Center</h1>
          {view.kind !== 'overview' && <button style={btn()} onClick={() => { setView({ kind: 'overview' }); load() }}>← Overview</button>}
          <button style={{ ...btn(), marginLeft: 'auto' }} onClick={load}>Refresh</button>
        </div>
        {err && !denied && <p style={{ color: '#f87171', fontSize: 13, marginBottom: 10 }}>{err}</p>}
        {!data && !denied && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
        {data && view.kind === 'overview' && <OverviewView data={data} onOpenUpdate={(key) => setView({ kind: 'update', key })} onOpenBusiness={(id) => setView({ kind: 'business', id })} onSeeded={load} />}
        {data && view.kind === 'update' && <UpdateDetail k={view.key} businesses={data.businesses} onChanged={load} />}
        {data && view.kind === 'business' && <BusinessDetail id={view.id} onChanged={load} />}
      </div>
    </OperationsShell>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────
function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return <div style={{ ...card, padding: 12, minWidth: 108 }}><p style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)' }}>{label}</p><p style={{ fontSize: 22, fontWeight: 900, marginTop: 2, color: tone ?? 'var(--text)' }}>{value}</p></div>
}

function OverviewView({ data, onOpenUpdate, onOpenBusiness, onSeeded }: { data: Overview; onOpenUpdate: (k: string) => void; onOpenBusiness: (id: string) => void; onSeeded: () => void }) {
  const { kpis, attention, businesses, updates } = data
  const [filter, setFilter] = useState<string>('all')
  const [showReg, setShowReg] = useState(false)
  const [busy, setBusy] = useState('')
  const seed = async () => { setBusy('seed'); try { await pf('/api/admin/platform/seed', { method: 'POST', body: '{}' }); onSeeded() } catch { /* */ } finally { setBusy('') } }
  const rows = updates.filter(u => filter === 'all' ? true : filter === 'pending' ? !['fully_deployed', 'cancelled', 'archived'].includes(u.status) : u.status === filter)

  return (
    <>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6, marginBottom: 14 }}>
        <Stat label="Pending" value={kpis.pending} tone={kpis.pending ? '#fbbf24' : undefined} />
        <Stat label="Ready · review" value={kpis.readyForReview} />
        <Stat label="Ready · release" value={kpis.readyToRelease} />
        <Stat label="Blocked" value={kpis.blocked} tone={kpis.blocked ? '#f87171' : undefined} />
        <Stat label="Failed" value={kpis.failed} tone={kpis.failed ? '#f87171' : undefined} />
        <Stat label="Deployed" value={kpis.fullyDeployed} tone="#34d399" />
        <Stat label=">14 days" value={kpis.olderThan14} tone={kpis.olderThan14 ? '#fbbf24' : undefined} />
      </div>

      {attention.length > 0 && (
        <div style={{ ...card, marginBottom: 14 }}>
          <p style={{ ...lab, marginBottom: 8 }}>Attention required</p>
          <div style={{ display: 'grid', gap: 6 }}>
            {attention.map((a, i) => (
              <button key={i} onClick={() => a.ref && (a.kind === 'deploy_failed' || a.kind === 'await_verify' ? null : onOpenUpdate(a.ref))} style={{ textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center', background: 'transparent', border: 'none', cursor: a.ref ? 'pointer' : 'default', color: 'var(--text)', padding: 0 }}>
                <span style={{ color: SEV[a.severity] }}>●</span><span style={{ fontSize: 13 }}>{a.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Businesses */}
      <div style={{ ...card, marginBottom: 14 }}>
        <p style={{ ...lab, marginBottom: 8 }}>Businesses</p>
        {businesses.length === 0 && <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><span style={{ color: 'var(--muted)', fontSize: 13 }}>No businesses yet.</span><button style={btn('primary')} disabled={busy === 'seed'} onClick={seed}>{busy === 'seed' ? 'Seeding…' : 'Seed J KISS + Supercharged + real updates'}</button></div>}
        {businesses.map(b => (
          <button key={b.id} onClick={() => onOpenBusiness(b.id)} style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--line)', background: 'transparent', border: 'none', borderTopStyle: 'solid', cursor: 'pointer', color: 'var(--text)' }}>
            <span style={{ fontWeight: 800, fontSize: 14 }}>{b.name}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{b.role} · {b.releaseChannel} · {nice(b.updatePolicy)}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{b.currentCommit ? `@${b.currentCommit}` : 'no commit'}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: b.healthStatus === 'healthy' ? '#34d399' : b.healthStatus === 'down' ? '#f87171' : 'var(--muted)' }}>{b.healthStatus}{b.updatesPaused ? ' · paused' : ''}</span>
          </button>
        ))}
      </div>

      {/* Updates */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <p style={{ ...lab, margin: 0 }}>Updates</p>
          <select value={filter} onChange={e => setFilter(e.target.value)} style={{ ...field, width: 'auto' }}>
            {['all', 'pending', 'ready_for_review', 'approved', 'blocked', 'failed', 'partially_deployed', 'fully_deployed', 'archived'].map(s => <option key={s} value={s}>{nice(s)}</option>)}
          </select>
          <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setShowReg(v => !v)}>{showReg ? 'Close' : '+ Register update'}</button>
        </div>
        {showReg && <RegisterForm businesses={businesses} onDone={() => { setShowReg(false); onSeeded() }} />}
        {rows.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>No updates.</p>}
        {rows.map(u => (
          <button key={u.key} onClick={() => onOpenUpdate(u.key)} style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '9px 0', borderTop: '1px solid var(--line)', background: 'transparent', border: 'none', borderTopStyle: 'solid', cursor: 'pointer', color: 'var(--text)' }}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)' }}>{u.key}</span>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>{u.title}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{nice(u.type)} · {nice(u.scope)}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: u.status === 'blocked' || u.status === 'failed' ? '#f87171' : u.status === 'fully_deployed' ? '#34d399' : '#fbbf24' }}>{nice(u.status)}</span>
          </button>
        ))}
      </div>
    </>
  )
}

function RegisterForm({ businesses, onDone }: { businesses: PlatformBusiness[]; onDone: () => void }) {
  const [f, setF] = useState<Record<string, unknown>>({ type: 'feature', scope: 'platform_core', severity: 'medium', priority: 'normal', sourceBusinessId: businesses[0]?.id ?? 'jkiss' })
  const [busy, setBusy] = useState(false); const [e, setE] = useState('')
  const set = (k: string, v: unknown) => setF(p => ({ ...p, [k]: v }))
  const submit = async () => { setBusy(true); setE(''); try { await pf('/api/admin/platform/updates', { method: 'POST', body: JSON.stringify(f) }); onDone() } catch (x) { setE(x instanceof Error ? x.message : 'Failed') } finally { setBusy(false) } }
  return (
    <div style={{ ...card, marginBottom: 12, background: 'color-mix(in srgb, var(--card) 70%, transparent)' }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div style={{ gridColumn: '1 / -1' }}><label style={lab}>Title *</label><input style={field} value={String(f.title ?? '')} onChange={e => set('title', e.target.value)} /></div>
        <div style={{ gridColumn: '1 / -1' }}><label style={lab}>Summary</label><input style={field} value={String(f.summary ?? '')} onChange={e => set('summary', e.target.value)} /></div>
        <div><label style={lab}>Type</label><select style={field} value={String(f.type)} onChange={e => set('type', e.target.value)}>{['feature', 'enhancement', 'bug_fix', 'security', 'performance', 'accessibility', 'design', 'infrastructure', 'migration', 'configuration', 'documentation', 'deprecation', 'emergency_hotfix'].map(x => <option key={x} value={x}>{nice(x)}</option>)}</select></div>
        <div><label style={lab}>Scope</label><select style={field} value={String(f.scope)} onChange={e => set('scope', e.target.value)}>{['platform_core', 'shared_module', 'industry_specific', 'edition_specific', 'business_specific', 'repository_specific', 'environment_specific'].map(x => <option key={x} value={x}>{nice(x)}</option>)}</select></div>
        <div><label style={lab}>Severity</label><select style={field} value={String(f.severity)} onChange={e => set('severity', e.target.value)}>{['low', 'medium', 'high', 'critical'].map(x => <option key={x} value={x}>{x}</option>)}</select></div>
        <div><label style={lab}>Priority</label><select style={field} value={String(f.priority)} onChange={e => set('priority', e.target.value)}>{['low', 'normal', 'high', 'urgent'].map(x => <option key={x} value={x}>{x}</option>)}</select></div>
        <div><label style={lab}>Source business</label><select style={field} value={String(f.sourceBusinessId)} onChange={e => set('sourceBusinessId', e.target.value)}>{businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div><label style={lab}>Module</label><input style={field} value={String(f.module ?? '')} onChange={e => set('module', e.target.value)} /></div>
        <div><label style={lab}>Source commit</label><input style={field} value={String(f.sourceCommit ?? '')} onChange={e => set('sourceCommit', e.target.value)} /></div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
          {['breakingChange', 'migrationRequired', 'featureFlagRequired', 'manualPortRequired', 'rollbackSupported'].map(k => (
            <label key={k} style={{ display: 'flex', gap: 5, alignItems: 'center', color: 'var(--muted)' }}><input type="checkbox" checked={!!f[k]} onChange={e => set(k, e.target.checked)} />{nice(k)}</label>
          ))}
        </div>
      </div>
      {e && <p style={{ color: '#f87171', fontSize: 12, marginTop: 6 }}>{e}</p>}
      <button style={{ ...btn('primary'), marginTop: 10 }} disabled={busy} onClick={submit}>{busy ? 'Registering…' : 'Register (status: discovered — not approved)'}</button>
    </div>
  )
}

// ── Update detail ────────────────────────────────────────────────────────────
function UpdateDetail({ k, businesses, onChanged }: { k: string; businesses: PlatformBusiness[]; onChanged: () => void }) {
  const [d, setD] = useState<{ update: PlatformUpdate; compat: UpdateCompatibility[]; deployments: DeploymentRecord[] } | null>(null)
  const [busy, setBusy] = useState(''); const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const [prompt, setPrompt] = useState(''); const [target, setTarget] = useState(businesses.find(b => b.role !== 'source')?.id ?? '')
  const load = useCallback(async () => { try { setD(await pf(`/api/admin/platform/updates/${k}`)) } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') } }, [k])
  useEffect(() => { load() }, [load])
  const act = async (body: Record<string, unknown>, tag: string) => { setBusy(tag); setMsg(''); setErr(''); try { const j = await pf(`/api/admin/platform/updates/${k}`, { method: 'PATCH', body: JSON.stringify(body) }); if (j.prompt) setPrompt(j.prompt); setMsg('Done.'); await load(); onChanged() } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') } finally { setBusy('') } }
  if (!d) return <p style={{ color: 'var(--muted)' }}>Loading…</p>
  const u = d.update
  const valSummary = `${Object.values(u.validation).filter(v => v === 'passed').length}/${Object.keys(u.validation).length} passed`
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── Always visible: summary + status ── */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--muted)' }}>{u.key}</span>
          <h2 style={{ fontSize: 17, fontWeight: 800 }}>{u.title}</h2>
          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 800, color: u.status === 'blocked' || u.status === 'failed' ? '#f87171' : u.status === 'fully_deployed' ? '#34d399' : '#fbbf24' }}>{nice(u.status)}</span>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 6 }}>{u.summary}</p>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, display: 'grid', gap: 2 }}>
          <span>{nice(u.type)} · {nice(u.scope)} · sev {u.severity} · prio {u.priority} · {u.module ?? 'no module'}</span>
          <span>source {u.sourceBusinessId} @ {u.sourceCommit ?? 'no commit'} · migration {u.migrationRequired ? 'yes' : 'no'} · flag {u.featureFlagRequired ? 'yes' : 'no'} · rollback {u.rollbackSupported ? 'yes' : 'no'}</span>
        </div>
        {msg && <p style={{ color: '#34d399', fontSize: 12, marginTop: 8 }}>{msg}</p>}
        {err && <p style={{ color: '#f87171', fontSize: 12, marginTop: 8 }}>{err}</p>}
      </div>

      {/* ── PRIMARY: Preview automation (target + readiness + next step + action) ── */}
      <AutomationPanel updateKey={k} businesses={businesses} inlineActions={{ update_approved: { label: 'Approve update', run: () => act({ action: 'approve' }, 'approve') } }} />

      {/* ── Progressive disclosure: everything else, collapsed ── */}
      <Section title="Update actions" hint="approve · status · archive">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={btn('primary')} disabled={busy === 'approve' || u.status === 'archived'} onClick={() => act({ action: 'approve' }, 'approve')}>Approve</button>
          <button style={btn()} disabled={busy === 'block'} onClick={() => act({ action: 'block', reason: prompt || '' }, 'block')}>Mark blocked</button>
          <select style={{ ...field, width: 'auto' }} value="" onChange={e => e.target.value && act({ action: 'set-status', status: e.target.value as UpdateStatus }, 'status')}>
            <option value="">Set status…</option>
            {['queued', 'in_progress', 'implemented', 'testing', 'ready_for_review', 'ready_to_release', 'partially_deployed', 'fully_deployed', 'failed', 'cancelled'].map(s => <option key={s} value={s}>{nice(s)}</option>)}
          </select>
          <button style={btn('danger')} disabled={busy === 'archive'} onClick={() => act({ action: 'archive' }, 'archive')}>Archive</button>
        </div>
      </Section>

      <Section title="Validation evidence" hint={valSummary}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(Object.keys(u.validation) as (keyof typeof u.validation)[]).map(check => (
            <div key={check} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{nice(check)}</span>
              <select value={u.validation[check]} onChange={e => act({ action: 'set-validation', check, value: e.target.value as CheckStatus }, `v-${check}`)} style={{ ...field, width: 'auto', padding: '4px 6px', color: CHECK_COLORS[u.validation[check]] }}>
                {(['unknown', 'passed', 'failed', 'skipped', 'not_applicable'] as CheckStatus[]).map(s => <option key={s} value={s}>{nice(s)}</option>)}
              </select>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Compatibility by business">
        {businesses.map(b => {
          const c = d.compat.find(x => x.businessId === b.id)
          return <CompatRow key={b.id} biz={b} c={c} onSave={(body) => act({ action: 'assess-compat', businessId: b.id, ...body }, `c-${b.id}`)} busy={busy === `c-${b.id}`} />
        })}
      </Section>

      <Section title="Deployment prompt" hint="copy-only — nothing runs">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select style={{ ...field, width: 'auto' }} value={target} onChange={e => setTarget(e.target.value)}>{businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <button style={btn('primary')} disabled={busy === 'gen'} onClick={() => act({ action: 'generate-prompt', targetBusinessId: target }, 'gen')}>Generate</button>
          {prompt && <button style={btn()} onClick={() => navigator.clipboard?.writeText(prompt)}>Copy</button>}
        </div>
        {prompt && <textarea readOnly value={prompt} style={{ ...field, marginTop: 8, minHeight: 220, fontFamily: 'monospace', fontSize: 11.5, whiteSpace: 'pre' }} />}
      </Section>

      <Section title="Deployments" hint={d.deployments.length === 0 ? 'none recorded' : `${d.deployments.length} recorded`}>
        {d.deployments.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>None recorded.</p>}
        {d.deployments.map(dep => (
          <div key={dep.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--line)', fontSize: 12 }}>
            <span style={{ fontFamily: 'monospace', color: 'var(--muted)' }}>{dep.id}</span>
            <span style={{ fontWeight: 700 }}>{dep.businessId}</span>
            <span style={{ color: 'var(--muted)' }}>{nice(dep.status)} · verify {nice(dep.verificationStatus)}{dep.deploymentId ? ` · ${dep.deploymentId}` : ''}</span>
            {dep.verificationStatus === 'pending' && <button style={btn('primary')} disabled={busy === `verify-${dep.id}`} onClick={() => { const w = dep.buildStatus === 'passed' && dep.healthCheckStatus === 'passed' ? undefined : prompt || window.prompt('Gates not all green — reason to waive verification:') || undefined; act({ action: 'verify-deployment', deploymentId: dep.id, waiveReason: w }, `verify-${dep.id}`) }}>Verify</button>}
          </div>
        ))}
        <RecordDeployment businesses={businesses} onSave={(body) => act({ action: 'record-deployment', ...body }, 'record')} busy={busy === 'record'} />
      </Section>
    </div>
  )
}

// ── Collapsible section (progressive disclosure) — native <details>, a11y-friendly ──
function Section({ title, hint, children, open = false }: { title: string; hint?: string; children: ReactNode; open?: boolean }) {
  return (
    <details style={{ ...card, padding: 0 }} open={open}>
      <summary style={{ listStyle: 'none', cursor: 'pointer', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>▸</span>
        <span style={{ ...lab, margin: 0 }}>{title}</span>
        {hint && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>{hint}</span>}
      </summary>
      <div style={{ padding: '0 16px 14px' }}>{children}</div>
    </details>
  )
}

// Plain-English "what to do next" for each blocking gate (falls back to the gate reason).
const GATE_NEXT: Record<string, string> = {
  automation_enabled: 'Turn on the three Preview flags (OPERION_AUTOMATION_ENABLED, OPERION_GITHUB_ACTIONS_ENABLED, OPERION_PREVIEW_AUTOMATION_ENABLED) in Vercel, then redeploy.',
  target_is_target: 'This business isn’t a deploy target — pick a target business.',
  target_configured: 'Finish this business’s setup: save the repo + Preview project, then Validate GitHub Connection until it reads “ready”.',
  preview_provider: 'Set the Preview project ID + provider in the business config (Businesses → this business).',
  update_approved: 'Approve this update (in “Update actions” below).',
  source_commit: 'This update has no source commit recorded.',
  tests_defined: 'Mark the source tests + build as passed (in “Validation evidence” below).',
  compat_assessed: 'Set this target’s compatibility (in “Compatibility” below).',
  compat_not_blocked: 'Compatibility is marked incompatible/blocked — change it or choose another update.',
  branch_allowlisted: 'The base branch isn’t allowlisted for this target.',
  target_health: 'Target health is down — set it back to healthy once verified.',
  no_conflicting_job: 'Another automation job is active for this target — finish or cancel it first.',
  migration_approved: 'This update needs explicit migration approval.',
  env_approved: 'This update changes env/flags — it needs explicit env approval.',
}

// ── Automation panel: Prepare Preview → gates → stepper → owner approval ──────
// Preview-pilot progress stepper. Each job status maps to the furthest stage reached and
// (for failures) the stage that failed.
const PILOT_STAGES = [
  { key: 'preflight', label: 'Preflight' },
  { key: 'branch', label: 'Branch' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'tests', label: 'Tests' },
  { key: 'build', label: 'Build' },
  { key: 'preview', label: 'Preview' },
  { key: 'owner_review', label: 'Owner Review' },
] as const
function pilotStage(status: string): { reached: number; failedAt: number | null } {
  switch (status) {
    case 'queued': return { reached: 0, failedAt: null }
    case 'blocked': return { reached: 0, failedAt: 0 }
    case 'creating_branch': return { reached: 1, failedAt: null }
    case 'dispatched': case 'running': case 'applying': return { reached: 2, failedAt: null }
    case 'tests_failed': return { reached: 3, failedAt: 3 }
    case 'build_failed': return { reached: 4, failedAt: 4 }
    case 'preview_deploying': return { reached: 5, failedAt: null }
    case 'preview_failed': return { reached: 5, failedAt: 5 }
    case 'preview_ready': return { reached: 6, failedAt: null }
    case 'awaiting_owner_review': case 'approved_for_production': return { reached: 6, failedAt: null }
    case 'failed': return { reached: 6, failedAt: 6 }
    case 'cancelled': return { reached: 0, failedAt: null }
    default: return { reached: 0, failedAt: null }
  }
}
type Gate = { id: string; label: string; ok: boolean; blocking: boolean; reason?: string }
function AutomationPanel({ updateKey, businesses, inlineActions }: { updateKey: string; businesses: PlatformBusiness[]; inlineActions?: Record<string, { label: string; run: () => void }> }) {
  const targets = businesses.filter(b => b.role === 'target' || b.role === 'source_and_target')
  const [target, setTarget] = useState(targets[0]?.id ?? '')
  const [busy, setBusy] = useState(false); const [checking, setChecking] = useState(false); const [err, setErr] = useState('')
  const [gates, setGates] = useState<Gate[] | null>(null); const [ready, setReady] = useState(false)
  const [job, setJob] = useState<{ id: string; status: string; currentStep: string; previewUrl?: string; pullRequestUrl?: string; pullRequestNumber?: number; workflowRunId?: string; failureSummary?: string } | null>(null)

  // Read-only readiness on mount + whenever the target changes. Never creates a job.
  const check = useCallback(async () => {
    if (!target) { setGates(null); setReady(false); return }
    setChecking(true); setErr('')
    try {
      const j = await pf('/api/admin/platform/automation', { method: 'POST', body: JSON.stringify({ updateKey, businessId: target, evaluateOnly: true }) })
      setGates(j.preflight?.gates ?? null); setReady(!!j.ok)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); setReady(false) } finally { setChecking(false) }
  }, [updateKey, target])
  useEffect(() => { check() }, [check])

  const prepare = async () => {
    setBusy(true); setErr('')
    try {
      const j = await pf('/api/admin/platform/automation', { method: 'POST', body: JSON.stringify({ updateKey, businessId: target }) })
      setGates(j.preflight?.gates ?? null); setJob(j.job ?? null); setReady(!!j.ok)
      if (!j.ok) setErr(j.error ?? 'Preview not prepared — see readiness below.')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false) }
  }
  const act = async (action: string, confirmMsg?: string) => {
    if (!job) return; if (confirmMsg && !confirm(confirmMsg)) return
    setBusy(true); setErr('')
    try { const j = await pf(`/api/admin/platform/automation/${job.id}`, { method: 'POST', body: JSON.stringify({ action }) }); if (j.job) setJob(j.job) } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false) }
  }

  const passCount = gates ? gates.filter(g => g.ok).length : 0
  const firstBlock = gates?.find(g => !g.ok && g.blocking)
  const nextStep = firstBlock ? (GATE_NEXT[firstBlock.id] ?? firstBlock.reason ?? firstBlock.label) : null
  const inline = firstBlock ? inlineActions?.[firstBlock.id] : undefined

  return (
    <div style={{ ...card, border: '1px solid rgba(129,140,248,.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <p style={{ ...lab, margin: 0, color: '#a5b4fc' }}>⚙️ Preview automation</p>
        <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 'auto' }}>Prepare Preview → Review → Approve Production (owner-gated)</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select style={{ ...field, width: 'auto' }} value={target} onChange={e => setTarget(e.target.value)}>{targets.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <button style={btn('primary')} disabled={busy || checking || !target || !ready || !!job} onClick={prepare} title={ready ? 'All checks pass' : 'Resolve the readiness checks first'}>{busy ? '…' : 'Prepare Preview'}</button>
        <button style={btn()} disabled={checking || busy} onClick={check}>{checking ? 'Checking…' : 'Re-check'}</button>
      </div>

      {/* One clear next step (or a ready confirmation) */}
      {!job && gates && (ready
        ? <p style={{ fontSize: 12.5, color: '#34d399', marginTop: 10 }}>✓ All checks pass — you can prepare a Preview.</p>
        : nextStep && (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: '#fbbf24' }}><strong>Next step:</strong> {nextStep}</span>
            {inline && <button style={btn()} disabled={busy} onClick={inline.run}>{inline.label}</button>}
          </div>
        ))}
      {err && <p style={{ color: '#f87171', fontSize: 12, marginTop: 6 }}>{err}</p>}

      {/* Full readiness list — collapsed once ready, expanded while blocked */}
      {gates && (
        <details open={!ready && !job} style={{ marginTop: 10 }}>
          <summary style={{ listStyle: 'none', cursor: 'pointer', fontSize: 11.5, color: 'var(--muted)' }}>▸ Readiness checks ({passCount}/{gates.length} pass)</summary>
          <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
            {gates.map(g => <div key={g.id} style={{ fontSize: 12, color: g.ok ? '#34d399' : g.blocking ? '#f87171' : '#fbbf24' }}>{g.ok ? '✓' : g.blocking ? '✗' : '⚠'} {g.label}{!g.ok && (GATE_NEXT[g.id] || g.reason) ? ` — ${GATE_NEXT[g.id] ?? g.reason}` : ''}</div>)}
          </div>
        </details>
      )}

      {job && (() => {
        const { reached, failedAt } = pilotStage(job.status)
        const failed = job.status.includes('fail') || job.status === 'blocked'
        const isTerminalFail = ['failed', 'build_failed', 'tests_failed', 'preview_failed', 'blocked'].includes(job.status)
        return (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          {/* Preflight → Branch → Workflow → Tests → Build → Preview → Owner Review */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
            {PILOT_STAGES.map((s, i) => {
              const isFail = failedAt === i
              const done = i < reached && failedAt == null
              const current = i === reached && !isTerminalFail
              const bg = isFail ? '#7f1d1d' : done ? 'rgba(52,211,153,.18)' : current ? 'var(--red)' : 'rgba(255,255,255,.05)'
              const col = isFail ? '#fecaca' : done ? '#34d399' : current ? '#fff' : 'var(--muted)'
              return (
                <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 6, background: bg, color: col, fontWeight: current || isFail ? 700 : 400 }}>{done ? '✓ ' : isFail ? '✗ ' : ''}{s.label}</span>
                  {i < PILOT_STAGES.length - 1 && <span style={{ color: 'var(--muted)', fontSize: 10, margin: '0 2px' }}>→</span>}
                </span>
              )
            })}
          </div>
          <p style={{ fontSize: 12 }}>Job <span style={{ fontFamily: 'monospace' }}>{job.id}</span> · <span style={{ fontWeight: 700, color: failed ? '#f87171' : job.status === 'completed' ? '#34d399' : '#fbbf24' }}>{nice(job.status)}</span>{job.failureSummary ? ` — ${job.failureSummary}` : ''}</p>
          <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap', fontSize: 12 }}>
            {job.pullRequestUrl && <a href={job.pullRequestUrl} target="_blank" rel="noreferrer" style={{ color: '#a5b4fc' }}>View PR{job.pullRequestNumber ? ` #${job.pullRequestNumber}` : ''} →</a>}
            {job.previewUrl && <a href={job.previewUrl} target="_blank" rel="noreferrer" style={{ color: '#a5b4fc' }}>View Preview →</a>}
            {job.workflowRunId && <span style={{ color: 'var(--muted)' }}>run {job.workflowRunId}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {/* Approve Production is owner-gated + also flag-gated server-side; it stays inert
                (returns "promotion disabled") while OPERION_PRODUCTION_PROMOTION_ENABLED is off. */}
            {job.status === 'awaiting_owner_review' && <button style={btn('primary')} disabled={busy} onClick={() => act('approve-production', 'Approve this verified preview for PRODUCTION? This is the owner promotion gate.')}>Approve Production</button>}
            {job.status === 'awaiting_owner_review' && <button style={btn()} disabled={busy} onClick={() => act('request-changes', 'Send this back for changes?')}>Request Changes</button>}
            {isTerminalFail && <button style={btn()} disabled={busy} onClick={() => act('retry', 'Retry this automation job from the start?')}>Retry Failed Step</button>}
            {job.status !== 'cancelled' && job.status !== 'completed' && <button style={btn()} disabled={busy} onClick={() => act('cancel', 'Cancel this automation job?')}>Cancel Automation</button>}
          </div>
        </div>
        )
      })()}
    </div>
  )
}

function CompatRow({ biz, c, onSave, busy }: { biz: PlatformBusiness; c?: UpdateCompatibility; onSave: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [status, setStatus] = useState(c?.status ?? 'unknown')
  const [reason, setReason] = useState(c?.reason ?? '')
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--line)' }}>
      <span style={{ fontWeight: 700, fontSize: 13, minWidth: 120 }}>{biz.name}</span>
      <select style={{ ...field, width: 'auto' }} value={status} onChange={e => setStatus(e.target.value as UpdateCompatibility['status'])}>{['unknown', 'under_review', 'compatible', 'compatible_with_changes', 'already_present', 'not_applicable', 'incompatible', 'blocked'].map(s => <option key={s} value={s}>{nice(s)}</option>)}</select>
      <input style={{ ...field, flex: 1, minWidth: 140 }} placeholder="reason / notes" value={reason} onChange={e => setReason(e.target.value)} />
      <button style={btn()} disabled={busy} onClick={() => onSave({ status, reason })}>Save</button>
    </div>
  )
}

function RecordDeployment({ businesses, onSave, busy }: { businesses: PlatformBusiness[]; onSave: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState<Record<string, unknown>>({ businessId: businesses.find(b => b.role !== 'source')?.id ?? businesses[0]?.id, status: 'deployed', buildStatus: 'passed', healthCheckStatus: 'passed', smokeTestStatus: 'passed' })
  const set = (k: string, v: unknown) => setF(p => ({ ...p, [k]: v }))
  if (!open) return <button style={{ ...btn(), marginTop: 10 }} onClick={() => setOpen(true)}>+ Record a deployment</button>
  return (
    <div style={{ ...card, marginTop: 10, background: 'color-mix(in srgb, var(--card) 70%, transparent)', display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))' }}>
      <div><label style={lab}>Business</label><select style={field} value={String(f.businessId)} onChange={e => set('businessId', e.target.value)}>{businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      <div><label style={lab}>Status</label><select style={field} value={String(f.status)} onChange={e => set('status', e.target.value)}>{['requested', 'in_progress', 'deployed', 'failed'].map(s => <option key={s} value={s}>{nice(s)}</option>)}</select></div>
      <div><label style={lab}>Target commit</label><input style={field} value={String(f.targetCommit ?? '')} onChange={e => set('targetCommit', e.target.value)} /></div>
      <div><label style={lab}>Deployment ID</label><input style={field} value={String(f.deploymentId ?? '')} onChange={e => set('deploymentId', e.target.value)} /></div>
      <div><label style={lab}>Build</label><select style={field} value={String(f.buildStatus)} onChange={e => set('buildStatus', e.target.value)}>{['unknown', 'passed', 'failed'].map(s => <option key={s} value={s}>{s}</option>)}</select></div>
      <div><label style={lab}>Health</label><select style={field} value={String(f.healthCheckStatus)} onChange={e => set('healthCheckStatus', e.target.value)}>{['unknown', 'passed', 'failed'].map(s => <option key={s} value={s}>{s}</option>)}</select></div>
      <div style={{ gridColumn: '1 / -1' }}><button style={btn('primary')} disabled={busy} onClick={() => { onSave(f); setOpen(false) }}>Save deployment (verify separately)</button></div>
    </div>
  )
}

// ── Business detail ──────────────────────────────────────────────────────────
function BusinessDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<{ business: PlatformBusiness; deployments: DeploymentRecord[]; pendingUpdates: PlatformUpdate[] } | null>(null)
  const [f, setF] = useState<Record<string, unknown>>({}); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
  const load = useCallback(async () => {
    const j = await pf(`/api/admin/platform/businesses/${id}`); setD(j)
    const b = j.business
    setF({
      releaseChannel: b.releaseChannel, updatePolicy: b.updatePolicy, updatesPaused: b.updatesPaused, manualApprovalRequired: b.manualApprovalRequired,
      healthStatus: b.healthStatus, currentCommit: b.currentCommit ?? '', currentVersion: b.currentVersion ?? '', repoName: b.repoName ?? '', notes: b.notes ?? '',
      // automation / preview config
      automationMode: b.automationMode ?? 'manual_prompt', healthEndpoint: b.healthEndpoint ?? '/api/health',
      previewDeploymentProvider: b.previewDeploymentProvider ?? '', previewProjectId: b.previewProjectId ?? '', previewRepoId: b.previewRepoId ?? '',
      productionProjectId: b.productionProjectId ?? '', automationWorkflowFile: b.automationWorkflowFile ?? '',
      requirePullRequest: b.requirePullRequest ?? true, requireOwnerApproval: b.requireOwnerApproval ?? true, requirePreview: b.requirePreview ?? true,
      requirePassingChecks: b.requirePassingChecks ?? true, allowAutomatedMerge: b.allowAutomatedMerge ?? false, allowProductionPromotion: b.allowProductionPromotion ?? false,
    })
  }, [id])
  useEffect(() => { load() }, [load])
  const save = async () => { if (!confirm('Save changes to this business?')) return; setBusy(true); setMsg(''); try { await pf(`/api/admin/platform/businesses/${id}`, { method: 'PATCH', body: JSON.stringify({ fields: f }) }); setMsg('Saved.'); await load(); onChanged() } catch { setMsg('Failed.') } finally { setBusy(false) } }
  const [conn, setConn] = useState<{ ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] } | null>(null)
  const [connBusy, setConnBusy] = useState(false)
  const validateConn = async () => { setConnBusy(true); setConn(null); try { const j = await pf(`/api/admin/platform/automation/validate`, { method: 'POST', body: JSON.stringify({ businessId: id }) }); setConn(j); await load() } catch (e) { setConn({ ok: false, checks: [{ name: 'Request', ok: false, detail: e instanceof Error ? e.message : 'failed' }] }) } finally { setConnBusy(false) } }
  if (!d) return <p style={{ color: 'var(--muted)' }}>Loading…</p>
  const set = (k: string, v: unknown) => setF(p => ({ ...p, [k]: v }))
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={card}>
        <h2 style={{ fontSize: 17, fontWeight: 800 }}>{d.business.name}</h2>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{d.business.repoName} · {d.business.defaultBranch} · {d.business.productionUrl}</p>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', marginTop: 12 }}>
          <div><label style={lab}>Release channel</label><select style={field} value={String(f.releaseChannel)} onChange={e => set('releaseChannel', e.target.value)}>{['internal', 'alpha', 'beta', 'stable', 'lts', 'custom'].map(s => <option key={s} value={s}>{s}</option>)}</select></div>
          <div><label style={lab}>Update policy</label><select style={field} value={String(f.updatePolicy)} onChange={e => set('updatePolicy', e.target.value)}>{['manual', 'owner_approval', 'scheduled_manual', 'security_only', 'pinned', 'paused'].map(s => <option key={s} value={s}>{nice(s)}</option>)}</select></div>
          <div><label style={lab}>Health</label><select style={field} value={String(f.healthStatus)} onChange={e => set('healthStatus', e.target.value)}>{['unknown', 'healthy', 'degraded', 'down'].map(s => <option key={s} value={s}>{s}</option>)}</select></div>
          <div><label style={lab}>Current commit</label><input style={field} value={String(f.currentCommit)} onChange={e => set('currentCommit', e.target.value)} /></div>
          <div><label style={lab}>Current version</label><input style={field} value={String(f.currentVersion)} onChange={e => set('currentVersion', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lab}>Repository (owner/name)</label>
            <input style={field} placeholder="ratchetnu/supercharged" value={String(f.repoName)} onChange={e => set('repoName', e.target.value)} />
            {(() => {
              const raw = String(f.repoName ?? '').trim()
              if (!raw) return <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>Format: <code>owner/name</code> — a GitHub URL is accepted and normalized.</p>
              const ref = parseRepoName(raw)
              return ref
                ? <p style={{ fontSize: 11, color: '#34d399', marginTop: 3 }}>✓ {ref.owner}/{ref.name}</p>
                : <p style={{ fontSize: 11, color: '#f87171', marginTop: 3 }}>✗ needs owner/name (e.g. ratchetnu/supercharged) — a bare name, URL, or path is rejected on save.</p>
            })()}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 12 }}>
          <label style={{ display: 'flex', gap: 5, alignItems: 'center', color: 'var(--muted)' }}><input type="checkbox" checked={!!f.updatesPaused} onChange={e => set('updatesPaused', e.target.checked)} />Updates paused</label>
          <label style={{ display: 'flex', gap: 5, alignItems: 'center', color: 'var(--muted)' }}><input type="checkbox" checked={!!f.manualApprovalRequired} onChange={e => set('manualApprovalRequired', e.target.checked)} />Manual approval required</label>
        </div>
        <div><label style={{ ...lab, marginTop: 10 }}>Notes</label><input style={field} value={String(f.notes)} onChange={e => set('notes', e.target.value)} /></div>

        {/* ── Automation / Preview configuration (for automated Preview pilots) ── */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          <p style={{ ...lab, color: '#a5b4fc', marginBottom: 8 }}>⚙️ Automation / Preview config</p>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
            <div><label style={lab}>Automation mode</label><select style={field} value={String(f.automationMode)} onChange={e => set('automationMode', e.target.value)}>{['manual_prompt', 'automated_preparation', 'automated_preview', 'approved_production', 'fully_manual'].map(s => <option key={s} value={s}>{nice(s)}</option>)}</select></div>
            <div><label style={lab}>Health endpoint</label><input style={field} placeholder="/api/health" value={String(f.healthEndpoint)} onChange={e => set('healthEndpoint', e.target.value)} /></div>
            <div><label style={lab}>Workflow file</label><input style={field} placeholder="operion-update.yml" value={String(f.automationWorkflowFile)} onChange={e => set('automationWorkflowFile', e.target.value)} /></div>
            <div><label style={lab}>Preview provider</label><input style={field} placeholder="vercel" value={String(f.previewDeploymentProvider)} onChange={e => set('previewDeploymentProvider', e.target.value)} /></div>
            <div><label style={lab}>Preview project ID</label><input style={field} placeholder="prj_…" value={String(f.previewProjectId)} onChange={e => set('previewProjectId', e.target.value)} /></div>
            <div><label style={lab}>Preview repo ID (numeric)</label><input style={field} placeholder="1295706037" value={String(f.previewRepoId)} onChange={e => set('previewRepoId', e.target.value)} /></div>
            <div><label style={lab}>Production project ID</label><input style={field} placeholder="(optional)" value={String(f.productionProjectId)} onChange={e => set('productionProjectId', e.target.value)} /></div>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 12, flexWrap: 'wrap' }}>
            {([['requirePullRequest', 'Require PR'], ['requireOwnerApproval', 'Require owner approval'], ['requirePreview', 'Require preview'], ['requirePassingChecks', 'Require passing checks'], ['allowAutomatedMerge', 'Allow automated merge'], ['allowProductionPromotion', 'Allow production promotion']] as const).map(([k, label]) => (
              <label key={k} style={{ display: 'flex', gap: 5, alignItems: 'center', color: k === 'allowProductionPromotion' || k === 'allowAutomatedMerge' ? '#fbbf24' : 'var(--muted)' }}><input type="checkbox" checked={!!f[k]} onChange={e => set(k, e.target.checked)} />{label}</label>
            ))}
          </div>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Fill Preview project + repo ID, then re-run Validate to reach <strong>ready</strong>. Keep automated-merge + production-promotion OFF for a Preview pilot.</p>
        </div>

        <button style={{ ...btn('primary'), marginTop: 10 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save (confirmed + audited)'}</button>
        {msg && <span style={{ marginLeft: 10, fontSize: 12, color: '#34d399' }}>{msg}</span>}
      </div>
      <div style={{ ...card, border: '1px solid rgba(129,140,248,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <p style={{ ...lab, margin: 0, color: '#a5b4fc' }}>🔌 GitHub connection {d.business.configurationStatus ? `· ${nice(d.business.configurationStatus)}` : ''}</p>
          <button style={{ ...btn(), marginLeft: 'auto' }} disabled={connBusy} onClick={validateConn}>{connBusy ? 'Validating…' : 'Validate GitHub Connection'}</button>
        </div>
        {conn && (
          <div style={{ marginTop: 8, display: 'grid', gap: 3 }}>
            {conn.checks.map((c, i) => <div key={i} style={{ fontSize: 12, color: c.ok ? '#34d399' : '#f87171' }}>{c.ok ? '✓' : '✗'} {c.name}{c.detail ? ` — ${c.detail}` : ''}</div>)}
            <p style={{ fontSize: 11, marginTop: 4, color: 'var(--muted)' }}>Read-only — no repository was modified. Write actions stay disabled until the automation flags are on.</p>
          </div>
        )}
      </div>
      <div style={card}>
        <p style={{ ...lab, marginBottom: 8 }}>Pending updates for {d.business.name} ({d.pendingUpdates.length})</p>
        {d.pendingUpdates.map(u => <div key={u.key} style={{ fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--line)' }}><span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)' }}>{u.key}</span> {u.title} <span style={{ color: '#fbbf24', fontSize: 11 }}>{nice(u.status)}</span></div>)}
      </div>
      <div style={card}>
        <p style={{ ...lab, marginBottom: 8 }}>Deployment history</p>
        {d.deployments.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>None.</p>}
        {d.deployments.map(dep => <div key={dep.id} style={{ fontSize: 12, padding: '4px 0', borderTop: '1px solid var(--line)', color: 'var(--muted)' }}>{dep.id} · {nice(dep.status)} · verify {nice(dep.verificationStatus)} · {fmtTs(dep.createdAt)}</div>)}
      </div>
    </div>
  )
}
