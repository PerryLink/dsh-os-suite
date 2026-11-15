# DESIGN — dsh-os-trace

> 状态：0.1.2 + 实时采集/HMAC 签名/OTLP JSON 互操作（未发布）。本文描述**已实现的行为**与**明确的未来接线点**，不把计划写成现状。

## 1. 目标与非目标

### 目标

1. **因果可解释**：给定一个事件 id，返回它和祖先/后代组成的 span 子图与边。
2. **可验证的证据包**：span 进入一条 SHA-256 哈希链；导出 bundle 后，任何单点修改、重排、错误拼接都能定位到第一个坏 span。
3. **可安全分享**：按字段名递归脱敏，重新封链，使校验针对实际分享的字节。
4. **零 DSH 依赖的核心**：`src/core.js` 不 import `@deepseek-ai/*`，`node --test` 可离线运行；`ingest.js` / `sign.js` / `otlp.js` / `cli.js` 同样可离线测试。
5. **可嵌**：插件入口负责 store 创建、种子输入、五个工具注册和实时采集 attach；采集/签名/OTLP 映射逻辑不写进 `index.js`。
6. **可互操作**：把 span 与单个 OTLP/JSON 文档互转，明确字段损失；不引入 OTLP SDK、Collector 或 gRPC/protobuf。

### 非目标

- 不做 OTel Collector/SDK，不做 OTLP/gRPC 或 protobuf，不做 W3C trace context 传播；OTLP/JSON 仅做离线导入/导出。
- 不替代 DSH session 日志、不建全局搜索、不做 UI。
- 不做 PKI、透明日志、外部时间戳或公钥签名；HMAC 是共享密钥 MAC，不是身份凭证。
- 不做 SQLite 持久化、跨进程共享、崩溃恢复；实时采集不回放历史 session。
- 不记录工具参数、消息正文或自由文本原因。

## 2. 架构

```text
packages/dsh-os-trace/
  src/core.js   纯逻辑：规范化、哈希链、store、why、bundle、verify
  src/ingest.js 实时采集：事件 → span、配对/去重、terminal 才 ingest
  src/sign.js   HMAC-SHA256 签名/验签（testatum-attest v1 载荷约定）
  src/otlp.js   OTLP/JSON ↔ span：trace/span id 派生、保留属性、字段损失
  src/cli.js    离线 CLI：trace_export / trace_import（默认 v1 bundle）
  src/index.js  Cordis 插件：createTraceStore + 5 个 defineTool + 种子输入 + attach
  test/         core / ingest / sign / otlp / cli / index 六组离线测试
```

数据流：

```text
DSH events (ctx.on) ──► createIngest ──┐
                                      ├── terminal span ──► createTraceStore.ingest
JSONL / config.spans ─────────────────┘                         │
OTLP/JSON ──► fromOtlp ─────────────────────────────────────────┘
                                                                │
                                                                ├── query(filter) ──► Span[]
                                                                ├── why(id, depth) ──► 子图 + edges + missing
                                                                ├── exportBundle({redact}) ──► bundle（可能重新封链）
                                                                ├── toOtlp(spans) ──► OTLP/JSON
                                                                └── verifyBundle(bundle) ──► { ok, firstBad, ... }
                                                                       │
                                                                       └── signBundle(bundle, secret) ──► signature
```

`src/cli.js` 只负责参数/文件/退出码：`trace_export` 读取 v1 bundle、OTLP/JSON、span 数组或 JSONL 后输出 v1 bundle（默认）或 OTLP/JSON；`trace_import` 读取 v1 bundle（校验链）或 OTLP/JSON，经 `createTraceStore().ingest()` 重新封链后输出 v1 bundle。

没有模块级可变状态：所有 store 状态在 `createTraceStore()` 闭包里；`verifyBundle` 是纯函数（输入 bundle，输出结果）。

## 3. 数据模型

### 3.1 Span

| 字段 | 类型 | 必填 | 约束 / 含义 |
|---|---|---|---|
| `id` | string | 是 | store 内唯一；非空 |
| `parentId` | string | 否 | 因果父 id；允许指向尚未 ingest 的 id（形成 missing 链） |
| `sessionId` | string | 是 | 来源 DSH session；非空 |
| `agentPath` | string | 否 | 例如 `lead/researcher`；允许空串 |
| `kind` | enum | 是 | `tool` / `subagent` / `job` / `approval` / `mcp` / `session` / `workflow` |
| `name` | string | 是 | 操作名；非空 |
| `startMs` | number | 是 | epoch 毫秒；有限值 |
| `endMs` | number | 否 | epoch 毫秒；`>= startMs` |
| `status` | enum | 是 | `ok` / `error` / `running` |
| `attrs` | object | 否 | 任意 JSON 对象；ingest 时深拷贝 |
| `hash` | string | 存储/导出 | 64 位小写十六进制 SHA-256 |
| `prevHash` | string | 存储/导出 | 上一条的 `hash`，创世为 64 个 `0` |

`ingest` 会忽略调用方传入的 `hash`/`prevHash` 并重新计算；未知顶层字段直接报 `INVALID_SPAN`，防止拼写错误变成未受链保护的数据。

### 3.2 不变量

1. 一个 store 只追加一条全局哈希链；顺序 = ingest 顺序，与 `startMs` 无关。
2. 每条 span 的 `hash` 覆盖除 `hash` 外的所有字段（包含 `prevHash` 与 `attrs`）。
3. `parentId` 可以在子节点之后到达，但不能形成环：ingest 会沿已存在的父链检查，闭合环抛 `CAUSAL_CYCLE`。
4. `query` 返回深拷贝，调用方不能通过返回值篡改 store。
5. `why` 不伪造根：父节点缺失时返回 `missing`，不把孤儿当 root。
6. 脱敏导出必然重新封链；未脱敏导出保留原链，因此可与源 store 的 `rootHash` 对照。

### 3.3 因果图

- `byId: Map<string, Span>` 用于 O(1) 定位。
- `childrenByParent: Map<string, Span[]>` 用于向下 BFS。
- `ingestOrder: Map<string, number>` 用于相同 `startMs` 的稳定排序。
- `why(eventId, depth)`：
  - 向上最多 `depth` 跳，遇到缺失父节点记录 id 并停止；
  - 向下 BFS 最多 `depth` 跳；
  - 返回的 `spans` 是包含 target 的、按 `startMs` + ingest order 排序的集合；
  - `edges` 只包含子图内部真实的 parent→child 关系；
  - `truncated` 表示还有节点因深度上限未纳入。
- 深度上限 64，避免一次调用失控；`0` 表示只要 target 本身。

### 3.4 OTLP/JSON 映射

`src/otlp.js` 只处理 OTLP/JSON 的 trace 部分，不依赖 DSH 或 OTel 运行时：

- **traceId**：有 `sessionId` 时取 `sha256(sessionId)` 前 16 字节（32 hex）；没有时取根 span id 的同一哈希。无 `parentId` 的 span 是根，不写 `parentSpanId`。
- **spanId**：`sha256(id)` 前 8 字节（16 hex）；`parentSpanId` 由 `parentId` 同法派生，因此父子引用于导出后仍然闭合。
- **时间**：`startTimeUnixNano` / `endTimeUnixNano` 是 `毫秒 × 1e6` 的十进制字符串；没有 `endMs` 时不写 `endTimeUnixNano`。
- **状态**：`ok` / `running` → `status.code: 1`，`error` → `2`。OTLP 没有 running，故 running 的原值写在保留属性里。
- **属性**：字符串/布尔/安全整数/浮点分别用 `stringValue` / `boolValue` / `intValue` / `doubleValue`；数组/对象用 `arrayValue` / `kvlistValue`。`null`/`undefined` 不写入。
- **保留属性**：`dsh.span.id`、`dsh.span.parent_id`、`dsh.span.session_id`、`dsh.span.kind`、`dsh.span.status`、`dsh.span.agent_path` 保存 OTLP 没有的 DSH 字段；导入时从 `attrs` 剔除。用户 attrs 不应使用 `dsh.span.*`。
- **导入缺省**：没有保留属性时 `id = spanId`、`sessionId = traceId`、`kind = "workflow"`、`name = "unnamed"`、缺失时间取 0；无 end 且 status code 为 0 视为 running，code 2 为 error，其余为 ok。
- **字段损失**：哈希链/HMAC 签名、DSH kind/agentPath（除非保留属性）、除 `service.name` 外的资源属性、span links/events、W3C traceState、OTLP kind/status.message 都不映射；外部 traceId 也不原样保留（导入后仅作缺省 sessionId，再导出会重新派生）。导入后重新封链，导入得到的 hash 不是来源证据。
- **不处理**：OTLP/gRPC、protobuf、metrics/logs、OTel SDK/Collector、自动上报、W3C trace context 注入/提取。

```js
import { toOtlp, fromOtlp } from 'dsh-os-trace/otlp'
const otlp = toOtlp(store.query(), { serviceName: 'my-dsh' })
for (const span of fromOtlp(otlp)) store.ingest(span)
```

## 4. 集成点（已接线，尽力而为）

`src/ingest.js` 已按下面的契约订阅 `session/event`、`tools/pre-execute`、`tools/post-execute`、`tool/result` 以及 approval/agent/subagent/job/mcp 家族事件。Cordis 没有通配符派发，所以实现同时枚举已知具体事件名，并用 `internal/dispatch` 做未知家族兜底。未知事件忽略，采集失败不阻塞主循环。

| 来源 | 建议 `kind` | 建议 `name` | 关键 `attrs`（示例） | 关系 |
|---|---|---|---|---|
| `session.event` | 视事件而定 | 事件类型 | 事件摘要、模型/回合 id | 根事件或上一事件的子节点 |
| tool call | `tool` | 工具名 | 参数摘要（脱敏）、耗时、错误码 | `parentId` = 发起它的 turn/subagent span |
| approval | `approval` | 策略/审批动作 | 决策、策略 id、是否人工确认 | 作为对应 tool span 的子节点 |
| subagent | `subagent` | 子 agent 名 | agentPath、任务摘要、token 用量 | 父 = 派发它的 tool/turn；子 = 子 agent 内部 tool |
| job | `job` | 命令/任务名 | job id、退出码、是否后台 | 父 = 启动它的 tool；`endMs` 在完成事件补 |
| MCP | `mcp` | `server/tool` | server 名、工具名、耗时、错误码 | 父 = 发起调用的 tool/subagent |
| workflow | `workflow` | 工作流/阶段名 | workflow id、step id、重试次数 | 父 = 触发者；orchestrator 作为祖先 |

接线要求：

1. **关联 id**：tool/approval/job/subagent 的事件必须携带稳定的关联 id，否则无法可靠构造 `parentId`。不能只靠时间邻近。
2. **时间**：优先使用 DSH 事件时间；没有时再用 adapter 接收时间，并在 `attrs` 标注来源，避免把两个时钟混为一谈。
3. **脱敏**：采集阶段就应对参数/结果做与 `redact` 等价的处理，不能先写盘再指望导出时兜底。
4. **失败隔离**：采集失败不能阻塞 agent 主循环；记录 adapter 自身错误，但不伪造 span。
5. **权限**：只订阅 DSH 明确公开的只读事件；不读凭据、不读用户 home 下的私有文件。

## 5. 失败模式

| 失败模式 | 当前行为 | 风险 / 后续 |
|---|---|---|
| 父节点缺失（乱序或丢失） | `why` 返回 `missing`，不补假根 | 因果链断点可见；需要采集端保证完整或提供回填 |
| 重复 `id` | `DUPLICATE_SPAN` | 调用方应先设计稳定事件 id |
| 因果环 | ingest 拒绝；`why` 有 visited 防御 | 事件关联逻辑错误应在上游修复 |
| 子节点先于父节点到达 | 允许；父到达后图自动闭合 | 查询时可能短时间看到 missing |
| 时钟回拨 / 跨机时间 | 原样记录，按 `startMs` 排序 | 链顺序仍按 ingest；不要用时间戳证明因果 |
| 导出时只删尾部 | `spanCount`/`rootHash` 不一致 → `firstBad` | 若攻击者同步改这两个字段，需外部锚 |
| 单点改字段 | `hash mismatch` | 定位到 index/id |
| 重排 / 嫁接连 | `prevHash` 不匹配 | 定位到第一处断链 |
| 整条链重算 | 未签名时校验通过；签名后 HMAC 失配（除非持有密钥重签） | **本质限制**：链本身不是签名；HMAC 也不是透明日志 |
| `exportedAt`/`sourceRootHash` 被改 | 未签名时不检测；签名后 HMAC 失配 | 这两个字段不在哈希链里，但在签名载荷里；未签名时不要当证据 |
| 脱敏漏字段 | 只按 key 名匹配，不改字符串内容 | 上游字段命名要规范；必要时先做值级审查 |
| 脱敏过度 | `id`/`parentId` 等被替换会破坏引用 | 文档建议不要 redact 结构字段；后续可加保留字段规则 |
| OTLP/JSON 坏 JSON 或坏外层 | `fromOtlp` 抛 `INVALID_OTLP`；CLI 退出码 2 | 不猜测性修复外层；span 内部缺字段才用默认值 |
| 外部 OTLP span 无 DSH 元数据 | `id = spanId`、`sessionId = traceId`、`kind = workflow` | 字段损失可见；不要把它当 DSH 因果语义 |
| OTLP 导入的 hash/signature | 丢弃并由 store 重新封链 | 导入后的 hash 不能证明 OTLP 来源 |
| OTLP attrs 含 null/自定义 AnyValue | null 不导出；未知 oneof 原样保留 | 跨实现可能丢类型；以 README 映射表为准 |
| 超大 store | 一次导出/返回全量，可能超上下文 | 后续分片导出、游标查询 |
| 多 DSH 进程 | 各自独立链，无法互验 | 后续 SQLite/共享存储 + 命名空间 |
| 重启 | 内存清空 | 后续 JSONL append + fsync；当前需调用方保存 bundle |
| JSONL 坏行/文件不存在 | 插件加载失败并带行号 | 故意 fail loud，避免静默丢审计数据 |
| canonical JSON 跨语言差异 | 只保证本包内可复现 | 后续对齐 RFC 8785 或发布测试向量 |
| bundle 版本升级 | `verifyBundle` 拒绝未知 `version` | 格式变更必须 bump version 并保留 v1 verifier |
| 工具权限滥用 | 任何能调工具者都可读全 store | 依赖 DSH tool policy；后续按 session/agent 过滤 |

### 威胁模型

- **能防**：拿到 bundle 后改一条 span、改哈希、重排、截断而不重算；意外损坏；JSONL 解析错误。
- **不能防**：能完整重写 bundle 并重算所有哈希的攻击者；能篡改工具进程内存的攻击者；能伪造源事件的上游；没有外部锚时无法证明「这份 bundle 属于某次特定 run」。
- **已加**：HMAC-SHA256 签名覆盖除 `signature` 外的全部字段；持有同一密钥者可伪造，故只提升到「知道密钥的人签过」。
- **下一步**：Ed25519 公钥签名，或把 `rootHash` 锚定到 Git commit / 透明日志 / 可信时间戳，才能把「自洽」提升为「可归属」。

## 6. 30 天路线

### 第 1 周：实时采集 MVP（已实现）

- 只读事件适配器：tool / subagent / job / approval / MCP / session → span。
- 关联 id 规则与父链构造；缺失父节点只记 missing，不补假根。
- 配对/去重；running span 保留在采集器视图，terminal 才进入哈希链。
- 验收：`trace_live_status` 能观察配对与 running；采集失败不阻塞主循环。

- 仍缺：JSONL append sink（可选 fsync）。

### 第 2 周：持久化与可操作性

- 引入只读 SQLite 索引（`node:sqlite` 或等价方案），按 session/时间/kind 建索引；JSONL 作为原始 append log。
- 增加 `trace verify <bundle.json>` 子命令或等价离线入口；CLI 目前已有 `trace_export` / `trace_import`。
- 分页/游标查询，避免一次扫描全量。
- 验收：1 万 span 的 store 查询 P95 可接受；离线校验不依赖 DSH 运行时。

### 第 3 周：证据强度与隐私

- 已实现 HMAC-SHA256 签名（共享密钥，testatum-attest v1 载荷兼容）；仍缺 Ed25519 公钥签名、密钥生命周期/轮换/公钥分发。
- 仍缺外部锚：把签名后的 root 写入 Git note / 透明日志适配器。
- 脱敏策略 v2：路径规则、允许列表、结构字段保护、值级 secret 检测（谨慎，默认关闭）。
- 发布 canonical JSON 测试向量，降低跨实现漂移。
- 验收：篡改 + 重算的 bundle 能被签名/锚验证拒绝；脱敏后仍可通过签名验证。

### 第 4 周：发布与生态

- OTLP/JSON 导入/导出（已实现；只做 JSON，不接 OTel SDK/Collector，不走 gRPC/protobuf）。
- 文档、示例 run、npm `pack` 检查、版本范围复核。
- 发布 0.1.x 到 npm；收集真实 run 的兼容性反馈。
- 验收：干净环境 `dsh plugin add` + 五个工具可用；`npm pack --dry-run` 文件清单符合预期；README/DESIGN 无未实现承诺。

## 7. 版本与兼容

- bundle `format: "dsh-os-trace/bundle"`，`version: 1`；不兼容变更必须 bump `version`，并保留旧版 verifier。
- `verifyBundle` 对未知 `format`/`version` 返回 `ok: false`，不做猜测性解析。
- `core.js` 的公开函数：`createTraceStore`、`verifyBundle`、`canonicalJson`、`computeSpanHash`、`normalizeSpan`；语义变更按 semver 处理。
- `ingest.js` 的公开入口：`createIngest`、`CORE_INGEST_EVENTS`、`FAMILY_INGEST_EVENTS`。`sign.js` 的公开入口：`signBundle`、`verifySignedBundle`、`signaturePayload`、`SIGN_ALG`、`SECRET_ENV`。`otlp.js` 的公开入口：`toOtlp`、`fromOtlp`、`OTLP_ATTR`、`OTLP_SCOPE_NAME`、`OTLP_DEFAULT_SERVICE_NAME`、`OTLP_SPAN_KIND`；包 `exports` 提供 `./otlp` 与 `./cli` 子路径。
- 包要求 DSH `>=0.2.2-rc.3 <0.3.0`；DSH 事件 API 变化时，适配器单独发版，不改动已导出的 bundle 格式。
