# Cordis 插件内核与 dsh 装配链路

面向中文源码分析站点的研究笔记：从 vendored Cordis 的 `Context` / `effect` / 事件 / Fiber，到 Loader 插件树，再到 `dsh --profile` 四层 patch 装配与 `packages/core` 的注册约定。

---

## 关键文件清单

- `vendor/cordis/src/context.ts` — 根/子 Context（Proxy、`extend`/`isolate`/`intercept`）
- `vendor/cordis/src/reflect.ts` — 将 `effect`/`plugin`/`on`/`waterfall` mixin 到 `ctx`
- `vendor/cordis/src/events.ts` — `emit`/`parallel`/`serial`/`bail`/`waterfall`
- `vendor/cordis/src/fiber.ts` — Fiber 生命周期、`effect()`、依赖驱动 `_reload`/`_unload`
- `vendor/cordis/src/registry.ts` — `ctx.plugin()`/`inject()`；function / class / `{ apply }`
- `vendor/loader/src/index.ts` — Loader：`internal/config` 插值、`fiber.entry` 绑定
- `vendor/loader/src/config/entry.ts` — Entry：`disabled`/`!!js`、`init`→`registry.plugin`
- `vendor/loader/src/config/utils.ts` — `evaluate` / `interpolate` / `isJsExpr`
- `vendor/loader/src/config/tree.ts` — `EntryTree.create`
- `vendor/include/src/index.ts` — YAML `!!js`、`applyEntryPatches`、Include
- `packages/boot/app-boot/src/profile.ts` — Profile / bundle / `composeEntries`
- `packages/boot/app-boot/src/index.ts` — `boot()` / `mountRootInclude` / 激活审计
- `apps/cli/src/{args,profile-boot,bin}.ts` — `--profile`/`--patch` 解析与 `runProfile`
- `packages/bundle/base/cordis.patch.yml` — `dsh-base` 插入 core 行
- `packages/core/{agent,tools,system-prompt,agent-loop}/src/index.ts` — 注册入口
- `packages/core/scope/src/store.ts` — `ScopedLayers.effect`
- `packages/preset/agent-presets/src/mount.ts` — 会话级 preset Include

---

## 核心代码摘录

### 1. Context 根对象：Proxy + 子作用域

```70:84:vendor/cordis/src/context.ts
  /** Create the root context and install the built-in services. */
  constructor() {
    this[symbols.isolate] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    const self = new Proxy<this>(this, ReflectService.handler)
    this.root = self
    this.baseUrl = undefined
    this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
    this.reflect = new ReflectService(self)
    this.registry = new RegistryService(self)
    this.events = new EventsService(self)
    this.logger = new LoggerService(self)
    this.fiber._disposables.clear()
    return self
  }
```

**解读：** 构造函数返回的是 Proxy，不是裸实例；根 Fiber 的 `runtime` 为 `null`。`extend` / `isolate` / `intercept`（同文件 99–145 行）只创建子 Context，不改父对象。读服务走反射层，写隔离标签走 `symbols.isolate`。

### 2. `ctx.effect` 从哪来：mixin

```219:222:vendor/cordis/src/reflect.ts
    this.mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'])
    this.mixin('fiber', ['runtime', 'effect'])
    this.mixin('registry', ['inject', 'plugin'])
    this.mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'])
```

**解读：** `ctx.effect(...)` ≡ `ctx.fiber.effect(...)`；`ctx.on` / `ctx.waterfall` 同理。仓库约定「注册即副作用」的技术落点在此 mixin。

### 3. `Fiber.effect`：立即执行、反向清理、UNLOADING 拒绝新建

```415:422:vendor/cordis/src/fiber.ts
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  /** Same as above for async effects; the disposer is also awaitable. */
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  effect(execute: () => Effect, label = 'anonymous'): any {
    this.assertActive()
    if (this.state === FiberState.UNLOADING) {
      throw new CordisError('INACTIVE_EFFECT')
    }
```

```517:522:vendor/cordis/src/fiber.ts
    // Make the effect visible to a reentrant owner unload before execute()
    // runs any plugin code. Async teardown stays owner-visible until it
    // settles, allowing an outer effect to join cleanup another caller began.
    removeWrapper = this._disposables.push(wrapper)
    try {
      task = this._execute(runner)
```

**解读：** `execute` 立即跑；disposer（含 generator 的多个 yield）被收集，卸载时逆序调用（427–441 行）。wrapper 先入 `_disposables` 再 setup（防 reentrant unload，见 `vendor/README.md`）。`UNLOADING` 时禁止新建 effect。

### 4. 事件：`waterfall` 与「必须 `next()`」

```224:243:vendor/cordis/src/events.ts
  waterfall(...args: any[]) {
    const cbs = this.dispatch('waterfall', args)
    const inner = args.pop()
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb(...args)
    }
    args.push(next)
    return next()
  }
```

```76:81:vendor/cordis/src/events.ts
    /**
     * Dispatch an event whose last argument is a `next` continuation.
     *
     * Each listener wraps the rest of the chain: calling `next()` invokes the
     * next listener (finally the built-in behavior); not calling it vetoes.
```

**解读：** 最后一个参数是最内层 `next`（通常是内建行为）。监听器若不调用传入的 `next`，整条链（含内建）被 veto。对比：`serial`/`bail` 用「返回值是否 bail」短路；`emit` 火后不管。`ctx.on` 自身也经 `fiber.effect` 注册（254–259 行），故 fiber 卸载自动摘监听器。

五种模式一览（类型注释 27–31 行）：`emit` 同步不等待；`parallel` 并发 await；`serial` 顺序 await 直至 bail；`bail` 同步直至 bail；`waterfall` 洋葱包装。

### 5. 插件启动：`registry.plugin` → Fiber → callback/`apply`

```316:335:vendor/cordis/src/registry.ts
  plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
    // check if it's a valid plugin
    const callback = this.resolve(plugin)
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    this.ctx.fiber.assertActive()

    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      if (name === 'apply') name = undefined
      runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
      this._internal.set(callback, runtime)
    }

    const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }
```

Fiber 内真正调用插件体：

```247:261:vendor/cordis/src/fiber.ts
      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: function () {
          if (isConstructor(runtime.callback)) {
            // eslint-disable-next-line new-cap
            const instance = new runtime.callback(this.ctx, this.config)
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook()
            }
            return instance?.[symbols.init]?.()
          } else {
            return runtime.callback(this.ctx, this.config)
          }
        },
        collect,
      }
```

**解读：** `resolve` 对 `{ apply }` 取 `plugin.apply`（registry 222–227 行）。依赖注入：fiber 的 `inject` 未齐时 epoch 为 `INACTIVE`，`_setEpoch` 触发 `_unload`；服务齐后 `_reload` → `_execute`（fiber 625–673、641–644 行）。配置经 `internal/config` waterfall（641–643 行）。

**没有 `loader.start()`：** 当前 vendored Loader 用 `Entry.init` → `_start` → `ctx.registry.plugin`。漫画/科普里的 `ctx.loader.start()` 不是本仓库 API；运行时创建行用 `ctx.loader.create(...)`（`EntryTree.create`，tree.ts 97–104 行）。

### 6. Loader Entry：disabled 的 `!!js`、挂载路径

```100:108:vendor/loader/src/config/entry.ts
  /**
   * Effective disabled state: a `!!js` expression evaluates against the loader
   * context. The raw node stays in the options, so write-back keeps the form.
   */
  private disabledOf(options: EntryOptions): boolean {
    return isJsExpr(options.disabled)
      ? Boolean(this.evaluate(options.disabled.__jsExpr))
      : Boolean(options.disabled)
  }
```

```291:301:vendor/loader/src/config/entry.ts
  private async _start(plugin: any) {
    let fiber: Fiber | undefined
    try {
      await this._patchContext([])
      this.loader.showLog(this, 'apply')
      fiber = this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
      await fiber.await()
    } catch (error) {
      await this._dispose(fiber)
      throw error
    }
  }
```

Loader 对**非 Group 载体**的 config 做插值（注入激活后）：

```92:101:vendor/loader/src/index.ts
    ctx.on('internal/config', function (this: Fiber, _config, next) {
      const config = next()
      if (!this.entry || this.parent.fiber?.entry === this.entry) return config
      // Tree carriers (Group, Include) keep their configs literal: their
      // entry and patch lists hold other rows' configs, whose `!!js`
      // expressions belong to those rows' own fibers.
      const plugin = this.runtime?.callback as Record<PropertyKey, unknown> | undefined
      if (plugin?.[EntryGroup.key]) return config
      return interpolate(this.ctx, config)
    }, { global: true })
```

`!!js` YAML 方言与求值：

```9:15:vendor/include/src/index.ts
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})
```

```4:21:vendor/loader/src/config/utils.ts
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`) as ((ctx: object, expr: string) => any)

/** Recursively replace YAML `!js` expression nodes with evaluated values. */
export function interpolate(ctx: object, value: any) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
```

**解读：** 写作 `!!js ...`（YAML 二次标签），解析为 `{ __jsExpr }`。合法域：条目 `config`（插件 ctx 插值）与 `disabled`（loader ctx 求值）。`id`/`name`/`inject` 等元数据保持字面——字面 `!!js` 对象会当 truthy，历史事故见 `docs/postmortem/0002-*`（彼时 `disabled` 尚未求值；**当前代码已对 disabled 求值**，但其它元数据仍禁止表达式）。

### 7. Patch 语义与四层叠加

`applyEntryPatches`（include）：空根上按 id 覆盖字段，或 `insert` 往根/group 插入；同层后插入的行可被同层后续 patch 命中（58–125 行）。

Profile 模板与加载：

```113:117:packages/boot/app-boot/src/profile.ts
/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}
```

```413:419:packages/boot/app-boot/src/profile.ts
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
```

运行时叠加顺序（`apps/cli/src/profile-boot.ts`）：

```121:128:apps/cli/src/profile-boot.ts
/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}
```

即：**profile bundles（有序）→ `$DSH_HOME/profiles/<name>/cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`（可重复）**；另有 telemetry / agent-presets 等 launcher 派生 overlay（同文件 142–170 行）。

CLI 解析：

```131:132:apps/cli/src/args.ts
    .option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
```

```29:37:apps/cli/src/bin.ts
switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
```

`boot()` 装配：

```757:785:packages/boot/app-boot/src/index.ts
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context> {
  const ctx = new Context()
  // Two failure labels: `prepare` runs before any config-tree entry mounts,
  // so its failure is host setup, not the plugin tree.
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
    ctx.provide('dshHomePath', dshHomePath)
    await ctx.plugin(Loader)
    await prepare?.(ctx)
    stage = 'plugin tree failed to load'
    await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)
    await ctx.get('loader')?.await()
    if (ctx.get('loader') === undefined) return ctx
    await assertEntriesActivated(ctx, binName)
    return ctx
```

Profile 根 `cordis.yml` 故意恒为空数组（profile-boot 59–64、98–102 行）：整棵树由 patch 层「插入」而成；`baseUrl` 仍锚定在 profile 目录以便解析。

`dsh-base` 插入核心行示例：

```58:59:packages/bundle/base/cordis.patch.yml
    - id: agent
      name: '@deepseek-ai/dsh-agent'
```

```424:437:packages/bundle/base/cordis.patch.yml
    - id: tools
      name: '@deepseek-ai/dsh-tools'
    # ...
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
      config:
        persona: ''
    - id: agent-loop
      name: '@deepseek-ai/dsh-agent-loop'
      config:
        agents: []
```

### 8. `packages/core`：注册一律经 effect / ScopedLayers

Agent registry：

```372:381:packages/core/agent/src/index.ts
  setFactory(factory: AgentFactory): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
      this.factory = { target }
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
```

```450:454:packages/core/agent/src/index.ts
  register(agent: Agent): () => void {
    const dispose = this.ctx.effect(function* (this: AgentRegistry) {
      yield this.enter(agent, this.ctx.agent)
      this.announce(agent)
    }.bind(this), 'agents.register()')
```

Agent-loop 挂 factory：

```349:353:packages/core/agent-loop/src/index.ts
    ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
```

Tools / SystemPrompt 经作用域层：

```1037:1061:packages/core/tools/src/index.ts
  register(definition: ToolDefinition): () => void {
    // ...
    return this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, definition),
      { label: 'tools.register()' },
    )
  }
```

```381:389:packages/core/system-prompt/src/index.ts
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }
```

```227:233:packages/core/scope/src/store.ts
  effect(
    ctx: Context,
    action: (layer: L) => () => void,
    options: { label: string; notify?: boolean },
  ): () => void {
    const scope = scopeOf(ctx)
    const notify = options.notify ?? true
    const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
```

**解读：** 全局注册挂在服务 fiber；在 `agent.ctx`（scoped）上注册则写入该 scope 的 layer，随 agent/preset 卸载回滚。Preset 在 agent 作用域再挂 Include（`packages/preset/agent-presets/src/mount.ts`），使 preset 内工具/prompt 自然归入该会话层。

---

## 执行流程

### 时序图素材：`dsh --profile web --patch extra.yml`

**参与者：** User · `bin.ts` · `args.ts` · `profile-boot` · `app-boot.boot` · `Context` · `Loader` · `Include` · `Entry` · `Registry` · `Fiber` · 各插件 Service

**消息序列（摘要）：**

1. User → `bin`：argv  
2. `bin` → `parseDshArgs`：得到 `{ mode:'profile', profile, patches, args }`  
3. `runProfile` → `prepareProfile` / `loadProfile`：解析 bundles 的 `cordis.patch.yml` + profile/home/`--patch`  
4. `allPatches` 展平 → `boot(NAME, profile/cordis.yml, patches, prepare)`  
5. `new Context()` → `ctx.plugin(Loader)` → `prepare`（`provideCmdline`、环境快照）  
6. `mountRootInclude`：`loader.create({ name:'cordis:include', config:{ path, patches }})`  
7. Include 读空根 + `applyEntryPatches` → `EntryGroup.update` 创建各 Entry  
8. 每 Entry：`import(name)` → `_start` → `registry.plugin` → Fiber 等 inject → ACTIVE → 插件内 `ctx.effect`/`register`  
9. `loader.await` + `assertEntriesActivated`  
10. 可选：`watchUserPatches` 热更新 profile/home patch  

### 活动图步骤：waterfall 一次策略链

1. 生产者调用 `ctx.waterfall('tools/pre-execute', ..., defaultNext)`  
2. `EventsService.waterfall` 弹出 inner，构造链式 `next`  
3. 监听器 A：改决策对象后 `return next()`  
4. 监听器 B：拒绝 → **不调** `next()`，直接返回否决结果  
5. 若全员委托 → 执行 inner（真实执行）  

### 活动图步骤：Fiber 依赖驱动

1. Fiber 创建，epoch=`INACTIVE`（缺服务）→ PENDING  
2. 所需 `provide` 出现 → `_setEpoch` 非 INACTIVE → LOADING → `_reload` → 跑 callback  
3. 成功 → ACTIVE；抛错 → FAILED  
4. dispose / 缺依赖 → UNLOADING → 逆序跑 disposers → DISPOSED 或再 PENDING  

---

## 值得可视化的点

1. Context 同心圆（Proxy → isolate/intercept → `fiber.entry`）与 Effect 栈（注册序 / 清理逆序 / disposer 身份）。  
2. 事件五模式 + waterfall 洋葱图（最内层 = 内建 `next`）。  
3. 四层地质剖面：bundles → profile patch → home patch → `--patch`（与 `--dump-config` 同源）。  
4. CLI→boot→Include→Entry 并发激活时序（依赖图 ≠ YAML 行序）。  
5. ScopedLayers：全局层 vs agent/preset；科普 `loader.start()` vs 真 API `create`/`init`/`dispose`。

---

## 易误读点 / 坑

1. **`ctx.loader.start()` 不存在** — 对齐 `Entry.init` / `registry.plugin` / `loader.create`；换插件是 dispose + create/update。  
2. **Waterfall 不调 `next()` = 故意 veto** — 只注解的监听器必须委托。  
3. **`!!js` ≠ `!js`；仅 `config`/`disabled`** — 其它元数据上的表达式对象曾导致永久 disabled（postmortem 0002）；Group/Include 的 config 不插值。  
4. **函数插件勿 default export** — 会丢 `inject` 命名空间（postmortem 0001）；可选服务用 `ctx.get`。  
5. **Patch 整字段覆盖** — 非 deep merge；mode 值放 mode bundle。Profile 根 `cordis.yml` 每次 boot 写成 `[]`，真树是 patch 叠加。  
6. **Launcher 标志须在前** — 首个未知 token 起属 app；`--patch` 可重复 collector。  
7. **Disposer Exact identity** — 勿包装 `agents.register`/`setFactory` 返回值。行序 ≠ 激活拓扑。
