/**
 * Panel renderer for the Command Code plugin.
 *
 * Runs inside the host's plugin panel window (780x820). Plain ES2020, no build
 * step and no dependencies: every host call goes through
 * `window.pluginBridge.invoke(channel, payload)`, which the plugin process
 * answers for the `cc.*` channels. All user-visible text is Chinese.
 *
 * Rendering rules that come from the data contract rather than from taste:
 *   - `credits.monthlyReported === false` means "not reported": show an em dash,
 *     never $0.00 (same for purchased/free).
 *   - A missing `fiveHour` / `weekly` window draws no row at all; `cap === 0`
 *     means unlimited and shows "—" instead of 0%.
 *   - `usage.successRate` is already a percentage (91.67): at most two decimals,
 *     trailing zeros trimmed.
 *   - `report.blocked` gets one plain sentence above the metrics; `failures` is
 *     listed verbatim at the bottom.
 *
 * Loading strategy: `cc.state` first and alone; `cc.usage` is a second, separate
 * request issued once after the state render, then only on demand.
 */

const bridge = window.pluginBridge
const bridgeAvailable = Boolean(bridge) && typeof bridge.invoke === "function"

/**
 * Message shown whenever no host call can be made. `stateError` carries it so
 * every section renders its own error/empty state instead of an eternal
 * skeleton — a panel with no bridge must not look like a panel that is loading.
 */
const NO_BRIDGE_ERROR = "宿主面板桥不可用（window.pluginBridge 缺失）"

const el = (id) => document.getElementById(id)

const ui = {
  live: el("live"),
  banner: el("banner"),

  usageStatus: el("usageStatus"),
  usageRefresh: el("usageRefresh"),
  usageBody: el("usageBody"),

  addAccount: el("addAccount"),
  accountForm: el("accountForm"),
  accountList: el("accountList"),
  accountStatusLine: el("accountStatusLine"),
  poolHint: el("poolHint"),
  probeWindows: el("probeWindows"),
  resetAccounts: el("resetAccounts"),

  resetPreferred: el("resetPreferred"),
  preferredAccount: el("preferredAccount"),
  preferredHint: el("preferredHint"),
  preferredStatus: el("preferredStatus"),

  addRule: el("addRule"),
  ruleForm: el("ruleForm"),
  ruleList: el("ruleList"),
  ruleStatusLine: el("ruleStatusLine"),

  whitelistCount: el("whitelistCount"),
  toggleWhitelist: el("toggleWhitelist"),
  whitelistPanel: el("whitelistPanel"),
  whitelistSearch: el("whitelistSearch"),
  whitelistAll: el("whitelistAll"),
  whitelistNone: el("whitelistNone"),
  whitelistList: el("whitelistList"),
  whitelistStatus: el("whitelistStatus"),
  whitelistSummary: el("whitelistSummary"),

  credentialBadge: el("credentialBadge"),
  loginAccountList: el("loginAccountList"),
  credentialSource: el("credentialSource"),

  login: el("login"),
  loginStatus: el("loginStatus"),

  advancedCount: el("advancedCount"),
  toggleAdvanced: el("toggleAdvanced"),
  advancedBody: el("advancedBody"),
  advancedFields: el("advancedFields"),
  advancedStatus: el("advancedStatus"),

  transportSeg: el("transportSeg"),
  transportHint: el("transportHint"),
  resetTransport: el("resetTransport"),
  enabled: el("enabled"),
  zdr: el("zdr"),

  diagBadge: el("diagBadge"),
  toggleDiag: el("toggleDiag"),
  diagBody: el("diagBody"),
  diagList: el("diagList"),
  diagNotes: el("diagNotes"),
  diagPath: el("diagPath"),
  openLog: el("openLog"),
  refreshModels: el("refreshModels"),
  diagStatus: el("diagStatus"),
}

/* ------------------------------------------------------------------ labels */

const TRANSPORT_TEXT = {
  unknown: "尚未发出请求",
  provider: "标准 Provider API",
  generate: "/alpha/generate",
}

const TRANSPORT_PREF_TEXT = {
  auto: "自动（先用标准接口，Go 账号自动降级）",
  generate: "始终使用 /alpha/generate（Go 订阅账号）",
  provider: "始终使用标准 Provider API",
}

const CREDENTIAL_TEXT = {
  login: "已登录账户",
  "local-auth-file": "本机已有的登录文件",
  none: "未登录",
}

const BLOCKED_TEXT = {
  "invalid-key": "登录已失效：Command Code 的四个接口全部返回 401，请在上方重新登录。",
  "service-unavailable": "服务不可用：Command Code 接口全部返回 5xx，稍后重试。",
  network: "网络不通：无法连接 Command Code 接口，请检查网络或代理设置。",
}

/** Advanced fields: value defaults double as the reset target. */
const ADVANCED_FIELDS = [
  {
    key: "apiBase",
    label: "API 地址",
    kind: "text",
    placeholder: "https://api.commandcode.ai",
    help: "留空使用默认地址。仅在需要走自建网关时填写。",
    empty: "",
  },
  {
    key: "workingDir",
    label: "工作目录",
    kind: "text",
    placeholder: "（进程工作目录）",
    help: "可选。留空时使用占位符显示的进程工作目录；仅在需要固定路径时填写。",
    empty: "",
  },
  {
    key: "requestTimeoutMs",
    label: "请求超时（毫秒）",
    kind: "number",
    placeholder: "60000",
    help: "等待响应首个字节的超时；默认 60000。",
    empty: 0,
  },
  {
    key: "streamIdleTimeoutMs",
    label: "流空闲超时（毫秒）",
    kind: "number",
    placeholder: "300000",
    help: "生成流停滞多久视为断流；默认 300000（长思考模型可静默数分钟，默认值刻意放宽）。",
    empty: 0,
  },
  {
    key: "transportRetries",
    label: "网络失败重试次数",
    kind: "number",
    placeholder: "5",
    help: "传输失败时自动重试几次，默认 5（各次等待 0.5+1+2+4+8 秒，合计约 15 秒）。限流、5xx 等可重试状态也由这个预算控制；填 0 表示完全不重试。",
    empty: 5,
  },
  {
    key: "hideOutOfPlan",
    label: "隐藏套餐外模型",
    kind: "switch",
    help: "不在当前套餐内的模型不出现在模型选择器里。",
    empty: false,
  },
  {
    key: "webSearch",
    label: "用 Command Code 承载联网搜索",
    kind: "switch",
    help: "宿主发起联网搜索时走 Command Code 而不是内置搜索。",
    empty: false,
  },
  {
    key: "sidebarQuota",
    label: "在侧边栏显示额度卡片",
    kind: "switch",
    help: "在侧边栏常驻一张额度卡片。",
    empty: false,
  },
]

/* ------------------------------------------------------------------ state */

let state = null
let usage = null
let usageLoading = false
let stateError = ""
let autoUsageRequested = false

const view = {
  accountFormOpen: false,
  ruleFormOpen: false,
  whitelistOpen: false,
  whitelistQuery: "",
  advancedOpen: false,
  diagOpen: false,
}

/* ----------------------------------------------------------------- helpers */

function make(tag, options = {}) {
  const node = document.createElement(tag)
  if (options.class) node.className = options.class
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text)
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value === undefined || value === null || value === false) continue
      node.setAttribute(name, value === true ? "" : String(value))
    }
  }
  if (options.props) Object.assign(node, options.props)
  if (options.focusKey) node.dataset.focusKey = options.focusKey
  if (options.on) {
    for (const [type, handler] of Object.entries(options.on)) node.addEventListener(type, handler)
  }
  return node
}

function field(labelText, control, forId) {
  const wrap = make("div", { class: "field" })
  wrap.append(
    make("label", {
      class: "field-label",
      text: labelText,
      attrs: forId ? { for: forId } : undefined,
    }),
    control,
  )
  return wrap
}

function emptyBlock(message, action) {
  const block = make("div", { class: "empty" })
  block.append(make("p", { class: "empty-text", text: message }))
  if (action) {
    block.append(
      make("button", {
        class: "btn small",
        text: action.label,
        props: { type: "button" },
        on: { click: action.onClick },
      }),
    )
  }
  return block
}

function loadingBlock(lines = 3) {
  const block = make("div", { class: "loading", attrs: { "aria-hidden": "true" } })
  for (let index = 0; index < lines; index += 1) {
    block.append(make("div", { class: index === 0 ? "skeleton w60" : "skeleton" }))
  }
  return block
}

function setStatus(node, message, kind) {
  if (!node) return
  if (!message) {
    node.hidden = true
    node.textContent = ""
    node.className = "status-line"
    return
  }
  node.hidden = false
  node.textContent = message
  node.className = `status-line${kind ? ` ${kind}` : ""}`
}

function setLive(message) {
  if (ui.live) ui.live.textContent = message
}

function badge(text, kind) {
  return make("span", { class: `badge${kind ? ` ${kind}` : ""}`, text })
}

function tag(text) {
  return make("span", { class: "tag", text })
}

/**
 * Two-step destructive button: the first click arms (and relabels), the second
 * commits. A 4s idle window disarms, so a stray click cannot delete anything.
 */
function armButton(button, onConfirm, armedLabel = "确认删除") {
  const label = button.textContent
  let armed = false
  let timer
  button.addEventListener("click", () => {
    if (!armed) {
      armed = true
      button.textContent = armedLabel
      button.classList.add("danger")
      setLive(`${label}：再次点击确认`)
      timer = setTimeout(() => {
        armed = false
        button.textContent = label
        button.classList.remove("danger")
      }, 4000)
      return
    }
    clearTimeout(timer)
    button.disabled = true
    onConfirm()
  })
}

async function withBusy(button, busyText, task) {
  const label = button.textContent
  button.disabled = true
  if (busyText) button.textContent = busyText
  try {
    return await task()
  } finally {
    button.disabled = false
    if (busyText) button.textContent = label
  }
}

/* --------------------------------------------------------------- formatting */

const numberFormat = new Intl.NumberFormat("en-US")

function fmtCount(value) {
  return Number.isFinite(value) ? numberFormat.format(value) : "—"
}

function trimZero(value) {
  return String(Math.round(value * 10) / 10)
}

function fmtCompact(value) {
  if (!Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${trimZero(value / 1e9)}B`
  if (abs >= 1e6) return `${trimZero(value / 1e6)}M`
  if (abs >= 1e4) return `${trimZero(value / 1e3)}K`
  return numberFormat.format(value)
}

/** Already a percentage (91.67) — at most two decimals, no trailing zeros. */
function fmtPercent(value) {
  if (!Number.isFinite(value)) return "—"
  return `${String(Math.round(value * 100) / 100)}%`
}

function fmtMoney(value, digits) {
  if (!Number.isFinite(value)) return "—"
  return `$${value.toFixed(digits)}`
}

function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false })
}

/**
 * Window/period timestamps arrive as millis, but the upstream family also emits
 * seconds in places; anything implausibly small is read as seconds.
 */
function toMillis(value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value > 1e11 ? value : value * 1000
}

function fmtDateTime(value) {
  if (!value) return "—"
  const parsed = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(parsed)) return String(value)
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false })
}

function settingsOf() {
  return state?.settings ?? {}
}

function poolAccounts() {
  return state?.accounts ?? []
}

function poolById(id) {
  return poolAccounts().find((entry) => entry.id === id)
}

/** Settings entry behind a pool slot id (`account-1` -> settings.accounts[0]). */

function poolBadge(account) {
  if (!account) return badge("未知", "warn")
  if (!account.configured) return badge("未配置", "warn")
  if (account.state === "disabled") return badge("已停用", "error")
  if (account.state === "cooldown" && account.cooldownUntil > Date.now()) {
    return badge("冷却中", "warn")
  }
  if (account.usable) return badge("可用", "ok")
  return badge("限流", "warn")
}

/** How the account list labels where a slot's credential came from. */
function credentialSourceText(account) {
  if (!account) return "未知"
  if (account.id === "default") {
    return account.configured ? "主登录账户" : (CREDENTIAL_TEXT[state?.credential] ?? "未登录")
  }
  return account.configured ? "已登录账户" : "未登录"
}

/* ------------------------------------------------------------------- usage */

function renderUsage() {
  const body = ui.usageBody
  const previousFocus = document.activeElement?.dataset?.focusKey
  body.replaceChildren()

  if (stateError) {
    body.append(emptyBlock(`无法读取用量：${stateError}`))
    return
  }
  if (!usage) {
    body.append(usageLoading ? loadingBlock(4) : emptyBlock("尚未加载用量。"))
    return
  }
  if (usage.error) {
    body.append(make("p", { class: "notice", text: `用量读取失败：${usage.error}` }))
  }

  const accounts = Array.isArray(usage.accounts) ? usage.accounts : []
  if (accounts.length === 0) {
    body.append(
      emptyBlock("尚未登录。点上面的「登录新账户」完成官方授权后即可看到用量。", {
        label: "去登录",
        onClick: focusKeySection,
      }),
    )
    restoreFocus(previousFocus)
    return
  }

  const fragment = document.createDocumentFragment()
  accounts.forEach((entry, index) => fragment.append(usageCard(entry, index)))
  body.append(fragment)
  restoreFocus(previousFocus)
}

function usageCard(entry, index) {
  const report = entry.report ?? {}
  const pool = poolById(entry.id)
  const card = make("div", { class: "usage-account" })
  card.style.setProperty("--i", String(index))
  if (entry.mark) card.classList.add("marked")

  /* header: name + current badge + account id, then one line of small print */
  const head = make("div", { class: "usage-head" })
  const name = report.account?.name || report.account?.userName || entry.label || entry.id
  head.append(make("span", { class: "usage-name", text: name }))
  if (entry.active) head.append(badge("当前使用", "accent"))
  if (entry.mark === "rate-limit") head.append(badge("限流", "warn"))
  if (entry.mark === "invalid-credential") head.append(badge("登录失效", "error"))
  if (report.blocked) head.append(badge("接口不可用", "error"))
  head.append(make("span", { class: "mono usage-sub", text: entry.id }))
  card.append(head)

  card.append(make("p", { class: "usage-sub", text: usageSubLine(entry, pool, report) }))

  if (report.blocked) {
    card.append(
      make("p", { class: "notice", text: BLOCKED_TEXT[report.blocked] ?? `接口不可用（${report.blocked}）` }),
    )
  }

  card.append(usageMetrics(report.usage))
  card.append(usageCredits(report.credits))
  const windows = usageWindows(report.credits)
  if (windows) card.append(windows)

  const failures = Array.isArray(report.failures) ? report.failures : []
  if (failures.length > 0) {
    card.append(make("p", { class: "usage-sub", text: "端点失败详情" }))
    const list = make("ul", { class: "failures" })
    for (const failure of failures) list.append(make("li", { text: failure }))
    card.append(list)
  }

  card.append(
    make("div", {
      class: "usage-foot",
      text: `更新于 ${fmtClock(usage?.fetchedAt ?? Date.now())}`,
    }),
  )
  return card
}

function usageSubLine(entry, pool, report) {
  const parts = []
  if (entry.mark === "invalid-credential") {
    parts.push("登录失效（401），已停用该账户")
  } else if (entry.mark === "rate-limit") {
    parts.push("达到用量限额（429）")
  } else if (report.blocked) {
    // Every endpoint failed, so the pool's "usable" flag is stale and must not
    // be printed next to the failure sentence.
    parts.push("本次读取全部端点失败")
  } else if (pool && !pool.configured) {
    parts.push("未登录")
  } else if (pool?.state === "cooldown" && pool.cooldownUntil > Date.now()) {
    parts.push(`冷却至 ${fmtClock(pool.cooldownUntil)}`)
  } else if (pool?.reason) {
    parts.push(pool.reason)
  } else if (pool?.usable) {
    parts.push("账户可用")
  }

  const account = report.account
  if (account && (account.userName || account.name)) {
    parts.push(`账号 ${account.userName || account.name}`)
  }
  const plan = report.plan
  if (plan && (plan.name || plan.planId)) {
    const status = plan.status ? `（${plan.status}）` : ""
    const periodEnd = toMillis(plan.currentPeriodEnd)
    const period = periodEnd ? ` · 周期至 ${fmtDateTime(periodEnd)}` : ""
    parts.push(`套餐 ${plan.name || plan.planId}${status}${period}`)
  }
  return parts.length > 0 ? parts.join(" · ") : "—"
}

function metric(name, value, detail, small) {
  const box = make("div", { class: "metric" })
  box.append(
    make("span", { class: "metric-name", text: name }),
    make("span", { class: `metric-value${small ? " small" : ""}`, text: value }),
  )
  if (detail !== undefined) box.append(make("span", { class: "metric-detail", text: detail }))
  return box
}

function usageMetrics(totals) {
  const grid = make("div", { class: "metrics" })
  if (!totals) {
    grid.append(
      metric("请求", "—", "失败 —"),
      metric("成功率", "—", "完成 —"),
      metric("花费", "—", "— credits"),
      metric("Token", "—", "— 入 / — 出"),
    )
    return grid
  }
  const tokens = (totals.totalTokensIn ?? 0) + (totals.totalTokensOut ?? 0)
  grid.append(
    metric("请求", fmtCount(totals.totalCount), `失败 ${fmtCount(totals.failedCount)}`),
    metric("成功率", fmtPercent(totals.successRate), `完成 ${fmtCount(totals.completedCount)}`),
    metric(
      "花费",
      fmtMoney(totals.totalCost, 4),
      `${fmtMoney(totals.totalCredits, 2)} credits`,
    ),
    metric(
      "Token",
      fmtCompact(tokens),
      `${fmtCompact(totals.totalTokensIn)} 入 / ${fmtCompact(totals.totalTokensOut)} 出`,
    ),
  )
  return grid
}

/** `reported === false` means "not reported", never "$0.00". */
function creditAmount(value, reported) {
  if (reported === false) return "—"
  return Number.isFinite(value) ? fmtMoney(value, 2) : "—"
}

function usageCredits(credits) {
  const row = make("div", { class: "credits-row" })
  const entries = [
    ["月额度", credits?.monthlyCredits, credits?.monthlyReported],
    ["已购", credits?.purchasedCredits, credits?.purchasedReported],
    ["赠送", credits?.freeCredits, credits?.freeReported],
  ]
  for (const [name, value, reported] of entries) {
    const item = make("div", { class: "credit" })
    item.append(
      make("span", { class: "credit-name", text: name }),
      make("span", { class: "credit-value", text: creditAmount(value, reported) }),
    )
    row.append(item)
  }
  return row
}

/** A window row exists only when the account published that window. */
function usageWindows(credits) {
  const rows = []
  for (const [label, window] of [
    ["5 小时额度", credits?.fiveHour],
    ["每周额度", credits?.weekly],
  ]) {
    if (!window) continue
    rows.push(windowRow(label, window))
  }
  if (rows.length === 0) return null
  const wrap = make("div", { class: "windows" })
  for (const row of rows) wrap.append(row)
  return wrap
}

function windowRow(label, window) {
  const used = Number.isFinite(window.used) ? window.used : 0
  const cap = Number.isFinite(window.cap) ? window.cap : 0
  const unlimited = cap <= 0
  const ratio = unlimited ? 0 : Math.min(1, used / cap)

  const row = make("div", { class: "window-row" })
  row.append(make("span", { class: "window-label", text: label }))
  if (!unlimited) {
    const bar = make("span", { class: "bar" })
    bar.append(
      make("span", {
        class: `bar-fill${window.exceeded ? " over" : ""}`,
        attrs: { style: `width: ${Math.round(ratio * 100)}%` },
      }),
    )
    row.append(bar)
  }
  row.append(
    make("span", {
      class: "window-meta",
      text: unlimited
        ? `${fmtMoney(used, 2)} / 无限额`
        : `${fmtMoney(used, 2)} / ${fmtMoney(cap, 2)}`,
    }),
    make("span", {
      class: "window-meta",
      text: unlimited ? "—" : `${Math.round(ratio * 100)}%`,
    }),
  )
  const resetAt = toMillis(window.resetAt)
  if (resetAt > 0) row.append(make("span", { class: "window-meta", text: `重置 ${fmtClock(resetAt)}` }))
  if (window.exceeded) row.append(badge("已超限", "error"))
  return row
}

async function refreshUsage(button) {
  if (usageLoading) return
  usageLoading = true
  if (!usage) renderUsage()
  setStatus(ui.usageStatus, "正在读取…", "busy")
  if (button) button.disabled = true
  try {
    usage = await invoke("cc.usage")
    setStatus(ui.usageStatus, "")
    setLive("用量已更新")
  } catch (error) {
    usage = { accounts: [], error: String(error?.message ?? error), fetchedAt: Date.now() }
    setStatus(ui.usageStatus, "")
  } finally {
    usageLoading = false
    if (button) button.disabled = false
    renderUsage()
  }
}

/* ------------------------------------------------------------ account pool */

function renderAccountList() {
  const accounts = poolAccounts()
  ui.accountList.replaceChildren()

  if (stateError) {
    ui.accountList.append(emptyBlock(`无法读取账户：${stateError}`))
    ui.poolHint.textContent = ""
    return
  }
  if (!state) {
    ui.accountList.append(loadingBlock(2))
    ui.poolHint.textContent = ""
    return
  }
  if (accounts.length === 0) {
  ui.accountList.append(emptyBlock("尚未配置账户。请在上面「账号登录」里登录一个账号。"))
  }

  const fragment = document.createDocumentFragment()
  accounts.forEach((account, index) => {
    const item = make("li")
    item.style.setProperty("--i", String(index))

    const main = make("div", { class: "item-main" })
    const title = make("div", { class: "item-title" })
    title.append(
      make("span", { text: account.label || account.id }),
      poolBadge(account),
      make("span", { class: "mono item-sub", text: account.id }),
    )
    if (account.id === "default") title.append(tag("主账户"))
    main.append(title)

    const details = [`凭据来源 ${credentialSourceText(account)}`]
    if (account.state === "cooldown" && account.cooldownUntil > Date.now()) {
      details.push(`冷却至 ${fmtClock(account.cooldownUntil)}`)
    } else if (account.reason) {
      details.push(account.reason)
    }
    main.append(make("div", { class: "item-sub", text: details.join(" · ") }))
    item.append(main)

    const actions = make("div", { class: "item-actions" })
    if (account.id === "default") {
      actions.append(make("span", { class: "item-sub", text: "不可删除" }))
    } else {
      const remove = make("button", {
        class: "btn small ghost",
        text: "删除",
        props: { type: "button" },
        attrs: { "aria-label": `删除账户 ${account.label || account.id}` },
      })
      armButton(remove, () => removeAccount(account))
      actions.append(remove)
    }
    item.append(actions)
    fragment.append(item)
  })
  ui.accountList.append(fragment)

  const configured = accounts.filter((account) => account.configured).length
  const hints = [`共 ${accounts.length} 个账户槽位，已配置 ${configured} 个`]
  const cooldowns = accounts
    .filter((account) => account.state === "cooldown" && account.cooldownUntil > Date.now())
    .map((account) => account.cooldownUntil)
  if (cooldowns.length > 0) {
    hints.push(`最早恢复时间 ${fmtClock(Math.min(...cooldowns))}`)
  }
  if (state.localAuthFile) hints.push("本机已有登录文件可作为回退凭据")
  ui.poolHint.textContent = hints.join(" · ")
}

function renderAccountForm() {
  const form = ui.accountForm
  form.replaceChildren()
  if (!view.accountFormOpen) {
    form.hidden = true
    return
  }
  form.hidden = false

  const labelInput = make("input", {
    class: "input",
    props: {
      type: "text",
      id: "newAccountLabel",
      value: "",
      placeholder: `账户 ${(settingsOf().accounts?.length ?? 0) + 2}`,
    },
    focusKey: "new-account-label",
  })

  // No key field: an account is added by signing in, and the label is optional
  // because the login itself reports who signed in.
  const note = make("p", {
    class: "hint subform-note",
    text: "点「添加」会打开浏览器完成一次官方登录；标签可以留空，登录后会使用账号自己的名字。",
  })

  const submit = make("button", {
    class: "btn small primary",
    text: "添加",
    props: { type: "button" },
    focusKey: "new-account-submit",
  })
  submit.addEventListener("click", () => withBusy(submit, "登录中…", () => addAccount(labelInput)))

  const cancel = make("button", {
    class: "btn small ghost",
    text: "取消",
    props: { type: "button" },
    on: {
      click: () => {
        view.accountFormOpen = false
        setStatus(ui.accountStatusLine, "")
        renderAccountForm()
        ui.addAccount.setAttribute("aria-expanded", "false")
      },
    },
  })

  const actions = make("div", { class: "form-actions" })
  actions.append(submit, cancel)

  form.append(field("标签（可选）", labelInput, "newAccountLabel"), actions, note)
}

/**
 * Add an account by running the official browser login.
 *
 * The label is only a display preference: the login response identifies the
 * account, and that identity decides whether this refreshes the existing entry
 * or appends a new one.
 */
async function addAccount(labelInput) {
  const label = labelInput.value.trim()
  try {
    const result = await invoke("cc.login")
    if (result && result.ok === false) {
      setStatus(ui.accountStatusLine, `登录失败：${result.error ?? "未知错误"}`, "error")
      return
    }
    state = await invoke("cc.state")
    stateError = ""
    // Apply the optional label to the account that just signed in. The login
    // reports an identity (userId) and a display name, while the label is only a
    // local preference, so match on the identity and fall back to the name.
    if (label) {
      const list = [...(settingsOf().accounts ?? [])]
      const wanted = result?.userName
      const index = list.findIndex(
        (entry) => entry.userId === result?.userId || (wanted && entry.userName === wanted),
      )
      if (index >= 0) {
        list[index] = { ...list[index], label }
        await saveSetting("accounts", list, ui.accountStatusLine)
      }
    }
    view.accountFormOpen = false
    ui.addAccount.setAttribute("aria-expanded", "false")
    setStatus(
      ui.accountStatusLine,
      `已登录${result?.userName ? `「${result.userName}」` : ""}，下一次请求即生效。`,
      "ok",
    )
    setLive("已登录新账户")
    renderAll()
  } catch (error) {
    setStatus(ui.accountStatusLine, `登录失败：${error?.message ?? error}`, "error")
  }
}

async function removeAccount(account) {
  const id = account.accountId ?? account.slot?.id ?? account.id
  try {
    const result = await invoke("cc.removeAccount", { accountId: id })
    if (result && typeof result === "object" && typeof result.error === "string") {
      setStatus(ui.accountStatusLine, `移除失败：${result.error}`, "error")
      return
    }
    state = result
    renderAll()
    setStatus(ui.accountStatusLine, `已移除账户「${account.label}」。`, "ok")
    setLive(`已移除账户 ${account.label}`)
  } catch (error) {
    setStatus(ui.accountStatusLine, `移除失败：${error?.message ?? error}`, "error")
  }
}

/* -------------------------------------------------------- preferred account */

function renderPreferred() {
  const select = ui.preferredAccount
  select.replaceChildren()
  select.disabled = true
  ui.preferredHint.textContent = ""
  if (stateError) {
    select.append(make("option", { text: `无法读取账户：${stateError}` }))
    return
  }
  if (!state) {
    select.append(make("option", { text: "加载中…" }))
    return
  }
  select.disabled = false

  const preferred = settingsOf().preferredAccount ?? "auto"
  select.append(make("option", { text: "自动（第一个可用账户）", props: { value: "auto" } }))
  for (const account of poolAccounts()) {
    const suffix = account.configured ? "" : "（未配置）"
    select.append(
      make("option", {
        text: `${account.label || account.id}${suffix}`,
        props: { value: account.id },
      }),
    )
  }
  if (preferred !== "auto" && !poolAccounts().some((account) => account.id === preferred)) {
    select.append(make("option", { text: `${preferred}（已不存在）`, props: { value: preferred } }))
  }
  select.value = preferred

  if (preferred === "auto") {
    ui.preferredHint.textContent = "按账户顺序自动选择第一个可用账户。"
    return
  }
  const account = poolById(preferred)
  const availability =
    account && !account.usable
      ? "该账户当前不可用，请求会自动回落到其他可用账户。"
      : "固定使用该账户，除非它不可用。"
  ui.preferredHint.textContent = `已固定到「${account?.label ?? preferred}」。${availability}`
}

/* ------------------------------------------------------------ account rules */

function renderRuleList() {
  const rules = settingsOf().modelAccountRules ?? []
  ui.ruleList.replaceChildren()
  if (stateError) {
    ui.ruleList.append(emptyBlock(`无法读取规则：${stateError}`))
    return
  }
  if (!state) {
    ui.ruleList.append(loadingBlock(2))
    return
  }
  if (rules.length === 0) {
    ui.ruleList.append(emptyBlock("尚未配置规则。"))
    return
  }
  const fragment = document.createDocumentFragment()
  rules.forEach((rule, index) => {
    const models = Array.isArray(rule?.models) ? rule.models : []
    const target = poolById(rule?.account)
    const item = make("li")
    item.style.setProperty("--i", String(index))

    const main = make("div", { class: "item-main" })
    const title = make("div", { class: "item-title" })
    for (const model of models) title.append(tag(model))
    if (models.length === 0) title.append(make("span", { class: "item-sub", text: "（没有模型）" }))
    main.append(title)
    main.append(
      make("div", {
        class: "item-sub",
        text: `目标账户 ${target?.label ?? rule?.account ?? "未知"}${target && !target.configured ? "（未配置）" : ""}`,
      }),
    )
    item.append(main)

    const actions = make("div", { class: "item-actions" })
    const remove = make("button", {
      class: "btn small ghost",
      text: "删除",
      props: { type: "button" },
      attrs: { "aria-label": `删除第 ${index + 1} 条规则` },
    })
    armButton(remove, () => removeRule(index))
    actions.append(remove)
    item.append(actions)
    fragment.append(item)
  })
  ui.ruleList.append(fragment)
}

function renderRuleForm() {
  const form = ui.ruleForm
  form.replaceChildren()
  if (!view.ruleFormOpen) {
    form.hidden = true
    return
  }
  form.hidden = false

  const modelsInput = make("input", {
    class: "input",
    props: {
      type: "text",
      id: "newRuleModels",
      value: "",
      placeholder: "claude-sonnet-4-6, gpt-5.6-luna",
    },
    focusKey: "new-rule-models",
  })

  const accountSelect = make("select", {
    props: { id: "newRuleAccount" },
    focusKey: "new-rule-account",
  })
  for (const account of poolAccounts()) {
    accountSelect.append(
      make("option", {
        text: `${account.label || account.id}${account.configured ? "" : "（未配置）"}`,
        props: { value: account.id },
      }),
    )
  }

  const submit = make("button", {
    class: "btn small primary",
    text: "添加规则",
    props: { type: "button" },
    focusKey: "new-rule-submit",
  })
  submit.addEventListener("click", () =>
    withBusy(submit, "保存中…", () => addRule(modelsInput, accountSelect)),
  )

  const cancel = make("button", {
    class: "btn small ghost",
    text: "取消",
    props: { type: "button" },
    on: {
      click: () => {
        view.ruleFormOpen = false
        setStatus(ui.ruleStatusLine, "")
        renderRuleForm()
        ui.addRule.setAttribute("aria-expanded", "false")
      },
    },
  })

  const actions = make("div", { class: "form-actions" })
  actions.append(submit, cancel)

  form.append(
    field("模型 id（逗号分隔）", modelsInput, "newRuleModels"),
    field("目标账户", accountSelect, "newRuleAccount"),
    actions,
  )
  form.append(
    make("p", {
      class: "hint subform-note",
      text: "命中的模型固定使用该账户；同一模型出现在多条规则里时，按列表顺序取第一条。",
    }),
  )
}

async function addRule(modelsInput, accountSelect) {
  const models = modelsInput.value
    .split(/[,，\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (models.length === 0) {
    setStatus(ui.ruleStatusLine, "请至少填写一个模型 id。", "error")
    modelsInput.focus()
    return
  }
  const account = accountSelect.value
  if (!account) {
    setStatus(ui.ruleStatusLine, "请选择目标账户。", "error")
    return
  }
  const rules = [...(settingsOf().modelAccountRules ?? []), { models, account }]
  const ok = await saveSetting("modelAccountRules", rules, ui.ruleStatusLine)
  if (ok) {
    view.ruleFormOpen = false
    ui.addRule.setAttribute("aria-expanded", "false")
    setStatus(ui.ruleStatusLine, `已添加 ${models.length} 个模型的规则。`, "ok")
    setLive("规则已保存")
    renderRuleForm()
  }
}

async function removeRule(index) {
  const rules = [...(settingsOf().modelAccountRules ?? [])]
  if (index < 0 || index >= rules.length) return
  rules.splice(index, 1)
  const ok = await saveSetting("modelAccountRules", rules, ui.ruleStatusLine)
  if (ok) setStatus(ui.ruleStatusLine, "已删除该规则。", "ok")
}

/* ------------------------------------------------------------- whitelist */

function renderWhitelist() {
  const models = state?.models ?? []
  const selected = settingsOf().visibleModels ?? []
  const selectedCount = Array.isArray(selected) ? selected.length : 0

  ui.whitelistCount.textContent =
    selectedCount > 0 ? `已选 ${selectedCount} 个模型` : "显示全部模型"
  ui.toggleWhitelist.textContent = view.whitelistOpen ? "收起" : "显示全部"
  ui.toggleWhitelist.setAttribute("aria-expanded", String(view.whitelistOpen))
  ui.whitelistPanel.hidden = !view.whitelistOpen

  const scrollTop = ui.whitelistList.scrollTop
  ui.whitelistList.replaceChildren()

  if (!view.whitelistOpen) {
    ui.whitelistSummary.textContent = ""
    return
  }
  if (stateError) {
    ui.whitelistList.append(emptyBlock(`无法读取模型列表：${stateError}`))
    ui.whitelistSummary.textContent = ""
    return
  }
  if (!state) {
    ui.whitelistList.append(loadingBlock(4))
    ui.whitelistSummary.textContent = ""
    return
  }
  if (models.length === 0) {
    ui.whitelistList.append(emptyBlock("还没有模型目录，先在「诊断」里刷新一次模型目录。"))
    ui.whitelistSummary.textContent = ""
    ui.whitelistAll.disabled = true
    ui.whitelistNone.disabled = true
    return
  }

  const query = view.whitelistQuery.trim().toLowerCase()
  const matched = query
    ? models.filter(
        (model) =>
          model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
      )
    : models

  if (matched.length === 0) {
    ui.whitelistList.append(emptyBlock("没有匹配的模型。"))
  } else {
    const fragment = document.createDocumentFragment()
    for (const model of matched) {
      fragment.append(whitelistRow(model, selected))
    }
    ui.whitelistList.append(fragment)
  }
  ui.whitelistList.scrollTop = scrollTop
  ui.whitelistAll.disabled = false
  ui.whitelistNone.disabled = false

  const parts = [`目录共 ${models.length} 个模型`]
  if (query) parts.push(`筛出 ${matched.length}`)
  parts.push(
    selectedCount > 0
      ? "模型选择器只列出勾选的模型"
      : "一个都没勾选：模型选择器显示全部模型",
  )
  ui.whitelistSummary.textContent = parts.join(" · ")
}

function whitelistRow(model, selected) {
  const checked = Array.isArray(selected) && selected.includes(model.id)
  const row = make("label", { class: "check-row" })

  const box = make("input", {
    props: { type: "checkbox", checked },
    attrs: { "aria-label": model.name || model.id },
    focusKey: `whitelist:${model.id}`,
  })
  box.addEventListener("change", () => toggleWhitelistModel(model.id, box.checked))

  const name = make("span", { class: "check-name" })
  name.append(
    make("span", { text: model.name || model.id }),
    make("span", { class: "check-id", text: model.id }),
  )

  const meta = make("span", { class: "check-meta" })
  meta.append(
    make("span", { text: fmtCompact(model.contextWindow) }),
    make("span", { text: `/${fmtCompact(model.maxTokens)}` }),
  )
  if (model.image) meta.append(tag("图片"))
  if (model.reasoning) meta.append(tag("推理"))
  if (model.apiStyle === "anthropic_messages") meta.append(tag("messages"))

  row.append(box, name, meta)
  return row
}

async function toggleWhitelistModel(modelId, checked) {
  const current = settingsOf().visibleModels ?? []
  const next = new Set(Array.isArray(current) ? current : [])
  if (checked) next.add(modelId)
  else next.delete(modelId)
  const list = (state?.models ?? []).map((model) => model.id).filter((id) => next.has(id))
  // Keep ids the catalog no longer knows about, so a transient catalog change
  // does not silently drop the user's selection.
  for (const id of next) if (!list.includes(id)) list.push(id)
  const ok = await saveSetting("visibleModels", list, ui.whitelistStatus)
  if (ok) {
    setStatus(
      ui.whitelistStatus,
      list.length > 0 ? `已选 ${list.length} 个模型。` : "已清空白名单：模型选择器显示全部模型。",
      "ok",
    )
    setLive("模型白名单已保存")
  }
}

async function setWhitelistAll(checked) {
  const models = state?.models ?? []
  const list = checked ? models.map((model) => model.id) : []
  const ok = await saveSetting("visibleModels", list, ui.whitelistStatus)
  if (ok) {
    setStatus(
      ui.whitelistStatus,
      checked ? `已全选 ${list.length} 个模型。` : "已清空白名单：模型选择器显示全部模型。",
      "ok",
    )
  }
}

/* ------------------------------------------------------- login accounts */

/** Every signed-in account: the primary login first, then the extras. */
function loginAccounts() {
  const settings = settingsOf()
  const out = []
  if (settings.credential) {
    out.push({
      id: "default",
      label: settings.lastLogin?.userName || settings.lastLogin?.userId || "主登录账户",
      primary: true,
      userId: settings.lastLogin?.userId,
    })
  }
  for (const [index, entry] of (settings.accounts ?? []).entries()) {
    if (!entry?.credential && !entry?.apiKey) continue
    out.push({
      id: entry.id ?? `account-${index + 1}`,
      label: entry.label || entry.userName || `账户 ${index + 1}`,
      primary: false,
      userId: entry.userId,
    })
  }
  return out
}

function renderLoginSection() {
  const accounts = loginAccounts()
  const signedIn = accounts.length > 0 || state?.credential === "local-auth-file"
  ui.credentialBadge.textContent = signedIn ? `已登录 ${accounts.length || 1}` : "未登录"
  ui.credentialBadge.className = `badge ${signedIn ? "ok" : "warn"}`
  ui.credentialSource.textContent = state
    ? `当前生效凭据：${CREDENTIAL_TEXT[state.credential] ?? state.credential}。推理强度由宿主的模型设置控制。`
    : ""

  ui.loginAccountList.replaceChildren()
  if (stateError) {
    ui.loginAccountList.append(emptyBlock(`无法读取账户：${stateError}`))
    return
  }
  if (!state) {
    ui.loginAccountList.append(loadingBlock(2))
    return
  }
  if (accounts.length === 0) {
    ui.loginAccountList.append(
      emptyBlock(
        state.credential === "local-auth-file"
          ? "本机已有 Command Code 登录文件，可直接使用；也可点「登录新账户」再用一个账号。"
          : "尚未登录。点「登录新账户」，浏览器完成后即可使用，不需要 API 密钥。",
      ),
    )
    return
  }

  const fragment = document.createDocumentFragment()
  accounts.forEach((account, index) => {
    const item = make("li")
    item.style.setProperty("--i", String(index))

    const main = make("div", { class: "item-main" })
    const title = make("div", { class: "item-title" })
    title.append(
      make("span", { text: account.label }),
      account.primary ? badge("主账户", "ok") : tag("附加账户"),
    )
    main.append(title)
    if (account.userId) {
      main.append(make("div", { class: "item-sub mono", text: account.userId }))
    }
    // The pool reports availability per slot, which is how a cooling-down or
    // The pool reports availability per slot, which is how a cooling-down or
    // rejected account is visible here.
    const poolAccount = live(account.id)
    if (poolAccount) {
      const details = [poolBadge(poolAccount)]
      if (poolAccount.state === "cooldown" && poolAccount.cooldownUntil > Date.now()) {
        details.push(
          make("span", { class: "item-sub", text: `冷却至 ${fmtClock(poolAccount.cooldownUntil)}` }),
        )
      }
      main.append(make("div", { class: "item-meta" }, details))
    }

    const actions = make("div", { class: "item-actions" })
    const remove = make("button", {
      class: "btn small ghost",
      text: "移除",
      props: { type: "button" },
    })
    armButton(remove, () => removeLoginAccount(account), "确认移除")
    actions.append(remove)
    item.append(main, actions)
    fragment.append(item)
  })
  ui.loginAccountList.append(fragment)
}

async function removeLoginAccount(account) {
  try {
    const result = await invoke("cc.removeAccount", { accountId: account.id })
    if (result && typeof result === "object" && typeof result.error === "string") {
      setStatus(ui.loginStatus, `移除失败：${result.error}`, "error")
      return
    }
    state = result
    stateError = ""
    renderAll()
    setStatus(ui.loginStatus, `已移除「${account.label}」，请重新登录以恢复使用。`, "ok")
    setLive(`已移除账户 ${account.label}`)
  } catch (error) {
    setStatus(ui.loginStatus, `移除失败：${error?.message ?? error}`, "error")
  }
}

function focusKeySection() {
  ui.login.scrollIntoView({ block: "center", behavior: "smooth" })
  ui.login.focus({ preventScroll: true })
}


/* --------------------------------------------------------------- advanced */

function advancedValue(definition) {
  const value = settingsOf()[definition.key]
  if (definition.kind === "switch") return value === true
  if (definition.kind === "number") return Number.isFinite(value) && value > 0 ? value : 0
  return typeof value === "string" ? value : ""
}

function isCustomised(definition) {
  const value = advancedValue(definition)
  if (definition.kind === "switch") return value !== definition.empty
  if (definition.kind === "number") return value !== definition.empty
  return value.trim() !== definition.empty
}

function renderAdvanced() {
  const customised = ADVANCED_FIELDS.filter(isCustomised).length
  ui.advancedCount.textContent = customised > 0 ? `已自定义 ${customised} 项` : ""
  ui.toggleAdvanced.textContent = view.advancedOpen ? "收起" : "展开"
  ui.toggleAdvanced.setAttribute("aria-expanded", String(view.advancedOpen))
  ui.advancedBody.hidden = !view.advancedOpen

  const container = ui.advancedFields
  container.replaceChildren()
  if (!view.advancedOpen) return
  if (stateError) {
    container.append(emptyBlock(`无法读取设置：${stateError}`))
    return
  }
  if (!state) {
    container.append(loadingBlock(4))
    return
  }
  for (const definition of ADVANCED_FIELDS) container.append(advancedRow(definition))
}

function advancedRow(definition) {
  const row = make("div", { class: "field-grid" })

  const text = make("div", { class: "field-text" })
  text.append(
    make("span", { class: "field-name", text: definition.label }),
    make("span", { class: "field-help", text: definition.help }),
  )
  row.append(text)

  const control = make("div", { class: "field-control" })
  const value = advancedValue(definition)
  const id = `adv-${definition.key}`

  if (definition.kind === "switch") {
    const box = make("input", {
      class: "switch",
      props: { type: "checkbox", id, checked: value },
      attrs: { "aria-label": definition.label },
      focusKey: `adv:${definition.key}`,
    })
    box.addEventListener("change", () =>
      saveSetting(definition.key, box.checked, ui.advancedStatus),
    )
    control.append(box)
  } else {
    const input = make("input", {
      class: "input",
      props: {
        type: definition.kind === "number" ? "number" : "text",
        id,
        value: value === 0 && definition.kind === "number" ? "" : String(value),
        placeholder: definition.placeholder,
        min: definition.kind === "number" ? "0" : undefined,
        spellcheck: definition.kind === "text" ? "false" : undefined,
      },
      attrs: { "aria-label": definition.label },
      focusKey: `adv:${definition.key}`,
    })
    input.addEventListener("change", () => {
      if (definition.kind === "number") {
        const raw = input.value.trim()
        const parsed = raw === "" ? 0 : Number(raw)
        if (!Number.isFinite(parsed) || parsed < 0) {
          setStatus(ui.advancedStatus, "请输入不小于 0 的数字。", "error")
          input.value = ""
          return
        }
        saveSetting(definition.key, Math.round(parsed), ui.advancedStatus)
        return
      }
      saveSetting(definition.key, input.value.trim(), ui.advancedStatus)
    })
    control.append(input)
  }
  row.append(control)

  const reset = make("button", {
    class: "btn small ghost",
    text: "重置",
    props: { type: "button" },
    attrs: { "aria-label": `重置${definition.label}` },
    focusKey: `adv-reset:${definition.key}`,
  })
  reset.disabled = !isCustomised(definition)
  reset.addEventListener("click", () =>
    withBusy(reset, "…", () => saveSetting(definition.key, definition.empty, ui.advancedStatus)),
  )
  const resetCell = make("div", { class: "field-reset" })
  resetCell.append(reset)
  row.append(resetCell)
  return row
}

/* --------------------------------------------------------------- transport */

function renderTransport() {
  const preference = settingsOf().transport ?? "auto"
  const buttons = [...ui.transportSeg.querySelectorAll("button")]
  for (const button of buttons) {
    const active = button.dataset.value === preference
    button.setAttribute("aria-checked", String(active))
    button.tabIndex = active ? 0 : -1
  }
  if (state) {
    const actual = TRANSPORT_TEXT[state.transport] ?? state.transport
    const pinned = TRANSPORT_PREF_TEXT[preference] ?? preference
    ui.transportHint.textContent = `上次请求实际使用：${actual}。当前偏好：${pinned}。`
  } else {
    ui.transportHint.textContent = ""
  }
  ui.enabled.checked = state ? settingsOf().enabled !== false : false
  ui.zdr.checked = state ? settingsOf().zdr === true : false
  ui.enabled.disabled = !state
  ui.zdr.disabled = !state
  ui.resetTransport.disabled = !state
  for (const button of buttons) button.disabled = !state
}

function moveTransportFocus(from, step) {
  const buttons = [...ui.transportSeg.querySelectorAll("button")]
  const index = buttons.indexOf(from)
  const next = buttons[(index + step + buttons.length) % buttons.length]
  if (!next) return
  for (const button of buttons) button.tabIndex = button === next ? 0 : -1
  next.focus()
}

/* ------------------------------------------------------------- diagnostics */

function renderDiagnostics() {
  const list = ui.diagList
  list.replaceChildren()
  ui.toggleDiag.textContent = view.diagOpen ? "收起" : "展开"
  ui.toggleDiag.setAttribute("aria-expanded", String(view.diagOpen))
  ui.diagBody.hidden = !view.diagOpen

  const notes = []
  if (state?.warning) notes.push(`警告：${state.warning}`)
  if (state?.hostReloadRequired) {
    notes.push("模型列表已更新：关掉再打开本插件（或重启应用）后，宿主才会读到新列表。")
  }
  ui.diagNotes.textContent = notes.join("\n")
  ui.diagNotes.hidden = notes.length === 0
  ui.diagBadge.hidden = notes.length === 0
  ui.diagBadge.textContent = state?.hostReloadRequired ? "需要重新加载" : notes.length ? "有警告" : ""
  ui.diagBadge.className = "badge warn"

  if (!view.diagOpen) return
  if (stateError) {
    list.append(make("dt", { text: "状态" }), make("dd", { text: stateError }))
    return
  }
  if (!state) {
    list.append(make("dt", { text: "状态" }), make("dd", { text: "读取中…" }))
    return
  }

  const stats = state.stats ?? {}
  const rows = [
    ["端点", `127.0.0.1:${state.port ?? "-"}（${state.started ? "运行中" : "未运行"}）`],
    ["传输偏好", TRANSPORT_PREF_TEXT[state.preference ?? "auto"] ?? String(state.preference)],
    ["上次实际传输", TRANSPORT_TEXT[state.transport] ?? String(state.transport)],
    [
      "模型目录",
      `${state.models.length} 个模型 · 来源 ${state.source} · CLI ${state.cliVersion} · 上次同步 ${fmtDateTime(state.lastSync)}`,
    ],
    ["工作目录", settingsOf().workingDir?.trim() || "进程工作目录"],
    [
      "凭据来源",
      `${CREDENTIAL_TEXT[state.credential] ?? state.credential}${state.localAuthFile ? " · 本机登录文件可用" : ""}`,
    ],
    [
      "推理档位",
      `${Object.values(state.thinkingLevelsByModel ?? {}).filter((levels) => levels.length > 0).length} 个模型带档位 · 由宿主的模型设置控制`,
    ],
    [
      "请求统计",
      `${stats.requests ?? 0} 次（provider ${stats.provider ?? 0} · generate ${stats.generate ?? 0} · 失败 ${stats.errors ?? 0} · 轮换 ${stats.rotations ?? 0}）`,
    ],
    ["上次传输", stats.lastTransport ? TRANSPORT_TEXT[stats.lastTransport] ?? String(stats.lastTransport) : "—"],
    ["最近错误", stats.lastError || "—"],
    ["每组模型上限", `${state.maxModelsPerProvider} 个`],
    ["目录接口", state.endpoints?.models ?? "—"],
    ["Provider API", state.endpoints?.providerApi ?? "—"],
    ["generate 接口", state.endpoints?.generate ?? "—"],
  ]
  for (const [label, value] of rows) {
    list.append(make("dt", { text: label }), make("dd", { text: String(value) }))
  }
}

/* ------------------------------------------------------------------ banner */

function renderBanner() {
  const messages = []
  if (!bridgeAvailable) {
    messages.push(
      `${NO_BRIDGE_ERROR}：面板无法读写插件状态。请重新加载插件后再打开。`,
    )
  }
  if (stateError && stateError !== NO_BRIDGE_ERROR) messages.push(`读取状态失败：${stateError}`)
  if (state?.warning) messages.push(state.warning)
  if (state?.hostReloadRequired) {
    messages.push("模型列表已变更：关掉再打开本插件（或重启应用）后，宿主才会读到新列表。")
  }
  if (state && state.credential === "none") {
    messages.push(
      "还没有登录：在上面的「账号登录」里点「登录新账户」完成官方授权即可，不需要 API 密钥。",
    )
  }
  if (messages.length === 0) {
    ui.banner.hidden = true
    ui.banner.textContent = ""
    return
  }
  ui.banner.hidden = false
  ui.banner.className = `banner${!bridgeAvailable || stateError ? " error" : ""}`
  ui.banner.textContent = messages.join("\n")
}

/* ------------------------------------------------------------------ render */

function restoreFocus(focusKey) {
  if (!focusKey) return
  const nodes = document.querySelectorAll("[data-focus-key]")
  for (const node of nodes) {
    if (node.dataset.focusKey === focusKey && typeof node.focus === "function") {
      node.focus({ preventScroll: true })
      return
    }
  }
}

function renderAll() {
  const focusKey = document.activeElement?.dataset?.focusKey
  renderUsage()
  renderAccountList()
  renderAccountForm()
  renderPreferred()
  renderRuleList()
  renderRuleForm()
  renderWhitelist()
  renderLoginSection()
  renderAdvanced()
  renderTransport()
  renderDiagnostics()
  renderBanner()
  applyBridgeAvailability()
  restoreFocus(focusKey)
}

/**
 * Without a host bridge every action would reject, so the controls that write
 * are disabled instead of failing on click. Collapsing/expanding stays enabled
 * because it needs no host call.
 */
function applyBridgeAvailability() {
  const off = !bridgeAvailable
  for (const node of [
    ui.usageRefresh,
    ui.addAccount,
    ui.probeWindows,
    ui.resetAccounts,
    ui.resetPreferred,
    ui.addRule,
    ui.whitelistAll,
    ui.whitelistNone,
    ui.login,
    ui.openLog,
    ui.refreshModels,
    ui.resetTransport,
  ]) {
    if (node) node.disabled = off
  }
}

function renderInitial() {
  renderUsage()
  renderAccountList()
  renderPreferred()
  renderRuleList()
  renderWhitelist()
  renderLoginSection()
  renderAdvanced()
  renderTransport()
  renderDiagnostics()
  renderBanner()
  applyBridgeAvailability()
}

/* ------------------------------------------------------------------- host */

function invoke(channel, payload) {
  if (!bridgeAvailable) {
    return Promise.reject(new Error(NO_BRIDGE_ERROR))
  }
  return Promise.resolve(bridge.invoke(channel, payload))
}

async function loadState() {
  try {
    state = await invoke("cc.state")
    stateError = ""
  } catch (error) {
    stateError = String(error?.message ?? error)
  }
  renderAll()
  return state
}

/**
 * Settings writes answer with the whole state, or `{ error }` for a key the host
 * does not know. Both are handled here; a rejection never re-renders, so an open
 * form keeps what the user typed.
 */
async function saveSetting(key, value, statusNode) {
  try {
    const result = await invoke("cc.setSetting", { key, value })
    if (result && typeof result === "object" && typeof result.error === "string") {
      setStatus(statusNode, `保存失败：${result.error}`, "error")
      setLive(`保存失败：${result.error}`)
      return false
    }
    state = result
    stateError = ""
    renderAll()
    setLive("设置已保存")
    return true
  } catch (error) {
    setStatus(statusNode, `保存失败：${error?.message ?? error}`, "error")
    return false
  }
}

/* ------------------------------------------------------------------ events */

ui.usageRefresh.addEventListener("click", (event) => refreshUsage(event.currentTarget))

ui.addAccount.addEventListener("click", () => {
  view.accountFormOpen = !view.accountFormOpen
  ui.addAccount.setAttribute("aria-expanded", String(view.accountFormOpen))
  setStatus(ui.accountStatusLine, "")
  renderAccountForm()
  if (view.accountFormOpen) {
    const input = ui.accountForm.querySelector("#newAccountLabel")
    if (input) input.focus()
  }
})

ui.probeWindows.addEventListener("click", (event) =>
  withBusy(event.currentTarget, "探测中…", async () => {
    try {
      const result = await invoke("cc.probeWindows")
      if (Array.isArray(result?.accounts)) state = { ...state, accounts: result.accounts }
      const probes = Array.isArray(result?.probes) ? result.probes : []
      const exceeded = probes.filter((probe) => probe.exceeded)
      const failed = probes.filter((probe) => probe.ok === false)
      const parts = [`已探测 ${probes.length} 个账户`]
      if (exceeded.length > 0) parts.push(`${exceeded.length} 个仍超限`)
      if (failed.length > 0) parts.push(`${failed.length} 个探测失败`)
      if (probes.length > 0 && exceeded.length === 0 && failed.length === 0) parts.push("全部可用")
      setStatus(ui.accountStatusLine, `${parts.join("，")}。`, failed.length > 0 ? "warn" : "ok")
      renderAll()
    } catch (error) {
      setStatus(ui.accountStatusLine, `探测失败：${error?.message ?? error}`, "error")
    }
  }),
)

ui.resetAccounts.addEventListener("click", (event) =>
  withBusy(event.currentTarget, "重置中…", async () => {
    try {
      state = await invoke("cc.resetAccounts")
      setStatus(ui.accountStatusLine, "已清除冷却与停用标记。", "ok")
      renderAll()
    } catch (error) {
      setStatus(ui.accountStatusLine, `重置失败：${error?.message ?? error}`, "error")
    }
  }),
)

ui.preferredAccount.addEventListener("change", () =>
  saveSetting("preferredAccount", ui.preferredAccount.value, ui.preferredStatus),
)

ui.resetPreferred.addEventListener("click", () =>
  withBusy(ui.resetPreferred, "…", () => saveSetting("preferredAccount", "auto")),
)

ui.addRule.addEventListener("click", () => {
  view.ruleFormOpen = !view.ruleFormOpen
  ui.addRule.setAttribute("aria-expanded", String(view.ruleFormOpen))
  setStatus(ui.ruleStatusLine, "")
  renderRuleForm()
  if (view.ruleFormOpen) {
    const input = ui.ruleForm.querySelector("#newRuleModels")
    if (input) input.focus()
  }
})

ui.toggleWhitelist.addEventListener("click", () => {
  view.whitelistOpen = !view.whitelistOpen
  renderWhitelist()
  if (view.whitelistOpen) ui.whitelistSearch.focus()
})

ui.whitelistSearch.addEventListener("input", () => {
  view.whitelistQuery = ui.whitelistSearch.value
  renderWhitelist()
})

ui.whitelistAll.addEventListener("click", () => setWhitelistAll(true))
ui.whitelistNone.addEventListener("click", () => setWhitelistAll(false))

ui.login.addEventListener("click", (event) =>
  withBusy(event.currentTarget, "等待浏览器授权…", async () => {
    setStatus(ui.loginStatus, "已发起授权：请在浏览器里完成 commandcode.ai 登录。", "busy")
    try {
      const result = await invoke("cc.login")
      if (result?.ok) {
        setStatus(
          ui.loginStatus,
          `登录成功${result.userName ? `（${result.userName}）` : ""}，下一次请求即生效。`,
          "ok",
        )
        setLive("登录成功")
        await loadState()
        refreshUsage()
      } else {
        setStatus(ui.loginStatus, `登录失败：${result?.error ?? "未知原因"}`, "error")
      }
    } catch (error) {
      setStatus(ui.loginStatus, `登录失败：${error?.message ?? error}`, "error")
    }
  }),
)


ui.toggleAdvanced.addEventListener("click", () => {
  view.advancedOpen = !view.advancedOpen
  renderAdvanced()
})

ui.toggleDiag.addEventListener("click", () => {
  view.diagOpen = !view.diagOpen
  renderDiagnostics()
})

ui.transportSeg.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-value]")
  if (!button || button.disabled) return
  saveSetting("transport", button.dataset.value)
})

ui.transportSeg.addEventListener("keydown", (event) => {
  const button = event.target.closest("button[data-value]")
  if (!button) return
  const keys = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  }
  if (event.key in keys) {
    event.preventDefault()
    moveTransportFocus(button, keys[event.key])
    return
  }
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault()
    saveSetting("transport", button.dataset.value)
  }
})

ui.enabled.addEventListener("change", () =>
  saveSetting("enabled", ui.enabled.checked, ui.advancedStatus),
)
ui.zdr.addEventListener("change", () => saveSetting("zdr", ui.zdr.checked, ui.advancedStatus))

ui.resetTransport.addEventListener("click", (event) =>
  withBusy(event.currentTarget, "…", async () => {
    try {
      state = await invoke("cc.resetTransport")
      setStatus(ui.diagStatus, "已清除传输选择记忆，下一次请求重新探测。", "ok")
      renderAll()
    } catch (error) {
      setStatus(ui.diagStatus, `重置失败：${error?.message ?? error}`, "error")
    }
  }),
)

ui.openLog.addEventListener("click", (event) =>
  withBusy(event.currentTarget, "…", async () => {
    try {
      const result = await invoke("cc.openLog")
      const path = result?.dataPath ?? "—"
      ui.diagPath.textContent = `数据目录 ${path}`
      setStatus(ui.diagStatus, `数据目录：${path}`, "ok")
    } catch (error) {
      setStatus(ui.diagStatus, `打开失败：${error?.message ?? error}`, "error")
    }
  }),
)

ui.refreshModels.addEventListener("click", (event) =>
  withBusy(event.currentTarget, "刷新中…", async () => {
    try {
      const result = await invoke("cc.refresh")
      state = result
      stateError = ""
      renderAll()
      const changed = result?.sync?.changed === true
      setStatus(
        ui.diagStatus,
        `模型目录已刷新：${state.models.length} 个模型（来源 ${state.source}）。${
          changed ? "需要重新加载插件一次，宿主才会读到新列表。" : ""
        }`,
        changed ? "warn" : "ok",
      )
    } catch (error) {
      setStatus(ui.diagStatus, `刷新失败：${error?.message ?? error}`, "error")
    }
  }),
)

/* -------------------------------------------------------------------- boot */

async function boot() {
  if (!bridgeAvailable) {
    // Without a bridge there is nothing to load: mark the failure as the state
    // error so every section shows its error/empty state instead of a skeleton
    // that would pulse forever.
    stateError = NO_BRIDGE_ERROR
    renderInitial()
    return
  }
  renderInitial()
  await loadState()
  // One usage request, after the state render, never in parallel with it.
  if (state && !autoUsageRequested) {
    autoUsageRequested = true
    refreshUsage()
  }
}

boot()
