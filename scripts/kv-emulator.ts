// An executable Upstash-REST emulator for tests.
//
// WHY THIS EXISTS. The claim state machine's correctness lives entirely in two Lua
// scripts — compare-and-set and compare-and-delete — that run atomically inside the
// store. A test that only greps the source for `compareAndSet(` proves the call is
// written, not that the transition is SAFE: it cannot distinguish a conditional
// update from an unconditional one, so the exact bug the Lua exists to prevent would
// pass. This emulator executes the real script bodies against real state, so a race
// can actually be played out and observed.
//
// It models: SET (with NX / PX), GET, DEL, EXPIRE, TTL, and EVAL for the three
// scripts in app/lib/kv-lock.ts. Expiry runs on a virtual clock so a lapsed claim can
// be reproduced deterministically, with no waiting and no flakiness.
//
// Keys arrive already tenant-scoped by the redis chokepoint, so helpers match on
// suffix rather than assuming a prefix.

type Entry = { value: string; expiresAt: number | null }

export type KvEmulator = {
  /** Install as globalThis.fetch. Returns the previous fetch so it can be restored. */
  install(): typeof fetch
  restore(prev: typeof fetch): void
  /** Advance the virtual clock, expiring anything due. */
  advance(ms: number): void
  now(): number
  /** Raw read that ignores expiry bookkeeping — for assertions. */
  peek(keySuffix: string): string | null
  ttlMs(keySuffix: string): number | null
  set(keySuffix: string, value: string, ttlMs?: number): void
  del(keySuffix: string): void
  keys(): string[]
  clear(): void
  /** Every command the code under test issued, e.g. 'SET', 'EVAL:cas'. */
  commands: string[]
  /** Force the next `n` commands to fail as a transport error (0 = always). */
  failNext(n: number): void
  stopFailing(): void
}

const CAS = "redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3])"
const CAD = "return redis.call('del', KEYS[1])"
const RENEW = "redis.call('pexpire', KEYS[1], ARGV[2])"

export function createKvEmulator(): KvEmulator {
  const store = new Map<string, Entry>()
  let clock = 1_000_000
  const commands: string[] = []
  let failures = -1

  const live = (k: string): Entry | null => {
    const e = store.get(k)
    if (!e) return null
    if (e.expiresAt != null && e.expiresAt <= clock) { store.delete(k); return null }
    return e
  }
  const find = (suffix: string): string | null => {
    for (const k of store.keys()) if (k.endsWith(suffix)) return k
    return null
  }

  function exec(argv: unknown[]): unknown {
    const cmd = String(argv[0]).toUpperCase()
    const a = argv.map(String)

    if (cmd === 'GET') { commands.push('GET'); return live(a[1])?.value ?? null }

    if (cmd === 'SET') {
      const [, k, v, ...rest] = a
      const flags = rest.map(x => x.toUpperCase())
      const nx = flags.includes('NX')
      const pxAt = flags.indexOf('PX')
      const ttl = pxAt >= 0 ? Number(rest[pxAt + 1]) : null
      commands.push(nx ? 'SET:NX' : 'SET')
      if (nx && live(k)) return null
      store.set(k, { value: v, expiresAt: ttl != null ? clock + ttl : null })
      return 'OK'
    }

    if (cmd === 'DEL') { commands.push('DEL'); return store.delete(a[1]) ? 1 : 0 }

    if (cmd === 'EXPIRE') {
      commands.push('EXPIRE')
      const e = live(a[1])
      if (!e) return 0
      e.expiresAt = clock + Number(a[2]) * 1000
      return 1
    }

    if (cmd === 'TTL') {
      const e = live(a[1])
      return !e ? -2 : e.expiresAt == null ? -1 : Math.ceil((e.expiresAt - clock) / 1000)
    }

    if (cmd === 'EVAL') {
      // ['EVAL', script, numKeys, ...keys, ...args]
      const script = a[1]
      const numKeys = Number(a[2])
      const keys = a.slice(3, 3 + numKeys)
      const args = a.slice(3 + numKeys)
      const cur = live(keys[0])?.value ?? null

      if (script.includes(CAS)) {
        commands.push('EVAL:cas')
        // if get(KEYS[1]) == ARGV[1] then set(KEYS[1], ARGV[2], PX ARGV[3]); return 1
        if (cur !== args[0]) return 0
        store.set(keys[0], { value: args[1], expiresAt: clock + Number(args[2]) })
        return 1
      }
      if (script.includes(RENEW)) {
        commands.push('EVAL:renew')
        if (cur !== args[0]) return 0
        const e = live(keys[0])
        if (e) e.expiresAt = clock + Number(args[1])
        return 1
      }
      if (script.includes(CAD)) {
        commands.push('EVAL:cad')
        // if get(KEYS[1]) == ARGV[1] then return del(KEYS[1]) else return 0
        if (cur !== args[0]) return 0
        store.delete(keys[0])
        return 1
      }
      throw new Error(`kv-emulator: unmodelled Lua script: ${script.slice(0, 60)}`)
    }

    commands.push(cmd)
    return null
  }

  return {
    commands,
    install() {
      const prev = globalThis.fetch
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (failures !== -1) {
          if (failures === 0 || failures-- > 0) throw new Error('kv-emulator: transport down')
        }
        const body = JSON.parse(String(init?.body)) as unknown[]
        const result = exec(body)
        return new Response(JSON.stringify({ result }), { status: 200 })
      }) as typeof fetch
      return prev
    },
    restore(prev) { globalThis.fetch = prev },
    advance(ms) { clock += ms },
    now() { return clock },
    peek(suffix) { const k = find(suffix); return k ? (live(k)?.value ?? null) : null },
    ttlMs(suffix) {
      const k = find(suffix); if (!k) return null
      const e = live(k); if (!e) return null
      return e.expiresAt == null ? null : e.expiresAt - clock
    },
    set(suffix, value, ttlMs) { store.set(suffix, { value, expiresAt: ttlMs != null ? clock + ttlMs : null }) },
    del(suffix) { const k = find(suffix); if (k) store.delete(k) },
    keys() { return [...store.keys()] },
    clear() { store.clear(); commands.length = 0; failures = -1 },
    failNext(n) { failures = n },
    stopFailing() { failures = -1 },
  }
}
