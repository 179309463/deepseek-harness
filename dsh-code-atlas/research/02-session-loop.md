# Session 事件日志 + Agent Loop 主循环

教学焦点：append-only 会话日志如何成为模型可见历史的唯一真相源；`ReactLoopAgent` 如何把 turn/step/inbox 编排成可重建请求；compaction 如何用 surface `replace` 瘦身。

---

## 关键文件清单

| 相对路径 | 职责 |
| --- | --- |
| `packages/core/session/src/types.ts` | `SessionEventMap`、`SESSION_FORMAT_VERSION`、`SurfaceOp`、信封 |
| `packages/core/session/src/index.ts` | `Session.append` / `deriveMessages`；`session/event`·`flush` |
| `packages/core/session/src/surface.ts` | surface 投影：`deriveEventMessage` |
| `packages/core/session/src/invariant.ts` | turn/step/`tool/call`↔`tool/result` 关系不变量 |
| `packages/core/session/src/known-event-types.ts` | 本仓库全部事件类型（生成；未知非 ignorable 拒载） |
| `packages/core/agent/src/types.ts` | `agent/inbox/spliced` declaration merging |
| `packages/core/agent/src/inbox.ts` | `Inbox.claim` / durable splice |
| `packages/core/agent/src/runtime-types.ts` | `agent/pre-step`、`agent/turn-stopping` 等扩展点 |
| `packages/core/agent-loop/src/agent.ts` | `ReactLoopAgent` 主循环 |
| `packages/core/agent-loop/src/tool-calls.ts` | 一步工具调度与 `tool/call`·`tool/result` 落盘 |
| `packages/core/agent-loop/src/invariant.ts` | **model-visible ⟺ logged**（`llm/stream` 重建校验） |
| `packages/core/tools/src/index.ts` | `tools/pre-execute` / `tools/execute` |
| `packages/core/tools/src/presentation.ts` | `presentCall`/`presentResult` 渲染意图 |
| `packages/session/session-persistence/src/coordinator.ts` | 持久化编排；按日志格式版拒载 |
| `packages/session/session-persistence-sqlite/src/index.ts` | SQLite 后端（`SCHEMA_VERSION` 独立） |
| `packages/session/session-persistence-jsonl/src/index.ts` | JSONL 后端（每会话文件） |
| `packages/session/session-projection/src/index.ts` | `ctx.sessionProjections` eager 驱动 |
| `packages/session/session-title/src/index.ts` | `session/title` + title projection |
| `packages/session/session-telemetry/src/coordinator.ts` | 订阅 `session/event` 投影遥测 |
| `packages/compaction/compaction/src/index.ts` | Compaction Service Definition |
| `packages/compaction/compaction/src/types.ts` | `compaction/*` SessionEventMap 合并 |
| `packages/compaction/compaction-basic/src/{index,region,summarizer}.ts` | basic：pressure/overflow、prune、LLM 摘要事务 |

---

## 核心代码摘录

### 1. 版本与核心事件地图

```56:56:packages/core/session/src/types.ts
export const SESSION_FORMAT_VERSION = 0
```

（完整 bump 规则见同文件 34–55 行 JSDoc。）

**解读：** 日志信封版固定 `0`。加普通事件类型不 bump（靠 `ignorable`）；结构性变更才 bump。SQLite 另有 `SCHEMA_VERSION`（当前 15），是**存储 schema**，与日志格式版正交。

```243:243:packages/core/session/src/types.ts
  'turn/start': { turn: number }
```

```252:256:packages/core/session/src/types.ts
  'turn/end': { turn: number; reason: TurnEndReason }
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': { turn: number; step: number }
  /** Closes step `step` of turn `turn`. */
  'step/end': { turn: number; step: number }
```

（`turn/end` 的 JSDoc 244–251 行明确：loop **不在 turn 边界 await flush**。）

```343:346:packages/core/session/src/types.ts
export type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
```

```372:374:packages/core/session/src/types.ts
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }
```

**解读：** 核心地图另有 `user/message`、`assistant/chunk|message`、`tool/call|result`、`todo/write`、`request/header|context`、`session/end-seed`（见同文件 257–332）。仅三类进 surface；`replace` 由 compaction 使用。

### 2. Declaration merging

```12:26:packages/core/agent/src/types.ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * Live dispatch precedes projection mutation, so synchronous observers may
     * read the pre-splice inbox to recover the removed messages.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}
```

```19:23:packages/compaction/compaction/src/types.ts
    /**
     * Marks the start of a compaction — log-only, holds the lock until
     * `compaction/end`. A numbered owner is strictly enclosed by that open turn;
     * `null` identifies a standalone manual transaction between turns.
     */
    'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }
```


**解读：** 必须合并到 `@deepseek-ai/dsh-session/types`（非根包）。同文件还有 `compaction/summary|end|prune`；title 合并 `session/title`。加载用生成的 `KNOWN_SESSION_EVENT_TYPES`。

### 3. Append、surface 派生、invariant

```643:648:packages/core/session/src/index.ts
      this.log.push(event as SessionEvent)
      this.eventsSnapshot = undefined
      if (callbacks !== undefined && entry !== undefined) {
        invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
      }
      return event
```

```726:746:packages/core/session/src/index.ts
  deriveMessages(): Message[] {
    const surface = this.surface
    const nodes = surface.nodes
    const generation = surface.replaceGeneration
    if (generation !== this.derivedGeneration) {
      this.derived = []
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }
    for (const seq of nodes.slice(this.derivedNodes)) {
      // Surface sequences are built from this.log — seq is always a valid
      // index by construction. The non-null assertion expresses that invariant.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const msg = this.deriveEventMessage(this.log[seq]!)
      // A surface node is one of the five message-producing types, but an
      // empty-content assistant/message (a max-tokens step that hosts only
      // usage) derives to null and must not enter the transcript.
      if (msg) this.derived.push(msg)
    }
    this.derivedNodes = nodes.length
    return [...this.derived]
  }
```

```97:108:packages/core/session/src/surface.ts
    case 'user/message': {
      return event.data
    }
    case 'assistant/message': {
      // Skip an empty-content assistant/message: it exists only to host a
      // max-tokens step's usage and must not inject a content-less assistant
      // turn into the provider transcript.
      if (event.data.message.content.length === 0) return null
      return event.data.message
    }
    case 'tool/result': {
      return event.data.message
    }
```

```21:42:packages/core/agent-loop/src/invariant.ts
  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    if (!isAgentLoopRequest(options)) return next()
    if (!Object.isFrozen(options)) fail('a loop-built request must be frozen')
    if (options.sessionId === undefined) fail('a loop-built request must carry a session id')
    const session = ctx.sessions.get(options.sessionId)
    if (!session) fail(`a loop-built request must carry a live session id, got "${String(options.sessionId)}"`)
    if (!Object.isFrozen(options.messages)) {
      fail('a loop-built request must carry a frozen messages array')
    }

    const events = session.events
    if (!events.some(event => event.type === 'step/start')) {
      return fail('a loop-built request with no step/start in its session log')
    }
    const header = foldRequestHeader(events)
    if (header === undefined) {
      return fail('a loop-built request with no request/header event in its session log')
    }
    const expected = session.deriveMessages()
    if (JSON.stringify(options.messages) !== JSON.stringify(expected)) {
      fail(`llm request for session "${String(session.id)}" diverges from the dispatch-time durable derivation (log-reconstruction desync)`)
    }
```

**解读：** append 热路径不阻塞 I/O；持久化订阅 `session/event`，耐久靠 `session/flush`。Invariant 在 `llm/stream`（`prepend: true`）上断言：loop 请求的 `messages` ≡ 此刻 `deriveMessages()`，且对齐已折叠 `request/header`。这不是「凡进模型的都有事件」的字面扫描，而是**请求可从日志重建**。

### 4. Inbox 与 ReactLoopAgent

```71:78:packages/core/agent/src/inbox.ts
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') {
      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    }
    for (const message of claimed) this.notifications.claimed(message, turn)
    return claimed
  }
```

```234:240:packages/core/agent-loop/src/agent.ts
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
```

```265:293:packages/core/agent-loop/src/agent.ts
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          const stepEnd = await this.step(decision.assembly)
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
```

```295:319:packages/core/agent-loop/src/agent.ts
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
```

```347:351:packages/core/agent-loop/src/agent.ts
      for await (const chunk of stream) {
        signal.throwIfAborted()
        chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
        assembler.push(chunk)
      }
```

```381:399:packages/core/agent-loop/src/agent.ts
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
      )
      return concluded ? { kind: 'completed' } : null
```

失败路径走 `agent/request-error` waterfall（同文件 354–370）；`buildRequest` 写 `request/header|context`（458–483）。

**解读：** `next-turn` = 每人一轮提示；`next-step` = 同 turn 步进（steer/inject/工具上下文）。首 step `claim('next-turn')`，后续 `claim('next-step')`。`agent/turn-stopping` 是 **serial**（靠 steer 改数据，非 waterfall 否决）。`buildRequest` 内写 `request/header|context`（见 `agent.ts` 458–483）。

### 5. 工具管线 ↔ 落盘

```1475:1478:packages/core/tools/src/index.ts
      const gate = await this.ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
```

`ask` / deny 物化为 `post-result` 错误结果（同文件 1479–1503）；body 经：

```1573:1576:packages/core/tools/src/index.ts
      const result = await this.ctx.waterfall(
        carrier, 'tools/execute', mutableExec,
        () => this.dispatchToolBody(mutableExec),
      )
```

```262:288:packages/core/agent-loop/src/tool-calls.ts
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): number {
  const event = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}

/** Append a model-ordered result linked to its call event. */
function appendToolResult(
  session: Session,
  turn: number,
  step: number,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: number,
): void {
  const message = createToolResultMessage({
    callId: block.id,
    content: result.content,
    isError: result.isError,
  })
  session.append('tool/result', {
    turn, step,
    message,
    ...result.error?.info ? { error: result.error.info } : {},
    // The tool's private presentation payload (e.g. a result-time diff),
    // persisted so a UI bridge reproduces the card on replay.
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
```

**解读：** `tool/call` 非 surface；`tool/result` 进 surface 并引用 call seq。超时由 `timeoutMs` + `tools/execute` wrapper 策略插件执行。UI：`presentCall`/`presentResult` → `card: generic|terminal|diff`；`meta` 随 result 持久化。

### 6. 持久化 / projection / title / telemetry（要点）

- **核心 Session 不写盘**；`PersistenceCoordinator` 按 `SESSION_FORMAT_VERSION` 拒异版；后端可选 **SQLite**（行存，`SCHEMA_VERSION`）或 **JSONL**（每会话文件，zstd/pack chunks）。
- **Projection**：`init/apply/view` 纯函数；框架在 committed `session/event` 上 eager 驱动；状态事件须 whole-value。
- **Title**：合并 `session/title`（log-only，latest-wins）。
- **Telemetry**：订阅 `session/event` + `agent/error`，经 `session-telemetry/record` waterfall 交 backend。

### 7. Compaction

```147:165:packages/compaction/compaction-basic/src/index.ts
    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })
```

```281:291:packages/compaction/compaction-basic/src/index.ts
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }
```

压力路径同理先可选 prune，再 `selectCompactableRange` + `compactRegion`（同文件 303–323）。

```189:216:packages/compaction/compaction-basic/src/region.ts
  const startEvent = session.append('compaction/start', lifecycle)
  const assertStable: StabilityCheck = options.stability === 'whole-surface'
    ? assertWholeSurfaceUnchanged
    : assertSelectedSpanStable
  let failure: TransactionFailure | undefined
  let flushFailure: unknown
  let result: CompactionResult | undefined
  let closed = false
  let closing = false
  let stage: TransactionFailure['stage'] = 'summary'

  try {
    const prepared = prepareCompaction(dependencies, session, selection)
    const summarized = await summarizeCompaction(
      dependencies,
      prepared,
      agent,
      compactionId,
      options.sourceCommandId,
      signal,
    )
    if (options.owner === null) signal?.throwIfAborted()
    assertStable(dependencies, session, summarized)
    stage = 'commit'
    const pending = commitCompactionBody(session, startEvent, summarized)
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    result = completeCompaction(pending, endEvent)
```


**解读：** Definition = `CompactionEngine`。Basic：可选 prune → LLM 摘要（复用会话前缀保 KV cache）→ `compaction/summary` + `user/message(replace)`。锁是 durable `compaction/start`。

---

## 执行流程

### 参与者

`ReactLoopAgent` · `Inbox` · `Session` · Cordis（`agent/pre-step` waterfall、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`agent/turn-stopping` serial）· ToolRegistry · Persistence/Projection/Telemetry · 可选 `BasicCompactionEngine`

### 完整 turn 时序（1 step + 1 tool）

```
send/followup → agent/inbox/spliced
wakeDriver → kick → turn()
  turn/start
  claim → agent/inbox/spliced（删除）→ agent/inbox/claimed
  systemPrompt.assemble
  agent/pre-step          ← compaction 可在此 pressure
  step/start
  user/message (append)×N
  agent/request
  request/header (+ request/context?)
  llm/stream              ← invariant: messages ≡ deriveMessages
  assistant/chunk×N
  assistant/message (append, sourceEventSeqs=chunks)
  tool/call
  tools/pre-execute → tools/execute
  tool/result (append, sourceEventSeqs=[callSeq])
  step/end
  agent/turn-stopping     （next-step 空且已 concluded）
  turn/end (completed)
session/event → projection / telemetry / write-behind
（可选）session/flush
```

多 step：`step/end` 后 `target='next-step'`，不再 `turn/start`。

---

## 值得可视化的点

1. 全量日志 vs surface（replace 阴影）对照。
2. 一 turn 泳道：Cordis 事件名 vs Session 事件类型。
3. Inbox 双队列：send / steer / inject / claim。
4. 请求重建三角：`request/header` + `deriveMessages` + `llm/stream` invariant。
5. `tool/call` ↔ `tool/result` 配对；Compaction 事务条；两套版本号。

---

## 易误读点 / 坑

1. **model-visible ⟺ logged** = 请求可从日志重建，非「所有事件进模型」。
2. **`agent/turn-stopping` 是 serial**，用 `steer` 否决，不是不调 `next()`。
3. Turn 可无 step 仍有 `turn/start`+`turn/end`；**max-tokens sticky**。
4. Compaction `shadowedRange` 是位置跨度（`start` 可 > `end`）；自动须 open turn。
5. **Session 核心不写盘**；merging 必须写 `/types`；deny/abort 仍落盘 call/result。
6. `tool/call.arguments` 是模型原始 JSON **字符串**。

---

## 教学一句话

> Session 日志是唯一真相；surface 是模型可见投影；Agent Loop 按 turn/step 把 inbox 写成 surface 事件，并用 `llm/stream` invariant 保证发出的请求永远能从同一份日志折叠回来。
