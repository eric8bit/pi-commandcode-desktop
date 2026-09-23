/**
 * Command Code credential resolution.
 *
 * There is no API-key path any more: PI-Desktop never hands this plugin a
 * credential, because every provider it declares uses `authKind: "none"`. A
 * credential therefore comes from one of two places:
 *
 *   1. the official browser login, stored in the plugin's own settings; or
 *   2. a Command Code / pi / Oh My Pi auth file that already exists on this
 *      machine, so a machine that has signed in before keeps working.
 *
 * Reading those files is synchronous disk I/O on a hot path (every request that
 * needs to know whether a fallback exists), so the result is memoised for a
 * short window.
 */

const { existsSync, readFileSync } = require("node:fs")
const { homedir } = require("node:os")
const { join } = require("node:path")

/** How long a resolved fallback credential is reused before re-reading disk. */
const CREDENTIAL_CACHE_TTL_MS = 30_000

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value) {
  return typeof value === "string" ? value : undefined
}

function defaultAuthPaths(home) {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
  ]
}

/**
 * Drop empty values. Unlike the API-key era there are no placeholder strings to
 * reject: the host no longer injects an env-var reference or a
 * "no auth needed" sentinel, because nothing is sent for `authKind: "none"`.
 */
function usableCredential(value) {
  const trimmed = typeof value === "string" ? value.trim() : undefined
  return trimmed ? trimmed : undefined
}

function credentialFromRecord(value) {
  if (!isRecord(value)) return undefined
  const type = stringValue(value.type)
  if (type === "api") return stringValue(value.key)
  if (type === "oauth") return stringValue(value.access)
  return stringValue(value.key) ?? stringValue(value.access)
}

/**
 * Read a credential from the known auth files.
 *
 * The shapes accepted are the ones the CLI and pi have used over time, so an
 * existing login is picked up without the user signing in again.
 */
function readConfiguredCredential(options = {}) {
  const home = options.homeDir ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home)

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!isRecord(parsed)) continue

      const direct = stringValue(parsed.apiKey)
      if (direct) return direct
      const legacy = stringValue(parsed.commandcode)
      if (legacy) return legacy

      // pi stores OAuth credentials as {"commandcode": {"type":"oauth","access":"..."}}.
      // The official Command Code CLI stores API credentials under "command-code".
      const providerKey =
        credentialFromRecord(parsed.commandcode) ?? credentialFromRecord(parsed["command-code"])
      if (providerKey) return providerKey

      const hyphenated = stringValue(parsed["command-code"])
      if (hyphenated) return hyphenated
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }

  return undefined
}

/** Memo holder. `key: undefined` means "no result recorded yet". */
let cache = { at: 0, found: false, key: undefined, home: undefined, paths: undefined }

/**
 * `readConfiguredCredential` behind a short TTL.
 *
 * Callers on the request path only need to know *whether* a fallback exists and
 * what it is; re-reading three files per request was pure latency.
 */
function readConfiguredCredentialCached(options = {}) {
  const home = options.homeDir ?? homedir()
  const paths = options.authPaths ?? defaultAuthPaths(home)
  // Signature of *resolved contents*, not the array reference: a caller that
  // builds a fresh array with the same paths must still hit the memo.
  const signature = `${home}\u0000${paths.join("\u0000")}`
  const now = Date.now()
  if (cache.found && cache.signature === signature && now - cache.at < CREDENTIAL_CACHE_TTL_MS) {
    return cache.key
  }
  const key = usableCredential(readConfiguredCredential({ homeDir: home, authPaths: paths }))
  cache = { at: now, found: true, key, signature }
  return key
}

/** Drop the memo — call after a login writes a credential or a file changes. */
function invalidateCredentialCache() {
  cache = { at: 0, found: false, key: undefined, signature: undefined }
}

function describeCredentialSource(options = {}) {
  return usableCredential(readConfiguredCredentialCached(options)) ? "local-auth-file" : "none"
}

module.exports = {
  CREDENTIAL_CACHE_TTL_MS,
  usableCredential,
  readConfiguredCredential,
  readConfiguredCredentialCached,
  invalidateCredentialCache,
  describeCredentialSource,
  defaultAuthPaths,
}
