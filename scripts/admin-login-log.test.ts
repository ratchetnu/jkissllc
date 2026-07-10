// User-agent → device parsing for the "Last Login" signal. Pure, no Redis.
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDevice } from '../app/lib/admin-login-log'

test('parses common browser/OS pairs', () => {
  // Safari on Mac (has Version/ and Safari/, no Chrome/)
  assert.equal(parseDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), 'Safari on Mac')
  // Chrome on Windows (Chrome/ present; must win over Safari/ token)
  assert.equal(parseDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'), 'Chrome on Windows')
  // Edge (Edg/ must win over Chrome/)
  assert.equal(parseDevice('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120.0'), 'Edge on Windows')
  // Safari on iPhone
  assert.equal(parseDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone')
  // Chrome on Android
  assert.equal(parseDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), 'Chrome on Android')
  // Firefox on Mac
  assert.equal(parseDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'), 'Firefox on Mac')
})

test('returns null when unreliable', () => {
  assert.equal(parseDevice(''), null)
  assert.equal(parseDevice(null), null)
  assert.equal(parseDevice(undefined), null)
  assert.equal(parseDevice('curl/8.4.0'), null) // no recognizable browser or OS
})
