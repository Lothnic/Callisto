// Deterministic DOM microbenchmark; no LLM, credentials or existing profile.
// node eval/agent-comparison/zen-actionability.mjs [output.json]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('../../packages/mini/node_modules/playwright-core');
const root = fileURLToPath(new URL('../../', import.meta.url));
const sourcePath = 'packages/firefox-rs/extension/content.js';
const baselineRef = process.env.ZEN_BASELINE_REF || 'HEAD';
const baselineCommit = execFileSync('git', ['rev-parse', baselineRef], { cwd: root, encoding: 'utf8' }).trim();
const sources = {
  baseline: execFileSync('git', ['show', `${baselineCommit}:${sourcePath}`], { cwd: root, encoding: 'utf8' }),
  candidate: await readFile(new URL(sourcePath, new URL('../../', import.meta.url)), 'utf8'),
};
const executablePath = process.env.CHROMIUM_PATH || '/snap/bin/chromium';
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const trials = [];
try {
  for (let trial = 0; trial < 4; trial++) {
    for (const variant of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const page = await browser.newPage();
      try {
        await page.setContent('<button id="target" style="position:relative">Target</button>');
        await page.evaluate(() => {
          window.clicks = 0;
          document.querySelector('#target').onclick = () => window.clicks++;
          window.browser = { runtime: { onMessage: { addListener(fn) { window.invoke = fn; } } } };
        });
        await page.addScriptTag({ content: sources[variant] });
        const result = await page.evaluate(async () => {
          const snapshot = await window.invoke({ type: 'action', method: 'snapshot' });
          const ref = snapshot.value.text.match(/\[(ax-\d+)\]/)[1];
          const stable = [];
          for (let i = 0; i < 20; i++) {
            const start = performance.now();
            const result = await window.invoke({ type: 'action', method: 'click', ref });
            if (result.error) throw new Error(result.error);
            stable.push(performance.now() - start);
          }
          const stableClicks = window.clicks;
          const target = document.querySelector('#target');
          const start = performance.now();
          const timer = setInterval(() => { target.style.left = `${(performance.now() - start) / 2}px`; }, 10);
          const stop = setTimeout(() => clearInterval(timer), 220);
          const animated = await window.invoke({ type: 'action', method: 'click', ref });
          const animatedMs = performance.now() - start;
          clearInterval(timer); clearTimeout(stop);
          return { stable_ms: stable, stable_clicks: stableClicks, animated_ms: animatedMs, animated_success: !!animated.value?.completed, animated_error: animated.error ?? null, animated_clicks: window.clicks - stableClicks };
        });
        assert.equal(result.stable_clicks, 20);
        assert.equal(result.animated_clicks, result.animated_success ? 1 : 0);
        trials.push({ trial, variant, ...result });
      } finally { await page.close(); }
    }
  }
  const median = values => { const sorted = [...values].sort((a,b) => a-b); const middle = Math.floor(sorted.length/2); return sorted.length % 2 ? sorted[middle] : (sorted[middle-1] + sorted[middle])/2; };
  const summary = Object.fromEntries(Object.keys(sources).map(variant => {
    const rows = trials.filter(row => row.variant === variant);
    return [variant, { stable_median_ms: median(rows.flatMap(row => row.stable_ms)), stable_actions: rows.reduce((n,row) => n+row.stable_clicks,0), animated_successes: rows.filter(row => row.animated_success).length, animated_trials: rows.length }];
  }));
  const output = {
    date: new Date().toISOString(), baseline_commit: baselineCommit,
    source_sha256: Object.fromEntries(Object.entries(sources).map(([key,source]) => [key,createHash('sha256').update(source).digest('hex')])),
    environment: { node: process.version, playwright: require('../../packages/mini/node_modules/playwright-core/package.json').version, browser: browser.version(), executablePath },
    scope: 'Injected extension DOM code in one disposable headless Chromium; alternating baseline/candidate trials. No extension transport, Zen, browse, LLM, dollar-cost or end-to-end task measurement.',
    summary, trials,
  };
  await writeFile(process.argv[2] || '/tmp/callisto-zen-extension-benchmark.json', JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
} finally { await browser.close(); }
