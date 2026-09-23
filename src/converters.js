/**
 * Pure conversion helpers for the Command Code /alpha/generate protocol.
 *
 * These mirror the semantics of pi-commandcode-provider's src/converters.ts so
 * the plugin speaks exactly the same wire format, but they are plain CommonJS
 * with no host dependency and no build step.
 */

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value) {
  return typeof value === "string" ? value : undefined
}

function recordArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

function recordOrEmpty(value) {
  if (isRecord(value)) return value
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Streamed tool arguments may be incomplete JSON fragments.
    }
  }
  return {}
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function textContent(message) {
  if (typeof message.content === "string") return message.content
  if (message.content === null || message.content === undefined) return ""
  if (!Array.isArray(message.content)) {
    try {
      return JSON.stringify(message.content) ?? String(message.content)
    } catch {
      return String(message.content)
    }
  }
  return recordArray(message.content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "")
    .join("\n")
}

function imageParts(value) {
  if (isRecord(value)) return value.type === "image" ? [value] : []
  return recordArray(value).filter((part) => part.type === "image")
}

function imageContentError(role) {
  return new Error(`Selected Command Code model does not support image content in ${role}`)
}

function assertTextOnlyMessages(messages) {
  for (const message of messages ?? []) {
    if (message.role !== "toolResult" && imageParts(message.content).length > 0) {
      throw imageContentError(`${message.role} messages`)
    }
  }
}

function imageToCommandCode(part) {
  const data = stringValue(part.data)
  const mimeType = stringValue(part.mimeType)
  if (!data || !mimeType) {
    throw new Error("Invalid image content: expected base64 data and mimeType")
  }
  return { type: "image", image: `data:${mimeType};base64,${data}`, mimeType }
}

function userContentToCommandCode(content, allowImages) {
  if (typeof content === "string") return content
  return recordArray(content).flatMap((part) => {
    if (part.type === "text") return [{ type: "text", text: stringValue(part.text) ?? "" }]
    if (part.type === "image") {
      if (!allowImages) throw imageContentError("user messages")
      return [imageToCommandCode(part)]
    }
    return []
  })
}

function toolCallState(messages) {
  const callIds = new Set()
  const resultIds = new Set()
  for (const message of messages ?? []) {
    if (message.role === "assistant") {
      for (const content of recordArray(message.content)) {
        if (content.type === "toolCall") {
          const id = stringValue(content.id)
          if (id) callIds.add(id)
        }
      }
    } else if (message.role === "toolResult" && message.toolCallId) {
      resultIds.add(message.toolCallId)
    }
  }
  return { callIds, resultIds }
}

/**
 * Convert host messages into the /alpha/generate message shape.
 *
 * /alpha/generate accepts only user, assistant and tool roles. Developer-role
 * messages (which hosts inject mid-conversation to steer the agent) degrade to
 * user rather than being dropped, preserving content and position.
 */
function messagesToCC(messages, options = {}) {
  const allowImages = options.allowImages ?? false
  if (!allowImages) assertTextOnlyMessages(messages)

  const out = []
  const { callIds, resultIds } = toolCallState(messages)
  const rawMessages = messages ?? []

  for (let i = 0; i < rawMessages.length; i++) {
    const message = rawMessages[i]

    if (message.role === "user" || message.role === "developer") {
      out.push({ role: "user", content: userContentToCommandCode(message.content, allowImages) })
      continue
    }

    if (message.role === "assistant") {
      const parts = []
      const missingResults = []
      for (const content of recordArray(message.content)) {
        if (content.type === "text") {
          parts.push({ type: "text", text: stringValue(content.text) ?? "" })
        } else if (content.type === "toolCall") {
          const toolCallId = stringValue(content.id) ?? ""
          const toolName = stringValue(content.name) ?? ""
          if (!toolCallId) continue
          parts.push({
            type: "tool-call",
            toolCallId,
            toolName,
            input: recordOrEmpty(content.arguments),
          })
          if (!resultIds.has(toolCallId)) {
            missingResults.push({
              type: "tool-result",
              toolCallId,
              toolName,
              output: {
                type: "error-text",
                value: "No result — the tool call did not complete (interrupted or lost).",
              },
            })
          }
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts })
      if (missingResults.length > 0) out.push({ role: "tool", content: missingResults })
      continue
    }

    if (message.role === "toolResult") {
      const pendingImages = []
      let j = i
      // Consecutive tool results are batched so interleaved user messages cannot
      // break multi-tool turns ("Tool result is missing").
      for (; j < rawMessages.length && rawMessages[j].role === "toolResult"; j++) {
        const toolMsg = rawMessages[j]
        if (!toolMsg.toolCallId || !callIds.has(toolMsg.toolCallId)) continue
        const images = imageParts(toolMsg.content)
        const text = textContent(toolMsg)
        const outputText =
          text ||
          (images.length > 0 && !allowImages ? "[Image omitted: model does not support images]" : "")
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: toolMsg.toolCallId,
              toolName: toolMsg.toolName,
              output: toolMsg.isError
                ? { type: "error-text", value: outputText }
                : { type: "text", value: outputText },
            },
          ],
        })
        if (images.length > 0 && allowImages) {
          pendingImages.push(...images.map(imageToCommandCode))
        }
      }
      i = j - 1
      // Tool-result images are batched after all tool results for the same reason.
      if (pendingImages.length > 0) out.push({ role: "user", content: pendingImages })
    }
  }

  return out
}

/**
 * Parse one SSE line into an event object. Accepts bare JSON or `data: {...}`,
 * ignores comments, `event:` lines and `[DONE]`.
 */
function parseStreamEventLine(line) {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === "[DONE]") return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function mapFinishReason(reason) {
  if (reason === "tool-calls") return "toolUse"
  if (
    reason === "length" ||
    reason === "max_tokens" ||
    reason === "max-tokens" ||
    reason === "max_output_tokens"
  ) {
    return "length"
  }
  return "stop"
}

function commandCodeErrorMessage(value) {
  if (typeof value === "string") return value
  if (!isRecord(value)) return undefined

  const parts = []
  for (const key of [
    "message",
    "errorMessage",
    "error",
    "detail",
    "details",
    "code",
    "type",
    "reason",
  ]) {
    const part = commandCodeErrorMessage(value[key])
    if (part && !parts.includes(part)) parts.push(part)
  }
  for (const key of ["status", "statusCode", "httpStatus"]) {
    const status = value[key]
    if (typeof status === "string" || typeof status === "number") {
      const statusPart = `status: ${status}`
      if (!parts.includes(statusPart)) parts.push(statusPart)
    }
  }
  return parts.length > 0 ? parts.join(": ") : undefined
}

function promptPartToText(value, depth = 0) {
  if (depth > 10) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((v) => promptPartToText(v, depth + 1))
      .filter(Boolean)
      .join("\n")
  }
  if (!isRecord(value)) return ""
  const text = stringValue(value.text)
  if (text) return text
  const content = promptPartToText(value.content, depth + 1)
  if (content) return content
  return ""
}

function systemPromptToText(value) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((v) => promptPartToText(v, 0))
      .filter(Boolean)
      .join("\n\n")
  }
  return promptPartToText(value, 0)
}

function getEnvironmentInfo() {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`
}

/** Normalize a working directory into the x-project-slug header value. */
function projectSlugFromPath(pathName) {
  const slug = String(pathName ?? "")
    .toLowerCase()
    .replace(/^[a-z]:/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}

/**
 * A JSON Schema is passed through mostly as-is; the generate endpoint rejects
 * `type: [X, "null"]` arrays for some Google models, so those are collapsed to
 * the first non-null member while required fields and literal data are kept.
 */
function normalizeSchemaForGenerate(schema, modelId) {
  if (!isRecord(schema)) return schema
  const isGemini = typeof modelId === "string" && modelId.startsWith("google/gemini-")
  if (!isGemini) return schema

  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit)
    if (!isRecord(node)) return node
    const out = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" && Array.isArray(value)) {
        const nonNull = value.filter((v) => v !== "null")
        out.type = nonNull.length === 1 ? nonNull[0] : nonNull
        continue
      }
      out[key] = visit(value)
    }
    return out
  }
  return visit(schema)
}

function toolsToJson(tools, modelId) {
  if (!Array.isArray(tools)) return []
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    input_schema: normalizeSchemaForGenerate(tool.parameters ?? {}, modelId),
  }))
}

module.exports = {
  isRecord,
  stringValue,
  recordArray,
  recordOrEmpty,
  numberValue,
  textContent,
  imageParts,
  assertTextOnlyMessages,
  messagesToCC,
  parseStreamEventLine,
  mapFinishReason,
  commandCodeErrorMessage,
  systemPromptToText,
  getEnvironmentInfo,
  projectSlugFromPath,
  toolsToJson,
  normalizeSchemaForGenerate,
}
