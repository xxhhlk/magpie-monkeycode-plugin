import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
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

// Official Cap.js golden vectors from wild-work/internal/monkeycode/captcha_test.go.
const CAP_GOLDEN = [
  {
    token: "abc",
    salts: [
      "a240feb00f42af1b0e9dab2bc4ea4c37",
      "88ca17aa8dd964158a2903b8e1948477",
      "79747a8032a433d22f1b1e1dd7cb9651",
      "65c1f9750701f44208bcb8466932c41c",
    ],
    targets: ["e6e", "b68", "01e", "198"],
    solutions: [11775, 6971, 310, 4613],
  },
  {
    token: "00112233445566778899aabbc",
    salts: [
      "b80c4c130048ae54a5c6b6351305d915",
      "42c1ff0ed920325e3218208bf7222a6f",
      "6a43c75a47b94fcea657a52e0cbbc6b7",
      "fb8b39d60a87464eab901a49b3f4aa85",
    ],
    targets: ["0b5", "b25", "731", "4a0"],
    solutions: [862, 2442, 3586, 1854],
  },
  {
    token: "zzz123",
    salts: [
      "e29d19037616627df16a7571474558f3",
      "13ba30afe050b57829060ee7f389cbca",
      "0ab99c3b1ee2f4244cacd6f71839e40e",
      "bb13314e7a6965b38d3af55ca1b28e14",
    ],
    targets: ["a0e", "4f8", "804", "dfe"],
    solutions: [345, 6144, 421, 4852],
  },
  {
    token: "tok-0",
    salts: [
      "493fa73f06db23b337032e450bbf4320",
      "30b9efc3a570a5038bc3208b1594db22",
      "1f326c4705ee065a6181bdc8912a4c54",
      "1db2a13b7b295bd15a392cf88b64764b",
    ],
    targets: ["30f", "553", "8dd", "f53"],
    solutions: [11647, 1866, 2349, 2645],
  },
]

test("Cap PRNG matches every official salt and target golden vector", () => {
  for (const g of CAP_GOLDEN) {
    for (let i = 0; i < g.salts.length; i++) {
      assert.equal(I.capPRNG(g.token + (i + 1), 32), g.salts[i], `${g.token} salt ${i + 1}`)
      assert.equal(I.capPRNG(g.token + (i + 1) + "d", 3), g.targets[i], `${g.token} target ${i + 1}`)
    }
  }
})

test("Cap solver matches every official minimum solution golden vector", async () => {
  for (const g of CAP_GOLDEN) {
    const solutions = await I.capSolve(g.token, 4, 32, 3)
    assert.deepEqual(solutions, g.solutions, g.token)
    for (let i = 0; i < solutions.length; i++) {
      const hash = createHash("sha256").update(g.salts[i] + solutions[i]).digest("hex")
      assert.ok(hash.startsWith(g.targets[i]), `${g.token} solution ${i + 1}`)
    }
  }
})

test("Cap solver rejects malformed and excessive challenge parameters", async () => {
  const invalid = [
    ["", 1, 32, 3],
    [null, 1, 32, 3],
    [123, 1, 32, 3],
    ["t", 0, 32, 3],
    ["t", -1, 32, 3],
    ["t", 1.5, 32, 3],
    ["t", "1", 32, 3],
    ["t", 101, 32, 3],
    ["t", Infinity, 32, 3],
    ["t", NaN, 32, 3],
    ["t", 1, 0, 3],
    ["t", 1, -1, 3],
    ["t", 1, 32.5, 3],
    ["t", 1, 129, 3],
    ["t", 1, 32, 0],
    ["t", 1, 32, -1],
    ["t", 1, 32, 1.5],
    ["t", 1, 32, 6],
    ["t", 1, 32, 65],
  ]
  for (const params of invalid) await assert.rejects(() => I.capSolve(...params), JSON.stringify(params))
})

test("Cap solver stops on an expired deadline or an aborted signal", async () => {
  await assert.rejects(() => I.capSolve("abc", 100, 128, 5, { deadline: Date.now() - 1 }))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => I.capSolve("abc", 100, 128, 5, { signal: controller.signal }))
})

test("Cap solver checks the deadline again after yielding during work", async () => {
  const original = Date.now
  const deadline = original() + 60000
  let checks = 0
  Date.now = () => (++checks >= 3 ? deadline : deadline - 1)
  try {
    await assert.rejects(() => I.capSolve("abc", 1, 32, 3, { deadline }))
    assert.equal(checks, 3)
  } finally {
    Date.now = original
  }
})

test("Cap solver rejects nonfinite and nonnumeric deadlines", async () => {
  for (const deadline of [Infinity, NaN, "2099-01-01", null]) {
    await assert.rejects(() => I.capSolve("abc", 1, 32, 3, { deadline }))
  }
})

test("Cap solver yields so cancellation can interrupt ongoing work", async () => {
  const controller = new AbortController()
  const cancel = setTimeout(() => controller.abort(), 0)
  try {
    await assert.rejects(() => I.capSolve("abc", 100, 128, 5, { signal: controller.signal }))
    assert.equal(controller.signal.aborted, true)
  } finally {
    clearTimeout(cancel)
  }
})

const checkinAuth = async () => ({
  type: "api",
  key: "oma_test",
  metadata: { secret: "omas_test", cookie: "checkin_test_cookie" },
})

function checkinResponses() {
  const expires = Date.now() + 60000
  return [
    { body: { code: 0, message: "success", data: { checked_in: false } } },
    { body: { challenge: { c: 1, s: 32, d: 1 }, expires, token: "abc" } },
    { body: { success: true, token: "test-id:test-verification", expires } },
    { body: { code: 0, message: "success", data: { checked_in: true } } },
  ]
}

function checkinMock(responses) {
  const calls = []
  return {
    calls,
    async fetch(url, init = {}) {
      const index = calls.length
      calls.push({
        path: new URL(url).pathname,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      })
      const response = responses[index]
      if (!response) throw new Error("Unexpected extra checkin request")
      return new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  }
}

test("checkin solves and redeems Cap before claiming through all four requests", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const responses = checkinResponses()
  responses[1].body.challenge = { c: 4, s: 32, d: 3 }
  const mock = checkinMock(responses)
  const original = globalThis.fetch
  globalThis.fetch = mock.fetch
  try {
    const result = await hooks.auth.checkin(checkinAuth)
    assert.equal(result.outcome, "claimed")
    assert.equal(Object.hasOwn(result, "credit"), false)
    assert.deepEqual(mock.calls.map(({ method, path }) => [method, path]), [
      ["GET", "/api/v1/users/wallet/checkin"],
      ["POST", "/api/v1/public/captcha/challenge"],
      ["POST", "/api/v1/public/captcha/redeem"],
      ["POST", "/api/v1/users/wallet/checkin"],
    ])
    assert.equal(mock.calls[0].body, undefined)
    assert.deepEqual(mock.calls[1].body, {})
    assert.deepEqual(mock.calls[2].body, { token: "abc", solutions: CAP_GOLDEN[0].solutions })
    assert.deepEqual(mock.calls[3].body, { captcha_token: "test-id:test-verification" })
    for (const call of mock.calls) {
      assert.equal(call.headers.get("cookie"), "monkeycode_ai_session=checkin_test_cookie")
      assert.equal(call.headers.get("accept"), "application/json")
      if (call.method === "POST") assert.equal(call.headers.get("content-type"), "application/json")
    }
  } finally {
    globalThis.fetch = original
  }
})

test("checkin reports an already claimed day as done after only one GET", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const mock = checkinMock([{ body: { code: 0, message: "success", data: { checked_in: true } } }])
  const original = globalThis.fetch
  globalThis.fetch = mock.fetch
  try {
    const result = await hooks.auth.checkin(checkinAuth)
    assert.equal(result.outcome, "done")
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].method, "GET")
    assert.equal(mock.calls[0].path, "/api/v1/users/wallet/checkin")
  } finally {
    globalThis.fetch = original
  }
})

test("checkin without a cookie is ineligible and never fetches", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error("A missing cookie must not trigger a network request")
  }
  try {
    const result = await hooks.auth.checkin(async () => ({ type: "api", key: "oma_test", metadata: { secret: "omas_test" } }))
    assert.equal(result.outcome, "ineligible")
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test("checkin fails at each stage on HTTP 401, 429 and server errors", async (t) => {
  for (let stage = 0; stage < 4; stage++) {
    for (const status of [401, 429, 500]) {
      await t.test(`stage ${stage + 1}, HTTP ${status}`, async () => {
        const hooks = await MonkeyCodeAuthPlugin({})
        const responses = checkinResponses()
        responses[stage] = { status, body: { message: "Test error" } }
        const mock = checkinMock(responses)
        const original = globalThis.fetch
        globalThis.fetch = mock.fetch
        try {
          const result = await hooks.auth.checkin(checkinAuth)
          assert.equal(result.outcome, "failed")
          assert.equal(mock.calls.length, stage + 1)
        } finally {
          globalThis.fetch = original
        }
      })
    }
  }
})

test("checkin rejects malformed and unsuccessful protocol replies", async (t) => {
  const cases = [
    ["state code", 0, { code: 10701, data: { checked_in: false } }],
    ["state string code", 0, { code: "0", data: { checked_in: false } }],
    ["state null code", 0, { code: null, data: { checked_in: false } }],
    ["state missing code", 0, { data: { checked_in: false } }],
    ["state missing checked_in", 0, { code: 0, data: {} }],
    ["state nonboolean checked_in", 0, { code: 0, data: { checked_in: "false" } }],
    ["challenge missing token", 1, { challenge: { c: 1, s: 32, d: 1 } }],
    ["challenge missing parameters", 1, { token: "abc" }],
    ["challenge excessive work", 1, { token: "abc", challenge: { c: 101, s: 32, d: 3 } }],
    ["redeem rejected", 2, { success: false, token: "test-id:test-verification" }],
    ["redeem missing token", 2, { success: true }],
    ["redeem empty token", 2, { success: true, token: "" }],
    ["redeem missing success", 2, { token: "test-id:test-verification" }],
    ["claim code", 3, { code: 10701, data: { checked_in: true } }],
    ["claim string code", 3, { code: "0", data: { checked_in: true } }],
    ["claim null code", 3, { code: null, data: { checked_in: true } }],
    ["claim missing code", 3, { data: { checked_in: true } }],
    ["claim false checked_in", 3, { code: 0, data: { checked_in: false } }],
    ["claim missing checked_in", 3, { code: 0, data: {} }],
    ["claim nonboolean checked_in", 3, { code: 0, data: { checked_in: "true" } }],
  ]
  for (const [name, stage, body] of cases) {
    await t.test(name, async () => {
      const hooks = await MonkeyCodeAuthPlugin({})
      const responses = checkinResponses()
      responses[stage] = { body }
      const mock = checkinMock(responses)
      const original = globalThis.fetch
      globalThis.fetch = mock.fetch
      try {
        const result = await hooks.auth.checkin(checkinAuth)
        assert.equal(result.outcome, "failed")
        assert.equal(mock.calls.length, stage + 1)
      } finally {
        globalThis.fetch = original
      }
    })
  }
})

test("checkin rejects expired or malformed challenge expiry before redeeming", async (t) => {
  const now = Date.now()
  const cases = [
    ["expired", now - 1],
    ["seconds instead of milliseconds", Math.floor(now / 1000) + 60],
    ["string", String(now + 60000)],
    ["null", null],
  ]
  for (const [name, expires] of cases) {
    await t.test(name, async () => {
      const hooks = await MonkeyCodeAuthPlugin({})
      const responses = checkinResponses()
      responses[1].body.expires = expires
      const mock = checkinMock(responses)
      const original = globalThis.fetch
      globalThis.fetch = mock.fetch
      try {
        assert.equal((await hooks.auth.checkin(checkinAuth)).outcome, "failed")
        assert.equal(mock.calls.length, 2)
      } finally {
        globalThis.fetch = original
      }
    })
  }
})

test("checkin rejects an expired redeemed token before claiming", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const responses = checkinResponses()
  responses[2].body.expires = Date.now() - 1
  const mock = checkinMock(responses)
  const original = globalThis.fetch
  globalThis.fetch = mock.fetch
  try {
    assert.equal((await hooks.auth.checkin(checkinAuth)).outcome, "failed")
    assert.deepEqual(mock.calls.map(({ method, path }) => [method, path]), [
      ["GET", "/api/v1/users/wallet/checkin"],
      ["POST", "/api/v1/public/captcha/challenge"],
      ["POST", "/api/v1/public/captcha/redeem"],
    ])
  } finally {
    globalThis.fetch = original
  }
})

test("checkin accepts a challenge without an optional expiry", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const responses = checkinResponses()
  delete responses[1].body.expires
  const mock = checkinMock(responses)
  const original = globalThis.fetch
  globalThis.fetch = mock.fetch
  try {
    assert.equal((await hooks.auth.checkin(checkinAuth)).outcome, "claimed")
    assert.equal(mock.calls.length, 4)
  } finally {
    globalThis.fetch = original
  }
})

test("simultaneous checkins for the same cookie share one complete flow", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const mock = checkinMock(checkinResponses())
  const original = globalThis.fetch
  let release
  const pending = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url, init) => {
    await pending
    return mock.fetch(url, init)
  }
  try {
    const first = hooks.auth.checkin(checkinAuth)
    const second = hooks.auth.checkin(checkinAuth)
    release()
    const results = await Promise.all([first, second])
    assert.deepEqual(results.map((result) => result.outcome), ["claimed", "claimed"])
    assert.equal(mock.calls.length, 4)
  } finally {
    release()
    globalThis.fetch = original
  }
})

test("a failed checkin can retry the entire flow with the same cookie", async () => {
  const hooks = await MonkeyCodeAuthPlugin({})
  const mock = checkinMock([
    { status: 500, body: { message: "Temporary test failure" } },
    ...checkinResponses(),
  ])
  const original = globalThis.fetch
  globalThis.fetch = mock.fetch
  try {
    assert.equal((await hooks.auth.checkin(checkinAuth)).outcome, "failed")
    assert.equal((await hooks.auth.checkin(checkinAuth)).outcome, "claimed")
    assert.equal(mock.calls.length, 5)
    assert.equal(mock.calls[1].method, "GET")
  } finally {
    globalThis.fetch = original
  }
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
