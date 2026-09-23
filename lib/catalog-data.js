/**
 * Generated capability snapshot for Command Code (catalog 1.56.0).
 *
 * Sources:
 *   - ids, display names, context windows, endpoints: https://api.commandcode.ai/provider/v1/models
 *   - image input, reasoning flags, effort levels, output limits: pi-commandcode-provider@latest (1.56.0)
 *
 * Regenerate with: npm run sync:catalog
 * Do not edit by hand.
 */

const CATALOG_CLI_VERSION = "1.56.0"

const CATALOG = [
  {
    "id": "claude-fable-5",
    "name": "Claude Fable 5",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/messages"
    ]
  },
  {
    "id": "claude-fable-5-1",
    "name": "Claude Fable 5.1",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/messages"
    ]
  },
  {
    "id": "claude-haiku-4-5-20251001",
    "name": "Claude Haiku 4.5",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/messages"
    ]
  },
  {
    "id": "claude-opus-4-7",
    "name": "Claude Opus 4.7",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/messages"
    ]
  },
  {
    "id": "claude-opus-4-8",
    "name": "Claude Opus 4.8",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/messages"
    ]
  },
  {
    "id": "claude-opus-5",
    "name": "Claude Opus 5",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/messages"
    ]
  },
  {
    "id": "claude-sonnet-4-6",
    "name": "Claude Sonnet 4.6",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/messages"
    ]
  },
  {
    "id": "claude-sonnet-5",
    "name": "Claude Sonnet 5",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/messages"
    ]
  },
  {
    "id": "deepseek/deepseek-v4-flash",
    "name": "DeepSeek V4 Flash (latest)",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "deepseek/deepseek-v4-flash-fast",
    "name": "DeepSeek V4 Flash Fast",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions"
    ]
  },
  {
    "id": "deepseek/deepseek-v4-flash-vision-exp",
    "name": "DeepSeek V4 Flash Vision (exp)",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "deepseek/deepseek-v4-pro",
    "name": "DeepSeek V4 Pro (latest)",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "deepseek/deepseek-v4.1-flash",
    "name": "DeepSeek V4.1 Flash",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "google/gemini-3.1-flash-lite",
    "name": "Gemini 3.1 Flash Lite",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "google/gemini-3.5-flash",
    "name": "Gemini 3.5 Flash",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "google/gemini-3.5-flash-lite",
    "name": "Gemini 3.5 Flash Lite",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "google/gemini-3.6-flash",
    "name": "Gemini 3.6 Flash",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "google/gemini-3.7-flash",
    "name": "Gemini 3.7 Flash",
    "contextWindow": 1048576,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions"
    ]
  },
  {
    "id": "google/gemini-3.8-flash",
    "name": "Gemini 3.8 Flash",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "gpt-5.3-codex",
    "name": "GPT-5.3 Codex",
    "contextWindow": 400000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "gpt-5.4",
    "name": "GPT-5.4",
    "contextWindow": 400000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "gpt-5.4-mini",
    "name": "GPT-5.4 Mini",
    "contextWindow": 400000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "gpt-5.5",
    "name": "GPT-5.5",
    "contextWindow": 400000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "gpt-5.6-luna",
    "name": "GPT-5.6 Luna",
    "contextWindow": 1050000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "gpt-5.6-sol",
    "name": "GPT-5.6 Sol",
    "contextWindow": 1050000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "gpt-5.6-terra",
    "name": "GPT-5.6 Terra",
    "contextWindow": 1050000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "inclusionai/ling-3.0-flash-sante:free",
    "name": "Ling 3.0 Flash Sante",
    "contextWindow": 262144,
    "maxTokens": 32768,
    "image": false,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions"
    ]
  },
  {
    "id": "meituan/LongCat-2.0",
    "name": "LongCat 2.0",
    "contextWindow": 1048576,
    "maxTokens": 32000,
    "image": false,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions"
    ]
  },
  {
    "id": "meta/muse-spark-1.1",
    "name": "Muse Spark 1.1",
    "contextWindow": 1048576,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "meta/muse-spark-1.2",
    "name": "Muse Spark 1.2",
    "contextWindow": 1048576,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "meta/muse-spark-1.2-contributor",
    "name": "Muse Spark 1.2 Contributor",
    "contextWindow": 1048576,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "meta/muse-spark-1.3",
    "name": "Muse Spark 1.3",
    "contextWindow": 1048576,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "meta/muse-spark-1.3-contributor",
    "name": "Muse Spark 1.3 Contributor",
    "contextWindow": 1048576,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "MiniMaxAI/MiniMax-M2.5",
    "name": "MiniMax M2.5",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "MiniMaxAI/MiniMax-M2.7",
    "name": "MiniMax M2.7",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "MiniMaxAI/MiniMax-M3",
    "name": "MiniMax M3",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "moonshotai/Kimi-K2.5",
    "name": "Kimi K2.5",
    "contextWindow": 256000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "moonshotai/Kimi-K2.6",
    "name": "Kimi K2.6",
    "contextWindow": 256000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "moonshotai/Kimi-K2.7-Code",
    "name": "Kimi K2.7 Code",
    "contextWindow": 256000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "moonshotai/Kimi-K2.7-Code-Highspeed",
    "name": "Kimi K2.7 Code HighSpeed",
    "contextWindow": 262000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "moonshotai/Kimi-K3",
    "name": "Kimi K3",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "nvidia/nemotron-3-ultra-550b-a55b",
    "name": "Nemotron 3 Ultra",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "poolside/laguna-s-2.1-free",
    "name": "Laguna S 2.1",
    "contextWindow": 256000,
    "maxTokens": 32768,
    "image": false,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "Qwen/Qwen3.6-Max-Preview",
    "name": "Qwen 3.6 Max Preview",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "Qwen/Qwen3.6-Plus",
    "name": "Qwen 3.6 Plus",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "Qwen/Qwen3.7-Flash",
    "name": "Qwen 3.7 Flash",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "Qwen/Qwen3.7-Max",
    "name": "Qwen 3.7 Max",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "Qwen/Qwen3.7-Plus",
    "name": "Qwen 3.7 Plus",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "Qwen/Qwen3.8-27B",
    "name": "Qwen 3.8 27B",
    "contextWindow": 262144,
    "maxTokens": 32768,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "Qwen/Qwen3.8-Flash",
    "name": "Qwen 3.8 Flash",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions"
    ]
  },
  {
    "id": "Qwen/Qwen3.8-Max",
    "name": "Qwen 3.8 Max",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "Qwen/Qwen3.8-Max-0902",
    "name": "Qwen 3.8 Max 0902",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions"
    ]
  },
  {
    "id": "Qwen/Qwen3.8-Omni-Flash",
    "name": "Qwen 3.8 Omni Flash",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "sakana/fugu-ultra",
    "name": "Fugu Ultra",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "stepfun/Step-3.5-Flash",
    "name": "Step 3.5 Flash",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions"
    ]
  },
  {
    "id": "stepfun/Step-3.7-Flash",
    "name": "Step 3.7 Flash",
    "contextWindow": 256000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "tencent/hy3-paid",
    "name": "Tencent Hy3",
    "contextWindow": 262144,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "tencent/hy4-preview",
    "name": "Tencent Hy4 Preview",
    "contextWindow": 1048576,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions"
    ]
  },
  {
    "id": "thinkingmachines/inkling",
    "name": "Inkling",
    "contextWindow": 256000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "thinkingmachines/inkling-small",
    "name": "Inkling Small",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "xai/grok-4.5",
    "name": "Grok 4.5",
    "contextWindow": 500000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "xai/grok-4.6",
    "name": "Grok 4.6",
    "contextWindow": 500000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "xiaomi/mimo-v2.5",
    "name": "MiMo V2.5",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": true,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "xiaomi/mimo-v2.5-pro",
    "name": "MiMo V2.5 Pro",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "z-ai/glm-5.3-flash",
    "name": "GLM-5.3 Flash",
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "image": true,
    "reasoning": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "z-ai/glm-5.3-flashx",
    "name": "GLM-5.3 FlashX",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "zai-org/GLM-5",
    "name": "GLM-5",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "zai-org/GLM-5.1",
    "name": "GLM-5.1",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "zai-org/GLM-5.2",
    "name": "GLM-5.2",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "zai-org/GLM-5.2-Fast",
    "name": "GLM-5.2 Fast",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": false,
    "efforts": [],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  },
  {
    "id": "zai-org/GLM-5.3",
    "name": "GLM-5.3",
    "contextWindow": 1000000,
    "maxTokens": 32000,
    "image": false,
    "reasoning": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "endpoints": [
      "/chat/completions",
      "/responses"
    ]
  }
]

module.exports = { CATALOG_CLI_VERSION, CATALOG }
