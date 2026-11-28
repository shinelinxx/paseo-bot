# 单流对话管家交互协议（Conversation Flow Protocol · v0.4.0）

> **工单溯源**：`T-001`（M1 · 体验协议与分层架构）  
> **维护责任**：管家总舵（`butler-lead`）  
> **视觉与体感标杆**：`docs/references/dot-reference-1-proactive-bubbles.jpg`、`docs/references/dot-reference-2-memory-and-verify.jpg`  
> **下游消费方**：`routing-engine`（T-002）、`bubble-ui`（T-003）、`persona-tuner`（T-001 提示词）、`qa-gatekeeper`（全阶段门禁）

---

## 1. 设计北极星：从「工单管理后台」彻底回归「Dot 风个人专属管家」

v0.3.0 的 `BotConsoleScreen.tsx`（4,926 行）演进为了包含 4 个顶层 Tab、搜索框、筛选芯片、顶部大表单与多按钮工单卡片的后台控制台。v0.4.0 遵循 **ADR-001**，将整个产品重构为一条温暖、极简、真人感的单流对话体验：

1. **主界面 90% 是纯净连续气泡流**：打开 Paseo Bot 看到的永远是与个人管家的连续聊天记录（最旧在上、最新在下），而不是任务卡片墙。
2. **主动推送即普通人聊天气泡**：定时巡检、文件变动、Webhook、后台子任务结果不再弹出带红点/彩条/按钮丛林的工单卡片，而是由管家像真人助理一样直接发来一条结论先行、称呼用户名、重点加粗、带内联可点链接的短气泡。
3. **一句话自然校准，告别表单**：用户随口回复（如 `"停用了，我换 example.net 了"`、`"以后低于 $50 不用提醒"`、`"叫你小点吧"`），管家在 L1 轻量层秒级更新 `MEMORY.md` 并静默更新/停用关联提醒，回复一句温暖确认即可，不强迫填弹窗。
4. **敏感操作以极简内联轻卡片嵌入对话流**：所有 Sentinel 确认（外发邮件/消息、资金交易、破坏性删除、`/tidy` 整理清单）不切走页面，直接以紧凑轻卡片嵌在对话流左侧，支持展开/修改执行内容预览、确认执行或取消，处理后自动收敛为单行已结状态。
5. **所有重管理 100% 优雅收纳进左上角抽屉**：原生定时计划、事件/差量规则、长期记忆（`MEMORY.md`）、后台子任务、模型分级策略、运行状态与完整审批历史全部收纳在左上角抽屉菜单中，**不丢任何 v0.3.0 能力，但平时零打扰**。

---

## 2. 主界面视觉布局规范（Dot Reference 1:1 映射）

### 2.1 三段式极简视口结构

```
┌──────────────────────────────────────────────────────────┐
│ [ ≡• ]              ( ☁️ 管家名 )                 [ ⚙ ] │  ← 顶部悬浮极简顶栏（约 56px，半透明柔和顶栏）
├──────────────────────────────────────────────────────────┤
│                        昨天 14:15                         │  ← 居中柔和时间分割线（间隔 >15min 或跨天显示）
│                                                          │
│  ┌────────────────────────────────────┐                  │
│  │ 辉，你的 ChatGPT Business 有一次    │                  │  ← 管家气泡（左对齐，柔和圆角 20px，左下角微收 6px）
│  │ 备用额度重置，**12 月 1 日到期**。  │                  │     支持加粗重点、内联可点链接、无标题栏/无红点
│  │ [查看 OpenAI 邮件](url)             │                  │
│  └────────────────────────────────────┘                  │
│                                                          │
│                    ┌──────────────────────────────┐      │
│                    │ 停用了，我换 example.net 了  │      │  ← 用户气泡（右对齐，柔和主题蓝胶囊圆角，白字）
│                    └──────────────────────────────┘      │
│                                                          │
│  ┌────────────────────────────────────┐                  │
│  │ 明白，legacy-api.io 是主动停用的，不用 │                  │  ← L1 秒回确认气泡（同步落盘记忆并静默旧提醒）
│  │ 赎回。以后按 example.net 来，旧域  │                  │
│  │ 名就不再提醒了。                    │                  │
│  └────────────────────────────────────┘                  │
│                                                          │
│  ┌────────────────────────────────────┐                  │
│  │ 🛡️ 确认执行 · 发送月度对账邮件      │                  │  ← 内联 Sentinel 轻确认卡片（需要拍板时自然嵌入）
│  │ 将向 finance@example.com 发送…     │                  │     [查看/编辑内容]  [确认执行] [先不用]
│  └────────────────────────────────────┘                  │
│                            [ ↓ ]                         │  ← 向上滚动 >120px 时浮现的回底圆形按钮
├──────────────────────────────────────────────────────────┤
│  ╭────────────────────────────────────────────────────╮  │
│  │  ( + )   给 管家名 发消息…                    ( ↑ ) │  │  ← 底部悬浮胶囊输入栏（居中 maxWidth 680px）
│  ╰────────────────────────────────────────────────────╯  │
└──────────────────────────────────────────────────────────┘
```

### 2.2 顶部悬浮顶栏（Top Floating Header）

- **左侧按钮（抽屉入口）**：
  - 圆形轻边框按钮（36×36），图标为极简双横线（或 `Menu`），右上角仅保留**一枚安静小圆点**（无数字红点噪音）：
    - 有待确认 Sentinel 审批 → 琥珀色小圆点（`theme.colors.statusWarning`）；
    - 无审批但有运行中子任务或未读更新 → 主题蓝小圆点（`theme.colors.accent`）；
    - 全局已暂停 → 灰色小圆点（`theme.colors.foregroundMuted`）；
    - 一切平静 → 无圆点。
- **居中标识（管家头像 + 名称胶囊）**：
  - 居中柔和云朵/光球头像（`ButlerAvatar`，自定义轻量 View/SVG 图形，支持呼吸微动效表示 L1/L2/L3 正在思考或核查）；
  - 下方或右侧紧邻圆角胶囊名牌（读取设置 `butlerName`，默认 `"Paseo Bot"`，用户在对话中给管家起名后可自动更新）。
  - 点击居中头像/名牌可轻提示当前管家运行状态（如 `"运行中 · 3 条规则守护中"` / `"已暂停自动规则"`）。
- **右侧按钮（单枚极简操作钮）**：
  - 36×36 圆形轻按钮，用于一键打开插件设置或切换「静默检查/立即整理」轻菜单（保持顶栏左右对称，严禁堆叠多个操作按钮）。

### 2.3 气泡样式与排版细则

| 元素 | 样式约束 | 交互规范 |
|---|---|---|
| **时间分组线** | 居中 `11px` `foregroundMuted`，与上下气泡间距 `12px` | 相邻两条消息间隔 > 15 分钟或跨自然日时插入（如 `今天 10:02`、`昨天 14:15`、`11-26 09:30`） |
| **管家气泡（左）** | 左对齐，`maxWidth: "82%"`（桌面端 `<= 560px`），圆角 `20px`（连发组末尾左下 `6px`），浅灰柔底 `surface1`（暗色 `surface2`），内边距 `11px 15px`，行高 `22px`，字号 `14px` | 渲染 `<Markdown>` 支持**加粗**、短列表、内联可点链接（`http(s)://` 调 `openExternalUrl`，`paseo://agent/<id>` 调 `openAgent`）；超长正文（`details` 存在）仅在气泡底部给一行柔和文字链 `"展开完整说明 ▾"`；悬浮/点击显示极简复制图标，无按钮丛林 |
| **用户气泡（右）** | 右对齐，`maxWidth: "78%"`（桌面端 `<= 520px`），圆角 `20px`（右下 `6px`），主题强调蓝（`accent`）背景 + 高对比文字（`accentForeground`），内边距 `10px 14px` | 如有附带图片，上方展示圆角缩略图网格；发送瞬间乐观上屏，零卡顿 |
| **L1→L2 两拍接力气泡** | 第一拍（L1 `kind: "ack"`）：独立短气泡立即出现（如 `"我先查这 4 条 Tunnel 对应的主机……"`），尾部可带柔和思考指示点直至第二拍到达；第二拍（L2/L3 `kind: "chat"`）：查证完毕后作为紧邻下一条气泡自然接上 | 两拍共享 `replyToMessageId` 便于追踪；若 L2 失败，第二拍温和坦诚说明失败原因与下一步建议 |
| **静默状态轻提示（`status_note` / `memory_update`）** | 若是记忆同步或规则静默调整，优先直接由管家在短气泡中口语化确认（如参考图 2）；辅助系统事件仅以极轻居中灰字一行展示（如 `"已更新长期记忆 · 已停用旧域名提醒"`），不占气泡重心 | 绝不把 L0 无变化跳过记录（`silent`）刷进主对话流（统计数字收在抽屉运行状态中） |
| **内联 Sentinel 轻确认卡（`kind: "approval"`）** | 嵌于左侧消息流，同宽 `<= 560px`，柔和 `1px` 边框 + 细微风险标识（`ShieldAlert`），无刺眼大色块 | 展示：一句话说明做什么 + 风险标签 + 折叠/展开的 `payloadPreview`（支持就地编辑、支持 `/tidy` 勾选清单）+ 非高风险时可选 `"以后同类自动执行"` + 主按钮 `"确认执行"` / 次按钮 `"先不用"`。用户操作后原地收敛为单行安静状态条（`"✓ 已确认执行 · ..."` / `"已取消 · ..."`） |
| **可选内联微动作胶囊（`quickActions`）** | **克制原则**：绝大多数对话气泡为 `0` 个按钮；仅当确实有跳转外部子会话或明确二选一时，允许在气泡下方附 `1~2` 个极简胶囊（如 `"查看子任务对话"`） | 彻底取消 `有用`、`减少此类提醒`、`稍后提醒`、`更多菜单` 等工单按钮丛林 |

### 2.4 底部悬浮胶囊输入栏（Bottom Floating Capsule Composer）

- **布局**：贴底悬浮（居中 `maxWidth: 680px`，左右留白 `16px`，底部留白 `14px`），胶囊圆角 `26px`，轻边框 + 柔和背景阴影。
- **左端 `+` 圆形按钮**：点击弹出极简轻浮层（Popover/Menu）：
  1. **添加图片**（触发 `pickWebImages`，同时保留输入框全局粘贴与拖放图片）；
  2. **快捷触发一句**（`"生成今日汇总"`、`"整理工作区与会话"`、`"整理 00-Inbox 草稿"`）；
  3. **深度思考模式（L3 升舱开关）**：默认关闭（由 L0–L3 自动分流）；开启后在输入栏上方显示一枚小胶囊 `"深度思考 · L3"`（可一键取消），允许用户显式要求重模型或手动选定某个具体模型。
- **中间自适应多行输入框**：
  - 占位符：`给 ${butlerName} 发消息` / `Message ${butlerName}...`；
  - 桌面 Web 键盘约定：`Enter` 直接发送，`Shift+Enter` 换行，`⌘↵` / `Ctrl+↵` 同样发送（中文输入法 `isComposing === true` 时绝不误发）。
- **右端发送按钮**：
  - 有文本或图片时高亮圆形向上箭头（`ArrowUp`）；发送中或 L1 处理中仍允许继续输入排队，绝不锁死输入框。

### 2.5 首次打开空白流（Dot 风格三连欢迎气泡）

当持久化 `messages` 为空且历史非静默 `feed` 也为空时，服务端或前端初始化展示温和的三连短气泡（与参考图 1 一致，按用户昵称动态称呼）：
1. `"嗨，{userName}！我是你的个人管家，可以帮你分担手头的事务。"`
2. `"想给我取个名字吗？直接告诉我就可以。"`
3. `"我平时会帮你盯着日程、文件和后台任务，没变化时不打扰你。现在有什么特别想处理的吗？"`

---

## 3. 左上角管理抽屉（Top-Left Management Drawer）与全量能力映射表

### 3.1 抽屉交互规范

- 从左侧滑出（桌面端宽度 `380px`，窄屏/移动端 `min(360px, 88vw)`），右侧半透明遮罩点击关闭，支持 `Escape` 关闭。
- **抽屉顶部固定栏**：
  - 管家名 + 运行状态开关胶囊（`运行中` / `已暂停`，一键调用 `setGlobalPauseRpc`）；
  - 一行摘要：`本小时触发 X/Y · 静默跳过 N 次`；
  - 关闭按钮 `×`。
- **抽屉内 5 个分段面板（Tab/分段切换或清晰分区，避免单屏过长）**：
  1. **计划与规则（Schedules & Rules）**
  2. **待确认（Approvals）**
  3. **长期记忆（Memory）**
  4. **后台任务（Workers）**
  5. **分流与状态（Routing & Status）**

### 3.2 v0.3.0 → v0.4.0 全量能力无损映射清单（防丢功能铁律）

| v0.3.0 能力 / 入口 | v0.4.0 落点 | 交互变化与向后兼容说明 |
|---|---|---|
| 顶部 4 Tab（动态 / 待确认 / 计划与规则 / 记忆与后台） | **已移除**（主屏改为单流气泡；管理项收进左上角抽屉） | 兼容 `/bot missions`、`/bot workers`、`/bot approvals`、命令中心 `cmdOpenSchedules`：打开主屏并自动展开抽屉对应分区 |
| 顶部大许愿框 + 图片粘贴/拖放/选择 | **底部悬浮胶囊输入栏**（`+` 菜单 + 粘贴 + 拖放） | 保留 6 图上限、16MB 校验、缩略图预览与移除；发送改为走新单流对话接口 |
| 快捷指令（今日汇总 / 整理草稿 / 查看进度 / 整理会话） | **底部 `+` 轻菜单** + 抽屉「后台任务」一键整理 | 主屏不再常驻 4 个大按钮 |
| 动态卡片（`feed`）与卡片内追问/过滤/稍后提醒 | **主屏单流气泡（`messages`）**；一句话回复替代点按表单 | 旧 `state.json` 的近期非静默 `feed` 自动迁移/投影进 `messages`；保留 `feed` 字段与旧 RPC 兼容 TimelineCards |
| 待确认审批卡（`approvals`，含预览编辑、信任升级、`/tidy` 勾选） | **主屏内联轻确认卡** + **抽屉「待确认」完整队列与历史** | 100% 保留 `payloadPreview` 编辑、`promoteTrust`、`decisionNote` 与 `/tidy` 勾选执行，Sentinel 红线零削弱 |
| Paseo 原生定时计划（`nativeSchedules`，`~/.paseo/schedules` 单源同步） | **抽屉「计划与规则」** + 复用 `CreateOrEditMissionModal` | 新建/编辑/运行一次/暂停/恢复/删除/跳转上次运行对话 100% 保留 |
| 事件与差量规则（`file_watch` / `poll_command` / `webhook` / `self_wake`）+ 4 个预设模板 + 常用建议 | **抽屉「计划与规则」** + 复用 `CreateOrEditMissionModal` | 保留自然语言草拟规则、过滤词编辑、Webhook 链接复制、开关/运行/删除、清理已完成提醒、接受/忽略建议 |
| 长期记忆（`MEMORY.md` 预览与编辑） | **抽屉「长期记忆」** + 复用 `MemoryEditorModal` + 对话一句话自动修改 | Obsidian 双向同步不变，新增对话中自然语言即时更新 |
| 后台子任务（`workers`）监控与停止/重试/清理 | **抽屉「后台任务」** + 完成后在主对话流发短气泡 | 保留停止、跳转对话、移除、清理已完成记录 |
| 模型选择与设置（`ModelPickerModal` / `BotSettingsScreen`） | **抽屉「分流与状态」**（L1/L2/L3 档位一览 + 单次覆盖）+ `BotSettingsScreen`（分层模型配置） | 默认不再全局写死重模型，而是分层配置 L1/L2/L3 |
| 侧边栏入口（`SidebarItem.tsx`） | 保留极简行，徽章降噪（待确认用琥珀点/小数字，未读用温和蓝点，无花哨堆叠） | 保持轻量 `watchBotSummarySubscription` (~100B) 性能优势 |
| 其他对话 Tab 中的时间线卡片（`TimelineCards.tsx`） | 保持兼容注册（`BOT_ALERT_TIMELINE_KIND` / `BOT_APPROVAL_TIMELINE_KIND`） | 避免破坏历史对话渲染 |

### 3.3 明确减法清单（严禁回归的反模式）

- ❌ 主屏禁止出现 4-Tab 导航栏、搜索框、过滤芯片（`全部/未读/进行中/待处理`、`显示无变化记录`、`清理已读`）。
- ❌ 主屏气泡禁止出现左侧彩色竖条、未读红点、工单式标题栏（如 `"子任务已完成：任务 · ..."`）。
- ❌ 主屏气泡禁止堆砌 `"有用"`、`"减少此类提醒"`、`"稍后提醒"`、`"更多 ⋯"` 按钮行。
- ❌ 禁止在主屏把 `level: "silent"`（无变化跳过）的机械日志渲染成气泡。
- ❌ 禁止保留 4,900+ 行单文件巨无霸组件；`bubble-ui` 必须拆分为职责清晰的子模块。

---

## 4. 单流消息数据契约与向后兼容方案（`shared/contracts.ts` & `state.json`）

### 4.1 核心 Schema 扩展（向后兼容增量设计）

所有新增字段均带默认值或可选，**严禁破坏旧字段类型与已有 `tests/engine.test.ts` 契约**。

```ts
export const RoutingTierSchema = z.enum(["L0", "L1", "L2", "L3"]);
export type RoutingTier = z.output<typeof RoutingTierSchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system"]);
export type ChatRole = z.output<typeof ChatRoleSchema>;

export const ChatMessageKindSchema = z.enum([
  "chat",          // 正常对话（用户输入或管家最终回复）
  "proactive",     // 主动提醒短气泡（定时巡检、目录监听、Webhook、子任务完成）
  "ack",           // L1 秒回占位/接力气泡（"我先帮你查一下…"）
  "approval",      // 内联 Sentinel 轻确认卡片（绑定 approvalId）
  "memory_update", // 记忆/规则静默更新提示
  "status_note",   // 轻量系统提示（如已改名、已暂停）
]);
export type ChatMessageKind = z.output<typeof ChatMessageKindSchema>;

export const ChatMessageStatusSchema = z.enum([
  "sending",
  "thinking",
  "done",
  "error",
]);
export type ChatMessageStatus = z.output<typeof ChatMessageStatusSchema>;

export const ChatMessageImageSchema = z.object({
  mimeType: z.string(),
  name: z.string().optional(),
  previewUri: z.string().optional(), // 缩略展示或引用，持久化时控制体积避免 state.json 膨胀
});

export const ChatInlineLinkSchema = z.object({
  label: z.string(),
  url: z.string(), // http(s):// 或 paseo://agent/<id>
  kind: z.enum(["external", "agent", "file"]).default("external"),
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  role: ChatRoleSchema,
  kind: ChatMessageKindSchema.default("chat"),
  text: z.string(),
  details: z.string().optional(),
  images: z.array(ChatMessageImageSchema).default([]),
  links: z.array(ChatInlineLinkSchema).default([]),
  quickActions: z.array(FeedActionSchema).default([]),
  tier: RoutingTierSchema.optional(),
  modelUsed: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  status: ChatMessageStatusSchema.default("done"),
  replyToMessageId: z.string().optional(),
  approvalId: z.string().optional(),
  triggerId: z.string().optional(),
  triggerName: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  unread: z.boolean().default(false),
});
export type ChatMessage = z.output<typeof ChatMessageSchema>;

export const RoutingTelemetrySchema = z.object({
  l0Hits: z.number().int().nonnegative().default(0),
  l1Hits: z.number().int().nonnegative().default(0),
  l2Hits: z.number().int().nonnegative().default(0),
  l3Hits: z.number().int().nonnegative().default(0),
  fallbackCount: z.number().int().nonnegative().default(0),
  lastTier: RoutingTierSchema.optional(),
  lastModelUsed: z.string().optional(),
  lastLatencyMs: z.number().int().nonnegative().optional(),
});
export type RoutingTelemetry = z.output<typeof RoutingTelemetrySchema>;
```

### 4.2 `BotSnapshot` 增量字段（严格向后兼容）

在 `BotSnapshotSchema` 中仅做**可选/带默认值的增量追加**：
- `butlerName: z.string().default("Paseo Bot")`
- `userName: z.string().default("")`
- `messages: z.array(ChatMessageSchema).default([])`（按时间升序，最旧在前、最新在后，单次快照最多返回最近 120 条）
- `routingTelemetry: RoutingTelemetrySchema.default(...)`
- `tierModels: z.object({ l1: z.string(), l2: z.string(), l3: z.string() }).optional()`

### 4.3 新增核心单流 RPC（保留全部既有 RPC 不删）

1. **`sendChatMessageRpc` (`bot.chat.send`)** — 主界面底部输入框唯一主入口：
   - Input：`{ text: string; images?: WishImageAttachment[]; replyToMessageId?: string; forceTier?: "L1" | "L2" | "L3"; providerOverride?: string; cwd?: string }`（校验至少有非空 `text` 或 `images`）
   - Output：`{ userMessageId: string; assistantMessageId?: string; ackMessageId?: string; tier: RoutingTier; modelUsed?: string; escalatedTo?: "L2" | "L3"; agentId?: string; routedSessionTitle?: string }`
2. **`markMessagesReadRpc` (`bot.chat.mark_read`)** — 打开对话流或滚动到底部时静默清未读：
   - Input：`{ upToMessageId?: string }`
   - Output：`{ ok: boolean }`
3. **`updateButlerProfileRpc` (`bot.profile.update`)** — 更新管家称呼/用户称呼（支持设置页或对话改名同步）：
   - Input：`{ butlerName?: string; userName?: string }`
   - Output：`{ ok: boolean; butlerName: string; userName: string }`
4. **旧 `submitWishRpc` (`bot.submit_wish`)**：保留完整签名与返回结构，供 `/wish` 斜杠命令及既有单测/调用方无缝工作，并同步在 `messages` 中落一条对应的对话记录。

### 4.4 `state.json` 平滑升级与零崩溃规范

- `PersistedBotState` 新增：
  - `messages: ChatMessage[]`（上限 200 条，加载时缺失自动回退 `[]`）
  - `l1AgentId: string | null`（常驻轻量 L1 管家会话 ID，缺失自动回退 `null`）
  - `routingTelemetry: RoutingTelemetry`（缺失自动初始化全 0）
  - `butlerNameOverride?: string | null`、`userNameOverride?: string | null`
- **首次加载迁移（无损投影）**：当旧版 `state.json` 加载且 `messages.length === 0` 时：
  - 若旧 `feed` 中存在最近非 `silent` 记录，将其最近 20 条按 `createdAt` 升序无损投影为初始 `messages`（`approval_required` 映射 `kind: "approval"`，其余映射 `kind: "proactive"`），并保留原 `feed` 不删；
  - 若 `feed` 也为空，写入（或首次快照生成）3 条 Dot 风格欢迎气泡，避免冷启动空白页。
- **体积保护**：写入 `state.json` 的 `ChatMessage.images` 绝不持久化动辄数 MB 的完整 base64 原图（仅存 `{ mimeType, name }` 或短缩略元数据），避免 `state.json` 膨胀拖慢读写。

---

## 5. 前端模块化拆分规范（指导 T-003）

`bubble-ui` 重构时需将原先 4,926 行的 `BotConsoleScreen.tsx` 拆分为高内聚低耦合模块（全部位于 `client/`）：

- `client/BotConsoleScreen.tsx`：顶层容器（整合顶部悬浮栏、`ChatStream`、`ChatComposer`、`ManagementDrawer` 与复用弹窗，目标控制在 400 行以内）。
- `client/ButlerAvatar.tsx`：Dot 风格柔和云朵/光球头像与思考呼吸态动效。
- `client/ChatStream.tsx`：单流消息滚动列表（自动贴底、时间分组线、向上滚动浮现 `↓` 回底按钮、键盘与窄屏适配）。
- `client/ChatBubble.tsx`：管家气泡（左）、用户气泡（右）、系统轻提示与内联链接点击处理（`openExternalUrl` / `openAgent`）。
- `client/InlineApprovalCard.tsx`：嵌入对话流的极简 Sentinel 确认轻卡片（支持展开/编辑 `payloadPreview`、`/tidy` 勾选清单、信任升级与已结态单行收敛）。
- `client/ChatComposer.tsx`：底部悬浮胶囊输入栏（`+` 轻菜单、图片粘贴/拖放/选图、L3 深度思考切换胶囊、自适应多行输入与 `Enter` 发送）。
- `client/ManagementDrawer.tsx`：左上角滑出管理抽屉（5 分区完整承载原生计划、事件/差量规则、长期记忆、后台子任务、待确认审批与模型分流状态）。
- `client/ConsoleModals.tsx` / `client/SettingsScreen.tsx` / `client/SidebarItem.tsx` / `client/store.ts` / `client/locales/{zh-CN,en}.json`：协同适配单流模型、乐观更新与双语文案。

---

## 6. 端到端验收场景（T-001 / T-002 / T-003 共享基准）

1. **冷启动体验**：打开 Paseo Bot，主屏呈现 Dot 风极简顶栏 + 柔和连续对话气泡流 + 底部胶囊输入栏，无 4-Tab 栏、无搜索栏、无工单卡片墙。
2. **日常秒回（L1）**：发送 `"嗨"` / `"谢谢"` → 乐观上屏用户蓝气泡，L1 轻量模型秒回温暖短气泡，绝不调用重模型。
3. **一句话改记忆与停提醒（L1）**：紧接一条主动提醒回复 `"停用了，我换 example.net 了"` → L1 自动写入 `MEMORY.md` 并在命中关联 `triggerId` 时静默加过滤词/停用旧提醒，回一条自然确认气泡。
4. **查证与两拍接力（L1 → L2）**：发送 `"帮我查下 Cloudflare Tunnel 能不能直接升级"` → 先出短气泡说明去查什么，随后 L2 核查完成后发出结论清晰、边界诚实的回复气泡。
5. **显式重任务升舱（L3）**：点击 `+` 开启 `深度思考 · L3` 或发送复杂架构/长文分析请求 → 精准路由到 L3（`gemini-4-neon`）。
6. **Sentinel 内联确认**：触发任意敏感操作或 `/tidy` → 对话流中出现内联轻确认卡，确认后执行并原地收敛为单行已完成态，不可绕过。
7. **左上角抽屉零丢功能**：点击左上角抽屉按钮，可无损增删改查原生计划、事件规则、4 个模板、长期记忆、后台子任务、审批队列与模型分级设置。
8. **旧状态零事故**：加载 v0.3.0 生产 `state.json` 无报错、无丢规则、无丢记忆，`npm run typecheck` 与 `npm test` 全绿。
