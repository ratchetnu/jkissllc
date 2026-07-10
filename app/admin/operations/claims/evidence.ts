import { upload } from '@vercel/blob/client'
import type { AttachmentKind } from '../../../lib/claims'

export type EvidenceUpload = { url: string; name: string; kind: AttachmentKind }

// Shrink a phone photo before upload so evidence stays light. Best-effort: any
// failure (e.g. a HEIC the browser can't decode to a canvas) returns the original
// file untouched. Mirrors the invoice-photo downscaler in app/admin/bookings.
async function downscaleImage(file: File, maxDim = 1600, quality = 0.82): Promise<Blob | File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    if (scale >= 1) { bitmap.close?.(); return file }
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) { bitmap.close?.(); return file }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    const out = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', quality))
    return out ?? file
  } catch { return file }
}

const kindFor = (type: string): AttachmentKind =>
  type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : 'document'

// Upload one piece of claim evidence straight to Vercel Blob (via the session-gated
// token broker) and return the stored URL + derived kind, ready to hand to the
// claim's `attach` action or the create-claim `attachments` array.
export async function uploadEvidence(file: File): Promise<EvidenceUpload> {
  const body = await downscaleImage(file)
  const blob = await upload(file.name, body, { access: 'public', handleUploadUrl: '/api/admin/claims/upload' })
  return { url: blob.url, name: file.name, kind: kindFor(file.type) }
}
