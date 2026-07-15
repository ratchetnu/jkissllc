// Minimal type declaration for `heic-convert` (ships no types). Pure-JS/wasm HEIC
// decoder used to convert iPhone HEIC/HEIF uploads to JPEG for the vision model.
declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array
    format: 'JPEG' | 'PNG'
    quality?: number // 0..1, JPEG only
  }
  export default function convert(options: ConvertOptions): Promise<ArrayBuffer>
}
