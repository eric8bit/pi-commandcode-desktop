/**
 * Browser login for Command Code.
 *
 * Mirrors the official CLI's flow, which the upstream provider also reproduces:
 *
 *   1. bind a temporary HTTP server on 127.0.0.1, first free port from 5959 up;
 *   2. generate a random `state` and open
 *      `{studio}/studio/auth/cli?callback=http://localhost:{port}/callback&state={state}`;
 *   3. after the user signs in, the Studio page POSTs the credentials JSON
 *      `{ apiKey, state, userId, userName, keyName }` to that loopback callback —
 *      there is no OAuth code exchange, the page holds the final API key;
 *   4. the delivered key is validated against `GET {apiBase}/alpha/whoami`
 *      before anything is stored.
 *
 * The callback is POST-only with a 10 KB body cap and a state check, so another
 * local process cannot inject a key.
 */

const { createServer } = require("node:http")
const { createServer: createProbeServer } = require("node:net")
const { randomBytes } = require("node:crypto")

const LOGIN_TIMEOUT_MS = 120_000
const LOGIN_START_PORT = 5959
const LOGIN_MAX_PORT_ATTEMPTS = 10
const CALLBACK_MAX_BYTES = 10 * 1024

const STUDIO_AUTH_PATH = "/studio/auth/cli"

/** Compose the Studio authorization URL. */
function buildCommandAuthUrl(options) {
  const callback = `http://localhost:${options.port}/callback`
  return `${options.studioBase}${STUDIO_AUTH_PATH}?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(options.state)}`
}

/** Map an API base onto the Studio base the CLI pairs it with. */
function studioBaseForApiBase(apiBase) {
  if (/^https:\/\/staging-api\.commandcode\.ai/i.test(apiBase)) return "https://staging.commandcode.ai"
  if (/^http:\/\/localhost(:\d+)?$/i.test(apiBase)) return "http://localhost:3000"
  return "https://commandcode.ai"
}

/**
 * Validate one candidate key against `/alpha/whoami`.
 * 401 -> invalid_key, other non-OK -> server_error, transport failure -> network_error.
 */
async function validateCommandApiKey(fetchImpl, apiBase, apiKey) {
  try {
    const response = await fetchImpl(`${apiBase.replace(/\/+$/, "")}/alpha/whoami`, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    })
    if (response.status === 401) return { valid: false, error: "invalid_key" }
    if (response.ok) return { valid: true }
    return { valid: false, error: "server_error" }
  } catch {
    return { valid: false, error: "network_error" }
  }
}

function isFreePort(port) {
  return new Promise((resolve) => {
    const probe = createProbeServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "127.0.0.1")
  })
}

/** Whether a callback body carries every credential field the CLI requires. */
function isCallbackCredentials(value) {
  if (typeof value !== "object" || value === null) return false
  return (
    typeof value.apiKey === "string" &&
    value.apiKey !== "" &&
    typeof value.state === "string" &&
    typeof value.userId === "string" &&
    typeof value.userName === "string" &&
    typeof value.keyName === "string"
  )
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")))
      } catch {
        reject(new Error("body is not JSON"))
      }
    })
    req.on("error", reject)
  })
}

/**
 * Run one browser-login attempt.
 *
 * Single-flight by design: a second call while one is waiting joins the live
 * attempt instead of starting another server.
 *
 * @returns {Promise<{ok: true, credentials: object} | {ok: false, error: string}>}
 */
function createLoginFlow(options = {}) {
  const fetchImpl = options.fetch ?? fetch
  const apiBase = () => options.apiBase?.() ?? "https://api.commandcode.ai"
  const openExternal = options.openExternal
  const log = options.log ?? (() => {})

  let inFlight

  function begin() {
    if (inFlight) return inFlight
    inFlight = run().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  async function run() {
    const state = randomBytes(32).toString("base64url")

    // Find a free loopback port, mirroring the CLI's consecutive-port scan.
    let port
    for (let i = 0; i < LOGIN_MAX_PORT_ATTEMPTS; i++) {
      const candidate = LOGIN_START_PORT + i
      if (await isFreePort(candidate)) {
        port = candidate
        break
      }
    }
    if (port === undefined) {
      return { ok: false, error: "no free loopback port for the login callback (5959-5968)" }
    }

    const authUrl = buildCommandAuthUrl({
      studioBase: studioBaseForApiBase(apiBase()),
      port,
      state,
    })

    let settle
    const delivered = new Promise((resolve) => {
      settle = resolve
    })

    const server = createServer((req, res) => {
      const origin = req.headers.origin
      const cors = {
        // The Studio page is a different origin; the state token is the real guard.
        "Access-Control-Allow-Origin": typeof origin === "string" ? origin : "*",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors)
        res.end()
        return
      }
      if (req.method !== "POST" || !(req.url ?? "").startsWith("/callback")) {
        res.writeHead(404, { ...cors, "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: false, error: "not_found" }))
        return
      }

      readJsonBody(req, CALLBACK_MAX_BYTES)
        .then((body) => {
          if (!isCallbackCredentials(body) || body.state !== state) {
            res.writeHead(400, { ...cors, "Content-Type": "application/json" })
            res.end(JSON.stringify({ success: false, error: "invalid_payload" }))
            return
          }
          res.writeHead(200, { ...cors, "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: true }))
          settle({ credentials: body })
        })
        .catch(() => {
          res.writeHead(400, { ...cors, "Content-Type": "application/json" })
          res.end(JSON.stringify({ success: false, error: "invalid_payload" }))
        })
    })

    const listening = new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => resolve())
    })

    try {
      await listening
    } catch (error) {
      return { ok: false, error: `could not bind the login callback: ${error.message}` }
    }

    try {
      if (typeof openExternal === "function") {
        await openExternal(authUrl)
      }

      const timer = setTimeout(() => settle({ timeout: true }), LOGIN_TIMEOUT_MS)
      let outcome
      try {
        outcome = await delivered
      } finally {
        clearTimeout(timer)
      }

      if (outcome?.timeout) {
        return { ok: false, error: "the browser login timed out; paste the key manually instead" }
      }

      const { credentials } = outcome
      const validation = await validateCommandApiKey(fetchImpl, apiBase(), credentials.apiKey)
      if (!validation.valid) {
        return { ok: false, error: `the delivered key was rejected (${validation.error})` }
      }

      log(`browser login delivered a key for ${credentials.userName || credentials.userId}`)
      return { ok: true, credentials }
    } finally {
      server.close(() => {})
    }
  }

  return { begin, buildCommandAuthUrl, studioBaseForApiBase }
}

module.exports = {
  LOGIN_TIMEOUT_MS,
  LOGIN_START_PORT,
  LOGIN_MAX_PORT_ATTEMPTS,
  CALLBACK_MAX_BYTES,
  STUDIO_AUTH_PATH,
  buildCommandAuthUrl,
  studioBaseForApiBase,
  validateCommandApiKey,
  isCallbackCredentials,
  createLoginFlow,
}
