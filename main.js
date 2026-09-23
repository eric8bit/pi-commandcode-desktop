/**
 * Command Code provider for PI-Desktop.
 *
 * PI-Desktop plugins cannot register a provider at runtime: the host reads
 * `contributes.providers` from the manifest before it spawns the plugin process,
 * and it only supports `authKind: api_key | none` (plugin OAuth is rejected).
 * So this plugin:
 *
 *   - publishes its model list by rewriting its own manifest.json;
 *   - runs a loopback HTTP endpoint that the declared providers point at;
 *   - serves every request with a credential obtained through the official
 *     browser login (or a Command Code / pi auth file already on this machine).
 *
 * Two providers are declared because PI-Desktop binds one wire protocol per
 * provider and Command Code splits its catalog across two of them:
 *   Command Code          -> /v1/chat/completions (OpenAI style)
 *   Command Code (Claude) -> /v1/messages         (Anthropic style)
 *
 * Both point at the same loopback server on the same fixed port, which is what
 * lets a single server answer both dialects.
 *
 * Model settings — including the reasoning level — belong to the host: this
 * plugin only declares, per model, which thinking levels exist
 * (`thinkingLevels` / `defaultThinkingLevel`). The host turns that into the
 * session's reasoning menu and writes `reasoning_effort` / `thinking` into the
 * request itself, which this endpoint forwards unchanged.
 */

const fs = require("node:fs")
const path = require("node:path")

const { CATALOG_CLI_VERSION } = require("./lib/catalog-data.js")
const {
  describeCredentialSource,
  readConfiguredCredentialCached,
  usableCredential,
  invalidateCredentialCache,
} = require("./src/auth.js")
const {
  DEFAULT_MODELS_URL,
  MAX_MODELS_PER_PROVIDER,
  applySelection,
  buildProviderDeclarations,
  declaredThinkingLevels,
  loadModels,
  readCachedCatalog,
} = require("./src/catalog.js")
const { createProxy } = require("./src/proxy.js")
const { createAccountPool } = require("./src/accounts.js")
const { requiresMessagesEndpoint, modelVisibleForAnyAccount } = require("./lib/cc-tables.js")
const {
  DEFAULT_API_BASE: DEFAULT_ACCOUNT_API_BASE,
  fetchUsageReport,
  probeAccountWindows,
  fetchBillingAccess,
} = require("./src/usage.js")
const { createLoginFlow } = require("./src/login.js")

/** The one background service declared in the manifest. */

const SERVICE_ID = "provider-host"

/**
 * Fixed candidate ports, in order. The host reads a provider's baseUrl from the
 * manifest before this process starts, so the endpoint must come back to the
 * same port; the second candidate covers the first being taken.
 */
const PORT_CANDIDATES = [41851, 41852]

const COMMANDS = {
  open: "commandcode.open",
  refresh: "commandcode.refresh",
  status: "commandcode.status",
  resetTransport: "commandcode.resetTransport",
}

let pi
let packageRoot = ""
let dataPath = ""
let log = () => {}

const state = {
  /** Merged live+cached catalog, before the user's selection is applied. */
  models: [],
  source: "empty",
  warning: undefined,
  lastSync: undefined,
  port: undefined,
  hostReloadRequired: false,
  started: false,
}

let proxy
let serviceStarted = false
let refreshInFlight
let refreshTimer

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  enabled: true,
  zdr: false,
  transport: "auto",
  catalogRefreshMinutes: 30,
  modelSelection: {},
  /**
   * The primary signed-in account, written by the official browser login.
   * There is no API key: this credential is the login's, and it is the pool's
   * first slot (with this machine's own auth file as a fallback).
   */
  credential: "",
  /** Further signed-in accounts: [{ id, label, credential, userId, userName, keyName, addedAt }]. */
  accounts: [],
  // Pins a model to an account: [{ models: [...], account: "account-1" }].
  modelAccountRules: [],
  preferredAccount: "auto",
  apiBase: "",
  workingDir: "",
  requestTimeoutMs: 0,
  streamIdleTimeoutMs: 0,
  // Matches the upstream provider's DEFAULT_TRANSPORT_MAX_RETRIES.
  transportRetries: 5,
  hideOutOfPlan: false,
  visibleModels: [],
  webSearch: false,
  sidebarQuota: false,
  // Written by the browser login: who signed in and when, for diagnostics.
  lastLogin: {},
}

/**
 * Settings the running endpoint captured when it started.
 *
 * Changing one of these used to require rebuilding the loopback server, which
 * reset the host's keep-alive connections. They are applied in place instead.
 */
const ENDPOINT_SETTINGS = new Set([
  "credential",
  "apiBase",
  "workingDir",
  "requestTimeoutMs",
  "streamIdleTimeoutMs",
  "transportRetries",
])

/**
 * Settings the account pool is built from.
 *
 * Changing one of these rebuilds the pool, which carries its rotation state
 * over, so a cooldown or a disabled account survives the rebuild.
 */
const POOL_SETTINGS = new Set(["credential", "accounts", "preferredAccount", "modelAccountRules"])

async function getSettings() {
  try {
    const stored = (await pi.plugin.getSettings()) || {}
    return { ...DEFAULT_SETTINGS, ...stored }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Credentials of every usable account, primary first.
 *
 * A credential IS the identity of an account here (the pool keys its rotation
 * state by it), so this is what both the pool and the panel iterates.
 */
function configuredCredentials() {
  const settings = state.settingsCache ?? DEFAULT_SETTINGS
  const out = []
  const primary = usableCredential(settings.credential)
  if (primary) out.push(primary)
  for (const entry of settings.accounts ?? []) {
    const credential = usableCredential(entry?.credential ?? entry?.apiKey)
    if (credential && !out.includes(credential)) out.push(credential)
  }
  return out
}

/**
 * Move a settings file written by the API-key era onto the login-only shape.
 *
 * Older versions kept a paste-able key in `apiKey` and per-account
 * `apiKey`/`apiKeyEnv`. Those values are still real credentials for this
 * account, so rather than dropping them they become the primary login and the
 * first account slot. Idempotent: once `apiKey` is gone this does nothing.
 */
async function migrateLegacySettings() {
  const stored = (await pi.plugin.getSettings().catch(() => ({}))) || {}
  const patch = {}

  const legacyPrimary = usableCredential(stored.apiKey)
  if (legacyPrimary && !usableCredential(stored.credential)) {
    patch.credential = legacyPrimary
  }

  const accounts = []
  let changedAccounts = false
  for (const [index, entry] of (stored.accounts ?? []).entries()) {
    if (!entry || typeof entry !== "object") continue
    const credential = usableCredential(entry.credential ?? entry.apiKey)
    // An env-var-only slot has no credential to carry over; it is dropped.
    if (!credential) {
      changedAccounts = true
      continue
    }
    const next = {
      id: typeof entry.id === "string" && entry.id ? entry.id : `account-${index + 1}`,
      label: typeof entry.label === "string" && entry.label ? entry.label : `账户 ${index + 1}`,
      credential,
      ...(entry.userId ? { userId: entry.userId } : {}),
      ...(entry.userName ? { userName: entry.userName } : {}),
      ...(entry.keyName ? { keyName: entry.keyName } : {}),
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : new Date().toISOString(),
    }
    if (entry.credential !== credential || entry.apiKey !== undefined || entry.apiKeyEnv !== undefined) {
      changedAccounts = true
    }
    accounts.push(next)
  }
  if (changedAccounts) patch.accounts = accounts

  // Clear the retired key so it cannot be read as configuration again.
  if (stored.apiKey !== undefined) patch.apiKey = ""

  if (Object.keys(patch).length === 0) return
  await setSettings(patch)
}

async function setSettings(patch) {
  try {
    await pi.plugin.setSettings(patch)
  } catch (error) {
    log(`could not save settings: ${error?.message ?? error}`)
  }
}

// ---------------------------------------------------------------------------
// Manifest declaration
// ---------------------------------------------------------------------------
function baseUrlsForPort(port) {
  return {
    // The host appends /chat/completions to the OpenAI base URL and /v1/messages
    // to the Anthropic one, so the two prefixes differ on purpose.
    chat_completions: `http://127.0.0.1:${port}/v1`,
    anthropic_messages: `http://127.0.0.1:${port}`,
  }
}
/**
 * Write the current provider declaration into this plugin's own manifest.
 *
 * The host validates the manifest and only then spawns the plugin, so a change
 * here takes effect on the next plugin load, not immediately. Callers surface
 * that as `hostReloadRequired`.
 */
function writeDeclaration(declarations) {
  if (!packageRoot) return { ok: false, error: "the plugin package path is unknown" }
  const manifestPath = path.join(packageRoot, "manifest.json")

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  } catch (error) {
    return { ok: false, error: `manifest.json could not be read: ${error.message}` }
  }

  const previous = JSON.stringify(manifest.contributes?.providers ?? [])
  const next = JSON.stringify(declarations)
  if (previous === next) return { ok: true, changed: false, path: manifestPath }

  manifest.contributes = manifest.contributes ?? {}
  manifest.contributes.providers = declarations
  const temporary = `${manifestPath}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    fs.renameSync(temporary, manifestPath)
  } catch (error) {
    return { ok: false, error: `manifest.json could not be written: ${error.message}` }
  }
  return { ok: true, changed: true, path: manifestPath }
}

/**
 * Publish the model list for the current port.
 *
 * A provider whose model list would be empty is dropped from the declaration:
 * the host rejects a provider with zero models, and that would invalidate the
 * whole manifest and take the plugin down.
 */
function syncDeclaration(port) {
  const settings = state.settingsCache ?? DEFAULT_SETTINGS
  let selected = applySelection(state.models, settings.modelSelection)

  // The panel's whitelist narrows what reaches the model picker at all; an
  // empty list means "no whitelist", not "no models".
  const whitelist = Array.isArray(settings.visibleModels) ? settings.visibleModels : []
  if (whitelist.length > 0) {
    const allowed = new Set(whitelist)
    selected = selected.filter((model) => allowed.has(model.id))
  }

  // "Hide out-of-plan models" drops anything the configured accounts cannot
  // reach. It needs a billing lookup, so it only applies once one succeeded.
  if (settings.hideOutOfPlan === true) {
    const access = (state.pool?.resolved?.() ?? [])
      .map((entry) => billingAccessFor(entry.key))
      .filter((value) => value !== undefined)
    if (access.length > 0) {
      selected = selected.filter((model) => modelVisibleForAnyAccount(model.id, access))
    }
  }

  const { declarations, truncated } = buildProviderDeclarations(selected, baseUrlsForPort(port))
  const usable = declarations.filter((entry) => entry.models.length > 0)

  if (usable.length === 0) {
    return { ok: true, changed: false, skipped: true, reason: "no models are enabled" }
  }

  const result = writeDeclaration(usable)
  if (result.changed) state.hostReloadRequired = true
  return { ...result, truncated }
}

// ---------------------------------------------------------------------------
// Catalog lifecycle
// ---------------------------------------------------------------------------

function cachePath() {
  return process.env.COMMANDCODE_MODELS_CACHE ?? path.join(dataPath, "commandcode-models.json")
}

/**
 * Refresh the catalog. Overlapping calls share one request, and a failed refresh
 * keeps the last valid list rather than clearing it.
 */
function refreshModels({ force = false } = {}) {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const loaded = await loadModels({
      url: process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL,
      cachePath: cachePath(),
      fs,
    })

    if (loaded.models.length > 0) {
      state.models = loaded.models
      state.source = loaded.source
      state.warning = loaded.warning
      state.lastSync = new Date().toISOString()
    } else if (!force && state.models.length > 0) {
      // Keep the previous list; only report why the refresh failed.
      state.warning = loaded.warning
    } else {
      state.models = loaded.models
      state.source = loaded.source
      state.warning = loaded.warning
    }

    return { ...loaded, modelCount: state.models.length }
  })()

  // Keep the derived promise: `refreshInFlight.finally(...)` as a bare statement
  // creates a second, unhandled promise, and Node's default
  // `--unhandled-rejections=throw` would take the whole plugin process down
  // instead of just failing the refresh its callers already handle.
  refreshInFlight = refreshInFlight.finally(() => {
    refreshInFlight = undefined
  })
  return refreshInFlight
}

/**
 * Load the cached list immediately so startup does not wait on the network.
 *
 * This is a plain file read, so the model picker is populated before the first
 * refresh even starts.
 */
function loadCachedOnly() {
  const cached = readCachedCatalog(cachePath(), fs)
  if (cached) {
    state.models = cached.models
    state.source = "cache"
    state.lastSync = new Date().toISOString()
  }
  return cached?.models
}

/**
 * Periodically re-read the catalog so newly published models show up without a
 * manual refresh. A change only reaches the host on the next plugin load, so the
 * timer rewrites the manifest and reports that a reload is pending.
 */
function startRefreshTimer(port) {
  stopRefreshTimer()
  const minutes = Number(state.settingsCache?.catalogRefreshMinutes ?? 30)
  if (!Number.isFinite(minutes) || minutes <= 0) return

  refreshTimer = setInterval(
    () => {
      refreshModels()
        .then(() => {
          const sync = syncDeclaration(port)
          if (sync.changed) log("the model list changed; reload the plugin once to apply it")
        })
        .catch((error) => log(`scheduled catalog refresh failed: ${error?.message ?? error}`))
    },
    minutes * 60_000,
  )
  // Do not keep the plugin process alive just for this timer.
  refreshTimer.unref?.()
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }
}

// ---------------------------------------------------------------------------
// Background service
// ---------------------------------------------------------------------------

async function startService({ log: serviceLog } = {}) {
  if (serviceLog) log = serviceLog
  const settings = await getSettings()
  state.settingsCache = settings

  if (!settings.enabled) {
    log("disabled in settings; the provider endpoint will not start")
    return
  }

  const port = await startProxy(settings)
  state.started = true

  // Publish the list for the port we actually bound.
  //
  // On a first run there is nothing cached, so the manifest would stay empty and
  // the plugin would never appear in the model picker. In that case wait for the
  // catalog before declaring; when a cache exists, publish immediately and refresh
  // in the background so startup never blocks on the network.
  if (state.models.length === 0) {
    try {
      await refreshModels({ force: true })
    } catch (error) {
      log(`initial catalog fetch failed: ${error?.message ?? error}`)
    }
  }

  const sync = syncDeclaration(port)
  if (sync.changed) {
    log("the model list changed; reload the plugin once so the host re-reads the manifest")
  }

  refreshModels()
    .then(() => {
      const after = syncDeclaration(port)
      if (after.changed) {
        log("the model list changed after refresh; reload the plugin once to apply it")
      }
    })
    .catch((error) => log(`catalog refresh failed: ${error?.message ?? error}`))

  startRefreshTimer(port)
}

/**
 * Billing access cache, keyed by API key. The transport decision and the plan
 * filter both read it, so it is fetched once per TTL rather than per request.
 */
const billingCache = new Map()
const BILLING_ACCESS_TTL_MS = 10 * 60_000

function billingAccessFor(credential) {
  const hit = billingCache.get(credential)
  if (!hit) return undefined
  if (Date.now() - hit.at >= BILLING_ACCESS_TTL_MS) return undefined
  return hit.value
}

function apiBaseFor(settings) {
  const configured = (settings?.apiBase ?? "").trim()
  if (configured) return configured
  return process.env.COMMANDCODE_GENERATE_BASE ?? DEFAULT_ACCOUNT_API_BASE
}

/** Refresh the billing cache for every configured account (best effort). */
async function refreshBillingAccess() {
  const settings = state.settingsCache ?? DEFAULT_SETTINGS
  const keys = [...new Set((state.pool?.resolved?.() ?? []).map((entry) => entry.key))]
  // One round trip per account, all accounts at once: serially awaited lookups
  // made the first request after a settings change wait for every account.
  await Promise.all(
    keys.map(async (key) => {
      try {
        const value = await fetchBillingAccess({ apiKey: key, apiBase: apiBaseFor(settings) })
        billingCache.set(key, { at: Date.now(), value })
      } catch {
        // A failed lookup leaves the previous value (or none) in place.
      }
    }),
  )
}
/**
 * The option set the proxy is built with.
 *
 * Kept in one place so startup cannot drift from a later reload; anything the
 * panel can change afterwards goes through `proxy.configure` instead.
 */
function proxyOptions(settings) {
  return {
    providerApiBase: process.env.COMMANDCODE_API_BASE,
    generateApiBase: apiBaseFor(settings),
    extraHeaders: settings.zdr ? { "x-cmd-zdr": "1" } : {},
    workingDir: (settings.workingDir ?? "").trim() || process.cwd(),
    log,
    transport: settings.transport ?? "auto",
    pool: state.pool,
    credential: settings.credential,
    requestTimeoutMs: settings.requestTimeoutMs,
    streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
    transportRetries: settings.transportRetries,
    billingAccessFor,
    // Claude ids only answer on the Messages endpoint.
    requiresMessages: (modelId) => requiresMessagesEndpoint(modelId),
    // Only models the catalog marks as vision-capable may carry images.
    allowImagesForModel: (modelId) => state.models.find((m) => m.id === modelId)?.image === true,
    // The host owns the reasoning level (it reads the levels this plugin
    // declares), so there is deliberately no per-model effort map here: the
    // proxy forwards whatever level arrives.
    modelList: () =>
      state.models.map((model) => ({
        id: model.id,
        object: "model",
        name: model.name,
        context_length: model.contextWindow,
      })),
  }
}

async function startProxy(settings) {
  // Rebuild the pool from settings so account edits take effect on reload. The
  // key pasted in the panel is the pool's first slot, which is what makes the
  // plugin-managed providers usable without touching PI-Desktop's own settings.
  rebuildPool(settings)
  proxy = createProxy(proxyOptions(settings))

  const port = await proxy.listen(PORT_CANDIDATES)
  state.port = port
  log(`provider endpoint listening on 127.0.0.1:${port}`)

  // Warm the billing cache so the first request already knows the account tier.
  refreshBillingAccess().catch(() => {})
  return port
}

function stopService() {
  stopRefreshTimer()
  if (proxy) {
    proxy.close().catch(() => {})
    proxy = undefined
  }
  state.started = false
  serviceStarted = false
}

/**
 * Rebuild the account pool from settings.
 *
 * The rotation state (cooldowns and disabled keys) is carried over from the
 * previous pool: the panel rebuilds whenever the key or account list changes,
 * and that is exactly when a 429/401 mark must not be forgotten.
 */
function rebuildPool(settings) {
  state.pool = createAccountPool({
    literal: settings?.credential,
    defaultLabel: "已登录账户",
    accounts: settings?.accounts ?? [],
    state: state.pool?.state,
    // Which account a model should use, applied by the pool's own selection.
    preferredId: settings?.preferredAccount,
    modelRules: settings?.modelAccountRules,
  })
  proxy?.setPool?.(state.pool)
  return state.pool
}

/**
 * Apply settings that used to be fixed when the endpoint started.
 *
 * The server is deliberately *not* restarted: the host keeps live connections to
 * this port, and rebinding would reset them (the host would then see ECONNRESET
 * on its next request). Everything settings-dependent is updated in place.
 */
function applySettingsToProxy(settings) {
  proxy?.configure?.(settings ?? DEFAULT_SETTINGS)
  // The upstream base changed, so cached billing facts are stale.
  billingCache.clear()
  refreshBillingAccess().catch(() => {})
}

/** One in-flight browser login, so a second click joins rather than restarts it. */
let loginFlow

function loginFlowInstance() {
  if (!loginFlow) {
    loginFlow = createLoginFlow({
      apiBase: () => apiBaseFor(state.settingsCache ?? DEFAULT_SETTINGS),
      openExternal: (url) => pi.shell.openExternal(url),
      log,
    })
  }
  return loginFlow
}

/**
 * Run the official browser login and remember the account it delivered.
 *
 * The delivered credential is the account's identity: the pool keys its rotation
 * state by it and every declared provider is `authKind: "none"`, so this is the
 * only credential the plugin will ever send upstream.
 *
 * The first login becomes the primary account. A later login is appended — or,
 * if the same user signs in again, refreshed in place — so re-authenticating
 * after a session expires does not leave a stale duplicate behind.
 */
async function runLogin() {
  try {
    const result = await loginFlowInstance().begin()
    if (!result.ok) return { ok: false, error: result.error }

    const credentials = result.credentials
    const settings = state.settingsCache ?? DEFAULT_SETTINGS
    const identity = {
      userId: credentials.userId,
      userName: credentials.userName,
      keyName: credentials.keyName,
      addedAt: new Date().toISOString(),
    }
    const patch = {
      // Keep the human-readable identity for the panel's diagnostics.
      lastLogin: { ...identity, at: new Date().toISOString() },
    }

    const accounts = [...(settings.accounts ?? [])]
    const existing = accounts.findIndex(
      (entry) => entry?.userId && entry.userId === credentials.userId,
    )
    if (existing >= 0) {
      accounts[existing] = {
        ...accounts[existing],
        credential: credentials.apiKey,
        userName: credentials.userName,
        keyName: credentials.keyName,
      }
      patch.accounts = accounts
    } else if (usableCredential(settings.credential)) {
      // A primary account is already signed in, so this is an extra account.
      accounts.push({
        id: `account-${accounts.length + 1}`,
        label: credentials.userName || credentials.userId || `账户 ${accounts.length + 1}`,
        credential: credentials.apiKey,
        ...identity,
      })
      patch.accounts = accounts
    } else {
      patch.credential = credentials.apiKey
    }

    await setSettings(patch)
    // The login may also have created this machine's own auth file.
    invalidateCredentialCache()
    state.settingsCache = { ...settings, ...patch }
    rebuildPool(state.settingsCache)
    applySettingsToProxy(state.settingsCache)
    log(`browser login stored a credential for ${credentials.userName || credentials.userId}`)
    return { ok: true, credential: "login", userName: credentials.userName }
  } catch (error) {
    log(`browser login failed: ${error?.message ?? error}`)
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Remove one signed-in account, and the primary login when it is the first. */
async function removeAccount(accountId) {
  const settings = state.settingsCache ?? DEFAULT_SETTINGS
  const id = typeof accountId === "string" ? accountId : ""
  let patch

  if (id === "default") {
    patch = { credential: "" }
  } else {
    const accounts = [...(settings.accounts ?? [])]
    const index = accounts.findIndex(
      (entry, position) => (entry?.id ?? `account-${position + 1}`) === id,
    )
    if (index < 0) return { error: `unknown account: ${id}` }
    accounts.splice(index, 1)
    patch = { accounts }
  }

  await setSettings(patch)
  state.settingsCache = { ...settings, ...patch }
  rebuildPool(state.settingsCache)
  applySettingsToProxy(state.settingsCache)
  return buildState()
}


// ---------------------------------------------------------------------------
// Panel bridge
// ---------------------------------------------------------------------------

function buildState() {
  const settings = state.settingsCache ?? DEFAULT_SETTINGS
  // Where the credential came from. The endpoint reports what it last actually
  // used; before the first request, fall back to what the settings show.
  const credential =
    proxy?.stats?.lastCredential && proxy.stats.lastCredential !== "none"
      ? proxy.stats.lastCredential
      : usableCredential(settings.credential)
        ? "login"
        : describeCredentialSource()
  return {
    models: state.models,
    source: state.source,
    warning: state.warning,
    lastSync: state.lastSync,
    port: state.port,
    started: state.started,
    hostReloadRequired: state.hostReloadRequired,
    cliVersion: CATALOG_CLI_VERSION,
    transport: proxy?.getTransport() ?? "unknown",
    preference: proxy?.getPreference?.() ?? settings.transport ?? "auto",
    accounts: state.pool?.describe?.() ?? [],
    stats: proxy?.stats ?? { requests: 0, generate: 0, provider: 0, errors: 0 },
    settings,
    credential,
    // What the reasoning menu is built from: the levels published per model in
    // the manifest. Shown so the panel can prove the host read them.
    thinkingLevelsByModel: Object.fromEntries(
      state.models.map((model) => [model.id, declaredThinkingLevels(model) ?? []]),
    ),
    endpoints: {
      models: process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL,
      providerApi: process.env.COMMANDCODE_API_BASE ?? "https://api.commandcode.ai/provider/v1",
      generate: process.env.COMMANDCODE_GENERATE_BASE ?? "https://api.commandcode.ai",
    },
    maxModelsPerProvider: MAX_MODELS_PER_PROVIDER,
    // How many accounts this machine could use right now, and whether this
    // machine's own Command Code login file is one of them.
    configuredAccounts: configuredCredentials().length,
    localAuthFile: describeCredentialSource() === "local-auth-file",
  }
}

/** One in-flight usage scan, shared by every caller that asks while it runs. */
let usageInFlight

/**
 * Read every account's usage report.
 *
 * All accounts are scanned at once. This used to be a `for … await` loop, which
 * made a refresh with N accounts take N round trips end to end — the single
 * biggest reason the panel felt slow with more than one account.
 */
async function collectUsage() {
  const settings = state.settingsCache ?? DEFAULT_SETTINGS
  const entries = state.pool?.resolved?.() ?? []
  if (entries.length === 0) {
    return { accounts: [], error: "no Command Code account is signed in" }
  }
  const live = state.pool?.describe?.() ?? []
  const accounts = await Promise.all(
    entries.map(async (entry) => {
      const report = await fetchUsageReport({
        apiKey: entry.key,
        apiBase: apiBaseFor(settings),
      })
      const current = live.find((a) => a.id === entry.slot.id)
      return {
        id: entry.slot.id,
        label: entry.slot.label,
        active: current?.usable === true,
        mark:
          current?.cause === "auth"
            ? "invalid-credential"
            : current?.cause === "window"
              ? "rate-limit"
              : "",
        cooldownUntil: current?.cooldownUntil ?? 0,
        report,
      }
    }),
  )
  return { accounts, fetchedAt: Date.now() }
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "cc.state":
      return buildState()
    case "cc.refresh": {
      await refreshModels({ force: true })
      const port = state.port ?? PORT_CANDIDATES[0]
      const sync = syncDeclaration(port)
      return { ...buildState(), sync }
    }

    case "cc.saveModels": {
      const selection = payload?.selection ?? {}
      await setSettings({ modelSelection: selection })
      state.settingsCache = { ...(state.settingsCache ?? DEFAULT_SETTINGS), modelSelection: selection }
      const sync = syncDeclaration(state.port ?? PORT_CANDIDATES[0])
      return { ...buildState(), sync }
    }

    case "cc.setSetting": {
      const key = payload?.key
      // `in` would also match inherited names (`constructor`, `toString`), which
      // would let the panel persist a key the settings schema never defined.
      if (typeof key !== "string" || !Object.hasOwn(DEFAULT_SETTINGS, key)) {
        return { error: `unknown setting: ${key}` }
      }
      await setSettings({ [key]: payload.value })
      state.settingsCache = { ...(state.settingsCache ?? DEFAULT_SETTINGS), [key]: payload.value }
      if (key === "transport") proxy?.setTransport(payload.value)
      if (POOL_SETTINGS.has(key)) {
        // The pool is built at start; rebuild it so a new key, account or routing
        // rule applies without a plugin reload. Cooldowns survive the rebuild:
        // the rotation state is carried over and keyed by resolved API key.
        rebuildPool(state.settingsCache)
      }
      // Anything the endpoint captured at start is applied in place, so the server
      // is never rebound (that would reset the host's keep-alive connections and
      // its next request would fail with ECONNRESET).
      if (ENDPOINT_SETTINGS.has(key)) applySettingsToProxy(state.settingsCache)
      if (key === "catalogRefreshMinutes" && state.port) startRefreshTimer(state.port)
      // The whitelist and the per-model selection both change which models are
      // published, which only reaches the host on the next plugin load.
      if (key === "visibleModels" || key === "hideOutOfPlan") {
        const sync = syncDeclaration(state.port ?? PORT_CANDIDATES[0])
        return { ...buildState(), sync }
      }
      return buildState()
      return buildState()
    }

    case "cc.login": {
      return runLogin()
    }

    case "cc.removeAccount": {
      return removeAccount(payload?.accountId)
    }
    case "cc.resetTransport": {
      proxy?.resetTransport()
      await pi.ui.showToast("Command Code: transport selection reset", "info")
      return buildState()
    }

    case "cc.openLog": {
      return { dataPath }
    }

    case "cc.usage": {
      // Single-flight: the panel asks on open and again on every click, and a
      // second scan while one is running would double the upstream calls to
      // answer with the same numbers.
      if (!usageInFlight) {
        usageInFlight = collectUsage().finally(() => {
          usageInFlight = undefined
        })
      }
      return usageInFlight
    }

    case "cc.probeWindows": {
      const settings = state.settingsCache ?? DEFAULT_SETTINGS
      const entries = state.pool?.resolved?.() ?? []
      const results = await Promise.all(
        entries.map(async (entry) => {
          const probe = await probeAccountWindows({
            apiKey: entry.key,
            apiBase: apiBaseFor(settings),
          })
          // A probe that returns ok proves this account still authenticates, so it
          // may clear even a 401-disabled mark. An exceeded window parks the account
          // clear even a 401-disabled mark. An exceeded window parks the account
          // until its reset; a failed probe never changes the marks.
          if (probe.ok && !probe.exceeded) {
            state.pool?.markHealthy?.(entry.key, { revive: true })
          } else if (probe.ok && probe.exceeded) {
            state.pool?.markRejected?.(entry.key, "rate-limit", probe.resetAt)
          }
          return { id: entry.slot.id, ...probe }
        }),
      )
      return { accounts: state.pool?.describe?.() ?? [], probes: results }
    }

    case "cc.resetAccounts": {
      state.pool?.reset?.()
      await pi.ui.showToast("Command Code: account state reset", "info")
      return buildState()
    }

    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function registerCommands() {
  pi.commands.register({
    id: COMMANDS.open,
    title: "Command Code: Open Panel",
    category: "AI",
    keywords: ["commandcode", "command code", "模型", "provider"],
    run: () => pi.ui.openPanel(),
  })

  pi.commands.register({
    id: COMMANDS.refresh,
    title: "Command Code: Refresh Model List",
    category: "AI",
    keywords: ["commandcode", "refresh", "刷新模型"],
    run: async () => {
      const loaded = await refreshModels({ force: true })
      const sync = syncDeclaration(state.port ?? PORT_CANDIDATES[0])
      const note = sync.changed ? " Reload the plugin once to apply the new list." : ""
      await pi.ui.showToast(
        `Command Code: ${state.models.length} model(s) from ${loaded.source}.${note}`,
        loaded.source === "live" ? "info" : "warning",
      )
    },
  })

  pi.commands.register({
    id: COMMANDS.status,
    title: "Command Code: Show Status",
    category: "AI",
    keywords: ["commandcode", "status", "诊断"],
    run: async () => {
      const info = buildState()
      const lines = [
        `endpoint: 127.0.0.1:${info.port ?? "-"} (${info.started ? "running" : "stopped"})`,
        `catalog: ${info.models.length} model(s), source ${info.source}, CLI ${info.cliVersion}`,
        `transport: ${info.transport}`,
        `credential: ${info.credential}${info.localAuthFile ? " (local auth file)" : ""}`,
        `requests: ${info.stats.requests} (provider ${info.stats.provider}, generate ${info.stats.generate}, errors ${info.stats.errors})`,
      ]
      if (info.warning) lines.push(`warning: ${info.warning}`)
      if (info.hostReloadRequired) lines.push("note: reload the plugin once to apply the model list")
      await pi.ui.showToast(lines.join("\n"), "info")
    },
  })

  pi.commands.register({
    id: COMMANDS.resetTransport,
    title: "Command Code: Reset Transport Selection",
    category: "AI",
    keywords: ["commandcode", "transport", "重置"],
    run: async () => {
      proxy?.resetTransport()
      await pi.ui.showToast("Command Code: transport selection reset", "info")
    },
  })
}

function unregisterCommands() {
  for (const id of Object.values(COMMANDS)) {
    try {
      pi.commands.unregister(id)
    } catch {
      // The host may already have dropped the command.
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

module.exports = {
  /**
   * The host calls `onLoad()` with NO arguments and exposes the plugin API as the
   * global `pi` (see the host's plugin-host-process: `globalThis.pi = buildApi()`
   * followed by `onLoad()`). Read it from there, not from a parameter.
   */
  async onLoad() {
    pi = globalThis.pi
    if (!pi) {
      throw new Error(
        "the host plugin API is unavailable: expected a global `pi` object before onLoad",
      )
    }
    log = (message) => {
      try {
        console.log(`[commandcode] ${message}`)
      } catch {
        // Console may be unavailable in some host contexts.
      }
    }

    packageRoot = __dirname
    try {
      dataPath = await pi.plugin.getDataPath()
      fs.mkdirSync(dataPath, { recursive: true })
    } catch (error) {
      log(`could not resolve the plugin data directory: ${error?.message ?? error}`)
      dataPath = packageRoot
    }

    // Bring a settings file written by the API-key era onto the login-only
    // shape before anything reads it.
    await migrateLegacySettings()
    state.settingsCache = await getSettings()

    // Register the endpoint host first: the host starts declared services right
    // after onLoad returns.
    pi.services.register({
      id: SERVICE_ID,
      start: (context) => {
        serviceStarted = true
        return startService(context)
      },
      stop: () => stopService(),
    })

    registerCommands()

    // Seed the model list from the cache so the panel is useful offline.
    loadCachedOnly()
    log(`loaded ${state.models.length} model(s) from the cache`)
  },

  async onUnload() {
    unregisterCommands()
    stopService()
  },

  onPanelInvoke,
}
