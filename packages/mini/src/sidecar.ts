#!/usr/bin/env node
/**
 * callisto-sidecar — stdio JSON-RPC bridge over @callisto/mini.
 *
 * Protocol (RFC 0003):
 *   stdin  → { id, method, params, v } (one JSON object per line)
 *   stdout → { id, ok, result }  |  { id, ok: false, error }
 *
 * Methods: launch | eval | close
 *
 * This process never crashes on a bad call. All errors are serialised and
 * returned. Browser lifecycle remains owned by the sidecar, not eval code.
 */

import * as readline from 'node:readline'
import { Mini, Page } from './index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Request {
  id: string
  method: string
  params: Record<string, unknown>
  v?: number
}

type Response =
  | { id: string; ok: true; result: Record<string, unknown> }
  | { id: string; ok: false; error: string }

// ---------------------------------------------------------------------------
// Serialisation helpers (RFC 0003 §serialization policy)
// ---------------------------------------------------------------------------

const EVAL_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 100 * 1024 // 100 KB

function encodeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return { type: 'base64', data: Buffer.from(v).toString('base64') }
  }
  if (v === undefined) return null
  if (Array.isArray(v)) return v.map(encodeValue)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, encodeValue(val)]),
    )
  }
  return v
}

function bigintReplacer(_key: string, val: unknown): unknown {
  return typeof val === 'bigint' ? val.toString() : val
}

function safeSerialise(raw: unknown): { value: unknown; truncated: boolean } {
  const encoded = encodeValue(raw)

  let json: string
  try {
    json = JSON.stringify(encoded, bigintReplacer)
  } catch (e) {
    const msg = String(e)
    if (msg.includes('circular') || msg.includes('cyclic')) {
      throw new Error('SerializeError: circular reference in return value')
    }
    throw e
  }

  if (json.length > MAX_OUTPUT_BYTES) {
    return { value: json.slice(0, MAX_OUTPUT_BYTES), truncated: true }
  }
  return { value: JSON.parse(json), truncated: false }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mini: Mini | null = null
let page: Page | null = null

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleLaunch(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (mini) {
    await mini.close()
    mini = null
    page = null
  }
  mini = await Mini.launch({
    headless: params.headless !== false,
    chromeFlags: Array.isArray(params.chromeFlags)
      ? (params.chromeFlags as string[])
      : [],
  })
  page = new Page(mini)
  return { ok: true }
}

async function handleEval(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!mini || !page) {
    throw new Error('EvalError: no browser session — call launch first')
  }
  const code = params.code
  if (typeof code !== 'string') {
    throw new Error('EvalError: params.code must be a string')
  }

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('page', `return (async () => { ${code} })()`)

  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('EvalTimeout: exceeded 60s')),
      EVAL_TIMEOUT_MS,
    )
  })

  try {
    const raw = await Promise.race([fn(page) as Promise<unknown>, timeout])
    // Focus any popup/new tab that opened during the action before returning.
    await mini.flushPendingFocus()
    const { value, truncated } = safeSerialise(raw)
    const signals = await mini.drainSignals()
    const result: Record<string, unknown> = truncated ? { value, truncated: true } : { value }
    if (signals.length) result._signals = signals
    return result
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EvalTimeout:')) {
      // Timed-out JavaScript cannot be cancelled safely. Retire its browser so
      // it cannot continue issuing actions against the next request's session.
      const expired = mini
      mini = null
      page = null
      await expired.close().catch(() => undefined)
    }
    throw error
  } finally {
    clearTimeout(timer!)
  }
}

async function handleClose(): Promise<Record<string, unknown>> {
  if (mini) {
    await mini.close()
    mini = null
    page = null
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const SUPPORTED_VERSION = 1

async function dispatch(req: Request): Promise<Response> {
  // Version check
  if (req.v !== undefined && req.v !== SUPPORTED_VERSION) {
    return {
      id: req.id,
      ok: false,
      error: `unsupported protocol version ${req.v}`,
    }
  }

  try {
    let result: Record<string, unknown>
    switch (req.method) {
      case 'launch':
        result = await handleLaunch(req.params ?? {})
        break
      case 'eval':
        result = await handleEval(req.params ?? {})
        break
      case 'close':
        result = await handleClose()
        break
      default:
        return { id: req.id, ok: false, error: `unknown method: ${req.method}` }
    }
    return { id: req.id, ok: true, result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { id: req.id, ok: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Stdio framing
// ---------------------------------------------------------------------------

function send(res: Response): void {
  // process.stdout.write is synchronous on every call — no buffering issue.
  process.stdout.write(JSON.stringify(res) + '\n')
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
})

let pending = Promise.resolve()
rl.on('line', (line: string) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let req: Request
  try {
    req = JSON.parse(trimmed) as Request
  } catch {
    send({ id: 'null', ok: false, error: 'ParseError: invalid JSON' })
    return
  }

  pending = pending.then(async () => {
    const res = await dispatch(req)
    send(res)
  })
})

rl.on('close', async () => {
  // stdin closed (EOF) — clean up and exit
  await pending
  if (mini) {
    try { await mini.close() } catch { /* best-effort */ }
  }
  page = null
  process.exit(0)
})

// Log diagnostic info to stderr (not stdout — stdout is reserved for JSON-RPC)
process.stderr.write('[callisto-sidecar] ready\n')
