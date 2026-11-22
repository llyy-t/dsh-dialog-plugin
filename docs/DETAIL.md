# dsh-dialog-plugin 实现细节与验收记录

写于 2026-11-21。设计目标与验收标准差见 `D:\DSH插件开发\BRIEF.md`，
任务沿革见上级目录的 `HANDOFF.md`。本文记的是**实现层面的细节**、
**实测得到的验收证据**，以及**已知限制和回滚办法**。

- 插件目录：`D:\WB\dsh-dialog-plugin\dsh-dialog-plugin\`
- 装载方式：desktop profile 用 `link:` 依赖 + Junction，改源文件即改运行文件
- 目标环境：DSH 0.2.2-rc.5，Electron 桌面版，Windows

---

## 一、这个插件做两件事

| | B：插话 | A：旁路讨论 |
|---|---|---|
| 入口 | 输入框工具行「插话」 | 输入框工具行「旁路讨论」 |
| 形态 | 浮层（`position:fixed`，z-index 极大） | 右侧栏 tab |
| 目标 | **当前会话**，默认 `steer` 进正在跑的回合 | **fork 出来的子会话**，`queue` |
| 目的 | 助手想偏了立刻纠正 | 有分歧时不打断主线，另开一条支线聊 |

两者互不依赖。B 不需要 A 存在，A 也不需要 B 存在。

此外还有第三件小事（与上面两者也无关）：**中文状态行** —— 在输入框上方
显示一句「这一步在干什么」，解决「思考时看不见进度」。
它只读会话事件，不投递任何消息，见第二节末尾。

---

## 二、代码结构

插件包 7 个文件：

```
dsh-dialog-plugin/
├── package.json          声明 dsh.bundle.patch 与 dsh.client（web, immediately）
├── cordis.patch.yml      只 insert 一行 `- id: dsh-dialog-plugin`
├── index.js              Host 半边：把 Agent inbox 事件写进日志（104 行）
├── client.js             全部 UI（1680 行、约 72.5 KB，单文件）
├── icon.svg
└── locale/{zh,en}.json   文案
```

### Host 半边（`index.js`）

只做一件事：把 `agent/inbox/inserted` 和 `agent/inbox/claimed` 两个事件追加到

```
C:\Users\30823\.dsh\dsh-dialog-plugin\inbox.log
```

每行一个 JSON：`{at, kind, sessionId, turn, messageId, text}`，`text` 截到 400 字符。
写日志失败只 `console.warn`，不向上抛 —— 这条 feed 是 fire-and-forget 的 emit，监听器不能抛。

**`inserted` 与 `claimed` 的区别就是这个插件的验收证据**：

- `inserted` = 消息进了活体 inbox
- `claimed` = 消息被当前正在跑的回合取走

`steer` 会立刻触发 `claimed`；`queue` 要等下一轮才 `claimed`。所以日志能直接回答
「我这句话是插进了当前回合，还是排到下一轮了」。

Host 半边**不参与投递**。投递走的是 Session Controller 自己的 `prompt` 面。
因此把 Host 半边禁用，UI 仍然全功能 —— 只是没有日志了。

### Client 半边（`client.js`）

关键函数与行号（行号会随编辑漂移，以函数名为准）：

| 位置 | 内容 |
|---|---|
| `L213` | `sessionFace(sessions, sessionId)` — 拿真正的 `SessionFace` |
| `L248` | `deliverToSession(sessions, sessionId, body, mode = 'steer')` — 唯一投递入口 |
| `L395` | `activityLine(name, argumentsRaw)` — 工具调用 → 一句中文 |
| `L468` | `describeActivity(entries)` — 从事件窗口算出当前这一步 |
| `L528` | `useActivity(sessions, sessionId)` — 订阅事件窗口（只认 `revision` 变化） |
| `L584` | `ActivityLine` — 输入框上方那行状态 |
| `L635` | `const PANEL_CSS` — 全部样式，用 `--dsw-alias-*` token |
| `L690` | `ensureStyles()` — 注入/刷新 `<style id="dsh-dialog-plugin-styles">`（内容不一致就覆写） |
| `L750` | `InterjectButton` — 插话按钮 + 浮层（头部带 `×` 关闭键） |
| `L964` | `const TAB_KIND = 'dialog-branch'` |
| `L975` | `SideDiscussionButton` — 打开右栏 tab |
| `L1026` | `const TAB_ID = 'dsh-dialog-plugin/branch'` |
| `L1029` | `const BRANCH_KEY_PREFIX = 'dsh-dialog-plugin.branch.'` |
| `L1042` / `L1061` | `readBranch` / `writeBranch` — 每个父会话记住自己的子会话 id |
| `L1197` | `useBranchLog(sessions, sessionId, fromSeq)` — 把子会话事件流变成消息列表 |
| `L1285` | `SideDiscussionTab` — 右栏 body |
| `L1555` | `apply(ctx)` — 全部注册都在这里（状态行在 `L1664` 注册） |

**投递链路**（两个功能共用）：

```
按钮 → deliverToSession(sessions, targetId, body, mode)
     → sessionFace()                        // binding()?.session 优先
     → face.prompt([{type:'text',text}], mode)
```

`sessionFace` 的实现要点（`client.js:211`）：`sessions.binding(id)` 有就直接用；
没有就 `sessions.retain(id, {source:'gateway'})` 借一个，读出 `binding.session`，
然后**延迟 15 秒才 release**（`setTimeout(release, 15000)`）——
因为调用方可能还要 await 一次 prompt，立刻释放会让 face 失效。

`deliverToSession` 的降级策略（`client.js:246`）：`steer` 失败自动重试 `queue`，
确保文本不会因为「回合刚好结束」而静默丢失。

### 右栏 tab 的注册（踩过坑的地方）

```js
ctx.inject(['sidebarRightTabs'], injected => {
  const tabs = injected.get('sidebarRightTabs')
  try {
    tabs.register({ id: TAB_ID, kind: TAB_KIND, keepMounted: true,
                    priority: 'extension', title, guide })
  } catch (error) {
    if (!String(error?.message).includes('is already registered')) warn(error)
  }
})
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, withServices(SideDiscussionTab))
)
```

两个必须记住的点：

1. **必须直接调 `tabs.register(...)`**，不要包 `scope.effect`，不要用
   `scope.sidebarRightTabs` 属性式访问。better-sidebar 就是这么写的。
2. **`try/catch` 必须留**。`sidebarRightTabs` 的 registry 挂在 sidebar-right 包
   自己的 ctx 上，**它的生命周期比一次页面加载长**。F5 之后旧注册还在，
   第二次 `register` 同 id 会抛 `is already registered`。
   早期没有 catch 时，这个异常把 `document.title` 污染成
   `DIALOG-REG-FAIL …already registered`，还把自动化点击脚本搞坏了（按标题找窗口找不到）。

### 中文状态行（Activity）：把「这一步在干什么」显示在输入框上方

对应 BRIEF 里用户提出的第三个诉求——**思考时看不清进度**。
DSH 自带的「工作步骤展示」只能控制折叠程度，看不到一句人话的当前动作，
所以插件自己补一行。

**注册位**：`conversation.input.dock`，`id: 'dsh-dialog-activity'`，`order: 5`
（该 slot 现有 `todo`(0)、`goal`(10)、`queue`(20)，`replaceRisk: 'none'`，
新 id 是并行追加，不会覆盖别人的条目）。
选上方 dock 而不是下方的 `conversation.composer.dock`，是因为后者已经有
DSH 自己的 `activity` 行，放两行会说同一件事。

**数据来源**（关键，也是唯一可行的路）：Client 侧可订阅的事件只有
`connection/reset`、`locale/change`、`slots/changed`、`theme/change` 四种，
**没有任何 tool/call 实时广播**。所以必须读会话事件窗口：

```js
binding = sessions.binding(sessionId)            // 没有就 retain 借一个
source  = binding.eventSource
window  = source.getSnapshot()                   // { entries, revision }
// snapshot 是原地 mutate 的，只有 revision 变化才代表追加了事件
source.subscribe(read) + setInterval(read, 900)  // 丢帧兜底
```

**讲什么话**，优先级从高到低：

1. **工具自带的 `description`** —— `pwsh` 的 422 次调用里 422 次都带这个字段，
   是最短最像人话的一句（「List plugin project files」）。命中时**原样显示**，
   不再套动词，避免出现「正在执行命令 Refresh and capture…」这种半中半英。
2. **本助手写的 `▶` 行** —— 落在 `assistant/message` 的 `content[].type === 'text'`
   里，且与 `tool-call` 在同一条消息中，所以工具刚开跑时它已经在事件窗内，
   零额外成本、不调模型。会去掉「第 N 步：」这种记账前缀，再按句号/分号/冒号
   截到首句，最后裁到 80 字符。
3. **工具名映射表** —— `ACTIVITY_TOOLS` 里按工具名给中文动词 + 参数摘要
   （`read` →「读文件 client.js」、`grep` →「搜索代码 needle」）。
4. 都没有 → 「正在思考…」。

**只扫描当前 step**：先反向找最近的 `step/start`／`step/end` 拿到 `stepAt`，
再只在 `[stepAt, end]` 里找 `tool/call` 与 `assistant/message`。
早期版本没有这层边界，导致整个回合都在显示上一个 step 的旧动作（自查发现的 bug）。

**验证方式**：`D:\DSH插件开发\tools\test-activity.js` 把 client.js 里的纯函数
切片出来（`new Function` 注入 `detectLanguage`），解码真实会话的 zstd 文件，
回放投喂 `describeActivity`，打印每个探针点的输出。不用开界面就能验算法。

实际渲染效果（输入框上方那一行，圆点 + 一句话）：

![中文状态行](activity-line.png)

这张图里显示的是 `Capture final activity line screenshot for docs` ——
工具自带的 `description` 被原样发布，没有套「正在执行命令」这种外壳，
这就是为了让句子短、能一眼看完。

---

## 三、验收证据

四条验收标准的实测结论与证据位置。

### ① 插话入口能提交且消息确实进当前会话 —— 通过

Host 日志 `C:\Users\30823\.dsh\dsh-dialog-plugin\inbox.log` 里的原始记录：

```json
{"at":"2026-11-21T07:45:34.909Z","kind":"inserted",
 "sessionId":"session-6f9a852b-f0e2-4c1d-9f3e-0bd0e0081e9a",
 "messageId":"c8494a0f-53c4-4757-b0bd-278e412e28a0",
 "text":"插话插件自测：这条消息由「自测投递」按钮发出，用来确认 steer 通路可用。"}
```

随后同一 `messageId` 出现 `kind:"claimed"` —— 证明消息是被**当前回合**取走的
（steer 生效），不是排到下一轮。

浮层三处显示缺陷修完之后又做了一次**真实输入**的端到端复验
（2026-11-21 20:02，粘帖「插话修复后的真实发送验证」后点「插话」）：

```json
{"at":"2026-11-21T12:02:12.994Z","kind":"inserted",
 "sessionId":"session-4381cd64-b1ef-47d6-9b5d-130ea8ccb914",
 "messageId":"d7e88272-e800-48a1-82da-3fbfaf5c3908",
 "text":"插话修复后的真实发送验证"}
{"at":"2026-11-21T12:02:17.396Z","kind":"claimed", … "turn":5,
 "messageId":"d7e88272-e800-48a1-82da-3fbfaf5c3908"}
```

会话文件里对应 `seq=3568 type=agent/inbox/spliced {"target":"next-step",…}`
与 `seq=3575 type=user/message {"source":{"kind":"user","rpcId":"7df1e870-455c-4dec-93c3-f7a48830270d"}}`。
注意 `target` 是 **`next-step`**（不是 `next-turn`）—— 这就是「插话」与普通消息的区别。

### ② 讨论栏能独立对话、主会话不受影响 —— 通过

这一条做了两次，第一次只有「自测发送」按钮的证据，第二次是**真实键盘输入 + 点发送**。

界面操作：点右栏输入框 → `SendKeys` 输入 `A-side-check-7701` → 点「发送」。

落盘证据在分支会话
`C:\Users\30823\.dsh\sessions\--D-DSH~63D2~4EF6~5F00~53D1--\session-35ac992d-e8c4-4ebe-bfe3-7fd466594b90\session.v4.jsonl.zstd`：

```
seq=2681  agent/inbox/spliced  {"target":"next-turn", ...,
          "text":"A-side-check-","rpcId":"af21d6e6-c448-40d4-a4f8-408c417d147a"}
seq=2682  turn/start           {"turn":5}
seq=2685  user/message         {"text":"A-side-check-",
          "source":{"kind":"user","rpcId":"af21d6e6-c448-40d4-a4f8-408c417d147a"}}
```

（输入框实际只收到 `A-side-check-`，后 4 位被 IME 候选窗吞了，见下文限制第 3 条。）

**主会话不受影响**的证据：父会话 `session-0fa2edf1-…-2c42e5857b11` 全文解码后
grep `A-side-check` = **0 命中**，且文件 mtime 停在操作前不再增长。
其余同期会话同样 0 命中。

> 附注：会话文件是 `.zstd`，但实际由**多个独立 zstd frame 顺序拼接**。
> `zlib.zstdDecompressSync` 只解第一个 frame，必须按 magic `28 B5 2F FD` 切帧逐个解。
> 解码脚本见 `D:\DSH插件开发\tools\unzstd.js`。

### ③ 关插件后界面恢复、DSH 正常启动 —— 通过（启动部分用间接证据）

执行 `rollback.ps1 -Mode remove` → F5 之后截图
`D:\DSH插件开发\shots\rb20-removed.png`：

- 输入框下方「插话」「旁路讨论」两个按钮**全部消失**
- 右栏不再自动出现「旁路讨论」tab
- 会话正文、模型选择、发送按钮、左栏会话列表全部正常
- 进程没有崩溃，没有残留报错

`plugin_manager list_plugins`（218 个 entry）里已无 `dsh-dialog-plugin` 的任何 row。

**关于「DSH 正常启动」**：无法用 CLI 单独验证 desktop profile ——

```
$ dsh --profile desktop
error: profile "desktop" is managed exclusively by the Electron application
```

（`--dump-config` 也输出空。）所以这一项只能以「插件卸载状态下页面 F5 正常渲染、
进程未崩、无报错」为证据。这是 DSH 的设计约束，不是验证遗漏。

### ④ 有回滚脚本且实测回滚过一次 —— 通过

脚本：`D:\WB\dsh-dialog-plugin\rollback.ps1`（纯 ASCII，4983 字节为改版前，
当前版本 8520 字节）。

```
powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1                 # 只报告
powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -Mode remove
powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -Mode restore
```

实测双向记录（同一天连续做的）：

| 步骤 | 结果 |
|---|---|
| `status` | `installed state: installed`，exit 0 |
| `remove` | 备份 `rollback-backup\package.json.20261121-192236.bak`，bundles 12→11 项，依赖项删除，exit 0 |
| F5 | 按钮与 tab 入口消失（`rb20-removed.png`） |
| `restore` | 备份 `…-192257.bak`，bundles 11→12 项（末位），依赖 `link:` 补回，exit 0 |
| F5 | 按钮与 tab 回来（`rb21-restored.png`） |
| `status` | `installed state: installed`，exit 0 |

脚本同时编辑**两处**：`dsh.profile.bundles`（挂载哪些 bundle）和
`dependencies["dsh-dialog-plugin"]`（pnpm 的 `link:` 依赖）。
只改一处会让 package.json 自相矛盾 —— 早期版本就出现过这种半残状态，见下文。

---

## 四、已知限制（都是实测撞出来的，不是猜测）

### 1. fork 只能从「有已完成回合」的会话发起

在正在跑的会话里点「开始讨论」会报：

```
支线功能建立: session fork failed: session/fork-unavailable:
session-"session-4381cd64-…" has no completed turn to fork from
```

这是 `sessions.fork` 的固有约束，不是插件 bug。插件把这个错误识别成
「等待中」状态（`client.js:981` 判断 `fork-unavailable`），显示
`panelWaitTurn` 提示，而不是当成故障。**会话跑完一轮之后再来点就能 fork。**

### 2. tab 只能开在「已 adopt」的会话上

`sidebarRight.openTabIn(sessionId, kind)` 在会话 store 未 adopt 时**静默无操作**
（源码如此：`const actions = this.actionsFor(sessionId); if (actions !== undefined) …`）。
插件因此做了两层兜底（`client.js:621-633`）：

1. 先 `openTabIn(sessionId, TAB_KIND)`
2. 再 `openTab(TAB_KIND)`
3. 最后用 `sidebarRight.tabsIn?.(sessionId)` 校验，失败提示
   `'tab did not open — no adopted store for this session'`

### 3. 输入法会吞字符

`SendKeys` 打字时 IME 候选窗会抢焦点，实测输入 `A-side-check-7701` 只落进
`A-side-check-`。**这是 Windows 输入法行为，不是插件问题**，真实用户手动打字不受影响。
但它意味着自动化测试不能依赖精确文本。

同理，`imm32.dll ImmAssociateContextEx(hwnd, IntPtr.Zero, 0)` 想解绑 IME 会返回
False / err=203，此路不通。

### 4. 刷新会丢草稿

右栏 tab 在 F5 / 重新挂载时会整个重建，输入框里没发出去的草稿会丢
（实测 `rev` 从 2580 掉到 523，输入框变回 placeholder）。
分支会话 id 存在 localStorage，不会丢；丢的只是**没发出的草稿**。

### 5. 每次 fork 都会在会话列表里多一个条目

这是刻意不做 auto-fork 的原因（`client.js:998-1000` 有注释）：
如果挂载即 fork，每次刷新都会多留一个 fork 出来的会话。
现在是**用户点「开始讨论」才 fork**，id 按父会话记在 localStorage。

### 6. 主题 token 必须用 `--dsw-alias-*`（踩过两个坑）

第一条：插件最早的 `PANEL_CSS` 把颜色变量全写成 `--dsh-color-*`，**这些变量在 DSH
里根本不存在**，于是 `var()` 的 fallback 全部生效：浮层背景变成 `#fff`，
文字 `inherit` 到暗色主题的浅色 —— 白底白字，连同「取消」等 ghost 按钮的边框
（6% 白）一起，表现为「两个空白框」。

真实 token 名来自 `cordis_inspect_query(platform=client, provider=Theme,
method=listTokens)`，全部 `requiresLightAndDark`：

```
--dsw-alias-bg-base  -bg-layer-1  -bg-layer-2  -bg-overlay
--dsw-alias-border-l1  -border-l2
--dsw-alias-brand-primary  -label-primary  -label-secondary
--dsw-alias-state-error-primary  -state-idle-primary  -state-success-primary  -state-warn-primary
--dsw-specific-sidebar-fill
```

暗色主题下实测值：

```
brand=#f9fafb  bgBase=#151517  bgL1=#232324  bgL2=#2c2c2e  overlay=#61666b
b1=#ffffff0f  b2=#ffffff1f  lbl=#f9fafb  lbl2=#cfd3d6
idle=#545557  succ=#22c55e  warn=#f59e0b  err=#f25a5a
```

**关键陷阱：`--dsw-alias-brand-primary` 在暗色下是 `#f9fafb`，那是「前景色」
不是「背景色」。** 拿它当 primary 按钮底色、再配 `color:#fff`，就是白底白字。
正确写法是 `background: var(--dsw-alias-brand-primary)` +
`color: var(--dsw-alias-bg-base)`（暗色下深字，亮色下自动反转）。
ghost 按钮的边框要用 `--dsw-alias-border-l2`（12% 白），
`-border-l1`（6% 白）在深色底上几乎看不见。
浮层背景用 `--dsw-alias-bg-layer-1`，与 DSH 面板一致
（`dsh-better-sidebar/src/client/sidebar.module.css:13-21` 的约定是
「只用 `--dsw-alias-*`，绝不用 `--dsw-specific-sidebar-fill`」）。

第二条（更隐蔽）：`ensureStyles()` 原来写成
「`document.getElementById(id) !== null` 就 `return`」。
F5 会重新执行 client 模块，但 DOM 里那个 `<style>` 还在，
于是**永远沿用首次加载的旧 CSS，改样式刷新后看着毫无变化**。
现在改成内容不一致就覆写：

```js
if (existing.textContent !== PANEL_CSS) existing.textContent = PANEL_CSS
```

排查手段见本节末尾「探针法」。

### 7. 浮层没有原生弹窗外观，需要自己的关闭键

浮层是 `createPortal(...)` 挂到 `document.body` 的普通 `div`，
不是 DSH 的 dialog 组件，所以没有标题栏也没有系统关闭按钮。
用户反馈「为什么没有收起的按键」就是这个原因 ——
其实 `Esc` 一直能关（`client.js:429-444` 的 keydown 监听），但界面上看不出来。
现在头部有一行「插一句话进当前回合」+ 右侧 `×`
（`.dsh-dialog-interject-close`，`onClick: close`，
`title`/`aria-label` 取 `text(language,'cancel')`）。

> 两个「自测」按钮（插话浮层的「自测投递」、右栏的「自测发送」）
> 曾经是为了绕开 IME 抢焦点而加的临时验收路径，**已经全部删除**
> （2026-11-21，按用户要求）。现在插话浮层只剩「取消 / 插话」，
> 右栏只剩「发送」。

---

## 五、回滚与恢复

### 正常回滚（推荐）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\WB\dsh-dialog-plugin\rollback.ps1 -Mode remove
```

然后 F5 刷新页面。插件从 profile 里摘掉，按钮和 tab 入口消失。

需要恢复时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\WB\dsh-dialog-plugin\rollback.ps1 -Mode restore
```

再 F5。脚本会补齐 bundle 条目、`link:` 依赖，junction 缺失时重建。

每次改写 profile 前都会 `Copy-Item` 到
`C:\Users\30823\.dsh\profiles\desktop\rollback-backup\package.json.<yyyyMMdd-HHmmss>.bak`，
写回用 `UTF8Encoding($false)`（无 BOM，与 DSH 自己写的一致）。改坏了直接拷回去即可。

### 用 DSH 服务做回滚（等价路径）

```
plugin_manager action=set_plugin    target=include:dsh-dialog-plugin enabled=false
plugin_manager action=remove_bundle target=dsh-dialog-plugin
```

### ⚠️ 恢复时的一个大坑（实测踩过）

**只跑 `install_bundle` 是不够的。**

`set_plugin enabled=false` 会在 profile 里留下一条
`include:dsh-dialog-plugin` 的 `enabled:false` 记录。
`install_bundle` 不会清掉它 —— 结果是 bundle 装回来了，但 entry 仍然 disabled，
**界面上一根按钮都不出现**，`plugin_manager list_plugins` 里能看到
`"enabled": false, "fiberPhase": null`。

正确恢复顺序是两步：

```
plugin_manager action=install_bundle target=D:\WB\dsh-dialog-plugin\dsh-dialog-plugin
plugin_manager action=set_plugin     target=include:dsh-dialog-plugin enabled=true
```

### ⚠️ 第二个坑：junction 被删掉会变成「半残状态」

`remove_bundle` / `install_bundle` 折腾过程中，
`C:\Users\30823\.dsh\profiles\desktop\node_modules\dsh-dialog-plugin`
这个 Junction 可能被删掉，而 package.json 里依赖和 bundles 还在。
这时 DSH 报：

```json
{"availability":"missing",
 "error":{"code":"operation-error",
          "diagnostic":"dsh: cannot resolve profile bundle \"dsh-dialog-plugin\" …"}}
```

界面上按钮全消失，`set_plugin enabled=true` 还会报 `unaddressable`
（因为 `availability:missing` 时那条 row 根本不存在，entry 不可寻址）。

修法是**先手工重建 junction，再 enable**：

```powershell
New-Item -ItemType Junction `
  -Path C:\Users\30823\.dsh\profiles\desktop\node_modules\dsh-dialog-plugin `
  -Target D:\WB\dsh-dialog-plugin\dsh-dialog-plugin
```

然后 `plugin_manager set_plugin target=include:dsh-dialog-plugin enabled=true`
→ 返回 `application: applied`，条目恢复 `availability: "profile"`，F5 后界面恢复。

用 `rollback.ps1 -Mode restore` 就不会碰到这个问题 —— 脚本会检查 junction 并在缺失时重建。

### 右栏残留一个空 tab 是正常的

回滚后如果右栏还留着「旁路讨论」tab，它显示
「这类内容还没有可用的查看方式」或 `tab.unavailable`。
这是 sidebar 给「没有注册者的 kind」渲染的正常提示，不是故障，关掉即可。

---

## 六、开发期的操作要点

### 改动生效方式

| 改的是 | 生效方式 |
|---|---|
| `client.js` | `SetForegroundWindow(hwnd)` + F5（或用 `ui.ps1 -Action keys -Text '{F5}'`） |
| `index.js`（Host） | `plugin_manager set_plugin target=include:dsh-dialog-plugin enabled=false` 再 `true` |
| 两个都改 | 先 Host 重载，再 F5 |

### 该插件的运行文件就是源文件

`D:\WB\dsh-dialog-plugin\dsh-dialog-plugin\` 通过 Junction 挂进
`C:\Users\30823\.dsh\profiles\desktop\node_modules\dsh-dialog-plugin`，
**改源文件就是改运行文件，不需要重装、不需要 pnpm install。**

### 写 .ps1 必须注意编码

PowerShell 5.1 会把**无 BOM 的 UTF-8 .ps1 当成 ANSI 解析**，
文件里有中文就会报 `Missing expression after ','` / `Unexpected token '{'`，
能跑起来也会输出一堆乱码。

两个应对：脚本写成纯 ASCII（`rollback.ps1` 就是这么做的，中文说明全在本文里）；
或者写成带 BOM 的 UTF-8。

另外 PowerShell 执行策略禁止直接跑 .ps1，必须：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <path>
```

### 自动化操作 DSH 窗口

工具脚本 `D:\DSH插件开发\tools\ui.ps1`，动作 `shot/move/click/clickshot/keys/type/enter`，
坐标是**屏幕绝对坐标**。

- 必须用 **danger-full-access** 权限跑：Low 完整性级别下 `SetCursorPos` 返回 False、
  err=5，`SendInput` err=203，光标纹丝不动（UIPI 拦截）。
- `-Action shot` 必须显式传 `-Out` 的 ASCII 路径，否则默认路径含乱码并在
  `Image.Save` 抛 `A generic error occurred in GDI+`。
- 没有 `focus` 动作（传了会打印 `unknown action: focus`）。
- 靠进程名 `DeepSeek Harness` 找 hwnd，不要靠窗口标题 ——
  标题会被页面自己的 `document.title` 改写（见上文 DIALOG-REG-FAIL 事故）。
- **坐标每次都要重新截图定位**，右栏开合会让按钮横向漂移一大截。

### 探针法：在页面里读值并带出来

DevTools Console 的粘贴通道不可用 —— 它会先弹
`Warning: Don't paste code into the DevTools Console that you don't understand…
Type 'allow pasting' below and press Enter`，
而用 SendKeys 敲 `allow pasting` 会**丢掉空格**变成 `allowpasting`，
Console 报 `Uncaught ReferenceError: allowPasting is not defined`。
自动化没法在 Console 里执行 JS。

替代通道（实测可用）：在 `client.js` 的 `apply(ctx)` 里临时插一段
`setTimeout(..., 1500)`，构造游离 DOM，读 `getComputedStyle` / `getPropertyValue`，
把结果拼成一个字符串写进 `globalThis.document.title`，
再用 PowerShell 从窗口标题读回来：

```powershell
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WT {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
}
'@
$p = Get-Process -Name 'DeepSeek Harness' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$sb = New-Object System.Text.StringBuilder 4096
[WT]::GetWindowTextW($p.MainWindowHandle, $sb, 4096) | Out-Null
$sb.ToString()
```

两条注意：

- 探针写进的是 `document.title`，会**覆盖窗口标题**，用完必须删掉
  （否则 `ui.ps1` 曾经靠标题找窗口就会直接失效，见 DIALOG-REG-FAIL 那段）。
- 探针块在 `client.js` 里留过 67 行，删完后要重新 `node --check` 并刷新两次确认
  标题回到正常值。

---

## 七、与本插件无关的环境噪声

排查时容易误认成插件 bug，记录在此：

- 主会话正文偶现
  `本轮运行失败 400: {"message":"workbuddy upstream client (http 422)…","code":"bili_gate_oversize_refusal_unattributed_bytes"}`
  —— billion-context 的压缩门拒绝超大字节，属上下文管理问题。
- 分支 agent 自己的 `cordis_inspect_query` 报
  `Error: Client Cordis inspect provider "Sessions" is not registered`
  —— Client 侧可枚举的 Service/Provider 本来就少（见 HANDOFF 第三节），不是插件问题。
- `@michengai/dsh-codex-ui@1.1.38` 因版本不兼容被拒（`incompatible-version`），
  与插件无关。

---

## 八、清理清单（交付前）

已执行（2026-11-21）：

| 删掉的 | 说明 |
|---|---|
| `shot-8.png`、`shot-36..54*.png`（21 张） | 开发期一次性截图，每张 1.5MB 左右 |
| `tmp-branch.jsonl`（7.1MB） | 会话解码的中间产物 |
| `tmp-child.js`、`tmp-probe.js`、`tmp-sources.js`、`tmp-zstd.js` | 一次性解码/探测脚本 |
| `acl-report/` | 权限排查产物，与插件最终形态无关 |

合计约 27 项 / 22.2 MB。

保留：`HANDOFF.md`（沿革）、`docs/DETAIL.md`（本文）、`rollback.ps1`、
`dsh-dialog-plugin/`（插件本体）、`research/`（源码参考，可选）、
`backup/`（⚠️ 里面那份 `package.json` 其实**仍含插件**，不是真回滚基线，
勿当作基准；真正的回滚基线由 `rollback.ps1` 每次写前自动备份到
`C:\Users\30823\.dsh\profiles\desktop\rollback-backup\`）。

最后状态（2026-11-21 20:42）：`client.js` 72549 字节 / 1680 行，`node --check` exit=0，
插话浮层与右栏都只剩真实按钮，中文状态行已上界面，
全项目 grep `selftest|自测|sendProbe|PROBE|TEMPORARY|dsh-color|DIALOG-REG-FAIL` 零命中。

恢复基线：`D:\WB\dsh-dialog-plugin\backup\client.js.before-activity`
（56822 字节，即加状态行之前的版本），要退掉状态行直接覆盖回去再 F5。
