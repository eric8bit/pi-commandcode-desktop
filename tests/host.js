/**
 * Integration test: load the real plugin entry (main.js) against a stubbed
 * PI-Desktop host API, start its declared service, and drive chat requests
 * through the loopback endpoint.
 *
 * This is what catches wiring mistakes the unit tests cannot see: a wrong
 * lifecycle export name, a service that never starts, or a manifest declaration
 * that would not satisfy the host's validator.
 *
 * The contract under test is the login-only one: both declared providers are
 * `authKind: "none"`, so PI-Desktop never sends an Authorization header, and the
 * credential is the one the official browser login stored (or, failing that, an
 * auth file already on this machine). There is no API key anywhere.
 *
 * Run: node tests/host.js
 */

const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const pluginRoot = path.resolve(__dirname, "..")

/**
 * The reasoning levels the host understands, in its own order.
 *
 * A declaration may name nothing else: the host filters a model's levels through
 * its own list, so an unknown value would be dropped silently and the model's
 * reasoning menu would come back empty.
 */
const HOST_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * Unload the plugin and wait until its loopback endpoint has really released the
 * port.
 *
 * main.js closes the server without awaiting it, and every block here reuses the
 * same two fixed candidate ports, so a fixed sleep would be a race.
 */
async function stopPlugin(plugin) {
  await plugin.onUnload()
  const { PORT_CANDIDATES } = readPortCandidates()
  for (const port of PORT_CANDIDATES) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await portIsOpen(port))) break
      await sleep(20)
    }
  }
}

/** The fixed ports main.js prefers, read from the plugin (never hard-coded twice). */
function readPortCandidates() {
  const source = fs.readFileSync(path.join(pluginRoot, "main.js"), "utf8")
  const match = /const PORT_CANDIDATES = \[([^\]]*)\]/.exec(source)
  const ports = match
    ? match[1]
        .split(",")
        .map((entry) => Number(entry.trim()))
        .filter((port) => Number.isInteger(port))
    : []
  return { PORT_CANDIDATES: ports }
}

/** Whether something is listening on 127.0.0.1:port. */
function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = require("node:net").connect({ port, host: "127.0.0.1" })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}


/**
 * Copy the plugin into a scratch directory so the manifest rewrite does not touch
 * the working tree, then load it with a fake host API.
 *
 * NOTE: `cc.setSetting` for a *known* key cannot be exercised from here. main.js's
 * handler reaches `POOL_SETTINGS.has(key)`, and that set is not declared anywhere
 * in the plugin (ReferenceError), so every write through the panel channel throws.
 * The routing/whitelist settings are therefore driven the way the host does it on
 * a reload: through the stored settings this stub hands back.
 */
function makeHostEnvironment({ upstreamPort, settings = {}, onOpenExternal } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-"))
  const root = path.join(dir, "plugin")
  fs.cpSync(pluginRoot, root, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}tests`) && !src.includes("node_modules"),
  })

  const dataPath = path.join(dir, "data")
  const homeDir = path.join(dir, "home")
  fs.mkdirSync(dataPath, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })

  const calls = { commands: [], services: [], toasts: [], panels: 0, opened: [] }
  const stored = { ...settings }
  const pi = {
    plugin: {
      getId: () => "local.pi-commandcode-desktop",
      getManifest: () => JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")),
      getSettings: async () => ({ ...stored }),
      setSettings: async (patch) => Object.assign(stored, patch),
      getDataPath: async () => dataPath,
    },
    commands: {
      register: (command) => {
        assert.equal(typeof command.run, "function", "a registered command needs a run function")
        calls.commands.push(command.id)
      },
      unregister: (id) => {
        calls.commands = calls.commands.filter((entry) => entry !== id)
      },
    },
    ui: {
      openPanel: async () => {
        calls.panels += 1
      },
      showToast: async (message, level) => calls.toasts.push({ message, level }),
    },
    services: {
      register: (service) => calls.services.push(service),
    },
    shell: {
      // The plugin opens the Studio authorization page through the host.
      openExternal: async (url) => {
        calls.opened.push(url)
        if (onOpenExternal) await onOpenExternal(url)
      },
    },
  }

  // Point the plugin at the mock upstream through its documented env overrides.
  process.env.COMMANDCODE_API_BASE = `http://127.0.0.1:${upstreamPort}/provider/v1`
  process.env.COMMANDCODE_GENERATE_BASE = `http://127.0.0.1:${upstreamPort}`
  process.env.COMMANDCODE_MODELS_URL = `http://127.0.0.1:${upstreamPort}/provider/v1/models`
  process.env.COMMANDCODE_MODELS_CACHE = path.join(dataPath, "commandcode-models.json")

  // Run hermetically: a fresh home directory so this machine's own auth files are
  // never consulted, and no key-shaped environment variable left over from the
  // API-key era can leak in.
  delete process.env.COMMAND_CODE_API_KEY
  delete process.env.COMMANDCODE_API_KEY
  process.env.USERPROFILE = homeDir
  process.env.HOME = homeDir

  return { dir, root, dataPath, homeDir, pi, calls, stored }
}

function startUpstream(mode) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body })
      if (req.url === "/provider/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            data: [
              {
                id: "gpt-5.6-luna",
                name: "GPT-5.6 Luna",
                context_length: 1050000,
                supported_endpoints: ["/chat/completions"],
              },
              {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                context_length: 1000000,
                supported_endpoints: ["/messages"],
              },
            ],
          }),
        )
        return
      }
      if (req.url.startsWith("/provider/v1/")) {
        if (mode === "go") {
          res.writeHead(403, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: { code: "upgrade_required" } }))
          return
        }
        // `throttleKey` lets a test make one specific account hit a 429, and
        // `throttleFor` lets it throttle whatever credential shows up.
        const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")
        const throttled =
          (server.throttleKey && presented === server.throttleKey) ||
          (typeof server.throttleFor === "function" && server.throttleFor(presented) === true)
        if (throttled) {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" })
          res.end(JSON.stringify({ error: { message: "rate limited" } }))
          return
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
        res.end("data: [DONE]\n\n")
        return
      }
      if (req.url === "/alpha/whoami") {
        // What the login flow validates a delivered credential against.
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ userId: "user_1", userName: "Tester" }))
        return
      }
      if (req.url === "/alpha/generate") {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ type: "text-delta", text: "generated" })}\n\n`)
        res.write(`data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n\n`)
        res.end()
        return
      }
      res.writeHead(404)
      res.end("{}")
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }))
  })
}

/** Read a provider declaration out of a plugin copy. */
function readProviders(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))
  return manifest.contributes?.providers ?? []
}

/** A required field set for the host's plugin-provider validator. */
function assertDeclarationIsHostValid(manifest) {
  const providers = manifest.contributes?.providers ?? []
  assert.ok(Array.isArray(providers), "contributes.providers must be an array")
  assert.ok(providers.length > 0, "at least one provider should be declared")
  assert.ok(providers.length <= 8, "at most 8 providers are allowed")

  const API_STYLES = [
    "chat_completions",
    "opencode_go",
    "responses",
    "anthropic_messages",
    "google_generative_ai",
    "openai_codex_responses",
    "pi_messages",
  ]
  const AUTH_KINDS = ["api_key", "none"]
  const ids = new Set()

  for (const provider of providers) {
    assert.match(provider.id, /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, `bad provider id ${provider.id}`)
    assert.ok(!ids.has(provider.id), `duplicate provider id ${provider.id}`)
    ids.add(provider.id)
    assert.ok(provider.name && provider.name.trim(), `${provider.id} needs a name`)
    assert.ok(
      provider.baseUrl.startsWith("http://") || provider.baseUrl.startsWith("https://"),
      `${provider.id} baseUrl must be an http(s) URL`,
    )
    assert.ok(API_STYLES.includes(provider.apiStyle), `${provider.id} bad apiStyle`)
    assert.ok(AUTH_KINDS.includes(provider.authKind), `${provider.id} bad authKind`)
    assert.equal(provider.oauth, undefined, "plugin OAuth providers are rejected by the host")
    assert.ok(Array.isArray(provider.models), `${provider.id} needs models`)
    assert.ok(provider.models.length >= 1, `${provider.id} needs at least one model`)
    assert.ok(provider.models.length <= 64, `${provider.id} exceeds the 64-model cap`)

    const modelIds = new Set()
    for (const model of provider.models) {
      assert.ok(model.id && model.id.length <= 256, `${provider.id} has a model without a valid id`)
      assert.ok(!modelIds.has(model.id), `${provider.id} declares ${model.id} twice`)
      modelIds.add(model.id)
      if (model.name !== undefined) assert.ok(model.name.trim(), `${model.id} name must be non-empty`)
      for (const field of ["contextWindow", "maxTokens"]) {
        const value = model[field]
        if (value !== undefined) {
          assert.ok(Number.isInteger(value) && value > 0, `${model.id} ${field} must be a positive integer`)
        }
      }
      if (model.supportsImages !== undefined) {
        assert.equal(typeof model.supportsImages, "boolean", `${model.id} supportsImages must be a boolean`)
      }

      // The reasoning menu is built from these two fields, so the host validates
      // them: the levels must be known strings and the default must be one of the
      // model's own levels.
      if (model.thinkingLevels !== undefined) {
        assert.ok(Array.isArray(model.thinkingLevels), `${model.id} thinkingLevels must be an array`)
        assert.ok(model.thinkingLevels.length > 0, `${model.id} thinkingLevels must not be empty`)
        for (const level of model.thinkingLevels) {
          assert.equal(typeof level, "string", `${model.id} thinking level must be a string`)
          assert.ok(
            HOST_THINKING_LEVELS.includes(level),
            `${model.id} declares the unknown thinking level ${level}`,
          )
        }
      }
      if (model.defaultThinkingLevel !== undefined) {
        assert.equal(
          typeof model.defaultThinkingLevel,
          "string",
          `${model.id} defaultThinkingLevel must be a string`,
        )
        assert.ok(
          Array.isArray(model.thinkingLevels) &&
            model.thinkingLevels.includes(model.defaultThinkingLevel),
          `${model.id} defaultThinkingLevel must be one of its own thinkingLevels`,
        )
      }
    }
  }
}

async function main() {
  section("plugin lifecycle (stubbed host)")

  {
    const upstream = await startUpstream("provider")
    // No credential of any kind: a fresh machine that has never signed in.
    const env = makeHostEnvironment({ upstreamPort: upstream.port })
    const plugin = require(path.join(env.root, "main.js"))

    const providers = () => readProviders(env.root)
    const chatBase = () => providers().find((p) => p.apiStyle === "chat_completions").baseUrl

    await test("the module exports the hooks the host calls", () => {
      assert.equal(typeof plugin.onLoad, "function")
      assert.equal(typeof plugin.onUnload, "function")
      assert.equal(typeof plugin.onPanelInvoke, "function")
    })

    await test("onLoad registers the declared service and the commands", async () => {
      // The host sets globalThis.pi then calls onLoad() with NO arguments, so the
      // harness must do exactly that or it would not catch a signature mismatch.
      globalThis.pi = env.pi
      await plugin.onLoad()
      assert.equal(env.calls.services.length, 1)
      assert.equal(env.calls.services[0].id, "provider-host")
      assert.deepEqual(env.calls.commands.sort(), [
        "commandcode.open",
        "commandcode.refresh",
        "commandcode.resetTransport",
        "commandcode.status",
      ])
    })

    await test("the service binds a loopback port and publishes a valid declaration", async () => {
      await env.calls.services[0].start({ log: () => {} })
      const manifest = JSON.parse(fs.readFileSync(path.join(env.root, "manifest.json"), "utf8"))
      assertDeclarationIsHostValid(manifest)

      // One declaration per wire protocol, both plugin-managed: every provider is
      // `authKind: "none"`, so the host sends no key and needs no `/pool` twin to
      // tell the two halves of a declaration apart.
      const declared = manifest.contributes.providers
      assert.equal(declared.length, 2)
      assert.equal(
        declared.some((p) => p.id.endsWith("-pool")),
        false,
        "the /pool twins must be gone",
      )
      assert.equal(
        declared.some((p) => p.baseUrl.includes("/pool")),
        false,
        "no declaration may keep the /pool prefix",
      )
      assert.equal(declared.every((p) => p.authKind === "none"), true)

      const chat = declared.find((p) => p.id === "commandcode-chat")
      const claude = declared.find((p) => p.id === "commandcode-claude")
      assert.ok(chat && claude, "both declarations must exist")
      assert.deepEqual(declared.map((p) => p.apiStyle).sort(), [
        "anthropic_messages",
        "chat_completions",
      ])
      assert.match(chat.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      assert.match(claude.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)

      // Every provider must point at the same port, or one of them is dead.
      const ports = new Set(declared.map((p) => new URL(p.baseUrl).port))
      assert.equal(ports.size, 1)

      // Reasoning belongs to the host: each model states which levels exist and
      // which one a new session opens on.
      const { CATALOG } = require(path.join(env.root, "lib", "catalog-data.js"))
      const capability = new Map(CATALOG.map((model) => [model.id, model]))
      let reasoningModels = 0
      for (const provider of declared) {
        for (const model of provider.models) {
          if (capability.get(model.id)?.reasoning !== true) continue
          reasoningModels += 1
          assert.ok(
            Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0,
            `${model.id} can reason, so it must publish thinkingLevels`,
          )
          assert.ok(model.thinkingLevels.includes("off"), `${model.id} must offer the off level`)
          assert.ok(
            model.thinkingLevels.includes(model.defaultThinkingLevel),
            `${model.id} default must be one of its levels`,
          )
        }
      }
      assert.ok(reasoningModels >= 1, "the catalog under test must contain a reasoning model")
    })

    await test("a request with no credential at all is answered 401 pointing at the login", async () => {
      // Nothing is signed in and no Authorization header is sent, so there is no
      // candidate at all; the answer must say how to fix it.
      const response = await fetch(`${chatBase()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 401)
      assert.match(await response.text(), /official browser login/)
    })

    await test("the declared endpoint serves a chat request", async () => {
      // With no stored login the endpoint still honours a credential that arrives
      // in the header, which is how this harness can drive it before a login.
      const before = upstream.requests.length
      const response = await fetch(`${chatBase()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer user_test" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 200)
      const text = await response.text()
      assert.match(text, /hi/)
      assert.match(text, /\[DONE\]/)

      const sent = upstream.requests
        .slice(before)
        .find((r) => r.url.startsWith("/provider/v1/chat"))
      assert.ok(sent, "the upstream should have been called")
      assert.equal(sent.headers.authorization, "Bearer user_test")
    })

    await test("the panel bridge answers cc.state with the catalog", async () => {
      const state = await plugin.onPanelInvoke("cc.state")
      assert.ok(state.models.length >= 2, "the catalog should have been published")
      assert.equal(state.started, true)
      assert.ok(state.port > 0)
      // Nothing is signed in: neither the plugin's own settings nor a local auth
      // file holds a credential.
      assert.equal(state.credential, "none", "no login means no live credential")
      assert.ok(state.settings, "settings should be reported")
      assert.ok(state.endpoints.models.startsWith("http://127.0.0.1"))
      assert.equal(state.localAuthFile, false)
    })

    await test("cc.refresh re-reads the catalog from the configured endpoint", async () => {
      const state = await plugin.onPanelInvoke("cc.refresh")
      assert.equal(state.source, "live")
      assert.ok(state.models.some((m) => m.id === "gpt-5.6-luna"))
      assert.ok(state.models.some((m) => m.id === "claude-sonnet-4-6"))
    })

    await test("saving a model selection rewrites the declaration", async () => {
      const selection = { enabled: { "gpt-5.6-luna": true, "claude-sonnet-4-6": false } }
      const state = await plugin.onPanelInvoke("cc.saveModels", { selection })
      assert.equal(state.settings.modelSelection.enabled["claude-sonnet-4-6"], false)

      const manifest = JSON.parse(fs.readFileSync(path.join(env.root, "manifest.json"), "utf8"))
      assertDeclarationIsHostValid(manifest)
      const ids = manifest.contributes.providers.flatMap((p) => p.models.map((m) => m.id))
      assert.ok(ids.includes("gpt-5.6-luna"))
      assert.ok(!ids.includes("claude-sonnet-4-6"), "the disabled model must not be published")
      // With every Claude model off, that provider must disappear entirely: the
      // host rejects a provider with an empty model list.
      assert.equal(
        manifest.contributes.providers.some((p) => p.apiStyle === "anthropic_messages"),
        false,
      )
    })

    await test("cc.setSetting refuses the retired apiKey key", async () => {
      // The panel used to paste an API key here; that setting no longer exists, so
      // the host must not accept it and nothing may be written.
      const retired = await plugin.onPanelInvoke("cc.setSetting", {
        key: "apiKey",
        value: "panel_key",
      })
      assert.match(retired.error, /unknown setting/)
      assert.equal(env.stored.apiKey, undefined, "an apiKey must never be stored again")

      const unknown = await plugin.onPanelInvoke("cc.setSetting", { key: "nope", value: 1 })
      assert.match(unknown.error, /unknown setting/)
    })

    await test("the login flow validates a delivered credential and stores it", async () => {
      // Drive the real callback server: the browser half is stubbed, but the
      // loopback listener, the state check and the /alpha/whoami validation are
      // all the plugin's own code.
      const { createLoginFlow } = require(path.join(env.root, "src", "login.js"))
      const opened = []
      const flow = createLoginFlow({
        apiBase: () => `http://127.0.0.1:${upstream.port}`,
        openExternal: async (url) => {
          opened.push(url)
          // Emulate the Studio page POSTing the credentials back.
          const callback = new URL(url).searchParams.get("callback")
          const state = new URL(url).searchParams.get("state")
          await sleep(50)
          const res = await fetch(callback, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              apiKey: "login_key",
              state,
              userId: "user_1",
              userName: "Tester",
              keyName: "cli",
            }),
          })
          assert.equal(res.status, 200)
        },
      })

      const result = await flow.begin()
      assert.equal(result.ok, true, `login should succeed: ${result.error}`)
      assert.equal(result.credentials.apiKey, "login_key")
      assert.equal(opened.length, 1)
      assert.match(opened[0], /\/studio\/auth\/cli\?callback=.*&state=/)
    })

    await test("the status command reports without throwing", async () => {
      const status = env.calls.commands.includes("commandcode.status")
      assert.ok(status)
      const command = {
        id: "commandcode.status",
        run: async () => {
          const state = await plugin.onPanelInvoke("cc.state")
          return state
        },
      }
      const state = await command.run()
      assert.ok(state.models.length >= 1)
    })

    await test("the cache file is written inside the plugin data directory", () => {
      const cache = path.join(env.dataPath, "commandcode-models.json")
      assert.ok(fs.existsSync(cache), "the catalog cache should exist")
      const parsed = JSON.parse(fs.readFileSync(cache, "utf8"))
      assert.ok(parsed.models.length >= 2)
    })

    await test("onUnload releases the endpoint", async () => {
      const chat = providers().find((p) => p.apiStyle === "chat_completions")
      await stopPlugin(plugin)
      await assert.rejects(
        fetch(`${chat.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-luna", messages: [] }),
        }),
        "the port should be closed after unload",
      )
      assert.equal(env.calls.commands.length, 0, "commands should be unregistered")
    })

    upstream.server.close()
  }

  section("zero-key traffic and multi-account rotation")

  {
    const upstream = await startUpstream("provider")
    // Two signed-in accounts and no primary login: this is the shape `cc.login`
    // writes for a second account.
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      settings: {
        credential: "",
        accounts: [
          { id: "account-1", label: "First", credential: "first_key" },
          { id: "account-2", label: "Second", credential: "second_key" },
        ],
      },
    })
    const plugin = require(path.join(env.root, "main.js"))
    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    const chatBase = () => readProviders(env.root).find((p) => p.apiStyle === "chat_completions").baseUrl
    const ask = async () => {
      const before = upstream.requests.length
      const response = await fetch(`${chatBase()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      const text = await response.text()
      const attempts = upstream.requests
        .slice(before)
        .filter((r) => r.url.startsWith("/provider/v1/chat"))
      return { response, text, attempts }
    }

    await test("a request with no Authorization header uses a stored account credential", async () => {
      const { response, text, attempts } = await ask()
      assert.equal(response.status, 200)
      assert.match(text, /hi/)
      assert.equal(attempts.length, 1)
      assert.equal(attempts[0].headers.authorization, "Bearer first_key")
    })

    await test("a rejected account rotates to the next one and the request still succeeds", async () => {
      // The first account is throttled; the plugin must mark it and continue on
      // the second instead of failing the turn.
      upstream.server.throttleKey = "first_key"
      const { response, text, attempts } = await ask()
      upstream.server.throttleKey = undefined

      assert.equal(response.status, 200)
      assert.match(text, /hi/)
      assert.deepEqual(
        attempts.map((r) => r.headers.authorization),
        ["Bearer first_key", "Bearer second_key"],
        "the request must be retried on the second account",
      )

      const state = await plugin.onPanelInvoke("cc.state")
      assert.equal(state.configuredAccounts, 2)
      const marked = state.accounts.find((a) => a.id === "account-1")
      assert.equal(marked.state, "cooldown", "the throttled account is marked for the panel")
    })

    await test("cc.usage reports every configured account with per-endpoint timings", async () => {
      // The upstream here has no /alpha/usage endpoints, so each report must come
      // back as a classified failure rather than throwing — and every configured
      // account must be reported.
      const usage = await plugin.onPanelInvoke("cc.usage")
      assert.ok(Array.isArray(usage.accounts))
      assert.deepEqual(usage.accounts.map((a) => a.id).sort(), ["account-1", "account-2"])
      for (const account of usage.accounts) {
        assert.ok(account.report, "each account carries a report object")
        assert.equal(typeof account.report.timings?.total, "number")
        assert.equal(typeof account.report.timings?.endpoints, "object")
      }
      assert.equal(typeof usage.fetchedAt, "number")
    })

    await test("when every account is throttled the endpoint answers 429", async () => {
      upstream.server.throttleFor = () => true
      const { response, text } = await ask()
      upstream.server.throttleFor = undefined
      assert.equal(response.status, 429)
      assert.match(text, /rate limited/i)
    })

    await test("a rebuilt pool keeps its cooldowns", async () => {
      // Rebuilding happens whenever the account list changes. A 429 mark must
      // survive it, or the plugin would immediately retry a throttled account.
      // Removing an account is one of the real rebuild paths.
      const before = (await plugin.onPanelInvoke("cc.state")).accounts.find(
        (a) => a.id === "account-1",
      )
      assert.equal(before.state, "cooldown")

      await plugin.onPanelInvoke("cc.removeAccount", { accountId: "account-2" })

      const state = await plugin.onPanelInvoke("cc.state")
      assert.equal(state.configuredAccounts, 1, "the removed account must be gone")
      assert.equal(
        state.accounts.find((a) => a.id === "account-1").state,
        "cooldown",
        "the cooldown survived the pool rebuild",
      )
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  section("panel settings applied on load")

  {
    const upstream = await startUpstream("provider")
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      settings: {
        credential: "login_key",
        accounts: [{ id: "account-1", label: "Pinned", credential: "pinned_key" }],
        preferredAccount: "account-1",
      },
    })
    const plugin = require(path.join(env.root, "main.js"))
    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    await test("preferredAccount steers which credential a request uses", async () => {
      const chatBase = readProviders(env.root).find((p) => p.apiStyle === "chat_completions").baseUrl
      const before = upstream.requests.length
      const response = await fetch(`${chatBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 200)
      await response.text()
      const sent = upstream.requests.slice(before).find((r) => r.url.startsWith("/provider/v1/chat"))
      assert.equal(sent.headers.authorization, "Bearer pinned_key", "the pinned account wins")
    })

    await test("a panel settings write applies instead of throwing", async () => {
      // Regression: the settings-write path referenced a set that had been
      // deleted, so every write rejected with a ReferenceError *after* already
      // persisting the value - the panel reported "保存失败" and the change only
      // took effect on a reload.
      for (const [key, value] of [
        ["transport", "generate"],
        ["visibleModels", ["gpt-5.6-luna"]],
        ["preferredAccount", "auto"],
      ]) {
        const result = await plugin.onPanelInvoke("cc.setSetting", { key, value })
        assert.equal(result?.error, undefined, `setting "${key}" must not error`)
      }
      // The change must have reached the running endpoint, not just the file.
      const state = await plugin.onPanelInvoke("cc.state")
      assert.equal(state.preference, "generate", "the transport change was applied live")
    })

    await test("an unknown or inherited settings key is refused", async () => {
      for (const key of ["constructor", "toString", "hasOwnProperty", "definitely-not-a-setting"]) {
        const result = await plugin.onPanelInvoke("cc.setSetting", { key, value: "x" })
        assert.match(
          result?.error ?? "",
          /unknown setting/,
          `"${key}" must not be accepted as a setting`,
        )
      }
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  {
    const upstream = await startUpstream("provider")
    // A per-model rule pins one model to an account; the account list is applied
    // on load, because the panel channel that used to change it is unreachable.
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      settings: {
        credential: "login_key",
        accounts: [{ id: "account-1", label: "Pinned", credential: "pinned_key" }],
        modelAccountRules: [{ models: ["gpt-5.6-luna"], account: "account-1" }],
      },
    })
    const plugin = require(path.join(env.root, "main.js"))
    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    const ask = async (model) => {
      const chatBase = readProviders(env.root).find(
        (p) => p.apiStyle === "chat_completions",
      ).baseUrl
      const before = upstream.requests.length
      const response = await fetch(`${chatBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "x" }] }),
      })
      assert.equal(response.status, 200)
      await response.text()
      const sent = upstream.requests.slice(before).find((r) => r.url.startsWith("/provider/v1/chat"))
      return sent?.headers.authorization
    }

    await test("a per-model rule pins that model to an account", async () => {
      assert.equal(await ask("gpt-5.6-luna"), "Bearer pinned_key", "the rule pins that model")
    })

    await test("a model the rule does not name falls back to normal rotation", async () => {
      // Slot 0 is the primary login, so an unlisted model uses it.
      assert.equal(await ask("some-other-model"), "Bearer login_key")
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  {
    const upstream = await startUpstream("provider")
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      settings: {
        credential: "login_key",
        visibleModels: ["gpt-5.6-luna"],
        hideOutOfPlan: true,
      },
    })
    const plugin = require(path.join(env.root, "main.js"))
    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    await test("a whitelist narrows the declaration and hideOutOfPlan stays inert without billing data", async () => {
      // With no cached billing access the filter must not run at all, or turning
      // the switch on would wipe the whole catalog.
      const manifest = JSON.parse(fs.readFileSync(path.join(env.root, "manifest.json"), "utf8"))
      assertDeclarationIsHostValid(manifest)
      const declared = manifest.contributes.providers
      assert.equal(declared.length, 1)
      assert.equal(declared[0].apiStyle, "chat_completions")
      assert.deepEqual(
        declared[0].models.map((m) => m.id),
        ["gpt-5.6-luna"],
      )
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  {
    const upstream = await startUpstream("provider")
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      settings: { credential: "login_key", visibleModels: ["no-such-model"] },
    })
    const plugin = require(path.join(env.root, "main.js"))
    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    await test("an all-unknown whitelist must not wipe the declaration", async () => {
      // The plugin skips the rewrite rather than publishing a manifest with zero
      // models, which the host would reject outright.
      const manifest = JSON.parse(fs.readFileSync(path.join(env.root, "manifest.json"), "utf8"))
      assertDeclarationIsHostValid(manifest)
      const ids = manifest.contributes.providers.flatMap((p) => p.models.map((m) => m.id))
      assert.ok(ids.includes("gpt-5.6-luna"), "the previous declaration must survive")
      assert.ok(ids.includes("claude-sonnet-4-6"))
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  section("legacy settings migration")

  {
    const upstream = await startUpstream("provider")
    // A settings file written by the API-key version of this plugin.
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      settings: {
        apiKey: "old_key",
        accounts: [{ label: "Legacy", apiKey: "legacy_key" }],
      },
    })
    const plugin = require(path.join(env.root, "main.js"))
    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    await test("a legacy apiKey is migrated into the login credential on load", async () => {
      assert.equal(env.stored.credential, "old_key")
      assert.equal(env.stored.apiKey, "", "the retired key must be cleared, not left readable")
      assert.equal(env.stored.accounts.length, 1)
      assert.equal(env.stored.accounts[0].id, "account-1")
      assert.equal(env.stored.accounts[0].credential, "legacy_key")
      assert.equal(env.stored.accounts[0].apiKey, undefined)
    })

    await test("the migrated credential still serves a request", async () => {
      const chatBase = readProviders(env.root).find((p) => p.apiStyle === "chat_completions").baseUrl
      const before = upstream.requests.length
      const response = await fetch(`${chatBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 200)
      assert.match(await response.text(), /hi/)
      const sent = upstream.requests.slice(before).find((r) => r.url.startsWith("/provider/v1/chat"))
      assert.equal(sent.headers.authorization, "Bearer old_key")
    })

    await test("the migration is idempotent", async () => {
      const before = JSON.parse(JSON.stringify(env.stored))
      await plugin.onLoad()
      assert.deepEqual(env.stored, before, "a second load must not rewrite the settings")
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  section("plugin lifecycle (Go account)")

  {
    const upstream = await startUpstream("go")
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      settings: { transport: "generate", credential: "user_go" },
    })
    // A fresh module instance: the plugin keeps module-level state.
    delete require.cache[require.resolve(path.join(env.root, "main.js"))]
    const plugin = require(path.join(env.root, "main.js"))

    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    const ask = () => {
      const chat = readProviders(env.root).find((p) => p.apiStyle === "chat_completions")
      return fetch(`${chat.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    }

    await test("the generate transport serves a chat request for a Go account", async () => {
      const response = await ask()
      assert.equal(response.status, 200)
      const text = await response.text()
      assert.match(text, /generated/)
      assert.ok(upstream.requests.some((r) => r.url === "/alpha/generate"))
    })

    await test("a forced-generate setting never touches the Provider API", () => {
      assert.equal(
        upstream.requests.filter((r) => r.url.startsWith("/provider/v1/chat")).length,
        0,
      )
    })

    await test("cc.resetTransport keeps serving and reports the live transport", async () => {
      // Clearing the memory must not break the endpoint: the next request still
      // succeeds and the reported transport reflects what it actually used.
      const before = await plugin.onPanelInvoke("cc.resetTransport")
      assert.equal(before.preference, "generate", "the preference is unchanged by a reset")

      const response = await ask()
      assert.equal(response.status, 200)
      assert.match(await response.text(), /generated/)
      const after = await plugin.onPanelInvoke("cc.state")
      assert.equal(after.transport, "generate")
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  section("reasoning level passthrough")

  {
    const upstream = await startUpstream("provider")
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      settings: { credential: "login_key" },
    })
    const plugin = require(path.join(env.root, "main.js"))
    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    const declared = () => readProviders(env.root)

    await test("the level the host put in a chat_completions body reaches upstream unchanged", async () => {
      // The host owns this setting; the plugin must not filter or re-map it.
      const chat = declared().find((p) => p.apiStyle === "chat_completions")
      const before = upstream.requests.length
      const response = await fetch(`${chat.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          reasoning_effort: "xhigh",
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 200)
      await response.text()

      const sent = upstream.requests
        .slice(before)
        .find((r) => r.url.startsWith("/provider/v1/chat"))
      assert.ok(sent, "the upstream should have been called")
      assert.equal(JSON.parse(sent.body).reasoning_effort, "xhigh")
      assert.equal(sent.headers.authorization, "Bearer login_key")
    })

    await test("an Anthropic thinking budget becomes a real level on the generate transport", async () => {
      // Claude ids ride the CLI transport, which cannot take an Anthropic body:
      // the level has to be derived, and it must never be the literal "auto".
      const claude = declared().find((p) => p.apiStyle === "anthropic_messages")
      const before = upstream.requests.length
      const response = await fetch(`${claude.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: true,
          max_tokens: 1024,
          thinking: { type: "enabled", budget_tokens: 4096 },
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 200)
      assert.match(await response.text(), /generated/)

      const sent = upstream.requests.slice(before).find((r) => r.url === "/alpha/generate")
      assert.ok(sent, "the generate transport should have been used")
      const params = JSON.parse(sent.body).params
      assert.equal(params.reasoning_effort, "medium")
      assert.notEqual(params.reasoning_effort, "auto")
    })

    await test("an off level is left out instead of being sent as a literal", async () => {
      const claude = declared().find((p) => p.apiStyle === "anthropic_messages")
      const before = upstream.requests.length
      const response = await fetch(`${claude.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: true,
          max_tokens: 1024,
          thinking: { type: "enabled", effort: "off" },
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 200)
      await response.text()

      const sent = upstream.requests.slice(before).find((r) => r.url === "/alpha/generate")
      assert.ok(sent, "the generate transport should have been used")
      assert.equal(JSON.parse(sent.body).params.reasoning_effort, undefined)
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  section("local auth-file fallback (all three locations)")

  {
    // The pool's first slot and the diagnostics must agree on which files mean
    // "this machine is already signed in". Reading only the CLI path here made
    // the panel report a healthy local credential while every request answered
    // 401 "No Command Code account is signed in".
    const cases = [
      ["official CLI", path.join(".commandcode", "auth.json"), "cli_cred"],
      ["pi", path.join(".pi", "agent", "auth.json"), "pi_cred"],
      ["Oh My Pi", path.join(".omp", "agent", "auth.json"), "omp_cred"],
    ]

    for (const [label, relative, credential] of cases) {
      await test(`a ${label} auth file alone is enough to serve a request`, async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-home-"))
        const authPath = path.join(home, relative)
        fs.mkdirSync(path.dirname(authPath), { recursive: true })
        fs.writeFileSync(
          authPath,
          JSON.stringify({ commandcode: { type: "oauth", access: credential } }),
        )

        const upstream = await startUpstream("provider")
        const env = makeHostEnvironment({
          upstreamPort: upstream.port,
          settings: { credential: "", accounts: [] },
        })
        // The plugin resolves HOME through os.homedir(), so point the whole
        // process at the throwaway home for the duration of this case.
        const previousHome = process.env.HOME
        const previousUserProfile = process.env.USERPROFILE
        process.env.HOME = home
        process.env.USERPROFILE = home

        const plugin = require(path.join(env.root, "main.js"))
        globalThis.pi = env.pi
        try {
          await plugin.onLoad()
          await env.calls.services[0].start({ log: () => {} })

          const state = await plugin.onPanelInvoke("cc.state")
          assert.equal(state.credential, "local-auth-file", "the panel reports the local login")
          assert.equal(state.localAuthFile, true)

          const chatBase = readProviders(env.root).find(
            (p) => p.apiStyle === "chat_completions",
          ).baseUrl
          const before = upstream.requests.length
          const response = await fetch(`${chatBase}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "gpt-5.6-luna",
              stream: true,
              messages: [{ role: "user", content: "hello" }],
            }),
          })
          await response.text()
          assert.equal(response.status, 200, "the request must be served, not answered 401")
          const sent = upstream.requests
            .slice(before)
            .find((r) => r.url.startsWith("/provider/v1/chat"))
          assert.equal(sent.headers.authorization, `Bearer ${credential}`)
        } finally {
          await stopPlugin(plugin)
          upstream.server.close()
          if (previousHome === undefined) delete process.env.HOME
          else process.env.HOME = previousHome
          if (previousUserProfile === undefined) delete process.env.USERPROFILE
          else process.env.USERPROFILE = previousUserProfile
        }
      })
    }
  }

  section("browser login through the panel bridge")

  {
    const upstream = await startUpstream("provider")
    const env = makeHostEnvironment({
      upstreamPort: upstream.port,
      // Stand in for the user's browser: the Studio page POSTs the credentials
      // back to the loopback callback the plugin opened.
      onOpenExternal: async (url) => {
        const callback = new URL(url).searchParams.get("callback")
        const state = new URL(url).searchParams.get("state")
        await fetch(callback, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: "login_key",
            state,
            userId: "user_1",
            userName: "Tester",
            keyName: "cli",
          }),
        })
      },
    })
    const plugin = require(path.join(env.root, "main.js"))

    globalThis.pi = env.pi
    await plugin.onLoad()
    await env.calls.services[0].start({ log: () => {} })

    const chatBase = () => readProviders(env.root).find((p) => p.apiStyle === "chat_completions").baseUrl

    await test("cc.login stores the delivered credential and no API key", async () => {
      const result = await plugin.onPanelInvoke("cc.login")
      assert.equal(result.ok, true, `login should succeed: ${result.error}`)
      assert.equal(result.credential, "login")

      // The credential must have been persisted as the primary login, and the
      // retired setting must not exist at all.
      assert.equal(env.stored.credential, "login_key")
      assert.equal(env.stored.apiKey, undefined, "cc.login must not write an apiKey")
      assert.equal(env.stored.lastLogin.userName, "Tester")
      assert.equal(env.calls.opened.length, 1)
    })

    await test("the declared provider answers with no Authorization header at all", async () => {
      // The core claim of the refactor: the host sends nothing, and the plugin's
      // own login credential is the only one needed.
      const before = upstream.requests.length
      const response = await fetch(`${chatBase()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 200)
      assert.match(await response.text(), /hi/)

      const sent = upstream.requests.slice(before).find((r) => r.url.startsWith("/provider/v1/chat"))
      assert.ok(sent, "the upstream should have been called")
      assert.equal(sent.headers.authorization, "Bearer login_key")
    })

    await test("cc.state reports the login as the live credential", async () => {
      const state = await plugin.onPanelInvoke("cc.state")
      assert.equal(state.credential, "login")
    })

    await test("a second login is appended as an account and can be removed", async () => {
      const second = await plugin.onPanelInvoke("cc.login")
      assert.equal(second.ok, true, `the second login should succeed: ${second.error}`)
      assert.equal(env.stored.accounts.length, 1, "the second login becomes an account")
      assert.equal(env.stored.accounts[0].id, "account-1")
      assert.equal(env.stored.accounts[0].credential, "login_key")
      assert.equal(env.stored.accounts[0].apiKey, undefined)
      assert.equal(env.stored.credential, "login_key", "the primary login is untouched")

      const state = await plugin.onPanelInvoke("cc.removeAccount", { accountId: "account-1" })
      assert.equal(env.stored.accounts.length, 0, "the account must be gone")
      assert.equal(env.stored.credential, "login_key")
      assert.ok(Array.isArray(state.accounts))

      const missing = await plugin.onPanelInvoke("cc.removeAccount", { accountId: "account-9" })
      assert.match(missing.error, /unknown account/)
    })

    await test("cc.removeAccount clears the primary credential and the endpoint locks again", async () => {
      const state = await plugin.onPanelInvoke("cc.removeAccount", { accountId: "default" })
      assert.equal(env.stored.credential, "", "the primary login must be cleared")
      assert.ok(Array.isArray(state.accounts))

      const response = await fetch(`${chatBase()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      assert.equal(response.status, 401)
      assert.match(await response.text(), /official browser login/)
    })

    await test("cc.login reports a rejection from the upstream instead of storing it", async () => {
      // Point this run at an upstream that 401s /alpha/whoami: the delivered
      // credential must not be written anywhere.
      const previousBase = process.env.COMMANDCODE_GENERATE_BASE
      const strict = http.createServer((req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "unauthorized" }))
      })
      await new Promise((resolve) => strict.listen(0, "127.0.0.1", resolve))
      process.env.COMMANDCODE_GENERATE_BASE = `http://127.0.0.1:${strict.address().port}`

      try {
        const result = await plugin.onPanelInvoke("cc.login")
        assert.equal(result.ok, false)
        assert.match(result.error, /rejected|invalid/i)
        assert.equal(env.stored.credential, "", "a rejected credential must not be stored")
        assert.equal(env.stored.apiKey, undefined)
        assert.equal(env.stored.accounts.length, 0, "no account may be created either")
      } finally {
        process.env.COMMANDCODE_GENERATE_BASE = previousBase
        strict.close()
      }
    })

    await stopPlugin(plugin)
    upstream.server.close()
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log("\nfailures:")
    for (const { name, error } of failures) console.log(`- ${name}: ${error.message}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("host harness crashed:", error)
  process.exit(1)
})
