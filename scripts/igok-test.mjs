/**
 * Unit test for `igOk` — the one function every Instagram response funnels through.
 *
 * Runs without a browser, unlike the other two suites, so it is the cheapest place to pin down
 * response classification. It guards the two failures that shipped markup to the agent or
 * passed a null body off as a successful empty result: Instagram answers *API* paths with
 * whole HTML pages (login wall, 404), sometimes with HTTP 200.
 *
 * Usage: npm run test:unit
 */
import { igOk } from '../src/browser.mjs'

const HTML_404 =
  '<!DOCTYPE html>\n<html lang="None" class="no-js not-logged-in "><head><title>\n  Page Not Found &bull; Instagram\n</title></head><body></body></html>'

const cases = [
  ['404 html (login wall)', { status: 404, ok: false, json: null, text: HTML_404 }],
  ['200 html', { status: 200, ok: true, json: null, text: '<html><head><title>Login &amp; Sign in &#8212; Instagram</title></head></html>' }],
  ['good json', { status: 200, ok: true, json: { status: 'ok', user: { username: 'x' } }, text: null }],
  ['bridge down', { status: 0, ok: false, json: null, text: 'Chrome extension is not connected' }],
  ['rate limited', { status: 429, ok: false, json: null, text: 'slow down' }],
  ['api fail json', { status: 200, ok: true, json: { status: 'fail', message: 'checkpoint_required' }, text: null }],
  ['http error plain', { status: 500, ok: false, json: null, text: 'server broke' }],
]

for (const [label, result] of cases) {
  const out = igOk(result)
  console.log(`${out.ok ? 'ok  ' : 'err '} ${label.padEnd(20)} ${JSON.stringify(out.error ?? out.data)}`)
}

const wall = igOk(cases[0][1])
const entity = igOk(cases[1][1])

const checks = [
  ['html 404 rejected', !wall.ok],
  ['html 404 has no markup', !/<!doctype|<html/i.test(wall.error)],
  ['html 404 entity decoded', !/&bull;|&#\d+;/.test(wall.error)],
  ['html 404 names the title', /Page Not Found/.test(wall.error)],
  ['html 404 suggests the fix', /sign into instagram\.com/i.test(wall.error)],
  ['html 200 rejected too', !entity.ok],
  ['html 200 named entities decoded', /Login & Sign in — Instagram/.test(entity.error)],
  ['bridge-down text preserved', /extension is not connected/.test(igOk(cases[3][1]).error)],
  ['good json passes through', igOk(cases[2][1]).ok === true],
  ['rate limit surfaced', /Rate limited/.test(igOk(cases[4][1]).error)],
  ['api fail message surfaces', /checkpoint_required/.test(igOk(cases[5][1]).error)],
  ['plain http error preserved', /server broke/.test(igOk(cases[6][1]).error)],
]

console.log('')
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)

const broken = checks.filter(([, ok]) => !ok)
process.exit(broken.length ? 1 : 0)
