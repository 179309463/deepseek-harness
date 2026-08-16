# 能力 Seam（Service Definition / Provider / Consumer）

研究范围：能力 seam 三角；以 `packages/shell` 为完整样板；横向扫 `fs`/`llm`/`subprocess`/`web`/`terminal`/`skill`/`workflow`/`todo`/`plan`/`guard`；简要 `context`/`hooks`。权威：`docs/glossary.md#capability-seam`、`.agents/notes/implemented/architecture/2026-06-13-capability-seams.md`。

---

# 能力 Seam 通用模式

## 关键文件清单

| 相对路径 | 职责 |
|---|---|
| `docs/glossary.md` | seam = 三角合称，单角色不是 seam |
| `.agents/notes/implemented/architecture/2026-06-13-capability-seams.md` | 为何拆三角、何时可折叠 |
| `docs/user/develop/practice/index.zh.md` | 中文教程：Bash 三角样板 |
| `packages/shell/shell/src/index.ts` | Definition 样板：`declare module` + 抽象 `Service` |
| `packages/core/tools/src/index.ts` | Consumer 宿主：`tools/pre-execute|execute|post-execute` |

## 核心代码摘录

### Declaration merging → `ctx.shell` 类型

```40:44:packages/shell/shell/src/index.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor
  }
}
```

解读：编译期扩 `Context`；运行时由 `Service` 构造函数按同名 key 注册。Consumer `inject: ['shell']` 即可类型安全使用，**禁止**依赖 Provider 包。

### Definition = 抽象类（非 interface）+ `super(ctx, key)`

```65:68:packages/shell/shell/src/index.ts
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }
```

解读：Provider `extends` 后 `export default`；Loader 加载即注册。同 context 重复同 key 抛错。

### 显式默认化：`resolve(request): Spec`

```85:93:packages/shell/shell/src/index.ts
  abstract resolve(request: ShellExecRequest): ShellExecSpec

  /**
   * Run a command in the foreground; resolves when it finishes.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the outcome; nonzero exits, timeout kills, and abort kills
   *   resolve with a descriptive result rather than reject.
   */
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>
```

解读：AGENTS「Explicit > implicit」落地——`run`/`start` 只吃 Spec，内部不再 `?? default`。

### Consumer 策略挂 waterfall，不改 Definition

```152:152:packages/core/tools/src/index.ts
    'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
```

解读：审批/沙箱/超时挂 `tools/*`；waterfall 必须 `next()`，否则短路。

## 执行流程（角色装配）

```
cordis.yml 选 Provider → Loader new LocalBashExecutor → super(ctx,'shell')
Consumer inject:['shell'] → ctx.shell.resolve(req) → run/start(spec)
Provider ↛ Consumer（只共依赖 Definition）
```

## 值得可视化的点

- 三角依赖：Def←Prov、Def←Cons、Prov↛Cons
- `declare module` 类型面 ∥ Cordis 运行时服务表
- Request→Spec→Result 三阶段

## 易误读点/坑

- seam ≠ 单个接口；`@cordisjs/plugin-capability` 是权限语义，不是本三角。
- LLM 可折叠 Definition+Consumer（`dsh-llm`）；可选服务用 `ctx.get`，已 inject 用 `ctx.x`。

---

# packages/shell（全家深挖）

## 关键文件清单

| 相对路径 | 职责 |
|---|---|
| `packages/shell/shell/src/types.ts` | Request/Spec/Result/Process 词汇 |
| `packages/shell/shell/src/index.ts` | `ShellExecutor` + settings namespace |
| `packages/shell/bash-local/src/index.ts` | Provider：`bash -c` + subprocess |
| `packages/shell/pwsh-local/src/index.ts` | Provider：`pwsh -Command` + UTF-8 preamble |
| `packages/shell/bash-sandbox/` / `pwsh-sandbox/` | 沙箱 Provider（继承 local） |
| `packages/shell/tool-bash/src/index.ts` | Consumer：工具、审批、render intent |
| `packages/shell/tool-bash/src/render.ts` | 模型可见文本与 markers |
| `packages/shell/shell-env/src/index.ts` | `ctx.shellEnv` 收集可信 `DSH_*` |
| `packages/core/agent-loop/src/tool-calls.ts` | tool_call → prepare/dispatch |
| `packages/core/tools/src/index.ts` | 工具调度器与 `output.render` |

## 核心代码摘录

### Request（可省略）vs Spec（已填齐）

```38:44:packages/shell/shell/src/types.ts
export interface ShellExecRequest {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
```

```86:90:packages/shell/shell/src/types.ts
export interface ShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
```

解读：`stdin`/`env`/`dshEnv` 仅 hooks 等可信调用方；模型工具 schema 不暴露。

### Provider `resolve` + `runArgv`

```146:158:packages/shell/bash-local/src/index.ts
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'bash-local: request.timeoutMs',
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
```

```223:231:packages/shell/bash-local/src/index.ts
  protected async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    // One deadline combines timeout and upstream cancellation; disposal clears its timer.
    using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, d.signal))
    const outcome = await handle.done
    const collected = LocalBashExecutor.collected(handle)
    // Only this executor's timeout reason counts as timedOut; outer deadlines count as aborts.
    const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
```

解读：`run()` → `runArgv(..., ['bash','-c',cmd])`。`timedOut`/`aborted` 互斥（先触发者）。

### pwsh：同一 Spec，不同 argv

```218:219:packages/shell/pwsh-local/src/index.ts
  protected argv(spec: ShellExecSpec): string[] {
    return [this.pwshPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${spec.command}`]
  }
```

解读：命令为**单个** argv 元素；无中间 shell 引号层。

### Consumer：render intent + resolve/run

```102:117:packages/shell/tool-bash/src/index.ts
function presentBashCall(args: BashCallArgs): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...args.workdir !== undefined ? { cwd: args.workdir } : {},
  }
}
```

```380:389:packages/shell/tool-bash/src/index.ts
      const result = await ctx.shell.run(ctx.shell.resolve({
        ...request,
        signal: exec.signal,
      }))
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return { kind: 'foreground' as const, ...canonicalBashResult(result) }
```

解读：核心句 `run(resolve(...))`。升级沙箱先 `approveEscalation`；非零 exit 不当 isError。

```53:58:packages/shell/tool-bash/src/render.ts
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
```

### Loop → tools → body → render

```164:173:packages/core/agent-loop/src/tool-calls.ts
  const startCall = async (index: number): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
    const call = group[index]!
    callSeqs[index] = appendToolCall(session, turn, step, call.block)
    started++
    const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
    throwSchedulerFailure()
    switch (prepared.kind) {
      case 'dispatch': {
```

```1475:1478:packages/core/tools/src/index.ts
      const gate = await this.ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
```

```1548:1550:packages/core/tools/src/index.ts
      state.bodyInvoked = true
      const returned = await tool.execute(exec.arguments, exec)
      const result = this.createSuccessResult(exec, tool, returned)
```

```1799:1800:packages/core/tools/src/index.ts
    try {
      rendered = tool.output.render(exec.arguments, value)
```

## 执行流程（bash 工具调用时序素材）

```mermaid
sequenceDiagram
  participant Model
  participant Loop as agent-loop
  participant Sess as Session
  participant Tools as ToolRuntime
  participant Bash as tool-bash
  participant Shell as ctx.shell
  participant Sub as ctx.subprocess

  Model->>Loop: tool-call(bash, args)
  Loop->>Sess: append tool/call
  Loop->>Tools: prepare → pre-execute waterfall
  alt deny
    Tools-->>Loop: error result
  else allow
    Loop->>Tools: dispatch → tools/execute wrappers
    Tools->>Bash: execute
    opt sandbox_permissions
      Bash->>Bash: approveEscalation
    end
    Bash->>Shell: resolve(request) then run(Spec)
    Shell->>Sub: spawn(bash -c)
    Sub-->>Bash: ShellRunResult
    Bash-->>Tools: foreground DTO
    Tools->>Tools: output.render
    Tools-->>Loop: ToolExecutionResult
  end
  Loop->>Sess: append tool/result
```

后台：`jobs.start` → `shell.start(resolve(req))` → 立即 `jobId`；读/杀走 `job_output`/`job_kill`。

## 值得可视化的点

- Request/Spec 字段 diff；env 序：`scrubbedParentEnv`→`ENV_OVERRIDES`→`env`→`dshEnv`
- 前台 `terminal` vs 后台 `generic` 卡；`timedOut`↔`aborted` 决策树
- shell→subprocess→（可选）sandbox.confine

## 易误读点/坑

- 非零 exit ≠ tool isError；`bash-local` 惰性携带 `sandboxPolicy`（不沙箱则忽略）。
- 后台忽略 `timeoutMs`；schema 省略后仍须在 execute 二次 enforce。
- 进程组生命周期挂 `ctx.subprocess` disposal，不是 executor 热重载。

---

# 横向能力包概览

## packages/fs

关键：`fs/fs`（`ctx.fs` + `fs/write-intent|edit-intent|observed`）、`fs-local`、`fs-sandbox`、`fs-observation-policy`、`tool-fs`。

```44:47:packages/fs/fs/src/index.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FileSystem
  }
```

观察策略按 session WeakMap 记已读版本；写/改经 intent waterfall 做 CAS/`createIfAbsent`。`fs-sandbox` 覆盖 `sandboxMode`，mutation 前 `checkedTarget`；白名单根来自每调用 `sandboxPolicy`（对称 bash escalation）。

## packages/llm

关键：`llm/llm`（`LlmRuntime` + `llm/stream`）、`llm-deepseek`、`llm-retry`。Definition+registry 同包；Adapters 为 Provider；agent-loop 为折叠 Consumer。

```913:926:packages/llm/llm/src/index.ts
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithRegistration(options)
  }

  private streamWithRegistration(
    options: GenerateOptions,
    prepared?: { registration: AdapterRegistration; config: LlmCallConfig },
  ): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(
      this,
      'llm/stream',
      options,
      () => this.adapterStream(options, prepared),
    )
```

Loop 请求深冻结 + `markAgentLoopRequest`；listener 只读——「模型可见 ⟺ session 可重建」。DeepSeek `adapter.stream` 产出 `StreamChunk`。

## packages/subprocess

`ctx.subprocess`：进程树、stdio collect/spill、凭据 scrub（`SENSITIVE_ENV_PATTERN` + 剥 `DSH_*`）。shell/terminal/hooks/lsp 的 Consumer。**不含** shell 语义与默认超时。

## packages/web

具体 registry `WebRuntime`：注册 search/fetch Provider；执行时按配置 id 或「恰好一个可用」选择，禁止依赖注册序。Consumer：`tool-web`。凭据请求禁自动重定向。

## packages/terminal

`ctx.terminals`：id/鉴权/清理；backend（`terminal-bash`）管 PTY。与一次性 `shell.run` 正交（持久会话）。Consumer：`tool-terminal`。

## packages/skill

`ctx.skills` 合并多 Provider catalog（rank+注册序）；`skill-filesystem` 落地；`tool-skill` 加载。`skills/change` 仅失效通知。

## packages/workflow

`ctx.workflowEngine` + 观察事件 `workflow/start|phase|log|agent-*|end`。Provider：`workflow-worker-thread`。Consumer：`tool-workflow`。事件只观察、不控 run。

## packages/todo / plan / guard

- **todo**：纯 Consumer，`todo_write` 整表替换写 session；无独立 Definition。
- **plan**：`ctx.planMode`，状态折叠自 `plan/mode` 事件；`exit_plan_mode` 始终注册；沙箱/审批不读 plan。
- **guard**：`timeout-policy`（`tools/execute`→`TOOL_TIMEOUT`）、`repeat-tool-reminder`（advisory，不 veto）——**pipeline 插件，非 seam**。

---

# packages/context 与 packages/hooks

## 关键文件清单

| 相对路径 | 职责 |
|---|---|
| `packages/context/agent-instructions/src/index.ts` | AGENTS.md 基线 + fs touch 增量 |
| `packages/context/time-context/src/index.ts` | 时钟上下文注入 pre-step |
| `packages/hooks/hook-protocol/src/runner.ts` | 经 `ctx.shell` 跑 command hook |
| `packages/hooks/hooks-claude-code/src/index.ts` | CC hooks.json 桥（`inject:['shell']`） |
| `packages/hooks/hooks-codex/` | Codex 方言桥 |

## 核心代码摘录

```67:87:packages/hooks/hook-protocol/src/runner.ts
export async function runHook(
  bash: ShellExecutor,
  hook: CommandHook,
  options: RunHookOptions,
  now: () => number,
): Promise<RunHookResult> {
  const started = now()
  const timeoutMs = hook.timeoutSec !== undefined ? hook.timeoutSec * 1000 : options.defaultTimeoutMs
  const stdin = JSON.stringify(options.payload) + (options.trailingNewline ? '\n' : '')

  const request = {
    command: hook.command,
    timeoutMs,
    stdin,
    signal: options.signal,
    ...options.cwd !== undefined ? { workdir: options.cwd } : {},
    ...options.env !== undefined ? { env: options.env } : {},
  }

  try {
    const result = await bash.run(bash.resolve(request))
```

```39:42:packages/hooks/hooks-claude-code/src/index.ts
export const name = 'hooks-claude-code'
// `bash` is required to run hooks; the rest are read opportunistically via
// ctx.get so a deployment can load this bridge without every extension point present.
export const inject = ['shell']
```

解读：hooks 是 shell Consumer（可信 stdin/env）；基础设施失败变为非阻塞 outcome。context 插件挂 pre-step/post-execute，写入带 `source` 的 durable UserMessage（改模型输入必须可从 session 重建）。

## 执行流程

```
tools/pre-execute → match hooks → runHook(shell) → merge → allow|deny|ask
tools/post-execute → PostToolUse（可 detached）
```

## 值得可视化的点

- 方言 JSON → hook-protocol → shell 分层；context「文件触摸→下一轮 prompt」

## 易误读点/坑

- hooks `stdin`/`env` 模型工具故意不暴露；CC `updatedInput` 只记不生效。

---

# 总览速查

| 能力 | `ctx.*` | Provider | Consumer | 备注 |
|---|---|---|---|---|
| shell | 抽象类 | bash/pwsh ±sandbox | tool-bash/hooks | request/spec 样板 |
| subprocess | 抽象类 | local/e2b | shell/terminal… | 更底层 |
| fs | 抽象类 | local/sandbox | tool-fs+policy | intent 事件 |
| llm | 具体 registry | deepseek/… | agent-loop（折叠） | `llm/stream` |
| web | 具体 registry | search/fetch | tool-web | 执行时选 Provider |
| terminal | terminals | terminal-bash | tool-terminal | 持久 PTY |
| skill | skills | filesystem | tool-skill | catalog 合并 |
| workflow | workflowEngine | worker-thread | tool-workflow | 观察事件 |
| todo/plan | 弱/有限 | — | tool-todo/plan-mode | session 状态 |
| guard | — | — | timeout/repeat | 非 seam |
