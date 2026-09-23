/**
 * Loopback HTTP endpoint that PI-Desktop talks to.
 *
 * The host reads a provider's baseUrl from the manifest and sends provider
 * requests there, so this server is what actually serves chat traffic. It:
 *
 *   1. binds 127.0.0.1 only, and rejects any request whose Host/Origin is not a
 *      loopback name (a browser page must not be able to reach it);
 *   2. picks an account from the pool (per-model rule → priority order → rotation)
 *      and uses that account's credential. Every declared provider uses
 *      `authKind: "none"`, so no Authorization header ever arrives from the host;
 *   3. chooses a transport per request, decided the way the upstream provider does:
 *        - Claude models always need the Messages endpoint, and the Provider API
 *          does not serve them for every plan, so they ride the CLI transport;
 *        - a Go subscription account is served only by `/alpha/generate`;
 *        - everything else uses the Provider API.
 *      The tier comes from the cached billing lookup, so no request is wasted on
 *      a probe. An explicit setting can force either transport.
 *   4. forwards the reasoning level the host chose. The host owns that setting
 *      (it reads the levels this plugin declares), so the plugin passes the value
 *      through instead of keeping a whitelist of its own.
 *
 * Both transports stream: the Provider API is passed through chunk by chunk, and
 * the generate transport is re-encoded into whichever dialect the host spoke.
 *
 * On 429/401 the account is marked and the request is retried on the next account
 * (rotation happens pre-stream only, so a caller never sees a half-written turn).
 */

const http = require("node:http")

const { describeCredentialSource, usableCredential } = require("./auth.js")
const { MAX_ACCOUNT_ROTATIONS } = require("./accounts.js")
const { DEFAULT_API_BASE, runGenerate } = require("./generate.js")
const { decodeAnthropicRequest, decodeOpenAIRequest, createStreamEncoder } = require("./protocol.js")


const DEFAULT_PROVIDER_API_BASE = "https://api.commandcode.ai/provider/v1"
const IDLE_TIMEOUT_MS = 300_000
const HEAD_TIMEOUT_MS = 60_000
const MAX_BODY_BYTES = 32 * 1024 * 1024

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false
  const host = String(hostHeader).replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
  return host === "127.0.0.1" || host === "localhost" || host === "::1"
}

function isLoopbackOrigin(origin) {
  if (!origin) return true
  try {
    const url = new URL(origin)
    // WHATWG URL keeps the brackets on an IPv6 hostname ("[::1]"), so strip them
    // the same way isLoopbackHost does; otherwise an IPv6 origin is refused while
    // the matching Host is allowed.
    const host = url.hostname.replace(/^\[|\]$/g, "")
    return host === "127.0.0.1" || host === "localhost" || host === "::1"
  } catch {
    return false
  }
}

/** A positive millisecond budget, or undefined to keep the default. */
function positiveMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A non-negative retry count, or undefined to keep the default. */
function positiveCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

function bearerFrom(req) {
  const header = req.headers.authorization
  if (typeof header !== "string") return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1] : undefined
}

/**
 * Release an upstream response body we are not going to read.
 *
 * A rotation attempt abandons the response; without this the socket stays open
 * until the garbage collector gets to it, and a burst of rotations leaks handles.
 */
async function drain(response) {
  try {
    await response.body?.cancel()
  } catch {
    // Already consumed or already gone.
  }
}

/**
 * Whether a pool account is worth trying right now.
 *
 * A `disabled` entry failed auth (its key is bad until changed) and a `cooldown`
 * entry is rate-limited until its reset; neither should be retried blind.
 */
function isRetryableNow(state, now = Date.now()) {
  if (!state || typeof state !== "object") return true
  if (state.kind === "disabled") return false
  if (state.kind === "cooldown") return !(state.until > now)
  return true
}

/** Decide whether a Provider API response means "this account needs generate". */
async function isUpgradeRequired(response) {
  if (response.status !== 403) return false
  try {
    const body = await response.clone().json()
    const error = body && typeof body.error === "object" && body.error ? body.error : body
    return error?.code === "upgrade_required"
  } catch {
    return false
  }
}

/**
 * Classify a rejection so the pool can mark the account.
 *
 * 429 is a rate/usage limit; 401 means the credential itself is bad. Both are
 * rotatable; anything else is a real error for the caller.
 */
function classifyRejection(status) {
  if (status === 401) return "invalid-credential"
  if (status === 429) return "rate-limit"
  return undefined
}

/** Read the reset hint a 429 may carry: `error.rateLimit.reset` (seconds) or `resets at <ISO>`. */
async function parseResetHint(response) {
  try {
    const body = await response.clone().json()
    const error = body && typeof body.error === "object" && body.error ? body.error : body
    const limit = error?.rateLimit
    if (limit && typeof limit === "object") {
      const reset = limit.reset
      if (typeof reset === "number" && Number.isFinite(reset) && reset > 0) {
        // Seconds since epoch, or a relative delay — accept both shapes.
        return reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000
      }
      if (typeof reset === "string") {
        const parsed = Date.parse(reset)
        if (!Number.isNaN(parsed)) return parsed
      }
    }
    const message = typeof error?.message === "string" ? error.message : undefined
    const match = message ? /resets?\s+at\s+([^\s;]+)/i.exec(message) : undefined
    if (match) {
      const parsed = Date.parse(match[1])
      if (!Number.isNaN(parsed)) return parsed
    }
  } catch {
    // No body, or not JSON.
  }
  return 0
}

/** The upstream base for account/usage calls, honouring the panel override. */
function apiBaseOf(settings, fallback) {
  const configured = (settings?.apiBase ?? "").trim()
  return (configured || fallback).replace(/\/+$/, "")
}

function createProxy(options) {
  /**
   * Every value the panel can change is held in one mutable holder rather than
   * in consts.
   *
   * Rebinding the loopback server to apply a setting would drop the host's
   * keep-alive connections, and the host would then see ECONNRESET on its next
   * request; updating these in place keeps the endpoint up across edits.
   */
  const live = {
    providerApiBase: (options.providerApiBase ?? DEFAULT_PROVIDER_API_BASE).replace(/\/+$/, ""),
    generateApiBase: (options.generateApiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
    workingDir: options.workingDir ?? process.cwd(),
    headTimeoutMs: positiveMs(options.requestTimeoutMs) ?? HEAD_TIMEOUT_MS,
    idleTimeoutMs: positiveMs(options.streamIdleTimeoutMs) ?? IDLE_TIMEOUT_MS,
    maxRetries: positiveCount(options.transportRetries),
    /** The primary login credential, used by the pool's first slot. */
    primaryCredential: usableCredential(options.credential),
  }
  const extraHeaders = options.extraHeaders ?? {}
  const log = options.log ?? (() => {})
  /** Mutable so the panel can swap the pool without restarting the server. */
  let pool = options.pool

  /**
   * Transport preference:
   *   "auto"     decide per request (Claude -> generate, Go tier -> generate)
   *   "generate" always the CLI transport
   *   "provider" always the Provider API
   */
  let preference = options.transport ?? "auto"
  /** Set once a 403 upgrade_required is seen, so later requests skip the probe. */
  let forcedGenerateKeys = new Set()

  const stats = {
    requests: 0,
    generate: 0,
    provider: 0,
    errors: 0,
    rotations: 0,
    lastTransport: "unknown",
    /**
     * Where the credential of the last request came from.
     *
     * The panel reports this, and the value is always a login: either the
     * plugin's own stored login or a Command Code / pi auth file already on this
     * machine. There is no host-supplied key any more.
     */
    lastCredential: "none",
  }


  /** Ask the host-supplied billing lookup whether this key is a Go-tier account. */
  function isGoTier(key) {
    const access = options.billingAccessFor?.(key)
    return access?.tierWeight === 0
  }

  /**
   * Decide the transport for one request. `modelId` is the Command Code model id.
   */
  function transportFor(modelId, key) {
    if (preference === "generate") return "generate"
    if (preference === "provider") return "provider"
    // Claude ids are served by the Messages endpoint; the CLI transport handles
    // them for every plan, so they take the safe route.
    if (options.requiresMessages?.(modelId) === true) return "generate"
    if (forcedGenerateKeys.has(key)) return "generate"
    if (isGoTier(key)) return "generate"
    return "provider"
  }

  /** Pass the request straight through to Command Code's Provider API. */
  async function proxyToProvider({ res, bodyText, apiKey, dialect, signal }) {
    const path = dialect === "anthropic_messages" ? "/messages" : "/chat/completions"
    const upstream = await fetch(`${live.providerApiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        accept: "text/event-stream",
        ...extraHeaders,
      },
      body: bodyText,
      signal,
    })

    if (await isUpgradeRequired(upstream)) {
      forcedGenerateKeys.add(apiKey)
      await drain(upstream)
      return { upgradeRequired: true }
    }
    const rejection = classifyRejection(upstream.status)
    if (rejection) {
      const resetAt = rejection === "rate-limit" ? await parseResetHint(upstream) : 0
      await drain(upstream)
      return { rejection, resetAt }
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "")
      res.writeHead(upstream.status, { "Content-Type": "application/json" })
      res.end(detail || JSON.stringify({ error: { message: `Upstream error ${upstream.status}` } }))
      return { handled: true }
    }

    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (res.writableEnded) break
        res.write(Buffer.from(chunk))
      }
    }
    res.end()
    return { handled: true }
  }

  /** Serve the request through the legacy generate transport. */
  async function serveWithGenerate({ res, decoded, apiKey, dialect, modelId, signal }) {
    const encoder = createStreamEncoder(dialect, modelId, {
      thinkingEnabled: decoded.thinkingEnabled,
    })
    // The host already resolved the level from its own setting; forward it as-is.
    const reasoningEffort = resolveEffort(decoded.reasoningEffort)

    let headersSent = false
    let preStreamRejection
    const send = (text) => {
      if (!text || res.writableEnded) return
      if (!headersSent) {
        headersSent = true
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        })
      }
      res.write(text)
    }

    try {
      const result = await runGenerate({
        apiKey,
        modelId,
        context: {
          systemPrompt: decoded.systemPrompt,
          messages: decoded.messages,
          tools: decoded.tools,
        },
        maxTokens: decoded.maxTokens,
        temperature: decoded.temperature,
        reasoningEffort,
        allowImages: options.allowImagesForModel?.(modelId) === true,
        sessionId: options.sessionId,
        timeoutMs: live.idleTimeoutMs,
        headTimeoutMs: live.headTimeoutMs,
        maxRetries: live.maxRetries,
        apiBase: live.generateApiBase,
        workingDir: live.workingDir,
        headers: extraHeaders,
        signal,
        emit: (event) => send(encoder.event(event)),
      })
      send(encoder.done(result))
      return { handled: true }
    } catch (error) {
      const status = error?.status
      const rejection = classifyRejection(status)
      // A rejection before any bytes were written can still rotate accounts.
      if (rejection && !headersSent) {
        preStreamRejection = { rejection, resetAt: error.resetAt ?? 0 }
        return { rejection, resetAt: error.resetAt ?? 0 }
      }
      const message =
        error?.name === "AbortError" ? "Request aborted" : String(error?.message ?? error)
      if (error?.name !== "AbortError") {
        stats.errors += 1
        stats.lastError = message
      }
      log(`generate transport failed for ${modelId}: ${message}`)

      // Nothing was written yet, so this can still be a real HTTP error. Reporting
      // it as a 200 with an SSE error event would hide the failure from the host's
      // own error handling, and `handled` would make the caller clear the account's
      // cooldown even though the request failed.
      if (!headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message } }))
        return { handled: true, failed: true }
      }

      send(encoder.error(message))
      return { handled: true, failed: true }
    } finally {
      if (!headersSent && !res.writableEnded && !preStreamRejection) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: stats.lastError ?? "Upstream request failed" } }))
      } else if (headersSent && !res.writableEnded) {
        res.end()
      }
    }
  }

  async function handle(req, res) {
    if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "loopback requests only" } }))
      return
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          ok: true,
          transport: stats.lastTransport,
          preference,
          accounts: pool?.describe?.() ?? [],
          ...stats,
        }),
      )
      return
    }

    // Every declared provider is `authKind: "none"`, so the host sends no
    // Authorization header; a `/pool` prefix is no longer needed to tell the two
    // halves of a declaration apart. `pathname` is just the request path.
    const pathname = url.pathname

    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: options.modelList?.() ?? [] }))
      return
    }

    const dialect = pathname.endsWith("/chat/completions")
      ? "chat_completions"
      : pathname.endsWith("/messages")
        ? "anthropic_messages"
        : undefined

    if (!dialect || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "not found" } }))
      return
    }

    let bodyText
    try {
      bodyText = await readBody(req)
    } catch (error) {
      res.writeHead(413, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: String(error.message) } }))
      return
    }

    let rawBody
    try {
      rawBody = JSON.parse(bodyText)
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "request body is not valid JSON" } }))
      return
    }

    const decoded =
      dialect === "anthropic_messages" ? decodeAnthropicRequest(rawBody) : decodeOpenAIRequest(rawBody)
    const modelId = decoded.model || String(rawBody?.model ?? "")

    // Credential candidates, in order: the pool's choice for this model, the
    // pool's primary login, then any other configured account.
    const hostKey = bearerFrom(req)
    const poolSelectable = typeof pool?.select === "function" ? pool.select(modelId) : undefined

    const candidates = []
    if (poolSelectable) candidates.push(poolSelectable)
    const primary = live.primaryCredential
    if (primary && !candidates.some((entry) => entry.key === primary)) {
      candidates.push({ slot: { id: "primary", label: "已登录账户" }, key: primary, state: {} })
    }
    // A stray Authorization header cannot happen with `authKind: "none"`, but if
    // one arrives it is a usable credential for this origin and worth trying.
    const headerKey = usableCredential(hostKey)
    if (headerKey && !candidates.some((entry) => entry.key === headerKey)) {
      candidates.push({ slot: { id: "header", label: "请求头凭据" }, key: headerKey, state: {} })
    }
    // Fall back to the remaining pool accounts, but skip ones the pool already
    // knows are dead: retrying a 401-disabled key or a cooling-down key just
    // burns an upstream round trip and delays the real answer.
    for (const entry of pool?.resolved?.() ?? []) {
      if (candidates.some((c) => c.key === entry.key)) continue
      if (!isRetryableNow(entry.state)) continue
      candidates.push(entry)
    }

    // Remember where the credential came from, for the panel's diagnostics.
    stats.lastCredential = primary
      ? "login"
      : describeCredentialSource()
    if (candidates.length === 0) {
      stats.errors += 1
      stats.lastError = "no credential"
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          error: {
            message:
              "No Command Code account is signed in. Open the Command Code panel and use the official browser login.",
          },
        }),
      )
      return
    }

    stats.requests += 1

    const controller = new AbortController()
    const onAborted = () => controller.abort()
    req.on("aborted", onAborted)
    res.on("close", () => {
      if (!res.writableEnded) controller.abort()
    })

    try {
      const limit = Math.min(candidates.length, MAX_ACCOUNT_ROTATIONS)
      let lastRejection

      for (let i = 0; i < limit; i++) {
        const account = candidates[i]
        if (controller.signal.aborted) return

        const transport = transportFor(modelId, account.key)
        stats.lastTransport = transport
        log(`request for ${modelId} via ${transport} on account ${account.slot.id}`)

        let outcome
        if (transport === "generate") {
          stats.generate += 1
          outcome = await serveWithGenerate({
            res,
            decoded,
            apiKey: account.key,
            dialect,
            modelId,
            signal: controller.signal,
          })
        } else {
          outcome = await proxyToProvider({
            res,
            bodyText,
            apiKey: account.key,
            dialect,
            signal: controller.signal,
          })
          if (outcome.handled) {
            stats.provider += 1
            pool?.markHealthy?.(account.key)
            return
          }
          if (outcome.upgradeRequired) {
            stats.lastTransport = "generate"
            stats.generate += 1
            outcome = await serveWithGenerate({
              res,
              decoded,
              apiKey: account.key,
              dialect,
              modelId,
              signal: controller.signal,
            })
          }
        }

        if (outcome?.handled) {
          // A failed attempt must not clear the account's cooldown: `markHealthy`
          // is for a request that actually reached the upstream successfully.
          if (outcome.failed !== true) pool?.markHealthy?.(account.key)
          return
        }

        if (outcome?.rejection) {
          lastRejection = outcome
          pool?.markRejected?.(account.key, outcome.rejection, outcome.resetAt)
          stats.rotations += 1
          log(`account ${account.slot.id} rejected (${outcome.rejection}); rotating`)
          continue
        }

        // Anything else already wrote a response.
        return
      }

      // Every candidate was rejected.
      const earliest = pool?.earliestReset?.() ?? 0
      const when = earliest > Date.now() ? new Date(earliest).toLocaleString() : undefined
      stats.errors += 1
      const message =
        lastRejection?.rejection === "invalid-credential"
          ? "Every signed-in Command Code account was rejected: the login is no longer valid. Sign in again in the plugin panel."
          : when
            ? `Every Command Code account is rate limited. The earliest reset is ${when}.`
            : "Every Command Code account is rate limited. Retry shortly."
      stats.lastError = message
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(429, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message } }))
      } else if (!res.writableEnded) {
        res.end()
      }
    } catch (error) {
      stats.errors += 1
      stats.lastError = String(error?.message ?? error)
      log(`request failed: ${stats.lastError}`)
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(502, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: stats.lastError } }))
      } else if (!res.writableEnded) {
        res.end()
      }
    } finally {
      req.off("aborted", onAborted)
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`unhandled proxy error: ${error?.stack ?? error}`)
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: { message: "internal proxy error" } }))
      } else if (!res.writableEnded) {
        res.end()
      }
    })
  })

  return {
    server,
    /** Bind 127.0.0.1, preferring the fixed candidates so the manifest stays valid. */
    listen(candidates) {
      return new Promise((resolve, reject) => {
        const ports = [...new Set(candidates.filter((p) => Number.isInteger(p) && p >= 0))]
        const tryPort = (index) => {
          if (index >= ports.length) {
            reject(new Error("no candidate port could be bound"))
            return
          }
          const onError = (error) => {
            if (error.code === "EADDRINUSE") {
              server.removeListener("listening", onListening)
              tryPort(index + 1)
              return
            }
            reject(error)
          }
          const onListening = () => {
            server.removeListener("error", onError)
            resolve(server.address().port)
          }
          server.once("error", onError)
          server.once("listening", onListening)
          server.listen(ports[index], "127.0.0.1")
        }
        tryPort(0)
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
    stats,
    /** The transport the last request actually used ("unknown" before the first). */
    getTransport: () => stats.lastTransport,
    /** The configured preference: "auto" | "generate" | "provider". */
    getPreference: () => preference,
    setTransport(value) {
      preference = value === "generate" || value === "provider" ? value : "auto"
      forcedGenerateKeys = new Set()
    },
    resetTransport() {
      forcedGenerateKeys = new Set()
    },
    /** Swap in a rebuilt pool after the panel edits accounts. */
    setPool(next) {
      if (next) pool = next
    },
    /**
     * Apply settings that were fixed at construction time.
     *
     * The server is never rebound: the host holds keep-alive connections to this
     * port, and a rebind would reset them mid-session.
     */
    configure(settings) {
      if (!settings) return
      live.generateApiBase = apiBaseOf(settings, DEFAULT_API_BASE)
      live.workingDir = (settings.workingDir ?? "").trim() || process.cwd()
      live.headTimeoutMs = positiveMs(settings.requestTimeoutMs) ?? HEAD_TIMEOUT_MS
      live.idleTimeoutMs = positiveMs(settings.streamIdleTimeoutMs) ?? IDLE_TIMEOUT_MS
      live.maxRetries = positiveCount(settings.transportRetries)
      live.primaryCredential = usableCredential(settings.credential)
    },
    describeCredential: () => describeCredentialSource(),
  }
}

/**
 * The reasoning level to send upstream.
 *
 * PI-Desktop owns this setting: it reads the levels from this plugin's
 * declaration and writes the one the user picked. So the plugin only normalises
 * — `off` (and a missing value) means "leave thinking to the provider" — and
 * forwards everything else untouched. It must not filter against a list of its
 * own, which is exactly the duplicate configuration this plugin used to keep.
 */
function resolveEffort(requested) {
  if (!requested || requested === "off" || requested === "auto") return undefined
  return requested
}

module.exports = {
  DEFAULT_PROVIDER_API_BASE,
  IDLE_TIMEOUT_MS,
  HEAD_TIMEOUT_MS,
  isLoopbackHost,
  isLoopbackOrigin,
  bearerFrom,
  isUpgradeRequired,
  classifyRejection,
  parseResetHint,
  resolveEffort,
  createProxy,
  usableCredential,
}
