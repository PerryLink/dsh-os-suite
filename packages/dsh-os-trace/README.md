# dsh-os-trace

> **Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.** Apache-2.0. No SLA, no warranty.


> 给 DSH Agent 运行提供**因果审计**与**防篡改证据包**：把 run 里发生的事连成父子链，记录 SHA-256 哈希链，并能导出、脱敏、校验。
>
> Causal audit and tamper-evident evidence bundles for DSH agent runs.

**状态：源码在 0.2.1 基础上加入实时事件采集、HMAC 签名与 OTLP/JSON 导入导出（尚未发布到 npm；npm 上的 0.2.1 不含这些能力）。** 社区项目，非 DeepSeek 官方项目，Apache-2.0，无 SLA。

## 为什么

DSH 的 session 日志能回答「发生过什么」，但很难直接回答下面这些问题。**DSH 目前缺少面向用户的因果审计与证据链层**，日志本身不提供跨 tool/subagent/job 的因果图，也不提供可校验的导出格式：

1. **为什么这个结果会出现？** 一次回答可能来自 tool → subagent → MCP → job 的六七层嵌套。日志按时间平铺，父子关系要靠人从事件顺序里猜。
2. **是谁触发的？** 同一 session 里并行跑了多个 subagent / 后台 job，只看时间戳分不清哪条因果链属于谁。
3. **审计时如何证明没被改过？** 导出一份 JSON 交给别人，对方无法判断某条记录是否被删改、重排或拼接。
4. **分享时如何不泄露密钥？** `attrs` 里经常带 API key、token、请求头；直接导出等于泄密。

`dsh-os-trace` 在**用户级**补这一层：默认订阅 DSH 的 tool / approval / agent / subagent / job / MCP / session 事件，以 span 为最小事件沿 `parentId` 组成因果图；结束的 span 进入一条 SHA-256 哈希链；导出时可按字段名递归脱敏并重新封链，也可用 HMAC-SHA256 签名；校验时返回第一个坏掉的 span。它不替换 DSH 日志，也不接 OTel 采集；它是日志之上的一层**可解释 + 可验证**视图，并额外提供 **OTLP/JSON 的离线导入/导出**（见下文）。

## 安装

要求 Node.js 24+、DSH `>=0.2.2-rc.3 <0.3.0`。纯 ESM JavaScript + JSDoc，无构建步骤。

npm 发布后：

```sh
dsh plugin --profile <your-profile> add dsh-os-trace
dsh --profile <your-profile>
```

从本仓库本地安装（当前可用）：

```sh
cd 04-build/dsh-os-suite
npm install

dsh plugin --profile <your-profile> add ./packages/dsh-os-trace
dsh --profile <your-profile> --dump-config   # 应出现 "# == dsh-os-trace" 层
```

移除：

```sh
dsh plugin --profile <your-profile> remove dsh-os-trace
```

### 数据从哪来

默认同时启用**实时采集**与两种只读种子输入：

```yaml
# 在 profile / patch 叠加层的 dsh-os-trace 条目上传入（示意）
- id: dsh-os-trace
  name: dsh-os-trace
  config:
    ingest: true                              # 默认 true；false 只保留种子输入
    dataFile: /absolute/path/to/spans.jsonl   # 每行一个 span JSON
```

- **实时采集（默认）**：`apply()` 时用 `ctx.on(...)` 订阅 DSH 事件，把事件映射为 span。设置 `ingest: false` 可关闭。
- `dataFile`：启动时读取一次的 JSONL 快照；坏行会让插件加载失败，而不是静默丢数据。
- `config.spans`：程序化注入的 span 数组，主要供嵌入和测试使用。

实时订阅的事件（具体名称随 DSH 版本而异，未知事件一律忽略、不抛错）：

| 来源 | 映射结果 |
|---|---|
| `session/event` | `tool/call`、`tool/result`、`approval/asked`、`approval/decided`、`job/registered`、`job/settled`、`turn/*`、`step/*` → `tool` / `approval` / `job` / `session` span |
| `tools/pre-execute`、`tools/post-execute` | 按 `callId` 配对的 tool 生命周期；工具名以 `mcp__` 开头时记作 `mcp` |
| `tool/result`、`tools/result` | 直接观察到的工具结果（与 post-execute 去重） |
| `approval/*` | `approval/request`、`approval/asked`、`approval/decided` 等 |
| `agent/*` | `agent/created`、`agent/status`、`agent/error`、`agent/disposed` → `session` span |
| `subagent/*` | `subagent/start` / `subagent/end` → `subagent` span |
| `job/*` | `job/registered` / `job/settled` → `job` span |
| `mcp/*` | MCP 生命周期事件 → `mcp` span；MCP 工具调用按 `mcp__<server>__<tool>` 命名识别 |

配对与去重规则：

- tool 按 `callId` 配对 pre/post；approval 优先按 `id`/`callId`，二者都没有时才退回 `toolName`（同一工具的并发审批可能无法区分）；subagent 按 `runId`；job 按 `jobId`。
- 重复投递按稳定 id 幂等：同一个结束事件不会产生第二条 span，也不会重复进入哈希链。
- **只有结束事件才进入哈希链**。只有 start 没有 end 的调用保留在采集器的实时视图里，`status: "running"`，由 `trace_live_status` 计数；这是 append-only 链无法回改已写入 span 的直接结果。
- 采集只记录结构化字段（id、工具名、状态、错误码等），**不记录工具参数、消息正文或自由文本原因**，避免证据包静默变成密钥/隐私收集器。

Cordis 事件总线没有通配符派发：本包会把 `approval/*` 等模式名注册给支持通配符的宿主，同时枚举当前 DSH 的已知具体事件名，并用 `internal/dispatch` 作为未知家族事件的最佳努力兜底。

## 五个工具

所有工具只读内存 store 与采集器状态，返回结构化 JSON；不会写文件、不会联网。工具参数由 DSH 在调用前校验。离线 CLI（`trace_export` / `trace_import`）是独立入口，见「OTLP/JSON 互操作」。

### `trace_query`

按条件查询已经进入 store 的 span，按 `startMs` 升序返回（`order: "desc"` 可反转）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 精确 span id |
| `sessionId` | 否 | 精确 DSH session id |
| `parentId` | 否 | 精确父 span id |
| `agentPath` | 否 | 精确 agent path |
| `kind` | 否 | 单个事件类别：`tool` / `subagent` / `job` / `approval` / `mcp` / `session` / `workflow` |
| `status` | 否 | 单个状态：`ok` / `error` / `running` |
| `name` | 否 | 精确操作名 |
| `since` / `until` | 否 | 按 `startMs` 过滤（含边界） |
| `limit` | 否 | 排序后最多返回多少条 |
| `order` | 否 | `asc`（默认）或 `desc` |

返回 `{ count, spans }`。空 store 返回 `{ count: 0, spans: [] }`。查询结果是深拷贝，修改返回值不会影响 store。

### `trace_why`

解释一条 span 的因果上下文：沿 `parentId` 向上、沿子节点向下各走最多 `depth` 跳。

| 参数 | 必填 | 说明 |
|---|---|---|
| `eventId` | 是 | 要解释的 span id |
| `depth` | 否 | 每个方向的跳数，默认 `4`，上限 `64` |

返回：

```json
{
  "eventId": "tool-1",
  "found": true,
  "target": { "id": "tool-1" },
  "depth": 4,
  "spans": [],
  "edges": [{ "parentId": "root", "childId": "tool-1" }],
  "missing": [],
  "truncated": false
}
```

- `found: false` 且 `missing: ["<eventId>"]`：目标本身不在 store 里。
- `missing` 里出现别的 id：父节点被引用但不存在；不会把它伪装成 root。
- `truncated: true`：`depth` 截断了一条更长的链；结果只是局部证据。

### `trace_export`

把当前 store 导出为证据包（bundle）。**不写文件**，bundle 作为工具结果返回，由调用方决定落盘或传输。

| 参数 | 必填 | 说明 |
|---|---|---|
| `redact` | 否 | 要递归替换的对象字段名数组，大小写不敏感，例如 `["apiKey","token"]` |
| `sign` | 否 | `true` 时给 bundle 附加 HMAC-SHA256 签名；密钥取 `config.secret` 或 `TESTATUM_KEY` |

返回 bundle：`format`、`version`、`hashAlgo`、`exportedAt`、`spanCount`、`rootHash`、`sourceRootHash`、`genesisPrevHash`、`redaction`、`spans`；`sign: true` 时另有 `signature: { alg: "hmac-sha256", sig }`。

- 不传 `redact`：保留 store 中的原始哈希链，`rootHash === sourceRootHash`。
- 传 `redact`：所有匹配字段（任意层级、含数组内元素）替换为字符串 `"[redacted]"`，然后**重新计算整条链**，让校验针对脱敏后的字节。`sourceRootHash` 记录脱敏前的链尾哈希，但它只是元数据，不能代替原 bundle 的密码学证明。
- 脱敏只按**字段名**匹配，不扫描字符串内容。把 key 放在 `attrs` 的任意嵌套对象里都能命中；拼在普通字符串里则不会。
- **不要 redact span 的结构字段**（`id`、`parentId`、`kind`、`status`、`startMs`、`attrs` 等）。它们被替换成字符串会破坏类型/因果引用；敏感信息应放在 `attrs` 的键里。当前版本没有结构字段保留规则，调用方需自行避免。
- `sign: true` 时，签名覆盖脱敏后的完整 bundle（含 `signature` 之外的元数据）。密钥缺失会返回 `SIGNING_KEY_MISSING`，错误信息与工具输出都不会包含密钥值。建议用环境变量而不是 `config.secret`，因为 `--dump-config` 可能打印 profile 配置。

### `trace_verify`

校验 bundle 的 SHA-256 哈希链和 `rootHash`。接受 bundle 对象或它的 JSON 文本。

| 参数 | 必填 | 说明 |
|---|---|---|
| `bundle` | 是 | `trace_export` 返回的 bundle 对象，或序列化后的 JSON 字符串 |

返回 `{ ok, count, checked, rootHash, firstBad }`：

- `ok: true`：每条 span 的 `prevHash` 与前一条的 `hash` 一致，每条 `hash` 重算一致，`rootHash` 与链尾一致。
- `ok: false`：`firstBad = { index, id, reason, expected?, actual? }`。`index` 从 0 开始；`-1` 表示 bundle 级问题（格式、版本、`spans` 不是数组、`spanCount` 不符）。失败时顶层 `rootHash` 为 `null`，计算出的链尾哈希在 `firstBad.expected` 里（如果是哈希/根不匹配）。
- 能发现：改字段、改 `hash`、重排 span、删掉尾部但没同步 `rootHash`/`spanCount`、把一条链嫁接到另一条链、坏 JSON 结构。
- **不能发现**：攻击者拿到整个 bundle 后重算全部哈希并重写 `rootHash`。`trace_verify` 只校验哈希链，不校验 HMAC；要验签请在代码中调用本包导出的 `verifySignedBundle(signed, secret)`（缺省读 `TESTATUM_KEY`）。HMAC 也不是身份凭证或透明日志（见「限制」）。

### `trace_live_status`

无参数。返回实时采集器的状态，不返回 span 内容或密钥：

```json
{
  "attached": true,
  "subscriptions": 36,
  "subscribed": ["session/event", "tools/pre-execute", "..."],
  "wildcard": true,
  "events": 12,
  "mapped": 10,
  "ignored": 2,
  "errors": 0,
  "finalized": 8,
  "running": 2,
  "failed": 0,
  "lastEventAt": 1700000000000,
  "lastError": null,
  "eventsByName": [{ "name": "tools/pre-execute", "count": 4 }]
}
```

- `attached`：是否成功安装事件钩子（`ctx.on` 不可用时为 `false`，插件仍可只用种子输入）。
- `running`：只有 start、还没等到 end 的 span；它们**不在**哈希链里。
- `finalized`：已 ingest 进 store 的结束 span；`failed`：被 store 拒绝的终态 span（例如 id 冲突）。
- `ignored`：未知或无法映射的事件；`errors`：采集器内部错误，永远不会抛给 agent 主循环。
- `wildcard`：是否成功安装 `internal/dispatch` 家族兜底钩子。

## OTLP/JSON 互操作（离线导入/导出）

本包提供**离线**的 OTLP/JSON 互操作：`src/otlp.js` 在现有 span 形状与 OTLP trace JSON 之间转换，CLI 可直接转文件。它**不是** OTLP SDK/Collector：不走 gRPC、不处理 protobuf、不接 OpenTelemetry SDK、不做自动上报，也不传播 W3C trace context；只处理单个 OTLP/JSON 文档的 trace 部分（`resourceSpans[].scopeSpans[].spans[]`）。

### 代码 API

```js
import { toOtlp, fromOtlp } from 'dsh-os-trace/otlp'

const otlp = toOtlp(store.query(), { serviceName: 'my-dsh' })
const spanInputs = fromOtlp(otlp)   // 可直接交给 store.ingest()
const fromText = fromOtlp(fs.readFileSync('traces.json', 'utf8'))
```

- `toOtlp(spans, { serviceName = 'dsh' })`：输出一条 `resourceSpans`；`resource.attributes` 只有 `service.name`，`scopeSpans[0].scope.name` 为 `"dsh-os-trace"`。
- `fromOtlp(json)`：接受对象或 JSON 文本，返回现有 span 输入数组；不返回 `hash`/`prevHash`，由 `createTraceStore().ingest()` 重新封链。坏 JSON / 坏外层结构抛 `INVALID_OTLP`。
- 包主入口也 re-export 了 `toOtlp` / `fromOtlp`。

### 字段映射

| DSH span | OTLP span |
|---|---|
| `id` | `spanId = sha256(id)` 前 8 字节（16 hex）；原 id 存入 `dsh.span.id` |
| `parentId` | `parentSpanId = sha256(parentId)` 前 8 字节；原 parentId 存入 `dsh.span.parent_id` |
| `sessionId` | `traceId = sha256(sessionId)` 前 16 字节（32 hex）；无 sessionId 时改用根 span id；原值存入 `dsh.span.session_id` |
| `kind` | `SPAN_KIND_INTERNAL`；原值存入 `dsh.span.kind` |
| `name` | `name` |
| `startMs` / `endMs` | `startTimeUnixNano` / `endTimeUnixNano`，`毫秒 × 1e6` 的十进制字符串；无 `endMs` 时不写 |
| `status` | `ok`/`running` → `status.code: 1`，`error` → `2`；`running` 的原值另存 `dsh.span.status` |
| `attrs` | `attributes`；字符串/布尔/安全整数/浮点分别用 `stringValue`/`boolValue`/`intValue`/`doubleValue`，数组/对象用 `arrayValue`/`kvlistValue` |
| `agentPath` | `dsh.span.agent_path` |
| `hash` / `prevHash` | 不导出；OTLP 没有等价链 |

- `dsh.span.*` 是保留属性命名空间；导入时这些键会从 `attrs` 中剔除。用户 attrs 不应使用该前缀。
- 本包自己导出的 span 可以 round-trip 回 id、parent、status、kind、agentPath、attrs 与时间，前提是保留 `dsh.span.*` 元数据；`null`/`undefined` attrs 不写入（OTLP 没有 null AnyValue）。
- 外部 OTLP 的缺省：没有 `dsh.span.*` 时 `id = spanId`、`sessionId = traceId`、`kind = "workflow"`、`name = "unnamed"`、缺失时间为 0；无 end 且 status code 为 0 视为 `running`，code 2 为 `error`，其余为 `ok`。
- 外部的未知 span attributes 尽量保留到 `attrs`（含嵌套 AnyValue；`bytesValue` 保留为 base64 字符串）。
- **字段损失**：OTLP 没有本包的哈希链/HMAC 签名、DSH `kind`、`agentPath`（除非用保留属性）、除 `service.name` 外的资源属性、span links/events、W3C traceState；外部 span 的 OTLP `kind`/`status.message` 不映射；外部 `traceId` 也不原样保留（导入后仅作为缺省 `sessionId`，再导出会按本包规则重新派生）。导入后重新封链，所以不能把导入 span 的 `hash` 当作 OTLP 来源的证据。
- **不处理**：OTLP/gRPC、protobuf、OTLP metrics/logs、OTel SDK/Collector、自动上报、W3C trace context 注入/提取。

### CLI

包内 `src/cli.js` 提供离线转换（安装后命令名为 `dsh-os-trace`）：

```sh
# 默认仍输出本包 v1 bundle
dsh-os-trace trace_export spans.json > bundle.json

# 导出 OTLP/JSON（stdout；也可 --out traces.json）
dsh-os-trace trace_export bundle.json --format otlp > traces.json

# 读入 OTLP/JSON，重新封链并输出 v1 bundle
dsh-os-trace trace_import traces.json --format otlp --out bundle.json

# 从 stdin 读
cat spans.jsonl | dsh-os-trace trace_export --format otlp
```

- `trace_export` 自动接受 v1 bundle、OTLP/JSON、span 数组或 JSONL；`--format` 选**输出**格式，默认 `bundle`（仍输出 v1 证据包）。
- `trace_import` 的 `--format` 选**输入**格式，默认 `bundle`（bundle 输入会先校验哈希链）；导入总是输出重新封链的 v1 bundle，不保留输入 bundle 的 `signature`。
- 输入为空时输出空导出；坏 JSON / 坏 span 以退出码 2 失败，不打印堆栈。`--out` 是唯一的写文件路径。

## 证据格式

每个 span 的哈希按下面的确定性规则计算：

```text
payload = canonicalJson(span 去掉 hash 字段，仍包含 prevHash)
hash    = sha256(prevHash + payload)
```

- `canonicalJson`：对象 key 递归排序、无多余空白；不支持非有限数字、BigInt、循环引用。
- 第一条 span 的 `prevHash` 是 64 个 `0`（`GENESIS_PREV_HASH`），其后每条 span 的 `prevHash` 等于上一条的 `hash`。
- 链的顺序是 **ingest 顺序**，不是 `startMs` 顺序。一个 store 只有一条全局链，跨 session 交错也按实际接入顺序串起来。
- `spanCount`、`rootHash`、`format`、`version`、`genesisPrevHash` 会被校验；`exportedAt`、`sourceRootHash`、`hashAlgo`、`redaction` 目前是**未封链的元数据**，不要把它们当作独立证据。

### 签名（`sign: true`）

`trace_export({ sign: true })` 会在 bundle 上加一个 `signature` 字段：

```text
payload = canonicalJson(bundle 去掉 signature 字段)
sig     = HMAC-SHA256(secret, payload)      # 64 位小写十六进制
signature = { "alg": "hmac-sha256", "sig": sig }
```

- 这与 `testatum-attest` v1 的 `signaturePayload()` 约定一致：对象 key 递归排序、无多余空白、不把 `signature` 自身纳入载荷。带 `schema: "testatum/v1"` 的对象可用同一套 `signBundle` / `verifySignedBundle` 处理。
- 密钥来自 `config.secret`，否则 `TESTATUM_KEY`；密钥不会出现在工具输出、bundle、错误信息或日志中。
- `verifySignedBundle(signed)` 缺省从 `TESTATUM_KEY` 取密钥；也可显式传第二参数。校验失败返回 `{ ok: false, reason }`（`signature-missing` / `signature-malformed` / `signature-mismatch` / `secret-missing` 等），不会抛错。
- 签名覆盖除 `signature` 外的**全部**字段，包括 `exportedAt` 和脱敏元数据；因此改任何字段都会让签名失配。但 HMAC 仍是共享密钥 MAC，不是透明日志，也不证明签发者身份。

## 权限与数据

- **只读会话数据。** 实时采集只订阅 DSH 事件总线（含 `internal/dispatch` 家族兜底观察钩子），不修改、不删除任何 session 数据；种子输入只读取 `dataFile` 或 `config.spans`。
- **插件工具不写文件。** store 是进程内 Map；五个 DSH 工具只返回对象，不落盘。离线 CLI 仅在显式传 `--out` 时写 JSON（stdout 是默认输出）。DSH 退出即丢失，除非调用方自己保存返回的 JSON。
- **不联网、不启子进程。** 没有 HTTP 客户端、shell 或进程管理。唯一接触文件系统的地方是启动时读取 `dataFile`。
- **只在签名时读一个密钥。** `trace_export sign:true` 从 `config.secret` 或 `TESTATUM_KEY` 读取 HMAC 密钥；不落盘、不打印、不写入 bundle 或错误信息。不做身份验证、不读取其他凭据。
- **无鉴权。** 能调用这五个工具的 agent 就能读取 store 里的全部 span；工具层权限由 DSH 的 tool policy 负责，本包不额外区分租户。
- **数据字段**：session id、agent path、事件名、起止时间、状态、结构化 `attrs`、哈希。实时采集不抓工具参数/消息正文；调用方注入的 `attrs` 可能含敏感信息，导出前请显式传 `redact`。
- **SQLite 尚未实现。** 规划中的本地持久化形态是只读会话事件 → JSONL 追加 / SQLite；当前两者都没有写入路径。

## 限制

- **只做 OTLP/JSON 互操作，不接 OTel 运行时。** 没有 OTLP/gRPC、protobuf、OpenTelemetry SDK/Collector、自动上报或 W3C trace context 传播；`toOtlp`/`fromOtlp` 只转换单个 OTLP/JSON 文档的 trace 部分，且 OTLP 里没有本包的哈希链/HMAC 签名。实时采集接的仍是 DSH 自己的事件总线。
- **实时采集是尽力而为。** Cordis 没有通配符事件派发，本包枚举当前 DSH 的已知事件名，并用 `internal/dispatch` 兜底；DSH 改事件名或字段后，未知事件会被忽略，不会伪造 span。MCP 生命周期事件目前只在产生方发事件时才可见；MCP 工具调用主要按 `mcp__` 名称前缀识别。采集器只有 attach 之后的内存态，不回放历史 session，重启即空。
- **运行中的 span 不进哈希链。** 只有配对到结束事件的 span 才被 ingest；长时间不结束的 job/tool 只在 `trace_live_status` 里以 `running` 计数，不会出现在 `trace_export` 中。链顺序是**结束/ingest 顺序**，不是开始时间顺序。
- **HMAC 不是透明日志。** 哈希链本身仍只是自洽性校验；`sign: true` 加的是共享密钥 HMAC-SHA256，不是 Ed25519/RSA 公钥签名，没有外部锚（Git commit、透明日志、时间戳服务）。持有同一密钥的人都能签发；它能证明「知道密钥的人签过这份 bundle」，不能证明签发者身份，也不能证明「它来自某个特定 DSH run」。签名格式与 `testatum-attest` v1 的 `signaturePayload`（canonical JSON 去掉 `signature`）兼容，`schema: "testatum/v1"` 可作为普通已签名对象接受，但这只是格式兼容，不是完整 trust card 语义。
- **元数据未封链（未签名时）。** 未签名 bundle 的 `exportedAt` 等元数据不在哈希链里；签名 bundle 的 HMAC 覆盖除 `signature` 外的全部字段，包括元数据。见「证据格式」。
- **脱敏不是秘密扫描。** 只按字段名精确匹配（大小写不敏感），不识别值里的 `sk-...`、JWT、私钥；也不会脱敏字段名本身。
- **脱敏后重新封链意味着不能拿它和原始 bundle 比哈希。** 如需最强证据，保留未脱敏原件，用脱敏副本对外分享。
- **单进程、内存态、无并发控制。** 多个 DSH 进程各自一条链；重启即空；没有锁、没有 fsync、没有崩溃恢复。
- **采集器没有 retention / 采样。** 结束的 span 和等待配对的 running 记录都留在进程内，长时间运行会持续增长；没有上限、环形缓冲或淘汰策略。
- **查询是全量线性扫描。** 没有索引、分页游标或跨 store 合并；`limit` 只截断结果，不减少扫描成本。
- **时间来自调用方。** 没有时钟校准或单调性校验；`startMs` 可早于父节点，也可乱序。哈希链顺序与时间顺序是两件事。
- **canonical JSON 不是 RFC 8785。** 只保证本包导出的 bundle 在本包内可复现；跨实现需要对齐同一算法。
- **bundle 大小受工具返回限制。** 超大 store 直接导出可能超过模型上下文/传输限制；MVP 没有分片导出。

## 命名核验

**2026-11-14 复核：**

- `npm view dsh-os-trace version` → `npm error code E404` / `404 Not Found`，包名未被占用。
- GitHub repository search（`GET /search/repositories?q=dsh-os-trace+in:name`）→ `total_count: 0`，无同名仓库。

npm 包名可随时被他人注册；GitHub 搜索只覆盖仓库名查询。**发布前应再次复核。**

## 开发

```sh
cd 04-build/dsh-os-suite
node --test packages/dsh-os-trace/test/*.test.js
node --check packages/dsh-os-trace/src/*.js
```

`src/core.js` 不 import 任何 `@deepseek-ai/*`，可离线单测；`src/ingest.js` / `src/sign.js` / `src/otlp.js` / `src/cli.js` 也不依赖 DSH 运行时。插件入口负责创建 store、装载种子输入、注册五个工具、按 `config.ingest !== false` 附加实时采集器。

## 许可

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)。Copyright 2026 dsh-os-suite contributors。

这是社区项目，与 DeepSeek 无隶属关系，不是 DeepSeek 官方产品，不提供任何 SLA。DSH 本体及其 `@deepseek-ai/*` 包遵循其各自许可。
