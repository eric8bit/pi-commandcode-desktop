/**
 * Wire-protocol translation between PI-Desktop's provider request formats and
 * the plugin's internal representation.
 *
 * PI-Desktop declares one apiStyle per provider, so the host speaks exactly one
 * of these dialects on a given request:
 *
 *   chat_completions   POST /v1/chat/completions   (OpenAI)
 *   anthropic_messages POST /v1/messages           (Anthropic)
 *
 * Both are decoded into the same internal shape (the one the generate transport
 * and the Provider API already agree on), and results are re-encoded back into
 * whichever dialect the caller used.
 */

const { isRecord, stringValue, recordArray } = require("./converters.js")

/** Level assumed when the host enabled thinking without naming one. */
const DEFAULT_THINKING_EFFORT = "high"

function contentParts(value) {
  if (typeof value === "string") return [{ type: "text", text: value }]
  return recordArray(value)
}

/** `data:image/png;base64,AAAA` -> { mimeType, data } */
function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url ?? ""))
  if (!match) return undefined
  return { mimeType: match[1], data: match[2] }
}

function parseJsonObject(value) {
  if (isRecord(value)) return value
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Tool arguments may be a partial fragment.
    }
  }
  return {}
}

// ---------------------------------------------------------------------------
// Request decoding
// ---------------------------------------------------------------------------

/** Decode an OpenAI chat-completions request body. */
function decodeOpenAIRequest(body) {
  const messages = []
  const systemParts = []

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!isRecord(message)) continue
    const role = stringValue(message.role)

    if (role === "system" || role === "developer") {
      for (const part of contentParts(message.content)) {
        if (part.type === "text") systemParts.push(stringValue(part.text) ?? "")
      }
      continue
    }

    if (role === "user") {
      const parts = []
      for (const part of contentParts(message.content)) {
        if (part.type === "text") {
          parts.push({ type: "text", text: stringValue(part.text) ?? "" })
        } else if (part.type === "image_url") {
          const image = parseDataUrl(isRecord(part.image_url) ? part.image_url.url : part.image_url)
          if (image) parts.push({ type: "image", ...image })
        }
      }
      messages.push({ role: "user", content: parts })
      continue
    }

    if (role === "assistant") {
      const parts = []
      const text = contentParts(message.content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join("")
      if (text) parts.push({ type: "text", text })
      for (const call of recordArray(message.tool_calls)) {
        const fn = isRecord(call.function) ? call.function : {}
        parts.push({
          type: "toolCall",
          id: stringValue(call.id) ?? "",
          name: stringValue(fn.name) ?? "",
          arguments: parseJsonObject(fn.arguments),
        })
      }
      if (parts.length > 0) messages.push({ role: "assistant", content: parts })
      continue
    }

    if (role === "tool") {
      const parts = contentParts(message.content)
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join("\n")
      const images = []
      for (const part of parts) {
        if (part.type === "image_url") {
          const image = parseDataUrl(isRecord(part.image_url) ? part.image_url.url : part.image_url)
          if (image) images.push({ type: "image", ...image })
        }
      }
      messages.push({
        role: "toolResult",
        toolCallId: stringValue(message.tool_call_id) ?? "",
        toolName: stringValue(message.name) ?? "",
        isError: false,
        content: text ? [{ type: "text", text }] : images,
      })
    }
  }

  return {
    model: stringValue(body?.model) ?? "",
    systemPrompt: systemParts.filter(Boolean).join("\n\n"),
    messages,
    tools: decodeOpenAITools(body?.tools),
    maxTokens: numberOrUndefined(body?.max_tokens ?? body?.max_completion_tokens),
    temperature: numberOrUndefined(body?.temperature),
    reasoningEffort: stringValue(body?.reasoning_effort),
    stream: body?.stream !== false,
  }
}

function decodeOpenAITools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => isRecord(tool))
    .map((tool) => {
      const fn = isRecord(tool.function) ? tool.function : tool
      return {
        name: stringValue(fn.name) ?? "",
        description: stringValue(fn.description),
        parameters: fn.parameters ?? {},
      }
    })
    .filter((tool) => tool.name)
}

/** Decode an Anthropic messages request body. */
function decodeAnthropicRequest(body) {
  const systemParts = []
  if (typeof body?.system === "string") systemParts.push(body.system)
  else {
    for (const part of recordArray(body?.system)) {
      if (part.type === "text") systemParts.push(stringValue(part.text) ?? "")
    }
  }

  const messages = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!isRecord(message)) continue
    const role = stringValue(message.role)
    const blocks = contentParts(message.content)

    if (role === "user") {
      // Anthropic returns tool results as user-role blocks; split them out so the
      // internal shape matches the OpenAI decoding path.
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const inner = contentParts(block.content)
          const text = inner
            .filter((part) => part.type === "text")
            .map((part) => stringValue(part.text) ?? "")
            .join("\n")
          const images = []
          for (const part of inner) {
            if (part.type === "image" && isRecord(part.source)) {
              const data = stringValue(part.source.data)
              const mimeType = stringValue(part.source.media_type)
              if (data && mimeType) images.push({ type: "image", mimeType, data })
            }
          }
          messages.push({
            role: "toolResult",
            toolCallId: stringValue(block.tool_use_id) ?? "",
            toolName: "",
            isError: block.is_error === true,
            content: text ? [{ type: "text", text }] : images,
          })
        }
      }

      const parts = []
      for (const block of blocks) {
        if (block.type === "text") {
          parts.push({ type: "text", text: stringValue(block.text) ?? "" })
        } else if (block.type === "image" && isRecord(block.source)) {
          const data = stringValue(block.source.data)
          const mimeType = stringValue(block.source.media_type)
          if (data && mimeType) parts.push({ type: "image", mimeType, data })
        }
      }
      if (parts.length > 0) messages.push({ role: "user", content: parts })
      continue
    }

    if (role === "assistant") {
      const parts = []
      for (const block of blocks) {
        if (block.type === "text") {
          parts.push({ type: "text", text: stringValue(block.text) ?? "" })
        } else if (block.type === "tool_use") {
          parts.push({
            type: "toolCall",
            id: stringValue(block.id) ?? "",
            name: stringValue(block.name) ?? "",
            arguments: parseJsonObject(block.input),
          })
        }
      }
      if (parts.length > 0) messages.push({ role: "assistant", content: parts })
    }
  }

  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((tool) => isRecord(tool))
    .map((tool) => ({
      name: stringValue(tool.name) ?? "",
      description: stringValue(tool.description),
      parameters: tool.input_schema ?? {},
    }))
    .filter((tool) => tool.name)

  const thinking = isRecord(body?.thinking) ? body.thinking : undefined
  // The host writes `enabled` for the classic shape and `adaptive` for models
  // that only take an effort hint; both mean "the user asked for thinking".
  const thinkingEnabled = thinking?.type === "enabled" || thinking?.type === "adaptive"

  return {
    model: stringValue(body?.model) ?? "",
    systemPrompt: systemParts.filter(Boolean).join("\n\n"),
    messages,
    tools,
    maxTokens: numberOrUndefined(body?.max_tokens),
    temperature: numberOrUndefined(body?.temperature),
    reasoningEffort: thinkingEnabled ? effortFromThinking(thinking) : undefined,
    thinkingEnabled,
    stream: body?.stream !== false,
  }
}

/**
 * The thinking level an Anthropic request asked for.
 *
 * This used to be the literal string `"auto"`, which the plugin then forwarded
 * upstream — Command Code does not accept that value, so the level the user
 * picked in PI-Desktop was silently dropped. The host states its choice in one
 * of two shapes: an explicit `thinking.effort`, or a `budget_tokens` budget only.
 */
function effortFromThinking(thinking) {
  const effort = stringValue(thinking?.effort)
  if (effort) return effort
  const budget = numberOrUndefined(thinking?.budget_tokens)
  if (budget === undefined) return DEFAULT_THINKING_EFFORT
  if (budget < 2048) return "low"
  if (budget < 8192) return "medium"
  if (budget < 24576) return "high"
  if (budget < 65536) return "xhigh"
  return "max"
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Response encoding
// ---------------------------------------------------------------------------

function sse(event, data, withEventName) {
  return `${withEventName ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`
}

const STOP_REASON_TO_OPENAI = {
  stop: "stop",
  length: "length",
  toolUse: "tool_calls",
}

const STOP_REASON_TO_ANTHROPIC = {
  stop: "end_turn",
  length: "max_tokens",
  toolUse: "tool_use",
}

/**
 * Encode an internal result as an OpenAI chat-completions SSE stream.
 *
 * `events` is the ordered delta list produced by the generate accumulator, so the
 * stream is written incrementally rather than buffered.
 */
function createOpenAIStreamEncoder(modelId) {
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const created = Math.floor(Date.now() / 1000)
  const toolIndexById = new Map()
  let nextToolIndex = 0

  function chunk(delta, finishReason, usage) {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
      ...(usage ? { usage } : {}),
    }
  }

  /**
   * Map the accumulator's content index to a dense tool_calls index: OpenAI
   * clients require tool_calls[].index to start at 0 and count up per call.
   */
  function toolIndexFor(contentIndex) {
    if (!toolIndexById.has(contentIndex)) toolIndexById.set(contentIndex, nextToolIndex++)
    return toolIndexById.get(contentIndex)
  }

  return {
    /** @returns {string} SSE text for one accumulated event, or "" */
    event(event) {
      switch (event.kind) {
        case "text_delta":
          return sse("", chunk({ content: event.text }), false)

        case "toolcall_start":
          return sse(
            "",
            chunk({
              tool_calls: [
                {
                  index: toolIndexFor(event.index),
                  id: event.toolCall?.id ?? `call_${event.index}`,
                  type: "function",
                  function: { name: event.toolCall?.name ?? "", arguments: "" },
                },
              ],
            }),
            false,
          )

        case "toolcall_delta":
          return sse(
            "",
            chunk({
              tool_calls: [
                { index: toolIndexFor(event.index), function: { arguments: event.text ?? "" } },
              ],
            }),
            false,
          )

        default:
          return ""
      }
    },

    done(result) {
      const finishReason = STOP_REASON_TO_OPENAI[result.stopReason] ?? "stop"
      let out = sse(
        "",
        chunk({}, finishReason, result.usage ? openAIUsage(result.usage) : undefined),
        false,
      )
      out += "data: [DONE]\n\n"
      return out
    },

    error(message) {
      return sse("", { error: { message, type: "upstream_error" } }, false) + "data: [DONE]\n\n"
    },
  }
}

function openAIUsage(usage) {
  return {
    prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
    completion_tokens: usage.output,
    total_tokens: usage.totalTokens,
    ...(usage.cacheRead ? { prompt_tokens_details: { cached_tokens: usage.cacheRead } } : {}),
  }
}

/**
 * Encode an internal result as an Anthropic messages SSE stream.
 *
 * Thinking blocks are only emitted when the request enabled extended thinking,
 * because Anthropic clients reject thinking blocks they did not ask for.
 */
function createAnthropicStreamEncoder(modelId, options = {}) {
  const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const emitThinking = options.thinkingEnabled === true
  let started = false
  let inputTokens = 0

  function start() {
    started = true
    return sse(
      "message_start",
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      true,
    )
  }

  /**
   * The accumulator's content index counts every block it built, including
   * thinking blocks this encoder suppresses. Anthropic clients require block
   * indices to be dense and to start at 0, so each emitted block gets its own
   * counter here, and `openBlocks` guarantees exactly one matching stop.
   */
  const blockIndexByContent = new Map()
  const openBlocks = new Set()
  let nextBlockIndex = 0

  function openBlock(contentIndex, contentBlock) {
    let index = blockIndexByContent.get(contentIndex)
    if (index === undefined) {
      index = nextBlockIndex++
      blockIndexByContent.set(contentIndex, index)
    }
    openBlocks.add(index)
    return sse(
      "content_block_start",
      { type: "content_block_start", index, content_block: contentBlock },
      true,
    )
  }

  function closeBlock(contentIndex) {
    const index = blockIndexByContent.get(contentIndex)
    if (index === undefined || !openBlocks.has(index)) return ""
    openBlocks.delete(index)
    return sse("content_block_stop", { type: "content_block_stop", index }, true)
  }

  function deltaFor(contentIndex, delta) {
    const index = blockIndexByContent.get(contentIndex)
    if (index === undefined) return ""
    return sse(
      "content_block_delta",
      { type: "content_block_delta", index, delta },
      true,
    )
  }

  return {
    event(event) {
      let out = started ? "" : start()

      switch (event.kind) {
        case "thinking_start":
          // A suppressed thinking block must not consume an index or open a block.
          if (!emitThinking) return out
          return out + openBlock(event.index, { type: "thinking", thinking: "" })

        case "thinking_delta":
          if (!emitThinking) return out
          return out + deltaFor(event.index, { type: "thinking_delta", thinking: event.text ?? "" })

        case "thinking_end":
          if (!emitThinking) return out
          return out + closeBlock(event.index)

        case "text_start":
          return out + openBlock(event.index, { type: "text", text: "" })

        case "text_delta":
          // Defensive: open the block if the start event was missed.
          if (!blockIndexByContent.has(event.index)) {
            out += openBlock(event.index, { type: "text", text: "" })
          }
          return out + deltaFor(event.index, { type: "text_delta", text: event.text ?? "" })

        case "text_end":
          return out + closeBlock(event.index)

        case "toolcall_start":
          return (
            out +
            openBlock(event.index, {
              type: "tool_use",
              id: event.toolCall?.id ?? `toolu_${event.index}`,
              name: event.toolCall?.name ?? "",
              input: {},
            })
          )

        case "toolcall_delta":
          return out + deltaFor(event.index, { type: "input_json_delta", partial_json: event.text ?? "" })

        case "toolcall_end":
          return out + closeBlock(event.index)

        default:
          return out
      }
    },

    done(result) {
      let out = started ? "" : start()
      if (result.usage) {
        inputTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite
      }
      out += sse(
        "message_delta",
        {
          type: "message_delta",
          delta: {
            stop_reason: STOP_REASON_TO_ANTHROPIC[result.stopReason] ?? "end_turn",
            stop_sequence: null,
          },
          usage: { input_tokens: inputTokens, output_tokens: result.usage?.output ?? 0 },
        },
        true,
      )
      out += sse("message_stop", { type: "message_stop" }, true)
      return out
    },

    error(message) {
      let out = started ? "" : start()
      out += sse("error", { type: "error", error: { type: "api_error", message } }, true)
      return out
    },
  }
}

/** Build the appropriate encoder for a request dialect. */
function createStreamEncoder(dialect, modelId, options) {
  return dialect === "anthropic_messages"
    ? createAnthropicStreamEncoder(modelId, options)
    : createOpenAIStreamEncoder(modelId)
}

module.exports = {
  DEFAULT_THINKING_EFFORT,
  decodeOpenAIRequest,
  decodeAnthropicRequest,
  effortFromThinking,
  createStreamEncoder,
  createOpenAIStreamEncoder,
  createAnthropicStreamEncoder,
  parseDataUrl,
  STOP_REASON_TO_OPENAI,
  STOP_REASON_TO_ANTHROPIC,
}
