/**
 * Legacy Command Code transport: POST {apiBase}/alpha/generate.
 *
 * Go subscription accounts are rejected by the Provider API endpoints, so this
 * transport is the fallback that keeps them working. It speaks the same wire
 * format as pi-commandcode-provider's src/core.ts: same request headers, same
 * request body, same SSE event names, same idle-timeout and retry behaviour.
 *
 * Unlike the pi extension this module does not emit pi stream events. It is
 * called by the loopback proxy, so it reports through small callbacks and lets
 * the proxy re-encode the result for whichever wire protocol the host used.
 */

const { randomUUID } = require("node:crypto")

const { CATALOG_CLI_VERSION } = require("../lib/catalog-data.js")
const {
  commandCodeErrorMessage,
  getEnvironmentInfo,
  messagesToCC,
  mapFinishReason,
  numberValue,
  isRecord,
  parseStreamEventLine,
  projectSlugFromPath,
  systemPromptToText,
  toolsToJson,
} = require("./converters.js")

const DEFAULT_API_BASE = "https://api.commandcode.ai"
const DEFAULT_GENERATE_MAX_TOKENS = 64_000
const DEFAULT_MAX_RETRIES = 0
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000
const BASE_RETRY_DELAY_MS = 500

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600)
}

function parseRetryAfterSeconds(value) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000)
  return undefined
}

function effectiveMaxRetryDelayMs(value) {
  if (value === undefined) return DEFAULT_MAX_RETRY_DELAY_MS
  if (value === 0) return Number.POSITIVE_INFINITY
  return value
}

function retryDelayMs(attempt, retryAfterHeader, maxDelayMs) {
  const retryAfterMs = parseRetryAfterSeconds(retryAfterHeader)
  if (retryAfterMs !== undefined) {
    if (retryAfterMs * 1000 > maxDelayMs) return -1
    return retryAfterMs * 1000
  }
  const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt
  const jitter = exponential * 0.2 * Math.random()
  return Math.min(exponential + jitter, maxDelayMs)
}

function abortError(message = "The operation was aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function timeoutError(timeoutMs) {
  return new Error(
    timeoutMs === undefined
      ? "Command Code API request timed out"
      : `Command Code API request timed out after ${timeoutMs}ms`,
  )
}

/**
 * Read the window reset a 429 body may carry, as epoch millis.
 *
 * The CLI reports it as `error.rateLimit.reset` (seconds) or inside the message
 * as `resets at <ISO>`. Both shapes are accepted so the account pool can park the
 * key until the real deadline instead of guessing.
 */
function resetHintFromBody(body) {
  const error = body && typeof body.error === "object" && body.error ? body.error : body
  if (!isRecord(error)) return 0

  const limit = isRecord(error.rateLimit) ? error.rateLimit : undefined
  const raw = limit?.reset
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw > 1e9 ? raw * 1000 : Date.now() + raw * 1000
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }

  const message = typeof error.message === "string" ? error.message : undefined
  const match = message ? /resets?\s+at\s+([^\s;]+)/i.exec(message) : undefined
  if (match) {
    const parsed = Date.parse(match[1])
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

/** Fall back to a `Retry-After` header (seconds or HTTP date). */
function resetHintFromHeader(response) {
  const value = response.headers.get("retry-after")
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Date.now() + seconds * 1000
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(id)
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Accumulates the /alpha/generate SSE stream into an ordered content list while
 * reporting deltas through `emit`. Keeping accumulation here (rather than in the
 * proxy) means both the OpenAI and Anthropic re-encoders see one consistent
 * model of the turn.
 */
function createAccumulator(model, emit) {
  const content = []
  let textBlock
  let textIndex = -1
  let thinkingIndex = -1
  const streamingToolCalls = new Map()
  let finished = false
  let stopReason = "stop"
  let usage = null
  let errorMessage

  function endTextBlock() {
    if (!textBlock) return
    emit({ kind: "text_end", index: textIndex, text: textBlock.text })
    textBlock = undefined
    textIndex = -1
  }

  function endThinking() {
    if (thinkingIndex < 0) return
    const block = content[thinkingIndex]
    if (block && block.type === "thinking") {
      emit({ kind: "thinking_end", index: thinkingIndex, text: block.thinking })
    }
    thinkingIndex = -1
  }

  function handle(event) {
    if (!isRecord(event)) return

    switch (event.type) {
      case "text-delta": {
        endThinking()
        if (!textBlock) {
          textBlock = { type: "text", text: "" }
          content.push(textBlock)
          textIndex = content.length - 1
          emit({ kind: "text_start", index: textIndex })
        }
        const delta = typeof event.text === "string" ? event.text : ""
        textBlock.text += delta
        emit({ kind: "text_delta", index: textIndex, text: delta })
        break
      }

      case "reasoning-start": {
        endTextBlock()
        break
      }

      case "reasoning-delta": {
        endTextBlock()
        const delta = typeof event.text === "string" ? event.text : ""
        if (thinkingIndex < 0) {
          content.push({ type: "thinking", thinking: delta })
          thinkingIndex = content.length - 1
          emit({ kind: "thinking_start", index: thinkingIndex })
        } else {
          const block = content[thinkingIndex]
          if (block && block.type === "thinking") block.thinking += delta
        }
        emit({ kind: "thinking_delta", index: thinkingIndex, text: delta })
        break
      }

      case "reasoning-end": {
        endThinking()
        break
      }

      case "tool-input-start": {
        endTextBlock()
        endThinking()
        const id = typeof event.id === "string" ? event.id : undefined
        if (!id || streamingToolCalls.has(id)) break
        const toolCall = {
          type: "toolCall",
          id,
          name: typeof event.toolName === "string" ? event.toolName : "",
          arguments: {},
        }
        content.push(toolCall)
        const index = content.length - 1
        streamingToolCalls.set(id, { index, toolCall, partialArgs: "" })
        emit({ kind: "toolcall_start", index, toolCall })
        break
      }

      case "tool-input-delta": {
        const id = typeof event.id === "string" ? event.id : undefined
        const delta = typeof event.delta === "string" ? event.delta : undefined
        if (!id || delta === undefined) break
        const active = streamingToolCalls.get(id)
        if (!active) break
        active.partialArgs += delta
        try {
          const parsed = JSON.parse(active.partialArgs)
          if (isRecord(parsed)) active.toolCall.arguments = parsed
        } catch {
          // Incomplete JSON fragment; the tool-call event carries the final args.
        }
        emit({ kind: "toolcall_delta", index: active.index, text: delta })
        break
      }

      case "tool-call": {
        endTextBlock()
        endThinking()
        const id = typeof event.toolCallId === "string" ? event.toolCallId : ""
        const active = streamingToolCalls.get(id)
        const toolCall =
          active?.toolCall ?? {
            type: "toolCall",
            id,
            name: typeof event.toolName === "string" ? event.toolName : "",
            arguments: {},
          }
        if (typeof event.toolName === "string") toolCall.name = event.toolName
        const rawArgs = event.input ?? event.args ?? event.arguments
        if (isRecord(rawArgs)) toolCall.arguments = rawArgs
        else if (typeof rawArgs === "string") {
          try {
            const parsed = JSON.parse(rawArgs)
            if (isRecord(parsed)) toolCall.arguments = parsed
          } catch {
            // Leave the streamed partial arguments in place.
          }
        }

        let index
        if (active) {
          index = active.index
          streamingToolCalls.delete(id)
        } else {
          content.push(toolCall)
          index = content.length - 1
          emit({ kind: "toolcall_start", index, toolCall })
        }
        emit({ kind: "toolcall_end", index, toolCall })
        break
      }

      case "finish": {
        const rawFinishReason = typeof event.rawFinishReason === "string" ? event.rawFinishReason : undefined
        if (rawFinishReason && /^(?:network|connection|upstream)[-_\s]?error$/i.test(rawFinishReason)) {
          throw new Error(
            `Provider finished with reason "${rawFinishReason}" — upstream connection failed mid-stream`,
          )
        }
        if (isRecord(event.totalUsage)) {
          const details = isRecord(event.totalUsage.inputTokenDetails)
            ? event.totalUsage.inputTokenDetails
            : undefined
          const totalInput = numberValue(event.totalUsage.inputTokens) ?? 0
          const cacheRead = numberValue(details?.cacheReadTokens) ?? 0
          const cacheWrite = numberValue(details?.cacheWriteTokens) ?? 0
          const noCache = numberValue(details?.noCacheTokens)
          const input = noCache ?? Math.max(0, totalInput - cacheRead - cacheWrite)
          const output = numberValue(event.totalUsage.outputTokens) ?? 0
          usage = {
            input,
            output,
            cacheRead,
            cacheWrite,
            totalTokens: input + output + cacheRead + cacheWrite,
          }
        }
        stopReason = mapFinishReason(event.finishReason)
        finished = true
        break
      }

      case "abort": {
        throw abortError("Request aborted")
      }

      case "error": {
        const message =
          commandCodeErrorMessage(event.error) ??
          commandCodeErrorMessage(event.message) ??
          "Stream error"
        stopReason = "error"
        errorMessage = message
        throw new Error(message)
      }

      default:
        break
    }
  }
  function seal() {
    endTextBlock()
    endThinking()
    // A tool call that started but never received its `tool-call` event (upstream
    // truncation, or a `finish` straight after `tool-input-start`) still opened a
    // block downstream, so it must be closed or the client sees an unterminated
    // block before the message ends.
    for (const [id, active] of streamingToolCalls) {
      streamingToolCalls.delete(id)
      emit({ kind: "toolcall_end", index: active.index, toolCall: active.toolCall })
    }
    return { content, stopReason, usage, errorMessage }
  }

  return {
    handle,
    seal,
    get finished() {
      return finished
    },
    get stopReason() {
      return stopReason
    },
    get usage() {
      return usage
    },
    get errorMessage() {
      return errorMessage
    },
  }
}

/**
 * Run one /alpha/generate request.
 *
 * @param {object} options
 * @param {string} options.apiKey        resolved Command Code credential
 * @param {string} options.modelId       Command Code model id
 * @param {object} options.context       { systemPrompt, messages, tools }
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @param {string} [options.reasoning]   resolved thinking level
 * @param {object} [options.effortMap]   level -> upstream effort
 * @param {boolean} [options.allowImages]
 * @param {string} [options.sessionId]
 * @param {number} [options.timeoutMs]   idle timeout, reset on every chunk
 * @param {number} [options.maxRetries]
 * @param {number} [options.maxRetryDelayMs]
 * @param {string} [options.apiBase]
 * @param {string} [options.workingDir]
 * @param {object} [options.headers]     extra headers (e.g. x-cmd-zdr)
 * @param {AbortSignal} [options.signal]
 * @param {(event: object) => void} options.emit
 * @param {() => void} [options.onResponse]
 * @returns {Promise<{content: Array, stopReason: string, usage: object|null, errorMessage?: string}>}
 */
async function runGenerate(options) {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")
  const emit = options.emit
  const externalSignal = options.signal

  const accumulator = createAccumulator({ id: options.modelId }, emit)
  const controller = new AbortController()
  let reader

  const abortUpstream = () => {
    if (!controller.signal.aborted) controller.abort()
    try {
      reader?.cancel().catch(() => undefined)
    } catch {
      // Best effort.
    }
  }

  if (externalSignal?.aborted) abortUpstream()
  else externalSignal?.addEventListener("abort", abortUpstream, { once: true })

  try {
    const workingDir = options.workingDir ?? process.cwd()
    const threadId = options.sessionId
      ? isUuid(options.sessionId)
        ? options.sessionId
        : undefined
      : randomUUID()

    const maxTokens = Math.min(
      options.maxTokens ?? DEFAULT_GENERATE_MAX_TOKENS,
      DEFAULT_GENERATE_MAX_TOKENS,
    )

    const body = {
      config: {
        workingDir,
        date: new Date().toISOString().split("T")[0],
        environment: getEnvironmentInfo(),
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      memory: null,
      taste: null,
      skills: null,
      params: {
        model: options.modelId,
        messages: messagesToCC(options.context?.messages, { allowImages: options.allowImages }),
        tools: toolsToJson(options.context?.tools, options.modelId),
        system: systemPromptToText(options.context?.systemPrompt),
        max_tokens: maxTokens,
        stream: true,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      },
      threadId,
    }

    const headTimeoutMs = options.headTimeoutMs
    const requestHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
      "x-command-code-version": CATALOG_CLI_VERSION,
      "x-cli-environment": "production",
      "x-project-slug": projectSlugFromPath(workingDir),
      "x-taste-learning": "true",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
      "User-Agent": "cli",
      ...options.headers,
    }
    const bodyStr = JSON.stringify(body)

    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    const maxRetryDelayMs = effectiveMaxRetryDelayMs(options.maxRetryDelayMs)
    const timeoutMs = options.timeoutMs
    const fetchImpl = options.fetch ?? fetch

    let response
    let finished = false

    retryLoop: for (let attempt = 0; ; attempt++) {
      const attemptController = new AbortController()
      let attemptTimedOut = false
      let attemptTimeoutId

      const clearAttemptTimeout = () => {
        if (attemptTimeoutId !== undefined) {
          clearTimeout(attemptTimeoutId)
          attemptTimeoutId = undefined
        }
      }

      /**
       * The first arm uses the head-of-request budget (time to first byte); every
       * later arm uses the idle budget. A long but active reasoning stream is
       * therefore not cut off, while a connection that never answers still fails.
       */
      let armedForHead = true
      const armAttemptTimeout = () => {
        const budget = armedForHead ? (headTimeoutMs ?? timeoutMs) : timeoutMs
        armedForHead = false
        if (budget === undefined) return
        attemptTimeoutId = setTimeout(() => {
          attemptTimedOut = true
          attemptController.abort()
        }, budget)
      }
      const onOuterAbort = () => attemptController.abort()
      controller.signal.addEventListener("abort", onOuterAbort, { once: true })

      armAttemptTimeout()

      try {
        try {
          response = await fetchImpl(`${apiBase}/alpha/generate`, {
            method: "POST",
            headers: requestHeaders,
            body: bodyStr,
            signal: attemptController.signal,
          })
        } catch (fetchError) {
          if (controller.signal.aborted) throw abortError("Aborted")
          if (attemptTimedOut) {
            if (attempt < maxRetries) continue retryLoop
            throw timeoutError(timeoutMs)
          }
          throw fetchError
        }

        if (!response.ok && isRetryableStatus(response.status)) {
          const retryAfter = response.headers.get("retry-after")
          const waitMs = retryDelayMs(attempt, retryAfter, maxRetryDelayMs)
          if (waitMs < 0) {
            const requestedSeconds = parseRetryAfterSeconds(retryAfter) ?? 0
            const capLabel =
              maxRetryDelayMs === Number.POSITIVE_INFINITY ? "disabled" : `${maxRetryDelayMs}ms`
            throw new Error(`Retry-After delay ${requestedSeconds}s exceeds max ${capLabel}`)
          }
          if (attempt < maxRetries) {
            await response.text().catch(() => "")
            if (waitMs > 0) await delay(waitMs, controller.signal)
            continue retryLoop
          }
        }

        try {
          await options.onResponse?.(response)
        } catch (error) {
          if (attemptTimedOut && attempt < maxRetries) continue retryLoop
          throw error
        }

        if (!response.ok) {
          const errBody = await response.text().catch(() => "")
          let detail
          let parsedBody
          try {
            parsedBody = JSON.parse(errBody)
            detail = commandCodeErrorMessage(parsedBody)
          } catch {
            // Plain-text provider error.
          }
          const fallback = errBody.slice(0, 500) || "Provider returned an error"
          const error = new Error(`Command Code API error ${response.status}: ${detail ?? fallback}`)
          error.status = response.status
          // A 429 may carry the window reset; the account pool uses it as a
          // cooldown deadline instead of guessing.
          if (response.status === 429) {
            const reset = resetHintFromBody(parsedBody) ?? resetHintFromHeader(response)
            if (reset > 0) error.resetAt = reset
          }
          throw error
        }

        reader = response.body?.getReader()
        if (!reader) throw new Error("No response body")

        const decoder = new TextDecoder()
        let buffer = ""

        try {
          readLoop: for (;;) {
            if (controller.signal.aborted) throw abortError("Aborted")
            const { done, value } = await raceAbort(reader.read(), attemptController.signal)
            if (done) {
              clearAttemptTimeout()
              if (buffer.trim()) accumulator.handle(parseStreamEventLine(buffer))
              if (!accumulator.finished) {
                throw new Error(
                  "Stream ended unexpectedly before completion (no finish event) — response was truncated",
                )
              }
              break
            }
            // Reset the idle timeout on every chunk so a long but active
            // reasoning stream is not cut off mid-turn.
            clearAttemptTimeout()
            armAttemptTimeout()
            if (controller.signal.aborted) throw abortError("Aborted")

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""

            for (const line of lines) {
              if (controller.signal.aborted) throw abortError("Aborted")
              accumulator.handle(parseStreamEventLine(line))
              if (accumulator.finished) break readLoop
            }
          }
        } catch (streamError) {
          await reader.cancel().catch(() => {})
          try {
            reader.releaseLock()
          } catch {
            // Already released.
          }
          reader = undefined

          // An idle timeout aborts the attempt controller, which surfaces as an
          // AbortError. Check for the timeout first, or a stalled stream would be
          // reported as a user cancellation.
          if (attemptTimedOut) {
            const canRetry = accumulator.seal().content.length === 0 && attempt < maxRetries
            if (canRetry) continue retryLoop
            throw timeoutError(timeoutMs)
          }
          if (controller.signal.aborted || streamError?.name === "AbortError") throw streamError
          // Never retry after visible content was emitted.
          const canRetry = accumulator.seal().content.length === 0 && attempt < maxRetries
          if (canRetry) {
            const waitMs = retryDelayMs(attempt, null, maxRetryDelayMs)
            if (waitMs > 0) await delay(waitMs, controller.signal)
            continue retryLoop
          }
          throw streamError
        }

        finished = true
        break retryLoop
      } finally {
        controller.signal.removeEventListener("abort", onOuterAbort)
        clearAttemptTimeout()
      }
    }

    if (!finished) throw new Error("Command Code generate request did not complete")
    return accumulator.seal()
  } finally {
    externalSignal?.removeEventListener("abort", abortUpstream)
    try {
      await reader?.cancel()
    } catch {
      // Reader may already be closed.
    }
    try {
      reader?.releaseLock()
    } catch {
      // Already released.
    }
  }
}

module.exports = {
  DEFAULT_API_BASE,
  DEFAULT_GENERATE_MAX_TOKENS,
  isRetryableStatus,
  parseRetryAfterSeconds,
  retryDelayMs,
  isUuid,
  createAccumulator,
  resetHintFromBody,
  resetHintFromHeader,
  runGenerate,
}
