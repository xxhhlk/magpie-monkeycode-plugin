// Checks the three auth hooks against the real account, reading the host's
// saved login the same way magpie does. Runs the plugin straight from a
// directory, so it works before and after installing.
//
//   node verify/verify-hooks.mjs [plugin-dir]
//
// Nothing is written: usage and check-in only read the console, and the login
// is handed over in place.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const dir = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url))
// magpie keeps its config in $XDG_CONFIG_HOME/magpie, else ~/.config/magpie.
const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const authPath = process.env.MONKEYCODE_AUTH ?? join(configHome, "magpie", "plugin-auth.json")
const saved = JSON.parse(readFileSync(authPath, "utf8")).monkeycode
if (!saved) throw new Error(`no monkeycode login in ${authPath}`)

const { MonkeyCodeAuthPlugin } = await import(pathToFileURL(`${dir}/index.mjs`).href)
const plugin = await MonkeyCodeAuthPlugin({})
const getAuth = async () => saved

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`)
}

// ---- usage -----------------------------------------------------------------

try {
  const out = await plugin.auth.usage(getAuth)
  const hasNumber = Boolean(out.balance) || (Array.isArray(out.windows) && out.windows.length > 0)
  record("usage reports a number", !out.error && hasNumber, out.error || [out.balance, ...(out.windows ?? []).map((w) => w.display)].filter(Boolean).join(" · "))
  if (out.windows?.length) {
    const w = out.windows[0]
    const sane = Number.isFinite(w.used) && w.used >= 0 && Number.isFinite(w.limit) && w.limit > 0 && Number.isFinite(w.amount)
    record("usage window is well formed", sane, `used=${w.used.toFixed(2)}%, amount=${w.amount}, limit=${w.limit}, span=${w.span}`)
  }
  record("usage does not claim a sign-in failure", out.signIn !== "expired", `signIn=${out.signIn || "(absent)"}`)
} catch (error) {
  record("usage reports a number", false, String(error?.message ?? error))
}

// ---- check-in --------------------------------------------------------------

try {
  const out = await plugin.auth.checkin(getAuth)
  const allowed = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]
  record("check-in returns a documented outcome", allowed.includes(out?.outcome), `${out?.outcome} — ${out?.message ?? ""}`)
  // The vendor wants a captcha for an unclaimed day; a plugin must never solve
  // one, so this outcome is the expected and correct answer here.
  record("check-in never claims a captcha was solved", out?.outcome !== "claimed", `outcome=${out?.outcome}`)
} catch (error) {
  record("check-in returns a documented outcome", false, String(error?.message ?? error))
}

// ---- loader ----------------------------------------------------------------

try {
  const loader = await plugin.auth.loader(getAuth)
  record("loader hands back a base URL and key", Boolean(loader.baseURL) && Boolean(loader.apiKey), `${loader.baseURL} · key length ${String(loader.apiKey ?? "").length}`)

  // The signature is what the vendor gates on; a live ping proves the whole
  // header set is accepted, not just that it is sent.
  const ping = await loader.fetch(`${loader.baseURL}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      model: "monkeycode-basic/deepseek-flash",
      max_tokens: 16,
      stream: true,
      system: "ping",
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await ping.text()
  record("a signed request is accepted upstream", ping.status === 200, `HTTP ${ping.status}${ping.status === 200 ? "" : `: ${text.slice(0, 120)}`}`)

  // A wrong signature must be refused in the way the plugin's error handling
  // expects -- text "Forbidden"/"invalid ohmyagent request", not a JSON error
  // body that would read as a dead sign-in.
  const bad = await fetch(`${loader.baseURL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": loader.apiKey,
      "X-Ohmyagent-Signature": "v1=" + "0".repeat(64),
      "Anthropic-Version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "monkeycode-basic/deepseek-flash",
      max_tokens: 8,
      stream: true,
      system: [{ type: "text", text: "You are a helpful assistant." }],
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const badText = await bad.text()
  record("a wrong signature is refused with 403", bad.status === 403, `HTTP ${bad.status}: ${badText.slice(0, 80)}`)
} catch (error) {
  record("loader hands back a base URL and key", false, String(error?.message ?? error))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? "ALL PASSED" : `${failed.length} FAILED`}`)
// exitCode rather than exit(): Node on Windows asserts if a handle is still
// closing when the process is torn down.
process.exitCode = failed.length === 0 ? 0 : 1
