// Token-count reporter for the a11y snapshot. Reproduces the Phase 2 density
// numbers: snapshot each URL, print an approximate token count (chars/4).
//
//   npm --prefix packages/mini run build
//   CHROME_PATH=... node packages/mini/scripts/tokens.mjs https://github.com https://news.ycombinator.com
//   add --no-sandbox envs as needed: CALLISTO_NO_SANDBOX=1
//
// Compare against agent-browser / Playwright MCP by hand on the same URLs.
let Mini
try {
  ;({ Mini } = await import('../dist/index.js'))
} catch {
  console.error('tokens.mjs needs built JS. Run: npm --prefix packages/mini run build')
  process.exit(1)
}

const urls = process.argv.slice(2)
if (!urls.length) {
  console.error('usage: node scripts/tokens.mjs <url> [url...]')
  process.exit(1)
}
const chromeFlags = process.env.CALLISTO_NO_SANDBOX ? ['--no-sandbox'] : []
const approxTokens = (s) => Math.ceil(s.length / 4)

const mini = await Mini.launch({ headless: true, chromeFlags })
try {
  console.log(`${'URL'.padEnd(48)} ${'chars'.padStart(8)} ${'~tokens'.padStart(8)}`)
  for (const url of urls) {
    try {
      await mini.goto(url, { waitUntil: 'load' })
      await new Promise((r) => setTimeout(r, 2000))
      const { text } = await mini.snapshot()
      console.log(`${url.slice(0, 48).padEnd(48)} ${String(text.length).padStart(8)} ${String(approxTokens(text)).padStart(8)}`)
    } catch (e) {
      console.log(`${url.slice(0, 48).padEnd(48)} ${'ERROR'.padStart(8)} ${(e.message || '').slice(0, 40)}`)
    }
  }
} finally {
  await mini.close()
}
