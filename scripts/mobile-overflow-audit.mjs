// Truthful mobile viewport audit. A route passes only after the intended hydrated
// content is present; clean layout on a login page or empty shell is never evidence.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

import { classifyCheck, summarize, validateAuditTarget } from './mobile-audit-classify.mjs'
import { MOBILE_AUDIT_ROUTES, readinessFor } from './mobile-audit-config.mjs'

const DEFAULT_BASE = 'http://localhost:3111'
const argv = process.argv.slice(2)
const argValue = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const BASE = (argValue('--base') || process.env.BASE || DEFAULT_BASE).replace(/\/$/, '')
const AUDIT_ENV = process.env.AUDIT_ENV || ''
const PW_EXE = process.env.PW_EXE || undefined
const LABEL = process.env.LABEL || 'run'
const ONLY = process.env.ONLY ? process.env.ONLY.split(',').filter(Boolean) : null
const CLICK_TEXT = process.env.CLICK_TEXT || null
const SHOT_DIR = process.env.SHOT_DIR || null
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join('.local-audit', 'mobile-evidence', LABEL)
const SHOT_WIDTHS = new Set([320, 390, 768, 1280])
const READINESS_TIMEOUT_MS = Number(process.env.READINESS_TIMEOUT_MS || 10_000)

const VIEWPORTS = [
  { w: 320, h: 568 }, { w: 360, h: 800 }, { w: 375, h: 667 }, { w: 390, h: 844 },
  { w: 393, h: 852 }, { w: 414, h: 896 }, { w: 430, h: 932 }, { w: 768, h: 1024 },
  { w: 1280, h: 900 },
]

const target = validateAuditTarget(BASE, AUDIT_ENV)
if (!target.ok) {
  console.error(`BLOCKED_ENV: ${target.reason}`)
  console.error('No browser was launched and no route was measured.')
  process.exit(2)
}
const environment = target.environment
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true })

const routes = (ONLY
  ? ONLY.map((requestedPath) => readinessFor(requestedPath) ?? {
      path: requestedPath,
      authRequired: requestedPath.startsWith('/admin') || requestedPath === '/portal',
      readiness: null,
    })
  : MOBILE_AUDIT_ROUTES
).map((route) => {
  if (!process.env.READINESS_EXPECT_TEXT || ONLY?.length !== 1 || !route.readiness) return route
  return {
    ...route,
    readiness: {
      ...route.readiness,
      expectedText: [...(route.readiness.expectedText || []), process.env.READINESS_EXPECT_TEXT],
    },
  }
})

const safeName = (value) => value.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'
const expectedUrlMatches = (actual, requestedPath) => {
  try {
    const pathname = new URL(actual).pathname.replace(/\/$/, '') || '/'
    const expected = requestedPath.replace(/\/$/, '') || '/'
    return pathname === expected
  } catch { return false }
}

async function installLocalCookie(ctx, response) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE)) return
  const setCookie = response.headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value)
    .join(',') || response.headers()['set-cookie'] || ''
  const match = setCookie.match(/(?:^|[,;]\s*)jk_admin_session=([^;]+)/)
  if (!match) return
  await ctx.addCookies([{
    name: 'jk_admin_session',
    value: match[1],
    url: BASE,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  }])
}

async function authenticate(ctx) {
  const requestedRole = (process.env.AUDIT_ROLE || 'owner').toLowerCase()
  if (requestedRole === 'public') return { ready: false, role: 'public', identity: 'public' }
  try {
    if (process.env.AUDIT_EMAIL && process.env.AUDIT_PASSWORD) {
      const response = await ctx.request.post(`${BASE}/api/auth/login`, {
        data: { email: process.env.AUDIT_EMAIL, password: process.env.AUDIT_PASSWORD },
      })
      if (!response.ok()) return { ready: false, role: requestedRole, identity: 'named-user' }
      await installLocalCookie(ctx, response)
      const payload = await response.json().catch(() => null)
      const role = String(payload?.role || requestedRole)
      const whoami = await ctx.request.get(`${BASE}/api/admin/platform/whoami`)
      return {
        ready: whoami.ok() && role === requestedRole,
        role,
        identity: 'named-user',
      }
    }
    if (process.env.ADMIN_PASSWORD) {
      const response = await ctx.request.post(`${BASE}/api/admin/auth`, {
        data: { password: process.env.ADMIN_PASSWORD },
      })
      if (!response.ok()) return { ready: false, role: 'owner', identity: 'owner' }
      await installLocalCookie(ctx, response)
      const whoami = await ctx.request.get(`${BASE}/api/admin/platform/whoami`)
      const payload = await whoami.json().catch(() => null)
      return { ready: whoami.ok() && payload?.owner === true, role: 'owner', identity: 'owner' }
    }
  } catch { /* classified as blocked auth without exposing response details */ }
  return { ready: false, role: requestedRole, identity: requestedRole === 'owner' ? 'owner' : 'named-user' }
}

async function preflight() {
  try {
    const response = await fetch(BASE, { signal: AbortSignal.timeout(10_000) })
    return { ok: true, status: response.status }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? (error.cause?.code || error.message) : String(error) }
  }
}

const preflightResult = await preflight()
if (!preflightResult.ok) {
  console.error(`BLOCKED_ENV: app unreachable at configured ${environment} target (${preflightResult.error})`)
  console.error('No browser was launched and no route was measured.')
  process.exit(2)
}

let browser
try {
  browser = await chromium.launch({ executablePath: PW_EXE })
} catch (error) {
  console.error(`BLOCKED_ENV: browser could not launch (${error instanceof Error ? error.message : String(error)})`)
  process.exit(2)
}

const ctx = await browser.newContext({ deviceScaleFactor: 1 })
const auth = await authenticate(ctx)
const page = await ctx.newPage()
let clientErrors = []
page.on('pageerror', (error) => clientErrors.push(error.name || 'client error'))

async function inspectReadiness(route) {
  const configured = Boolean(route.readiness?.selector)
  if (configured) {
    await page.waitForFunction(
      ({ selector, minimumText, expectedText }) => {
        const element = document.querySelector(selector)
        const text = (element?.textContent || '').replace(/\s+/g, ' ').trim()
        const expected = expectedText || []
        const visible = (candidate) => {
          const style = getComputedStyle(candidate)
          const rect = candidate.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        }
        const loadingMarker = [...document.querySelectorAll('.skeleton,[aria-busy="true"]')].some(visible)
        const loadingText = [...document.querySelectorAll('main p,main div,main span')]
          .some((candidate) => visible(candidate) && /^loading(?:\s|[.…]|$)/i.test((candidate.textContent || '').trim()))
        return document.readyState === 'complete' &&
          text.length >= minimumText &&
          expected.every((part) => text.toLowerCase().includes(String(part).toLowerCase())) &&
          !loadingMarker &&
          !loadingText
      },
      route.readiness,
      { timeout: READINESS_TIMEOUT_MS },
    ).catch(() => {})
  }

  return page.evaluate(({ readiness }) => {
    const visible = (element) => {
      if (!element) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
    const selector = readiness?.selector || ''
    const readyElement = selector ? document.querySelector(selector) : null
    const readyText = (readyElement?.textContent || '').replace(/\s+/g, ' ').trim()
    const expected = readiness?.expectedText || []
    const readinessMet = Boolean(readyElement) &&
      readyText.length >= (readiness?.minimumText || 1) &&
      expected.every((part) => readyText.toLowerCase().includes(String(part).toLowerCase()))
    const loadingElements = [...document.querySelectorAll('.skeleton,[aria-busy="true"]')].some(visible)
    const loadingText = /\bloading(?:[.…]{0,3})?\b/i.test(bodyText) && !readinessMet
    const loginDetected = Boolean(document.querySelector('input[type="password"]')) &&
      /\b(sign in|log in|password)\b/i.test(bodyText)
    const errorBoundary = /\b(application error|internal server error|something went wrong|unexpected error)\b/i.test(bodyText)
    const primaryAction = readiness?.primaryActionSelector
      ? document.querySelector(readiness.primaryActionSelector)
      : null
    return {
      hydrated: document.readyState === 'complete' && Boolean(document.body),
      blank: bodyText.length < 10,
      loading: loadingElements || loadingText,
      loginDetected,
      errorBoundary,
      readinessConfigured: Boolean(selector),
      readinessMet,
      primaryActionRequired: Boolean(readiness?.primaryActionSelector),
      primaryActionVisible: readiness?.primaryActionSelector ? visible(primaryAction) : true,
      bodyTextLength: bodyText.length,
    }
  }, { readiness: route.readiness })
}

async function measureLayout() {
  return page.evaluate(() => {
    const documentElement = document.documentElement
    const scrollWidth = documentElement.scrollWidth
    const clientWidth = documentElement.clientWidth
    const offenders = []
    if (scrollWidth > clientWidth + 1) {
      for (const element of document.querySelectorAll('body *')) {
        const rect = element.getBoundingClientRect()
        if (rect.right > clientWidth + 1 && rect.width > 1 && rect.left < clientWidth + 40) {
          const classes = typeof element.className === 'string' && element.className
            ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
            : ''
          offenders.push(`${element.tagName.toLowerCase()}${classes} L=${Math.round(rect.left)} R=${Math.round(rect.right)} w=${Math.round(rect.width)}`)
        }
      }
    }
    const reachableViaRail = (element) => {
      let parent = element.parentElement
      while (parent) {
        const style = getComputedStyle(parent)
        if (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          parent.scrollWidth > parent.clientWidth + 1
        ) return true
        parent = parent.parentElement
      }
      return false
    }
    const clipped = []
    for (const element of document.querySelectorAll('button,a,input,select,textarea,[data-fab]')) {
      const style = getComputedStyle(element)
      if (
        style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0' ||
        element.closest('[aria-hidden="true"]')
      ) continue
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0 && (rect.right <= 1 || rect.left >= clientWidth - 1)) {
        if (reachableViaRail(element)) continue
        const label = element.getAttribute('aria-label') ||
          (element.textContent || '').trim().slice(0, 22) ||
          element.tagName.toLowerCase()
        clipped.push(`"${label}" L=${Math.round(rect.left)} R=${Math.round(rect.right)}`)
      }
    }
    return {
      scrollWidth,
      clientWidth,
      offenders: offenders.slice(0, 8),
      clipped: [...new Set(clipped)].slice(0, 6),
    }
  })
}

const results = []
for (const route of routes) {
  for (const viewport of VIEWPORTS) {
    const evidenceStem = `${safeName(route.path)}__${viewport.w}`
    const evidencePath = path.join(EVIDENCE_DIR, `${evidenceStem}.json`)
    const row = {
      requestedRoute: route.path,
      finalUrl: null,
      viewport: `${viewport.w}x${viewport.h}`,
      environment,
      identity: route.authRequired ? auth.identity : 'public',
      role: route.authRequired ? auth.role : 'public',
      assertion: route.readiness
        ? `${route.readiness.selector}; minText=${route.readiness.minimumText}; expected=${(route.readiness.expectedText || []).join('|') || 'semantic-content'}`
        : 'missing',
      evidencePath,
    }
    let check = {
      environmentAllowed: true,
      authRequired: route.authRequired,
      authReady: route.authRequired ? auth.ready : true,
      readinessConfigured: Boolean(route.readiness),
      evidencePath,
    }
    let pageWasOpened = false
    clientErrors = []

    if (!route.authRequired || auth.ready) {
      await page.setViewportSize({ width: viewport.w, height: viewport.h })
      try {
        const response = await page.goto(`${BASE}${route.path}`, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        })
        pageWasOpened = true
        row.finalUrl = page.url()
        let redirectCount = 0
        let redirectedFrom = response?.request().redirectedFrom() ?? null
        while (redirectedFrom) {
          redirectCount++
          redirectedFrom = redirectedFrom.redirectedFrom()
        }
        if (CLICK_TEXT) {
          const target = page.getByRole('tab', { name: CLICK_TEXT, exact: true })
          if (await target.count() !== 1) throw new Error('configured tab assertion did not resolve uniquely')
          await target.click()
        }
        const readiness = await inspectReadiness(route)
        const layout = await measureLayout()
        check = {
          ...check,
          httpStatus: response?.status() ?? null,
          finalUrlMatches: expectedUrlMatches(page.url(), route.path),
          redirectLoop: redirectCount > 10,
          clientError: clientErrors[0] || null,
          ...readiness,
          ...layout,
        }
      } catch (error) {
        check = { ...check, error: error instanceof Error ? error.message : String(error) }
      }
    }

    const classified = classifyCheck(check)
    const result = { ...row, outcome: classified.outcome, reason: classified.detail }
    if (classified.outcome !== 'PASS' && pageWasOpened) {
      const screenshotPath = path.join(EVIDENCE_DIR, `${evidenceStem}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
      result.screenshotPath = screenshotPath
    } else if (classified.outcome === 'PASS' && SHOT_DIR && SHOT_WIDTHS.has(viewport.w)) {
      const screenshotPath = path.join(SHOT_DIR, `${LABEL}__${evidenceStem}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true })
      result.screenshotPath = screenshotPath
    }
    fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`)
    results.push(result)
  }
}

await browser.close()
const summary = summarize(results)

console.log(`\n==== MOBILE AUDIT (environment=${environment}, auth=${auth.ready ? auth.role : 'not-ready'}, base=${BASE}) ====`)
console.log(`${results.length} checks run`)
for (const outcome of ['PASS', 'FAIL', 'BLOCKED_AUTH', 'BLOCKED_ENV', 'ROUTE_ERROR', 'INCONCLUSIVE']) {
  console.log(`  ${outcome.padEnd(14)} ${summary.counts[outcome]}`)
}
console.log(`\n---- per-route ----`)
for (const route of routes) {
  const rows = results.filter((result) => result.requestedRoute === route.path)
  const states = [...new Set(rows.map((result) => result.outcome))]
  const passed = rows.length > 0 && rows.every((result) => result.outcome === 'PASS')
  console.log(`${passed ? 'PASS' : states.join('+')} ${route.path}`)
}
const reportPath = path.join(EVIDENCE_DIR, 'summary.json')
fs.writeFileSync(reportPath, `${JSON.stringify({ base: BASE, environment, auth, summary, results }, null, 2)}\n`)
console.log(`\nevidence → ${EVIDENCE_DIR}/`)
console.log(`exit ${summary.exitCode}  (0 = all PASS, 1 = finding/route error, 2 = blocked/inconclusive)`)
process.exit(summary.exitCode)
