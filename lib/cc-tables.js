var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// __entry.ts
var entry_exports = {};
__export(entry_exports, {
  KNOWN_DEALS: () => KNOWN_DEALS,
  KNOWN_EFFORTS: () => KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS: () => KNOWN_IMAGE_MODELS,
  KNOWN_PEAK_PRICING: () => KNOWN_PEAK_PRICING,
  KNOWN_PLANS: () => KNOWN_PLANS,
  KNOWN_SUBSCRIPTION_PLANS: () => KNOWN_SUBSCRIPTION_PLANS,
  KNOWN_THINKING_MODELS: () => KNOWN_THINKING_MODELS,
  MESSAGES_ONLY_MODELS: () => MESSAGES_ONLY_MODELS,
  PEAK_HOUR_RANGES: () => PEAK_HOUR_RANGES,
  PLAN_LABELS: () => PLAN_LABELS,
  PLAN_ORDER: () => PLAN_ORDER,
  capabilityDescription: () => capabilityDescription,
  compareByPlan: () => compareByPlan,
  dealLabel: () => dealLabel,
  formatContext: () => formatContext,
  isFreeModel: () => isFreeModel,
  isPeakPricingHour: () => isPeakPricingHour,
  modelPriceTable: () => modelPriceTable,
  modelVisibleForAnyAccount: () => modelVisibleForAnyAccount,
  modelVisibleInPlan: () => modelVisibleInPlan,
  peakPricingLabel: () => peakPricingLabel,
  peakPricingState: () => peakPricingState,
  planLabel: () => planLabel,
  requiresMessagesEndpoint: () => requiresMessagesEndpoint,
  subscriptionPlanInfo: () => subscriptionPlanInfo
});
module.exports = __toCommonJS(entry_exports);

// capabilities.ts
var KNOWN_EFFORTS = {
  // Re-verified against the authoritative command-code@1.53.0 bundled model
  // table (dist/cli.mjs, the provider effort map): exactly these models carry
  // selectable efforts. Models marked 'reasoning:!0' without efforts
  // (e.g. Tencent Hy3, GLM-5/5.1/5.2-Fast)
  // think automatically and are absent here - the CLI omits
  // 'reasoning_effort' for them, so the picker must not offer a selector. Do
  // NOT add entries from the OAuth provider tables (anthropic/openai) - only
  // the Provider-API table is authoritative for this plugin's route.
  // `stealth/ox-alpha` (['low', 'high', 'max']) was removed in
  // command-code@1.34.0 when its preview ended; its successor,
  // `z-ai/glm-5.3-flash`, ships the same effort set.
  // `tencent/hy4-preview` gained ['low', 'medium', 'high'] in
  // command-code@1.38.0 (it previously thought automatically with no
  // selectable levels).
  // `moonshotai/Kimi-K3` gained ['low', 'high', 'max'] in command-code@1.39.3
  // (it previously thought automatically with no selectable levels).
  // `claude-fable-5-1` (Claude Fable 5.1, command-code@1.40.0) ships the same
  // five-level effort set as its predecessor `claude-fable-5` and is served
  // by the Provider API (the Provider/Max tier; see KNOWN_PLANS).
  // command-code@1.41.0 added `Qwen/Qwen3.8-Max-0902` and command-code@1.43.0
  // added `google/gemini-3.8-flash`; both carry effort sets matching their
  // existing family members. command-code@1.45.0 added selectable
  // ['low', 'medium', 'high', 'xhigh'] efforts for the Muse Spark family
  // (1.1, 1.2, 1.2-contributor, 1.3, 1.3-contributor); they previously reasoned
  // automatically with no selectable levels. command-code@1.48.0 added the
  // `max` effort tier to Muse Spark 1.3 (previously ['low','medium','high',
  // 'xhigh']); 1.3 and 1.3-contributor now ship different effort sets.
  // command-code@1.49.0 added `gpt-6-astra` with the five-level effort set.
  // command-code@1.51.0 briefly added `deepseek/deepseek-v4.1-flash-beta`
  // (text+image, reasoning without selectable efforts, hidden behind a
  // 2026-09-10 expiry gate); command-code@1.51.2 removed it from the bundle
  // entirely, so no snapshot entry is needed.
  "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max-0902": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-27B": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Flash": ["low", "medium", "xhigh"],
  // command-code@1.56.0 added Qwen 3.8 Omni Flash — the only model-registry
  // change across 1.54.0 -> 1.56.0, and the only catalog model with no local
  // snapshot entry before this. Omni-modal (text+image), 1M context, reasoning
  // with the same ['low', 'medium', 'xhigh'] set as its Qwen 3.8 siblings.
  "Qwen/Qwen3.8-Omni-Flash": ["low", "medium", "xhigh"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  // `deepseek/deepseek-v4-flash-fast` joined in command-code@1.39.0
  // ("Add DeepSeek V4 Flash Fast"); 1.39.1 dropped `medium` for it, and
  // the 1.39.2 table ships ['low', 'high', 'max'].
  "deepseek/deepseek-v4-flash-fast": ["low", "high", "max"],
  // command-code@1.53.0 added DeepSeek V4.1 Flash ("Add new
  // deepseek/deepseek-v4.1-flash model"); the bundle ships
  // ['low', 'high', 'max'] for it.
  "deepseek/deepseek-v4.1-flash": ["low", "high", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "deepseek/deepseek-v4-flash-vision-exp": ["high", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  // `moonshotai/Kimi-K3` gained selectable ['low', 'high', 'max'] efforts in
  // command-code@1.39.3 ("Add low, high, and max reasoning effort support for
  // Kimi K3"); it previously reasoned automatically with no levels.
  "moonshotai/Kimi-K3": ["low", "high", "max"],
  // command-code@1.43.0 added Gemini 3.8 Flash with the same three-level
  // effort set as the rest of the Gemini Flash family.
  "google/gemini-3.8-flash": ["low", "medium", "high"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "tencent/hy4-preview": ["low", "medium", "high"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  // command-code@1.57.0 added GLM-5.3 FlashX — the only model-registry change
  // across 1.56.0 -> 1.57.0 — with the same three-level effort set as its
  // `z-ai/glm-5.3-flash` sibling.
  "z-ai/glm-5.3-flashx": ["low", "high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.3": ["low", "high", "max"],
  // Muse Spark family (command-code@1.45.0: "Reasoning levels for Muse
  // Spark 1.3") gained selectable ['low', 'medium', 'high', 'xhigh'] efforts
  // — they previously reasoned automatically with no levels.
  "meta/muse-spark-1.1": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high", "xhigh"],
  // command-code@1.48.0 added `max` to Muse Spark 1.3; 1.3-contributor keeps
  // the four-level set.
  "meta/muse-spark-1.3": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.3-contributor": ["low", "medium", "high", "xhigh"],
  // command-code@1.49.0 added GPT-6 Astra with the full five-level effort set.
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  // command-code@1.51.3 gave MiniMax M3 selectable ['low', 'medium', 'high']
  // efforts (it previously reasoned automatically with no levels and lived in
  // KNOWN_THINKING_MODELS; the hidden `minimax/minimax-m3-free` sibling gained
  // the same set in the bundle). No CLI changelog entry exists for 1.51.1–1.51.3
  // yet — this was read from the 1.51.3 bundled model table.
  // command-code@1.52.0 added `inclusionai/ling-3.0-flash-sante:free` with
  // automatic reasoning and no selectable efforts, so the effort map is
  // unchanged by that release.
  "MiniMaxAI/MiniMax-M3": ["low", "medium", "high"]
};
var KNOWN_IMAGE_MODELS = /* @__PURE__ */ new Set([
  "MiniMaxAI/MiniMax-M3",
  "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.7-Plus",
  "Qwen/Qwen3.8-27B",
  "Qwen/Qwen3.8-Flash",
  "Qwen/Qwen3.8-Max",
  // command-code@1.41.0 added Qwen 3.8 Max 0902; Vision per the official
  // registry ("Text input, Vision, Reasoning") and the CLI's
  // inputModalities:["text","image"].
  "Qwen/Qwen3.8-Max-0902",
  // command-code@1.56.0 added Qwen 3.8 Omni Flash; Vision per the official
  // registry and the CLI's inputModalities:["text","image"] (the pricing page
  // also carries caps.vision: true).
  "Qwen/Qwen3.8-Omni-Flash",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "deepseek/deepseek-v4-flash-vision-exp",
  // command-code@1.53.0 added DeepSeek V4.1 Flash; Vision per the official
  // registry ("Text input, Vision, Reasoning") and the CLI's
  // inputModalities:["text","image"].
  "deepseek/deepseek-v4.1-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.6-flash",
  "google/gemini-3.7-flash",
  // command-code@1.43.0 added Gemini 3.8 Flash; Vision per the official
  // registry and the CLI's inputModalities:["text","image"].
  "google/gemini-3.8-flash",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  // command-code@1.49.0 added GPT-6 Astra; Vision per the official registry
  // and the CLI's inputModalities:["text","image"].
  "gpt-6-astra",
  // command-code@1.44.0 added Muse Spark 1.3 and its Contributor sibling;
  // both are Vision per the official registry and the CLI's
  // inputModalities:["text","image"].
  "meta/muse-spark-1.1",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
  "meta/muse-spark-1.3",
  "meta/muse-spark-1.3-contributor",
  "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K3",
  "sakana/fugu-ultra",
  "stepfun/Step-3.7-Flash",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
  "xai/grok-4.5",
  // command-code@1.47.0 marked Grok 4.6 vision-capable (it was text-only in
  // 1.46.0); re-verified present in the 1.53.0 bundle's
  // inputModalities:["text","image"] entries.
  "xai/grok-4.6",
  "xiaomi/mimo-v2.5",
  "z-ai/glm-5.3-flash",
  // command-code@1.57.0 added GLM-5.3 FlashX; Vision per the official
  // registry and the CLI's inputModalities:["text","image"] (the pricing page
  // also carries caps.vision: true).
  "z-ai/glm-5.3-flashx"
]);
var KNOWN_THINKING_MODELS = /* @__PURE__ */ new Set([
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.7-Flash",
  "Qwen/Qwen3.7-Max",
  "Qwen/Qwen3.7-Plus",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "stepfun/Step-3.5-Flash",
  "stepfun/Step-3.7-Flash",
  "tencent/hy3-paid",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "thinkingmachines/inkling",
  "thinkingmachines/inkling-small",
  "poolside/laguna-s-2.1-free",
  // LongCat 2.0 (command-code@1.42.0, Meituan's trillion-parameter coding
  // model, 1M context) is text-only with automatic reasoning. The free promo
  // ended 2026-09-19 and the backend catalog renamed it from
  // `meituan/LongCat-2.0:free` to the paid `meituan/LongCat-2.0`. The rename is
  // billing-only, so the new id keeps this entry: the pricing page still
  // carries `caps.reasoning: true` with no efforts, and command-code@1.58.0 —
  // the CLI release that retired the free tier — carries the new id with
  // `reasoning:!0` and no `reasoningEfforts`, one release after the backend
  // rename the 1.57.0 sync recorded here.
  "meituan/LongCat-2.0",
  // Ling 3.0 Flash Sante (command-code@1.52.0, 262K context, text-only) is
  // free and reasons automatically with no selectable efforts.
  "inclusionai/ling-3.0-flash-sante:free"
]);
var MESSAGES_ONLY_MODELS = /* @__PURE__ */ new Set([
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-haiku-4-5-20251001"
]);
function requiresMessagesEndpoint(modelId) {
  return MESSAGES_ONLY_MODELS.has(modelId) || modelId.startsWith("claude-");
}
var KNOWN_PLANS = {
  // --- Go (46) ---
  "MiniMaxAI/MiniMax-M2.5": "go",
  "MiniMaxAI/MiniMax-M2.7": "go",
  "MiniMaxAI/MiniMax-M3": "go",
  "Qwen/Qwen3.6-Max-Preview": "go",
  "Qwen/Qwen3.6-Plus": "go",
  "Qwen/Qwen3.7-Flash": "go",
  "Qwen/Qwen3.7-Max": "go",
  "Qwen/Qwen3.7-Plus": "go",
  "Qwen/Qwen3.8-27B": "go",
  "Qwen/Qwen3.8-Flash": "go",
  "Qwen/Qwen3.8-Max": "go",
  // command-code@1.41.0 added Qwen 3.8 Max 0902; it sits on the Go plan page.
  "Qwen/Qwen3.8-Max-0902": "go",
  // command-code@1.56.0 added Qwen 3.8 Omni Flash; the pricing page's embedded
  // availability grants every tier (individual-go through teams-pro) — the
  // same "all":true shape as the rest of the Qwen 3.8 family.
  "Qwen/Qwen3.8-Omni-Flash": "go",
  // command-code@1.39.0 added DeepSeek V4 Flash Fast; it is a Go-tier model
  // alongside the rest of the DeepSeek V4 family.
  "deepseek/deepseek-v4-flash-fast": "go",
  // command-code@1.53.0 added DeepSeek V4.1 Flash ("Add new
  // deepseek/deepseek-v4.1-flash model"); the pricing page's embedded
  // availability grants it every plan including Go, and the Go/GOAT/Pro/Max
  // plan pages all list it.
  "deepseek/deepseek-v4.1-flash": "go",
  "deepseek/deepseek-v4-flash": "go",
  "deepseek/deepseek-v4-flash-vision-exp": "go",
  "deepseek/deepseek-v4-pro": "go",
  "gpt-5.6-luna": "go",
  // command-code@1.42.0 added Meituan's LongCat 2.0 as a free Go-tier model
  // ("LongCat 2.0 free model" — 100% off while it lasts, every plan). That
  // promo ended 2026-09-19: the pricing page dropped the deal and the free
  // slug, the public catalog renamed the id to `meituan/LongCat-2.0` (paid,
  // $0.30/$1.20/$0.006), and the docs list the new id. command-code@1.58.0
  // followed the backend: it adds the paid id and marks the retired `:free`
  // sibling `hidden` ("LongCat 2.0 (Free)"), so the CLI registry now agrees
  // with the catalog this map is keyed by.
  "meituan/LongCat-2.0": "go",
  // command-code@1.52.0 added Ling 3.0 Flash Sante as a free Go-tier model
  // ("free, up to 100 requests a day", every plan) — the successor to the
  // retired `inclusionai/ling-3.0-flash-free` promo.
  "inclusionai/ling-3.0-flash-sante:free": "go",
  // command-code@1.44.0 added Muse Spark 1.3 Contributor on every plan
  // including Go, like its 1.2 Contributor sibling.
  "meta/muse-spark-1.2-contributor": "go",
  "meta/muse-spark-1.3-contributor": "go",
  "moonshotai/Kimi-K2.5": "go",
  "moonshotai/Kimi-K2.6": "go",
  "moonshotai/Kimi-K2.7-Code": "go",
  "moonshotai/Kimi-K2.7-Code-Highspeed": "go",
  "moonshotai/Kimi-K3": "go",
  "nvidia/nemotron-3-ultra-550b-a55b": "go",
  "poolside/laguna-s-2.1-free": "go",
  "stepfun/Step-3.5-Flash": "go",
  "stepfun/Step-3.7-Flash": "go",
  "tencent/hy3-paid": "go",
  "tencent/hy4-preview": "go",
  "thinkingmachines/inkling": "go",
  "thinkingmachines/inkling-small": "go",
  "xai/grok-4.5": "go",
  "xiaomi/mimo-v2.5": "go",
  "xiaomi/mimo-v2.5-pro": "go",
  "z-ai/glm-5.3-flash": "go",
  // command-code@1.57.0 added GLM-5.3 FlashX; the pricing page's embedded
  // availability grants every tier (individual-go through teams-pro) — the
  // same "all":true shape as its `z-ai/glm-5.3-flash` sibling.
  "z-ai/glm-5.3-flashx": "go",
  "zai-org/GLM-5": "go",
  "zai-org/GLM-5.1": "go",
  "zai-org/GLM-5.2": "go",
  "zai-org/GLM-5.2-Fast": "go",
  "zai-org/GLM-5.3": "go",
  // --- GOAT (6 more) ---
  "google/gemini-3.7-flash": "goat",
  // command-code@1.43.0 added Gemini 3.8 Flash; the pricing page marks it
  // "Available on GOAT and above", like the rest of the Gemini Flash family.
  "google/gemini-3.8-flash": "goat",
  "gpt-5.6-sol": "goat",
  "meta/muse-spark-1.2": "goat",
  // command-code@1.44.0 added Muse Spark 1.3; the pricing page marks it
  // "Available on GOAT and above", like the 1.2/1.1 models.
  "meta/muse-spark-1.3": "goat",
  "xai/grok-4.6": "goat",
  // --- Pro (13 more) ---
  "claude-haiku-4-5-20251001": "pro",
  "claude-sonnet-4-6": "pro",
  "claude-sonnet-5": "pro",
  "google/gemini-3.1-flash-lite": "pro",
  "google/gemini-3.5-flash": "pro",
  "google/gemini-3.5-flash-lite": "pro",
  "google/gemini-3.6-flash": "pro",
  "gpt-5.3-codex": "pro",
  "gpt-5.4": "pro",
  "gpt-5.4-mini": "pro",
  "gpt-5.5": "pro",
  "gpt-5.6-terra": "pro",
  "meta/muse-spark-1.1": "pro",
  // --- Provider / Max (7) ---
  "claude-fable-5-1": "provider",
  "claude-fable-5": "provider",
  "claude-opus-4-7": "provider",
  "claude-opus-4-8": "provider",
  "claude-opus-5": "provider",
  // command-code@1.49.0 added GPT-6 Astra; per the pricing page it sits on
  // Max (Provider/Max tier).
  "gpt-6-astra": "provider",
  "sakana/fugu-ultra": "provider"
};
var PLAN_LABELS = {
  go: "Go",
  goat: "GOAT",
  pro: "Pro",
  provider: "Provider",
  max: "Max"
};
var PLAN_ORDER = {
  go: 0,
  goat: 1,
  pro: 2,
  provider: 3,
  max: 4
};
function isFreeModel(modelId) {
  return KNOWN_DEALS[modelId]?.free === true;
}
function compareByPlan(a, b) {
  const freeDelta = Number(isFreeModel(b.id)) - Number(isFreeModel(a.id));
  if (freeDelta !== 0) return freeDelta;
  const pa = PLAN_ORDER[KNOWN_PLANS[a.id] ?? ""] ?? Number.MAX_SAFE_INTEGER;
  const pb = PLAN_ORDER[KNOWN_PLANS[b.id] ?? ""] ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  const nameDiff = a.name.localeCompare(b.name);
  if (nameDiff !== 0) return nameDiff;
  return a.id.localeCompare(b.id);
}
var KNOWN_SUBSCRIPTION_PLANS = {
  "individual-go": { name: "Go", monthlyCredits: 10, tierWeight: 0 },
  "individual-goat": { name: "GOAT", monthlyCredits: 70, tierWeight: 1 },
  "individual-pro": { name: "Pro", monthlyCredits: 30, tierWeight: 2 },
  "individual-pro-v1": { name: "Pro", monthlyCredits: 80, tierWeight: 2 },
  "individual-provider": { name: "Provider", monthlyCredits: 15, tierWeight: 3 },
  "individual-max": { name: "Max", monthlyCredits: 150, tierWeight: 4 },
  "individual-ultra": { name: "Ultra", monthlyCredits: 300, tierWeight: 4 },
  "teams-pro": { name: "Teams Pro", monthlyCredits: 40, tierWeight: 2 }
};
var SUBSCRIPTION_PLAN_PREFIXES = Object.keys(KNOWN_SUBSCRIPTION_PLANS).sort((a, b) => b.length - a.length);
function subscriptionPlanInfo(planId) {
  const normalized = planId.toLowerCase().replace(/_/g, "-");
  const prefix = SUBSCRIPTION_PLAN_PREFIXES.find((candidate) => normalized.startsWith(candidate));
  return prefix === void 0 ? void 0 : KNOWN_SUBSCRIPTION_PLANS[prefix];
}
function modelVisibleInPlan(modelId, access) {
  if (access === void 0) return true;
  if (access.onDemandCredits > 0) return true;
  if (access.tierWeight === void 0 || !Number.isFinite(access.tierWeight)) return true;
  const tier = KNOWN_PLANS[modelId];
  if (tier === void 0) return true;
  const weight = PLAN_ORDER[tier];
  if (weight === void 0) return true;
  return weight <= access.tierWeight;
}
function modelVisibleForAnyAccount(modelId, accounts) {
  if (accounts === void 0 || accounts.length === 0) return true;
  return accounts.some((access) => modelVisibleInPlan(modelId, access));
}
var KNOWN_DEALS = {
  // Gemini 3.7 Flash's 50% off deal was retired from the official pricing
  // page's #deals section (command-code@1.38.2 sync); the model now shows at
  // full price.
  "MiniMaxAI/MiniMax-M3": { label: "50% off" },
  "xiaomi/mimo-v2.5-pro": { label: "99% off" },
  "xiaomi/mimo-v2.5": { label: "98% off" },
  // The MiniMax M3 / M2.7 FREE promo variants were retired in
  // command-code@1.39.2 ("Retire MiniMax free models"): the official CLI hides
  // them and the pricing page no longer lists them as free, so the free
  // entries that shipped through 1.38.2 (with a 2026-09-05 expiry) are removed
  // here rather than left to lapse on schedule. The paid MiniMax M3 / M2.7
  // rows keep their own rates.
  "poolside/laguna-s-2.1-free": { label: "FREE", free: true },
  // Meituan's LongCat 2.0 promo ended 2026-09-19 (the pricing page's deal count
  // dropped 6 -> 5, its free count 4 -> 3, and the DEAL block no longer exists):
  // the entry that shipped from command-code@1.42.0 on is removed here rather
  // than left to badge a model the catalog now serves paid as
  // `meituan/LongCat-2.0` at $0.30/$1.20/$0.006.
  // Ling 3.0 Flash Sante (command-code@1.52.0) is free "up to 100 requests a
  // day" while the promo lasts — a permanent-style deal (no fixed end date,
  // like LongCat 2.0 used to be). Free requests cost no credits on every plan.
  "inclusionai/ling-3.0-flash-sante:free": { label: "FREE", free: true }
};
var KNOWN_PEAK_PRICING = /* @__PURE__ */ new Set([
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  // command-code@1.53.0 added DeepSeek V4.1 Flash with the same `timeOfDay`
  // block as the other DeepSeek models (off-peak $0.15/$0.60, peak
  // $0.30/$1.20, 01–04 & 06–10 UTC Mon–Fri).
  "deepseek/deepseek-v4.1-flash"
]);
var PEAK_HOUR_RANGES = [
  [1, 4],
  [6, 10]
];
function isPeakPricingHour(now = Date.now()) {
  const at = new Date(now);
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return PEAK_HOUR_RANGES.some(([start, end]) => hour >= start && hour < end);
}
function peakPricingState(modelId, now = Date.now()) {
  if (!KNOWN_PEAK_PRICING.has(modelId)) return void 0;
  return isPeakPricingHour(now) ? "peak" : "off-peak";
}
function peakPricingLabel(modelId, now = Date.now()) {
  const state = peakPricingState(modelId, now);
  if (state === void 0) return void 0;
  return state === "peak" ? "Peak" : "Half";
}
function planLabel(modelId) {
  const plan = KNOWN_PLANS[modelId];
  return plan === void 0 ? void 0 : PLAN_LABELS[plan];
}
function dealLabel(modelId, now = Date.now()) {
  const deal = KNOWN_DEALS[modelId];
  if (deal === void 0) return void 0;
  if (deal.expiresAt !== void 0 && now >= Date.parse(deal.expiresAt)) return void 0;
  return deal.label;
}
function formatContext(contextWindow) {
  if (contextWindow === void 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return void 0;
  }
  if (contextWindow >= 1e6) {
    const m = contextWindow / 1e6;
    const rounded = Math.round(m * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`;
  }
  if (contextWindow < 1e3) return String(Math.floor(contextWindow));
  return `${Math.floor(contextWindow / 1e3)}K`;
}
function capabilityDescription(modelId, contextWindow, now = Date.now()) {
  const parts = [];
  const plan = planLabel(modelId);
  if (plan !== void 0) parts.push(plan);
  const deal = dealLabel(modelId, now);
  if (deal !== void 0) parts.push(deal);
  const peak = peakPricingLabel(modelId, now);
  if (peak !== void 0) parts.push(peak);
  if (KNOWN_IMAGE_MODELS.has(modelId)) parts.push("Image");
  const ctx = formatContext(contextWindow);
  if (ctx !== void 0) parts.push(ctx);
  return parts.join(" \xB7 ");
}

// model-prices.ts
var MODEL_PRICE_ROWS = [
  { id: "claude-fable-5", rates: [10, 50, 1, 12.5] },
  { id: "claude-fable-5-1", rates: [10, 50, 0.25, 12.5] },
  { id: "claude-haiku-4-5", rates: [1, 5, 0.1, 1.25] },
  { id: "claude-opus-4-6", rates: [5, 25, 0.5, 6.25] },
  { id: "claude-opus-4-7", rates: [5, 25, 0.5, 6.25] },
  { id: "claude-opus-4-8", rates: [5, 25, 0.5, 6.25] },
  { id: "claude-opus-5", rates: [5, 25, 0.5, 6.25] },
  { id: "claude-sonnet-4-6", rates: [3, 15, 0.3, 3.75] },
  { id: "claude-sonnet-5", rates: [2, 10, 0.2, 2.5] },
  { id: "deepseek-v4-flash", rates: [0.15, 0.6, 3e-3], peak: [0.3, 1.2, 6e-3] },
  { id: "deepseek-v4-flash-fast", rates: [0.28, 0.56, 0.07] },
  { id: "deepseek-v4-flash-vision-exp", rates: [0.15, 0.6, 3e-3], peak: [0.3, 1.2, 6e-3] },
  { id: "deepseek-v4-pro", rates: [0.66, 1.98, 0.022], peak: [1.32, 3.96, 0.044] },
  { id: "deepseek-v4.1-flash", rates: [0.15, 0.6, 3e-3], peak: [0.3, 1.2, 6e-3] },
  { id: "fugu-ultra", rates: [5, 30, 0.5] },
  { id: "gemini-3.1-flash-lite", rates: [0.25, 1.5, 0.03] },
  { id: "gemini-3.5-flash", rates: [1.5, 9, 0.15] },
  { id: "gemini-3.5-flash-lite", rates: [0.3, 2.5, 0.03] },
  { id: "gemini-3.6-flash", rates: [1.5, 7.5, 0.15] },
  { id: "gemini-3.7-flash", rates: [1.5, 7.5, 0.15, 0.08334] },
  { id: "gemini-3.8-flash", rates: [1.5, 7.5, 0.15] },
  { id: "glm-5", rates: [1, 3.2, 0.2] },
  { id: "glm-5.1", rates: [1.4, 4.4, 0.26] },
  { id: "glm-5.2", rates: [1.4, 4.4, 0.26] },
  { id: "glm-5.2-fast", rates: [3, 10.25, 0.5] },
  { id: "glm-5.3", rates: [1.4, 4.4, 0.26] },
  { id: "glm-5.3-flash", rates: [0.15, 0.5, 0.03] },
  { id: "glm-5.3-flashx", rates: [0.37, 1.25, 0.075] },
  { id: "gpt-5.3-codex", rates: [2, 8, 0.5, 0] },
  { id: "gpt-5.4", rates: [2.5, 15, 0.25, 0] },
  { id: "gpt-5.4-mini", rates: [0.75, 4.5, 0.075, 0] },
  { id: "gpt-5.5", rates: [5, 30, 0.5, 0] },
  { id: "gpt-5.6-luna", rates: [0.2, 1.2, 0.02, 0.25], contextTiers: [{ "maxContext": 272e3, "rates": [0.2, 1.2, 0.02, 0.25] }, { "rates": [0.4, 1.8, 0.04, 0.5] }] },
  { id: "gpt-5.6-sol", rates: [5, 30, 0.5, 6.25], contextTiers: [{ "maxContext": 272e3, "rates": [5, 30, 0.5, 6.25] }, { "rates": [10, 45, 1, 12.5] }] },
  { id: "gpt-5.6-terra", rates: [2, 12, 0.2, 2.5], contextTiers: [{ "maxContext": 272e3, "rates": [2, 12, 0.2, 2.5] }, { "rates": [4, 18, 0.4, 5] }] },
  { id: "gpt-6-astra", rates: [10, 50, 1, 12.5], contextTiers: [{ "maxContext": 272e3, "rates": [10, 50, 1, 12.5] }, { "rates": [20, 75, 2, 25] }] },
  { id: "grok-4.5", rates: [2, 6, 0.5] },
  { id: "grok-4.6", rates: [2, 6, 0.5], contextTiers: [{ "maxContext": 2e5, "rates": [2, 6, 0.5] }, { "rates": [4, 12, 1] }] },
  { id: "inkling", rates: [1, 4.05, 0.17] },
  { id: "inkling-small", rates: [0.5, 1.2, 0.1] },
  { id: "kimi-k2.5", rates: [0.6, 3, 0.1] },
  { id: "kimi-k2.6", rates: [0.95, 4, 0.16] },
  { id: "kimi-k2.7-code", rates: [0.95, 4, 0.19] },
  { id: "kimi-k2.7-code-highspeed", rates: [1.9, 8, 0.38] },
  { id: "kimi-k3", rates: [3, 15, 0.3] },
  { id: "longcat-2.0", rates: [0.3, 1.2, 6e-3] },
  { id: "mimo-v2.5", rates: [0.14, 0.28, 28e-4] },
  { id: "mimo-v2.5-pro", rates: [0.435, 0.87, 36e-4] },
  { id: "minimax-m2.5", rates: [0.3, 1.2, 0.03] },
  { id: "minimax-m2.7", rates: [0.3, 1.2, 0.06] },
  { id: "minimax-m3", rates: [0.3, 1.2, 0.06] },
  { id: "muse-spark-1.1", rates: [1.25, 4.25, 0.15] },
  { id: "muse-spark-1.2", rates: [1.25, 4.25, 0.15] },
  { id: "muse-spark-1.2-contributor", rates: [0.1, 0.2, 2e-3] },
  { id: "muse-spark-1.3", rates: [1.25, 4.25, 0.15] },
  { id: "muse-spark-1.3-contributor", rates: [0.1, 0.2, 2e-3] },
  { id: "nemotron-3-ultra", rates: [0.6, 2.4, 0.12] },
  { id: "qwen-3.6-max", rates: [1.3, 7.8, 0.26, 1.63] },
  { id: "qwen-3.6-plus", rates: [0.5, 3, 0.1], contextTiers: [{ "maxContext": 256e3, "rates": [0.5, 3, 0.1] }, { "rates": [2, 6, 0.2] }] },
  { id: "qwen-3.7-flash", rates: [0.03, 0.13, 6e-3, 0.038], contextTiers: [{ "maxContext": 32e3, "rates": [0.03, 0.13, 6e-3, 0.038] }, { "maxContext": 256e3, "rates": [0.1, 0.4, 0.02, 0.125] }, { "rates": [0.2, 0.8, 0.04, 0.25] }] },
  { id: "qwen-3.7-max", rates: [2.5, 7.5, 0.5, 3.13] },
  { id: "qwen-3.7-plus", rates: [0.4, 1.6, 0.08, 0.5], contextTiers: [{ "maxContext": 256e3, "rates": [0.4, 1.6, 0.08, 0.5] }, { "rates": [1.2, 4.8, 0.24, 1.5] }] },
  { id: "qwen-3.8-27b", rates: [0.4, 3, 0.04] },
  { id: "qwen-3.8-flash", rates: [0.16, 0.47, 0.016] },
  { id: "qwen-3.8-max", rates: [2, 6, 0.25, 2.5] },
  { id: "qwen-3.8-max-0902", rates: [2, 6, 0.25] },
  { id: "qwen-3.8-omni-flash", rates: [0.15, 0.47, 0.016] },
  { id: "step-3.5-flash", rates: [0.1, 0.3, 0.02] },
  { id: "step-3.7-flash", rates: [0.2, 1.15, 0.04] },
  { id: "tencent/hy3-paid", rates: [0.14, 0.58, 0.035] },
  { id: "tencent/hy4-preview", rates: [0.834, 2.501, 0.042] }
];
var PRICE_SLUG_OVERRIDES = {
  // The page lists it by its short name; the catalog carries the full one.
  "nvidia/nemotron-3-ultra-550b-a55b": "nemotron-3-ultra"
};
function priceSlugCandidates(modelId) {
  const lower = modelId.toLowerCase();
  const bare = lower.includes("/") ? lower.slice(lower.indexOf("/") + 1) : lower;
  const out = /* @__PURE__ */ new Set();
  const add = (slug) => {
    const hyphenated = slug.replace(/^([a-z]+)(\d)/, "$1-$2");
    out.add(slug);
    out.add(hyphenated);
    out.add(slug.replace(/-\d{8}$/, ""));
    out.add(slug.replace(/-(preview|latest)$/, ""));
    out.add(hyphenated.replace(/-\d{8}$/, ""));
    out.add(hyphenated.replace(/-(preview|latest)$/, ""));
  };
  add(lower);
  add(bare);
  return [...out];
}
function priceSlugFor(modelId, known) {
  const override = PRICE_SLUG_OVERRIDES[modelId];
  if (override !== void 0) return known.has(override) ? override : void 0;
  return priceSlugCandidates(modelId).find((slug) => known.has(slug));
}
function ratesOf(values) {
  const rates = {
    inputCost: values[0],
    outputCost: values[1],
    cacheReadCost: values[2]
  };
  if (values[3] !== void 0) rates.cacheWriteCost = values[3];
  return rates;
}
function wireRow(id, slug, row) {
  const price = { id, slug, ...ratesOf(row.rates) };
  if (row.peak !== void 0) price.peak = ratesOf(row.peak);
  if (row.contextTiers !== void 0) price.contextTiers = row.contextTiers.map((tier) => ({
    ...ratesOf(tier.rates),
    ...tier.maxContext === void 0 ? {} : { maxContext: tier.maxContext }
  }));
  return price;
}
function modelPriceTable() {
  const bySlug = new Map(MODEL_PRICE_ROWS.map((row) => [row.id, row]));
  const known = new Set(bySlug.keys());
  const models = [];
  const claimed = /* @__PURE__ */ new Set();
  for (const catalogId of Object.keys(KNOWN_PLANS)) {
    if (isFreeModel(catalogId) || catalogId.endsWith(":free")) {
      models.push({ id: catalogId, slug: catalogId, inputCost: 0, outputCost: 0, cacheReadCost: 0, free: true });
      continue;
    }
    const slug = priceSlugFor(catalogId, known);
    if (slug === void 0) continue;
    const row = bySlug.get(slug);
    if (row === void 0) continue;
    claimed.add(slug);
    models.push(wireRow(catalogId, slug, row));
  }
  for (const row of MODEL_PRICE_ROWS) {
    if (claimed.has(row.id)) continue;
    models.push(wireRow(row.id, row.id, row));
  }
  return {
    models,
    peakHours: PEAK_HOUR_RANGES.map(([start, end]) => [start, end])
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  KNOWN_DEALS,
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MODELS,
  KNOWN_PEAK_PRICING,
  KNOWN_PLANS,
  KNOWN_SUBSCRIPTION_PLANS,
  KNOWN_THINKING_MODELS,
  MESSAGES_ONLY_MODELS,
  PEAK_HOUR_RANGES,
  PLAN_LABELS,
  PLAN_ORDER,
  capabilityDescription,
  compareByPlan,
  dealLabel,
  formatContext,
  isFreeModel,
  isPeakPricingHour,
  modelPriceTable,
  modelVisibleForAnyAccount,
  modelVisibleInPlan,
  peakPricingLabel,
  peakPricingState,
  planLabel,
  requiresMessagesEndpoint,
  subscriptionPlanInfo
});
