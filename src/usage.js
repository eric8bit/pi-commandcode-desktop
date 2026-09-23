/**
 * Command Code account endpoints.
 *
 * Ported from the upstream provider's `adapter.ts` (the `getUsage` / billing probe
 * path). Four endpoints are read together and each one degrades independently, so
 * a single failing endpoint never blanks the whole panel:
 *
 *   GET /alpha/whoami                              -> account identity + orgId
 *   GET /alpha/usage/summary                       -> request/token/cost totals
 *   GET /alpha/billing/credits                     -> balances + 5h/weekly windows
 *   GET /alpha/billing/subscriptions?orgId=<id>    -> subscription plan
 *
 * The exact field names and the "reported" flags below are load-bearing: a scalar
 * that defaults to 0 while the endpoint omitted the field would render as
 * "0 left, fully consumed", which is a lie. Hence `*Reported`.
 */

const { CATALOG_CLI_VERSION } = require("../lib/catalog-data.js")
const { subscriptionPlanInfo } = require("../lib/cc-tables.js")

const DEFAULT_API_BASE = "https://api.commandcode.ai"
/**
 * Per-endpoint budget. Four endpoints are queried at once, so this is also the
 * worst-case wall clock of one report rather than the sum of four waits.
 */
const ENDPOINT_TIMEOUT_MS = 6_000

/** Subscription statuses the CLI treats as live. */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"])

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(value) {
  return typeof value === "boolean" ? value : undefined
}

/** Headers every account endpoint expects (no project/taste headers here). */
function accountHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "x-command-code-version": CATALOG_CLI_VERSION,
    "x-cli-environment": "production",
    accept: "application/json",
  }
}

/** Fetch one endpoint and parse JSON. Non-2xx / non-object bodies yield no record. */
async function fetchEndpointJson(url, headers, fetchImpl, timeoutMs = ENDPOINT_TIMEOUT_MS) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return { status: response.status }
  let parsed
  try {
    parsed = await response.json()
  } catch {
    return { status: response.status }
  }
  return { status: response.status, ...(isRecord(parsed) ? { record: parsed } : {}) }
}

/** Account identity from `/alpha/whoami`. */
function parseAccountIdentity(whoami) {
  const data = isRecord(whoami?.data) ? whoami.data : whoami
  if (!isRecord(data)) return {}
  const orgId =
    stringValue(data.orgId) ??
    stringValue(data.organizationId) ??
    stringValue(isRecord(data.org) ? data.org.id : undefined)
  const id = stringValue(data.id) ?? stringValue(data.userId) ?? ""
  const name = stringValue(data.name) ?? ""
  const userName = stringValue(data.userName) ?? stringValue(data.username) ?? ""
  if (!id && !name && !userName) return { orgId }
  return { account: { id, name, userName }, orgId }
}

/** Totals from `/alpha/usage/summary`. */
function parseUsageTotals(usage) {
  if (usage === undefined) return undefined
  return {
    totalCount: numberValue(usage.totalCount) ?? 0,
    totalCost: numberValue(usage.totalCost) ?? 0,
    successRate: numberValue(usage.successRate) ?? 0,
    completedCount: numberValue(usage.completedCount) ?? 0,
    failedCount: numberValue(usage.failedCount) ?? 0,
    totalTokensIn: numberValue(usage.totalTokensIn) ?? 0,
    totalTokensOut: numberValue(usage.totalTokensOut) ?? 0,
    totalCredits: numberValue(usage.totalCredits) ?? 0,
    periodBasis: stringValue(usage.periodBasis) ?? "billing-period",
  }
}

/**
 * One window block (`fiveHour` / `weekly`).
 *
 * Returning undefined rather than a zeroed window is deliberate: the panel must
 * not draw a quota row for a window the account never reported, and a zeroed
 * window is indistinguishable from a genuinely uncapped one.
 */
function parseWindowLimit(value) {
  if (!isRecord(value)) return undefined
  return {
    used: numberValue(value.used) ?? 0,
    cap: numberValue(value.cap) ?? 0,
    exceeded: value.exceeded === true,
    resetAt: numberValue(value.resetAt) ?? 0,
  }
}

/** Balances and windows from `/alpha/billing/credits`. */
function parseCreditLimits(credits) {
  if (credits === undefined) return undefined
  const creditsData = isRecord(credits.credits) ? credits.credits : undefined
  const windowLimits = isRecord(credits.windowLimits) ? credits.windowLimits : undefined
  const fiveHour = parseWindowLimit(windowLimits?.fiveHour)
  const weekly = parseWindowLimit(windowLimits?.weekly)
  if (creditsData === undefined && fiveHour === undefined && weekly === undefined) return undefined

  const monthly = numberValue(creditsData?.monthlyCredits)
  const purchased = numberValue(creditsData?.purchasedCredits)
  const free = numberValue(creditsData?.freeCredits)

  return {
    monthlyCredits: monthly ?? 0,
    purchasedCredits: purchased ?? 0,
    freeCredits: free ?? 0,
    // An explicit false means "not reported", not "nothing left".
    monthlyReported: monthly !== undefined,
    purchasedReported: purchased !== undefined,
    freeReported: free !== undefined,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    planId: stringValue(creditsData?.planId),
  }
}

/** Parse a period-end value that may be millis, seconds, or an ISO string. */
function periodEndValue(value) {
  const num = numberValue(value)
  if (num !== undefined) return num > 1e12 ? num : num * 1000
  const str = stringValue(value)
  if (!str) return 0
  const parsed = Date.parse(str)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Account endpoints fetched by one report (whoami, usage, credits, subscriptions). */
const USAGE_ENDPOINT_COUNT = 4

/**
 * Why every endpoint failed at once. Undefined for partial failures, which the
 * per-endpoint list already explains.
 *
 * The endpoint count matters: one 401 among four endpoints is a partial failure
 * and must not be reported as "your credential is invalid".
 */
function classifyTotalFailure(failures, failedStatuses) {
  if (failures.length !== USAGE_ENDPOINT_COUNT) return undefined
  const statuses = failedStatuses.filter((s) => s !== undefined)
  if (statuses.length === USAGE_ENDPOINT_COUNT && statuses.every((s) => s === 401)) {
    return "invalid-key"
  }
  if (statuses.length === USAGE_ENDPOINT_COUNT && statuses.every((s) => s >= 500)) {
    return "service-unavailable"
  }
  if (statuses.length === 0) return "network"
  return undefined
}

/**
 * Read one account's usage report.
 *
 * All four endpoints are queried at once. They used to run as "whoami, then the
 * other three", which cost two round trips per account purely to learn `orgId`
 * for the subscriptions URL. The subscriptions endpoint answers without the
 * parameter too, so the parallel attempt usually succeeds; only when it fails is
 * it retried once with the `orgId` whoami reported.
 *
 * Each endpoint still degrades independently, so one failure never blanks the
 * whole report.
 */
async function fetchUsageReport(options) {
  const apiKey = options.apiKey
  const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? fetch
  const headers = accountHeaders(apiKey)

  const failures = []
  const failedStatuses = []
  const timings = {}

  const getJson = async (path) => {
    const startedAt = Date.now()
    try {
      const { status, record } = await fetchEndpointJson(`${base}${path}`, headers, fetchImpl)
      timings[path] = Date.now() - startedAt
      if (record === undefined) {
        failures.push(`${path}: HTTP ${status}`)
        failedStatuses.push(status)
        return undefined
      }
      return record
    } catch (error) {
      timings[path] = Date.now() - startedAt
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      failedStatuses.push(undefined)
      return undefined
    }
  }

  /**
   * Forget every recorded failure for one endpoint.
   *
   * `failures` and `failedStatuses` are parallel arrays, so they must be spliced
   * together; leaving a stale entry behind would let a retried endpoint count
   * twice toward the four-endpoint total.
   */
  const dropFailure = (endpoint) => {
    for (let index = failures.length - 1; index >= 0; index--) {
      if (!failures[index].startsWith(`${endpoint}:`)) continue
      failures.splice(index, 1)
      failedStatuses.splice(index, 1)
    }
  }


  const report = { failures }
  const startedAt = Date.now()

  const [whoami, usage, credits, subscriptionFirstTry] = await Promise.all([
    getJson("/alpha/whoami"),
    getJson("/alpha/usage/summary"),
    getJson("/alpha/billing/credits"),
    getJson("/alpha/billing/subscriptions"),
  ])

  const { account, orgId } = parseAccountIdentity(whoami)
  if (account !== undefined) report.account = account

  // Only pay for the second attempt when the bare query failed and whoami can
  // still supply the scope the endpoint wanted.
  let subscription = subscriptionFirstTry
  if (subscription === undefined && orgId !== undefined) {
    // Replace the bare attempt's failure rather than appending to it: one
    // endpoint must never contribute two entries, or three failing endpoints
    // could add up to the four-entry total and be misread as "every endpoint
    // rejected the credential" when whoami actually authenticated fine.
    dropFailure("/alpha/billing/subscriptions")
    const scoped = `/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`
    subscription = await getJson(scoped)
  }

  const totals = parseUsageTotals(usage)
  if (totals !== undefined) report.usage = totals

  const limits = parseCreditLimits(credits)
  if (limits !== undefined) report.credits = limits

  // Plan identity: subscriptions is authoritative, credits.planId is the fallback.
  const subData = isRecord(subscription?.data) ? subscription.data : undefined
  const creditsData = isRecord(credits?.credits) ? credits.credits : undefined
  const planId = stringValue(subData?.planId) ?? stringValue(creditsData?.planId)
  if (subData !== undefined || planId !== undefined) {
    const info = planId === undefined ? undefined : subscriptionPlanInfo(planId)
    report.plan = {
      planId: planId ?? "",
      name: info?.name ?? planId ?? "",
      status: stringValue(subData?.status) ?? "",
      monthlyCredits: info?.monthlyCredits ?? null,
      tierWeight: info?.tierWeight,
      currentPeriodEnd: periodEndValue(subData?.currentPeriodEnd),
    }
  }

  const blocked = classifyTotalFailure(failures, failedStatuses)
  if (blocked !== undefined) report.blocked = blocked

  // Wall clock plus the per-endpoint split, so the panel can show that a slow
  // report is one slow endpoint rather than a serial chain.
  report.timings = { total: Date.now() - startedAt, endpoints: timings }

  return report
}

/**
 * Probe one account's real usage windows from `/alpha/billing/credits`.
 *
 * Both published windows are read, not just the five-hour one: an account can
 * have a clear five-hour window and an exhausted weekly quota at the same time,
 * and reading only the shorter one would revive a used-up account on every pass.
 * `exceeded` is therefore true when ANY published window is exceeded, and
 * `resetAt` is the LATEST reset among the exceeded ones — the binding constraint.
 *
 * Returns undefined when the probe itself failed, so a failed probe never
 * changes the pool's marks.
 */
async function probeAccountWindows(options) {
  const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")
  try {
    const { status, record } = await fetchEndpointJson(
      `${base}/alpha/billing/credits`,
      accountHeaders(options.apiKey),
      options.fetch ?? fetch,
    )
    if (record === undefined) return { ok: false, status }
    const limits = parseCreditLimits(record)
    if (!limits) return { ok: false, status }

    const windows = [limits.fiveHour, limits.weekly].filter(Boolean)
    if (windows.length === 0) return { ok: false, status }

    const exceeded = windows.filter((w) => w.exceeded)
    return {
      ok: true,
      status,
      exceeded: exceeded.length > 0,
      resetAt: exceeded.length > 0 ? Math.max(...exceeded.map((w) => w.resetAt)) : 0,
      limits,
    }
  } catch {
    return { ok: false }
  }
}

/** Billing facts needed by the plan filter (mirrors the CLI's createBilling). */
async function fetchBillingAccess(options) {
  const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")
  const fetchImpl = options.fetch ?? fetch
  const headers = accountHeaders(options.apiKey)
  try {
    // Same parallel shape as the usage report: ask everything at once and only
    // scope the subscriptions query when it actually needed the org id.
    const [whoami, subsFirstTry, credits] = await Promise.all([
      fetchEndpointJson(`${base}/alpha/whoami`, headers, fetchImpl),
      fetchEndpointJson(`${base}/alpha/billing/subscriptions`, headers, fetchImpl),
      fetchEndpointJson(`${base}/alpha/billing/credits`, headers, fetchImpl),
    ])
    const { orgId } = parseAccountIdentity(whoami.record)
    let subs = subsFirstTry
    if (subs.record === undefined && orgId !== undefined) {
      subs = await fetchEndpointJson(
        `${base}/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`,
        headers,
        fetchImpl,
      )
    }
    const planId =
      stringValue(subs.record?.data?.planId) ?? stringValue(credits.record?.credits?.planId)
    const info = planId === undefined ? undefined : subscriptionPlanInfo(planId)
    const limits = parseCreditLimits(credits.record)
    return {
      tierWeight: info?.tierWeight,
      planName: info?.name,
      planId,
      // Any on-demand balance lifts the plan gate entirely.
      onDemandCredits: (limits?.purchasedCredits ?? 0) + (limits?.freeCredits ?? 0),
    }
  } catch {
    return undefined
  }
}

module.exports = {
  DEFAULT_API_BASE,
  ENDPOINT_TIMEOUT_MS,
  ACTIVE_SUBSCRIPTION_STATUSES,
  accountHeaders,
  fetchEndpointJson,
  parseAccountIdentity,
  parseUsageTotals,
  parseCreditLimits,
  parseWindowLimit,
  periodEndValue,
  classifyTotalFailure,
  fetchUsageReport,
  probeAccountWindows,
  fetchBillingAccess,
}
