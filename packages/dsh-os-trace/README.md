# dsh-os-trace

> **Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.** Apache-2.0. No SLA, no warranty.


> 给 DSH Agent 运行提供**因果审计**与**防篡改证据包**：把 run 里发生的事连成父子链，记录 SHA-256 哈希链，并能导出、脱敏、校验。
>
> Causal audit and tamper-evident evidence bundles for DSH agent runs.

**状态：0.1.2（MVP，已发布到 npm）。** 社区项目，非 DeepSeek 官方项目，Apache-2.0，无 SLA。

## 为什么

DSH 的 session 日志能回答「发生过什么」，但很难直接回答下面这些问题。**DSH 目前缺少面向用户的因果审计与证据链层**，日志本身不提供跨 tool/subagent/job 的因果图，也不提供可校验的导出格式：

1. **为什么这个结果会出现？** 一次回答可能来自 tool → subagent → MCP → job 的六七层嵌套。日志按时间平铺，父子关系要靠人从事件顺序里猜。
2. **是谁触发的？** 同一 session 里并行跑了多个 subagent / 后台 job，只看时间戳分不清哪条因果链属于谁。
3. **审计时如何证明没被改过？** 导出一份 JSON 交给别人，对方无法判断某条记录是否被删改、重排或拼接。
4. **分享时如何不泄露密钥？** `attrs` 里经常带 API key、token、请求头；直接导出等于泄密。

`dsh-os-trace` 在**用户级**补这一层：以 span 为最小事件，沿 `parentId` 组成因果图；所有 span 进入一条 SHA-256 哈希链；导出时可按字段名递归脱敏并重新封链；校验时返回第一个坏掉的 span。它不替换 DSH 日志，也不采集 OTel；它是日志之上的一层**可解释 + 可验证**视图。

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

### 数据从哪来（MVP）

当前版本**不订阅实时 DSH 事件**，启动时支持两种只读输入：

```yaml
# 在 profile / patch 叠加层的 dsh-os-trace 条目上传入（示意）
- id: dsh-os-trace
  name: dsh-os-trace
  config:
    dataFile: /absolute/path/to/spans.jsonl   # 每行一个 span JSON
```

- `dataFile`：启动时读取一次的 JSONL 快照；坏行会让插件加载失败，而不是静默丢数据。
- `config.spans`：程序化注入的 span 数组，主要供嵌入和测试使用。

实时采集适配器（`session.event` → span）尚未实现，路线见 [DESIGN.md](./DESIGN.md)。

## 四个工具

所有工具只读内存 store，返回结构化 JSON；不会写文件、不会联网。工具参数由 DSH 在调用前校验。

### `trace_query`

按条件查询已经进入 store 的 span，按 `startMs` 升序返回（`order: "desc"` 可反转）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 精确 span id |
| `sessionId` | 否 | 精确 DSH session id |
| `parentId` | 否 | 精确父 span id |
| `agentPath` | 否 | 精确 agent path |
| `kind` | 否 | 单个事件类别：`tool` / `subagent` / `job` / `approval` / `mcp` / `workflow` |
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

返回 bundle：`format`、`version`、`hashAlgo`、`exportedAt`、`spanCount`、`rootHash`、`sourceRootHash`、`genesisPrevHash`、`redaction`、`spans`。

- 不传 `redact`：保留 store 中的原始哈希链，`rootHash === sourceRootHash`。
- 传 `redact`：所有匹配字段（任意层级、含数组内元素）替换为字符串 `"[redacted]"`，然后**重新计算整条链**，让校验针对脱敏后的字节。`sourceRootHash` 记录脱敏前的链尾哈希，但它只是元数据，不能代替原 bundle 的密码学证明。
- 脱敏只按**字段名**匹配，不扫描字符串内容。把 key 放在 `attrs` 的任意嵌套对象里都能命中；拼在普通字符串里则不会。
- **不要 redact span 的结构字段**（`id`、`parentId`、`kind`、`status`、`startMs`、`attrs` 等）。它们被替换成字符串会破坏类型/因果引用；敏感信息应放在 `attrs` 的键里。0.1.0 没有结构字段保留规则，调用方需自行避免。

### `trace_verify`

校验 bundle 的 SHA-256 哈希链和 `rootHash`。接受 bundle 对象或它的 JSON 文本。

| 参数 | 必填 | 说明 |
|---|---|---|
| `bundle` | 是 | `trace_export` 返回的 bundle 对象，或序列化后的 JSON 字符串 |

返回 `{ ok, count, checked, rootHash, firstBad }`：

- `ok: true`：每条 span 的 `prevHash` 与前一条的 `hash` 一致，每条 `hash` 重算一致，`rootHash` 与链尾一致。
- `ok: false`：`firstBad = { index, id, reason, expected?, actual? }`。`index` 从 0 开始；`-1` 表示 bundle 级问题（格式、版本、`spans` 不是数组、`spanCount` 不符）。失败时顶层 `rootHash` 为 `null`，计算出的链尾哈希在 `firstBad.expected` 里（如果是哈希/根不匹配）。
- 能发现：改字段、改 `hash`、重排 span、删掉尾部但没同步 `rootHash`/`spanCount`、把一条链嫁接到另一条链、坏 JSON 结构。
- **不能发现**：攻击者拿到整个 bundle 后重算全部哈希并重写 `rootHash`；这不是签名，也没有外部锚（见「限制」）。

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

## 权限与数据

- **只读会话数据。** 设计上只消费会话事件；当前 MVP 只读取启动时配置的本地 JSONL（`dataFile`）或 `config.spans`，不修改、不删除任何 session 数据。
- **不写文件。** store 是进程内 Map；`trace_export` 只返回对象，不落盘。DSH 退出即丢失，除非调用方自己保存返回的 JSON。
- **不联网、不启子进程、不读凭据。** 没有 HTTP 客户端、shell、进程管理或密钥读取。唯一接触文件系统的地方是启动时读取 `dataFile`。
- **无鉴权。** 能调用这四个工具的 agent 就能读取 store 里的全部 span；工具层权限由 DSH 的 tool policy 负责，本包不额外区分租户。
- **数据字段**：session id、agent path、事件名、起止时间、状态、调用方提供的 `attrs`、哈希。`attrs` 完全由上游决定，可能含敏感信息；导出前请显式传 `redact`。
- **SQLite 尚未实现。** 规划中的本地持久化形态是只读会话事件 → JSONL 追加 / SQLite；0.1.0 两者都没有写入路径。

## 限制

- **MVP 不接真实 OTel。** 没有 OTLP exporter/importer，不支持 W3C trace context、span id 传播或 OpenTelemetry SDK 互操作。当前格式是本包自己的 v1 bundle。
- **没有实时采集。** `session.event`、tool call、approval、subagent、job、MCP、workflow 的自动映射都未接线；需要外部把 span 写进 JSONL 或 `config.spans`。因此这四个工具当前更像「审计/证据层」，不是「记录器」。
- **哈希链不是签名。** 没有 Ed25519/RSA 签名，没有外部锚（Git commit、透明日志、时间戳服务）。能重写整条链并重算 `rootHash` 的人可以伪造一份自洽的 bundle；`verify` 只能证明「这份 bundle 内部自洽」，不能证明「它来自某个特定 DSH run」。
- **元数据未封链。** 见「证据格式」最后一条。
- **脱敏不是秘密扫描。** 只按字段名精确匹配（大小写不敏感），不识别值里的 `sk-...`、JWT、私钥；也不会脱敏字段名本身。
- **脱敏后重新封链意味着不能拿它和原始 bundle 比哈希。** 如需最强证据，保留未脱敏原件，用脱敏副本对外分享。
- **单进程、内存态、无并发控制。** 多个 DSH 进程各自一条链；重启即空；没有锁、没有 fsync、没有崩溃恢复。
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

`src/core.js` 不 import 任何 `@deepseek-ai/*`，可离线单测；插件入口只负责创建 store、注册四个工具和读取只读 JSONL。

## 许可

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)。Copyright 2026 dsh-os-suite contributors。

这是社区项目，与 DeepSeek 无隶属关系，不是 DeepSeek 官方产品，不提供任何 SLA。DSH 本体及其 `@deepseek-ai/*` 包遵循其各自许可。
