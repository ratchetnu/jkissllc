import { legacyBlobPath, sanitizeBlobSegment, scopeBlobPath } from './blob-keys'

/** Build the exact pathname a browser-direct Blob upload must request. */
export function clientUploadBlobPath(filename: string): string {
  return scopeBlobPath(sanitizeBlobSegment(filename))
}

/**
 * Token brokers must bind tokens only to the active tenant's issued pathname.
 * This prevents a modified browser request from selecting another tenant or an
 * arbitrary nested object path.
 */
export function assertClientUploadBlobPath(pathname: string): string {
  const expected = clientUploadBlobPath(sanitizeBlobSegment(legacyBlobPath(pathname)))
  if (pathname !== expected) throw new Error('invalid blob pathname')
  return pathname
}
