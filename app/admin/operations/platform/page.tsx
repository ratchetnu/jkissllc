'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import OperationsShell from '../OperationsShell'
import { fmtTs } from '../ui'
import { parseRepoName } from '../../../lib/platform/automation/repo-identity'
import { businessReadiness, businessNextStep, groupUpdates, BUCKET_ORDER } from '../../../lib/platform/updates/business-view'
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
        {data && view.kind === 'business' && <BusinessDetail id={view.id} onChanged={load} onOpenUpdate={(key) => setView({ kind: 'update', key })} />}
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
  const [job, setJob] = useState<{ id: string; status: string; currentStep: string; previewUrl?: string; previewDeploymentId?: string; pullRequestUrl?: string; pullRequestNumber?: number; workflowRunId?: string; targetCommit?: string; failureSummary?: string; result?: { filesApplied?: number; filesSkipped?: number; filesFailed?: number } } | null>(null)

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
  // Live-poll a running job so the stepper advances when the CI callback lands (the workflow
  // reports once at the end, so this flips creating_branch → its final state without a refresh).
  const TERMINAL_STATUSES = ['awaiting_owner_review', 'approved_for_production', 'completed', 'failed', 'build_failed', 'tests_failed', 'preview_failed', 'blocked', 'cancelled', 'rolled_back']
  const jobId = job?.id; const jobStatus = job?.status
  useEffect(() => {
    if (!jobId || !jobStatus || TERMINAL_STATUSES.includes(jobStatus)) return
    const t = setInterval(async () => { try { const r = await pf(`/api/admin/platform/automation/${jobId}`); if (r.job) setJob(r.job) } catch { /* keep polling */ } }, 8000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobStatus])

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
        {(() => {
          const canPrepare = !busy && !checking && !!target && ready && !job
          return <button style={{ ...btn('primary'), ...(canPrepare ? {} : { opacity: 0.45, cursor: 'not-allowed' }) }} disabled={!canPrepare} onClick={prepare} title={ready ? 'All checks pass' : 'Prepare Preview is disabled until every readiness check passes'}>{busy ? '…' : 'Prepare Preview'}</button>
        })()}
        <button style={{ ...btn(), ...(checking || busy ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }} disabled={checking || busy} onClick={check}>{checking ? 'Checking…' : 'Re-check'}</button>
      </div>

      {/* One clear next step (or a ready confirmation) — always tells the owner why it's gated */}
      {!job && (
        checking ? <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>Checking readiness…</p>
        : !gates ? <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>Click <strong>Re-check</strong> to evaluate readiness for this target.</p>
        : ready ? <p style={{ fontSize: 12.5, color: '#34d399', marginTop: 10 }}>✓ All checks pass — Prepare Preview is enabled.</p>
        : (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: '#fbbf24' }}>⚠ <strong>Prepare Preview is disabled — next step:</strong> {nextStep ?? 'resolve the failing readiness checks below'}</span>
            {inline && <button style={btn()} disabled={busy} onClick={inline.run}>{inline.label}</button>}
          </div>
        )
      )}
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
          {job.result && (job.result.filesApplied != null || job.result.filesFailed != null) && (
            <p style={{ fontSize: 12, marginTop: 2, color: 'var(--muted)' }}>Transfer: <span style={{ color: '#34d399' }}>{job.result.filesApplied ?? 0} applied</span>{job.result.filesSkipped ? ` · ${job.result.filesSkipped} skipped` : ''}{job.result.filesFailed ? <span style={{ color: '#f87171' }}> · {job.result.filesFailed} failed</span> : ''}</p>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap', fontSize: 12 }}>
            {job.targetCommit && <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>{job.targetCommit.slice(0, 7)}</span>}
            {job.pullRequestUrl && <a href={job.pullRequestUrl} target="_blank" rel="noreferrer" style={{ color: '#a5b4fc' }}>View PR{job.pullRequestNumber ? ` #${job.pullRequestNumber}` : ''} →</a>}
            {job.previewUrl && <a href={job.previewUrl} target="_blank" rel="noreferrer" style={{ color: '#a5b4fc' }}>View Preview →</a>}
            {job.previewDeploymentId && <span style={{ color: 'var(--muted)' }}>{job.previewDeploymentId}</span>}
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
// ── Small presentational helpers (Operion design tokens) ─────────────────────
const TONE = {
  green: { fg: '#34d399', bg: 'rgba(52,211,153,.12)' },
  amber: { fg: '#fbbf24', bg: 'rgba(251,191,36,.12)' },
  red: { fg: '#f87171', bg: 'rgba(248,113,113,.12)' },
  blue: { fg: '#a5b4fc', bg: 'rgba(129,140,248,.12)' },
  gray: { fg: 'var(--muted)', bg: 'rgba(255,255,255,.05)' },
} as const
function Badge({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) {
  const t = TONE[tone]
  return <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: t.fg, background: t.bg, whiteSpace: 'nowrap' }}>{children}</span>
}
function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', borderTop: '1px solid var(--line)', fontSize: 12.5 }}><span style={{ color: 'var(--muted)' }}>{label}</span><span style={{ fontWeight: 600, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span></div>
}
function ReadinessCard({ title, tone, status, sub, onClick }: { title: string; tone: keyof typeof TONE; status: string; sub: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`${title}: ${status}. ${sub}`} style={{ ...card, padding: 12, textAlign: 'left', cursor: onClick ? 'pointer' : 'default', display: 'grid', gap: 5, alignContent: 'start' }}>
      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)' }}>{title}</span>
      <span><Badge tone={tone}>{status}</Badge></span>
      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</span>
    </button>
  )
}
const secHead = { ...lab, marginBottom: 8 } as const

type OperionFlags = { automation: boolean; githubActions: boolean; preview: boolean; productionPromotion: boolean; aiAdaptation: boolean; automaticRollback: boolean }
function BusinessDetail({ id, onChanged, onOpenUpdate }: { id: string; onChanged: () => void; onOpenUpdate: (key: string) => void }) {
  const [d, setD] = useState<{ business: PlatformBusiness; deployments: DeploymentRecord[]; pendingUpdates: PlatformUpdate[]; operionFlags?: OperionFlags } | null>(null)
  const [f, setF] = useState<Record<string, unknown>>({}); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
  const [editBiz, setEditBiz] = useState(false); const [editAuto, setEditAuto] = useState(false); const [showHistory, setShowHistory] = useState(false)
  const load = useCallback(async () => {
    const j = await pf(`/api/admin/platform/businesses/${id}`); setD(j)
    const b = j.business
    setF({
      releaseChannel: b.releaseChannel, updatePolicy: b.updatePolicy, updatesPaused: b.updatesPaused, manualApprovalRequired: b.manualApprovalRequired,
      healthStatus: b.healthStatus, currentCommit: b.currentCommit ?? '', currentVersion: b.currentVersion ?? '', repoName: b.repoName ?? '', notes: b.notes ?? '',
      automationMode: b.automationMode ?? 'manual_prompt', healthEndpoint: b.healthEndpoint ?? '/api/health',
      previewDeploymentProvider: b.previewDeploymentProvider ?? '', previewProjectId: b.previewProjectId ?? '', previewRepoId: b.previewRepoId ?? '',
      productionProjectId: b.productionProjectId ?? '', automationWorkflowFile: b.automationWorkflowFile ?? '',
      requirePullRequest: b.requirePullRequest ?? true, requireOwnerApproval: b.requireOwnerApproval ?? true, requirePreview: b.requirePreview ?? true,
      requirePassingChecks: b.requirePassingChecks ?? true, allowAutomatedMerge: b.allowAutomatedMerge ?? false, allowProductionPromotion: b.allowProductionPromotion ?? false,
    })
  }, [id])
  useEffect(() => { load() }, [load])
  // Save persists ALL fields (same PATCH contract + confirm + read-back + audit). Returns success.
  const save = async (): Promise<boolean> => {
    if (!confirm('Save changes to this business?')) return false
    setBusy(true); setMsg('')
    try { await pf(`/api/admin/platform/businesses/${id}`, { method: 'PATCH', body: JSON.stringify({ fields: f }) }); setMsg('Saved.'); await load(); onChanged(); return true }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed.'); return false }
    finally { setBusy(false) }
  }
  const cancelEdit = async () => { if (!confirm('Discard unsaved changes?')) return; await load(); setEditBiz(false); setEditAuto(false); setMsg('') }
  const [conn, setConn] = useState<{ ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] } | null>(null)
  const [connBusy, setConnBusy] = useState(false)
  const validateConn = async () => { setConnBusy(true); setConn(null); try { const j = await pf(`/api/admin/platform/automation/validate`, { method: 'POST', body: JSON.stringify({ businessId: id }) }); setConn(j); await load() } catch (e) { setConn({ ok: false, checks: [{ name: 'Request', ok: false, detail: e instanceof Error ? e.message : 'failed' }] }) } finally { setConnBusy(false) } }
  if (!d) return <p style={{ color: 'var(--muted)' }}>Loading…</p>
  const b = d.business
  const set = (k: string, v: unknown) => setF(p => ({ ...p, [k]: v }))
  const scrollTo = (secId: string) => { if (typeof document !== 'undefined') document.getElementById(secId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }

  // ── Derived readiness (pure view model; reads existing model + config status) ──
  const { repo, githubReady, configurationStatus: cfg, previewReady, productionProtected: protectedProd, missing } = businessReadiness(b)
  const previewTone: keyof typeof TONE = previewReady ? 'green' : cfg === 'error' ? 'red' : 'amber'
  const previewStatus = previewReady ? 'Ready' : cfg === 'error' ? 'Error' : cfg === 'incomplete' ? 'Needs review' : 'Needs setup'
  const pending = d.pendingUpdates

  // ── Next step (pure) + the UI action wired to its key ──
  const ns = businessNextStep(b, pending.length)
  const nextAction = ns.key === 'connect' ? { label: 'Validate GitHub Connection', run: validateConn }
    : ns.key === 'configure' ? { label: 'Edit Automation Settings', run: () => { setEditAuto(true); scrollTo('sec-automation') } }
      : ns.key === 'prepare' ? { label: 'View pending updates', run: () => scrollTo('sec-updates') } : undefined
  const next = { ...ns, action: nextAction }

  // ── Pending-update grouping (pure) ──
  const groupOrder = BUCKET_ORDER
  const groups = groupUpdates(pending)

  // ── Resolved automation-flag state (booleans only; plain-English in the UI) ──
  const flags = d.operionFlags
  const previewAutomationOn = !!flags && flags.automation && flags.githubActions && flags.preview

  // Inline field renderers for the editors (closures over f/set).
  const Txt = (k: string, label: string, ph?: string) => <div><label style={lab}>{label}</label><input style={field} placeholder={ph} value={String(f[k] ?? '')} onChange={e => set(k, e.target.value)} /></div>
  const Sel = (k: string, label: string, opts: string[]) => <div><label style={lab}>{label}</label><select style={field} value={String(f[k])} onChange={e => set(k, e.target.value)}>{opts.map(o => <option key={o} value={o}>{nice(o)}</option>)}</select></div>
  const Chk = (k: string, label: string, warn?: boolean) => <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: warn ? '#fbbf24' : 'var(--muted)', fontSize: 12.5 }}><input type="checkbox" checked={!!f[k]} onChange={e => set(k, e.target.checked)} />{label}</label>
  const grid = { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' } as const

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── 1. Business header (compact, read-only) ── */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 17, fontWeight: 800 }}>{b.name}</h2>
          <Badge tone={b.role === 'source_and_target' ? 'blue' : 'gray'}>{nice(b.role)}</Badge>
          <button style={{ ...btn(), marginLeft: 'auto' }} onClick={() => { setEditBiz(v => !v); scrollTo('sec-settings') }}>{editBiz ? 'Close' : 'Edit Business'}</button>
        </div>
        <div style={{ marginTop: 10 }}>
          <MetaRow label="Repository" value={repo ? `${repo.owner}/${repo.name}` : <span style={{ color: '#f87171' }}>not set</span>} />
          <MetaRow label="Production URL" value={b.productionUrl ? <a href={b.productionUrl} target="_blank" rel="noreferrer" style={{ color: '#a5b4fc' }}>{b.productionUrl}</a> : '—'} />
          <MetaRow label="Release channel" value={nice(b.releaseChannel)} />
          <MetaRow label="Health" value={<Badge tone={b.healthStatus === 'healthy' ? 'green' : b.healthStatus === 'down' ? 'red' : b.healthStatus === 'degraded' ? 'amber' : 'gray'}>{nice(b.healthStatus)}</Badge>} />
          <MetaRow label="Automation mode" value={nice(b.automationMode ?? 'manual_prompt')} />
          <MetaRow label="Current version" value={b.currentVersion || '—'} />
          <MetaRow label="Current commit" value={b.currentCommit ? <span style={{ fontFamily: 'monospace' }}>{b.currentCommit}</span> : '—'} />
        </div>
      </div>

      {/* ── 2. Next step ── */}
      <div style={{ ...card, border: '1px solid rgba(129,140,248,.35)' }}>
        <p style={{ ...lab, margin: 0, color: '#a5b4fc' }}>Next step</p>
        <p style={{ fontSize: 15, fontWeight: 800, marginTop: 6 }}>{next.title}</p>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>{next.detail}</p>
        {next.action && <button style={{ ...btn('primary'), marginTop: 10 }} disabled={connBusy || busy} onClick={next.action.run}>{next.action.label}</button>}
      </div>

      {/* ── 3. Readiness summary (4 cards; stack on mobile) ── */}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))' }}>
        <ReadinessCard title="GitHub Connection" tone={githubReady ? 'green' : 'amber'} status={githubReady ? 'Ready' : 'Needs setup'} sub={githubReady ? 'Repository verified' : 'Validate to connect'} onClick={() => scrollTo('sec-github')} />
        <ReadinessCard title="Preview Automation" tone={previewTone} status={previewStatus} sub={previewReady ? 'Configuration ready' : missing[0] ? `Missing: ${missing[0]}` : 'Configure preview'} onClick={() => scrollTo('sec-automation')} />
        <ReadinessCard title="Production Protection" tone={protectedProd ? 'green' : 'amber'} status={protectedProd ? 'Protected' : 'Promotion enabled'} sub={protectedProd ? 'Promotion disabled' : 'Owner promotion allowed'} onClick={() => scrollTo('sec-automation')} />
        <ReadinessCard title="Pending Updates" tone={pending.length ? 'blue' : 'gray'} status={String(pending.length)} sub={pending.length ? `${groups['Ready for Preview'].length} ready for preview` : 'Nothing pending'} onClick={() => scrollTo('sec-updates')} />
      </div>

      {/* ── Automation status (plain-English flag state; raw names in diagnostics) ── */}
      {flags && (
        <div style={card}>
          <p style={secHead}>Automation status</p>
          <MetaRow label="Preview Automation" value={<Badge tone={previewAutomationOn ? 'green' : 'gray'}>{previewAutomationOn ? 'Enabled' : 'Disabled'}</Badge>} />
          <MetaRow label="Production Promotion" value={<Badge tone={flags.productionPromotion ? 'amber' : 'green'}>{flags.productionPromotion ? 'Enabled' : 'Disabled'}</Badge>} />
          <MetaRow label="AI Adaptation" value={<Badge tone={flags.aiAdaptation ? 'amber' : 'green'}>{flags.aiAdaptation ? 'Enabled' : 'Disabled'}</Badge>} />
          <MetaRow label="Automatic Rollback" value={<Badge tone={flags.automaticRollback ? 'amber' : 'green'}>{flags.automaticRollback ? 'Enabled' : 'Disabled'}</Badge>} />
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 11.5, color: 'var(--muted)' }}>▸ Diagnostics (environment flags)</summary>
            <div style={{ marginTop: 4, display: 'grid', gap: 2, fontFamily: 'monospace', fontSize: 11 }}>
              {([['OPERION_AUTOMATION_ENABLED', flags.automation], ['OPERION_GITHUB_ACTIONS_ENABLED', flags.githubActions], ['OPERION_PREVIEW_AUTOMATION_ENABLED', flags.preview], ['OPERION_PRODUCTION_PROMOTION_ENABLED', flags.productionPromotion], ['OPERION_AI_ADAPTATION_ENABLED', flags.aiAdaptation], ['OPERION_AUTOMATIC_ROLLBACK_ENABLED', flags.automaticRollback]] as const).map(([n, on]) => (
                <div key={n} style={{ color: on ? '#34d399' : 'var(--muted)' }}>{on ? '✓' : '·'} {n}={String(on)}</div>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* ── 4. Primary actions ── */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={btn('primary')} disabled={connBusy} onClick={validateConn}>{connBusy ? 'Validating…' : 'Validate GitHub Connection'}</button>
          <button style={btn()} onClick={() => { setEditAuto(true); scrollTo('sec-automation') }}>Edit Automation Settings</button>
          <button style={btn()} onClick={() => { setEditBiz(true); scrollTo('sec-settings') }}>Edit Business</button>
        </div>
        {!previewReady && <p style={{ fontSize: 12, color: '#fbbf24', marginTop: 8 }}>Prepare Preview runs per-update once this business is <strong>ready</strong>{missing.length ? ` — resolve: ${missing.join(', ')}` : ''}. Open a pending update to prepare its preview.</p>}
        {msg && <p style={{ marginTop: 8, fontSize: 12, color: msg === 'Saved.' ? '#34d399' : '#f87171' }}>{msg}</p>}
      </div>

      {/* ── 5. GitHub connection card (simplified) ── */}
      <div id="sec-github" style={{ ...card, border: '1px solid rgba(129,140,248,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <p style={{ ...lab, margin: 0, color: '#a5b4fc' }}>🔌 GitHub Connection</p>
          <Badge tone={githubReady ? 'green' : 'amber'}>{githubReady ? 'Ready' : nice(cfg)}</Badge>
          <button style={{ ...btn(), marginLeft: 'auto' }} disabled={connBusy} onClick={validateConn}>{connBusy ? 'Validating…' : 'Validate Again'}</button>
        </div>
        <div style={{ marginTop: 8 }}>
          <MetaRow label="Repository" value={repo ? `${repo.owner}/${repo.name}` : 'not set'} />
          <MetaRow label="Installation" value={b.githubInstallationId ? <Badge tone="green">Connected</Badge> : <Badge tone="amber">Not connected</Badge>} />
          <MetaRow label="Default branch" value={b.defaultBranch || '—'} />
          <MetaRow label="Last validated" value={b.lastVerificationAt ? fmtTs(b.lastVerificationAt) : 'never'} />
        </div>
        {conn && !conn.ok && (
          <div style={{ marginTop: 8 }}>
            <p style={{ fontSize: 12.5, color: '#f87171' }}>{conn.checks.find(c => !c.ok)?.name}{conn.checks.find(c => !c.ok)?.detail ? ` — ${conn.checks.find(c => !c.ok)?.detail}` : ''}</p>
            <button style={{ ...btn(), marginTop: 6 }} onClick={() => { setEditAuto(true); scrollTo('sec-automation') }}>Edit Configuration</button>
            <details style={{ marginTop: 6 }}><summary style={{ cursor: 'pointer', fontSize: 11.5, color: 'var(--muted)' }}>▸ Raw check details</summary><div style={{ marginTop: 4, display: 'grid', gap: 2 }}>{conn.checks.map((c, i) => <div key={i} style={{ fontSize: 12, color: c.ok ? '#34d399' : '#f87171' }}>{c.ok ? '✓' : '✗'} {c.name}{c.detail ? ` — ${c.detail}` : ''}</div>)}</div></details>
          </div>
        )}
        {conn && conn.ok && <p style={{ marginTop: 8, fontSize: 12, color: '#34d399' }}>✓ All checks passed — read-only, no repository was modified.</p>}
      </div>

      {/* ── 6. Automation / Preview config — summary + editor drawer ── */}
      <div id="sec-automation" style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <p style={{ ...secHead, margin: 0 }}>⚙️ Automation / Preview</p>
          <Badge tone={previewTone}>{previewStatus}</Badge>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            <button style={btn()} disabled={connBusy} onClick={validateConn}>{connBusy ? 'Validating…' : 'Validate Configuration'}</button>
            <button style={btn('primary')} onClick={() => setEditAuto(v => !v)}>{editAuto ? 'Close' : 'Edit Automation Settings'}</button>
          </div>
        </div>
        {!editAuto && (
          <div style={{ marginTop: 8 }}>
            <MetaRow label="Automation mode" value={nice(b.automationMode ?? 'manual_prompt')} />
            <MetaRow label="GitHub" value={b.githubInstallationId ? <Badge tone="green">Connected</Badge> : <Badge tone="amber">Not connected</Badge>} />
            <MetaRow label="Workflow" value={b.automationWorkflowFile || '—'} />
            <MetaRow label="Preview provider" value={b.previewDeploymentProvider || '—'} />
            <MetaRow label="Preview project" value={b.previewProjectId ? <Badge tone="green">Configured</Badge> : <Badge tone="amber">Not set</Badge>} />
            <MetaRow label="Production promotion" value={b.allowProductionPromotion ? <Badge tone="amber">Enabled</Badge> : <Badge tone="green">Disabled</Badge>} />
            <MetaRow label="Automated merge" value={b.allowAutomatedMerge ? <Badge tone="amber">Enabled</Badge> : <Badge tone="green">Disabled</Badge>} />
          </div>
        )}
        {editAuto && (
          <div style={{ marginTop: 10, display: 'grid', gap: 14 }}>
            <div><p style={{ ...lab, marginBottom: 6 }}>A · Execution</p><div style={grid}>{Sel('automationMode', 'Automation mode', ['manual_prompt', 'automated_preparation', 'automated_preview', 'approved_production', 'fully_manual'])}{Txt('automationWorkflowFile', 'Workflow file', 'operion-update.yml')}{Txt('healthEndpoint', 'Health endpoint', '/api/health')}</div></div>
            <div><p style={{ ...lab, marginBottom: 6 }}>B · Preview provider</p><div style={grid}>{Txt('previewDeploymentProvider', 'Provider', 'vercel')}{Txt('previewProjectId', 'Preview project ID', 'prj_…')}{Txt('previewRepoId', 'Preview repo ID (numeric)', '1295706037')}{Txt('productionProjectId', 'Production project ID', '(optional)')}</div></div>
            <div><p style={{ ...lab, marginBottom: 6 }}>C · Required gates</p><div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>{Chk('requirePullRequest', 'Require PR')}{Chk('requireOwnerApproval', 'Require owner approval')}{Chk('requirePreview', 'Require preview')}{Chk('requirePassingChecks', 'Require passing checks')}</div></div>
            <div style={{ border: '1px solid rgba(251,191,36,.4)', borderRadius: 10, padding: 12, background: 'rgba(251,191,36,.06)' }}>
              <p style={{ ...lab, marginBottom: 6, color: '#fbbf24' }}>D · Production controls</p>
              <p style={{ fontSize: 11.5, color: '#fbbf24', marginBottom: 8 }}>⚠️ These let automation merge and promote to production. Keep both OFF for Preview-only pilots. Production promotion is additionally gated by the owner flag server-side.</p>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>{Chk('allowAutomatedMerge', 'Allow automated merge', true)}{Chk('allowProductionPromotion', 'Allow production promotion', true)}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={btn('primary')} disabled={busy} onClick={async () => { if (await save()) setEditAuto(false) }}>{busy ? 'Saving…' : 'Save (confirmed + audited)'}</button>
              <button style={btn()} disabled={busy} onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Business settings editor (read-only by default; drawer on Edit) ── */}
      <div id="sec-settings" style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <p style={{ ...secHead, margin: 0 }}>Business settings</p>
          <button style={{ ...btn(), marginLeft: 'auto' }} onClick={() => setEditBiz(v => !v)}>{editBiz ? 'Close' : 'Edit Business'}</button>
        </div>
        {!editBiz && (
          <div style={{ marginTop: 8 }}>
            <MetaRow label="Release channel" value={nice(b.releaseChannel)} />
            <MetaRow label="Update policy" value={nice(b.updatePolicy)} />
            <MetaRow label="Repository" value={b.repoName || '—'} />
            <MetaRow label="Health" value={nice(b.healthStatus)} />
            <MetaRow label="Version / commit" value={`${b.currentVersion || '—'} · ${b.currentCommit || '—'}`} />
            <MetaRow label="Updates paused" value={b.updatesPaused ? 'Yes' : 'No'} />
            <MetaRow label="Manual approval" value={b.manualApprovalRequired ? 'Required' : 'No'} />
            <MetaRow label="Notes" value={b.notes || '—'} />
          </div>
        )}
        {editBiz && (
          <div style={{ marginTop: 10, display: 'grid', gap: 14 }}>
            <div><p style={{ ...lab, marginBottom: 6 }}>Release policy</p><div style={grid}>{Sel('releaseChannel', 'Release channel', ['internal', 'alpha', 'beta', 'stable', 'lts', 'custom'])}{Sel('updatePolicy', 'Update policy', ['manual', 'owner_approval', 'scheduled_manual', 'security_only', 'pinned', 'paused'])}</div></div>
            <div>
              <p style={{ ...lab, marginBottom: 6 }}>Repository</p>
              <input style={field} placeholder="ratchetnu/supercharged" value={String(f.repoName ?? '')} onChange={e => set('repoName', e.target.value)} />
              {(() => { const raw = String(f.repoName ?? '').trim(); if (!raw) return <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>Format: <code>owner/name</code> — a GitHub URL is accepted and normalized.</p>; const ref = parseRepoName(raw); return ref ? <p style={{ fontSize: 11, color: '#34d399', marginTop: 3 }}>✓ {ref.owner}/{ref.name}</p> : <p style={{ fontSize: 11, color: '#f87171', marginTop: 3 }}>✗ needs owner/name (e.g. ratchetnu/supercharged) — rejected on save.</p> })()}
            </div>
            <div><p style={{ ...lab, marginBottom: 6 }}>Status</p><div style={grid}>{Sel('healthStatus', 'Health', ['unknown', 'healthy', 'degraded', 'down'])}{Txt('currentVersion', 'Current version')}{Txt('currentCommit', 'Current commit')}</div>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>{Chk('updatesPaused', 'Updates paused')}{Chk('manualApprovalRequired', 'Manual approval required')}</div></div>
            <div><p style={{ ...lab, marginBottom: 6 }}>Notes</p><input style={field} value={String(f.notes ?? '')} onChange={e => set('notes', e.target.value)} /></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={btn('primary')} disabled={busy} onClick={async () => { if (await save()) setEditBiz(false) }}>{busy ? 'Saving…' : 'Save (confirmed + audited)'}</button>
              <button style={btn()} disabled={busy} onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ── 7. Pending updates (grouped) ── */}
      <div id="sec-updates" style={card}>
        <p style={secHead}>Pending updates for {b.name} ({pending.length})</p>
        {pending.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Nothing pending.</p>}
        {groupOrder.filter(g => groups[g].length).map(g => (
          <div key={g} style={{ marginTop: 8 }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>{g} ({groups[g].length})</p>
            {groups[g].map(u => (
              <div key={u.key} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--line)' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)' }}>{u.key}</span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{u.title}</span>
                <Badge tone={u.status === 'blocked' || u.status === 'failed' ? 'red' : g === 'Ready for Preview' ? 'green' : 'amber'}>{nice(u.status)}</Badge>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>prio {u.priority}</span>
                <button style={{ ...btn(), marginLeft: 'auto', padding: '4px 10px' }} onClick={() => onOpenUpdate(u.key)}>View Update</button>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* ── 8. Deployment activity (compact; collapsed when empty) ── */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <p style={{ ...secHead, margin: 0 }}>Deployment activity</p>
          {d.deployments.length > 0 && <button style={{ ...btn(), marginLeft: 'auto' }} onClick={() => setShowHistory(v => !v)}>{showHistory ? 'Hide' : `View history (${d.deployments.length})`}</button>}
        </div>
        {d.deployments.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 6 }}>No deployments have been recorded for {b.name} yet.</p>}
        {showHistory && d.deployments.map(dep => (
          <div key={dep.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '5px 0', borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ fontFamily: 'monospace' }}>{dep.id}</span><span>{nice(dep.status)}</span><span>verify {nice(dep.verificationStatus)}</span><span style={{ marginLeft: 'auto' }}>{fmtTs(dep.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
