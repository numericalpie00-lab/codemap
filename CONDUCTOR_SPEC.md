# 🎼 CodeMap Conductor — 规格 (v1, MVP)

> 喂一个分阶段的 prompt 文件,编排器自动一段段驱动编码 agent(首发 Claude Code),
> **每段强制校验、可设断点、随时急停、需要你时自动停下**。你盯着地图当指挥官,
> 而不是手动复制粘贴不同阶段的 prompt。
>
> 这份文档是实现基准。代码在你本机跑(需要本机 Claude Code 登录 + `npm install`)。

---

## 0. 已锁定的决定

| # | 决定 | 落到实现 |
|---|---|---|
| 认证 | **用本机 Claude Code 登录(订阅额度)** | Agent SDK 默认走本机凭证,**不注入** `ANTHROPIC_API_KEY` |
| 危险动作 | **写文件 / bash 一律过人手批准(最安全档)** | `permissionMode:'default'` + `allowedTools` 只放只读类;其余全落 `canUseTool` |
| 执行内核 | **Claude Agent SDK** | `@anthropic-ai/claude-agent-sdk` |
| 多平台 | **以后要支持 Codex 等** | 抽 `AgentDriver` 接口,`ClaudeDriver` 首发(见 §3) |

---

## 0.1 成本与触发模型(谁花钱、何时花)

**只有 Conductor 烧 Claude 订阅额度,且只在你显式"运行"时。** 地图是免费被动的。

| 部分 | 成本 | 花谁的钱 |
|---|---|---|
| 地图观测(文件监听 / 地图 / 时间线) | **零** | 无 LLM,纯本地 |
| 语义分组(中文领域聚类) | 很便宜、可选、有缓存 | **API key**(非订阅);无 key 免费退回文件夹分组 |
| **Conductor**(驱动 agent 干活) | **烧订阅额度** | 唯一动订阅的东西 |

**两个独立入口,泾渭分明:**

```bash
codemap watch  <repo>      # 被动地图,零成本,随便开
codemap run    <scheme>    # Conductor:显式动作,会烧订阅额度,绝不随地图自启
```

成本护栏:
- Conductor **绝不自动启动** —— 只在 `codemap run` / `POST /api/run` 显式触发时才动。
- 运行前**一道确认**:"这将开始消耗你的 Claude 订阅额度 —— 确认开始?"
- 面板显示本次 run 进度,随时**急停**。
- `maxTurns` 每段封顶,防跑飞烧额度。
- 语义分组:默认"有 key 才自动跑 + 缓存";可配置为 UI 上显式**「语义分组」按钮**,做到"任何花钱动作都需亲手触发"。

---

## 1. 架构总览

```
scheme.md ──▶ Orchestrator ──▶ AgentDriver ──▶ 编码 agent 干活
                  │              (ClaudeDriver)      │ 改文件
                  │  每段 result 后跑 gate            ▼
                  ▼                              CodeMap 文件监听
            /api/run 状态 ◀──────────────────────  气泡亮起
                  │
            前端「指挥面板」: 阶段进度 / 暂停原因 / 继续·带补充·跳过·中止 / 急停
```

**关键洞察:这个项目里"跟 agent 绑定"的只是一小块。**

| 组成 | 与 agent 的关系 |
|---|---|
| CodeMap 观测层(文件监听 / 地图 / 时间线 / 语义分组) | **完全无关** —— 监听文件系统,谁改都行(Codex/Cursor/Aider/手改) |
| Conductor 编排逻辑(scheme / 闸门 / 断点 / 暂停模型 / 急停 / 面板) | **完全无关** —— 纯编排,不关心底下是谁 |
| **驱动一段对话** | **仅此** 与 agent 绑定 → 收进 `AgentDriver` 接口 |

---

## 2. scheme 文件格式(保持"就是写 prompt")

```markdown
# @gate: npm run build        全局默认闸门(每段强制,不可关闭)
# @cwd: .                     锁死工作目录 = 爆炸半径
# @driver: claude             用哪个 driver(默认 claude)

## 阶段1：数据层  @break        打断点：这段开始前停下等我
把 xxx 建成 yyy……（你的 prompt 原文）

## 阶段2：接 UI                 没打断点：自动跑
在上面基础上……
@gate: npm test               覆写本段闸门(仍强制,只是换命令)
@session: fresh               清场重开(默认 continue = 续接上一段会话)
@maxTurns: 30                 本段 agent 循环上限,防跑飞
```

- 未写 `@gate` → 用全局默认。**闸门永远存在,不可关**(这是安全地基,不是 prompt 的责任)。
- 未写 `@session` → 默认 `continue`(传 resume);`fresh` → 不传 resume。
- 80% 的行是纯 prompt。解析:`## ` 起一段,`@key: val` 是指令,其余是 prompt 正文。

---

## 3. `AgentDriver` 接口(多平台的接缝)

编排器只跟这个接口讲话。换后端 = 换一个实现,编排器和地图**零改动**。

```ts
interface AgentDriver {
  name: string;
  runPhase(input: {
    prompt: string;
    cwd: string;
    resumeToken?: string;                          // 会话续接句柄(各 driver 自定义)
    maxTurns?: number;
    systemPrompt?: string;                         // 注入 ask_human 铁律等
    onEvent:      (e: DriverEvent) => void;        // tool_use / file_change / text → 喂地图与时间线
    onNeedInput:  (q: string) => Promise<string>;  // 要人输入 → 挂起,拿到答案再 resolve
    onPermission: (t: { tool: string; input: unknown }) => Promise<'allow' | 'deny'>; // 危险动作过手
    signal:       AbortSignal;                     // 急停
  }): Promise<{ ok: boolean; error?: string; resumeToken?: string }>;
}

type DriverEvent =
  | { kind: 'tool_use';    tool: string; input: unknown }
  | { kind: 'file_change'; path: string }          // 可选:driver 自报;CodeMap 也会独立监听到
  | { kind: 'text';        text: string };
```

### 3.1 `ClaudeDriver` → Agent SDK 映射

包:`@anthropic-ai/claude-agent-sdk`。核实过的 API(建构时对官方文档再核一遍确切类型):

| 接口需求 | Agent SDK 机制 |
|---|---|
| 驱动一段 | `query({ prompt, options })` → `for await (msg of q)` |
| 段完成 | `SDKResultMessage` `{ type: 'result' }`(`subtype` 含 error 语义)/ 生成器结束 |
| 续接句柄 | `result` 里的 `session_id` → 下段 `options.resume = session_id` |
| `onPermission` | `options.canUseTool: CanUseTool`(仅当权限落到"要问"才触发;`allowedTools` 命中的跳过) |
| `onNeedInput` | 自定义工具 `ask_human`(见 §5)via `createSdkMcpServer` + `tool()` |
| `onEvent` | `options.hooks` 的 `PreToolUse`/`PostToolUse` + 流里的 `assistant`/`tool_result` 消息 |
| 急停 | `q.interrupt()` |
| 上限 | `options.maxTurns` |
| 目录锁 | `options.cwd` |
| 危险默认 | `options.permissionMode: 'default'` + `options.allowedTools: ['Read','Grep','Glob']` |
| 认证 | 不传 key,用本机 Claude Code 登录 |

> `CanUseTool` 签名:`(toolName, input, {signal, toolUseID, ...}) => Promise<PermissionResult | null>`。
> 返回 allow/deny(确切 `PermissionResult` 形状建构时核文档)。

---

## 4. 五种"停" → 机制映射

| 要求 | 触发 | 靠什么 |
|---|---|---|
| **强制闸门** | 每段 `result` 后 | 编排器跑 `@gate` 命令,退出码非 0 → 停(与 driver 无关) |
| **断点(VS Code 式)** | 段标了 `@break` | 编排器在该段 `runPhase` **之前**停,等"继续"(与 driver 无关) |
| **程序报错停** | gate 失败 / `runPhase` 抛错 / `ok:false` | 编排器判定(与 driver 无关) |
| **要人输入停** | 缺密钥/要选择/信息不全 | `onNeedInput`(ClaudeDriver: `ask_human`)+ `onPermission`(危险命令过手) |
| **急停** | 你拍按钮 | `AbortSignal` → `q.interrupt()` |

**四种与 driver 无关,任何后端都能做到;唯"要人输入"依赖后端开放度(见 §11)。**

---

## 5. 架构精髓:暂停 = 一个被 await 住的 Promise

`onNeedInput` / `onPermission` 都是 async。暂停不需要复杂状态机 —— **让回调挂起一个 Promise 即可**,agent 自然在那儿等:

```ts
// ClaudeDriver 里给 Claude Code 的求助工具
const askHuman = tool(
  'ask_human',
  '缺密钥/要做选择/信息不全时必须调用;禁止猜测或编造',
  { question: z.string() },
  async ({ question }) => {
    const answer = await onNeedInput(question);           // ← 挂起,地图标黄,面板弹问题
    return { content: [{ type: 'text', text: answer }] };  // ← 你答完,它拿到继续
  }
);
```

- **Vercel/Cloudflare token 场景**:agent 调 `ask_human("需要 VERCEL_TOKEN")` → 面板弹出 → 你"带补充继续"粘 token → Promise resolve → 无缝续跑。
- **急停** = abort signal 触发 → `interrupt()` + reject 所有挂起的 Promise。
- 系统提示注入铁律:**"缺密钥/要决策/信息不全 → 禁止猜测编造,必须调 `ask_human` 停下。"**

gate/报错是第三层兜底:万一 agent 既不求助又硬跑,命令会因缺密钥失败 → 闸门红 → 停。

---

## 6. 权限与爆炸半径

- `cwd` 锁死 repo 目录;
- `permissionMode:'default'` + `allowedTools:['Read','Grep','Glob']` → **写文件 / bash 一律落 `canUseTool` 过人手**;
- `maxTurns` 每段封顶;
- **绝不** `bypassPermissions` / `allowDangerouslySkipPermissions` 无人值守。

---

## 7. 会话续接

每段一次 `runPhase`;返回 `resumeToken`(ClaudeDriver = `session_id`)。
下段 `@session: continue` → 传 `resumeToken`;`fresh` → 不传。闸门卡在两段之间跑。

---

## 8. 指挥面板 UI(复用现有地图/时间线)

- 顶部**阶段进度条**:③/⑦ 跑到第几段,每段 ✅ 过 / ⛔ 红 / ⏸ 停;
- 当前段**实时工具调用流**(PreToolUse)贴时间线上方;
- 暂停时该簇文件**标黄/标红** + 弹窗(原因 + 相关输出 + 按钮:**继续 / 带补充继续 / 跳过 / 中止**);
- 右上角常驻**急停键**。

---

## 9. 后端新增接口

| 方法 路径 | 作用 |
|---|---|
| `POST /api/run` | 上传 scheme + 断点集,启动 |
| `GET  /api/run` | 轮询运行状态(复用现有 1s 轮询):当前段 / 各段状态 / 暂停原因 / 待答问题 |
| `POST /api/run/resume` | 处置暂停:`continue` / `answer`(带补充) / `skip` / `abort` |
| `POST /api/run/stop` | 急停 |

---

## 10. 分步实施计划

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 骨架** | 装 SDK;`query()` 单段跑通;`result` 收尾;工具调用打进时间线 | 能驱动 Claude Code 改一个文件,地图亮 |
| **M1 顺序 + 强制闸门** | 解析 scheme;顺序跑;每段后跑 gate;红则停 | 一个多段 scheme 跑到底,故意让某段 build 失败会停 |
| **M2 三种自动停** | `ask_human` + `canUseTool` + 报错停 + 暂停/恢复 Promise | token 场景:agent 停下问 → 粘入 → 续跑 |
| **M3 断点 + 急停 + 面板** | `@break`、`interrupt()`、前端进度条与弹窗 | 断点停在指定段;急停立即中断 |

**先不做**:并行、失败自动重试、分支决策。

---

## 11. 诚实的能力矩阵(多后端)

| 能力 | Claude Code | Codex / 只有 CLI 的后端 |
|---|---|---|
| 断点 / 强制闸门 / 报错停 / 急停 | ✅ | ✅ 都能(编排器层 + 进程退出,与后端无关) |
| 文件变化观测(地图) | ✅ | ✅ 都能(CodeMap 监听文件系统) |
| **要人输入(结构化信号)** | ✅ 权限回调 + `ask_human` | ⚠️ 退化:无一等公民信号,靠文本粗检测 / 命令失败兜底 |
| 工具调用实时流 | ✅ hooks | ⚠️ 视后端,可能只有粗事件 |
| 会话续接 | ✅ `resume` | ⚠️ 视后端 |

> 加新后端 = 写一个新 `AgentDriver` 实现,不是重构。能填多满取决于该 agent 的开放度。

---

## 12. 护栏(一句话清单)

强制闸门不可关 · `cwd` 锁目录 · 写/ bash 默认过人手 · `maxTurns` 封顶 · 全局急停 · 绝不无人值守跳权限。

---

## 13. 待建构时再核实的点

- `PermissionResult` 的确切形状(allow/deny 的字段名)。
- `ask_human` 作为 in-process MCP 工具时,`allowedTools` 里要不要显式放行它的工具名。
- 流式注入 `streamInput()` vs 每段独立 `query({resume})` 的取舍(MVP 用后者,边界更清晰)。
- 本机 Claude Code 登录在 SDK 侧的确切读取方式(是否需要 `CLAUDE_CODE_*` 环境变量)。
