import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MonkeyCodeAuthPlugin, _internal as I } from "../index.mjs"

// A signature computed outside this code (python hmac) so the check does not
// agree with a bug in the plugin's own helper.
const GOLDEN_SIGNATURE =
  "v1=31ed07bab14f19261ab94811b3c62e51fc2f9d6573b71706f17da966c31ed468"

test("signature matches an independently computed HMAC", () => {
  assert.equal(I.signatureOf("omas_test"), GOLDEN_SIGNATURE)
})

test("signature is stable per secret and empty without one", () => {
  assert.equal(I.signatureOf("omas_test"), I.signatureOf("omas_test"))
  assert.equal(I.signatureOf(""), "")
  assert.notEqual(I.signatureOf("omas_test"), I.signatureOf("omas_other"))
})

test("model table covers the hosted list", () => {
  assert.equal(I.MODEL_IDS.length, 25)
  assert.equal(new Set(I.MODEL_IDS).size, 25)
  for (const id of I.RESPONSES_MODELS) assert.ok(I.MODEL_IDS.includes(id), id)
  assert.equal(I.RESPONSES_MODELS.size, 4)
})

test("upstream model ids carry the tier prefix only for tiered ids", () => {
  assert.equal(I.upstreamModelID("basic/deepseek-flash"), "monkeycode-basic/deepseek-flash")
  assert.equal(I.upstreamModelID("pro/gpt-5.6-terra"), "monkeycode-pro/gpt-5.6-terra")
  assert.equal(I.upstreamModelID("ultra/gpt-6-astra"), "monkeycode-ultra/gpt-6-astra")
  assert.equal(I.upstreamModelID("glm-5.1"), "glm-5.1")
  assert.equal(I.upstreamModelID("monkeycode/basic/qwen3.5-plus"), "monkeycode-basic/qwen3.5-plus")
  assert.equal(I.upstreamModelID("monkeycode-pro/kimi-k2.6"), "monkeycode-pro/kimi-k2.6")
})

test("model entries pick the Responses API where the vendor does", () => {
  const anthropic = I.modelEntry("basic/deepseek-flash")
  assert.equal(anthropic.id, "monkeycode-basic/deepseek-flash")
  assert.equal(anthropic.provider, undefined)
  assert.equal(anthropic.tool_call, true)
  assert.deepEqual(anthropic.limit, { context: 200000, output: 32000 })

  const responses = I.modelEntry("pro/gpt-5.6-terra")
  assert.deepEqual(responses.provider, { npm: "@ai-sdk/openai" })
  assert.equal(responses.name, "专业模型 5.6 terra")
})

test("anthropic body gets the signed system first", () => {
  const body = I.applyAnthropic({
    model: "monkeycode-basic/deepseek-flash",
    system: "You are Claude Code.",
    messages: [{ role: "user", content: "hi" }],
    metadata: { user_id: "x" },
  })
  assert.deepEqual(body.system, [
    { type: "text", text: I.SIGN_PROMPT },
    { type: "text", text: "You are Claude Code." },
  ])
  assert.equal(body.metadata, undefined)
  assert.equal(body.max_tokens, 16384)
})

test("anthropic body keeps block systems and is not double-signed", () => {
  const blocks = [
    { type: "text", text: "agent prompt", cache_control: { type: "ephemeral" } },
  ]
  const once = I.applyAnthropic({ system: blocks, max_tokens: 99999 })
  assert.deepEqual(once.system, [{ type: "text", text: I.SIGN_PROMPT }, ...blocks])
  assert.equal(once.max_tokens, 32000)

  const twice = I.applyAnthropic(once)
  assert.deepEqual(twice.system, once.system)
})

test("anthropic body without a system still signs", () => {
  const body = I.applyAnthropic({ messages: [] })
  assert.deepEqual(body.system, [{ type: "text", text: I.SIGN_PROMPT }])
})

test("responses body signs input[0] and moves instructions after it", () => {
  const body = I.applyResponses({
    model: "monkeycode-pro/gpt-5.6-terra",
    instructions: "You are Codex.",
    input: [
      { role: "developer", content: "dev rules" },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
    max_tokens: 500,
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "abc",
  })
  assert.equal(body.instructions, undefined)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.max_output_tokens, 500)
  assert.equal(body.store, undefined)
  assert.equal(body.include, undefined)
  assert.equal(body.prompt_cache_key, undefined)
  assert.equal(body.input[0].role, "system")
  assert.equal(body.input[0].content, I.SIGN_PROMPT)
  assert.deepEqual(body.input[1], { role: "system", content: "You are Codex." })
  assert.deepEqual(body.input[2], { role: "system", content: "dev rules" })
  assert.equal(body.input[3].role, "user")
})

test("responses body is not double-signed", () => {
  const once = I.applyResponses({ input: [{ role: "user", content: "hi" }] })
  const twice = I.applyResponses(structuredClone(once))
  assert.deepEqual(twice.input, once.input)
  assert.equal(twice.max_output_tokens, 16384)
})

test("responses url detection", () => {
  assert.equal(I.isResponsesURL("https://proxy.monkeycode-ai.com/v1/responses"), true)
  assert.equal(I.isResponsesURL("https://proxy.monkeycode-ai.com/v1/messages"), false)
  assert.equal(I.isResponsesURL("https://x/v1/responses?beta=1"), true)
})

test("credentials read from metadata, or from a colon-joined key", () => {
  assert.deepEqual(
    I.credentialOf({ type: "api", key: "oma_a", metadata: { secret: "omas_b", cookie: "c1" } }),
    { key: "oma_a", secret: "omas_b", cookie: "c1", base: "" },
  )
  assert.deepEqual(
    I.credentialOf({ type: "api", key: "oma_a:omas_b:c2" }),
    { key: "oma_a", secret: "omas_b", cookie: "c2", base: "" },
  )
  assert.equal(I.credentialOf({ type: "api", key: "Bearer oma_a" }).key, "oma_a")
  assert.equal(I.credentialOf({ type: "api", key: "oma_a", metadata: { base: "https://x/v1/" } }).base, "https://x/v1")
})

test("the official client's settings.json is read without writing to it", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-plugin-"))
  const bundle = join(root, "com.chaitin.baizhi.monkeycode")
  const configDir = join(bundle, "ohmyagent")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({
      signing_secret: "omas_local",
      models: {
        "monkeycode-pro/kimi-k2.6@monkeycode#1": {
          api_key: "oma_local",
          base_url: "https://proxy.monkeycode-ai.com/v1",
        },
      },
    }),
  )
  writeFileSync(
    join(bundle, "monkeycode-cookies.json"),
    JSON.stringify([
      { name: "other", value: "x", expires: "2099-01-01T00:00:00Z" },
      { name: "monkeycode_ai_session", value: "cookie_local", expires: "2099-01-01T00:00:00Z" },
    ]),
  )

  const previous = process.env.MONKEYCODE_CONFIG_DIR
  process.env.MONKEYCODE_CONFIG_DIR = configDir
  try {
    const cred = I.readLocalCredential()
    assert.equal(cred.key, "oma_local")
    assert.equal(cred.secret, "omas_local")
    assert.equal(cred.cookie, "cookie_local")
    assert.equal(cred.base, "https://proxy.monkeycode-ai.com/v1")

    const hooks = await MonkeyCodeAuthPlugin({})
    const first = hooks.auth.methods[0]
    assert.equal(first.keyless, true)
    const signed = await first.authorize()
    assert.equal(signed.type, "success")
    assert.equal(signed.key, "oma_local")
    assert.equal(signed.metadata.secret, "omas_local")
    assert.equal(signed.metadata.cookie, "cookie_local")
  } finally {
    if (previous === undefined) delete process.env.MONKEYCODE_CONFIG_DIR
    else process.env.MONKEYCODE_CONFIG_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test("an expired cookie in the client file is ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-plugin-"))
  const bundle = join(root, "bundle")
  const configDir = join(bundle, "ohmyagent")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(bundle, "monkeycode-cookies.json"),
    JSON.stringify([{ name: "monkeycode_ai_session", value: "stale", expires: "2000-01-01T00:00:00Z" }]),
  )
  const previous = process.env.MONKEYCODE_CONFIG_DIR
  process.env.MONKEYCODE_CONFIG_DIR = configDir
  try {
    assert.equal(I.readCookieFile(join(configDir, "settings.json"), "monkeycode_ai_session"), "")
  } finally {
    if (previous === undefined) delete process.env.MONKEYCODE_CONFIG_DIR
    else process.env.MONKEYCODE_CONFIG_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test("cookie normalisation accepts pasted headers", () => {
  assert.equal(I.normalizeCookie("abc123"), "abc123")
  assert.equal(I.normalizeCookie("monkeycode_ai_session=abc123"), "abc123")
  assert.equal(I.normalizeCookie("a=1; monkeycode_ai_session=abc123; b=2"), "abc123")
  assert.equal(I.normalizeCookie("-"), "")
  assert.equal(I.normalizeCookie(""), "")
})

test("wallet data becomes usage windows", () => {
  const usage = I.walletToUsage({ balance: 54487, daily_token_balance: 2500000, daily_token_limit: 10000000 })
  assert.equal(usage.balance, "55 积分")
  assert.equal(usage.windows.length, 1)
  assert.equal(usage.windows[0].amount, 7500000)
  assert.equal(usage.windows[0].limit, 10000000)
  assert.equal(usage.windows[0].used, 75)
  assert.equal(usage.windows[0].span, 86400)
})

test("loader sends signed requests with the vendor headers", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const opts = await hooks.auth.loader(async () => ({
    type: "api",
    key: "oma_test",
    metadata: { secret: "omas_test" },
  }))

  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init })
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    await opts.fetch("https://proxy.monkeycode-ai.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "monkeycode-basic/deepseek-flash",
        max_tokens: 1024,
        system: "You are Claude Code.",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    await opts.fetch("https://proxy.monkeycode-ai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "monkeycode-pro/gpt-5.6-terra",
        input: [{ role: "user", content: "hi" }],
      }),
    })
  } finally {
    globalThis.fetch = original
  }

  assert.equal(seen.length, 2)

  const anthropic = seen[0]
  assert.equal(anthropic.url, "https://proxy.monkeycode-ai.com/v1/messages")
  assert.equal(anthropic.init.headers.get("x-api-key"), "oma_test")
  assert.equal(anthropic.init.headers.get("x-ohmyagent-signature"), GOLDEN_SIGNATURE)
  assert.equal(anthropic.init.headers.get("user-agent"), "ohmyagent f6b21ad")
  assert.equal(anthropic.init.headers.get("anthropic-version"), "2023-06-01")
  const anthropicBody = JSON.parse(anthropic.init.body)
  assert.equal(anthropicBody.system[0].text, I.SIGN_PROMPT)
  assert.equal(anthropicBody.system[1].text, "You are Claude Code.")
  assert.equal(anthropicBody.max_tokens, 1024)

  const responses = seen[1]
  assert.equal(responses.init.headers.get("anthropic-version"), null)
  const responsesBody = JSON.parse(responses.init.body)
  assert.equal(responsesBody.input[0].content, I.SIGN_PROMPT)
  assert.equal(responsesBody.input[1].role, "user")
})

test("loader without a signing secret refuses instead of calling upstream", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "oma_test", metadata: {} }))
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    return new Response("{}")
  }
  try {
    const res = await opts.fetch("https://proxy.monkeycode-ai.com/v1/messages", { body: "{}" })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
    assert.equal(called, false)
  } finally {
    globalThis.fetch = original
  }
})

test("config hook declares the provider and every model", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider.monkeycode
  assert.equal(provider.npm, "@ai-sdk/anthropic")
  assert.equal(provider.api, "https://proxy.monkeycode-ai.com/v1")
  assert.equal(Object.keys(provider.models).length, 25)
  assert.equal(provider.models["basic/deepseek-flash"].id, "monkeycode-basic/deepseek-flash")
})

test("checkin says captcha rather than solving one", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 0, message: "success", data: { checked_in: false } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  try {
    const result = await hooks.auth.checkin(async () => ({
      type: "api",
      key: "oma_test",
      metadata: { secret: "omas_test", cookie: "c1" },
    }))
    assert.equal(result.outcome, "captcha")
  } finally {
    globalThis.fetch = original
  }
})

test("checkin reports an already claimed day as done", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 0, message: "success", data: { checked_in: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  try {
    const result = await hooks.auth.checkin(async () => ({
      type: "api",
      key: "oma_test",
      metadata: { secret: "omas_test", cookie: "c1" },
    }))
    assert.equal(result.outcome, "done")
  } finally {
    globalThis.fetch = original
  }
})

test("checkin without a cookie is ineligible", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const result = await hooks.auth.checkin(async () => ({ type: "api", key: "oma_test", metadata: { secret: "omas_test" } }))
  assert.equal(result.outcome, "ineligible")
})

test("console prices become the credit rate magpie shows", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: [
          { name: "monkeycode-basic/deepseek-flash", input_price: 200, is_hidden: false },
          { name: "qwen3.5-plus", input_price: 100, is_hidden: true },
          { name: "glm-5.1", input_price: 800, is_hidden: false },
          { name: "no-price" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  try {
    const { rates } = await I.fetchRates("cookie")
    assert.equal(rates.get("basic/deepseek-flash"), 1)
    assert.equal(rates.get("qwen3.5-plus"), 0.5)
    assert.equal(rates.get("glm-5.1"), 4)
    assert.equal(rates.get("no-price"), undefined)
  } finally {
    globalThis.fetch = original
  }
})

test("a console that answers badly leaves the rates alone", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response("{}", { status: 500 })
  try {
    const { rates, why } = await I.fetchRates("cookie")
    assert.equal(rates.size, 0)
    assert.match(why, /500/)
    const none = await I.fetchRates("")
    assert.equal(none.rates.size, 0)
  } finally {
    globalThis.fetch = original
  }
})

test("rates land on the models magpie lists, and only where priced", () => {
  const rates = new Map([
    ["basic/deepseek-flash", 1],
    ["glm-5.1", 4],
  ])
  const listed = {
    "basic/deepseek-flash": { name: "Basic · deepseek-flash" },
    "glm-5.1": { name: "glm-5.1" },
    "pro/hy3": { name: "Pro · hy3" },
  }
  const out = I.withRates(listed, rates)
  assert.equal(out["basic/deepseek-flash"].rate, 1)
  assert.equal(out["glm-5.1"].rate, 4)
  assert.equal(out["pro/hy3"].rate, undefined)
  assert.equal(out["pro/hy3"].name, "Pro · hy3")
  // Nothing to add: the list is handed back untouched.
  const same = { "basic/deepseek-flash": { name: "x" } }
  assert.equal(I.withRates(same, new Map()), same)
})

test("only the rate, never the model table's own shape, changes", () => {
  const entry = I.modelEntry("basic/deepseek-flash", 1)
  assert.equal(entry.rate, 1)
  assert.equal(entry.id, "monkeycode-basic/deepseek-flash")
  const bare = I.modelEntry("pro/hy3")
  assert.equal(bare.rate, undefined)
  // A rate of 0 must not become a badge showing 0x.
  assert.equal(I.modelEntry("pro/hy3", 0).rate, undefined)
})
