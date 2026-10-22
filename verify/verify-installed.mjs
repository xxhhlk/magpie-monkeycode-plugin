// Post-install check: run against the running magpie gateway, not the plugin
// directory. It answers the question that matters after installing -- can an
// agent talk to MonkeyCode through magpie, on both faces the vendor offers?
//
//   node verify/verify-installed.mjs [gateway] [anthropic-model] [responses-model]
//
// Every check is a normal user path; a failure here means the install is
// broken for that path and the plugin should be fixed or removed.
const GW = process.argv[2] ?? "http://127.0.0.1:3425"
const ANTH = process.argv[3] ?? "monkeycode/basic/deepseek-flash"
const RESP = process.argv[4] ?? "monkeycode/basic/qwen3.8-flash"
const KEY = process.env.MAGPIE_KEY ?? "magpie"

const post = (body) =>
  fetch(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}

const jsonOf = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const said = (body) => String(body?.choices?.[0]?.message?.content ?? "").trim()

// 1. The plugin loads and lists its models.
try {
  const res = await fetch(`${GW}/v1/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(20_000),
  })
  const ids = (await res.json()).data.map((m) => m.id)
  const mine = ids.filter((id) => id.startsWith("monkeycode/"))
  record("plugin loads and lists its models", mine.length > 0, `${mine.length} model(s), e.g. ${mine.slice(0, 3).join(", ")}`)
} catch (error) {
  record("plugin loads and lists its models", false, String(error?.message ?? error))
}

// 2. A plain reply over the Anthropic face.
try {
  const res = await post({ model: ANTH, messages: [{ role: "user", content: "只回复 PONG" }], max_tokens: 32 })
  const body = jsonOf(await res.text())
  const content = said(body)
  record("plain reply over the Messages face", res.status === 200 && content.includes("PONG"), `HTTP ${res.status}, content=${JSON.stringify(content.slice(0, 40))}`)
} catch (error) {
  record("plain reply over the Messages face", false, String(error?.message ?? error))
}

// 3. A plain reply over the Responses face. These models answer 404 on
// /messages, so this check is what proves the per-model routing works.
try {
  const res = await post({ model: RESP, messages: [{ role: "user", content: "只回复 PONG" }], max_tokens: 32 })
  const body = jsonOf(await res.text())
  const content = said(body)
  record("plain reply over the Responses face", res.status === 200 && content.includes("PONG"), `HTTP ${res.status}, content=${JSON.stringify(content.slice(0, 40))}`)
} catch (error) {
  record("plain reply over the Responses face", false, String(error?.message ?? error))
}

// 4. Streaming: one [DONE], no error frame.
for (const [label, model] of [["Messages", ANTH], ["Responses", RESP]]) {
  try {
    const res = await post({ model, messages: [{ role: "user", content: "只回复 OK" }], max_tokens: 32, stream: true })
    const text = await res.text()
    const done = (text.match(/data: \[DONE\]/g) ?? []).length
    const errored = /"error"/.test(text)
    record(`stream over ${label} ends with one [DONE], no error frame`, res.status === 200 && done === 1 && !errored, `HTTP ${res.status}, done=${done}, error=${errored}`)
  } catch (error) {
    record(`stream over ${label} ends with one [DONE], no error frame`, false, String(error?.message ?? error))
  }
}

// 5. A tool call comes back structured, with complete arguments.
try {
  const res = await post({
    model: ANTH,
    max_tokens: 300,
    messages: [
      { role: "system", content: "You are a coding agent. Use the tools you are given." },
      { role: "user", content: "Call the get_project_files tool now. Do not answer in text." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_project_files",
          description: "List the files in a directory",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
    tool_choice: "auto",
  })
  const body = jsonOf(await res.text())
  const calls = body?.choices?.[0]?.message?.tool_calls ?? []
  let argsOk = calls.length > 0
  for (const call of calls) {
    try {
      JSON.parse(call.function?.arguments ?? "")
    } catch {
      argsOk = false
    }
  }
  const leakedMarkup = String(body?.choices?.[0]?.message?.content ?? "").includes("<tool_call>")
  record("tool call is structured with complete arguments", res.status === 200 && argsOk && !leakedMarkup, `${calls.length} call(s): ${calls.map((c) => c.function?.name).join(", ")}`)
} catch (error) {
  record("tool call is structured with complete arguments", false, String(error?.message ?? error))
}

// 6. The agent's own system prompt still reaches the model. The plugin puts a
// fixed signed sentence first and moves the agent's prompt behind it; if that
// move dropped or reordered the prompt, the model answers something else.
try {
  const res = await post({
    model: ANTH,
    max_tokens: 24,
    messages: [
      { role: "system", content: "Reply with exactly the single word BANANA and nothing else." },
      { role: "user", content: "What is your favourite fruit?" },
    ],
  })
  const body = jsonOf(await res.text())
  const content = said(body)
  record("the agent's system prompt reaches the model", res.status === 200 && /BANANA/i.test(content), `content=${JSON.stringify(content.slice(0, 40))}`)
} catch (error) {
  record("the agent's system prompt reaches the model", false, String(error?.message ?? error))
}

// 7. A model the plugin does not serve is refused locally, and the refusal is
// not reported as a lapsed sign-in.
try {
  const res = await post({ model: "monkeycode/basic/definitely-not-a-model", messages: [{ role: "user", content: "hi" }], max_tokens: 8 })
  const signIn = res.headers.get("x-magpie-sign-in")
  record("unknown model is a request error, not a sign-in failure", res.status >= 400 && res.status < 500 && signIn !== "expired", `HTTP ${res.status}, X-Magpie-Sign-In=${signIn}`)
} catch (error) {
  record("unknown model is a request error, not a sign-in failure", false, String(error?.message ?? error))
}

// 8. A tier this account cannot use must not be painted as a dead sign-in,
// which would park a healthy account in cooldown. Whether the account holds
// the tier is not this check's business: an answer of 403 Forbidden with no
// sign-in header is the vendor refusing the tier, and it reads as SKIP.
try {
  const res = await post({ model: "monkeycode/ultra/gpt-6-astra", messages: [{ role: "user", content: "hi" }], max_tokens: 8 })
  const signIn = res.headers.get("x-magpie-sign-in")
  const ok = res.status === 200 || (res.status >= 400 && res.status < 500 && signIn !== "expired")
  const detail = `HTTP ${res.status}, X-Magpie-Sign-In=${signIn}`
  if (ok && res.status !== 200) record("an unreachable tier does not report a sign-in failure", true, `${detail} (the account has no ultra tier — expected)`)
  else record("an unreachable tier does not report a sign-in failure", ok, detail)
} catch (error) {
  record("an unreachable tier does not report a sign-in failure", false, String(error?.message ?? error))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? "ALL PASSED" : `${failed.length} FAILED — report these, do not roll back a working install`}`)
console.log(JSON.stringify({ at: new Date().toISOString(), gateway: GW, anthropic: ANTH, responses: RESP, passed: results.length - failed.length, failed: failed.length }, null, 2))
process.exitCode = failed.length === 0 ? 0 : 1
