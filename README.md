# MonkeyCode provider plugin for magpie / OpenCode

把 [MonkeyCode](https://monkeycode-ai.com)（长亭百智云，官方客户端 ohmyagent）的托管模型接进 magpie。
装上之后，Claude Code、Codex、OpenCode 等 Agent 都能选 `monkeycode/basic/…`、`monkeycode/pro/…`、`monkeycode/ultra/…`。

## 安装

```sh
magpie plugin add X:\github-repos\magpie-monkeycode-plugin
magpie plugin login monkeycode
magpie provider test monkeycode
magpie models | grep monkeycode
```

也可以在 magpie 窗口的「插件 › 发现 › 从文件夹添加」里选这个目录。插件就地加载，不装任何依赖。

## 登录

### 方式一：读取本机客户端登录态（推荐）

选「读取本机 MonkeyCode 客户端登录态」。插件只读下面这份配置，不改动它：

| 系统 | settings.json |
| --- | --- |
| Windows | `%APPDATA%\com.chaitin.baizhi.monkeycode\ohmyagent\settings.json` |
| macOS | `~/Library/Application Support/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json` |
| Linux | `~/.config/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json` |

`MONKEYCODE_CONFIG_DIR` 可以覆盖这个目录。控制台 Cookie 从同级的
`monkeycode-cookies.json` 里取（`monkeycode_ai_session`，过期就不用）。

### 方式二：手动填写

从同一份 `settings.json` 里取两个值：

- `signing_secret`：顶层字段，形如 `omas_…`
- `models` 里任意 `monkeycode-*` 条目的 `api_key`：形如 `oma_…`

第三个问题问控制台 Cookie，只用于查积分和签到状态，没有就填 `-`。

两把密钥是**不同的东西**：`oma_` 是请求身份，`omas_` 用来算请求签名，缺一个都发不出去。

## 模型

上游没有模型目录接口（`GET /models` 返回 405），所以模型表是静态的，取自官方客户端的托管清单：

| 档位 | 模型 |
| --- | --- |
| `basic/` | deepseek-flash、glm-5.3-flash、kimi-k2.5、minimax-m2.5、qwen3.5-plus、qwen3.8-flash |
| `pro/` | deepseek-flash、glm-5、hy3、kimi-k2.6、minimax-m3、qwen3.6-plus、gpt-5.6-terra |
| `ultra/` | glm-5.1、qwen3.7-max、gpt-5.6-sol、gpt-6-astra |
| 无档位 | deepseek-flash、glm-5.1、glm-5、kimi-k2.6、minimax-m2.5、minimax-m3、qwen3.6-plus、qwen3.7-max |

上下文 200K、输出上限 32K，全部支持工具调用。

四个模型走 OpenAI Responses 而不是 Anthropic Messages：`basic/qwen3.8-flash`、`pro/gpt-5.6-terra`、`ultra/gpt-5.6-sol`、`ultra/gpt-6-astra`。插件已经按模型切换，不用手动配。

## 请求是怎么发出去的

MonkeyCode 的托管端点收 Anthropic Messages 形状的请求，但要求每个请求带一枚签名头：

```
X-Ohmyagent-Signature: v1=hex(HMAC-SHA256(signing_secret, system[0].text))
```

它只校验签名和实际发出的内容对得上，不要求 system[0] 是官方那段提示词。
所以插件固定把 `You are a helpful assistant.` 放在 system 第一条，Agent 自己的系统提示词接在后面（后续条目不参与签名）。
Responses 面同理，签名对象换成 `input[0].content`。

另外两条请求头也照官方客户端设置：`User-Agent: ohmyagent f6b21ad`、`Anthropic-Version: 2023-06-01`（仅 Messages 面）。

## 用量与签到

「用量」里的积分和每日 Token 来自控制台钱包接口，需要控制台 Cookie：

- 积分余额：钱包 `balance` 除以 1000（与网页控制台一致）
- 每日 Token：当日已用 / 当日上限

控制台会话大约 6 天过期，过期后用量会提示重新登录，**不影响对话**（对话只用 `oma_` + `omas_`）。

签到：MonkeyCode 的签到要过 Cap.js 人机验证。按 magpie 的插件规范，插件不代解验证码，
所以这里只查今天签没签：已签显示「今日已签到」，未签提示去 monkeycode-ai.com 或官方客户端签到。

## 已知限制

- 上游没有模型目录接口，新模型上线要改 `MODEL_IDS` 后重新安装插件。
- 未知模型上游会静默回落到默认模型，插件因此只暴露清单里的模型。
- 控制台 Cookie 过期后积分/签到读不到，对话不受影响。
- 并发默认 4（`package.json` 的 `magpie.maxConcurrency`），需要更高可以改。

## 开发

```sh
node --test test/index.test.mjs
```

测试覆盖签名黄金向量（用 python hmac 独立算出）、模型映射、两套请求体的注入与去重、
凭据解析、客户端配置读取、钱包到用量的换算。`_internal` 导出这些纯函数供测试使用，
入口文件本身只导出插件函数。
