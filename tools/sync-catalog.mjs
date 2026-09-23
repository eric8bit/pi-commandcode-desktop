/**
 * Regenerate lib/catalog-data.js.
 *
 * Two inputs are merged:
 *
 *   1. the live Command Code catalog
 *      https://api.commandcode.ai/provider/v1/models
 *      -> model ids, display names, context windows, supported endpoints
 *
 *   2. a capability snapshot for image input, reasoning flags, effort levels and
 *      output limits. The Provider API does not publish these, and the Command
 *      Code CLI no longer ships them as a static table (it resolves them at
 *      runtime), so they are taken from the community provider package
 *      `pi-commandcode-provider`, which tracks the CLI catalog and is the same
 *      source this plugin was ported from.
 *
 * Usage:
 *   node tools/sync-catalog.mjs                     # fetch the published provider package
 *   node tools/sync-catalog.mjs --from <dir>        # use a local checkout
 *   node tools/sync-catalog.mjs --dry-run           # report without writing
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outFile = join(root, "lib", "catalog-data.js")
const MODELS_URL =
  process.env.COMMANDCODE_MODELS_URL ?? "https://api.commandcode.ai/provider/v1/models"
const SNAPSHOT_PACKAGE = process.env.COMMAND_CODE_SNAPSHOT_PACKAGE ?? "pi-commandcode-provider@latest"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const fromIndex = args.indexOf("--from")
const DEFAULT_MAX_OUTPUT = 32_000

/** Locate the capability snapshot module inside a package or checkout. */
function findSnapshot(dir) {
  const candidates = [
    "src/commandcode-catalog.ts",
    "src/commandcode-catalog.js",
    "dist/commandcode-catalog.js",
    "commandcode-catalog.js",
  ]
  const found = candidates.map((rel) => join(dir, rel)).find((p) => existsSync(p))
  if (!found) {
    throw new Error(
      `no commandcode-catalog module under ${dir}; pass --from <dir> pointing at a pi-commandcode-provider checkout`,
    )
  }
  return found
}

/**
 * Read the snapshot's data tables.
 *
 * The module is TypeScript with `export const X: Readonly<Record<...>> = {...}`
 * declarations, so the annotations are stripped and the literals evaluated
 * rather than imported.
 */
function readSnapshot(dir) {
  const file = findSnapshot(dir)
  let source = readFileSync(file, "utf8")
  source = source.replace(/^export type [^\n]*$/gm, "")
  source = source.replace(/export const ([A-Za-z_]+)[^=]*=/g, "const $1 =")

  const value = new Function(
    `${source}
    return {
      version: typeof COMMAND_CODE_CLI_VERSION === "string" ? COMMAND_CODE_CLI_VERSION : "unknown",
      inputModalities: MODEL_INPUT_MODALITIES,
      reasoning: MODEL_REASONING,
      efforts: MODEL_EFFORTS,
      maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    }`,
  )()

  if (!value.inputModalities || !value.reasoning) {
    throw new Error(`${file} did not expose the expected capability tables`)
  }
  return value
}

function fetchSnapshotPackage() {
  const dir = mkdtempSync(join(tmpdir(), "cc-snapshot-"))
  console.log(`fetching ${SNAPSHOT_PACKAGE} …`)
  execFileSync("npm", ["pack", SNAPSHOT_PACKAGE, "--silent"], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz"))
  if (!tarball) throw new Error("npm pack did not produce a tarball")
  execFileSync("tar", ["-xzf", tarball], { cwd: dir, stdio: "inherit" })
  return join(dir, "package")
}

async function readLiveCatalog() {
  const response = await fetch(MODELS_URL, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`catalog request failed: ${response.status}`)
  const payload = await response.json()
  const data = Array.isArray(payload?.data) ? payload.data : undefined
  if (!data) throw new Error("the catalog response had no data array")
  return data
}

function build(live, snapshot) {
  const models = []
  const skipped = []

  for (const entry of live) {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim()) {
      skipped.push(entry)
      continue
    }
    const id = entry.id
    const contextWindow =
      Number.isInteger(entry.context_length) && entry.context_length > 0
        ? entry.context_length
        : 128_000
    const endpoints = Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints : []
    const modalities = snapshot.inputModalities[id]
    const maxTokens = Math.min(
      contextWindow,
      snapshot.maxOutputTokens?.[id] ?? DEFAULT_MAX_OUTPUT,
    )

    models.push({
      id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
      contextWindow,
      maxTokens,
      image: Array.isArray(modalities) && modalities.includes("image"),
      reasoning: snapshot.reasoning[id] === true,
      efforts: Array.isArray(snapshot.efforts?.[id]) ? snapshot.efforts[id] : [],
      endpoints,
    })
  }

  models.sort((a, b) => a.id.localeCompare(b.id))
  return { models, skipped }
}

function render(snapshotVersion, models) {
  return `/**
 * Generated capability snapshot for Command Code (catalog ${snapshotVersion}).
 *
 * Sources:
 *   - ids, display names, context windows, endpoints: ${MODELS_URL}
 *   - image input, reasoning flags, effort levels, output limits: ${SNAPSHOT_PACKAGE} (${snapshotVersion})
 *
 * Regenerate with: npm run sync:catalog
 * Do not edit by hand.
 */

const CATALOG_CLI_VERSION = ${JSON.stringify(snapshotVersion)}

const CATALOG = ${JSON.stringify(models, null, 2)}

module.exports = { CATALOG_CLI_VERSION, CATALOG }
`
}

const snapshotDir = fromIndex >= 0 && args[fromIndex + 1] ? args[fromIndex + 1] : fetchSnapshotPackage()
const snapshot = readSnapshot(snapshotDir)
const live = await readLiveCatalog()
const { models, skipped } = build(live, snapshot)

const missing = models.filter((m) => !snapshot.inputModalities[m.id] && !snapshot.reasoning[m.id])
const chat = models.filter((m) => m.endpoints.includes("/chat/completions"))
const claude = models.filter((m) => !m.endpoints.includes("/chat/completions"))

console.log(`snapshot:      ${snapshot.version}`)
console.log(`models:        ${models.length}${skipped.length ? ` (${skipped.length} skipped)` : ""}`)
console.log(`vision-capable:${String(models.filter((m) => m.image).length).padStart(4)}`)
console.log(`reasoning:     ${String(models.filter((m) => m.reasoning).length).padStart(4)}`)
console.log(`with efforts:  ${String(models.filter((m) => m.efforts.length > 0).length).padStart(4)}`)
console.log(`endpoints:     ${chat.length} chat/completions, ${claude.length} messages-only`)

if (missing.length > 0) {
  console.log(
    `\nnote: ${missing.length} model(s) have no capability metadata and default to text-only:\n  ${missing
      .map((m) => m.id)
      .join("\n  ")}`,
  )
}

if (dryRun) {
  console.log("\n--dry-run: nothing written")
} else {
  writeFileSync(outFile, render(snapshot.version, models), "utf8")
  console.log(`\nwrote ${outFile}`)
}
