// OpenCode & Magpie provider plugin for MonkeyCode (monkeycode-ai.com).
//
// MonkeyCode serves its hosted models on an Anthropic-compatible endpoint
// ({base}/messages) plus an OpenAI Responses endpoint ({base}/responses) for a
// few models. Every request carries the client's API key (oma_...) and a
// signature over the *first* system prompt:
//
//   X-Ohmyagent-Signature = "v1=" + hex(HMAC-SHA256(signing_secret, system[0].text))
//
// The vendor only checks that the signature matches what was sent, not that
// the system prompt is its own text, so this plugin always puts one fixed
// sentence first and appends the agent's system prompt after it. On the
// Responses endpoint the signed object is input[0].content instead.
//
// Credentials are read from the official client's settings.json: an `oma_`
// api key plus an `omas_` signing secret. A console session cookie is
// optional and only used for the usage and check-in reads.

import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const PROVIDER_ID = "monkeycode"
const PROVIDER_NAME = "MonkeyCode"
const ANTHROPIC_NPM = "@ai-sdk/anthropic"
const RESPONSES_NPM = "@ai-sdk/openai"

const DEFAULT_BASE = "https://proxy.monkeycode-ai.com/v1"
const CONSOLE_BASE = "https://monkeycode-ai.com"

// The signed system prompt. It must stay byte-identical to what is sent: any
// change here invalidates every signature this plugin computes.
const SIGN_PROMPT = "You are a helpful assistant."
const AGENT_UA = "ohmyagent f6b21ad"
const ANTHROPIC_VERSION = "2023-06-01"
const DEFAULT_MAX_TOKENS = 16384
const MAX_TOKENS_CAP = 32000

const CONTEXT_WINDOW = 200000
const MAX_OUTPUT = 32000

const CHANNEL_PREFIX = "monkeycode/"
const TIERS = ["basic", "pro", "ultra"]

// Hosted models as the official client lists them. The proxy domain has no
// model catalogue endpoint (GET /models answers 405); the console does
// (/api/v1/users/models, cookie-authenticated) but it also lists entries
// flagged is_hidden, which the client hides too. This table equals the
// console's visible set (verified 2026-10-23 against the live catalogue).
const MODEL_IDS = [
  "basic/deepseek-flash",
  "basic/glm-5.3-flash",
  "basic/kimi-k2.5",
  "basic/minimax-m2.5",
  "basic/qwen3.5-plus",
  "basic/qwen3.8-flash",
  "pro/deepseek-flash",
  "pro/glm-5",
  "pro/hy3",
  "pro/kimi-k2.6",
  "pro/minimax-m3",
  "pro/qwen3.6-plus",
  "pro/gpt-5.6-terra",
  "ultra/glm-5.1",
  "ultra/qwen3.7-max",
  "ultra/gpt-5.6-sol",
  "ultra/gpt-6-astra",
  "deepseek-flash",
  "glm-5.1",
  "glm-5",
  "kimi-k2.6",
  "minimax-m2.5",
  "minimax-m3",
  "qwen3.6-plus",
  "qwen3.7-max",
]

// Models the vendor serves on the Responses endpoint. Asking for one of these
// on /messages answers 404 "route not found".
const RESPONSES_MODELS = new Set([
  "basic/qwen3.8-flash",
  "pro/gpt-5.6-terra",
  "ultra/gpt-5.6-sol",
  "ultra/gpt-6-astra",
])

// Fields an OpenAI Responses request may carry that MonkeyCode does not take.
const RESPONSES_DROP = [
  "store",
  "include",
  "prompt_cache_key",
  "metadata",
  "service_tier",
  "parallel_tool_calls",
  "truncation",
  "user",
  "previous_response_id",
  "background",
  "max_tool_calls",
  "top_logprobs",
  "stream_options",
]

const MODEL_LABELS = {
  "pro/gpt-5.6-terra": "专业模型 5.6 terra",
  "ultra/gpt-5.6-sol": "极致模型 5.6 sol",
  "ultra/gpt-6-astra": "极致模型 6 astra",
}

const TIER_LABELS = { basic: "Basic", pro: "Pro", ultra: "Ultra" }

// MonkeyCode has no "multiplier" field. Its console lists a per-model
// `input_price` on /api/v1/users/models/available, and what it actually
// charges tracks that price exactly (measured 2026-10-23: 197-token requests
// cost 4 / 8 / 15 / 23 / 30 credits at prices 100 / 200 / 400 / 600 / 800).
// The basic tier's list price is the natural 1x, so a model's credit rate is
// its price over that one.
const RATE_BASE = 200
const RATE_TTL_MS = 10 * 60 * 1000

// ---- helpers ----------------------------------------------------------------

const baseURL = () => String(process.env.MONKEYCODE_API_BASE || DEFAULT_BASE).replace(/\/+$/, "")
const consoleURL = () => String(process.env.MONKEYCODE_CONSOLE_BASE || CONSOLE_BASE).replace(/\/+$/, "")

// upstreamModelID is the name the vendor expects: tiered ids carry a
// `monkeycode-` prefix, bare ids are sent as they are.
function upstreamModelID(id) {
  const bare = bareModelID(id)
  const slash = bare.indexOf("/")
  if (slash > 0 && TIERS.includes(bare.slice(0, slash))) return "monkeycode-" + bare
  return bare
}

// bareModelID normalises every accepted spelling to a MODEL_IDS entry.
function bareModelID(id) {
  let s = String(id ?? "").trim()
  if (s.startsWith(CHANNEL_PREFIX)) s = s.slice(CHANNEL_PREFIX.length)
  if (s.startsWith("monkeycode-")) s = s.slice("monkeycode-".length)
  return s
}

function labelOf(id) {
  if (MODEL_LABELS[id]) return MODEL_LABELS[id]
  const slash = id.indexOf("/")
  if (slash > 0) {
    const tier = id.slice(0, slash)
    if (TIER_LABELS[tier]) return `${TIER_LABELS[tier]} · ${id.slice(slash + 1)}`
  }
  return id
}

function isResponsesModel(id) {
  return RESPONSES_MODELS.has(bareModelID(id))
}

function modelEntry(id, rate = 0) {
  const entry = {
    name: labelOf(id),
    id: upstreamModelID(id),
    limit: { context: CONTEXT_WINDOW, output: MAX_OUTPUT },
    tool_call: true,
    reasoning: true,
  }
  // magpie shows the credit rate beside the model; OpenCode ignores it.
  if (rate > 0) entry.rate = rate
  // A model on the Responses endpoint needs a different API shape than the
  // provider's default Anthropic one.
  if (isResponsesModel(id)) entry.provider = { npm: RESPONSES_NPM }
  return entry
}

function modelsConfig(rates) {
  return Object.fromEntries(MODEL_IDS.map((id) => [id, modelEntry(id, rates?.get(id) ?? 0)]))
}

// fetchRates reads the console's per-model input price and turns it into the
// credit rate magpie displays. The console lists hosted models under their
// upstream names (with the `monkeycode-` prefix), and only the basic tier and
// the bare names carry a price, so anything missing keeps no rate rather than
// a made-up one.
async function fetchRates(cookie) {
  if (!cookie) return { rates: new Map(), why: "no console cookie" }
  const res = await fetch(`${consoleURL()}/api/v1/users/models/available`, {
    headers: { Cookie: `monkeycode_ai_session=${cookie}`, Accept: "application/json", "User-Agent": AGENT_UA },
    signal: AbortSignal.timeout(10000),
  })
  const { payload } = await readJSON(res)
  if (!res.ok || Number(payload?.code) !== 0 || !Array.isArray(payload?.data)) {
    return { rates: new Map(), why: `HTTP ${res.status}` }
  }
  const rates = new Map()
  for (const row of payload.data) {
    const name = bareModelID(row?.name ?? row?.model ?? "")
    const price = Number(row?.input_price)
    if (!name || !Number.isFinite(price) || price <= 0) continue
    rates.set(name, price / RATE_BASE)
  }
  return { rates, why: "" }
}

// rateCache holds the last good answer per console cookie, so a listing keeps
// its rates when the console is briefly unreachable.
const rateCache = new Map()

function rateCacheKey(cookie) {
  return cookie ? cookie.slice(-12) : ""
}

// ratesFor returns the console's rates, reusing the last good read for a
// while so the model list stays stable when the console is slow.
async function ratesFor(cookie) {
  const key = rateCacheKey(cookie)
  const hit = key ? rateCache.get(key) : null
  if (hit && Date.now() - hit.at < RATE_TTL_MS) return hit.rates
  try {
    const { rates, why } = await fetchRates(cookie)
    if (rates.size && key) {
      rateCache.set(key, { rates, at: Date.now() })
      return rates
    }
    if (why) return hit?.rates ?? new Map()
    return rates
  } catch {
    return hit?.rates ?? new Map()
  }
}

// withRates puts the credit rate on the models magpie was about to show. A
// model the console prices nothing for keeps no rate, so magpie shows no
// badge instead of a wrong number.
function withRates(models, rates) {
  if (!rates?.size) return models
  const out = {}
  for (const [id, model] of Object.entries(models)) {
    const rate = rates.get(bareModelID(id)) ?? 0
    out[id] = rate > 0 ? { ...model, rate } : model
  }
  return out
}

// signatureCache keeps the signature per signing secret. The signed text is a
// constant, so a signature never goes stale.
const signatureCache = new Map()

function signatureOf(secret) {
  const s = String(secret ?? "").trim()
  if (!s) return ""
  const hit = signatureCache.get(s)
  if (hit) return hit
  const value = "v1=" + createHmac("sha256", s).update(SIGN_PROMPT, "utf8").digest("hex")
  signatureCache.set(s, value)
  return value
}

function stripBearer(value) {
  return String(value ?? "").trim().replace(/^Bearer\s+/i, "").trim()
}

// normalizeCookie accepts a bare cookie value, `name=value`, or a pasted
// Cookie header, and returns just the value of the console session.
function normalizeCookie(value) {
  let s = String(value ?? "").trim()
  if (!s || s === "-" || s === "none" || s === "skip") return ""
  if (s.toLowerCase().startsWith("cookie:")) s = s.slice(7).trim()
  const parts = s.split(";")
  for (const part of parts) {
    const eq = part.indexOf("=")
    if (eq > 0 && part.slice(0, eq).trim() === "monkeycode_ai_session") {
      return part.slice(eq + 1).trim()
    }
  }
  const eq = s.indexOf("=")
  if (eq > 0 && !s.includes(";")) return s.slice(eq + 1).trim()
  return s
}

// credentialOf reads the sign-in record into the values a request needs.
// A `key` that carries `oma_...:omas_...[:cookie]` is accepted as a fallback
// for a record written without metadata.
function credentialOf(auth) {
  const md = auth?.metadata ?? {}
  let key = stripBearer(auth?.key)
  let secret = String(md.secret ?? md.signing_secret ?? md.signingSecret ?? "").trim()
  let cookie = String(md.cookie ?? md.console_cookie ?? md.consoleCookie ?? "").trim()
  let base = String(md.base ?? md.base_url ?? "").trim()
  if (!secret && key.includes(":")) {
    const parts = key.split(":")
    key = stripBearer(parts[0])
    secret = String(parts[1] ?? "").trim()
    if (!cookie) cookie = String(parts[2] ?? "").trim()
  }
  return { key, secret, cookie: normalizeCookie(cookie), base: base ? base.replace(/\/+$/, "") : "" }
}

// ---- reading the official client -------------------------------------------

// settingsPaths lists where the desktop client keeps its settings.json.
function settingsPaths() {
  const out = []
  const override = String(process.env.MONKEYCODE_CONFIG_DIR ?? "").trim()
  if (override) out.push(join(override, "settings.json"))
  const home = homedir()
  if (process.platform === "win32") {
    const appData = String(process.env.APPDATA ?? "").trim()
    if (appData) out.push(join(appData, "com.chaitin.baizhi.monkeycode", "ohmyagent", "settings.json"))
    const local = String(process.env.LOCALAPPDATA ?? "").trim()
    if (local) {
      out.push(join(local, "com.chaitin.baizhi.monkeycode", "ohmyagent", "settings.json"))
      out.push(join(local, "MonkeyCode", "ohmyagent", "settings.json"))
    }
  } else if (process.platform === "darwin") {
    out.push(
      join(home, "Library", "Application Support", "com.chaitin.baizhi.monkeycode", "ohmyagent", "settings.json"),
    )
  } else {
    out.push(join(home, ".config", "com.chaitin.baizhi.monkeycode", "ohmyagent", "settings.json"))
  }
  return out
}

// readCookieFile reads one of the client's cookie files. They sit one level
// above the ohmyagent directory that holds settings.json, and hold
// [{name, value, expires}] entries.
function readCookieFile(settingsFile, name) {
  const file = join(dirname(dirname(settingsFile)), "monkeycode-cookies.json")
  try {
    const items = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(items)) return ""
    for (const item of items) {
      if (item?.name !== name) continue
      const expires = String(item?.expires ?? "")
      if (expires) {
        const at = Date.parse(expires)
        if (Number.isFinite(at) && Date.now() >= at) return ""
      }
      return String(item?.value ?? "").trim()
    }
  } catch {}
  return ""
}

// readLocalCredential reads the api key, signing secret, base URL and console
// cookie the desktop client already holds. Read-only: nothing is written back.
function readLocalCredential() {
  for (const path of settingsPaths()) {
    let raw
    try {
      raw = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      continue
    }
    const secret = String(raw?.signing_secret ?? "").trim()
    const models = raw?.models && typeof raw.models === "object" ? raw.models : {}
    const names = Object.keys(models)
      .filter((n) => n.startsWith("monkeycode-"))
      .sort()
    if (!secret || !names.length) continue
    const entry = models[names[0]] ?? {}
    const key = String(entry?.api_key ?? "").trim()
    if (!key) continue
    return {
      key,
      secret,
      base: String(entry?.base_url ?? "").trim(),
      cookie: readCookieFile(path, "monkeycode_ai_session"),
      path,
    }
  }
  return null
}

// ---- request shaping --------------------------------------------------------

// applyAnthropic puts the signed sentence first in system and appends the
// agent's own system prompt after it. Only system[0] is signed, so everything
// from system[1] on may carry dynamic content.
function applyAnthropic(body) {
  const system = body.system
  if (Array.isArray(system) && system[0]?.type === "text" && system[0]?.text === SIGN_PROMPT) {
    // Already shaped by this plugin.
  } else if (Array.isArray(system)) {
    body.system = [{ type: "text", text: SIGN_PROMPT }, ...system]
  } else if (typeof system === "string" && system.trim()) {
    body.system = [{ type: "text", text: SIGN_PROMPT }, { type: "text", text: system }]
  } else {
    body.system = [{ type: "text", text: SIGN_PROMPT }]
  }

  // Anthropic's max_tokens is required.
  const max = Number(body.max_tokens)
  if (!Number.isFinite(max) || max <= 0) body.max_tokens = DEFAULT_MAX_TOKENS
  else body.max_tokens = Math.min(Math.trunc(max), MAX_TOKENS_CAP)

  // The official client sends no request metadata.
  delete body.metadata
  return body
}

// applyResponses does the same for the Responses endpoint, where the signed
// object is input[0].content and the system prompt may arrive as
// `instructions` or as a leading system/developer item.
function applyResponses(body) {
  let input = body.input
  if (typeof input === "string") input = [{ role: "user", content: input }]
  if (!Array.isArray(input)) input = []

  const signed = Array.isArray(input) && input[0]?.role === "system" && input[0]?.content === SIGN_PROMPT
  if (!signed) {
    const rest = input.filter((item) => !(item && item.role === "system" && item.content === SIGN_PROMPT))
    for (const item of rest) {
      if (item && item.role === "developer") item.role = "system"
    }
    const prefix = []
    if (typeof body.instructions === "string" && body.instructions.trim()) {
      prefix.push({ role: "system", content: body.instructions })
    }
    delete body.instructions
    body.input = [{ role: "system", content: SIGN_PROMPT }, ...prefix, ...rest]
  }

  if (body.max_tokens != null) {
    if (body.max_output_tokens == null) body.max_output_tokens = body.max_tokens
    delete body.max_tokens
  }
  const out = Number(body.max_output_tokens)
  if (!Number.isFinite(out) || out <= 0) body.max_output_tokens = DEFAULT_MAX_TOKENS
  else body.max_output_tokens = Math.min(Math.trunc(out), MAX_TOKENS_CAP)

  for (const field of RESPONSES_DROP) delete body[field]
  return body
}

function pathOf(url) {
  try {
    return new URL(String(url)).pathname
  } catch {
    return String(url ?? "")
  }
}

function isResponsesURL(url) {
  return /\/responses\/?$/.test(pathOf(url))
}

// ---- vendor calls -----------------------------------------------------------

async function readJSON(res) {
  const text = await res.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  return { text, payload }
}

function vendorMessage(payload, fallback) {
  for (const k of ["message", "msg", "error_description", "detail"]) {
    const v = payload?.[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  const e = payload?.error
  if (typeof e === "string" && e.trim()) return e.trim()
  if (typeof e?.message === "string" && e.message.trim()) return e.message.trim()
  return fallback
}

// fetchWallet reads the console wallet: balance is in milli-credits, the
// daily fields are tokens.
async function fetchWallet(cookie) {
  const res = await fetch(`${consoleURL()}/api/v1/users/wallet`, {
    headers: {
      Cookie: `monkeycode_ai_session=${cookie}`,
      Accept: "application/json",
      "User-Agent": AGENT_UA,
    },
    signal: AbortSignal.timeout(20000),
  })
  const { text, payload } = await readJSON(res)
  if (res.status === 401) {
    const err = new Error("控制台会话已过期")
    err.status = 401
    throw err
  }
  if (!res.ok) throw new Error(`钱包接口 HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`)
  if (!payload || typeof payload !== "object") throw new Error("钱包接口返回的不是 JSON")
  if (Number(payload.code) !== 0) throw new Error(`钱包接口 code=${payload.code} ${vendorMessage(payload, "")}`.trim())
  return payload.data ?? {}
}

async function fetchCheckinState(cookie) {
  const res = await fetch(`${consoleURL()}/api/v1/users/wallet/checkin`, {
    headers: {
      Cookie: `monkeycode_ai_session=${cookie}`,
      Accept: "application/json",
      "User-Agent": AGENT_UA,
    },
    signal: AbortSignal.timeout(20000),
  })
  const { text, payload } = await readJSON(res)
  if (res.status === 401) {
    const err = new Error("控制台会话已过期")
    err.status = 401
    throw err
  }
  if (!res.ok) throw new Error(`签到状态接口 HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`)
  if (!payload || typeof payload !== "object") throw new Error("签到状态接口返回的不是 JSON")
  if (Number(payload.code) !== 0) throw new Error(`签到状态接口 code=${payload.code} ${vendorMessage(payload, "")}`.trim())
  const checkedIn = payload.data?.checked_in
  if (typeof checkedIn !== "boolean") throw new Error("签到状态回执缺少 checked_in")
  return { checkedIn }
}

function formatTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K`
  return String(v)
}

function walletToUsage(data) {
  const milli = Number(data?.balance) || 0
  const credits = milli > 0 ? Math.ceil(milli / 1000) : 0
  const limit = Number(data?.daily_token_limit) || 0
  const remain = Number(data?.daily_token_balance) || 0
  const used = Math.max(0, limit - remain)
  const windows = []
  if (limit > 0) {
    windows.push({
      name: "每日 Token 额度",
      used: (used / limit) * 100,
      display: `${formatTokens(used)} / ${formatTokens(limit)} tokens`,
      amount: used,
      limit,
      unit: "tokens",
      span: 86400,
    })
  }
  return {
    plan: PROVIDER_NAME,
    balance: `${credits} 积分`,
    windows,
  }
}

// ---- plugin -----------------------------------------------------------------

export const MonkeyCodeAuthPlugin = async () => {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER_ID] ?? {}
      cfg.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: ANTHROPIC_NPM,
        api: baseURL(),
        ...was,
        models: { ...modelsConfig(), ...(was.models ?? {}) },
      }
    },

    provider: {
      id: PROVIDER_ID,
      // Ask the console what each model costs and hand magpie the credit rate
      // so it shows a badge by the model. Without a console cookie (or when
      // the console prices a model nothing) the list comes back as it was, so
      // magpie shows no badge rather than a made-up one.
      async models(provider, { auth } = {}) {
        try {
          const cred = credentialOf(auth)
          const rates = await ratesFor(cred.cookie)
          if (!rates.size) return provider.models
          return withRates(provider.models ?? {}, rates)
        } catch {
          return provider.models
        }
      },
    },

    auth: {
      provider: PROVIDER_ID,
      single: true,

      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        const cred = credentialOf(auth)
        if (!cred.key) return {}
        if (!cred.secret) {
          // Without the signing secret no request can be accepted upstream.
          return {
            baseURL: cred.base || baseURL(),
            apiKey: cred.key,
            async fetch() {
              return new Response(
                JSON.stringify({
                  error: {
                    message:
                      "MonkeyCode 缺少 signing secret（omas_…）。请在 magpie 里重新登录并填入客户端 settings.json 里的签名密钥。",
                    type: "authentication_error",
                  },
                }),
                {
                  status: 401,
                  headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" },
                },
              )
            },
          }
        }

        const signature = signatureOf(cred.secret)

        return {
          baseURL: cred.base || baseURL(),
          apiKey: cred.key,
          headers: { "User-Agent": AGENT_UA },

          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input?.url ?? String(input)
            const method = init?.method ?? (input instanceof Request ? input.method : "POST")
            const responses = isResponsesURL(url)

            let bodyText = init?.body
            if (bodyText == null && input instanceof Request) bodyText = await input.clone().text()

            if (typeof bodyText === "string" && bodyText) {
              let body
              try {
                body = JSON.parse(bodyText)
              } catch {
                body = null
              }
              if (body && typeof body === "object") {
                bodyText = JSON.stringify(responses ? applyResponses(body) : applyAnthropic(body))
              }
            }

            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            headers.delete("content-length")
            headers.set("Content-Type", "application/json")
            headers.set("Accept", "application/json, text/event-stream")
            headers.set("User-Agent", AGENT_UA)
            headers.set("X-Api-Key", cred.key)
            headers.set("Authorization", `Bearer ${cred.key}`)
            headers.set("X-Ohmyagent-Signature", signature)
            if (responses) headers.delete("anthropic-version")
            else headers.set("Anthropic-Version", ANTHROPIC_VERSION)

            return fetch(url, { ...init, method, headers, body: bodyText })
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        const cred = credentialOf(auth)
        if (!cred.cookie) {
          return {
            plan: PROVIDER_NAME,
            error: "未保存控制台 Cookie，无法查询积分。重新登录时在第二个问题里填写 monkeycode_ai_session。",
            signIn: "kept",
          }
        }
        try {
          return { ...walletToUsage(await fetchWallet(cred.cookie)), signIn: "kept" }
        } catch (e) {
          const expired = e?.status === 401
          return {
            plan: PROVIDER_NAME,
            error: expired
              ? "控制台会话已过期：请在 magpie 里重新登录 MonkeyCode 并填入新的 Cookie。"
              : e?.message ?? String(e),
            signIn: "kept",
          }
        }
      },

      async checkin(getAuth) {
        const auth = await getAuth()
        const cred = credentialOf(auth)
        if (!cred.cookie) {
          return { outcome: "ineligible", message: "未保存控制台 Cookie，无法查询签到状态。" }
        }
        try {
          const { checkedIn } = await fetchCheckinState(cred.cookie)
          if (checkedIn) return { outcome: "done", message: "今日已签到" }
          return {
            outcome: "captcha",
            message: "MonkeyCode 签到需要人机验证，请在 monkeycode-ai.com 或官方客户端完成签到。",
          }
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e) }
        }
      },

      methods: [
        {
          type: "api",
          keyless: true,
          label: "读取本机 MonkeyCode 客户端登录态（推荐）",
          authorize: async () => {
            const cred = readLocalCredential()
            if (!cred) {
              return {
                type: "failed",
                error:
                  "没找到 MonkeyCode 客户端登录态。请先安装并登录 MonkeyCode 客户端，或改用手动填写。",
              }
            }
            return {
              type: "success",
              key: cred.key,
              metadata: {
                secret: cred.secret,
                ...(cred.cookie ? { cookie: cred.cookie } : {}),
                ...(cred.base ? { base: cred.base } : {}),
              },
            }
          },
        },
        {
          type: "api",
          label: "手动填写（oma_ key + omas_ 签名密钥）",
          placeholder: "oma_…",
          prompts: [
            {
              type: "password",
              key: "secret",
              message: "Signing secret（omas_…，来自客户端 settings.json）",
              placeholder: "omas_…",
              validate: (v) => (/^omas_/.test(String(v ?? "").trim()) ? undefined : "应以 omas_ 开头"),
            },
            {
              type: "password",
              key: "cookie",
              message: "控制台 Cookie（可选，用于查积分；没有就填 -）",
              placeholder: "monkeycode_ai_session 的值",
            },
          ],
        },
      ],
    },
  }
}

export const _internal = {
  SIGN_PROMPT,
  MODEL_IDS,
  RESPONSES_MODELS,
  bareModelID,
  upstreamModelID,
  labelOf,
  modelEntry,
  modelsConfig,
  fetchRates,
  ratesFor,
  withRates,
  RATE_BASE,
  signatureOf,
  credentialOf,
  normalizeCookie,
  settingsPaths,
  readCookieFile,
  readLocalCredential,
  applyAnthropic,
  applyResponses,
  isResponsesURL,
  walletToUsage,
  formatTokens,
}
