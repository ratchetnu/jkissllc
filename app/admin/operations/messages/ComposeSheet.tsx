'use client'

import { useMemo, useState } from 'react'
import { Send } from 'lucide-react'
import { osField, osLabel } from '../ui'
import { Toggle } from '../ui'
import {
  Sheet, ChannelPicker, Icon, api,
  type ChannelId, type TemplateDef,
} from './commsShared'

// Command Center compose (request Part 14). Given a set of recipients, pick a
// template (or write a custom message), choose channels, require acknowledgement,
// and blast it — tracking responses via the reminder-instance ledger. Reused by the
// Crew directory and (pre-filled) by Dispatch mode.
export default function ComposeSheet({
  recipientIds, recipientLabel, templates, onClose, onSent, initialTemplateId, initialMessage, origin = 'bulk',
}: {
  recipientIds: string[]
  recipientLabel: string
  templates: TemplateDef[]
  onClose: () => void
  onSent: (sent: number) => void
  initialTemplateId?: string
  initialMessage?: string
  origin?: 'bulk' | 'dispatch'
}) {
  const initial = templates.find(t => t.id === initialTemplateId) || templates.find(t => t.id === 'custom') || templates[0]
  const [templateId, setTemplateId] = useState(initial?.id || 'custom')
  const tpl = useMemo(() => templates.find(t => t.id === templateId) || initial, [templates, templateId, initial])
  const [message, setMessage] = useState(initialMessage ?? initial?.defaultMessage ?? '')
  const [channels, setChannels] = useState<ChannelId[]>(initial?.defaultChannels || ['inapp', 'sms'])
  const [requireAck, setRequireAck] = useState(initial?.requireAckDefault ?? (origin === 'dispatch'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function pickTemplate(id: string) {
    setTemplateId(id)
    const t = templates.find(x => x.id === id)
    if (t) {
      if (t.id !== 'custom') setMessage(t.defaultMessage)
      setChannels(t.defaultChannels)
      setRequireAck(t.requireAckDefault)
    }
  }

  async function send() {
    if (!message.trim()) { setError('Write a message first.'); return }
    if (!recipientIds.length) { setError('No crew selected.'); return }
    setBusy(true); setError('')
    try {
      const res = await api<{ sent: number }>('/api/admin/comms/send', {
        method: 'POST',
        body: JSON.stringify({
          origin, templateId, title: tpl?.label || 'Message', message: message.trim(),
          channels, requireAck, ackOptions: tpl?.ackOptions || ['acknowledged'],
          staffIds: recipientIds,
        }),
      })
      onSent(res.sent)
    } catch (e) { setError(e instanceof Error ? e.message : 'Send failed.') }
    finally { setBusy(false) }
  }

  return (
    <Sheet title={`Message ${recipientLabel}`} onClose={onClose} footer={
      <button onClick={send} disabled={busy} className="cc-action os-tap" style={{ width: '100%', background: 'var(--red)', color: '#fff', opacity: busy ? .6 : 1 }}>
        <Send size={17} /> {busy ? 'Sending…' : `Send to ${recipientIds.length} crew`}
      </button>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ ...osLabel, marginBottom: 8 }}>Template</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {templates.map(t => {
              const on = t.id === templateId
              return (
                <button key={t.id} type="button" onClick={() => pickTemplate(t.id)} className="os-tap"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 11px', borderRadius: 12, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: `1px solid ${on ? 'var(--red)' : 'var(--line)'}`, background: on ? 'color-mix(in srgb, var(--red) 14%, transparent)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
                  <Icon name={t.icon} size={14} /> {t.label}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <div style={{ ...osLabel, marginBottom: 8 }}>Message</div>
          <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4} placeholder="Write your message…"
            style={{ ...osField, resize: 'vertical', minHeight: 96, lineHeight: 1.5 }} />
        </div>

        <div>
          <div style={{ ...osLabel, marginBottom: 8 }}>Channels</div>
          <ChannelPicker value={channels} onChange={setChannels} />
          {channels.includes('push') && <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Push is delivered in-app until web-push is enabled.</p>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Require acknowledgement</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Crew respond with one tap; unacknowledged sends can escalate.</div>
          </div>
          <Toggle on={requireAck} onChange={setRequireAck} label="Require acknowledgement" />
        </div>

        {requireAck && tpl && (
          <div>
            <div style={{ ...osLabel, marginBottom: 6 }}>Response buttons</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {tpl.ackOptions.map(a => (
                <span key={a} style={{ fontSize: 11.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999, background: 'rgba(255,255,255,.06)', border: '1px solid var(--line)', color: 'var(--muted)', textTransform: 'capitalize' }}>{a.replace('_', ' ')}</span>
              ))}
            </div>
          </div>
        )}

        {error && <p style={{ color: '#fca5a5', fontSize: 13.5 }}>{error}</p>}
      </div>
    </Sheet>
  )
}
