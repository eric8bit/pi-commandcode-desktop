# Command Code · PI-Desktop 插件

把 [Command Code](https://commandcode.ai) 的模型接进 PI-Desktop：官方 Provider API 的模型目录会发布进模型选择器，**凭据只来自官方浏览器登录（不需要任何 API 密钥）**，**推理强度沿用宿主自己的模型设置**，Go 订阅账号自动走 `/alpha/generate` 旧传输，GOAT / Provider API 账号走标准接口。

这是 [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider)（MIT，pi / Oh My Pi 的社区插件）的 PI-Desktop 移植版。

> **免责声明**：非官方集成，与 Command Code 无隶属关系。需要你自己的 Command Code 账号与可用套餐。

---

## 1. 安装

### 方式 A：作为开发插件加载（推荐）

1. 打开 PI-Desktop → **插件** 页；
2. 头部溢出菜单 → **加载开发插件**（Load development plugin）；
3. 选择本目录（含 `manifest.json` 的那一层）；
4. 首次加载会请求以下权限：

| 权限 | 用途 |
| --- | --- |
| `ui.panel` | 打开 Command Code 面板 |
| `background.service` | 常驻回环端点（承接对话请求） |
| `provider.register` | 把供应商分组加进模型列表 |
| `shell.openExternal` | 官方浏览器登录时打开授权页 |

> 插件**不需要** `net.fetch`：上游请求由插件进程自己的原生 `fetch` 发出，因为宿主的 `net.fetch` 桥会把响应缓冲成一整块文本，那样就丢掉了流式。

### 方式 B：打包成 `.piplug`

```sh
PluginPack            # 或使用宿主/工具链提供的打包命令
```

---

## 2. 凭据：只有账号登录

### 2.1 两个 provider

Command Code 的模型分散在两种线上的协议里，而 PI-Desktop 每个 provider 只能绑定一种协议，所以声明**两个** provider：

| provider id | 名称 | `authKind` | `baseUrl` | `apiStyle` |
| --- | --- | --- | --- | --- |
| `commandcode-chat` | Command Code | `none` | `http://127.0.0.1:PORT/v1` | `chat_completions` |
| `commandcode-claude` | Command Code (Claude) | `none` | `http://127.0.0.1:PORT` | `anthropic_messages` |

两者都指向**同一个回环端口的同一个服务**，共享模型目录、传输选择、账户池与配额。

**两者都是 `authKind: "none"`**：宿主不会为此类供应商发送任何 `Authorization` 头，也不会要求你在 PI-Desktop 的供应商设置里填密钥；宿主把它视为「已就绪」。凭据由插件自己持有。

> 旧版本曾为每种协议各声明两份（一份 `api_key` 用宿主密钥、一份 `none` 带 `/pool` 前缀）。宿主现在对 `authKind: "none"` 的判定已经完善，因此 `api_key` 那一半与 `/pool` 前缀都已删除。

### 2.2 凭据来源（面板会显示，`state.credential`）

| 取值 | 含义 |
| --- | --- |
| `login` | **官方浏览器登录**得到的凭据（插件设置里的主登录账户或附加账户） |
| `local-auth-file` | 本机已有登录文件的回退（无需额外配置） |
| `none` | 未登录 |

本机回退的读取顺序（仅在插件设置里没有任何登录账户时才会用到）：

1. `~/.commandcode/auth.json`
2. `~/.pi/agent/auth.json`
3. `~/.omp/agent/auth.json`

> 环境变量 `COMMAND_CODE_API_KEY` / `COMMANDCODE_API_KEY` **不再读取**：本插件只支持账号登录。

### 2.3 官方浏览器登录

面板「账号登录」→「登录新账户」→ `cc.login` 通道。流程：

1. 插件在 `127.0.0.1` 上从 `5959` 起找空闲端口，开一个临时回调服务器；
2. 生成随机 `state`；
3. 通过宿主 `shell.openExternal` 打开 `https://commandcode.ai/studio/auth/cli?callback=...&state=...`；
4. 用户在浏览器完成登录后，Studio 页面把 `{apiKey, state, userId, userName, keyName}` POST 回回环回调——**没有 OAuth code 交换**，页面直接持有最终凭据；
5. 插件校验 `state`，并用 `GET /alpha/whoami` 验证凭据；
6. 验证通过才保存：**第一次登录**写入 `credential`（主登录账户），**之后再登录**则按 `userId` 追加到 `accounts`（同一账号重复登录会就地刷新，不产生重复项）。

安全约束：回调是 **POST-only**、**10KB** 体积上限、必须通过 `state` 校验；整体 **120 秒**超时。被上游拒绝的凭据**不会**被保存。

### 2.4 从旧版本升级

旧版本把可粘贴的密钥存在 `apiKey`、把每个账户存在 `accounts[].apiKey` / `apiKeyEnv`。插件在 `onLoad()` 时做一次性、幂等的迁移：

- `apiKey` → `credential`（主登录账户），随后把 `apiKey` 清空；
- `accounts[].apiKey` → `accounts[].credential`；只有环境变量名的槽位因为没有可迁移的凭据会被丢弃。

迁移失败不会阻断启动（本机登录文件仍可兜底）。

---

## 3. 首次使用

1. 装好插件后，**模型选择器**里会出现两个分组：`Command Code`、`Command Code (Claude)`；
2. 打开 **插件 → Command Code** 面板 → 「账号登录」→「登录新账户」，浏览器完成授权；
3. 该账户立即生效，可以在会话里直接发消息；
4. 若模型列表与面板不一致，**把插件关掉再打开一次**（或重启应用）——宿主只在插件加载时读取 provider 声明。

---

## 4. 推理强度：由宿主的模型设置决定

插件**不复刻**一套推理档位配置，它只做一件事：在声明里如实公布每个模型支持的档位。

```json
{
  "id": "gpt-5.6-luna",
  "name": "GPT-5.6 Luna",
  "contextWindow": 1050000,
  "maxTokens": 32000,
  "supportsImages": true,
  "thinkingLevels": ["off", "low", "medium", "high", "xhigh", "max"],
  "defaultThinkingLevel": "medium"
}
```

于是：

- 宿主读 `thinkingLevels` → 生成会话里的**推理强度菜单**，读 `defaultThinkingLevel` → 决定新会话的初始档位；
- 宿主按用户选择**自己**把档位写进请求体（`chat_completions` 写 `reasoning_effort`，`anthropic_messages` 写 `thinking`），插件**原样转发**；
- 插件不再持有任何档位白名单，因此不存在「插件设置」与「宿主设置」两套档位。

只发布宿主规范集合内的值（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）：宿主用交集过滤，非规范值会被静默丢弃、菜单出现空洞，所以插件在声明时就把它们剔掉。`off` 始终包含，否则用户无法关闭思考。只会自动推理、没有可选档位的模型（快照里 `reasoning: true` 但 `efforts` 为空）不发布这两个字段，菜单里只显示 `off`。

> **修复**：旧版本在 `anthropic_messages` 方言下会把档位写死成 `reasoning_effort: "auto"`，上游不认这个值，等于丢掉用户选的档位。现在改为优先取 `thinking.effort`，否则按 `budget_tokens` 映射（`<2048→low`、`<8192→medium`、`<24576→high`、`<65536→xhigh`、否则 `max`）。

---

## 5. 传输方式

Command Code 有两套后端接口：

| 传输 | 端点 | 适用账号 |
| --- | --- | --- |
| **provider**（标准） | `/provider/v1/chat/completions`、`/provider/v1/messages` | GOAT / Pro / Provider 账号 |
| **generate**（旧） | `/alpha/generate` | **Go 订阅账号**、**Claude 模型** |

插件的选择逻辑**按套餐判定，不靠 403 探测**：

- **`auto`（默认）**：
  - Claude 模型（`claude-*`，走 Messages 端点）一律走 `generate`；
  - Go 套餐账号走 `generate`；
  - 其余走标准 Provider API。
  - 套餐来自 `GET /alpha/billing/subscriptions` 的 `planId`，经套餐表映射出 `tierWeight`（Go = 0），结果缓存 **10 分钟**；首个请求前会预热。
  - `403 upgrade_required` 探测**仅作兜底**：万一仍被拒，就地改用 `/alpha/generate` 重放这次请求，并记住该凭据。
- **`generate`**：强制走 `/alpha/generate`。
- **`provider`**：强制走标准 Provider API，不做降级。

套餐表（`planId` → 名称 / 月额度 / `tierWeight`）：

| `planId` | 套餐 | 月额度 | `tierWeight` |
| --- | --- | --- | --- |
| `individual-go` | Go | 10 | 0 |
| `individual-goat` | GOAT | 70 | 1 |
| `individual-pro` | Pro | 30 | 2 |
| `individual-provider` | Provider | 15 | 3 |
| `individual-max` | Max | 150 | 4 |

`/alpha/generate` 请求会带上 CLI 需要的头部（`x-command-code-version`、`x-cli-environment`、`x-project-slug`、`x-taste-learning`、`User-Agent: cli`），并把两种方言（OpenAI / Anthropic）的请求体统一转换成该端点的格式，再把返回的 SSE 重新编码成调用方期望的方言——因此**两种协议都支持流式**。

---

## 6. 多账户与轮换

一次登录 = 一个账户。面板可以登录多个账户，它们按顺序使用：

- **槽位**：第 0 槽是「主登录账户」（设置里的 `credential`），之后是 `accounts` 数组里每一项（`{id, label, credential, userId, userName, keyName, addedAt}`）。
- **轮换顺序**：按模型的规则（`modelAccountRules`，第一条匹配生效）→ 优先账户（`preferredAccount`）→ 配置顺序里的第一个可用账户。
- **失败标记**：
  - `429` 且带 reset 时间 → 冷却到该时刻；
  - 裸 `429` → 短暂冷却（30 秒），这样下一个请求不会立刻又选中同一个被限流的账户；
  - `401` → 该账户停用，直到重新登录（成功请求不会自动复活它；「探测配额窗口」验证通过才复活）。
- 池状态按**解析出的凭据**索引，所以改标签不会丢冷却；面板改动账户列表时会重建账户池，但**轮换状态会带过去**。
- `cc.probeWindows` 主动探测配额窗口，验证通过则复活账户；`cc.resetAccounts` 清空所有标记；`cc.removeAccount` 移除某个账户。
- 轮换只发生在**写出任何字节之前**，调用方不会看到半截回复。

**用量面板**走四个端点：

| 端点 | 用途 |
| --- | --- |
| `GET /alpha/whoami` | 账户身份 + `orgId` |
| `GET /alpha/usage/summary` | 请求 / token / 成本合计 |
| `GET /alpha/billing/credits` | 余额 + 5 小时 / 每周窗口 |
| `GET /alpha/billing/subscriptions` | 订阅套餐 |

四个端点各自独立降级；只有**四个全失败**才判定为凭据失效（`invalid-key`）。

---

## 7. 性能

刷新与账户检测都做过针对性优化，这几处是实测最慢的来源：

| 环节 | 之前 | 现在 |
| --- | --- | --- |
| 模型目录刷新 | 每次下载完整 JSON，超时 10s | **ETag 条件请求**：未变化时 304，面板显示来源 `cache-validated`；超时 4s |
| 账户用量（N 个账户） | `for … await` 串行，端到端 N 轮 | **全部并行** + **单飞**（重复点击合并成同一次请求） |
| 单个账户的 4 个端点 | whoami 串行 → 再并行 3 个（2 轮往返） | 一次性并行 4 个（1 轮）；只有 subscriptions 失败且 whoami 给出 orgId 时才补一次；超时 6s |
| 计费查询（每个账户） | 串行 await | 并行 |
| 本机登录文件读取 | 每个请求 3 次同步 `existsSync + readFileSync` | **30 秒记忆化**（登录后主动失效） |

面板「诊断」区会显示目录来源与每个端点的耗时，可以直接核对。

---

## 8. 面板功能

中文界面，纯静态（HTML/CSS/JS，无构建、无依赖），共 **9 个分区**：

| # | 分区 | 说明 |
| --- | --- | --- |
| 1 | **账户用量** | 月额度 / 已购 / 赠送、5 小时与每周窗口、套餐与重置时间 |
| 2 | **账户与轮换** | 已登录账户列表、增删、冷却状态、「探测配额窗口」、「清除冷却标记」 |
| 3 | **当前使用账户** | 指定优先使用的账户，或保持 `auto` |
| 4 | **按模型切换账户** | 把指定模型固定到某个账户（第一条匹配生效） |
| 5 | **模型白名单** | 勾选要保留的模型；一个都不勾选 = 显示全部 |
| 6 | **账号登录** | 登录新账户、查看已登录账户、移除；显示当前生效凭据 |
| 7 | **高级设置** | 8 项不常改的选项（见下表） |
| 8 | **传输方式** | `自动` / `始终 generate` / `始终 provider` 三选一；启用供应商、零数据保留头开关 |
| 9 | **诊断** | 端点、传输、目录来源、凭据来源、推理档位统计、请求统计、最近错误、数据目录、刷新模型目录 |

用量卡片的显示细节：

- 金额字段在 `monthlyReported === false` 时显示 `—`，而不是 `$0.00`（「未上报」不等于「余额为 0」）；
- `fiveHour` / `weekly` 窗口缺失时**不画该行**；
- `cap === 0` 显示 `—` 而非 0%（无上限不等于用满）。

高级设置 8 项：`apiBase`、`workingDir`、`requestTimeoutMs`、`streamIdleTimeoutMs`、`transportRetries`、`hideOutOfPlan`、`webSearch`、`sidebarQuota`。

**破坏性操作需要二次确认**：移除已登录账户要再点一次（按钮会变成「确认移除」）才生效。

> 面板里**没有**「API 密钥」分区：本插件只支持账号登录。

---

## 9. 命令与设置

命令面板里可调用（共 4 个）：

- `Command Code: Open Panel`
- `Command Code: Refresh Model List` —— 重新拉取目录并重新发布（有变更时提示重载插件）
- `Command Code: Show Status` —— 把诊断摘要以通知形式弹出
- `Command Code: Reset Transport Selection` —— 清掉记住的传输选择

设置项（manifest 里共 **19 项**，多数由面板管理）：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 关闭后回环端点不再启动 |
| `transport` | select | `auto` | `auto` / `generate` / `provider` |
| `zdr` | bool | `false` | 发送 `x-cmd-zdr: 1`（零数据保留） |
| `catalogRefreshMinutes` | number | `30` | 模型目录刷新间隔 |
| `modelSelection` | json | `{}` | 面板管理的模型选择（启用 / 图片 / 上下文上限） |
| `credential` | string | `""` | **主登录账户**的凭据（官方登录写入） |
| `accounts` | json | `[]` | 附加登录账户（`{id, label, credential, userId, userName, keyName, addedAt}`） |
| `modelAccountRules` | json | `[]` | 按模型切换账户（`{models, account}`） |
| `preferredAccount` | string | `auto` | 优先账户 |
| `visibleModels` | json | `[]` | 模型白名单（空 = 不限制） |
| `hideOutOfPlan` | bool | `false` | 隐藏套餐外模型 |
| `apiBase` | string | `""` | API 地址（留空用默认） |
| `workingDir` | string | `""` | 工作目录（留空用进程目录） |
| `requestTimeoutMs` | number | `0` | 请求超时；`0` 表示用内置默认 `60000` |
| `streamIdleTimeoutMs` | number | `0` | 流空闲超时；`0` 表示用内置默认 `300000` |
| `transportRetries` | number | `5` | 传输失败重试次数（限流、5xx 等可重试状态也由这个预算控制；`0` 表示不重试） |
| `webSearch` | bool | `false` | 用 Command Code 承载联网搜索 —— **尚未接入** |
| `sidebarQuota` | bool | `false` | 在侧边栏显示额度卡片 —— **尚未接入** |
| `lastLogin` | json | `{}` | 上次官方登录的身份信息（面板管理） |

> **尚未接入的两项**：`webSearch` 与 `sidebarQuota` 目前**只是保存了值，功能尚未实现**——面板可以切换、设置会持久化，但联网搜索仍走宿主内置搜索，侧边栏也不会出现额度卡片。manifest 的 title 里已标注「暂未接入」。

---

## 10. 它怎么工作

```
PI-Desktop 模型选择器
        │
        ├─ commandcode-chat     authKind: none，宿主不发 Authorization 头
        └─ commandcode-claude   authKind: none，宿主不发 Authorization 头
        ▼
  回环端点 127.0.0.1:41851（仅监听回环；备选 41852）
        │  按请求方言解码 → 选账户 → 选传输 → 原样转发档位 → 重新编码 SSE
        ├── provider ──► api.commandcode.ai/provider/v1/{chat/completions,messages}
        └── generate ──► api.commandcode.ai/alpha/generate
```

- **端口固定**（41851，备选 41852）是刻意的：宿主在插件进程启动**之前**就从 manifest 读取 `baseUrl`，因此端点必须每次回到同一个端口，否则已发布的供应商行会指向空地址。
- 端口全被占用时会退回临时端口并重写 manifest，此时需要**重载插件一次**。
- 模型目录取自 `https://api.commandcode.ai/provider/v1/models`（公开接口，无需凭据），带 ETag 条件请求，缓存写在插件自己的数据目录里；离线时用缓存。
- 图片输入与推理档位来自生成的**能力快照** `lib/catalog-data.js`（Provider API 不提供这些字段）。
- 模型列表变更需要**重载插件一次**才生效（宿主只在加载时读声明），面板会提示。
- 声明里模型列表为空的 provider 会被整个丢弃：只要有一个 provider 的模型列表为空，宿主的 manifest 校验就会失败，从而拖垮整个插件。

### 目录与代码结构

```
manifest.json          插件声明（providers 由插件运行时写入）
main.js                入口：生命周期、命令、面板桥、服务编排、manifest 声明、设置迁移
src/
  accounts.js          登录账户池（槽位、轮换、冷却、按凭据索引的状态）
  auth.js              凭据解析（登录账户 → 本机登录文件，含 30s 记忆化）
  catalog.js           目录拉取（ETag 条件请求）/ 缓存 / 选择 / 生成两份 provider 声明
  converters.js        /alpha/generate 协议的消息、工具与 SSE 转换
  generate.js          legacy /alpha/generate 传输（重试、超时、流解析）
  login.js             官方浏览器登录（回环回调 + state 校验 + whoami 验证）
  protocol.js          OpenAI / Anthropic 两种方言的解码与 SSE 重编码
  proxy.js             回环 HTTP 端点 + 账户选择 + 传输选择 + 档位转发
  usage.js             四个账户端点（whoami / usage / credits / subscriptions）
lib/
  catalog-data.js      生成的能力快照（勿手改）
  cc-tables.js         生成的套餐 / 能力 / 价格表（勿手改）
renderer/              面板（HTML/CSS/JS）
tools/sync-catalog.mjs 重新生成能力快照
tests/                 单元 + 宿主集成测试
```

---

## 11. 权限与数据边界

| 权限 | 用途 |
| --- | --- |
| `ui.panel` | 打开 Command Code 面板 |
| `background.service` | 常驻回环端点（承接对话请求） |
| `provider.register` | 发布供应商与模型声明 |
| `shell.openExternal` | 官方浏览器登录时打开授权页 |

- **不保存任何 API 密钥**：本插件不读取也不写入 PI-Desktop 的供应商密钥；两个 provider 都是 `authKind: "none"`，宿主从不发送 `Authorization` 头；
- **凭据只来自官方登录**：保存在插件自己的设置里（插件数据目录中的普通 JSON 文件），请求时仅转发给 `api.commandcode.ai`；
- **本机登录文件仅作回退**：当插件设置里没有任何登录账户时才会读取 `~/.commandcode/auth.json` 等文件，方便本机已经登录过的情况；
- **不请求 `net.fetch`**：上游请求由插件进程自己的原生 `fetch` 发出，宿主的 `net.fetch` 桥会把响应缓冲成一整块文本，会丢掉流式；
- **回环端点**：只监听 `127.0.0.1`，拒绝非回环的 `Host`/`Origin`（浏览器页面无法访问）；
- **无遥测、无第三方服务器**。

---

## 12. 已知限制

- **模型列表变更需要一次重载**：宿主只在插件加载时读取 provider 声明，写入新列表后要关掉再打开插件（或重启应用）。面板会提示。
- **宿主不允许手改插件 provider 的模型与档位**：宿主设置里这类 provider 的编辑入口是禁用的（`ownerPluginId` 决定），且每次同步都会覆盖 `config_json`。因此档位的可操作面是**会话里的推理强度菜单**，其内容来自插件声明的 `thinkingLevels`——这正是「沿用宿主设置」的实现方式。
- **每个分组最多 64 个模型**：宿主对单个 provider 的模型数有硬上限。超出部分不会发布，面板会提示。
- **空模型列表会拖垮整个 manifest**：只要有一个 provider 声明里模型列表为空，宿主的 manifest 校验就会失败，所以插件会丢弃这类 provider。
- **端口被占需要重载**：41851 / 41852 全被占用时退回临时端口并重写 manifest，需重载插件一次。
- **成本显示**：Provider API 的目录不含价格，因此 PI-Desktop 里显示的请求成本不代表 Command Code 的实际计费。请以 [Command Code 用量页](https://commandcode.ai/docs/resources/pricing-limits) 为准。
- **只支持账号登录**：粘贴密钥、环境变量两种方式已被移除；旧设置会自动迁移。
- **两个设置尚未接入**：`webSearch`（联网搜索）与 `sidebarQuota`（侧边栏额度卡片）只保存值，功能待实现。

---

## 13. 开发

```sh
node tests/run.js     # 单元测试
node tests/host.js    # 宿主集成测试
npm test              # 全部测试（单元 + 宿主集成）
npm run test:unit     # 同 tests/run.js
npm run test:host     # 同 tests/host.js
npm run sync:catalog  # 重新生成 lib/catalog-data.js
```

`tests/host.js` 会用桩宿主模拟真实的调用序列：先给 `globalThis.pi` 赋值，再**无参**调用 `onLoad()`，然后 `service.start({log})`。它把插件复制到临时目录，对写出的 `contributes.providers` 施加与宿主相同的校验规则（provider id 格式、`apiStyle` 白名单、`authKind` 仅 `api_key|none`、每个 provider ≤64 模型、`thinkingLevels` / `defaultThinkingLevel` 的类型与取值范围、空模型列表必须整条剔除），并覆盖：两份声明的发布、**不带任何凭据头的请求也能成功**、宿主传入的推理档位原样到达上游（含 `off` 不发出、Anthropic 预算映射成真实档位）、`cc.login` 端到端流程、旧 `apiKey` 设置的迁移、被拒凭据不落盘，以及三条防回归用例：**面板写设置必须真正生效**（曾因引用被删除的集合而抛 `ReferenceError`）、**未知/原型链上的设置键被拒**、**三个本机登录文件位置各自都能单独把请求服务起来**（曾只读 `~/.commandcode`，导致面板显示已登录而请求 401）。改 `main.js` 或声明逻辑后请跑它。

---

## 14. 许可

MIT。上游为 [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider)（MIT）。
