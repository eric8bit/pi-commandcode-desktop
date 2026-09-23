/**
 * Command Code model catalog.
 *
 * The live catalog at https://api.commandcode.ai/provider/v1/models lists ids,
 * display names, context windows and which endpoints each model supports, but it
 * carries no image / reasoning / effort metadata. That part comes from the
 * generated CLI capability snapshot in lib/catalog-data.js.
 *
 * Because PI-Desktop reads plugin provider declarations from the manifest before
 * it spawns the plugin process, the model list is published by rewriting this
 * plugin's own manifest.json. A change therefore needs one plugin reload to
 * reach the model picker, which the panel states explicitly.
 *
 * Refreshing is cheap by design: the response is cached together with its
 * `ETag` / `Last-Modified`, and the next fetch is conditional, so an unchanged
 * catalog comes back as a 304 in milliseconds instead of re-downloading a large
 * JSON body.
 */

const { CATALOG, CATALOG_CLI_VERSION } = require("../lib/catalog-data.js")

const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models"
/**
 * Short on purpose: a stalled catalog fetch must not hold a refresh open. The
 * list is cached, so a missed attempt costs nothing.
 */
const DEFAULT_TIMEOUT_MS = 4_000

/** Host-enforced bound: contributes.providers allows at most this many models. */
const MAX_MODELS_PER_PROVIDER = 64

/**
 * The thinking levels the host understands, in its own order.
 *
 * A declaration may only name values from this set: the host filters a binding's
 * levels through its own list (`THINKING_LEVELS.filter(...)`), so anything else
 * is dropped silently and the reasoning menu would come back empty.
 */
const HOST_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Two providers, one per wire protocol Command Code serves.
 *
 * Both are declared `authKind: "none"`: the credential lives in the plugin (the
 * official browser login), and PI-Desktop sends no key. The host treats a `none`
 * provider as ready without a secret, so nothing has to be pasted anywhere.
 */
const PROVIDER_CHAT = "commandcode-chat"
const PROVIDER_CLAUDE = "commandcode-claude"

const CAPABILITY_BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]))

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Claude models are the only ones served exclusively by the Anthropic endpoint. */
function apiStyleForModel(model) {
  const endpoints = Array.isArray(model.endpoints) ? model.endpoints : []
  if (endpoints.includes("/chat/completions")) return "chat_completions"
  return "anthropic_messages"
}

/** Merge one live catalog entry with the generated capability snapshot. */
function mergeModel(live, capability) {
  const contextWindow = positiveInt(live.context_length) ?? capability?.contextWindow ?? 128_000
  const maxTokens = Math.min(
    contextWindow,
    capability?.maxTokens ?? Math.min(contextWindow, 32_000),
  )
  const endpoints = Array.isArray(live.supported_endpoints) ? live.supported_endpoints : []
  return {
    id: String(live.id),
    name: typeof live.name === "string" && live.name.trim() ? live.name : String(live.id),
    contextWindow,
    maxTokens,
    image: capability?.image === true,
    reasoning: capability?.reasoning === true,
    efforts: Array.isArray(capability?.efforts) ? capability.efforts : [],
    endpoints,
    apiStyle: apiStyleForModel({ endpoints }),
  }
}

/**
 * Parse a /provider/v1/models response. Tolerant by design: a single malformed
 * entry must not discard the whole catalog, so bad entries are skipped and
 * reported instead.
 */
function parseModelsResponse(payload) {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : undefined
  if (!data) throw new Error("Command Code model catalog did not contain a data array")

  const models = []
  const skipped = []
  const seen = new Set()

  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      skipped.push("entry without a usable id")
      continue
    }
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    models.push(mergeModel(entry, CAPABILITY_BY_ID.get(entry.id)))
  }

  if (models.length === 0) throw new Error("Command Code returned an empty model catalog")
  models.sort((a, b) => a.id.localeCompare(b.id))
  return { models, skipped }
}

/** Conditional-request headers for a cached catalog, or {} on a cold fetch. */
function conditionalHeaders(cache) {
  if (!cache) return {}
  if (cache.etag) return { "if-none-match": cache.etag }
  if (cache.lastModified) return { "if-modified-since": cache.lastModified }
  return {}
}

/**
 * Fetch the live catalog.
 *
 * `options.cache` (the previously stored `{etag, lastModified}`) turns this into
 * a conditional request. A `304 Not Modified` is a success that carries no body,
 * so it is reported as `{notModified: true}` and the caller reuses its cache.
 * Never throws on a non-2xx; the caller decides.
 */
async function fetchModels(options = {}) {
  const url = options.url ?? DEFAULT_MODELS_URL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onOuterAbort, { once: true })

  try {
    const response = await (options.fetch ?? fetch)(url, {
      headers: { accept: "application/json", ...conditionalHeaders(options.cache) },
      signal: controller.signal,
    })
    if (response.status === 304) {
      return { notModified: true, etag: options.cache?.etag, lastModified: options.cache?.lastModified }
    }
    if (!response.ok) {
      throw new Error(`Command Code model catalog request failed: ${response.status}`)
    }
    const { models, skipped } = parseModelsResponse(await response.json())
    return {
      models,
      skipped,
      // Either validator may be absent; a later request uses whichever exists.
      etag: response.headers?.get?.("etag") ?? undefined,
      lastModified: response.headers?.get?.("last-modified") ?? undefined,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onOuterAbort)
  }
}

/**
 * Read the last successfully cached catalog.
 *
 * Returns `{models, etag, lastModified}` (validators may be undefined), or
 * undefined when nothing usable is stored.
 */
function readCachedCatalog(cachePath, fs) {
  try {
    if (!fs.existsSync(cachePath)) return undefined
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"))
    const models = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : undefined
    if (!models || models.length === 0) return undefined
    const normalized = models
      .filter((m) => isRecord(m) && typeof m.id === "string" && m.id.trim())
      .map((m) => ({
        id: m.id,
        name: typeof m.name === "string" && m.name.trim() ? m.name : m.id,
        contextWindow: positiveInt(m.contextWindow) ?? 128_000,
        maxTokens: positiveInt(m.maxTokens) ?? 32_000,
        image: m.image === true,
        reasoning: m.reasoning === true,
        efforts: Array.isArray(m.efforts) ? m.efforts : [],
        endpoints: Array.isArray(m.endpoints) ? m.endpoints : [],
        apiStyle: m.apiStyle === "anthropic_messages" ? "anthropic_messages" : "chat_completions",
      }))
    if (normalized.length === 0) return undefined
    return {
      models: normalized,
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      lastModified: typeof parsed.lastModified === "string" ? parsed.lastModified : undefined,
    }
  } catch {
    return undefined
  }
}

/** The model list of the cached catalog, for callers that only want that. */
function readCachedModels(cachePath, fs) {
  return readCachedCatalog(cachePath, fs)?.models
}

function writeCachedModels(cachePath, models, fs, validators = {}) {
  try {
    fs.writeFileSync(
      cachePath,
      `${JSON.stringify(
        {
          cliVersion: CATALOG_CLI_VERSION,
          savedAt: new Date().toISOString(),
          etag: validators.etag,
          lastModified: validators.lastModified,
          models,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    )
    return true
  } catch {
    return false
  }
}

/**
 * Load the catalog with offline fallback: a conditional live fetch first, then
 * the cached copy.
 *
 * A `304` costs one round trip and no body, and reports `source:
 * "cache-validated"` so the panel can show that the list was confirmed current
 * rather than downloaded again.
 */
async function loadModels(options) {
  const { cachePath, fs } = options
  const cached = readCachedCatalog(cachePath, fs)
  try {
    const result = await fetchModels({ ...options, cache: cached })
    if (result.notModified) {
      if (!cached) {
        // The server says "unchanged" but we hold nothing to reuse; retry once
        // without validators so the list is actually delivered. A misbehaving
        // proxy can answer 304 even then, so treat a second 304 as a miss
        // instead of returning `models: undefined`.
        const fresh = await fetchModels({ ...options, cache: undefined })
        if (fresh.notModified || !Array.isArray(fresh.models)) {
          return {
            models: [],
            source: "empty",
            warning: "the catalog endpoint kept answering 304 with no cached list to reuse",
          }
        }
        writeCachedModels(cachePath, fresh.models, fs, fresh)
        return {
          models: fresh.models,
          source: "live",
          warning: fresh.skipped?.length ? `${fresh.skipped.length} catalog entry(ies) skipped` : undefined,
        }
      }
      return {
        models: cached.models,
        source: "cache-validated",
        etag: cached.etag,
        lastModified: cached.lastModified,
      }
    }
    writeCachedModels(cachePath, result.models, fs, result)
    return {
      models: result.models,
      source: "live",
      etag: result.etag,
      lastModified: result.lastModified,
      warning: result.skipped?.length
        ? `${result.skipped.length} catalog entry(ies) skipped`
        : undefined,
    }
  } catch (error) {
    if (cached) {
      return {
        models: cached.models,
        source: "cache",
        etag: cached.etag,
        lastModified: cached.lastModified,
        warning: `Live catalog unavailable (${error.message}); using the cached list`,
      }
    }
    return { models: [], source: "empty", warning: error.message }
  }
}

/**
 * Apply the user's panel selections: which models are published, which accept
 * images, and any lowered context-window cap.
 */
function applySelection(models, selection) {
  const enabled = isRecord(selection?.enabled) ? selection.enabled : {}
  const image = isRecord(selection?.image) ? selection.image : {}
  const contextWindow = isRecord(selection?.contextWindow) ? selection.contextWindow : {}
  const hasEnabled = Object.keys(enabled).length > 0

  return models
    .filter((model) => (hasEnabled ? enabled[model.id] === true : true))
    .map((model) => {
      const override = positiveInt(contextWindow[model.id])
      const ctx = override ?? model.contextWindow
      return {
        ...model,
        contextWindow: ctx,
        maxTokens: Math.min(model.maxTokens, ctx),
        image: typeof image[model.id] === "boolean" ? image[model.id] : model.image,
      }
    })
}

/**
 * The thinking levels to publish for one model, or undefined for a model that
 * cannot reason with selectable levels at all.
 *
 * This is the whole "use the host's setting" story: the plugin states which
 * levels exist, the host turns them into the session's reasoning menu and writes
 * `reasoning_effort` / `thinking` itself. The plugin keeps no second copy of the
 * user's choice and forwards whatever it is handed.
 */
function declaredThinkingLevels(model) {
  if (model.reasoning !== true) return undefined
  const efforts = Array.isArray(model.efforts) ? model.efforts : []
  const levels = efforts.filter((level) => HOST_THINKING_LEVELS.includes(level))
  if (levels.length === 0) return undefined
  // `off` always comes first so the menu can turn thinking off.
  return ["off", ...levels.filter((level) => level !== "off")]
}

/**
 * Build the `contributes.providers` entries.
 *
 * `baseUrls` maps an apiStyle to the loopback base the host must call. Models are
 * grouped by apiStyle and capped at the host's per-provider limit; the overflow
 * is reported rather than silently dropped.
 *
 * Each declared model carries `thinkingLevels` / `defaultThinkingLevel`, which is
 * how the host learns what the reasoning menu may offer.
 */
function buildProviderDeclarations(models, baseUrls) {
  const groups = new Map([
    ["chat_completions", []],
    ["anthropic_messages", []],
  ])

  for (const model of models) {
    const list = groups.get(model.apiStyle) ?? groups.get("chat_completions")
    list.push(model)
  }

  const declarations = []
  const truncated = []

  for (const [apiStyle, list] of groups) {
    if (list.length === 0) continue
    const kept = list.slice(0, MAX_MODELS_PER_PROVIDER)
    if (list.length > kept.length) truncated.push(`${apiStyle}: ${list.length - kept.length}`)

    const declaredModels = kept.map((model) => {
      const thinkingLevels = declaredThinkingLevels(model)
      return {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: model.image,
        ...(thinkingLevels
          ? {
              thinkingLevels,
              // The host opens a session on this level when the user has not
              // chosen one, so pick something sensible.
              defaultThinkingLevel: thinkingLevels.includes("medium")
                ? "medium"
                : thinkingLevels[0],
            }
          : {}),
      }
    })
    const claude = apiStyle === "anthropic_messages"

    declarations.push({
      id: claude ? PROVIDER_CLAUDE : PROVIDER_CHAT,
      name: claude ? "Command Code (Claude)" : "Command Code",
      vendorKey: "commandcode",
      baseUrl: baseUrls[apiStyle],
      apiStyle,
      authKind: "none",
      models: declaredModels,
    })
  }

  return { declarations, truncated }
}

module.exports = {
  DEFAULT_MODELS_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_MODELS_PER_PROVIDER,
  HOST_THINKING_LEVELS,
  PROVIDER_CHAT,
  PROVIDER_CLAUDE,
  CATALOG_CLI_VERSION,
  conditionalHeaders,
  parseModelsResponse,
  fetchModels,
  readCachedCatalog,
  readCachedModels,
  writeCachedModels,
  loadModels,
  applySelection,
  declaredThinkingLevels,
  buildProviderDeclarations,
  apiStyleForModel,
}
