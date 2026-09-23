/**
 * End-to-end tests for the plugin's core, run with plain Node (no test runner).
 *
 * The important case is the proxy: it must serve both wire dialects, use the
 * Provider API when the account allows it, and fall back to /alpha/generate when
 * the upstream answers 403 upgrade_required — all while streaming.
 *
 * Run: node tests/run.js
 */

const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { messagesToCC, parseStreamEventLine, mapFinishReason, toolsToJson, projectSlugFromPath } =
  require("../src/converters.js")
const {
  decodeOpenAIRequest,
  decodeAnthropicRequest,
  effortFromThinking,
  createStreamEncoder,
  DEFAULT_THINKING_EFFORT,
} = require("../src/protocol.js")
const {
  parseModelsResponse,
  applySelection,
  buildProviderDeclarations,
  declaredThinkingLevels,
  readCachedModels,
  loadModels,
  writeCachedModels,
  readCachedCatalog,
  conditionalHeaders,
  HOST_THINKING_LEVELS,
} = require("../src/catalog.js")
const {
  usableCredential,
  readConfiguredCredential,
  readConfiguredCredentialCached,
  invalidateCredentialCache,
  describeCredentialSource,
} = require("../src/auth.js")
const { resolveEffort, isLoopbackHost, isLoopbackOrigin, bearerFrom } = require("../src/proxy.js")
const { runGenerate, createAccumulator } = require("../src/generate.js")
const { createAccountPool } = require("../src/accounts.js")
const {
  parseUsageTotals,
  parseCreditLimits,
  classifyTotalFailure,
} = require("../src/usage.js")

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

// ---------------------------------------------------------------------------
// Mock upstream
// ---------------------------------------------------------------------------

/** An SSE body for the Provider API (OpenAI style). */
function openAIProviderStream(text) {
  const chunks = [
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`,
    "data: [DONE]\n\n",
  ]
  return chunks
}

/** An SSE body for the legacy /alpha/generate endpoint. */
function generateStream(text, options = {}) {
  const events = [
    { type: "reasoning-start" },
    { type: "reasoning-delta", text: "thinking..." },
    { type: "reasoning-end" },
    { type: "text-delta", text },
  ]
  if (options.toolCall) {
    events.push({ type: "tool-input-start", id: "t1", toolName: "read_file" })
    events.push({ type: "tool-input-delta", id: "t1", delta: '{"path":"a.txt"}' })
    events.push({ type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "a.txt" } })
  }
  events.push({
    type: "finish",
    finishReason: options.toolCall ? "tool-calls" : "stop",
    totalUsage: {
      inputTokens: 20,
      outputTokens: 5,
      inputTokenDetails: { noCacheTokens: 15, cacheReadTokens: 5, cacheWriteTokens: 0 },
    },
  })
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`)
}

/**
 * Start a mock Command Code upstream.
 *
 * `mode` decides the account's behaviour:
 *   "provider"  both Provider API and generate succeed
 *   "go"        Provider API answers 403 upgrade_required; generate succeeds
 */
function startUpstream(mode) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const url = req.url ?? ""
      requests.push({ url, method: req.method, headers: req.headers, body })

      if (url === "/provider/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "gpt-5.6-luna",
                name: "GPT-5.6 Luna",
                context_length: 1050000,
                supported_endpoints: ["/chat/completions", "/responses"],
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

      if (url.startsWith("/provider/v1/")) {
        if (mode === "go") {
          res.writeHead(403, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: { code: "upgrade_required", message: "upgrade" } }))
          return
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const chunk of openAIProviderStream("provider-answer")) res.write(chunk)
        res.end()
        return
      }

      if (url === "/alpha/generate") {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const chunk of generateStream("generate-answer")) res.write(chunk)
        res.end()
        return
      }

      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "not found" } }))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, requests })
    })
  })
}

/** Start the plugin proxy pointed at a mock upstream. */
async function startProxyFor(upstreamPort, options = {}) {
  const { createProxy } = require("../src/proxy.js")
  const proxy = createProxy({
    providerApiBase: `http://127.0.0.1:${upstreamPort}/provider/v1`,
    generateApiBase: `http://127.0.0.1:${upstreamPort}`,
    workingDir: "C:\\work\\demo",
    log: () => {},
    transport: options.transport ?? "auto",
    allowImagesForModel: () => true,
    // The host key is the only credential in these tests: no env, no auth files.
    pool: undefined,
    billingAccessFor: options.billingAccessFor,
    requiresMessages: options.requiresMessages,
    effortMapForModel: () => ({ low: "low", high: "high" }),
  })
  const port = await proxy.listen([0])
  return { proxy, port, base: `http://127.0.0.1:${port}` }
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key-123", ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text(), response }
}

const CHAT_BODY = {
  model: "gpt-5.6-luna",
  stream: true,
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  section("converters")

  await test("messagesToCC keeps user/assistant turns and degrades developer role", () => {
    const out = messagesToCC([
      { role: "system", content: "sys" },
      { role: "developer", content: "nudge" },
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ])
    assert.equal(out.length, 3)
    assert.equal(out[0].role, "user")
    assert.equal(out[0].content, "nudge")
    assert.equal(out[2].role, "assistant")
  })

  await test("messagesToCC synthesizes a result for an unanswered tool call", () => {
    const out = messagesToCC([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "a1", name: "read", arguments: { p: 1 } }],
      },
    ])
    assert.equal(out.length, 2)
    assert.equal(out[1].role, "tool")
    assert.equal(out[1].content[0].output.type, "error-text")
  })

  await test("messagesToCC batches consecutive tool results", () => {
    const out = messagesToCC([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a1", name: "r", arguments: {} },
          { type: "toolCall", id: "a2", name: "r", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "a1", toolName: "r", content: [{ type: "text", text: "1" }] },
      { role: "toolResult", toolCallId: "a2", toolName: "r", content: [{ type: "text", text: "2" }] },
    ])
    assert.deepEqual(
      out.map((m) => m.role),
      ["assistant", "tool", "tool"],
    )
  })

  await test("messagesToCC rejects images for a text-only model", () => {
    assert.throws(
      () =>
        messagesToCC([
          { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAA" }] },
        ]),
      /does not support image/,
    )
  })

  await test("parseStreamEventLine handles data: prefixes, comments and [DONE]", () => {
    assert.deepEqual(parseStreamEventLine('data: {"a":1}'), { a: 1 })
    assert.deepEqual(parseStreamEventLine('{"a":2}'), { a: 2 })
    assert.equal(parseStreamEventLine(": ping"), undefined)
    assert.equal(parseStreamEventLine("data: [DONE]"), undefined)
    assert.equal(parseStreamEventLine("event: message"), undefined)
  })

  await test("mapFinishReason maps tool and length variants", () => {
    assert.equal(mapFinishReason("tool-calls"), "toolUse")
    assert.equal(mapFinishReason("max_tokens"), "length")
    assert.equal(mapFinishReason("stop"), "stop")
  })

  await test("toolsToJson collapses Gemini nullable type arrays", () => {
    const tools = toolsToJson(
      [{ name: "t", parameters: { type: "object", properties: { a: { type: ["string", "null"] } } } }],
      "google/gemini-3.5-flash",
    )
    assert.equal(tools[0].input_schema.properties.a.type, "string")
  })

  await test("projectSlugFromPath produces a header-safe slug", () => {
    assert.equal(projectSlugFromPath("C:\\work\\My Demo"), "work-my-demo")
    assert.equal(projectSlugFromPath(""), "project")
  })

  section("protocol")

  await test("decodeOpenAIRequest lifts system and reads tool calls", () => {
    const decoded = decodeOpenAIRequest({
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", function: { name: "read", arguments: '{"p":1}' } }],
        },
        { role: "tool", tool_call_id: "t1", name: "read", content: "done" },
      ],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      max_tokens: 100,
    })
    assert.equal(decoded.systemPrompt, "sys")
    assert.equal(decoded.maxTokens, 100)
    assert.equal(decoded.tools[0].name, "read")
    assert.deepEqual(decoded.messages[1].content[0].arguments, { p: 1 })
    assert.equal(decoded.messages[2].role, "toolResult")
    assert.equal(decoded.messages[2].toolCallId, "t1")
  })

  await test("decodeAnthropicRequest splits tool_result blocks out of user turns", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-sonnet-4-6",
      system: [{ type: "text", text: "sys" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "read", input: { p: 1 } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "ok" }] }],
        },
      ],
      tools: [{ name: "read", input_schema: { type: "object" } }],
      thinking: { type: "enabled", budget_tokens: 1000 },
    })
    assert.equal(decoded.systemPrompt, "sys")
    assert.equal(decoded.thinkingEnabled, true)
    assert.equal(decoded.tools[0].name, "read")
    assert.equal(decoded.messages[1].content[0].type, "toolCall")
    assert.equal(decoded.messages[2].role, "toolResult")
  })


  await test("the accumulator closes a tool call that never received its tool-call event", () => {
    const events = []
    const acc = createAccumulator({ id: "m" }, (e) => events.push(e))
    acc.handle({ type: "tool-input-start", id: "t1", toolName: "read" })
    acc.handle({ type: "tool-input-delta", id: "t1", delta: '{"p":' })
    // Upstream truncates: a finish arrives with no matching `tool-call`.
    acc.handle({ type: "finish", finishReason: "stop" })
    acc.seal()

    const kinds = events.map((e) => e.kind)
    assert.ok(kinds.includes("toolcall_start"), "the block was opened")
    assert.ok(kinds.includes("toolcall_end"), "the block must also be closed")
    // Every start must be paired, or an Anthropic client sees an unterminated block.
    const starts = events.filter((e) => e.kind === "toolcall_start").length
    const ends = events.filter((e) => e.kind === "toolcall_end").length
    assert.equal(ends, starts, "toolcall_start/end must be paired")
  })
  await test("Anthropic blocks are dense, paired and never leak a suppressed index", () => {
    // Mirrors the proxy: seal() first (its emits are appended), then done().
    const run = (thinkingEnabled, events) => {
      const encoder = createStreamEncoder("anthropic_messages", "claude-sonnet-4-6", { thinkingEnabled })
      const parts = []
      const acc = createAccumulator({ id: "m" }, (ev) => parts.push(encoder.event(ev)))
      for (const event of events) acc.handle(event)
      parts.push(encoder.done(acc.seal()))
      const out = parts.join("")
      const grab = (name) =>
        [...out.matchAll(new RegExp(`event: ${name}\\ndata: (\\{.*?\\})\\n\\n`, "g"))].map((m) =>
          JSON.parse(m[1]),
        )
      return { starts: grab("content_block_start"), deltas: grab("content_block_delta"), stops: grab("content_block_stop") }
    }

    const cases = {
      "thinking suppressed + text": [
        false,
        [
          { type: "reasoning-start" },
          { type: "reasoning-delta", text: "t" },
          { type: "reasoning-end" },
          { type: "text-delta", text: "answer" },
          { type: "finish", finishReason: "stop" },
        ],
      ],
      "thinking enabled + text": [
        true,
        [
          { type: "reasoning-start" },
          { type: "reasoning-delta", text: "t" },
          { type: "reasoning-end" },
          { type: "text-delta", text: "answer" },
          { type: "finish", finishReason: "stop" },
        ],
      ],
      "text then tool": [
        false,
        [
          { type: "text-delta", text: "look" },
          { type: "tool-input-start", id: "t1", toolName: "read" },
          { type: "tool-input-delta", id: "t1", delta: '{"p":1}' },
          { type: "tool-call", toolCallId: "t1", toolName: "read", input: { p: 1 } },
          { type: "finish", finishReason: "tool-calls" },
        ],
      ],
      "two tools only": [
        false,
        [
          { type: "tool-input-start", id: "a", toolName: "one" },
          { type: "tool-input-start", id: "b", toolName: "two" },
          { type: "tool-call", toolCallId: "a", toolName: "one", input: {} },
          { type: "tool-call", toolCallId: "b", toolName: "two", input: {} },
          { type: "finish", finishReason: "tool-calls" },
        ],
      ],
    }

    for (const [label, [thinkingEnabled, events]] of Object.entries(cases)) {
      const { starts, deltas, stops } = run(thinkingEnabled, events)
      const startIndexes = starts.map((b) => b.index)
      const stopIndexes = stops.map((b) => b.index)
      // Anthropic clients require indices to start at 0 and increase by one.
      assert.deepEqual(
        startIndexes,
        startIndexes.map((_, i) => i),
        `${label}: block indices must be dense from 0`,
      )
      assert.deepEqual(stopIndexes, startIndexes, `${label}: every block needs one matching stop`)
      for (const delta of deltas) {
        assert.ok(startIndexes.includes(delta.index), `${label}: delta for an unopened block`)
      }
    }
  })

  await test("OpenAI encoder emits tool_calls with dense indices and [DONE]", () => {
    const encoder = createStreamEncoder("chat_completions", "gpt-5.6-luna")
    // Feed content indices that are deliberately not 0-based, as the accumulator
    // does when a thinking block preceded the tool call.
    let out = encoder.event({ kind: "toolcall_start", index: 2, toolCall: { id: "x", name: "f" } })
    out += encoder.event({ kind: "toolcall_delta", index: 2, text: '{"a":1}' })
    out += encoder.event({ kind: "toolcall_start", index: 5, toolCall: { id: "y", name: "g" } })
    out += encoder.done({ stopReason: "toolUse", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } })

    // Parse the tool_calls index out of the delta payloads, not the outer
    // choices[0].index (which is always 0 and would make this assertion vacuous).
    // Both start and argument-delta chunks carry the index, so dedupe in order.
    const allIndexes = [...out.matchAll(/"tool_calls":\[\{"index":(\d+)/g)].map((m) => Number(m[1]))
    const distinct = [...new Set(allIndexes)]
    assert.deepEqual(distinct, [0, 1], "tool_calls indices must be dense from 0")
    // Deltas must address a tool call that was already opened.
    for (const index of allIndexes) assert.ok(distinct.includes(index))
    assert.match(out, /"name":"f"/)
    assert.match(out, /"name":"g"/)
    assert.match(out, /"finish_reason":"tool_calls"/)
    assert.match(out, /data: \[DONE\]/)
  })

  await test("Anthropic encoder suppresses thinking unless the request enabled it", () => {
    const silent = createStreamEncoder("anthropic_messages", "claude-sonnet-4-6", {
      thinkingEnabled: false,
    })
    const out = silent.event({ kind: "thinking_delta", index: 0, text: "hmm" })
    assert.doesNotMatch(out, /thinking_delta/)
    assert.match(out, /message_start/)
  })

  section("catalog")

  await test("parseModelsResponse merges capabilities and picks the api style", () => {
    const { models } = parseModelsResponse({
      data: [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", context_length: 1050000, supported_endpoints: ["/chat/completions"] },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1000000, supported_endpoints: ["/messages"] },
      ],
    })
    const chat = models.find((m) => m.id === "gpt-5.6-luna")
    const claude = models.find((m) => m.id === "claude-sonnet-4-6")
    assert.equal(chat.apiStyle, "chat_completions")
    assert.equal(chat.image, true)
    assert.ok(chat.efforts.includes("high"))
    assert.equal(claude.apiStyle, "anthropic_messages")
    assert.equal(claude.reasoning, true)
  })

  await test("parseModelsResponse skips bad entries instead of failing", () => {
    const { models, skipped } = parseModelsResponse({
      data: [
        { id: "good", name: "Good", context_length: 1000, supported_endpoints: [] },
        { name: "no id" },
        "garbage",
      ],
    })
    assert.equal(models.length, 1)
    assert.equal(skipped.length, 2)
  })

  await test("parseModelsResponse rejects an empty catalog", () => {
    assert.throws(() => parseModelsResponse({ data: [] }), /empty model catalog/)
  })

  await test("buildProviderDeclarations splits by api style and honours the 64 cap", () => {
    const models = []
    for (let i = 0; i < 70; i++) {
      models.push({ id: `m${i}`, name: `M${i}`, contextWindow: 1000, maxTokens: 100, image: false, apiStyle: "chat_completions" })
    }
    models.push({ id: "claude", name: "C", contextWindow: 1000, maxTokens: 100, image: true, apiStyle: "anthropic_messages" })
    const { declarations, truncated } = buildProviderDeclarations(models, {
      chat_completions: "http://127.0.0.1:1/v1",
      anthropic_messages: "http://127.0.0.1:1",
    })
    const chat = declarations.find((d) => d.apiStyle === "chat_completions")
    const claude = declarations.find((d) => d.apiStyle === "anthropic_messages")
    assert.equal(chat.models.length, 64)
    assert.equal(claude.models.length, 1)
    assert.equal(claude.baseUrl, "http://127.0.0.1:1")
    assert.equal(truncated.length, 1)
    // The host requires these fields exactly.
    // Every provider is credential-free: the host treats authKind "none" as
    // ready, which is what makes a login-only plugin usable without a key.
    assert.equal(chat.authKind, "none")
    assert.equal(claude.authKind, "none")
    assert.equal(declarations.length, 2, "one declaration per wire protocol")
    assert.equal(chat.vendorKey, "commandcode")
    assert.equal(typeof chat.models[0].supportsImages, "boolean")
  })

  await test("applySelection honours enabled / image / context overrides", () => {
    const models = [
      { id: "a", name: "A", contextWindow: 1000, maxTokens: 500, image: false, apiStyle: "chat_completions" },
      { id: "b", name: "B", contextWindow: 1000, maxTokens: 500, image: false, apiStyle: "chat_completions" },
    ]
    const out = applySelection(models, {
      enabled: { a: true, b: false },
      image: { a: true },
      contextWindow: { a: 300 },
    })
    assert.equal(out.length, 1)
    assert.equal(out[0].id, "a")
    assert.equal(out[0].image, true)
    assert.equal(out[0].contextWindow, 300)
    assert.equal(out[0].maxTokens, 300)
  })

  section("auth")

  await test("usableCredential trims and rejects blanks", () => {
    assert.equal(usableCredential("   "), undefined)
    assert.equal(usableCredential(""), undefined)
    assert.equal(usableCredential(undefined), undefined)
    assert.equal(usableCredential(" user_abc "), "user_abc")
    // No placeholder concept remains: with authKind "none" the host sends
    // nothing, so a literal string can only be a real credential.
    assert.equal(usableCredential("COMMAND_CODE_API_KEY"), "COMMAND_CODE_API_KEY")
  })

  await test("readConfiguredCredential reads the CLI / pi auth-file shapes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-auth-"))
    const direct = path.join(dir, "direct.json")
    fs.writeFileSync(direct, JSON.stringify({ apiKey: "user_direct" }))
    assert.equal(readConfiguredCredential({ authPaths: [direct] }), "user_direct")

    const oauth = path.join(dir, "oauth.json")
    fs.writeFileSync(oauth, JSON.stringify({ commandcode: { type: "oauth", access: "user_oauth" } }))
    assert.equal(readConfiguredCredential({ authPaths: [oauth] }), "user_oauth")

    const cli = path.join(dir, "cli.json")
    fs.writeFileSync(cli, JSON.stringify({ "command-code": { type: "api", key: "user_cli" } }))
    assert.equal(readConfiguredCredential({ authPaths: [cli] }), "user_cli")

    assert.equal(readConfiguredCredential({ authPaths: [path.join(dir, "nope.json")] }), undefined)
  })

  await test("the credential read is memoised, and invalidation drops the memo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-auth-cache-"))
    const authPath = path.join(dir, "auth.json")
    fs.writeFileSync(authPath, JSON.stringify({ apiKey: "user_first" }))

    invalidateCredentialCache()
    assert.equal(readConfiguredCredentialCached({ homeDir: dir, authPaths: [authPath] }), "user_first")
    assert.equal(describeCredentialSource({ homeDir: dir, authPaths: [authPath] }), "local-auth-file")

    // A changed file is NOT noticed inside the TTL: that is the point of the memo
    // (the request path must not stat three files per request).
    fs.writeFileSync(authPath, JSON.stringify({ apiKey: "user_second" }))
    assert.equal(readConfiguredCredentialCached({ homeDir: dir, authPaths: [authPath] }), "user_first")

    invalidateCredentialCache()
    assert.equal(readConfiguredCredentialCached({ homeDir: dir, authPaths: [authPath] }), "user_second")

    invalidateCredentialCache()
    assert.equal(describeCredentialSource({ homeDir: dir, authPaths: [] }), "none")
  })

  await test("loopback guards reject foreign hosts and origins", () => {
    assert.equal(isLoopbackHost("127.0.0.1:41851"), true)
    assert.equal(isLoopbackHost("localhost"), true)
    assert.equal(isLoopbackHost("evil.example.com"), false)
    assert.equal(isLoopbackOrigin(undefined), true)
    assert.equal(isLoopbackOrigin("http://127.0.0.1"), true)
    assert.equal(isLoopbackOrigin("https://evil.example.com"), false)
  })

  await test("bearerFrom extracts the token", () => {
    assert.equal(bearerFrom({ headers: { authorization: "Bearer abc" } }), "abc")
    assert.equal(bearerFrom({ headers: {} }), undefined)
  })

  await test("resolveEffort forwards the host's level untouched", () => {
    // The host resolves the level from its own model settings, so the plugin
    // must not filter it against a list of its own.
    assert.equal(resolveEffort("high"), "high")
    assert.equal(resolveEffort("max"), "max")
    assert.equal(resolveEffort("xhigh"), "xhigh")
    assert.equal(resolveEffort("minimal"), "minimal")
    // "off" (and nothing at all) leaves thinking to the provider.
    assert.equal(resolveEffort("off"), undefined)
    assert.equal(resolveEffort("auto"), undefined)
    assert.equal(resolveEffort(undefined), undefined)
  })

  section("proxy (provider transport)")

  {
    const upstream = await startUpstream("provider")
    const { proxy, base } = await startProxyFor(upstream.port)

    await test("OpenAI dialect streams through the Provider API", async () => {
      const result = await postJson(`${base}/v1/chat/completions`, CHAT_BODY)
      assert.equal(result.status, 200)
      assert.match(result.text, /provider-answer/)
      assert.match(result.text, /data: \[DONE\]/)
      const sent = upstream.requests.find((r) => r.url.startsWith("/provider/v1/chat/completions"))
      assert.ok(sent, "the Provider API endpoint should have been called")
      assert.equal(sent.headers.authorization, "Bearer test-key-123")
      // The host's own body is forwarded, so the model id survives unchanged.
      assert.equal(JSON.parse(sent.body).model, "gpt-5.6-luna")
    })

    await test("Anthropic dialect maps to the /messages endpoint", async () => {
      const result = await postJson(`${base}/v1/messages`, {
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      })
      assert.equal(result.status, 200)
      const sent = upstream.requests.find((r) => r.url.startsWith("/provider/v1/messages"))
      assert.ok(sent, "/provider/v1/messages should have been called")
    })

    await test("the last transport used was the Provider API", () => {
      assert.equal(proxy.getTransport(), "provider")
      assert.equal(proxy.getPreference(), "auto")
    })

    await test("healthz reports transport and counters", async () => {
      const response = await fetch(`${base}/healthz`)
      const info = await response.json()
      assert.equal(info.ok, true)
      assert.equal(info.transport, "provider")
      assert.ok(info.requests >= 2)
    })

    await test("a foreign Host header is refused", async () => {
      // fetch() silently drops a manual Host header, so use a raw request.
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: Number(new URL(base).port),
            method: "POST",
            path: "/v1/chat/completions",
            headers: {
              Host: "evil.example.com",
              "Content-Type": "application/json",
              Authorization: "Bearer test-key-123",
            },
          },
          (res) => {
            res.resume()
            res.on("end", () => resolve(res.statusCode))
          },
        )
        req.on("error", reject)
        req.end(JSON.stringify(CHAT_BODY))
      })
      assert.equal(status, 403)
    })

    await test("a missing credential yields 401 with guidance", async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(CHAT_BODY),
      })
      assert.equal(response.status, 401)
      assert.match(await response.text(), /official browser login/)
    })

    await test("a non-loopback Origin is refused", async () => {
      const result = await postJson(`${base}/v1/chat/completions`, CHAT_BODY, {
        Origin: "https://evil.example.com",
      })
      assert.equal(result.status, 403)
    })

    await proxy.close()
    upstream.server.close()
  }

  section("proxy (Go account falls back to generate)")

  {
    const upstream = await startUpstream("go")
    const { proxy, base } = await startProxyFor(upstream.port)

    await test("403 upgrade_required switches to generate and still answers", async () => {
      const result = await postJson(`${base}/v1/chat/completions`, CHAT_BODY)
      assert.equal(result.status, 200)
      assert.match(result.text, /generate-answer/)
      assert.match(result.text, /data: \[DONE\]/)
      assert.ok(
        upstream.requests.some((r) => r.url === "/alpha/generate"),
        "the generate endpoint should have been called",
      )
    })

    await test("the upgrade switch is remembered for later requests", () => {
      // The 403 marked this key, so the next request takes the CLI transport
      // without re-probing the Provider API.
      assert.equal(proxy.getTransport(), "generate")
    })

    await test("the generate request carries the CLI headers and project slug", () => {
      const sent = upstream.requests.find((r) => r.url === "/alpha/generate")
      assert.match(sent.headers["x-command-code-version"], /^\d+\.\d+\.\d+$/)
      assert.equal(sent.headers["x-cli-environment"], "production")
      assert.equal(sent.headers["x-project-slug"], "work-demo")
      assert.equal(sent.headers.authorization, "Bearer test-key-123")
    })

    await test("the generate body has the documented shape", () => {
      const sent = upstream.requests.find((r) => r.url === "/alpha/generate")
      const body = JSON.parse(sent.body)
      assert.equal(body.params.model, "gpt-5.6-luna")
      assert.equal(body.params.stream, true)
      assert.equal(body.params.system, "be brief")
      assert.equal(body.params.messages[0].role, "user")
      assert.ok(Array.isArray(body.params.tools))
      assert.equal(body.config.workingDir, "C:\\work\\demo")
      assert.equal(body.memory, null)
      assert.equal(typeof body.threadId, "string")
    })

    await test("a second request goes straight to generate without re-probing", async () => {
      const before = upstream.requests.filter((r) => r.url.startsWith("/provider/v1/chat")).length
      await postJson(`${base}/v1/chat/completions`, CHAT_BODY)
      const after = upstream.requests.filter((r) => r.url.startsWith("/provider/v1/chat")).length
      assert.equal(after, before, "the Provider API must not be probed again")
    })

    await test("the Anthropic dialect is re-encoded from the generate stream", async () => {
      const result = await postJson(`${base}/v1/messages`, {
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      })
      assert.equal(result.status, 200)
      assert.match(result.text, /event: message_start/)
      assert.match(result.text, /generate-answer/)
      assert.match(result.text, /"type":"text_delta"/)
      assert.match(result.text, /event: message_stop/)
    })

    await test("thinking is withheld when the Anthropic request did not enable it", async () => {
      const result = await postJson(`${base}/v1/messages`, {
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      })
      assert.doesNotMatch(result.text, /thinking_delta/)
    })

    await proxy.close()
    upstream.server.close()
  }

  section("proxy (forced generate)")

  {
    const upstream = await startUpstream("provider")
    const { proxy, base } = await startProxyFor(upstream.port, { transport: "generate" })

    await test("transport=generate skips the Provider API entirely", async () => {
      const result = await postJson(`${base}/v1/chat/completions`, CHAT_BODY)
      assert.equal(result.status, 200)
      assert.match(result.text, /generate-answer/)
      assert.equal(
        upstream.requests.filter((r) => r.url.startsWith("/provider/v1/chat")).length,
        0,
        "no Provider API request should be made",
      )
    })
    await proxy.close()
    await proxy.close()
    upstream.server.close()
  }

  section("generate transport")

  await test("runGenerate reports a truncated stream as an error", async () => {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ type: "text-delta", text: "partial" })}\n\n`)
        res.end() // no finish event
      })
    })
    const port = await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
    )
    await assert.rejects(
      runGenerate({
        apiKey: "k",
        modelId: "m",
        context: { messages: [{ role: "user", content: "hi" }] },
        apiBase: `http://127.0.0.1:${port}`,
        emit: () => {},
      }),
      /truncated|finish event/,
    )
    server.close()
  })

  await test("runGenerate surfaces an upstream error event", async () => {
    const server = http.createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ type: "error", error: { message: "quota exhausted" } })}\n\n`)
        res.end()
      })
    })
    const port = await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
    )
    await assert.rejects(
      runGenerate({
        apiKey: "k",
        modelId: "m",
        context: { messages: [] },
        apiBase: `http://127.0.0.1:${port}`,
        emit: () => {},
      }),
      /quota exhausted/,
    )
    server.close()
  })

  await test("the accumulator tracks usage and tool calls", () => {
    const events = []
    const acc = createAccumulator({ id: "m" }, (event) => events.push(event))
    for (const line of generateStream("hi", { toolCall: true })) {
      const parsed = parseStreamEventLine(line)
      if (parsed) acc.handle(parsed)
    }
    const result = acc.seal()
    assert.equal(result.stopReason, "toolUse")
    assert.equal(result.usage.input, 15)
    assert.equal(result.usage.cacheRead, 5)
    assert.equal(result.usage.output, 5)
    const kinds = events.map((e) => e.kind)
    assert.ok(kinds.includes("thinking_start"))
    assert.ok(kinds.includes("text_delta"))
    assert.ok(kinds.includes("toolcall_end"))
  })

  section("catalog cache")

  section("accounts (pool + rotation)")

  await test("the pool resolves slots in configured order, skipping unresolvable ones", () => {
    const pool = createAccountPool({
      homeDir: "C:\\nonexistent-home",
      accounts: [
        { id: "account-a", label: "A", credential: "user_a" },
        { label: "Empty" },
        { id: "account-c", label: "C", credential: "user_c" },
      ],
    })
    const resolved = pool.resolved()
    assert.deepEqual(
      resolved.map((e) => e.slot.id),
      ["account-a", "account-c"],
      "the slot without a credential must be dropped, keeping the others' ids",
    )
    assert.deepEqual(
      resolved.map((e) => e.key),
      ["user_a", "user_c"],
    )
  })

  await test("a legacy apiKey slot still resolves, so old settings keep working", () => {
    // Settings written by the previous version stored apiKey; the pool reads it
    // so an upgrade does not silently sign everyone out.
    const pool = createAccountPool({
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "Legacy", apiKey: "user_legacy" }],
    })
    assert.equal(pool.resolved()[0].key, "user_legacy")
    // An env-var-only slot has no credential to resolve, so it is dropped.
    const envOnly = createAccountPool({
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "Env", apiKeyEnv: "SOME_VAR" }],
    })
    assert.equal(envOnly.resolved().length, 0)
  })

  await test("the pool's first slot falls back to this machine's login file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pool-home-"))
    fs.mkdirSync(path.join(dir, ".commandcode"), { recursive: true })
    fs.writeFileSync(
      path.join(dir, ".commandcode", "auth.json"),
      JSON.stringify({ commandcode: { type: "oauth", access: "user_file" } }),
    )
    const pool = createAccountPool({ homeDir: dir, accounts: [] })
    assert.deepEqual(pool.resolved().map((e) => e.key), ["user_file"])
    assert.equal(pool.describe()[0].configured, true)
  })

  await test("a 429 with a reset parks the account until that deadline", () => {
    const pool = createAccountPool({
      env: {},
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "A", apiKey: "user_a" }, { label: "B", apiKey: "user_b" }],
    })
    const reset = Date.now() + 60_000
    pool.markRejected("user_a", "rate-limit", reset)

    // Slot 0 is the default (no auth file here), so address accounts by id.
    const byId = (list, id) => list.find((entry) => entry.id === id)
    const describe = pool.describe()
    assert.equal(byId(describe, "account-1").usable, false, "the limited account is not usable")
    assert.equal(byId(describe, "account-1").cooldownUntil, reset)
    assert.equal(byId(describe, "account-2").usable, true)

    // Rotation must skip it and pick the next account.
    const picked = pool.select("gpt-5.6-luna")
    assert.equal(picked.key, "user_b")
    // And the earliest reset is reported so the UI can say when to retry.
    assert.equal(pool.earliestReset(), reset)
  })

  await test("a bare 429 parks the account briefly and rotation skips it", () => {
    const pool = createAccountPool({
      env: {},
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "A", apiKey: "user_a" }, { label: "B", apiKey: "user_b" }],
    })
    const before = Date.now()
    pool.markRejected("user_a", "rate-limit", 0)
    const entry = pool.describe().find((e) => e.id === "account-1")
    // A bare 429 must still be remembered: leaving it unmarked would make the very
    // next request pick the same throttled account again.
    assert.equal(entry.state, "cooldown")
    assert.ok(entry.cooldownUntil > before, "the throttle gets a short deadline")
    assert.equal(entry.usable, false)
    assert.equal(pool.select("gpt-5.6-luna").key, "user_b", "rotation moves to the next account")
  })

  await test("a 401 disables the account until the key changes", () => {
    const pool = createAccountPool({
      env: {},
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "A", apiKey: "user_a" }, { label: "B", apiKey: "user_b" }],
    })
    pool.markRejected("user_a", "invalid-credential", 0)
    const a = pool.describe().find((e) => e.id === "account-1")
    assert.equal(a.state, "disabled")
    assert.equal(a.usable, false)
    // A disabled account is not revived by a healthy mark.
    pool.markHealthy("user_a")
    assert.equal(pool.describe().find((e) => e.id === "account-1").usable, false)
    assert.equal(pool.select("m").key, "user_b")
  })

  await test("a per-model rule pins a model to an account, first match wins", () => {
    const pool = createAccountPool({
      env: {},
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "A", apiKey: "user_a" }, { label: "B", apiKey: "user_b" }],
    })
    const rules = [
      { models: ["claude-sonnet-4-6"], account: "account-2" },
      { models: ["claude-sonnet-4-6", "gpt-5.6-luna"], account: "account-1" },
    ]
    assert.equal(pool.select("claude-sonnet-4-6", { modelRules: rules }).key, "user_b")
    assert.equal(pool.select("gpt-5.6-luna", { modelRules: rules }).key, "user_a")
    // An unlisted model falls through to the priority order.
    assert.equal(pool.select("deepseek/deepseek-v4-pro", { modelRules: rules }).key, "user_a")
  })

  await test("a rule pointing at an unusable account falls back to rotation", () => {
    const pool = createAccountPool({
      env: {},
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "A", apiKey: "user_a" }, { label: "B", apiKey: "user_b" }],
    })
    pool.markRejected("user_b", "invalid-credential", 0)
    const picked = pool.select("gpt-5.6-luna", {
      modelRules: [{ models: ["gpt-5.6-luna"], account: "account-2" }],
    })
    assert.equal(picked.key, "user_a", "the request must still be served")
  })

  await test("selecting with every account disabled yields nothing", () => {
    const pool = createAccountPool({
      env: {},
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "A", apiKey: "user_a" }],
    })
    pool.markRejected("user_a", "invalid-credential", 0)
    assert.equal(pool.select("m"), undefined)
  })

  await test("a preferred account wins when it is usable", () => {
    const pool = createAccountPool({
      env: {},
      homeDir: "C:\\nonexistent-home",
      accounts: [{ label: "A", apiKey: "user_a" }, { label: "B", apiKey: "user_b" }],
    })
    assert.equal(pool.select("m", { preferredId: "account-2" }).key, "user_b")
    // "auto" means no pin.
    assert.equal(pool.select("m", { preferredId: "auto" }).key, "user_a")
    // An unusable pin falls back to rotation.
    pool.markRejected("user_b", "invalid-credential", 0)
    assert.equal(pool.select("m", { preferredId: "account-2" }).key, "user_a")
  })

  section("usage parsing")

  await test("usage/summary maps to the dashboard fields", () => {
    const parsed = parseUsageTotals({
      totalCount: 12,
      totalCost: 1.25,
      successRate: 91.67,
      completedCount: 11,
      failedCount: 1,
      totalTokensIn: 1000,
      totalTokensOut: 250,
      totalCredits: 0.5,
      periodBasis: "billing-period",
    })
    assert.equal(parsed.completedCount, 11)
    assert.equal(parsed.failedCount, 1)
    assert.equal(parsed.successRate, 91.67)
    assert.equal(parsed.totalCost, 1.25)
    assert.equal(parsed.totalTokensIn, 1000)
    assert.equal(parsed.totalTokensOut, 250)
  })

  await test("billing/credits keeps the reported flags and both windows", () => {
    const limits = parseCreditLimits({
      credits: { monthlyCredits: 3, purchasedCredits: 1 },
      windowLimits: {
        fiveHour: { used: 1, cap: 5, exceeded: false, resetAt: 111 },
        weekly: { used: 20, cap: 20, exceeded: true, resetAt: 222 },
      },
    })
    assert.equal(limits.monthlyCredits, 3)
    assert.equal(limits.purchasedCredits, 1)
    assert.equal(limits.freeCredits, 0)
    // freeCredits was absent, so it must be flagged as not reported rather than
    // rendered as a real "0 left".
    assert.equal(limits.freeReported, false)
    assert.equal(limits.monthlyReported, true)
    assert.equal(limits.fiveHour.cap, 5)
    assert.equal(limits.weekly.exceeded, true)
  })

  await test("an unreported window is absent, not a zeroed limit", () => {
    const limits = parseCreditLimits({ credits: { monthlyCredits: 1 } })
    assert.equal(limits.fiveHour, undefined)
    assert.equal(limits.weekly, undefined)
  })

  await test("only an all-four-401 failure is reported as an invalid key", () => {
      const four = ["a", "b", "c", "d"]
      // All four endpoints rejecting with 401 is the only "key is invalid" case.
      assert.equal(
        classifyTotalFailure(four, [401, 401, 401, 401]),
        "invalid-key",
      )
      assert.equal(
        classifyTotalFailure(four, [503, 500, 502, 500]),
        "service-unavailable",
      )
      assert.equal(classifyTotalFailure(four, [undefined, undefined, undefined, undefined]), "network")
      // A partial failure is explained per endpoint, not as a blanket block:
      // one 401 among four must NOT claim the key is invalid.
      assert.equal(classifyTotalFailure(["a", "b", "c", "d"], [401, 200, 200, 200]), undefined)
      assert.equal(classifyTotalFailure(["a"], [401]), undefined, "fewer than four is partial")
    })

  await test("probeAccountWindows treats ANY exceeded window as exhausted", () => {
    // A clear five-hour window with a spent weekly quota must stay exhausted, and
    // the binding deadline is the LATER reset.
    const report = parseCreditLimits({
      windowLimits: {
        fiveHour: { used: 0, cap: 5, exceeded: false, resetAt: 100 },
        weekly: { used: 20, cap: 20, exceeded: true, resetAt: 999 },
      },
    })
    const exceeded = [report.fiveHour, report.weekly].filter((w) => w.exceeded)
    assert.equal(exceeded.length, 1)
    assert.equal(Math.max(...exceeded.map((w) => w.resetAt)), 999)
  })

  await test("the transport decision follows the plan tier, not a probe", () => {
    const { requiresMessagesEndpoint } = require("../lib/cc-tables.js")
    // Claude ids always take the CLI transport.
    assert.equal(requiresMessagesEndpoint("claude-sonnet-4-6"), true)
    assert.equal(requiresMessagesEndpoint("claude-opus-5"), true)
    assert.equal(requiresMessagesEndpoint("gpt-5.6-luna"), false)
  })

  await test("subscription plan ids resolve to a tier, Go being weight 0", () => {
    const { subscriptionPlanInfo } = require("../lib/cc-tables.js")
    assert.equal(subscriptionPlanInfo("individual-go").tierWeight, 0)
    assert.equal(subscriptionPlanInfo("individual-goat").tierWeight, 1)
    assert.equal(subscriptionPlanInfo("individual-pro-v1").name, "Pro")
    assert.equal(subscriptionPlanInfo("nonsense-plan"), undefined)
  })

  await test("the plan filter hides models above the account tier", () => {
    const { modelVisibleInPlan } = require("../lib/cc-tables.js")
    const go = { tierWeight: 0, onDemandCredits: 0 }
    // A Go account sees Go models but not Provider-tier ones.
    assert.equal(modelVisibleInPlan("gpt-5.6-luna", go), true)
    assert.equal(modelVisibleInPlan("gpt-5.6-sol", go), false)
    // Any on-demand balance lifts the gate entirely.
    assert.equal(modelVisibleInPlan("gpt-5.6-sol", { tierWeight: 0, onDemandCredits: 5 }), true)
    // An unknown plan cannot be filtered.
    assert.equal(modelVisibleInPlan("gpt-5.6-sol", undefined), true)
  })

  await test("readCachedModels round-trips a written cache", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cache-"))
    const cachePath = path.join(dir, "models.json")
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          {
            id: "x",
            name: "X",
            contextWindow: 1000,
            maxTokens: 100,
            image: false,
            reasoning: true,
            efforts: ["low"],
            endpoints: ["/chat/completions"],
            apiStyle: "chat_completions",
          },
        ],
      }),
    )
    const cached = readCachedModels(cachePath, fs)
    assert.equal(cached.length, 1)
    assert.equal(cached[0].reasoning, true)
    assert.equal(readCachedModels(path.join(dir, "missing.json"), fs), undefined)
  })

  section("reasoning level (declared, not configured here)")

  await test("declaredThinkingLevels publishes only host-known levels", () => {
    assert.equal(declaredThinkingLevels({ reasoning: false, efforts: ["low"] }), undefined)
    assert.equal(declaredThinkingLevels({ reasoning: true, efforts: [] }), undefined)
    // A level the host does not know would be filtered away silently, so it is
    // dropped here rather than producing a menu with holes.
    assert.deepEqual(declaredThinkingLevels({ reasoning: true, efforts: ["turbo", "high"] }), [
      "off",
      "high",
    ])
    assert.deepEqual(declaredThinkingLevels({ reasoning: true, efforts: ["medium", "max"] }), [
      "off",
      "medium",
      "max",
    ])
    // "off" is always offered, so thinking can be turned off.
    assert.ok(declaredThinkingLevels({ reasoning: true, efforts: ["high"] }).includes("off"))
    for (const level of declaredThinkingLevels({ reasoning: true, efforts: ["low", "xhigh"] })) {
      assert.ok(HOST_THINKING_LEVELS.includes(level), `${level} must be a host level`)
    }
  })

  await test("a declaration carries the levels and a default inside them", () => {
    const { declarations } = buildProviderDeclarations(
      [
        {
          id: "reasoner",
          name: "Reasoner",
          contextWindow: 1000,
          maxTokens: 100,
          image: false,
          reasoning: true,
          efforts: ["low", "medium", "high"],
          apiStyle: "chat_completions",
        },
      ],
      { chat_completions: "http://127.0.0.1:1/v1", anthropic_messages: "http://127.0.0.1:1" },
    )
    const model = declarations[0].models[0]
    assert.deepEqual(model.thinkingLevels, ["off", "low", "medium", "high"])
    assert.equal(model.defaultThinkingLevel, "medium")
    assert.ok(model.thinkingLevels.includes(model.defaultThinkingLevel))
    // A model with no reasoning metadata publishes no menu at all.
    assert.equal(declaredThinkingLevels({ reasoning: false, efforts: [] }), undefined)
  })

  await test("decodeAnthropicRequest reports a real level, never auto", () => {
    const explicit = decodeAnthropicRequest({
      model: "claude-sonnet-4-6",
      thinking: { type: "enabled", effort: "xhigh" },
    })
    assert.equal(explicit.reasoningEffort, "xhigh")
    assert.equal(explicit.thinkingEnabled, true)

    const budgeted = decodeAnthropicRequest({
      model: "claude-sonnet-4-6",
      thinking: { type: "enabled", budget_tokens: 4096 },
    })
    assert.equal(budgeted.reasoningEffort, "medium")
    // The bug this replaces: the old code sent the literal string "auto", which
    // Command Code rejects, silently discarding the user's choice.
    assert.notEqual(budgeted.reasoningEffort, "auto")

    const adaptive = decodeAnthropicRequest({
      model: "claude-sonnet-4-6",
      thinking: { type: "adaptive" },
    })
    assert.equal(adaptive.thinkingEnabled, true)
    assert.equal(adaptive.reasoningEffort, DEFAULT_THINKING_EFFORT)

    const off = decodeAnthropicRequest({ model: "claude-sonnet-4-6" })
    assert.equal(off.reasoningEffort, undefined)
    assert.equal(off.thinkingEnabled, false)
  })

  await test("effortFromThinking maps a token budget onto the nearest level", () => {
    assert.equal(effortFromThinking({ budget_tokens: 1024 }), "low")
    assert.equal(effortFromThinking({ budget_tokens: 4096 }), "medium")
    assert.equal(effortFromThinking({ budget_tokens: 16000 }), "high")
    assert.equal(effortFromThinking({ budget_tokens: 40000 }), "xhigh")
    assert.equal(effortFromThinking({ budget_tokens: 100000 }), "max")
    // An explicit effort always wins over the budget.
    assert.equal(effortFromThinking({ effort: "low", budget_tokens: 100000 }), "low")
    assert.equal(effortFromThinking({}), DEFAULT_THINKING_EFFORT)
    assert.equal(effortFromThinking(undefined), DEFAULT_THINKING_EFFORT)
  })

  section("catalog refresh (conditional request)")

  await test("an unchanged catalog is reused via ETag instead of re-downloaded", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-etag-"))
    const cachePath = path.join(dir, "models.json")
    const seenHeaders = []

    const body = {
      data: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          context_length: 1050000,
          supported_endpoints: ["/chat/completions"],
        },
      ],
    }
    const jsonResponse = (payload) => ({
      status: 200,
      ok: true,
      headers: { get: (name) => (name.toLowerCase() === "etag" ? '"v1"' : null) },
      json: async () => payload,
    })
    const notModified = {
      status: 304,
      ok: false,
      headers: { get: () => null },
      json: async () => {
        throw new Error("a 304 must not carry a body")
      },
    }

    const first = await loadModels({
      url: "http://example.test/models",
      cachePath,
      fs,
      fetch: async (_url, init) => {
        seenHeaders.push(init.headers)
        return jsonResponse(body)
      },
    })
    assert.equal(first.source, "live")
    assert.equal(first.models.length, 1)

    // The second refresh must be conditional and must not parse a body.
    const second = await loadModels({
      url: "http://example.test/models",
      cachePath,
      fs,
      fetch: async (_url, init) => {
        seenHeaders.push(init.headers)
        return notModified
      },
    })
    assert.equal(second.source, "cache-validated")
    assert.equal(second.models.length, 1)
    assert.equal(seenHeaders[1]["if-none-match"], '"v1"')

    // And a cold cache with no validators sends no conditional header.
    const other = path.join(dir, "other.json")
    await loadModels({
      url: "http://example.test/models",
      cachePath: other,
      fs,
      fetch: async (_url, init) => {
        seenHeaders.push(init.headers)
        return jsonResponse(body)
      },
    })
    assert.equal(seenHeaders[2]["if-none-match"], undefined)
  })

  await test("a failed refresh keeps the cached list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-offline-"))
    const cachePath = path.join(dir, "models.json")
    const body = {
      data: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          context_length: 1050000,
          supported_endpoints: ["/chat/completions"],
        },
      ],
    }
    await loadModels({
      url: "http://example.test/models",
      cachePath,
      fs,
      fetch: async () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => body,
      }),
    })
    const offline = await loadModels({
      url: "http://example.test/models",
      cachePath,
      fs,
      fetch: async () => {
        throw new Error("offline")
      },
    })
    assert.equal(offline.source, "cache")
    assert.equal(offline.models.length, 1)
    assert.match(offline.warning, /offline/)
  })

  // -------------------------------------------------------------------------

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log("\nfailures:")
    for (const { name, error } of failures) console.log(`- ${name}: ${error.message}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("test harness crashed:", error)
  process.exit(1)
})
