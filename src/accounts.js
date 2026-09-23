/**
 * Command Code login-account pool.
 *
 * Ported from the upstream provider's `accounts.ts`. A "pool" is an ordered list of
 * account slots; each slot resolves to a credential obtained through the
 * official browser login, or (for the first slot only) from the machine's own
 * Command Code login file, so a machine that has signed in before works as-is.
 *
 * Rotation rules, in the order the upstream implementation applies them:
 *
 *   1. A per-model rule pins a model to one account (first matching rule wins).
 *   2. Otherwise the configured priority order decides: the first usable slot.
 *   3. A slot rejected with 429/401 is marked and skipped until its cooldown ends
 *      or a window probe shows its quota recovered.
 *
 * State is keyed by the resolved credential, not by slot, so editing a slot's
 * label never loses its cooldown.
 */

const { existsSync, readFileSync } = require("node:fs")
const { homedir } = require("node:os")
const { join } = require("node:path")

/** Hard cap on rotations within one request (one attempt per distinct key). */
const MAX_ACCOUNT_ROTATIONS = 16

/** A cooldown longer than this is not worth waiting for inline. */
const RETRY_MAX_DELAY_MS = 900_000

/**
 * How long a 429 without a reset hint parks an account.
 *
 * Short on purpose: long enough that the next request does not immediately pick
 * the same throttled account, short enough that a blip recovers on its own.
 */
const BARE_THROTTLE_COOLDOWN_MS = 30_000

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value) {
  return typeof value === "string" ? value : undefined
}

/**
 * The auth files the first slot may fall back to.
 *
 * The same three locations `src/auth.js` scans: a machine that signed in with
 * the official CLI, with pi, or with Oh My Pi all count as "already logged in",
 * so the pool and the diagnostics must agree on what they read. Reading only the
 * CLI path here made the panel report a healthy local credential while every
 * request answered 401.
 */
function authFilePaths(home) {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
  ]
}

/**
 * Read a credential from one of the known auth files.
 * Accepts the shapes the CLI and pi have used over time.
 */
function readAuthFileKey(home) {
  for (const path of authFilePaths(home)) {
    const key = readOneAuthFile(path)
    if (key) return key
  }
  return undefined
}

function readOneAuthFile(path) {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    if (!isRecord(parsed)) return undefined
    const direct = stringValue(parsed.apiKey)
    if (direct) return direct
    if (direct) return direct
    const legacy = stringValue(parsed.commandcode)
    if (legacy) return legacy

    for (const key of ["commandcode", "command-code"]) {
      const record = parsed[key]
      if (!isRecord(record)) continue
      const type = stringValue(record.type)
      if (type === "api") return stringValue(record.key)
      if (type === "oauth") return stringValue(record.access)
      const fallback = stringValue(record.key) ?? stringValue(record.access)
      if (fallback) return fallback
    }
    const hyphenated = stringValue(parsed["command-code"])
    if (hyphenated) return hyphenated
  } catch {
    // A malformed auth file must not break startup.
  }
  return undefined
}

function usableKey(value) {
  const trimmed = typeof value === "string" ? value.trim() : undefined
  return trimmed ? trimmed : undefined
}

/**
 * Build the slot list from settings.
 *
 * Slot 0 is the default: the plugin's own primary login, with the machine's own
 * Command Code login file as a fallback. Extra slots come from `accounts`, in
 * the order configured; each holds a credential obtained by a separate browser
 * login.
 */
function buildSlots(options = {}) {
  const home = options.homeDir ?? homedir()

  const slots = [
    {
      id: "default",
      label: options.defaultLabel ?? "Default",
      literal: usableKey(options.literal),
      allowAuthFile: true,
    },
  ]

  for (const [index, entry] of (options.accounts ?? []).entries()) {
    if (!isRecord(entry)) continue
    // `apiKey` is accepted only so settings written by the previous version
    // still resolve; new entries always carry `credential`.
    const literal = usableKey(entry.credential ?? entry.apiKey)
    // A slot without a credential can never resolve.
    if (!literal) continue
    slots.push({
      id: stringValue(entry.id) || `account-${index + 1}`,
      label: stringValue(entry.label) || `Account ${index + 1}`,
      literal,
      allowAuthFile: false,
    })
  }

  return { slots, home }
}

/** Resolve one slot to a credential, or undefined when it has none. */
function resolveSlotKey(slot, home) {
  if (slot.literal) return slot.literal
  if (slot.allowAuthFile) return usableKey(readAuthFileKey(home))
  return undefined
}


function createAccountPool(options = {}) {
  const { slots, home } = buildSlots(options)

  /**
  /**
   * Rotation state keyed by the resolved credential, so relabelling keeps
   * cooldowns.
   *
   * The caller may hand in the map from a previous pool: the panel rebuilds the
   * pool whenever the account list changes, and a rebuild must not forget which
   * accounts are cooling down or disabled.
   */
  const state = options.state ?? new Map()

  /**
   * The panel's per-model routing, captured at construction. `select` falls back
   * to these, so the proxy does not have to pass them on every request.
   */
  const defaultPreferredId = options.preferredId
  const defaultModelRules = Array.isArray(options.modelRules) ? options.modelRules : []

  function stateFor(key) {
    let entry = state.get(key)
    if (!entry) {
      entry = { kind: "unknown", cause: undefined, reason: "", until: 0 }
      state.set(key, entry)
    }
    return entry
  }

  /** Every slot that currently resolves to a credential, in configured order. */
  function resolved() {
    const out = []
    for (const slot of slots) {
      const key = resolveSlotKey(slot, home)
      if (!key) continue
      out.push({ slot, key, state: stateFor(key) })
    }
    return out
  }

  function isUsable(entry, now = Date.now()) {
    const s = entry.state
    if (s.kind === "disabled") return false
    if (s.kind === "cooldown") return s.until <= now
    return true
  }

  /**
   * Pick the account for one request.
   *
   * `model` consults the per-model rules first (first match wins), exactly like
   * the upstream pool; a rule pointing at an unusable account falls through to the
   * normal rotation instead of failing the request.
   */
  function select(model, options = {}) {
    const all = resolved()
    if (all.length === 0) return undefined
    const now = options.now ?? Date.now()

    // Per-call options win over the pool's configured defaults, so a caller can
    // still override what the panel saved.
    const preferredId = options.preferredId ?? defaultPreferredId
    const modelRules = options.modelRules ?? defaultModelRules

    if (preferredId && preferredId !== "auto") {
      const pinned = all.find((entry) => entry.slot.id === preferredId && isUsable(entry, now))
      if (pinned) return pinned
    }

    for (const rule of modelRules ?? []) {
      if (!isRecord(rule) || !Array.isArray(rule.models) || !rule.models.includes(model)) continue
      const hit = all.find((entry) => entry.slot.id === rule.account && isUsable(entry, now))
      if (hit) return hit
      // The rule matched but its account is unavailable: keep rotating.
      break
    }

    const usable = all.filter((entry) => isUsable(entry, now))
    if (usable.length > 0) return usable[0]
    return undefined
  }

  /**
   * 429 with a reset time becomes a cooldown until that moment; a bare 429 gets a
   * short cooldown, because leaving it unmarked would make the pool pick the same
   * throttled account again on the very next request; 401 disables the account
   * until the key changes.
   */
  function markRejected(key, cause, resetAtMs) {
    const entry = stateFor(key)
    if (cause === "invalid-credential") {
      entry.kind = "disabled"
      entry.cause = "auth"
      entry.reason = "invalid credential"
      entry.until = 0
      return
    }
    if (resetAtMs && resetAtMs > Date.now()) {
      entry.kind = "cooldown"
      entry.cause = "window"
      entry.reason = "usage limit"
      entry.until = resetAtMs
      return
    }
    entry.kind = "cooldown"
    entry.cause = "throttle"
    entry.reason = "throttled"
    entry.until = Date.now() + BARE_THROTTLE_COOLDOWN_MS
  }

  /**
   * Clear the mark on one key.
   *
   * A normal success never revives a `disabled` entry: that entry means the key
   * itself was rejected, and a later success is more likely to be a different
   * account's response than proof the key was fixed. `options.revive` is for the
   * one caller that *did* prove it — a window probe that validated this key.
   */
  function markHealthy(key, options = {}) {
    const entry = state.get(key)
    if (!entry) return
    if (entry.kind === "disabled" && options.revive !== true) return
    entry.kind = "unknown"
    entry.cause = undefined
    entry.reason = ""
    entry.until = 0
  }

  function reset() {
    state.clear()
  }

  /**
   * The earliest moment any marked account could become usable again, used to
   * tell the user when to retry once everything is exhausted.
   */
  function earliestReset(now = Date.now()) {
    const pending = []
    for (const entry of resolved()) {
      const s = entry.state
      if (s.kind === "cooldown" && s.until > now) pending.push(s.until)
    }
    if (pending.length === 0) return 0
    return Math.min(...pending)
  }

  /** Snapshot for the panel: every slot, whether usable, and why not. */
  function describe(now = Date.now()) {
    return slots.map((slot) => {
      const key = resolveSlotKey(slot, home)
      if (!key) {
        return { id: slot.id, label: slot.label, configured: false, usable: false, state: "unconfigured" }
      }
      const s = stateFor(key)
      return {
        id: slot.id,
        label: slot.label,
        configured: true,
        usable: isUsable({ state: s }, now),
        state: s.kind,
        cause: s.cause,
        reason: s.reason,
        cooldownUntil: s.kind === "cooldown" ? s.until : 0,
      }
    })
  }

  return {
    MAX_ACCOUNT_ROTATIONS,
    RETRY_MAX_DELAY_MS,
    resolved,
    select,
    markRejected,
    markHealthy,
    earliestReset,
    describe,
    reset,
    /** The live rotation state, so a rebuilt pool can carry it over. */
    state,
    count: () => resolved().length,
  }
}

module.exports = {
  MAX_ACCOUNT_ROTATIONS,
  RETRY_MAX_DELAY_MS,
  usableKey,
  readAuthFileKey,
  buildSlots,
  createAccountPool,
}
