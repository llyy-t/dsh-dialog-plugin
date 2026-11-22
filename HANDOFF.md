# dsh-dialog-plugin 交接说明

写于 2026-11-21。上一个会话因上下文超限（`bili_gate_oversize_refusal_unattributed_bytes`）中断，
本文件用于在新会话里无缝继续。

## 一、任务来源

`D:\DSH插件开发\BRIEF.md`。目标：DSH 小窗讨论插件，两部分：

- **B（插话按钮）**：输入框旁按钮，点开输入内容，消息塞进当前正在跑的会话。
- **A（侧边讨论窗）**：右侧常驻栏，独立会话，聊分歧，不干扰主会话。

验收四条：
1. 插话入口能提交且消息确实进当前会话（有日志或界面证据）
2. 讨论栏能独立对话、主会话不受影响
3. 关插件后界面恢复、DSH 正常启动
4. 有回滚脚本且实测回滚过一次

## 二、已完成

### B —— 已通过，有硬证据

- 按钮「插话」渲染在 `conversation.input.right` 槽（order 40）。
- 弹窗可开，弹窗内有：textarea、取消、「自测投递」、发送。
- **证据**：点击「自测投递」后，Host 日志
  `C:\Users\30823\.dsh\dsh-dialog-plugin\inbox.log` 出现
  ```json
  {"at":"2026-11-21T07:45:34.909Z","kind":"inserted",
   "sessionId":"session-6f9a852b-f0e2-4c1d-9f3e-0bd0e0081e9a",
   "messageId":"c8494a0f-53c4-4757-b0bd-278e412e28a0",
   "text":"插话插件自测：这条消息由「自测投递」按钮发出，用来确认 steer 通路可用。"}
  ```
  且该文本作为用户消息真实出现在会话中。
- 日志同时记录 `kind:"claimed"`（消息被当前回合取用），可区分 steer 与 queue。

### A —— 代码已写完，卡在最后一环

已确认的事实：
- 按钮「旁路讨论」渲染在 `conversation.input.right`（order 50），能点。
- body 座席 `sidebar.right.pane.tab` 已注册成功：
  `cordis_inspect_query` 显示 occupants 里有
  `{"registrant":"WC","key":"dsh-dialog-plugin/branch","priority":0,"active":true}`。
- tab 类型注册已按 better-sidebar 的写法修正（`injected.get('sidebarRightTabs')` 后**直接** `tabs.register(...)`，
  不要再包 `scope.effect`，不要用 `scope.sidebarRightTabs` 属性式访问）。
- **修正后尚未刷新验证。** 上一次刷新时撞上 bili_gate 错误，页面没能正常渲染新 bundle。

待验证/待修的点（按顺序）：
1. 刷新页面，点「旁路讨论」，看右栏是否出现 tab。
2. 若仍打不开：`openTabIn(sessionId, kind)` 在会话 store 未 adopt 时会**静默无操作**（源码如此），
   可改用 `sidebarRight.openTab(kind)`；或先 `layout.openRightbar(false, false)` 再开 tab。
3. 打开后验证 fork：`sessions.fork({sessionId, onCreated})` → localStorage 记住子会话 id →
   tab 内显示子会话消息列表 + 输入框 + 发送。
4. 在 tab 里发一条消息，确认主会话不受影响（BRIEF 验收②）。

## 三、关键 API 事实（都已从源码核实，别重新踩一遍）

插件目录 `D:\WB\dsh-dialog-plugin\dsh-dialog-plugin\` 通过 **Junction** 装到
`C:\Users\30823\.dsh\profiles\desktop\node_modules\dsh-dialog-plugin`，
**改源文件即改运行文件，不需要重装**。

- Host 半边改动生效：`plugin_manager set_plugin target=include:dsh-dialog-plugin enabled=false` 再 `true`。
- Client 半边改动生效：`SetForegroundWindow(hwnd)` + `keybd_event(0x74)`（F5）刷新页面。
- 两边语法检查：
  ```
  $env:ELECTRON_RUN_AS_NODE='1'
  'D:\新建文件夹 (2)\DeepSeek Harness.exe' --check <file>
  ```
  （pwsh 5.1 必须用 `$psi.Arguments` 字符串拼接，`.ArgumentList` 是 null 会抛异常。）

### Client 侧服务

- 可枚举的 Client Service 只有 8 个：`layout`/`locale`/`sessions`/`slots`/`theme`/`timer`/`uiWorkspace`/`workspaces`。
  **`sidebarRight`、`sidebarRightTabs`、`conversation` 都不可枚举**，只能 `ctx.get()` / `ctx.inject()`。
- `sessions` 服务方法：`retain` / `using` / `retainInfo` / `refreshProjections` / `search` / `fork` /
  `scope(id)` / `binding(id)`。**没有 create**，讨论会话只能 fork。
- `SessionFace = ISession & ObservableSnapshot<SessionSnapshot>`，
  核心方法 `prompt(content, mode:'queue'|'steer', signal?, requestId?): Promise<RemoteResult<{accepted:true}>>`。
- **槽位标准 props 里没有 `session`**，只有 `sessionId` 和 `useSession`。
  `useSession` 是快照选择器，返回纯数据，**没有 `.prompt()`**。
  要真正的 `SessionFace`，必须 `sessionId` → `sessions.binding(id)?.session` 或 `sessions.retain(...)`。

### 注册第三方右栏 tab（better-sidebar 已验证的写法）

```js
ctx.inject(['sidebarRightTabs'], injected => {
  const tabs = injected.get('sidebarRightTabs')
  if (tabs === undefined) return
  tabs.register({
    id: TAB_ID, kind: TAB_KIND, keepMounted: true, priority: 'extension',
    title: () => '…', guide: [{ id: TAB_ID, order: 200, title: () => '…' }],
  })
})
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, withServices(SideDiscussionTab))
)
```

`openTabIn` 前提：`actionsFor(sessionId)` 必须已 adopt，否则静默返回。
`placeTab` 里 tab 类型未注册会抛 `sidebar right: no tab type is registered as "<kind>"`。

### Host 事件（验收证据来源）

- `agent/inbox/inserted(session, event)` —— 消息进入 inbox。
- `agent/inbox/claimed(session, event)` —— 消息被当前回合取用。
- `ToolExecution` 字段：`session` 不是 `agent`，用 `ctx.agents.currentInitiator()` 取 agent。

## 四、环境与操作要点

- DSH 窗口 hwnd：每次重开可能变，用 `EnumWindows` + `GetWindowTextW` 找标题含 `DeepSeek Harness` 的窗口。
- 截屏 + 裁剪到窗口矩形，再 `read_image` 看。
- 点击：必须 `Add-Type -TypeDefinition` 写 C# 类包 P/Invoke
  `SetForegroundWindow` / `SetCursorPos` / `mouse_event(0x02/0x04)`。
- **坐标随窗口大小/右栏开合大幅漂移**，每次点击前必须重新截图定位。
- **键盘输入进不去插话弹窗的根因是 IME 候选窗抢焦点**（不是 DSH 快捷键监听、不是 React ref）。
  `keybd_event` 与剪贴板粘贴都失败。这就是为什么插件里加了「自测投递」/「自测发送」按钮，
  **免键盘验证路径不要删**。
- PowerShell 读 UTF-8 日志会显示中文乱码，是显示问题，不是文件问题。

## 五、上下文超限

本会话撞到 `bili_gate_oversize_refusal_unattributed_bytes`：
> context refused this request locally: it is not attributed to a bili-managed session
> and its body is larger than the silent-direct byte ceiling (#5405)

原因：会话上下文过大。**新会话启动后不要再一次性读大文件**，
按需读、按行范围读，避免重蹈覆辙。

## 六、剩余工作 —— 已于 2026-11-21 19:25 全部完成

1. ~~验证 A 能打开、能对话（BRIEF 验收②）~~ —— **通过**。
   真实键盘输入 + 点「发送」，消息只落进分支会话 `session-35ac992d-…`，
   父会话 `session-0fa2edf1-…` grep 该文本 0 命中。
2. ~~BRIEF 验收③：关掉插件后界面恢复、DSH 正常启动~~ —— **通过**。
   `rollback.ps1 -Mode remove` + F5 后按钮与 tab 入口全部消失，界面其余部分正常，
   进程未崩。CLI 无法单独启动 desktop profile（`--profile desktop` 被拒），
   故「正常启动」以 F5 正常渲染为证。
3. ~~BRIEF 验收④：回滚脚本 + 实测回滚一次~~ —— **通过**。
   `rollback.ps1` 支持 `-Mode status|remove|restore`，remove→F5→restore→F5 双向实测走通，
   每次改写前自动备份到 `rollback-backup\package.json.<时间戳>.bak`。
4. ~~补 `docs/DETAIL.md` 与交付说明~~ —— **已写** `docs/DETAIL.md`（实现细节、四条验收证据、
   六个已知限制、回滚与恢复的两个大坑）。
5. ~~清理一次性截图 `shot-*.png` 与临时脚本~~ —— **已删** 26 个文件 / 22.2 MB
   （21 张截图 + `tmp-branch.jsonl` 与 4 个 `tmp-*.js`）。

`rollback.ps1` 与 `docs/DETAIL.md` 是后来重写/新增的，与本文件第二节的描述有出入时，
以那两个文件为准。**注意 `backup/package.json` 里其实仍含插件，不是回滚基线**，
`docs/DETAIL.md` 第八节有说明。
