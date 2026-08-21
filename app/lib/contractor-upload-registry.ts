import { redis } from './redis'

const INDEX = 'app:upload:index'
const KEY = (id: string) => `app:upload:${id}`

export type PendingContractorUpload = {
  id: string
  applicantId: string
  path: string
  createdAt: number
}

export async function registerPendingContractorUpload(upload: PendingContractorUpload): Promise<void> {
  await redis.set(KEY(upload.id), JSON.stringify(upload))
  await redis.zadd(INDEX, upload.createdAt, upload.id)
}

export async function commitPendingContractorUploads(paths: string[]): Promise<void> {
  if (!paths.length) return
  const ids = await redis.zrange(INDEX, 0, -1)
  if (!ids.length) return
  const raws = await redis.mget(ids.map(KEY))
  const wanted = new Set(paths)
  await Promise.all(raws.map(async (raw) => {
    if (!raw) return
    try {
      const upload = JSON.parse(raw) as PendingContractorUpload
      if (!wanted.has(upload.path)) return
      await redis.del(KEY(upload.id))
      await redis.zrem(INDEX, upload.id)
    } catch { /* malformed registry rows expire through cleanup */ }
  }))
}

export async function pendingContractorUploadsBefore(cutoff: number, limit = 100): Promise<PendingContractorUpload[]> {
  const ids = await redis.zrangebyscore(INDEX, '-inf', String(cutoff), 0, limit)
  const raws = await redis.mget(ids.map(KEY))
  return raws.map((raw, index) => {
    if (!raw) return null
    try { return JSON.parse(raw) as PendingContractorUpload } catch { return { id: ids[index], applicantId: '', path: '', createdAt: 0 } }
  }).filter((row): row is PendingContractorUpload => row !== null)
}

export async function removePendingContractorUpload(id: string): Promise<void> {
  await redis.del(KEY(id))
  await redis.zrem(INDEX, id)
}
