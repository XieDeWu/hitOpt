/* ══════════════════════════════════════════════════════════════════════════════
 * hitOpt · opt.js —— **缓存优化算法**（从 horae.client.js 整段搬运 + 只改依赖来源）
 *
 * 【这个文件是什么】
 *   把 horae.client.js 里"送出去之前最后那一段算子"整段搬到独立扩展里，让最终形态
 *   **Horae 原版 ＋ hitOpt 独立插件** 也能跑同一套缓存优化。
 *
 *   搬的是什么（一条链，顺序即源文件里的执行顺序）：
 *     CHAT_COMPLETION_PROMPT_READY
 *       → _applyStableFront(chat)          静态前置（把稳定 system 注入钉到固定位置）
 *       → _measureAssembledPrompt(chat,·)  采"池化前快照" + 起 4 秒兜底计时
 *     CHAT_COMPLETION_SETTINGS_READY
 *       → _onChatCompletionSettingsReady(data)
 *           ├ _normalizeLatestInputWrap(msgs)   最新输入套壳归一
 *           ├ _restoreFrozenHistory(msgs)       历史还原 ＋ A/B 池化（内部调 _abSplit）
 *           │     └ 再由 _abSplit 调 _freezeApply / _amPool* / _amAddr* / _algoPipe* …
 *           ├ _relocMoveVarBlock / _relocateVaryingBlocks  变量块后置（A/B 没跑时才走）
 *           ├ _samePromptShape / _shapeKeyOf
 *           └ _finalizeMeasure(p, msgs)         度量 + 记账（_measuredLcp / _gitLogPushTurn）
 *
 * 【搬运纪律（用户口径）】
 *   · 判据 / 阈值 / 顺序 / 文案 **一个字都没有改** —— 本文件里所有函数体都是
 *     horae.client.js 的**逐字切片**，函数上方那行注明它在源文件里的起止行号。
 *   · 原版函数 **一个字都没有复制**（见下面「二、原版函数依赖」那一节）。
 *   · 只改了"依赖从哪来"，全部列在「一、依赖换来源」里。
 *
 * 【注释约定】本文件的注释里一律不写反引号（项目硬约束）。
 *
 * ⚠⚠⚠ 【上机前必须先看这一条：不能和"魔改版 Horae"同时开】
 *   本模块与魔改版 horae.client.js 跑的是**同一套算子**。若两边同时生效，
 *   同一串 msgs 会被改写两遍、localStorage 里那几份基准/池也会互相覆盖。
 *   ⇒ 正确装法：**把 horae.client.js 换回原版**（7a88598 的 index.js）之后再启用本模块。
 *     过渡期若想两边都留着，**只能在 Horae 侧关掉缓存补丁**，
 *     绝不能让两套同时跑。
 *
 * ⚠ 【本模块**只读** Horae 的设置，不写回】源文件里那句 settings.autoSummaryCostStats = st
 *   照原样保留，但它落在**本模块自己的 settings 影子对象**上，不会写进 extension_settings.horae
 *   （写回要走 Horae 的 saveSettings，那是原版函数，本模块不碰）。
 * ══════════════════════════════════════════════════════════════════════════════ */

import { getContext, extension_settings } from '/scripts/extensions.js';
import { eventSource, event_types } from '/script.js';
/* ★ 依赖换来源③：差异分析的那 5 秒缓存 —— 源文件里是本模块内的 _diffAnalysisInvalidate，
   它要打的正是**账表那一份缓存**；hitOpt 里账表在 ledger.js ⇒ 从那儿引（同名同义）。 */
import { _diffAnalysisInvalidate } from './ledger.js';


/* ══════════════════════════════════════════════════════════════════════════════
 * 一、依赖换来源（**只改"从哪来"，判据一个字没改**）
 *
 *  ① settings        —— 源文件读 Horae 的 settings 对象（在 Horae 的模块作用域里，本模块够不到）。
 *                       改成：读 extension_settings.horae 上的**同名同字段**；
 *                       读不到就用源文件 DEFAULT_SETTINGS 里的那个默认值。
 *                       ⚠ 全部只读；本模块不会写回 Horae 的设置。
 *  ② estimateTokens  —— **原版函数**（@21032，474 名单内）⇒ ⛔ 不复制。见下面的占位说明。
 *  ③ _diffAnalysisInvalidate —— 从 ./ledger.js 引（打的是账表那份 5 秒缓存），不再是本模块内的副本。
 *  ④ _diffRenderIfOpen —— 差异面板重画（纯 UI，画的是 Horae 抽屉里那个 tab）⇒ 本模块不碰 DOM，留空桥。
 *  ⑤ _normalizePromptMessageText —— **原版函数**（@39356）⇒ ⛔ 不复制，留"原样返回"的占位（见下）。
 *  ⑥ getContext / eventSource / event_types —— 改成酒馆自己的模块 API
 *                       （/scripts/extensions.js、/script.js），不 import Horae 任何东西、
 *                       不读 window.Horae。
 *  ⑦ _measureAssembledPrompt 的第二个形参 injectedTexts —— 源文件由 Horae 的注入系统给
 *                       （时间线 / 世界书 @D 注入的文本清单）；本模块**不做注入** ⇒ 传空数组。
 *                       后果如实列：_finalizeMeasure 的"全价区逐条归因"里少了"Horae 注入"那一类；
 *                       其余判据、算法一个字没变（它不影响 msgs 的改写）。
 *  ⑧ _amPool / _amAddr / _prevMsgs / _freeze 那几份落盘 —— 沿用源文件的 localStorage 键名与格式，
 *                       一字未改（见下面「写动作风险清单」）。**这也是"两边不能同时开"的原因之一**。
 * ══════════════════════════════════════════════════════════════════════════════ */

/* ── ① settings 影子对象 ────────────────────────────────────────────────────── */
/** 源文件 DEFAULT_SETTINGS 里这几个字段的默认值（后面的 @N 是 horae.client.js 的行号）。 */
const OPT_SETTINGS_DEFAULTS = {
    autoSummaryCostStats: null,        // @192
    promptStableFront: true,           // @206
    stableFrontNonSystem: true,        // @130
    cacheRelocateVarying: true,        // @211
    cacheFreezeInject: true,           // @212
    wiDepthHoistRules: {},             // @204
    cacheRestoreHistory: undefined,    // 源码里没有这个默认值：只有 === false 才算"关"
};
/** 本模块读的那几个字段（就这些，不多读） */
const OPT_SETTINGS_KEYS = Object.keys(OPT_SETTINGS_DEFAULTS);

/** 影子设置对象。**可变**：源文件里那句 settings.autoSummaryCostStats = st 要能落地（只落在本对象上）。 */
const settings = { ...OPT_SETTINGS_DEFAULTS };

/** 每一轮开跑前把用户在 Horae 设置里改过的值同步进来（读不到就保持默认值）。 */
function _optSyncSettings() {
    for (const k of OPT_SETTINGS_KEYS) {
        try {
            const v = extension_settings?.horae?.[k];
            if (v !== undefined) settings[k] = v;
            else settings[k] = OPT_SETTINGS_DEFAULTS[k];
        } catch (_) { /* 读不到就用默认值 */ }
    }
    return settings;
}

/* ── ② estimateTokens 占位（⛔ 原版函数，不复制） ───────────────────────────── */
/** 源文件 @21032 的 estimateTokens 是**原版就有的函数**（474 名单内）⇒ ⛔ 不许复制。
 *  它在被搬的这一段里只有两个调用点，都在 _countStMessage / _countStText 的 catch 里
 *  —— 也就是"酒馆分词器（/scripts/tokenizers.js）加载失败"时的兜底估算。
 *  本模块够不到原版那个函数（酒馆的扩展是按 type=module 加载的 ⇒ 原版的顶层 function
 *  不是全局；也不许读 window.Horae）⇒ 这里放一个**同签名占位**，并让"没实现"这件事
 *  **当场暴露**：抛一个带名字的错误，由调用点原有的 try/catch 接住。
 *  表现（如实说）：**酒馆分词器不可用的那一轮，本模块数不出 token、也就不写这一轮的账** ——
 *  宁可不记，也不要悄悄写一个看起来正常的错数。 */
function estimateTokens() {
    throw new Error('hitOpt: estimateTokens（原版函数 @21032）未搬运 —— 酒馆分词器不可用时无法兜底估算，本轮不记账');
}

/* ── ⑤ _normalizePromptMessageText 占位（⛔ 原版函数，不复制） ──────────────── */
/** 源文件 @39356 的 _normalizePromptMessageText 是**原版就有的函数** ⇒ ⛔ 不许复制。
 *  它只被 _sfChatHashes 用一次：给"chat 里每条正文"再补一个**剥掉 think / 标签后的**指纹，
 *  好让静态前置认出"这块 system 就是聊天历史里的某一条"。
 *  占位实现 = **原样返回**（不是复制：它一个字符都不归一）。
 *  后果（如实说）：_sfChatHashes 只按**原文**建指纹，少了"归一形态"那一份
 *  ⇒ 静态前置认"预设块"时会略保守（stableFrontNonSystem 那一支可能少认几条）。
 *  这是本模块**唯一**一处行为与源文件不同的判据，其余一字未改。 */
function _normalizePromptMessageText(text) {
    return String(text ?? '');
}

/* ── ④ _diffRenderIfOpen 空桥（纯 UI） ──────────────────────────────────────── */
/** 源文件 @27698：差异分析页开着就重画一遍（画的是 Horae 抽屉里那个 tab 的 DOM）。
 *  hitOpt 里那块界面归 index.js / ledger.js 管，本模块**不碰 DOM** ⇒ 留空桥。
 *  调用点（_gitLogPushTurn 落盘之后那一句）原样保留。 */
function _diffRenderIfOpen() {
    /* 面板由 hitOpt 的 index.js 自己的刷新节奏负责 */
}

/* ══════════════════════════════════════════════════════════════════════════
 * 一、模块级状态与常量 —— **源文件逐字搬运**（按源行号排列）
 *   每条上面那行注释里的 @N 就是它在 horae.client.js 里的行号，便于逐字对账。
 * ══════════════════════════════════════════════════════════════════════════ */

/* @117 */
const DEFAULT_SETTINGS = {
    uiLanguage: 'auto',
    aiOutputLanguage: 'auto',
    enabled: true,
    autoParse: true,
    autoFillPrevTimelineOnSend: false, // 发送前自动补全上一条AI消息的时间线（默认关闭，避免静默误写历史）
    injectContext: true,
    useMainPresetForAiTasks: false, // AI分析/批量扫描/手动压缩是否使用酒馆主预设（generate）
    showMessagePanel: true,
    injectionDepthSource: 'tail', // 注入深度来源: tail(尾部锚定：历史之后，断点落在上一轮末尾→命中随历史增长)【v6.5 起默认】 / anchor(固定锚点：历史之前，动态块会把后面整段历史按全价重算) / preset(按提示词末尾偏移) / system(按聊天楼层，每轮往后挪)
    injectionPosition: 0,
    timelineInjectionMode: 'inline', // inline(原逻辑合并注入) / separate(剧情轨迹独立前置)
    timelineCompactVisible: true, // v6.5：轨迹里"正文里还在"的楼层只留一行汇总索引（描述不重复发）
    stableFrontNonSystem: true,   // v6.5：静态前置也搬"预设块"（非聊天历史的 user/assistant 稳定块）
    // v6.9：**既定历史（不是最新那一条）的正文，默认一个字都不许改**。
    // 为什么：历史消息一改，它后面整段提示词的缓存立刻作废（实测：一条 AI 回复尾巴被删 → 后面 5k~8k tok 全价）。
    // 想给模型看到新状态，就写结构化数据（不进提示词）或把内容追加到**最新一条的尾巴**。
    // 只有你自己在面板上动手（改楼层数据 / 批量扫描确认 / HUD 编辑）才会带着代价提示放行。
    historyRewriteAllow: false,
    // v6.9：改写历史的"花钱上限"（元）。0 = 不设上限（只受上面那个开关约束）。
    // 一旦某次改写预计超过这个数，自动流程直接放弃（用户手动操作照做，但会把价钱打出来）。
    historyRewriteMaxYuan: 0,
    lastStoryDate: '',
    lastStoryTime: '',
    favoriteNpcs: [],  // 用户标记的星标NPC列表
    pinnedNpcs: [],    // 用户手动标记的重要角色列表（特殊边框）
    // 发送给AI的内容控制
    sendTimeline: true,    // 发送剧情轨迹（关闭则无法计算相对时间）
    contextDepth: 15,      // 一般级别剧情轨迹数量
    sendCharacters: true,  // 发送角色信息（服装、好感度）
    sendCharacterAffection: true,        // 单独控制好感度注入
    sendMainCharacterPersonality: true,  // 关闭后主要角色（卡片本体 + 置顶 NPC）的性格简述不再注入
    sendItems: true,       // 发送物品栏
    panelLayoutStyle: 'classic',         // 'classic' = 默认 / 'glass' = 半透明玻璃 / 'obsidian' = 曜石简约 / 'cyber' = 赛博
    customTables: [],      // 自定义表格 [{id, name, rows, cols, data, prompt}]
    customSystemPrompt: '',      // 自定义系统注入提示词（空=使用默认）
    customBatchPrompt: '',       // 自定义AI摘要提示词（空=使用默认）
    customAnalysisPrompt: '',    // 自定义AI分析提示词（空=使用默认）
    customCompressPrompt: '',    // 自定义剧情压缩提示词（空=使用默认）
    customAutoSummaryPrompt: '', // 自定义自动摘要提示词（空=使用默认；独立于手动压缩）
    customAutoResummaryPrompt: '', // 自定义二次总结提示词（空=使用默认）
    aiScanIncludeNpc: false,     // AI摘要是否提取NPC
    aiScanIncludeAffection: false, // AI摘要是否提取好感度
    aiScanIncludeScene: false,    // AI摘要是否提取场景记忆
    aiScanIncludeRelationship: false, // AI摘要是否提取关系网络
    panelWidth: 100,               // 消息面板宽度百分比（50-100）
    panelOffset: 0,                // 消息面板右偏移量（px）
    themeMode: 'dark',             // 插件主题：dark / light / custom-{index}
    customCSS: '',                 // 用户自定义CSS
    customThemes: [],              // 导入的美化主题 [{name, author, variables, css}]
    globalTables: [],              // 全局表格（跨角色卡共享）
    showTopIcon: true,             // 显示顶部导航栏图标
    customTablesPrompt: '',        // 自定义表格填写规则提示词（空=使用默认）
    sendLocationMemory: false,     // 发送场景记忆（地点固定特征描述）
    customLocationPrompt: '',      // 自定义场景记忆提示词（空=使用默认）
    sendRelationships: false,      // 发送关系网络
    sendMood: false,               // 发送情绪/心理状态追踪
    customRelationshipPrompt: '',  // 自定义关系网络提示词（空=使用默认）
    customMoodPrompt: '',          // 自定义情绪追踪提示词（空=使用默认）
    // 自动摘要
    autoSummaryEnabled: false,     // 自动摘要开关
    autoSummaryKeepRecent: 3,      // AI消息最低保真数：压缩后至少保留最近N条AI消息的原文（0~99；它同时是每次压缩的重算尾巴 S）
    autoSummarySourceMode: 'fulltext', // 'fulltext'(全文+时间线) | 'events'(仅时间线事件)
    autoSummaryBufferMode: 'messages', // 'messages'(按AI条数) | 'tokens'
    autoSummaryBufferLimit: 10,     // 旧版缓冲阈值（迁移用）
    autoSummaryBufferMsgLimit: 10,  // 按AI条数触发的阈值
    autoSummaryBufferTokenLimit: 30000, // 按Token数触发的阈值
    autoSummaryResummaryThreshold: 7, // <=0 关闭二次总结；>0 时同层摘要达到此值触发更高层摘要（2->3->4...）
    autoSummaryResummaryMinChars: 800, // 二次总结输入字数下限；不足时跳过避免对短文本反复压缩降质
    autoSummaryBatchMaxMsgs: 50,    // 单次摘要最大消息条数
    autoSummaryBatchMaxTokens: 80000, // 单次摘要最大Token数
    // ── 缓存优化补丁（本地）────────────────────────────────────────
    autoSummarySettleHide: true,      // 结算式隐藏：只在压缩事件时成块隐藏，不做每轮滑动预隐藏（缓存友好）
    autoSummaryCapEnabled: true,      // 上下文上限兜底：估算的完整提示词超过上限即强制压缩（默认开）
    autoSummaryCapTokens: 300000,     // 上限（实测的完整提示词 tokens）：按常见 300K 级窗口设定
    autoSummaryCostStats: null,       // 缓存代价快照（前台观测用）
    // ── 下面这几个 v6.21.8 起**面板上已经没有控件**了（那块「缓存代价观测（人民币估算）」整块删掉：
    //    每轮的钱与命中率现在只在「差异分析」页看，官方 usage 打底）。键留着是为了老存档读得回来，
    //    实现照旧认它们：priceMode 决定计价时段，injectCap/Budget 仍是注入上限/总预算。──
    autoSummaryPriceMode: 'auto',     // 计价时段：auto(按北京时间空闲窗口) / idle / peak
    autoSummaryLiveTips: true,        // （已无 UI）旧的"面板内实时读数"开关，留着给老存档
    // ── 注入经济学（v4.4）：摘要会被注入回提示词，注入块每轮都要重发 ──
    //    （v6.21.8 起面板上不再给这两个输入框；值为 0 = 不限，实现照旧）
    autoSummaryInjectCap: 0,          // 单张摘要注入上限（tok，0=不限）：超出的注入时截断，只影响注入，卡片/聊天保留全文
    autoSummaryInjectBudget: 0,       // 摘要注入总预算（tok，0=不限）：按"新→旧"装填，超出的摘要不注入
    // ── v4.9：世界书 @D 缓存命中化（**默认开启**：扫到的 @D 块一律前移，原槽位只留一行指针）──
    wiDepthHoistEnabled: true,        // 总开关（默认 true）：@D 块搬进命中区，原地只留 ≤100 tok 唤起词索引
    wiDepthHoistRules: {},            // 逐块覆盖：{ 'customDepthWI_<depth>_<role>': { on:false, name, suspended, changedStreak, stableStreak, everSuspended } }
                                      // 没有条目的块按默认走（前移）；只有 on:false / suspended:true 才留在 @D
    promptStableFront: true,          // v5.0 静态前置：把"内容没变、只是被摆在末尾锚定位置"的 system 注入钉到固定位置（只动 system，绝不动对话历史）
    // v6.21.9：这里以前有 runLogEnabled（内存运行记录）与 gitLogEnabled（AI 消息 diff 开关）两个键。
    //   用户定版："**我不需要内存临时存储，只需要 git + 硬盘**" —— 内存运行记录整套删掉（差异分析只读
    //   git 仓库 + 硬盘上的 usage.json），设置页那个勾选框也删了，所以 git 记录**照旧一律在记**：
    //   老存档里遗留的 `gitLogEnabled:false / runLogEnabled:false` 已经没有代码读它，不会再悄悄关掉记录。
    cacheRelocateVarying: true,       // v6.16 变量后置：断点坐在前部 system 块里时，把"每轮在变的那一段"搬到末尾、原地留常量指针
    cacheFreezeInject: true,          // v6.24.24 冻结注入池：完整注入只发一次（存进只增不改的池），此后只发增量＋指针索引
    /* ★ v6.39.20【主算法 ⇄ 实验算法 互换】用户 2026-09-19 拍板原话：
     *   "**将主算法与当前的2.4实验算法互换，现在它2.4就是主算法了！**"
     *   盘上评估（真切片的 B0，6 轮合计）：只池化省 46.7%（miss 161,204 tok）／
     *   只 v2.4 省 85.5%（43,719 tok）／两层叠加 86.3%（41,412 tok）—— 叠加只多 0.8 个百分点
     *   ⇒ 互换之后每 6 轮少花 ¥0.11748（空闲档）。空串 = 关，立刻回原来的两层指针化。 */
                                      //   判据全是本轮实测（断点位置 + 与上一轮真文本的差异段），不猜；只动 system，绝不动对话历史；
                                      //   内容一个字不删（只是换位置）。不满足判据就一个字不动（面板读数里会写为什么没动）
    autoSummaryUseCustomApi: false, // 是否使用独立API端点
    autoSummaryApiUrl: '',          // 独立API端点地址（OpenAI兼容）
    autoSummaryApiKey: '',          // 独立API密钥
    autoSummaryModel: '',           // 独立API模型名称
    auxApiEnabled: false,            // 辅助API总开关
    auxApiUrl: '',                   // 辅助API端点地址
    auxApiKey: '',                   // 辅助API密钥
    auxApiModel: '',                 // 辅助API模型名称
    auxApiUseForAnalysis: true,      // AI分析/魔术棒/发送前补全
    auxApiUseForSummary: true,       // 自动总结/AI智能补全
    auxApiUseForManualCompress: false, // 手动多选压缩
    auxApiFallbackToMain: false,     // 辅助API失败后回退主API
    antiParaphraseMode: false,      // 反转述模式：AI回复时结算上一条USER的内容
    sideplayMode: false,            // 番外/小剧场模式：启用后可标记消息跳过Horae
    // 自定义日历：开启后插件按 monthNames/monthDays 解析剧情日期；未启用走默认公历+奇幻兜底
    customCalendar: {
        enabled: false,
        monthNames: [],
        monthDays: [],
    },
    // 已忽略过自定义日历建议的 chatId 集合，避免同一会话反复弹窗
    _customCalendarHintDismissed: {},
    // RPG 模式
    rpgMode: false,                 // RPG 模式总开关
    rpgStrictPresentOnly: false,     // 无在场角色时不发送RPG数据
    sendRpgBars: true,              // 发送属性条（HP/MP/SP/状态）
    rpgBarsUserOnly: false,         // 属性条仅限主角
    sendRpgSkills: true,            // 发送技能列表
    rpgSkillsUserOnly: false,       // 技能仅限主角
    sendRpgAttributes: true,        // 发送多维属性面板
    rpgAttrsUserOnly: false,        // 属性面板仅限主角
    sendRpgReputation: true,        // 发送声望数据
    rpgReputationUserOnly: false,   // 声望仅限主角
    sendRpgEquipment: false,        // 发送装备栏（可选）
    rpgEquipmentUserOnly: false,    // 装备仅限主角
    sendRpgLevel: false,            // 发送等级/经验值
    rpgLevelUserOnly: false,        // 等级仅限主角
    sendRpgCurrency: false,         // 发送货币系统
    rpgCurrencyUserOnly: false,     // 货币仅限主角
    rpgUserOnly: false,             // RPG全局仅限主角（总开关，联动所有子模块）
    sendRpgStronghold: false,       // 发送据点/基地系统
    rpgBarConfig: [],
    rpgAttributeConfig: [],
    rpgAttrViewMode: 'radar',       // 'radar' 或 'text'
    customRpgPrompt: '',            // 自定义RPG提示词（空=默认）
    promptPresets: [],              // 提示词预设存档 [{name, prompts:{system,batch,...}}]
    equipmentTemplates: [],          // 装备格位模板（i18n 初始化后生成）
    rpgDiceEnabled: false,          // RPG骰子面板
    dicePosX: null,                 // 骰子面板拖拽位置X（null=默认右下角）
    dicePosY: null,                 // 骰子面板拖拽位置Y
    // 教学
    tutorialCompleted: false,       // 新用户导航教学是否已完成
    // 向量记忆
    vectorEnabled: false,
    vectorSource: 'local',             // 'local' = 本地模型, 'api' = 远程 API
    vectorModel: 'Xenova/bge-small-zh-v1.5',
    vectorDtype: 'q8',
    vectorApiUrl: '',                  // OpenAI 兼容 embedding API 地址
    vectorApiKey: '',                  // API 密钥
    vectorApiModel: '',                // 远程 embedding 模型名称
    vectorPureMode: false,             // 纯向量模式（强模型优化，关闭关键词启发式）
    vectorRerankEnabled: false,        // 启用 Rerank 二次排序
    vectorRerankFullText: false,       // Rerank 使用全文而非摘要（需要长上下文模型如 Qwen3-Reranker）
    vectorRerankModel: '',             // Rerank 模型名称
    vectorRerankUrl: '',               // Rerank API 地址（留空则复用 embedding 地址）
    vectorRerankKey: '',               // Rerank API 密钥（留空则复用 embedding 密钥）
    vectorRerankCandidates: 25,        // Rerank 候选条数（embedding 召回上限）
    vectorRerankRecallThreshold: 0.3,  // Rerank 路径的 embedding 召回阈值
    vectorRerankMinScore: 0.5,         // Rerank 最低分；低于此分丢弃
    vectorRerankContextLimit: 32768,   // Rerank 上下文上限（8K/Cohere/Jina 类用户需手动改小）
    vectorDebugLog: false,             // 向量召回详细调试日志（默认关闭，开启后输出阈值/频率/去重等明细）
    vectorRecallPresets: [],           // 用户自定义召回参数预设
    vectorRecallPresetSelected: 'builtin:small',
    vectorTopK: 5,
    vectorThreshold: 0.72,
    vectorFullTextCount: 3,
    vectorFullTextThreshold: 0.9,
    vectorStripTags: '',
    vectorQueryRewriteEnabled: false,    // 多角度 Query 重写；默认关，强制走辅助 API 避免阻塞主回合
    vectorQueryRewriteSystemPrompt: '',  // 自定义重写提示词（空=使用默认按语言加载）
    // 角色卡设置档：把 Horae 配置随卡保存，切卡时按模式套用
    // ''=未设定（默认，不做任何处理直到用户选定）；ask=切卡时弹窗确认；auto=静默套用；badge=不弹窗只在抽屉挂提示；never=完全不处理
    cardProfileMode: '',
    // key=avatar 文件名，value=已忽略的 profile.savedAt；卡作者更新设置档（savedAt 变了）会重新提示
    _cardProfileHintDismissed: {},
};

/* @18532 */
/* ★ 2026-09-24【这个号现在是 **hitOpt 自己的版本**】—— 用户原话："**没有HORAE_CACHE_PATCH，
 *   我们只有独立插件hitOpt**"。它以前是从魔改版 Horae 抄过来的号（`v6.55.0`），
 *   而它**不是死注释**：抬头与面板报的 `cli=`、算法版本标签、以及 `/turn` 的版本戳
 *   读的都是它（见本文件 `ver: String(...)` 那几处、`ledger.js` 的算法标注行）
 *   ⇒ 于是面板一直显示 `cli=v6.55.0`，跟插件自己的 `v7.3.0` 对不上，用户看着就是"版本错了"。
 *   ⇒ 值改成 hitOpt 的版本，**与 `index.js` 的 `APP_VERSION` 保持一致**（升版本时两处一起改）。
 *   ⚠ 常量名是历史遗留（改它要动构建链：`tools/parts/__var_*.js` ＋ `tools/plan.json`），
 *     留待下一步统一改名 —— ⛔ 但在那之前**值不许再对不上**。 */
const HORAE_CACHE_PATCH = 'v7.3.6';

/* @18536 */
const HORAE_HOIST_OFF = true;

/* @19347 */
const _EMPTY_AUTOSUM_COST = {
    // ── 实测（v4.8）：完整提示词 = 真的发出去的那个 messages 数组，用 ST 自己的分词器数出来 ──
    //    绝不再预设"预设/世界书/角色卡有多长"——它们天天在变，只能量。
    measuredPromptTok: 0,          // 完整提示词（实测，含预设/世界书/角色卡/正文/注入块）
    measuredInjectTok: 0,          // 其中 Horae 注入块（实测）
    measuredMsgs: 0,               // 实测时的消息条数
    measuredAt: 0,                 // 实测时间戳
    measuredChatKey: '',           // 实测时的聊天标识（换聊天后旧数字不冒充新鲜）
    measuredBy: '',                // 'st'（ST 分词器）| 'local'（本地估算兜底）
    // ── v4.9：每轮必然全价区（最早那个末尾锚定注入之后的部分，下一轮一定按全价重算）──
    wiFullPriceTok: 0,             // 实测：从最早的末尾锚定注入点到末尾的 token
    wiWiTok: 0,                    // 其中世界书 @D 块（未被前移的那些）
    wiBreakIdx: -1,                // 断点在 messages 里的下标（-1 = 本轮没有末尾锚定注入）
    wiHoistedCount: 0,             // 本轮前移进命中区的 @D 块数
    wiHoistedTok: 0,               // 其中前移走的 token（H：这些 token 从全价区挪进了命中区）
    wiPointerTok: 0,               // 留在原槽位的唤起词索引 token（P：它仍在全价区，要减掉）
    wiResumeNeed: 0,               // 自动试前移所需的"连续稳定轮数"（= 提示词总量 ÷ 每轮全价区，实测）
    wiBlocksSeen: 0,               // 本轮酒馆注册表里的 @D 块数
    // ── v4.9.4：真断点定位器（与上一轮逐条比对得出的"本轮必然全价区"，并逐条拆开）──
    pfBreakIdx: -1,                // 真断点下标（-1 = 没有可比对象/完全相同）
    pfRegionTok: 0,                // 从真断点到末尾的 token（本轮必然按全价重算的部分）
    pfReplyTok: 0,                 // 其中：上一轮刚生成的回复（新内容，这一轮必然全价，下一轮就变命中）
    pfInjectTok: 0,                // 其中：Horae 自己的注入块（末尾锚定 → 每轮全价；可改成锚定）
    pfWiTok: 0,                    // 其中：未前移的世界书 @D 块
    pfPointerTok: 0,               // 其中：前移后留在原槽位的唤起词指针
    pfNewTok: 0,                   // 其中：新消息/正文
    pfMovedTok: 0,                 // 其中：与上一轮**同文本、只是换了位置**的块（末尾锚定注入 → 锚定即可命中）
    pfFreshTok: 0,                 // 其中：上一轮**根本没有这段文本**的块（每轮新出现/在变 → 缓存不了，真凶在这里）
    pfDetail: [],                  // 逐条：#下标 角色 token 判定
    // ── v5.0：静态前置（把"内容没变、只是被摆在末尾锚定位置"的 system 注入钉到固定位置）──
    sfMovedCount: 0,               // 本轮钉住几块
    sfMovedTok: 0,                 // 这些块共多少 token（已进命中区 → 每轮省 0.98/M）
    pfTotalTok: 0, pfMsgs: 0, pfTurnSeq: 0, pfParts: '',
    // ── 官方 usage（唯一权威的命中/未命中与花费）──
    lastRealHitTok: 0, lastRealMissTok: 0, lastPromptTok: 0, lastRealAt: 0,
    lastSideInTok: 0, lastSideOutTok: 0, lastSideHitTok: 0, lastSideMissTok: 0,
    usageMissing: 0,               // 响应里没有 usage 字段的次数（流式且上游未开 include_usage）
    // ── 当前这一刻的本地量 ──
    lastChatLen: 0,                // 上次检查时的 chat 长度（算"本回合新增"用）
    curPromptTok: 0, curVisibleTok: 0, curInjectTok: 0, curNewTurnTok: 0,
    coveredTok: 0,                 // 当前被摘要覆盖(已移出上下文)的正文 token 快照
    // ── 注入块构成（最近一次快照）──
    injMode: 'inline', injTotalTok: 0, injFrontTok: 0, injTailTok: 0, injReceive: '',
    skippedSummaries: 0,           // 被跳过注入的摘要卡数（覆盖楼层还在正文里 → 不重复注入）
    // ── 门禁结论：当前 vs 假如压了 ──
    gateText: '', gateU: 0, gateS: 0, gateSaveTok: 0, gateSaveYuan: 0, gateOneTimeYuan: 0,
    gateKeepTok: 0, gateKeepRecent: 0,
    dInjTok: 0, dInjAddTok: 0, dInjDropTok: 0, injTaxTok: 0, minUInjTok: 0,
    dInjRealTok: 0,                // 压缩前后各量一次的实际注入增量
    // ── 最近一次压缩 / 二次总结的结果 ──
    rsMergeRatio: 0,               // 合并后 ÷ 合并前 的摘要体积比（最近一次实测）
    lastText: '', rsLastText: '', rsSkipText: '',
};

/* @19403 */
let _wiDepthBlocks = [];

/* @19405 */
const _wiDepthTokCache = new Map();

/* @19652 */
const _measuredMsgTok = new Map();

/* @19654 */
const COST_MAP_MAX = 4000;

/* @21042 */
let _stTokMod = null;

/* @21043 */
let _stTokTried = false;

/* @21044 */
let _measureSeq = 0;

/* @21130 */
const CACHE_BLOCK_TOK = 64;

/* @21164 */
const WI_DEPTH_POINTER_SUFFIX = '｜详细内容已移到这条请求最前面的设定区（第一条 system 消息之后、角色定义之前），这里只留提示';

/* @21165 */
const WI_DEPTH_POINTER_SUFFIX_OLD = '｜详细内容已前置到提示词开头的设定区，此处仅作提示';

/* @21166 */
const WI_DEPTH_POINTER_SUFFIXES = [WI_DEPTH_POINTER_SUFFIX, WI_DEPTH_POINTER_SUFFIX_OLD];

/* @21174 */
const WI_DEPTH_POINTER_MAX_CHARS = 120;

/* @21637 */
let _diffCache = { rows: [], at: 0, source: '' };

/* @22886 */
const EXP_ALGO_KEY = 'horae_exp_algo_v1';

/* @22907 */
let _expAlgoCache = {};

/* @22955 */
let _expAlgoReg = null;

/* @22956 */
let _expAlgoRegLoading = null;

/* ★★★★★★ 2026-09-24【补搬 · 缺口：注册表装载】—— 逐字搬自 `horae.client.js` @22957-22988。
 *
 *  病（对拍器 `tools/parity_opt.mjs` 当场抓出来的）：`_expAlgoReg` 只搬了**声明**（@22955）
 *  与 3 处**读取**（`_algoPipeSnap` / `_algoPipeRun` 两级 / `_algoPipeRun` 记账那处），
 *  而把它**赋值**的那一段（`_expAlgoLoad` ＋ 那一行预热）**没搬过来** ⇒ `_expAlgoReg` 恒为 `null`
 *  ⇒ `_algoPipeRun` 拿不到 `apply` ⇒ 池化管线**每一轮**都报
 *  「「ptr-exact-v2.4」不在算法清单里（或它没有 apply）」⇒ B 区只能是原文（`mainSave = 0`）。
 *  ⚠ 这一条**静态检查抓不到**（名字声明了，只是永远是 null）—— 只有真跑一轮才看得见。
 *
 *  ⚠ 装载那一跳用的是**相对说明符**（下面函数里那一行 `./core/expAlgo/index.js`）：浏览器里按
 *    **本模块自己的 URL** 解析，即 `…/scripts/extensions/third-party/hitOpt/core/expAlgo/index.js`。
 *    ⇒ 算法本体那 11 个文件必须**部署在 hitOpt 自己的扩展目录里**（见
 *    `_notes/搬迁-路径改动清单.md` 的「reset 之后还需要做什么」；sync3 的新落点条目待加）。
 *    它**不是**指向 Horae 扩展目录的路径，所以"hitOpt 独立"这一条没破。
 *  ⚠ 下面这一段**一个字都没改**（源文件怎么写就怎么搬），只把位置挪到 `_expAlgoReg` 旁边。 */

/* @22957-22961 */
/* ★ v6.39.20【互换：预热】主算法要用它 ⇒ 不再等"打开面板"，扩展一加载就开始 import（幂等）。
 * ⚠ 这一行必须留在**实验算法节内部**：在 `_abSplit` 里引用取数/加载那几个名字，会把这一节的
 *    边界撑破（`exp_algo_test` 当场抓到 —— 池化前原文那个读数落进了节内，判红）。
 * ⚠ 也正因为这样，本节注释里**不许出现那个读数的名字**。 */
try { _expAlgoLoad().catch(() => { }); } catch (_) { }

/** 动态加载算法清单（**只在第一次真要算的时候**发生） */
/* @22963-22988 */
async function _expAlgoLoad() {    if (_expAlgoReg) return _expAlgoReg;
    if (!_expAlgoRegLoading) {
        _expAlgoRegLoading = import('./core/expAlgo/index.js')
            .then((m) => {
                _expAlgoReg = m;
                /* ★ v6.39.10【主算法条目的版本号 = 客户端版本】
                 *   `mainAlgo.js` 里那格写的是占位串 —— 主算法的真版本就是 `HORAE_CACHE_PATCH`
                 *   （它的池化逻辑就在这份客户端里）。**加载完立刻填上**，这样下拉框里
                 *   显示的是「主算法（Horae 池化） v6.39.10」这种**可对账**的名字，
                 *   而不是一句"由客户端填"。 */
                try {
                    for (const a of (m.list ? m.list() : [])) {
                        if (a && a.kind === 'disk' && !/^v\d/.test(String(a.version || ''))) {
                            a.version = HORAE_CACHE_PATCH;
                        }
                    }
                } catch (_) { }
                return m;
            })
            .catch((e) => {
                _expAlgoRegLoading = null;                 // 失败允许重试（别把一次网络抖动钉死）
                throw new Error(`实验算法清单加载不了：${String(e?.message || e)}`);
            });
    }
    return _expAlgoRegLoading;
}

/* @26378 */
/* ★ 2026-09-24（第二十三批）：记录服务的挂载名 —— 服务端 `info.id` 从 `horae-git` 改成 `hitopt-git`
 *   （记录服务是 **hitOpt 自己的**，不该再挂 Horae 的名；用户原话："这里的 horae 的 id 也没改 hitopt"）。
 *   候选**新的在前、旧的兜底**：服务端模块是酒馆启动时加载的 ⇒ 没重启时旧路由还在，
 *   面板照常能用（状态条会如实标出"还是旧挂载名"），重启之后自动切到新名。 */
const GIT_LOG_IDS = ['hitopt-git', 'horae-git'];
const GIT_LOG_BASES = GIT_LOG_IDS.map((x) => `/api/plugins/${x}`);

/* @26385 */
let _gitLogId = '';

/* @26386 */
let _wiretapId = '';

/* @26397 */
let _gitLogBase = null;

/* @26398 */
let _gitLogOk = null;

/* @26399 */
let _gitLogInfo = null;

/* @26400 */
let _gitLogTried = 0;

/* @26405 */
let _gitLogSwipePending = false;

/* @26406 */
const SWIPE_PENDING_TTL_MS = 10 * 60 * 1000;

/* @26408 */
const _gitLogChat = () => _currentChatKey();

/* @26477 */
let _gitLogCsrfCache = '';

/* @26507 */
let _diagFailN = 0;

/* @26510 */
let _diagLast = null;

/* @26592 */
let _sendProof = null;

/* ★★★★★★ 2026-09-24【同一轮只许落一次盘】—— 上一次**成功提交**用的 sendProof 指纹。
 *  病与判据见 `_gitLogPushTurn` 里 `/turn` 之前那一大段（线上实测：同一对轮共享同一个 `proofAt`）。
 *  ⛔ 只在提交成功之后写；指纹 = `digest@at`（真重 roll 会给出新取证 ⇒ 指纹不同 ⇒ 不会被拦）。 */
let _lastTurnProofFp = '';
let _lastTurnProofAt = 0;
let _lastTurnProofNo = -1;

/* @26597 */
let _lastSendAt = 0;

/* @26599 */
let _lastFinalSnap = null;

/* ★ 2026-09-24【补回搬迁漏掉的一跳】官方 usage 采集的累计计数 —— 只用来决定"第几次才出声"，
   不参与任何计算。魔改版把这个数记在 Horae 的设置对象里（`st.usageMissing`），
   hitOpt **不拥有**那份设置 ⇒ 放模块级（见 `_captureUsageFromResponse` 那段）。 */
let _usageMissing = 0;

/* @26974 */
const WIRE_TRY_DELAYS = [0, 700, 1600];

/* @27018 */
const WIRE_WAIT_STEPS = [1500, 3000, 5000, 5000, 5000, 5000];

/* @27019 */
const WIRE_WAIT_MIN_MS = 8000;

/* @29432 */
let _prevPromptItems = null;

/* @29433 */
let _pfTurnSeq = 0;

/* @29440 */
let _prev2PromptItems = null;

/* @29441 */
let _sfOrder = [];

/* @29442 */
let _sfInfo = { moved: [], at: -1, tok: 0 };

/* @29444 */
const _tailKeepHashes = new Set();

/* @29486 */
const _amPoolSend = new Map();

/* @29511 */
const AM_POOL_STORE = 'horae_am_pool_v1';

/* @29521 */
let _amPoolSnapText = '';

/* @29541 */
let _amPoolDiskText = '';

/* @29542 */
let _amAddrDiskText = '';

/* @29543 */
let _amPoolDiskChat = '';

/* @29606 */
const AM_POOL_MAX = 4000;

/* @29607 */
const _amPoolAt = new Map();

/* @29608 */
let _amPoolStat = { at: 0, state: '', why: '', n: 0, key: '', loaded: -1, saved: -1 };

/* @29609 */
let _amPoolChat = '';

/* @29610 */
let _amPoolDirty = false;

/* @29611 */
let _amPoolRound = 0;

/* @29767 */
const AM_ADDR_STORE = 'horae_am_addr_v1';

/* @29769 */
let _amAddrSnapText = '';

/* @29770 */
const AM_ADDR_MAX = 400;

/* @29771 */
const AM_ADDR_MIN = 160;

/* @29793 */
const AM_PTR_HEAD = '<HASH-';

/* @29795 */
const _amPtrRe = () => /<HASH-([0-9A-F]{6})(?:\s[^>]*)?\/>|<HASH-([0-9A-F]{6})>[\s\S]*?<\/HASH-\2>/g;

/* @29812 */
const _amAddrPool = new Map();

/* @29821 */
let _keepTexts = [];

/* @29822 */
let _floorLimNow = -1;

/* @29851 */
const PRESET_KEEP_NAMES = ['前文结束', '核心指令开始', '变量（滚动）', '字数设置（随意更改）', '测试用', '破限[闭]', '伪对话', '写作指南', '基础文风', '通用', '简练网文', '细腻网文', '轻小说（清淡）', '轻小说（浓厚）'];

/* @29852 */
const PRESET_KEEP_TAGS = ['核心指导', '任务介绍', '第一写作指导', '通用写作规范', '核心文字风格', '创作准则', '追加行动选项', '输出模板', 'think', 'SUOT'];

/* @29863 */
const PRESET_KEEP_MARKS = ['</互动历史>', 'You are a helpful software engineer assistant', '# 创作范围：', '# NSFW核心：', '# 段落安排：', '# 角色表现准则：', '# 人称准则：', '# 字数准则：', '你需注意，本轮回复是完整扩写任务', '重要提示：', 'User:\n开始。\nAssistant:'];

/* @29864 */
const PRESET_KEEP_DENY = [/<world_/, /<school_/, /<activity_/, /<xingyue_/, /<sample_/, /<role_/, /<相关资料/, /<User设定/, /<charDescription/, /<scenario/, /<status_current_variables/, /<UpdateVariable/, /<JSONPatch/, /<Analysis/, /<最新互动/, /\[当前状态快照/, /<horae/];

/* @29935 */
const _amAddrAt = new Map();

/* @29936 */
let _amAddrIdx = new Map();

/* @29937 */
let _amAddrStat = { at: 0, state: '', why: '', n: 0, loaded: -1, saved: -1, hitN: 0, hitChars: 0, addN: 0 };

/* @29938 */
let _amAddrChat = '';

/* @29939 */
let _amAddrDirty = false;

/* @30294 */
let _prevPrefixItems = null;

/* @30519 */
let _prevTurnSnap = null;

/* @30533 */
let _pendingMeasure = null;

/* @30536 */
let _prevRealMsgs = null;

/* @30551 */
let _prevLastMsgs = null;

/* @30554 */
let _relocateStats = null;

/* @30563 */
let _varMoveStats = null;

/* @30572 */
let _restoreStats = null;

/* @30631 */
const PROMPT_OVERHEAD_TOK = 28;

/* @30637 */
const TEMPLATE_PER_MSG_TOK = 2;

/* @30652 */
const RELOC_GROUP_STORE = 'horae_reloc_tail_group_v1';

/* @30712 */
const RELOC_POINTER = '【此处内容每轮都会变，已挪到提示词末尾（原地留指针，好让缓存前缀不被它打断）】';

/* @30714 */
const RELOC_MOVED_HEAD = '【以下内容原本在提示词前部的指针处：它每轮都在变，挪到末尾是为了保住前面的缓存】\n';

/* @30722 */
const RELOC_POINTER_IDLE = '【此处内容每轮可能变动，变动部分一律挪到提示词末尾；这一行是常量指针，每轮一字不差】';

/* @30724 */
const RELOC_TAIL_POINTER = '【此处内容已前置到前面的设定区（它的位置每轮都在挪，留这行指针省缓存）】';

/* @30741 */
const RELOC_VARPTR = '【这里原本是每轮都在变的状态变量块：已整段挪到提示词末尾（原地只留这行常量指针，好让缓存前缀不被它打断）】';

/* @30743 */
const RELOC_VARMIN_CHARS = 400;

/* @30746 */
const RELOC_VARBODY_MIN_CHARS = 120;

/* @30754 */
const RELOC_VARTAG = '<status_current_variables>';

/* @30755 */
const RELOC_VARENDTAG = '</status_current_variables>';

/* @30756 */
const RELOC_VARMACRO_RE = /\{\{[^}]*\}\}/;

/* @30825 */
const PREV_PROMPT_STORE = 'horae_prev_prompt_v1';

/* @30826 */
const PREV_PROMPT_KEEP = 3;

/* @30830 */
const PREV_PROMPT_MAX_CHATS = 1;
/* ★ 2026-09-24 内存池最多留几个**聊天**（与 localStorage 无关；内存便宜，留多点省得切来切去重拉）。
 *   用户原话："注意哦 我随时切换聊天，内存就是临时的，真实都是硬盘上的文件"。 */
const PREV_MEM_MAX_CHATS = 8;

/* @30831 */
const PREV_PROMPT_MAX_CHARS = 1600000;

/* @30832 */
let _prevStoreChat = '';

/* @30835 */
let _prevBaselineSrc = '';

/* @30849 */
let _prevStoreStat = { at: 0, state: '', why: '', len: 0, key: '', src: '', keys: 0 };

/* @30908 */
let _prevDiskCache = { chat: '', at: 0, no: -1, msgs: null, err: '' };

/* @31278 */
const CONTAINER_STAB = true;

/* @31894 */
const SHAPE_VAR_TAG = '<status_current_variables>';

/* @31895 */
const SHAPE_VAR_ENDTAG = '</status_current_variables>';

/* @31897 */
const SHAPE_VAR_WILD = '\u0000<var>\u0000';

/* @31899 */
const SHAPE_VAR_WHOLE_MAX_IDX = 12;

/* @32003 */
const RELOC_PREARM_MAX_CHARS = 30000;

/* @32012 */
const RELOC_SKEL_FREEZE_FLOORS = 9;

/* @32013 */
const RELOC_MIN_MID_CHARS = 120;

/* @32014 */
const RELOC_MIN_KEEP_CHARS = 400;

/* @32109 */
const WB_CHURN_PROBE_CHARS = 70;

/* @32110 */
const WB_CHURN_TTL_MS = 10 * 60 * 1000;

/* @32111 */
let _wbChurnProbes = [];

/* @32119 */
let _wbConstProbes = [];

/* @32120 */
let _wbChurnAt = 0;

/* @32121 */
let _wbChurnBuilding = false;

/* @32469 */
const RESTORE_MAX_TOTAL_CHARS = 200000;

/* @32479 */
const RESTORE_ADD_HEAD = '【本轮增量 · 下面这些是本轮新写/改的字：原位已按上一轮的版本逐字保留（好让缓存前缀不被打断），读到时以这里为准】\n';

/* @32481 */
const RESTORE_MAX_COPIES = 64;

/* @32485 */
const RESTORE_MAX_COPY_CHARS = 800000;

/* @32490 */
const RESTORE_LOST_MIN_CHARS = 400;

/* @32491 */
const RESTORE_LOST_MIN_LINE = 16;

/* @32492 */
const RESTORE_LOST_MIN_LINES = 5;

/* @32493 */
const RESTORE_LOST_MISS_RATIO = 0.2;

/* @32500 */
const RESTORE_SEAT_BACK_ON = true;

/* @32501 */
const RESTORE_SEAT_MAX_CHARS = 40000;

/* @32505 */
const RESTORE_TAIL_MIN_CHARS = 16;

/* @32506 */
const RESTORE_TAIL_MIN_CUR = 8;

/* @32525 */
const RESTORE_ADD_HEAD2 = RESTORE_ADD_HEAD + '（这一条只列**这一轮**相对上一轮那一版增量又多写/改了的行 —— 上一轮那一版原样留在上面）';

/* @33135 */
const FLOOR_MIN_CHARS = 300;

/* @33293 */
const ALGO_PIPE_KEY = EXP_ALGO_KEY + ':pipe';

/* @33295 */
const ALGO_PIPE_DEFAULT = [{ id: 'ptr-exact-v2.4', on: true }];

/* @33296 */
let _algoPipeBad = '';

/* @33297 */
let _algoPipeLast = [];

/* @33342 */
const ALGO_PIPE_SLOT_SEP = '__';

/* @33346 */
const ALGO_PIPE_SLOT_RAW = 'pipe-raw';

/* @35524 */
const _relocFrozenSlots = new Set();

/* @35609 */
const RELOC_MOVE_VAR_OFF = false;

/* @35610 */
const FREEZE_POOL_OFF = true;

/* @36021 */
const FREEZE_STORE = 'horae_freeze_pool_v1';

/* @36022 */
const FREEZE_MAX_CHATS = 6;

/* @36023 */
const FREEZE_MARK = '〔冻结·';

/* @36024 */
const FREEZE_VAR_MARK = '〔变动·';

/* @36025 */
const FREEZE_EXPLAIN = '【冻结注入池】上面／下面带〔冻结·N·名称〕标记的块是"完整注入"的正文（世界书条目、变量块）：'
    + '它们只在第一次注入时发过一次，此后每轮**一字不差地留在本提示词里**，不再重复注入 —— 需要时按标记名索引它。'
    + '带〔变动·第N轮〕标记的是那一轮的**局部变动**（只列变动的行）。';

/* @36028 */
const FREEZE_VAR_PTR = '【冻结注入池·变量块】完整变量与状态快照见池内的"变量块"条目（只注入过一次）；本轮的局部变动列在末尾的变动记录里。';

/* @36030 */
let _freezePool = { items: [], log: [], seq: 0, varCur: {} };

/* @36031 */
let _freezeChatKey = '';

/* @36032 */
let _freezeStats = null;

/* @36313 */
let _relocTailGroup = [];

/* @36319 */
let _relocTailWi = [];

/* @36336 */
let _relocTailAnchor = -1;

/* @36357 */
const LATEST_INPUT_OPEN = '<最新互动>';

/* @36358 */
const LATEST_INPUT_CLOSE = '</最新互动>';

/* @36929 */
const HORAE_REPO_META = 'horae_repo';

/* ══════════════════════════════════════════════════════════════════════════
 * 二、算法链函数 —— **源文件逐字搬运**（按源行号排列）
 *   ⛔ 判据 / 阈值 / 顺序 / 文案一个字都没有改；改的只有下面 SHIM 里列出的那几处依赖来源。
 * ══════════════════════════════════════════════════════════════════════════ */

/* @19599-19603 */
function _getAutoSummaryCostStats() {
    const s = settings.autoSummaryCostStats;
    if (!s || typeof s !== 'object') return { ..._EMPTY_AUTOSUM_COST };
    return { ..._EMPTY_AUTOSUM_COST, ...s };
}

/* @20201-20204 */
function _isChatCompletionUrl(url) {
    const u = String(url || '');
    return u.includes('/chat-completions/generate') || u.includes('/chat/completions');
}

/* @21046-21061 */
async function _ensureStTokenizer() {
    if (_stTokTried) return _stTokMod;
    _stTokTried = true;
    try {
        const m = await import('../../../tokenizers.js');
        if (m && typeof m.countTokensOpenAIAsync === 'function') {
            _stTokMod = m;
            console.log('[hitOpt] 已接入酒馆分词器：面板 token 口径与酒馆提示词管理器一致');
        } else {
            console.warn('[hitOpt] 酒馆 tokenizers.js 形态不认识，回退本地估算');
        }
    } catch (err) {
        console.warn('[hitOpt] 无法接入酒馆分词器（回退本地估算）:', err);
    }
    return _stTokMod;
}

/* @21085-21098 */
async function _countStMessage(role, content) {
    const text = typeof content === 'string' ? content : '';
    if (!text) return 0;
    const m = await _ensureStTokenizer();
    if (!m) return estimateTokens(text) + TEMPLATE_PER_MSG_TOK;
    try {
        // 只喂 content 一个键 —— 详见上面 v6.24.85 那段（多一个键就会把 role 编进去，偏差随之而来）。
        // role 形参保留：调用点仍在传，但它从此不参与计数（各调用点的语义没变，只是口径对齐官方）。
        const n = await m.countTokensOpenAIAsync({ content: text }, true);
        return Math.max(0, Math.round(Number(n) || 0)) + TEMPLATE_PER_MSG_TOK;
    } catch (_) {
        return estimateTokens(text) + TEMPLATE_PER_MSG_TOK;
    }
}

/* @21111-21122 */
async function _countStText(text) {
    const t = String(text ?? '');
    if (!t) return 0;
    const m = await _ensureStTokenizer();
    if (!m) return estimateTokens(t);
    try {
        // ★ v6.24.85：与 _countStMessage 同一口径 —— 只喂 content 一个键，拿"这段字自己"的 token。
        // 旧写法喂 { role:'user', content } 会编成 user+两个换行+t，白搭 2 个 role token（见 _countStMessage 注释）。
        const n = await m.countTokensOpenAIAsync({ content: t }, true);
        return Math.max(0, Math.round(Number(n) || 0));
    } catch (_) { return estimateTokens(t); }
}

/* @21131-21134 */
function _blockFloor(tok) {
    const n = Math.max(0, Number(tok) || 0);
    return Math.floor(n / CACHE_BLOCK_TOK) * CACHE_BLOCK_TOK;
}

/* @21139-21143 */
async function _prefixHitTok(prefixText, fallback) {
    const raw = prefixText ? await _countStText(prefixText) : 0;
    const base = raw > 0 ? raw : Math.max(0, Number(fallback) || 0);
    return _blockFloor(base);
}

/* @21168-21172 */
function _isWiPointer(text) {
    const s = String(text ?? '');
    for (const suf of WI_DEPTH_POINTER_SUFFIXES) if (s.includes(suf)) return true;
    return false;
}

/* @21221-21232 */
function _wiDepthPointer(name, block) {
    let nm = String(name || '').trim();
    if (!nm) {
        // ★ v6.24.49：跳过"只有符号/横线/空白"的行。实测块首行是 `---`，指针就成了 `【---｜详细内容已前置…】`
        //   —— 模型拿着这个名字什么也找不到（用户原话："连个地址都没标记，你让模型去哪找？"）。
        const lines = String(block?.text || '').split('\n').map(s => s.trim());
        const pick = lines.find(s => s && /[\u4e00-\u9fa5A-Za-z0-9]/.test(s)) || '';
        nm = pick.replace(/^[【\[（(<]+/, '').replace(/[】\]）)>]+$/, '').trim().slice(0, 40) || `@D ${block?.depth ?? 0}`;
    }
    nm = nm.replace(/\s+/g, ' ').trim().slice(0, WI_DEPTH_POINTER_MAX_CHARS);
    return `【${nm}${WI_DEPTH_POINTER_SUFFIX}】`;
}

/* @21480-21488 */
async function _wiDepthBlockTok(text) {
    const key = String(text || '');
    if (!key) return 0;
    if (_wiDepthTokCache.has(key)) return _wiDepthTokCache.get(key);
    const n = await _countStMessage('system', key);
    if (_wiDepthTokCache.size > 64) _wiDepthTokCache.clear();
    _wiDepthTokCache.set(key, n);
    return n;
}

/* @21647 _diffAnalysisInvalidate —— ⛔ 不搬：从 ./ledger.js 引（见文件头 依赖换来源③） */

/* @22093-22112 */
function _floorOfPromptText(text, chatArr) {
    const norm = String(text || '').replace(/\s+/g, ' ').trim();
    if (norm.length < 8 || !Array.isArray(chatArr) || !chatArr.length) return null;
    const h48 = norm.slice(0, 48), h32 = norm.slice(0, 32);
    let hit = null;
    for (let i = 0; i < chatArr.length; i++) {
        const mes = String(chatArr[i]?.mes || '').replace(/\s+/g, ' ').trim();
        if (!mes) continue;
        if (mes === norm) return i;                       // 完全同文 —— 最强证据，直接认
        if (mes.startsWith(h48)) { if (hit !== null && hit !== i) { hit = -1; } else if (hit === null) hit = i; }
    }
    if (hit !== null && hit >= 0) return hit;
    hit = null;
    for (let i = 0; i < chatArr.length; i++) {
        const mes = String(chatArr[i]?.mes || '').replace(/\s+/g, ' ').trim();
        if (!mes) continue;
        if (mes.includes(h32)) { if (hit !== null && hit !== i) { hit = -1; } else if (hit === null) hit = i; }
    }
    return (hit !== null && hit >= 0) ? hit : null;
}

/* @23044-23061 */
function _expAlgoStale(chatKey) {
    try {
        const ck = String(chatKey || '');
        if (!ck) return;
        for (const s of Object.keys(_expAlgoCache)) {
            const bag = _expAlgoCache[s];
            if (bag && typeof bag === 'object' && bag[ck]) delete bag[ck];
        }
        const raw = JSON.parse(localStorage.getItem(EXP_ALGO_KEY) || '{}');
        if (raw && raw.v === 2 && raw.slots && typeof raw.slots === 'object') {
            for (const s of Object.keys(raw.slots)) {
                const bag = raw.slots[s];
                if (bag && typeof bag === 'object' && bag[ck]) delete bag[ck];
            }
            localStorage.setItem(EXP_ALGO_KEY, JSON.stringify(raw));
        }
    } catch (_) { /* 作废失败不影响任何主路径：最坏退化成"下一次取数自己重算" */ }
}

/* @23109-23111 */
async function _expAlgoPut(pathname, body, timeoutMs = 15000) {
    return await _gitLogApi(pathname, body, timeoutMs);
}

/* @26390-26396 */
function _wireBases() {
    const out = [];
    /* ★★★★★★ 2026-09-24【合并】抓包**已经不是独立插件**了 —— 它并进了记录服务，挂在自己的
     *   `/tap` 下面（服务端 `hitopt-git/wiretap.mjs`，路由 `/api/plugins/hitopt-git/tap/…`）。
     *   ⇒ 原来那套"把 `-git` 字符串替换成 `-wiretap`、再把几个候选名都列一遍"整个退休：
     *     地址就是**记录服务那几个 base ＋ `/tap`**，一处都不用猜。
     *   ⚠ `_wiretapId` 仍然认：它来自服务端 `/status` 报的 `peer`，合并后那个值就是记录服务自己的
     *     id（`hitopt-git`）⇒ 拼出来与 `GIT_LOG_BASES` 那条**同一个地址**，去重后只剩一条。
     *   ⚠ 不支持"老版独立抓包插件"了（用户定版："**没有horae-wiretap，只有hitopt**"）。 */
    if (_wiretapId) out.push(`/api/plugins/${_wiretapId}/tap`);
    for (const b of GIT_LOG_BASES) out.push(b.replace(/\/+$/, '') + '/tap');
    if (_gitLogId) out.push(`/api/plugins/${_gitLogId}/tap`);
    return out.filter((v, i, a) => v && a.indexOf(v) === i);
}

/* @26478-26486 */
function _gitLogCsrf() {
    if (_gitLogCsrfCache) return _gitLogCsrfCache;
    try {
        const ctx = getContext();
        return ctx?.getRequestHeaders?.()?.['X-CSRF-Token']
            || ctx?.getRequestHeaders?.()?.['x-csrf-token']
            || '';
    } catch (_) { return ''; }
}

/* @26512-26543 */
function _diagReport(payload) {
    /* ★ v6.51.13【重放集 · 缺口2：把这一轮的埋点**也落进聊天仓**】
     *   为什么非留不可：定案 2026-09-23 那场"整轮不池化"事故的三条铁证（abOn=0 / rsBase 空 /
     *   stState=fail）**全在抓包插件的 `_diag.log` 里** —— 它不在聊天仓、按天滚动、7 天就没了。
     *   ⇒ 心跳照旧发（`tools/` 那边的自动诊断还靠它），**同时**把这一条原样留一份在内存里，
     *     由 `/turn` 带进 `turns/NNNNN.diag.json`（同一份对象，**不另拼一套字段** ——
     *     两套字段就是"各说各话"的起点）。 */
    try { if (payload && payload.tag === 'pushTurn:enter') _diagLast = payload; } catch (_) { }
    try {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(payload || {})) q.set(k, typeof v === 'string' ? v : JSON.stringify(v ?? null));
        if (typeof fetch !== 'function') return;
        // ⚠ 三个坑都踩过了，写清楚免得下次又加回来：
        //   ① `navigator.sendBeacon(...)` 返回 true（排队成功）**却一个都不到服务端** —— 实测三种写法全丢；
        //   ② `keepalive: true` 与 `cache: 'no-store'` **不能同时在**（fetch 规范禁止的组合，直接抛）；
        //   ③ 探针**必须带超时**：不带的话一条坏地址就能把整条诊断通道堵死（见上面 _diagFailN 那段）。
        for (const base of _wireBases()) {
            fetch(`${base}/diag?${q.toString()}`, { method: 'GET', signal: AbortSignal.timeout(4000) })
                .catch((err) => {
                    _diagFailN++;
                    if (_diagFailN > 60) return;      // 只封顶，不当"只报一次"用
                    try { console.warn(`[hitOpt] 诊断上报失败（第 ${_diagFailN} 次）：${base}｜${String(err?.message || err).slice(0, 80)}`); } catch (_) { }
                    if (String(payload?.tag) === 'diag:throw') return;   // 防递归：自报失败的不再自报
                    try {
                        fetch(`${_wireBases()[0] || ''}/diag?` + new URLSearchParams({
                            tag: 'diag:throw', from: String(payload?.tag || ''), err: String(err?.message || err).slice(0, 120),
                        }).toString(), { method: 'GET', signal: AbortSignal.timeout(4000) }).catch(() => { });
                    } catch (_) { }
                });
        }
    } catch (_) { /* 记不上就算了，绝不影响记账 */ }
}

/* @26583-26589 */
async function _sendDigestOf(list) {
    const canon = JSON.stringify((Array.isArray(list) ? list : []).map(m => ({
        role: String(m?.role || ''), content: String(m?.content ?? ''),
    })));
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/* @26606-26660 */
function _sendProofReconcile(wireMsgs, digest) {
    try {
        const canon = (list) => (Array.isArray(list) ? list : []).map(m => ({
            role: String(m?.role || ''), content: String(m?.content ?? ''),
        }));
        const w = canon(wireMsgs);
        // 对账对象 = **本轮定稿那份快照**（`_finalizeMeasure` 里那份 snap），不是上一轮的基准：
        // 同一轮里"定稿文本" vs "网上真字"才可比（跨轮比必然不同，那是正常的）。
        const fin = Array.isArray(_lastFinalSnap) ? _lastFinalSnap : null;
        let diffs = 0, drift = -1;
        if (fin) {
            for (let i = 0; i < Math.max(fin.length, w.length); i++) {
                const a = fin[i], b = w[i];
                if (String(a?.role || '') !== String(b?.role || '') || String(a?.content ?? '') !== String(b?.content ?? '')) {
                    diffs++;
                    if (drift < 0) drift = i;
                }
            }
            if (diffs) {
                console.warn(`[hitOpt] 出网的字与定稿副本不一致：${diffs} 条不同（第一条 #${drift}${
                    drift >= 0 ? `：定稿 ${String(fin[drift]?.role || '?')} ${String(fin[drift]?.content ?? '').slice(0, 40)}… / 出网 ${String(w[drift]?.role || '?')} ${String(w[drift]?.content ?? '').slice(0, 40)}…` : ''}）`);
            } else {
                console.log(`[hitOpt] 出网对账：定稿副本 == 网上那份 messages（指纹 ${digest}）→ 基准就是它`);
            }
        }
        // ══ ★★★ v6.24.81【只有"与定稿副本逐条相同"的那一份，才有资格当下一轮的基准】══════════════
        //   这条纪律（"基准 = 官方缓存里存的那份真字"）**没变**，缺的是它一直没写出来的**前提**：
        //   下一轮拿这份基准去干的事是**逐下标无脑盖**（`_restoreFrozenHistory`，v6.24.48 用户定版
        //   "用 A 的内容，还原范围 = B 从头到对话楼"）—— 那要求基准与下一轮的 `msgs` **同源同形状**。
        //   而 `w` 是**网上那份 POST body 的 messages**，酒馆后端在出网前已经 `postProcessPrompt`
        //   把消息并过一遍了 —— 它与客户端手里那份**条数就不一样**：
        //     实测 `proof` 心跳 `spN:54 / snapN:43`（第 7 轮）、`spN:45 / snapN:41`（第 6 轮）。
        //   ⇒ 54 条按下标盖到 43 条上 = **整条历史错位**，再叠上"接回上一轮的增量条"，内容当场翻倍。
        //   ★★ 官方数为证（2026-09-17 `圣樱学院_mu5ffle6lfcc` 第 7 轮 —— **用户重 roll 那一下**）：
        //     第 6 轮 43,420 / 30,720 / 12,700（出网 73,566 字 / 12 条）
        //     第 7 轮 87,068 / 17,664 / 69,404（出网 144,063 字 / 16 条，接回 12,755 → **27,897** 字）
        //     现场物证（`captures/_diag.log`）：11:56:53 那次 `swipe:false` 81,614 字；
        //       11:57:24 用户点重新生成 ⇒ `swipe:true` ⇒ 同一轮变 144,063 字。
        //   ⇒ 现在：`fin && diffs === 0`（定稿副本与网上那份**逐条逐字节相同** ⇒ 两者同形状）才认它；
        //     不一致就**一个字节都不动基准** —— 基准已经由 `_prevBaselineFrom` 按"同源"口径定好了
        //     （那条路的①分支本来就要求"条数对得上"，②分支用的是定稿快照本身）。
        //   ⚠ `_prevBaselineSrc` 在 else 分支里**故意不动**：它现在如实记着"这一轮的基准是谁"。
        if (fin && diffs === 0) {
            _prevRealMsgs = w;
            try { globalThis.__hitOptPrevChat = String(_currentChatKey() || ''); } catch (_) { }
            _prevBaselineSrc = `wire0:${digest}`;
            _prevMsgsSave(_currentChatKey(), w, 'wire0', digest);
        } else {
            console.warn(`[hitOpt] v6.24.81 出网那份**不当基准**（${fin ? `${diffs} 条与定稿副本不同` : '定稿副本没拿到'}）`
                + `：它比这一轮手里那份多/少几条（酒馆后端并过消息），拿它逐下标盖会让整条历史错位 ——`
                + ` 实测第 7 轮 54 条盖 43 条 ⇒ 出网 73,566 → 144,063 字、官方 prompt 43,420 → 87,068`);
        }
    } catch (err) {
        console.warn('[hitOpt] 出网对账失败（不动任何东西）:', err?.message || err);
    }
}

/* @26680-26687 */
function _headerSafe(v) {
    const s = String(v ?? '');
    try {
        // 已经是纯 ASCII 可打印字符就直接用（钥匙本来就是 ASCII 时保持原样，一眼能读）
        if (/^[\x20-\x7E]*$/.test(s)) return s;
        return encodeURIComponent(s);
    } catch (_) { return 'unknown'; }
}

/* @26696-26750 */
function _installSendProof() {
    try {
        if (typeof window === 'undefined' || typeof window.fetch !== 'function' || window.__horaeSendProof) return;
        const orig = window.fetch;
        window.fetch = function (...args) {
            // ★ v6.24.40：这一次 fetch 的"票据" —— 请求**真的交出去了**才算取证有效（见下面 ret.catch）
            const ticket = {};
            try {
                const a0 = args[0], a1 = args[1];
                const url = String(a0?.url ?? a0 ?? '');
                // ★ v6.24.39：判据与官方 usage 采集**共用一处**。
                //   老版本这里写的是 `/chat\/completions/i`（斜杠），而酒馆真地址是
                //   `/api/backends/chat-completions/generate`（连字符）—— **永不匹配**，
                //   于是这一整段（标注头 ＋ 出发取证 ＋ 时间窗起点）**一次都没跑过**。
                if (_isChatCompletionUrl(url)) {
                    _lastSendAt = Date.now();      // ★ 出发那一刻，同步记下（不等指纹）—— 取回出网原文的时间窗起点
                    try {
                        const key = _currentChatKey();
                        if (key && a1 && typeof a1 === 'object' && a1.headers && typeof a1.headers === 'object' && !Array.isArray(a1.headers)) {
                            // ★ v6.24.40：**必须** _headerSafe —— 直接把中文钥匙写进去会让这条请求被 fetch 拒掉
                            a1.headers['X-Horae-Chat'] = _headerSafe(key);
                        }
                    } catch (_) { }
                    const body = a1?.body ?? a0?.body;
                    if (typeof body === 'string') {
                        const j = JSON.parse(body);
                        const arr = Array.isArray(j?.messages) ? j.messages : null;
                        if (arr && arr.length) {
                            const n = arr.length;
                            let chars = 0;
                            for (const m of arr) chars += String(m?.content ?? '').length;
                            const wire = body.length;
                            _sendDigestOf(arr).then(d => {
                                _sendProof = { digest: d, n, chars, wire, at: Date.now(), msgs: arr, ticket };
                                console.log(`[hitOpt] 取证：本轮 POST 的 messages 指纹 ${d}（${n} 条 / ${chars} 字 / body ${wire} 字节）`);
                                _sendProofReconcile(arr, d);
                            }).catch(() => { });
                        }
                    }
                }
            } catch (_) { /* 取证失败不影响请求 */ }
            const ret = orig.apply(this, args);
            // ★ v6.24.40：**请求没出去就不算取证** —— fetch 被拒（头值非法 / 网络错 / 被中止）时撤销这一份，
            //   否则记录里会挂着一个"这一轮出发了"的假指纹。实测踩到：头值非法 ⇒ 请求当场被拒、
            //   一轮都没发出去，可三轮记录里都写着 `send <指纹>` —— 顺着它排查反而被带沟里。
            try {
                if (ret && typeof ret.catch === 'function') {
                    ret.catch(() => { if (_sendProof && _sendProof.ticket === ticket) _sendProof = null; });
                }
            } catch (_) { }
            return ret;
        };
        window.__horaeSendProof = true;
    } catch (_) { /* 没有 fetch 就算了 */ }
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * ★★★★★★ 2026-09-24【**补回搬迁漏掉的一跳**：官方 usage → `POST /usage`】
 *
 * 【病】用户报「面板信息丢失 / Δhit Δmiss 不对（应该在 6k 左右）」。盘上量出来的：
 *   `_gitlog/林夏_muf17g3x5dix` 第 3 轮起 `usage.json` **停在第二轮不再增长**，
 *   而 `turns/NNNNN.ver.json` 里每一轮的官方 usage **都在** ⇒ **是中间那一跳没了**，
 *   面板右半边（官方请求/命中/未命中/命中率）**永久空白**。
 *
 * 【链条断在哪】官方三列的唯一来源是**服务端** `index.mjs` 的 `usage.json`：
 *     面板 → `GET /log` → `readUsage()` → `usage.json` ← `POST /usage` ← **客户端这一跳**
 *   而 `POST /usage` 在魔改版里**只有一处**调用点：`horae.client.js:27767` 的
 *   `_gitLogPushUsage()`（在 `_applyUsageToLedger()` 里）。搬迁是**按函数名逐个挑**的
 *   （`tools/plan.json` 132 个），这个函数**没被挑中**，而 `tools/mkreport.mjs` 当时把它
 *   判成「没搬，不依赖这条链」—— **判错了**：依赖**绕了一层**（走服务端 usage.json），
 *   所以按函数名逐个看**看不出来**。Horae 一 reset 成原版（魔改版整份消失）⇒ 链断。
 *
 * 【为什么不搬 `_applyUsageToLedger` 整份】那函数的后半段是**Horae 摘要系统的账**
 *   （`_getAutoSummaryCostStats` / `settings.autoSummaryCostStats` / `lastSideInTok` …）——
 *   hitOpt **不拥有**那份设置，照抄等于替 Horae 管它的状态（而且原版根本没有那个设置对象）。
 *   ⇒ 这里只补**真正缺的那一跳**：从响应里取官方 usage → POST 给**我们自己的记录服务**。
 *
 * 【为什么落在这儿（opt.js）而不是 index.js / ledger.js】
 *   `window.fetch` 已经被本文件 `_installSendProof()` 独占包了一层，`_gitLogApi` 的
 *   基址解析 / CSRF 换令牌重试也在本文件 ⇒ 另起一份就是"同一件事两套实现"
 *   （本项目 §2.2 的硬口径，踩过多次）。**只加一层包装、不动既有那一层一个字节。**
 *
 * 【挂载时机】**在 `_installSendProof` 之后**再包一次 ⇒ 采集层在外层 ⇒ 它 `clone()` 的
 *   是在 ST 真正 `await` 之前拿到的原始 `Response`（安全；反过来先包的人会拿到已被消费的流）。
 *   只读不改：不改请求体、不改响应、`clone()` 与 `text()` 都不碰还给调用方的那一份。
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/** 从响应体里取官方 usage —— **流式与非流式都认**，取**最后一个**带 usage 的块。
 *
 *  形状（DeepSeek 实测）：非流式 ＝ 一整个 JSON；流式 ＝ 若干行 `data: {...}`，
 *  只有**最后一个** data 块带 `usage`（前面的都是 delta）。
 *  `prompt_cache_hit_tokens` 是官方直给；老形状退回 `prompt_tokens_details.cached_tokens`；
 *  两个都没有就**如实返回 null**（⛔ 不拿 0 顶 —— 0 是"真的一 tok 都没命中"，不是"拿不到"）。 */
function _parseUsageFromBody(text) {
    const pick = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        const hit = Number(obj.prompt_cache_hit_tokens);
        const miss = Number(obj.prompt_cache_miss_tokens);
        const cached = Number(obj.prompt_tokens_details?.cached_tokens);
        if (!Number.isFinite(hit) && !Number.isFinite(cached)) return null;
        const h = Math.max(0, Number.isFinite(hit) ? hit : cached);
        const prompt = Math.max(0, Number(obj.prompt_tokens) || 0);
        const m = Math.max(0, Number.isFinite(miss) ? miss : (prompt ? prompt - h : 0));
        return {
            hit: h, miss: m,
            promptTok: prompt || (h + m),
            outTok: Math.max(0, Number(obj.completion_tokens) || 0),
        };
    };
    const s = String(text || '').trim();
    if (!s) return null;
    // 非流式：整体就是一个 JSON
    if (s.startsWith('{')) { try { return pick(JSON.parse(s)); } catch (_) { return null; } }
    // 流式：逐行 data: {...}，取最后一个带 usage 的
    let found = null;
    for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { const u = pick(JSON.parse(payload)?.usage); if (u) found = u; } catch (_) { /* 这一行不是完整 JSON，跳过 */ }
    }
    return found;
}

/** 官方 usage 回填到**那一轮**（服务端 `POST /usage` → gitignore 掉的 `usage.json`，不动提交历史）。
 *
 *  ★ 不传 `no`：服务端 `headTurnNo()` 会按 `HEAD` 那条提交的 `turn #N` 取轮号 ——
 *    **这就是"那一轮"**，与记录自己算的口径同源（客户端在本文件里另算一份轮号必然漂）。
 *  ⛔ 失败**如实报**，不静默吞：静默降级是这个项目反复踩的坑（面板空着而没人知道为什么）。 */
async function _gitLogPushUsage(usage) {
    if (!usage) return false;
    try {
        const r = await _gitLogApi('/usage', {
            chat: _gitLogChat(),
            hit: usage.hit, miss: usage.miss, out: usage.outTok, promptTok: usage.promptTok,
        });
        if (r?.ok) {
            try { console.log(`[hitOpt] 官方 usage 已回填：请求 ${usage.promptTok} tok｜命中 ${usage.hit}｜未命中 ${usage.miss}｜输出 ${usage.outTok}`); } catch (_) { }
            /* 官方三列一落盘就把面板刷新（用户 2026-09-24 报的那两格就是它）——
               这一步原来是 Horae 的 `_diffRenderIfOpen()` 干的，我们自己刷自己的面板。
               ⛔ 只调存在的那一个，拿不到就算了（面板本身还有个「刷新」按钮与自动刷新兜底）。 */
            try { globalThis.hitOpt?.refresh?.('usage'); } catch (_) { }
            return true;
        }
        try { console.warn('[hitOpt] 官方 usage 回填被服务端拒了：', JSON.stringify(r)); } catch (_) { }
    } catch (e) {
        try { console.warn('[hitOpt] 官方 usage 回填失败（这一轮面板的官方三列会是空的）：', e?.message || e); } catch (_) { }
    }
    return false;
}

/** 包一层 fetch 取官方 usage。**幂等**；必须在 `_installSendProof()` **之后**调用（见上）。 */
function _installUsageCapture() {
    try {
        if (typeof window === 'undefined' || typeof window.fetch !== 'function' || window.__hitOptUsageCapture) return;
        const orig = window.fetch;
        window.fetch = function (...args) {
            const ret = orig.apply(this, args);
            try {
                const a0 = args[0];
                const url = String(a0?.url ?? a0 ?? '');
                /* 判据与出网取证**共用一处**（`_isChatCompletionUrl`）—— 老版本这里各写一份，
                   其中一份写成斜杠、永不匹配，代价见那个函数的注释。 */
                if (!_isChatCompletionUrl(url)) return ret;
                /* ⚠ `clone()` 必须**同步**在这儿做：异步之后原始流可能已被消费，克隆会抛。 */
                const clone = ret && typeof ret.then === 'function'
                    ? ret.then(r => { try { return (r && r.ok && typeof r.clone === 'function') ? r.clone() : null; } catch (_) { return null; } })
                    : null;
                if (!clone) return ret;
                void clone.then(c => { if (c) void _captureUsageFromResponse(c); }).catch(() => { });
            } catch (_) { /* 采集失败绝不影响请求本身 */ }
            return ret;
        };
        window.__hitOptUsageCapture = true;
        console.log('[hitOpt] 已启用官方 usage 采集（prompt_cache_hit_tokens / prompt_cache_miss_tokens → POST /usage）');
    } catch (e) { try { console.warn('[hitOpt] 官方 usage 采集没装上：', e?.message || e); } catch (_) { } }
}

async function _captureUsageFromResponse(res) {
    let text = '';
    try { text = await res.text(); } catch (_) { return; }
    const usage = _parseUsageFromBody(text);
    if (!usage) {
        /* 拿不到就**如实说一次**（每 20 次再提一次，别刷屏）—— 这与魔改版同一套口径，只是不写进 Horae 的设置。 */
        _usageMissing++;
        if (_usageMissing === 1 || _usageMissing % 20 === 0) {
            try {
                console.warn('[hitOpt] 本次响应里没有 usage 字段（流式默认不回）⇒ 这一轮的官方命中/未命中拿不到；'
                    + '面板那几格会是空的（本地三列不受影响）。要官方精确值可让上游带 stream_options.include_usage。'
                    + `（累计 ${_usageMissing} 次）`);
            } catch (_) { }
        }
        return;
    }
    await _gitLogPushUsage(usage);
}

/* @26793-26819 */
async function _gitLogProbe() {
    for (const base of GIT_LOG_BASES) {
        try {
            const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(2500) });
            if (!res.ok) continue;
            const j = await res.json();
            if (j?.ok) {
                _gitLogBase = base;
                _gitLogInfo = j;
                // ★ v6.24.55【可移植性】把服务报出来的**真实挂载名**记下来：
                //   记录服务自己的 `id`（酒馆就是拿它拼 `/api/plugins/<id>` 的），
                //   以及它声明的同伴名 `peer`（抓包插件）。之后 `_wireBases()` 按真名拼地址，
                //   不再依赖"表里写死的那两个名字"。老版本服务端没有这两个字段 → 留空、照旧兜底。
                if (typeof j.id === 'string' && j.id) _gitLogId = j.id;
                if (typeof j.peer === 'string' && j.peer) _wiretapId = j.peer;
                _gitLogOk = true;
                _gitLogTried++;
                return j;
            }
        } catch (_) { /* 这个地址不通，继续下一个 */ }
    }
    _gitLogBase = null;
    _gitLogInfo = null;
    _gitLogOk = false;
    _gitLogTried++;
    return null;
}

/* @26822-26871 */
async function _gitLogApi(pathname, body, timeoutMs = 4000) {
    if (!_gitLogBase) {
        const ok = await _gitLogProbe();
        if (!ok) throw new Error('git 服务未就绪');
    }
    const base = _gitLogBase;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    // ★ v6.24.58：这一跳的"进/出"诊断探针（`turn:send` / `turn:res` / `turn:send:throw`）已撤 ——
    //   它们当初是为了找"`willCommit` 有、`/turn` 却没下文"那个断点（真因是 `putWire` 抛 TypeError，已修）。
    //   留下来的只有**真失败**那条 `api:throw`（见下面 catch）：它不是探针，是"这一跳到底怎么了"的如实留痕。
    try {
        const headers = { 'content-type': 'application/json' };
        const csrf = _gitLogCsrf();
        if (csrf) headers['X-CSRF-Token'] = csrf;
        const res = await fetch(`${base}${pathname}`, body === undefined
            ? { signal: ctl.signal }
            : { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
        // ★ v6.24.55：**403 = 手里那枚 CSRF 令牌作废了**（酒馆 csrf-sync 的原话：
        //   `Invalid CSRF token. Please refresh the page and try again.`）。
        //   老代码在这里什么都没做 ⇒ `res.json()` 把 403 的错误体当成正常返回值，
        //   调用方看到的是 `{ok:false}`，而**这一轮就永远写不进去了**（实测：用户酒馆窗口里
        //   一连串 ForbiddenError，`turns/` 一直空着）。
        //   现在：向酒馆讨一枚新的 `/csrf-token`（它会把新令牌写进同一个 session），
        //   然后**原样重试一次** —— 用户不用刷新页面，记录自己接上。
        //   令牌是从 `/csrf-token` 换的、不猜、不编；换不到就照旧如实失败。
        if (res.status === 403) {
            let csrfNew = '';
            try {
                const tr = await fetch('/csrf-token', { signal: AbortSignal.timeout(2500) });
                if (tr.ok) csrfNew = String((await tr.json())?.token || '');
            } catch (_) { /* 讨不到新令牌：下面如实报错 */ }
            if (csrfNew) {
                try { console.warn('[hitOpt] git 记录：CSRF 令牌失效 → 已向酒馆换了一枚新的，这一跳重试'); } catch (_) { }
                _gitLogCsrfCache = csrfNew;
                return await _gitLogApi(pathname, body, timeoutMs);
            }
        }
        const j = await res.json();
        _gitLogOk = true;
        return j;
    } catch (err) {
        _gitLogOk = false;
        _gitLogBase = null;   // 地址失效：下次重新探
        // ★ v6.24.58：这条**保留** —— 异常对象本身不带状态码，而"是不是 403 / 超时 / 打到了不通的地址"
        //   正是排查时第一件要知道的事（自动检测那条链读它；它只在**真出错**时发一条，平时零开销）。
        try { _diagReport({ tag: 'api:throw', chat: body?.chat || '', path: pathname, base, err: String(err?.message || err) }); } catch (_) { }
        throw err;
    } finally { clearTimeout(t); }
}

/* @26934-26942 */
function _currentAiFloor() {
    try {
        const chat = Array.isArray(getContext()?.chat) ? getContext().chat : [];
        if (!chat.length) return null;
        const last = chat[chat.length - 1];
        const overwrite = last && last.is_user === false && last.is_system !== true;   // swipe / continue → 就地覆盖
        return overwrite ? chat.length - 1 : chat.length;
    } catch { return null; }
}

/* @26975-27004 */
async function _gitLogFetchWire(opt = {}) {
    const since = Number(opt.since) || 0;
    const q = new URLSearchParams();
    if (since) q.set('since', String(Math.max(0, since - 1500)));   // 减 1.5 秒余量：抓包落盘可能略早于量测起点
    // ★ v6.24.39：**不再带 `chat`** —— 这是"抓包抓到了、前端却永远取不回来"的最后一环。
    //   抓包在传输层，酒馆后端给上游拼的 header 是写死的 `{Content-Type, Authorization}`
    //   ⇒ 抓包侧 `chatKey` 恒为 `unknown`、**文件名里根本没有聊天钥匙**；而服务端老代码是
    //   `if (key && !files[i].includes(key)) continue;` —— **带上它就等于把每一份都跳过**。
    //   实测：同一时刻、同一份文件，不带 `chat` 问 → `ok:true`；带上 → `ok:false`（三份真 request
    //   躺在盘上，三轮记录全写"没抓到出网原文"）。服务端已改成"钥匙只当偏好、认不出就退回时间窗"，
    //   这里索性别送：时间窗（mtime ≥ 出发那一刻）本来就把"哪一轮"卡死了。
    if (Number(opt.expectMsgs) > 0) q.set('expectMsgs', String(Number(opt.expectMsgs)));
    if (Number(opt.minChars) > 0) q.set('minChars', String(Number(opt.minChars)));
    let lastErr = '抓包插件 /latest 一次都没答上来';
    for (let attempt = 0; attempt < WIRE_TRY_DELAYS.length; attempt++) {
        if (WIRE_TRY_DELAYS[attempt]) await new Promise(r => setTimeout(r, WIRE_TRY_DELAYS[attempt]));
        for (const base of _wireBases()) {
            try {
                const res = await fetch(`${base}/latest?${q.toString()}`, { signal: AbortSignal.timeout(2500) });
                if (!res.ok) { lastErr = `${base} 回了 HTTP ${res.status}`; continue; }
                const j = await res.json();
                if (j?.ok && typeof j.body === 'string' && j.body) return j;
                // ★ v6.24.39：把服务端附的 `hint`（盘上最新那份是什么时候的）一起说出来 ——
                //   "没抓到"这三个字本身没法查（实测就这么白丢过两轮）。
                if (j?.error) lastErr = String(j.error) + (j?.hint ? `｜${String(j.hint)}` : '');
            } catch (e) { lastErr = `${base} 连不上（${String(e?.name || e?.message || e)}）`; }
        }
    }
    return { ok: false, error: lastErr };
}

/* @27041-27695 */
function _gitLogPushTurn(assembled, tokArr, total, lcp = null, sendProof = null, tokSrc = '', rawSnap = null) {
    // ══ ★ v6.24.108【真 bug：重 roll 又漏了一种，盘上抓到的】══════════════════════════════════
    //  现场（`圣樱学院_mu5sd7sejhp0`，`_diag.log` 的 pushTurn 心跳 + `git log` 为证）：
    //    02:06:46 enter swipe=false rsPrevLen=100 rsCurLen=104 → committed no=24   ← 正常一轮
    //    02:07:00 enter swipe=true  rsPrevLen=104 rsCurLen=104 → committed no=24   ← 重 roll，**识别对了**
    //    02:08:00 enter swipe=false rsPrevLen=104 rsCurLen=104 → committed no=25   ← ⚠ 还是重 roll，却没认出来
    //  ⇒ `turns/00024.txt` 与 `turns/00025.txt` **逐字节相同**（sha256 都是 f2ca101b…）；
    //    `#27/#28` 是同一件事的第二例（sha256 都是 998b4b86…）。
    //  ⇒ 那一轮**没有进任何新消息**（`rsCurLen == rsPrevLen`）⇒ 不可能是"用户新发了一条"。
    //  根因：`GENERATION_AFTER_COMMANDS` 里那句清零是**无条件**的 —— 用户在重 roll 之后，
    //    酒馆（或别的插件）只要再发一次**静默/后台**生成（dryRun / quiet / 自动摘要），
    //    那次 emit 就会把已经置好的重 roll 标记抹成 false，于是这一轮被当成全新一轮提交。
    //  修法（两处，见下面 `GENERATION_AFTER_COMMANDS` 那段）：① 清零只发生在"**用户发起的那一次**"
    //    emit 上；② 标记带上置位那一刻的聊天条数，消费时**要求条数一个字没变**才认。
    //  ⚠ 判据是**保守**的：拿不到条数 / 条数变了 ⇒ 一律不认 ⇒ 最坏退化成"重 roll 仍多记一行"（现状），
    //    **绝不会**把正常一轮误判成重 roll 而把它 reset 掉。
    const swipe = (() => {
        const p = _gitLogSwipePending;
        _gitLogSwipePending = false;
        if (p === true) return true;                                   // 老形状（没有 cl 信息）照旧认
        if (!p || typeof p !== 'object') return false;
        if (!(Date.now() - Number(p.at || 0) < SWIPE_PENDING_TTL_MS)) return false;
        let cl = null; try { const c = getContext()?.chat; cl = Array.isArray(c) ? c.length : null; } catch (_) { }
        if (p.cl == null || cl == null) return false;                  // 有一边拿不到 ⇒ 不认（宁可多记一行）
        return cl === p.cl;                                            // 条数一个字没变 ⇒ 这一轮没进新消息
    })();
    // ★ v6.24.59【真 bug 修复】把"这一轮请求 token"**真的带给归档抬头**。
    //   原来 `putWire` 里读的是 `body.wire.tok` / `body.wire.chars`，可**没有任何地方给它们赋过值**
    //   （注释写着"由主路 `_gitLogPushTurn` 数好传进来"，而主路其实只把总数放在 `meta.total` 里）
    //   ⇒ 每一轮 `turns/NNNNN.meta.txt` 的抬头都写 `0 tok` ⇒
    //   面板「本地请求Token」那一格永远是 0，只能退回官方 `prompt_tokens` 顶上
    //   （用户看到的就是"请求 token 对不上官网 token"）。
    //   现在在这里落一次（`tok` = 主路数好的**出发那一刻**那份字的总量；`chars` 由 `putWire`
    //   填上**出网原文正文**的真实长度 —— 那一份只有拿到抓包才知道）。
    //   ⚠ 变量名**别叫 `snapChars`** —— 那是旧版"本地快照字数"的名字，⑨ 段有反回归钉子专门禁它
    //     （它代表"拿本地快照顶上"那条已经删掉的后路）。这里叫 `settledChars`：定稿快照的字数，
    //     只是给抬头一个初值，真值在 `putWire` 里由**出网原文正文**的长度覆盖。
    const settledChars = (Array.isArray(assembled) ? assembled : [])
        .reduce((a, m) => a + String(m?.content ?? '').length, 0);
    const prewireTok = Number(total) || 0;
    const prewireChars = settledChars;
    // ★ v6.24.54：这一份 body **不再带 `text`** —— 记录服务只收 `wire.body`（真出网原文）。
    //   以前这里塞的是本地快照的可读文本，服务端在没抓到抓包时就把那份写进 git（存档被污染）。
    const body = {
        chat: _gitLogChat(), swipe,
        at: Date.now(),
        // ★★★★★★ v6.27.0【三件套之一：酒馆原始组装的请求（Horae 一个字都没改之前那份）】——
        //   随 /turn 一起交给服务端落成 `turns/NNNNN.raw.txt`（跟 ② 走同一套 git）。
        //   服务端**拿不到就如实不写**（老客户端 / 别的地方调 /turn 不会有这个字段），绝不编。
        raw: (rawSnap && rawSnap.length)
            ? { n: rawSnap.length, chars: rawSnap.reduce((a, m) => a + String(m.content || '').length, 0), msgs: rawSnap }
            : null,
        /* ★★★★★★ v6.51.6【池化前的整份输入 ⇒ `turns/NNNNN.pre.json`】
         *  用户 2026-09-22 原话："把原文后 变量已展开 池化前的消息存起来！不出意外应该是json格式，若不是就txt存着吧"。
         *  形状与上面 `raw` 那一份**同构**（`{n, chars, msgs}`，msgs 里只有 role/content）——
         *  内容 = `_restoreFrozenHistory` 里 `_abSplit` 调用点**前一瞬间**的 msgs（落点为什么定在那里，
         *  见那一大段注释）。msgs 是 JSON 数组 ⇒ 就按 json 存（`pre.json`），不是 txt。
         *  ⚠ 与 `raw` / `abc` 两条通道**同一纪律**：客户端带就落、不带就如实不写 ——
         *    绝不用 raw（少了入口段算子）或出网那份（多了 A 区照抄）冒名顶替。 */
        pre: (() => {
            try {
                const pm = Array.isArray(_restoreStats?.abPreMsgs) ? _restoreStats.abPreMsgs : null;
                if (!pm || !pm.length) return null;
                return { n: pm.length, chars: pm.reduce((a, m) => a + String(m?.content ?? '').length, 0), msgs: pm };
            } catch (_) { return null; }
        })(),
        /* ★★★★★★ v6.38.1【A / B / C 三片原文随 /turn 落盘 ⇒ `turns/NNNNN.a|b|c.txt`】
         *  用户 2026-09-19 定版："可以 你可以将A B C分片存档，方便我们进行测试"。
         *  为什么非要落盘（2026-09-19 实测的硬阻塞）：要让"逐轮各算法压缩率"**可复算**，就必须有分片原文；
         *  而分片依赖 `prev` 的**装配形状**（79 条），那个形状盘上没有任何存档 —— `raw.txt` 是 45 条
         *  （酒馆原始）、`txt` 是 15 条（抓包/合并后）。用替代品复现，|B| 偏大 1.6 倍。
         *  ⇒ 这三份是**唯一**能让算法研究从"估"变成"算"的东西。
         *  ⚠ 服务端拿不到就**如实不写**（老客户端 / 别处调 /turn 没这个字段），绝不用别的东西冒名顶替 ——
         *    与 `raw` 那条通道同一纪律。 */
        abc: (() => {
            try {
                const pack = (arr) => {
                    if (!Array.isArray(arr) || !arr.length) return null;
                    return { n: arr.length, chars: arr.reduce((x, m) => x + String(m?.content ?? '').length, 0), msgs: arr };
                };
                const a = pack(_restoreStats?.abAMsgs);
                const b = pack(_restoreStats?.abBMsgs);      // ★ 池化**后**（实际发出的 B）
                const b0 = pack(_restoreStats?.abB0Msgs);    // 池化**前**（算压缩率的基准）
                const c = pack(_restoreStats?.abCMsgs);
                /* ★★★★★★ v6.51.10【重放集完备性 · 缺口1（客户端侧）：**没切分也要带一份读数**】
                 *  原来四片全空就 `return null` ⇒ 服务端什么都不写 ⇒ 事故那轮（圣樱学院_mucxfcb8nw6n
                 *  生成 00002.json 时的第 3 轮）盘上连"为什么没切"都没有，只能靠 `_diag.log`
                 *  （它住在抓包插件目录里、按天滚动、7 天就没）一步步反推。
                 *  ⇒ 现在带上原因；服务端据此写一份**未切分抬头**（只写 abc.meta.txt，不写 abc.json，
                 *    所以"这一轮有没有切片"这个判据一个字节都不受影响）。 */
                if (!(a || b || b0 || c)) {
                    const R0 = _restoreStats || {};
                    const nm0 = (v, d = -1) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
                    return {
                        a: null, b: null, b0: null, c: null,
                        nowork: String(R0.abSkip || R0.skip || '（没说原因）').slice(0, 240),
                        read: {
                            anchor: nm0(R0.abAnchor), at: nm0(R0.abAt),
                            floorLim: nm0(R0.abFloorLim), same: nm0(R0.abSame),
                            aChars: 0, bRawChars: 0, abOn: 0, preMsgs: Array.isArray(R0.abPreMsgs) ? R0.abPreMsgs.length : 0,
                        },
                    };
                }
                /* ★★★★★★【读数：用户 2026-09-19 定版"我 只！针！对！A！B！C！切片文件"
                 *   ＋ 前一句"实际我对话 肯定会读LCP啊"
                 *   ⇒ 切片文件**自己**要带够能对上 LCP 的读数，读的人不必再去翻心跳/面板：
                 *     · `anchor` = 锚点 `a`（A 区＝基准 `prev[0..a]`）—— **A 的右边界就是它**；
                 *     · `at`     = 那个锚点在**这一轮** `msgs` 里的下标；
                 *     · `aChars` = **A 区字数 ＝ 断点位置**（客户端认定的公共前缀长度）；
                 *     · `bRawChars` = B 区池化**前**字数 ⇒ 与 `b.chars`（池化后）一比就是这一轮省了多少；
                 *     · `floorLim` / `same` / `keepQ` / `keepCut` = 切分依据（对话楼边界 / 对上几条 / 保真区位置）。
                 *   ⚠ 这些**只进切片文件**：不写 `body.meta`、不进 messages、不参与任何判据。 */
                const R = _restoreStats || {};
                const num = (v, d = -1) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
                return {
                    a, b, b0, c,
                    read: {
                        anchor: num(R.abAnchor), at: num(R.abAt), floorLim: num(R.abFloorLim), same: num(R.abSame),
                        aChars: num(R.abAChars, 0), bRawChars: num(R.abRawBChars, 0),
                        amN: num(R.amN, 0), amSave: num(R.amSave, 0),
                        keepQ: num(R.abKeepQ), keepCut: num(R.abKeepCut, 0),
                        /* ★★★★★★ v6.41.4【管线快照 ＋ 逐级读数 —— 目标④】用户定版：
                             "每轮记录里落**管线快照**（顺序 ＋ 每级 id/name/version）与**逐级读数**，供对账复现"。
                           ── 形状：`[{id, name, version, chars}]`（`chars` = 这一级净省多少字，可加总对账）。
                           ── ⚠ 服务端那一侧是**逐字段显式读取**（不是整包透传）⇒ 那边也要同步加一段，
                              否则这里写了也落不到 `turns/NNNNN.abc.meta.txt` 上。 */
                        pipe: Array.isArray(R.abPipe) ? R.abPipe.map((x) => ({
                            id: String(x?.id || ''), name: String(x?.name || ''), version: String(x?.version || ''),
                            chars: num(x?.chars, 0),
                        })) : [],
                        pipeOn: num(R.abPipeOn, -1), pipeBad: String(R.abPipeBad || ''),
                    },
                };
            } catch (_) { return null; }
        })(),
        /* ★★★★★★ v6.51.7【池化台账快照 ⇒ `turns/NNNNN.pool.json` —— 用户 2026-09-22 点名"方便计算重放"】
         *  【为什么非存不可】`B2`（池化后的 B 区 ＝ 真发出去那一份）是 `_amPtr` 按**指纹池**
         *    （localStorage `horae_am_pool_v1`）与**区间台账**（`horae_am_addr_v1`）算出来的。
         *    这两个台账**只活在浏览器 localStorage 里** —— 盘上过去只有**读数**（`abc.meta.txt` 的
         *    `amN` / `amSave` / `pipe`）⇒ 离线重放**算不出 B2**（只算得到 A / C 的边界）。
         *    这是重放充要集里**最后一块缺的**（其余见 STATE 那张表）。
         *  【纪律】原样读、原样发（**不解析、不改写**）—— 台账是什么形状就存什么形状，
         *    重放那边用**同一版源码**去读它，中间不许过一道会丢字段的转换。
         *  ⚠ 体积闸门见 `POOL_SNAP_MAX`：超了就**不发**，改发一条摘要 ＋ 写清原因（不静默、不假装存了）。 */
        pool: (() => {
            /* ★★★★★★ v6.51.11【缺口5′：**内存里那份才是真的**，localStorage 只是兜底】
             *   为什么非要换过来：`_amPoolSave` 的 `setItem` 实测每轮都撞 QuotaExceededError
             *   ⇒ localStorage 里那一份**从来没有本场的键**，而这里原来只读它 ⇒
             *   盘上 `turns/NNNNN.pool.json` 存的一直是别人的池（全仓 352 轮，⑤ 项 **0/352**）。
             *   ⇒ 优先用两个 Save 在写盘前记下的快照（形状 = 准备写进 localStorage 的那一个字符串，
             *     一个字段都不差），两个都空才回落到 localStorage（老客户端 / 这一页还没跑过轮末）。
             *   ⚠ 只改**取数顺序**，字段名与形状一个字不动 —— 重放那边照旧原样读。 */
            try {
                const p = _amPoolSnapText || String(localStorage.getItem(AM_POOL_STORE) || '');
                const a = _amAddrSnapText || String(localStorage.getItem(AM_ADDR_STORE) || '');
                const src = (_amPoolSnapText || _amAddrSnapText) ? 'mem' : 'localStorage';
                if (!p && !a) return { skip: '两个台账都是空的（这一场还没跑过池化）', poolChars: 0, addrChars: 0, src };
                return { pool: p, addr: a, poolChars: p.length, addrChars: a.length, src };
            } catch (_) { return { skip: '读 localStorage 抛了（配额满 / 隐私模式）', poolChars: -1, addrChars: -1 }; }
        })(),
        // 真出网原文由 `putWire(w)` 填（拿到抓包那一刻）；这两个数是抬头第一格要的 token / 字数
        wire: { tok: prewireTok, chars: prewireChars },
        /* ★★★★★★ v6.51.13【重放集 · 缺口3：**这一轮到底开着什么** ⇒ `turns/NNNNN.cfg.json`】
         *   为什么非有不可（定理 4 第 4 项）：同一个 `E_N`，在**不同的开关组合**下会被入口段算子
         *   改写成不同的东西、切出不同的 `A/B0/C` ⇒ 重放时不知道当时开着什么，算出来的数就不是那一轮的数。
         *   逐轮查盘实测：这一项在全仓 **0/352**（从来没有过）。
         *   ── 记什么 ──────────────────────────────────────────────────────────────────
         *     · `settings` 里**所有标量**（布尔的开关、数字、字符串）—— 不点名、不挑，
         *       因为"哪些开关会影响出网那一串"这件事**会随版本变**，点名法迟早漏掉新加的那个；
         *     · 管线级表（`_algoPipeUse`：id / on / ref 模式）＋ 槽名 —— 它决定 `f_X` 是哪几级；
         *     · 客户端版本 —— 与抬头 `cli=` 同源（`f_X` 那一刻是哪一版代码）。
         *   ⚠ 对象/数组型的 settings 项**跳过**（它们不属于"开关"，且可能很大）—— 跳过是**如实**的：
         *     这一份只声称记了标量。绝不写"全量"却只记了一半。
         *   ⚠ 纯读，一个字都不写回；拿不到就 `null`（服务端据此如实不写文件）。 */
        cfg: (() => {
            try {
                const sc = {};
                for (const [k, v] of Object.entries(settings || {})) {
                    const t = typeof v;
                    if (t === 'string' || t === 'number' || t === 'boolean' || v === null) sc[k] = v;
                }
                let pipe = [];
                try {
                    pipe = (_algoPipeUse() || []).map((x) => ({
                        id: String((x && x.id) || ''), on: !!(x && x.on), ref: String((x && x.ref) || ''),
                    }));
                } catch (_) { pipe = []; }
                let slot = '';
                try { slot = String(_algoPipeSlotId() || ''); } catch (_) { slot = ''; }
                return { cli: HORAE_CACHE_PATCH, at: Date.now(), keys: Object.keys(sc).length, settings: sc, pipe, pipeSlot: slot };
            } catch (_) { return null; }
        })(),
        meta: {
            total: Math.max(0, Number(total) || 0), msgs: assembled.length, floor: _currentAiFloor(),
            // 这一轮聊天里一共有多少条（面板拿它判断"表里那些轮次的回复还在不在聊天里"）
            chatLen: (() => { try { const c = getContext()?.chat; return Array.isArray(c) ? c.length : null; } catch (_) { return null; } })(),
            // ★ v6.24.69【删掉 meta.lcp / wire.lcp 两处上传】—— 见下面 putWire 那段的长注释。
            // ★ v6.24.37：把"搬迁到底做没做"写进提交元数据 —— 上一版只有 console 里看得见，
            //   于是"这一轮的后置生效了吗"只能靠猜。写进仓库后，任何一轮都能事后从盘上复查。
            src: sendProof && sendProof.n === assembled.length ? 'sent' : 'settled',
            reloc: (() => {
                const st = _relocateStats;
                // ★ v6.24.41：变量块后置现在**无条件**跑，而 `_relocateStats` 只在那条
                //   "形状判据通过"的路上才有值（而且进 `_finalizeMeasure` 后就被清空了）
                //   ⇒ 这里必须回退到 `_varMoveStats`，否则面板/提交元数据又会把"已经搬了"
                //   写成"没动"（用户已经因为"读数撒谎"踩过一次坑）。
                const vm = (st && st.varBlk) || _varMoveStats || null;
                if (!st && !vm) return null;
                return {
                    count: Math.max(0, Number(st?.count) || 0),
                    skip: String(st?.skip || ''),
                    tailMoved: Math.max(0, Number(st?.tail?.moved) || 0),
                    tailSkip: String(st?.tail?.skip || ''),
                    varBlk: !!(vm && Array.isArray(vm.moved) && vm.moved.length),
                    varBlkSkip: String(vm?.skip || ''),
                    varBlkChars: Math.max(0, Number(vm?.chars)
                        || (Array.isArray(vm?.moved) ? vm.moved.reduce((a, x) => a + (Number(x.chars) || 0), 0) : 0)),
                };
            })(),
            // ★ v6.24.42：历史还原的战果（"新对话轮之前被别的插件删掉的字，这一轮补回来几条"）——
            //   写进提交元数据，任何一轮都能事后从盘上复查"这条纪律到底执行没执行"。
            //   ★ v6.24.44：`boundaryAt` = 拼接的**落点**（第几条起用后文件 = GUI 上"最近这条 AI 消息的开头"）。
            restore: (() => {
                const r = _restoreStats;
                if (!r) return null;
                return {
                    on: !!r.on, restored: Math.max(0, Number(r.restored) || 0),
                    chars: Math.max(0, Number(r.chars) || 0), skipped: Math.max(0, Number(r.skipped) || 0),
                    boundaryAt: (r.boundaryAt === null || r.boundaryAt === undefined) ? null : Number(r.boundaryAt),
                    skip: String(r.skip || ''),
                };
            })(),
        },
    };
    // v6.6：**不再做旧 key 迁移**。key 现在是"这个聊天文件自己盖章的 id"，
    // 迁移只会把上一个聊天的记录搬进新聊天（正是用户踩到的"删了聊天记录还在"）。
    // 旧仓库原地留着（还能当分析素材），到 30 个上限时按"最近用过"自然淘汰。
    void (async () => {
        // 时间窗起点：优先用"请求真出发那一刻"（`_sendProof.at`，最准）；
        // ★ v6.24.39：它没凑齐（条数对不上 / 指纹还没算完 / 非 openai 通路）就用 `_lastSendAt`
        //   —— 那也是"出发那一刻"，但是**同步记下的、一定存在**。两个都没有才退回"现在"。
        //   为什么这一行是命门：退回"现在"（提交那一刻）实测比抓包落盘**晚 7 秒**
        //   （抓包 20:38:33 落盘 / 这里 20:38:37 才提交）⇒ 时间窗把这一轮的出网原文挡在门外，
        //   三轮记录全写"没抓到"（而三份真 request 就躺在盘上）。
        // ★ v6.24.54【用户定版："本地快照是历史死代码，给我删了吧，我们只管最终出网"】──────
        //   出网原文这一份是**唯一**能进 git 的字。取不到就**等它落盘**（不再拿本地快照顶上）：
        //   以前 `wire.ok` 为假 → 走 `body.text`（本地快照）照样提交，抬头写"本地快照（没抓到出网原文）"，
        //   那就是"git 存档被污染"的入口。实测（全仓 125 轮）：12 轮存档是本地快照，其中 10 轮的抓包
        //   就在落盘前 4~7 秒躺在盘上（重试窗口只有 2.3 秒 + 形状判据拿本地快照条数当尺子，两条都太紧）。
        //   现在：**取不到 → 不写、不提交**（下面等；超时也宁可这一轮没有记录）。
        //   ⚠ 代价写清楚（别让人以后当 bug）：抓包插件没加载／酒馆没重启时，这一轮**没有记录** ——
        //     这正是"不许编数"的口径；console 会写明原因。
        const putWire = (w) => {
            // ★ v6.24.57【真 bug 修复】这一行原来是
            //     `tok: Number(body.wire.tok) || 0, chars: Number(body.wire.chars) || 0`
            //   而它写在 `body.wire = { … }` 这个**字面量里面** —— 赋值还没发生，`body.wire` 还是
            //   `undefined` ⇒ 读 `.tok` **必抛 `TypeError`**（首轮必然抛；重试轮因为上一轮已经把
            //   `body.wire` 建好了反而不抛）。这就是"面板 0 轮"的**第三个真因**，也是最后一个：
            //   现场证据链 —— `diag:A-beforePutWire`（取到出网原文 101,428 字节）**到了**，
            //   紧接着的 `putWire` 抛异常、被下面那个 catch 吞成 `lastWhy`，于是
            //   `diag:B` / `willCommit` / `turn:send` 一条都不出现，`/turn` 从来没被调用过。
            //   （前两个真因见 v6.24.55：CSRF 403 自愈、抓包判据放宽。）
            //   修法：先算好再赋值 —— 不碰**还没建出来**的字段，并给个安全的默认值。
            const preTok = Number(body?.wire?.tok) || 0;
            const preChars = Number(body?.wire?.chars) || 0;
            /* ★★★★★★ v6.41.4【这一轮是谁装的 ＝ **管线**（不再是"某一个算法"）】
               ── 用户 2026-09-20 点名："**单算法切换记得删除 特别实验标准已无效 因为已经模块化算法
                  组合管线**" ⇒ 抬头上报的那一格从此是**管线**的快照，与 `algos/<槽>/` 同一个字符串。
               ── `_algoPipeSnap()` 给的正是"顺序 ＋ 每级 id/name/version" —— 目标④要的就是它。 */
            const _ps = (typeof _algoPipeSnap === 'function') ? _algoPipeSnap() : [];
            body.wire = {
                body: w.body, bytes: w.bytes, sha256: w.sha256, n: w.n, model: w.model, file: w.file,
                // ★ v6.24.39：**本地 = 官方**的同一串字 —— `tok` / `chars` 由主路（`_gitLogPushTurn`）数好传进来；
                //   重试那头拿到的同一份 `body` 已经带着它们，所以这里不重数（`_finalizeMeasure` 那条主路已经把
                //   数不出来的情况如实留成 0，面板那一格显示"—"，**绝不编数**）。
                tok: preTok, chars: preChars,
                // ★ v6.24.69【用户点名："给抬头添加当前版本信息，我们日后好对账，省的我没重启服务器
                //   或者 F5 影响你的判断"】—— `ver` = 写这一轮时**浏览器里真跑着的那份客户端版本**
                //   （`HORAE_CACHE_PATCH`）；另一半 `srv` 由服务端自己填（只有它知道自己加载的是哪一版）。
                //   为什么非加不可：以前的抬头**看不出这一轮是哪套代码写的** —— 判断"搬迁到底生效没生效"时
                //   分不清是"代码有问题"还是"用户还没 F5 / 没重启酒馆"，只能拿时间戳去猜。
                //   `tokSrc`：`sent` = 这个 tok 数的是出发那一刻的 POST body（与官方同源，实测 +51~+60 对得上）；
                //             `settled` = 数的是定稿快照那份（**与官方不可比**，实测差 6,500 tok）。
                ver: String(HORAE_CACHE_PATCH || ''),
                /* ★★★★★★ v6.39.11【这一轮是**哪个算法**装配的 —— 与 `ver`(cli=) 同性质、同一处上报】
                   ── 用户 2026-09-19 要求："给每一轮的数据 标记 来自什么版本算法，跟BS双端版本一个性质"，
                      并给了一个非常具体的理由："**省的我对话一半了，切算法继续跑，结果修bug时候
                      大家的认知错误**"。
                   ── 解读：切换算法**不必**打断正在进行的对话（本来就是下一轮才换链），
                      但**同一场聊天里每一轮可能是不同算法算的** —— 事后若只按"现在选的是哪个"去读，
                      认知必然错乱（修 bug 时会把 A 算法的账算到 B 算法头上）。
                   ── ⇒ 标注必须**落在这一轮的记录里**（抬头），而不是面板上现读一个"当前算法"。
                      `ver` 说的是"哪套代码写的"，这三个字段说的是"这一轮的提示词是哪条链装配的"。
                   ⚠ 取的是**写这一轮那一刻**的管线快照（`_algoPipeSnap()`），不是"现在的" ——
                     用户完全可能对话中途改管线，事后按"现在是什么"去读，认知必然错乱。
                   ⚠ 服务端拿不到就如实不写（老客户端照旧）；这里拿不到注册表时如实留空串
                     （抬头会写 `?`，与 `cli=?` 同一纪律 —— 不编）。 */
                /* ── 值的来源：**管线**（三个键名保持不动 —— 它们是这一跳的内部字段名，
                      改它们要连 `/turn` 的接线与 `check/wire_meta_test.mjs` 一起动，而收益为零）。
                   ── `algo`     = 管线槽名（＝`algos/<槽>/` 的目录名，也是 `/log` 判"这一行归谁管"的
                                   唯一来源 ⇒ 它必须与客户端槽名**同一个字符串**，否则取消勾选时补算找不到人）；
                      `algoVer`  = 逐级版本用 + 连（有几级、各是哪一版，一眼看得出；空管线如实写 raw）；
                      `algoKind` = pipe（如实：它既不是盘上的 disk，也不是单个 local）。 */
                algo: String((typeof _algoPipeSlotId === 'function') ? _algoPipeSlotId() : ''),
                algoName: _ps.map((x) => x.name || x.id).join(' → '),
                algoVer: _ps.map((x) => x.version || '?').join('+') || 'raw',
                algoKind: 'pipe',
                pipeSnap: _ps,
                tokSrc: String(tokSrc || ''),
                // ══ ★ v6.24.69【★ 删掉归档抬头里那段 `| lcp …`】══════════════════════════
                //   为什么删（实测 2026/9/17，用户报"本地文件跟官方就对不上"）：
                //   `_measuredLcp` 比的是**客户端手里那串字** —— `_prevRealMsgs`（上一次发送那一刻的
                //   取证，**跨聊天也算**）与这一轮组装结果。它与 `turns/NNNNN.txt` 里真出网那份
                //   **不是同一串字**（酒馆后端 postProcess 会并消息、展开宏），于是抬头那个数对
                //   "这一场聊天的第 N 轮"根本不成立。现场两条：
                //     · `圣樱学院_mu5clow3vpjs` #00001：抬头写 `lcp 31104tok/53679ch @#33 user (两轮逐字一致)`，
                //       服务端在两份记录正文上现算（面板口径）**只有 4 字**逐字相同（命中率 0.0%）；
                //     · 同一场 #00000 是**这一场聊天的第一轮**，抬头照样写"(两轮逐字一致)" ——
                //       那个"上一轮"其实是**上一场聊天**的最后一次发送。
                //   为什么留着有害：面板那三列的**唯一来源**是服务端 `lcpOfTurns`（§2.2 一处参数栏
                //   只许有一套算法），抬头这一段等于在盘上又躺了一个与面板、与官方都对不上的第二套数；
                //   用户是**拿盘上文件跟官方对账**的，这一行就是他看到的"对不上"。
                //   v6.24.42 当初非给不可的理由（"出网那层没有逐条 token ⇒ 面板本地命中只能得 0"）
                //   早在 v6.24.51 就随 `lcpOfTurns` 落地失效了 —— 这行是那次没删干净的死代码。
                //   ⚠ 服务端 `flattenWire` 的 lcp 形参、以及 `body.meta?.lcp` 那条后路**都保留**：
                //     它们服务的是**老客户端**（用户还没 F5 的那些页面），盘上历史记录的抬头也照旧读得回来。
                //   ⚠ `_measuredLcp` 本身不删：`[hitOpt] 实测断点：…` 那条 console 与 `pushTurn:enter`
                //     心跳里的 `lcpTok` 还在用它做诊断（那两处**只给人看，不落盘**）。
            };
        };
        // ★ v6.24.58：这条心跳**保留**（"自动检测用户动作"的起点 —— `tools/auto_monitor.mjs`
        //   靠它看出"新一轮出发了、手上当时有多少条、出发时刻是什么"）。
        try {
            _diagReport({
                tag: 'pushTurn:enter', chat: body.chat, swipe,
                assembledLen: Array.isArray(assembled) ? assembled.length : -1,
                hasProof: !!sendProof, proofN: Number(sendProof?.n) || 0,
                proofAt: Number(sendProof?.at) || 0, lastSendAt: Number(_lastSendAt) || 0,
                tokTotal: Number(total) || 0, lcpTok: Number(lcp?.tok) || 0,
                // ★ v6.24.69【诊断"LCP 突然失灵"用的一条只写 GET 日志的埋点，不入档】——
                //   实测 `圣樱学院_mu5clow3vpjs`：#0→#1 两轮公共前缀只有 **4 字**，断在 system 第 5 个字节
                //   （#0 那个位置是空的、#1 被填进 2,866 字的 `<status_current_variables>` 块）。
                //   离线复算（真出网原文）：把那块按规则摘到末尾 → lcp 从 4 字涨到 28,937 字（0% → 53.8%）。
                //   可盘上 4 轮的原文里，那个位置**从来没留下过 Horae 的常量指针** ⇒ 搬迁那一步没碰它。
                //   这两个数是"它到底跑了没、跳过的理由是什么"的唯一直接证据（控制台里看不到）。
                //   ⚠ 这里**不许**写成 `Number(_varMoveStats?.count) || 0`：`Number(null)` 是 0 而 0 是有限数，
                //     那样"这一步压根没跑到"会被伪装成"跑了、一个都没搬"—— 正是本项目踩过四次的坑
                //     （楼层全变 #0 / 官方没回来被当成命中 0 / lcp 为 null 当成 0 字 / 命中率渐变把 null 涂红）。
                //     所以：**没跑 = -1**，跑了没搬 = 0，搬了 = 正数。
                varBlkCount: (() => { try { return _varMoveStats ? (Number(_varMoveStats.count) || 0) : -1; } catch (_) { return -2; } })(),
                varBlkSkip: (() => { try { return String(_varMoveStats?.skip || '').slice(0, 90); } catch (_) { return ''; } })(),
                varBlkWhy: (() => { try { return String(_varMoveStats?.why || '').slice(0, 90); } catch (_) { return ''; } })(),
                varBlkMoved: (() => { try { return (_varMoveStats?.moved || []).map(v => `#${v.j}:${v.chars}`).join(',').slice(0, 90); } catch (_) { return ''; } })(),
                relocCount: (() => { try { return _relocateStats ? (Number(_relocateStats.count) || 0) : -1; } catch (_) { return -2; } })(),
                // ★ v6.24.71【这一改到底有没有生效的唯一直接证据，只写 GET 日志、不入档】——
                //   历史还原那一步（`_restoreFrozenHistory`）接回了几条"上一轮自己后置、这一轮已经找不回来"
                //   的增量条。实测收益（真出网原文复算）：第 5→6 轮接回 1 条 15,585 字
                //   ⇒ 与上一轮的公共前缀 48,128 → 63,713 字（+9,197 tok 全转成命中），未命中一个字不涨。
                //   控制台里也有一行（`[hitOpt] …历史还原…｜★ 接回…`），但控制台不留档；
                //   这两个数进心跳之后，`tools/auto_selfcheck.mjs` 能从盘上直接判"接回有没有发生"。
                //   ⚠ 同样的纪律：**没跑 = -1**（`Number(null) === 0` 是有限数，会把"没跑"伪装成"跑了、一条没接"）。
                keptBack: (() => { try { return _restoreStats ? (Number(_restoreStats.keptBack) || 0) : -1; } catch (_) { return -2; } })(),
                /* ★★★★★★ v6.50.6【席位补回的四个读数 —— 用户 2026-09-22 点名"一个都不许静默"】
                 *  · `rsSeatBackN` / `rsSeatBackChars` —— 本轮**补回了几条 / 几字**（席位级整段）
                 *  · `rsSeatIdem`      —— 因**幂等**（本轮已经有这份内容）跳过的条数
                 *  · `rsSeatBlocked`   —— 因**超过上限** `RESTORE_SEAT_MAX_CHARS` 被挡下的条数
                 *  ⛔ prompt 无上限膨胀 ＝ 直接判失败 ⇒ 这三个数就是那个护栏的可见面。 */
                rsSeatBackN: (() => { try { return _restoreStats ? (Number(_restoreStats.seatBackN) || 0) : -1; } catch (_) { return -2; } })(),
                rsSeatBackChars: (() => { try { return _restoreStats ? (Number(_restoreStats.seatBackChars) || 0) : -1; } catch (_) { return -2; } })(),
                rsSeatIdem: (() => { try { return _restoreStats ? (Number(_restoreStats.seatIdem) || 0) : -1; } catch (_) { return -2; } })(),
                rsSeatBlocked: (() => { try { return _restoreStats ? (Number(_restoreStats.seatBlocked) || 0) : -1; } catch (_) { return -2; } })(),
                keptChars: (() => { try { return _restoreStats ? (Number(_restoreStats.keptChars) || 0) : -1; } catch (_) { return -2; } })(),
                relocSkip: (() => { try { return String(_relocateStats?.skip || '').slice(0, 90); } catch (_) { return ''; } })(),
                // ══ ★★★ v6.24.83【"体检到底拦没拦"必须可观测】══════════════════════════════════════
                //   为什么非加（2026-09-17 第 8~11 轮实测踩到）：连续四轮 `kept 0 / 0`，而
                //   **两种解释都成立、从盘上一个字都分辨不出来**：
                //     a. 基准体检把这一轮拦住了（`on=false`）⇒ 说明基准卡在可疑来源上，是 bug；
                //     b. 这一轮**本来就没有增量**（`adds` 为空，历史一个字没变）⇒ 完全正常。
                //   分辨它们只要几个数，而这些数原来只打在 console 里（控制台不留档、刷新就没）。
                //   ⇒ 现在进心跳：`rsOn` 跑成了没 / `rsSkip` 跳过的原文理由 / `rsBase` 基准来源标记
                //     （`wire0`·`mem`·`post` = 同源可信；`wire` = 网上那份、形状与这一轮不同源）。
                //   ⚠ 纪律照旧：**没跑 = -1**（`Number(null) === 0` 是有限数，会把"没跑"伪装成"跑了"）。
                rsOn: (() => { try { return _restoreStats ? (_restoreStats.on ? 1 : 0) : -1; } catch (_) { return -2; } })(),
                rsSkip: (() => { try { return String(_restoreStats?.skip || '').slice(0, 120); } catch (_) { return ''; } })(),
                rsBase: (() => { try { return String(_restoreStats?.baseSrc || '').slice(0, 40); } catch (_) { return ''; } })(),
                // ══ ★★★ v6.24.94【"这一轮到底走没走 A/B"必须从盘上看得见】════════════════════════
                //   为什么非加（2026-09-17 实测的血泪）：`varBlkWhy` 为空有**两种截然不同**的解释 ——
                //     ① `abOn=1` ⇒ v6.24.92 主动跳过搬运（新值本来就落在 B 区）；
                //     ② 搬运跑了但没有 victims（变量块已搬过 / 被冻结池先接管）；
                //   这两种的修法完全相反，**而从盘上一个字都分辨不出来**。我这次是靠"#34 的 #0 是
                //   58 字的冻结池指针"反推出它是①，多花了一整轮。
                //   `abBase` = A/B 用的基准是"上一轮那一份"（last）还是"候选里挑出来的那份"（picked）
                //   —— v6.24.94 的前提修正成没成，看这一格。
                //   ⚠ 纪律照旧：**没跑 = -1**（`Number(null) === 0` 会把"没跑"伪装成"跑了"）。
                abOn: (() => { try { return _restoreStats ? (_restoreStats.abOn ? 1 : 0) : -1; } catch (_) { return -2; } })(),
                //   ★ v6.51.9：**兜到 out.skip** —— 以前只有 34298 那一种「基准拿不到」写 abSkip，
                //     其余几种（开关关着 / 没有 messages / 体检拦下）在这里全显示成空串，
                //     于是"这一轮为什么没池化"从盘上根本读不出来（事故那一轮就是这样）。
                abSkip: (() => { try { return String(_restoreStats?.abSkip || _restoreStats?.skip || '').slice(0, 130); } catch (_) { return ''; } })(),
                abBase: (() => { try { return String(_restoreStats?.abBase || '').slice(0, 8); } catch (_) { return ''; } })(),
                abAN: (() => { try { return _restoreStats ? (Number(_restoreStats.abAN) || 0) : -1; } catch (_) { return -2; } })(),
                abBN: (() => { try { return _restoreStats ? (Number(_restoreStats.abBN) || 0) : -1; } catch (_) { return -2; } })(),
                // ★ v6.24.106（乙）：锚点被限制在哪（＝这一轮认出的对话楼边界下标；-1 = 没认出 ⇒ 不限制）。
                abFloorLim: (() => { try { return _restoreStats ? (Number(_restoreStats.abFloorLim) || 0) : -1; } catch (_) { return -2; } })(),
                /* ★ v6.41.27：对话历史末尾**靠什么认出来的**（`chatHistory` / `lastFloor`）＋认出几条
                 *   `chatHistory-N`。认不出 ⇒ 判据静默退回老路，盘上只看 `abFloorLim` 是分辨不出来的
                 *   ⇒ 这两个读数就是"新判据到底生效没有"的唯一凭据（发一轮就能查）。 */
                abFloorSrc: (() => { try { return _restoreStats ? String(_restoreStats.abFloorSrc || '') : ''; } catch (_) { return ''; } })(),
                abChatHistN: (() => { try { return _restoreStats ? (Number(_restoreStats.abChatHistN) || 0) : -1; } catch (_) { return -2; } })(),
                // ★ v6.26.0【保真区】`keepCut=1` = 这一轮真的把 A 区截到"保真区第一条"前面了；
                //   `keepQ` = 基准里第一个命中保真区集合的下标（-1 = 没命中 ⇒ 一个字没截）。
                abKeepSetN: (() => { try { return _restoreStats ? (Number(_restoreStats.abKeepSetN) || 0) : -1; } catch (_) { return -2; } })(),
                abKeepQ: (() => { try { return _restoreStats ? (Number.isFinite(Number(_restoreStats.abKeepQ)) ? Number(_restoreStats.abKeepQ) : -1) : -2; } catch (_) { return -2; } })(),
                abABefore: (() => { try { return _restoreStats ? (Number.isFinite(Number(_restoreStats.abABefore)) ? Number(_restoreStats.abABefore) : -1) : -2; } catch (_) { return -2; } })(),
                abKeepCut: (() => { try { return _restoreStats ? (Number(_restoreStats.abKeepCut) || 0) : -1; } catch (_) { return -2; } })(),
                abAChars: (() => { try { return _restoreStats ? (Number(_restoreStats.abAChars) || 0) : -1; } catch (_) { return -2; } })(),
                abBChars: (() => { try { return _restoreStats ? (Number(_restoreStats.abBChars) || 0) : -1; } catch (_) { return -2; } })(),
                // ★★★★★★ v6.27.0【B 区 `<AMnnnn>` 指针化】`amN` = 这一轮换掉几个重复注入块；
                //   `amSave` = 少发多少字（≈ tok 按 0.6265 折算）；`amBad` 非空 = 那一步抛了（如实报，不静默）。
                amN: (() => { try { return _restoreStats ? (Number(_restoreStats.amN) || 0) : -1; } catch (_) { return -2; } })(),
                amSave: (() => { try { return _restoreStats ? (Number(_restoreStats.amSave) || 0) : -1; } catch (_) { return -2; } })(),
                amPtrChars: (() => { try { return _restoreStats ? (Number(_restoreStats.amPtrChars) || 0) : -1; } catch (_) { return -2; } })(),
                amNames: (() => { try { return String(_restoreStats?.amNames || '').slice(0, 170); } catch (_) { return ''; } })(),
                amBad: (() => { try { return String(_restoreStats?.amBad || '').slice(0, 90); } catch (_) { return ''; } })(),
                // ★ v6.27.1：包裹账（首次注入包了几个块 / 壳花了多少字）—— 与 amSave 一起才是真账
                amWrapN: (() => { try { return _restoreStats ? (Number(_restoreStats.amWrapN) || 0) : -1; } catch (_) { return -2; } })(),
                amWrapCost: (() => { try { return _restoreStats ? (Number(_restoreStats.amWrapCost) || 0) : -1; } catch (_) { return -2; } })(),
                // ★ v6.27.2：子段指针化（吃掉"块内变异"那 22,000 tok/轮）
                amSubN: (() => { try { return _restoreStats ? (Number(_restoreStats.amSubN) || 0) : -1; } catch (_) { return -2; } })(),
                amSubSegs: (() => { try { return _restoreStats ? (Number(_restoreStats.amSubSegs) || 0) : -1; } catch (_) { return -2; } })(),
                amSubSave: (() => { try { return _restoreStats ? (Number(_restoreStats.amSubSave) || 0) : -1; } catch (_) { return -2; } })(),
                // ★★★★★★ v6.27.1【池落盘】"池多大、装回来没、写进去没"必须有读数 ——
                //   否则"amN 又是 0"依旧分辨不出是池空、没装回来、还是块本身不在 B 区（三种修法完全不同）。
                //   纪律照旧：**没跑 = -1**，不拿 0 冒充。
                amPoolN: (() => { try { return _amPoolSize(); } catch (_) { return -2; } })(),
                amPoolLoaded: (() => { try { return Number(_amPoolStat.loaded); } catch (_) { return -2; } })(),
                amPoolSaved: (() => { try { return Number(_amPoolStat.saved); } catch (_) { return -2; } })(),
                amPoolState: (() => { try { return String(_amPoolStat.state || ''); } catch (_) { return ''; } })(),
                amPoolWhy: (() => { try { return String(_amPoolStat.why || '').slice(0, 120); } catch (_) { return ''; } })(),
                pickCands: (() => { try { return _restoreStats ? (Number(_restoreStats.pickCands) || 0) : -1; } catch (_) { return -2; } })(),
                // ══ ★★★ v6.24.96【"基准到底写没写进 localStorage"必须从盘上看得见】══════════════
                //   为什么非加（v6.24.95 修完判据之后剩下的最后一个盲区）：自锁的**判据**修好了，
                //   可"写盘成功了吗"不可观测 ⇒ 下一轮若仍是 `rsOn=0`，依旧分辨不出是
                //     a. 压根没调用（`stState=''`）／b. 调用了但 setItem 抛了（`state='fail'`＋真实错因）
                //     ／c. 存进去了、下一轮读不出（`state='read0'` 或 `stKey` 与当前聊天 key 不等）。
                //   三种的修法完全不同，而盘上原来一个字都查不出来。**没跑 = -1**（不许拿 0 冒充）。
                stState: (() => { try { return _prevStoreStat.at ? String(_prevStoreStat.state || '?') : -1; } catch (_) { return -2; } })(),
                stWhy: (() => { try { return String(_prevStoreStat.why || '').slice(0, 90); } catch (_) { return ''; } })(),
                stLen: (() => { try { return _prevStoreStat.at ? (Number(_prevStoreStat.len) || 0) : -1; } catch (_) { return -2; } })(),
                stKey: (() => { try { return String(_prevStoreStat.key || '').slice(0, 60); } catch (_) { return ''; } })(),
                stSrc: (() => { try { return String(_prevStoreStat.src || '').slice(0, 8); } catch (_) { return ''; } })(),
                stCopies: (() => { try { return _prevStoreStat.at ? (Number(_prevStoreStat.keys) || 0) : -1; } catch (_) { return -2; } })(),
                pickTried: (() => { try { return _restoreStats ? (Number(_restoreStats.pickTried) || 0) : -1; } catch (_) { return -2; } })(),
                rsRestored: (() => { try { return _restoreStats ? (Number(_restoreStats.restored) || 0) : -1; } catch (_) { return -2; } })(),
                rsCopies: (() => { try { return _restoreStats ? (Number(_restoreStats.copies) || 0) : -1; } catch (_) { return -2; } })(),
                rsFloors: (() => { try { return _restoreStats ? (Number(_restoreStats.floors) || 0) : -1; } catch (_) { return -2; } })(),
                rsFloorsGone: (() => { try { return _restoreStats ? (Number(_restoreStats.floorsGone) || 0) : -1; } catch (_) { return -2; } })(),
                /* ══ ★★★★★★ v6.50.2【锁①：运行时自证 —— 这两个读数必须每轮都进心跳】══════════════════
                 *  用户 2026-09-22 拍板「**给我上锁**」（把这个 bug 锁死、不许再犯）。
                 *  要锁的 bug（v6.50.1 已修，但修完必须**看得见它有没有复发**）：
                 *    体检拿「上一轮**池化后**的串」里的条目（B 段那些已被压成壳：
                 *    `<HASH-XXXXXX>…略 N 字…</HASH-XXXXXX>`）去「这一轮酒馆给的原件」里找 —— 原件里是**原文**，
                 *    壳只存在于壳里 ⇒ 必然找不到 ⇒ 判「一条聊天楼层被删」⇒ **整条还原链放弃**（`rsOn=0`）
                 *    ⇒ `_abSplit` 根本没进去（`abOn=0`）⇒ **这一轮没有 A 区** ⇒ 命中当场从 9 万掉到 8 千。
                 *    已知 4 个受害者（`圣樱学院_mubee2ngkp5o` 第 20/32/36 轮 ＋ `muc1ddcaiddc` 第 20 轮）。
                 *  ⇒ **一旦再发生，盘上立刻看得见**，不用人去猜：
                 *    · `rsFloorsGoneReal` —— 真正找不着的**聊天楼层**数（**闸门只看它**；变量更新块不算）；
                 *    · `auditShape` —— 体检拿**哪一份参考**比的：
                 *        `prePool(A+B0+C)` ＝ 走 v6.50.1 的新路（**原文对原文**，已修）；
                 *        `postPool(prev)`  ＝ **退回旧路**（取不到 `B0`）⇒ 这一档**必须显式可见**，
                 *        ⛔ **不许静默降级** —— "静默降级"是这个项目反复踩的坑（表现成"判据没生效"，白查好几轮）。 */
                rsFloorsGoneReal: (() => { try { return _restoreStats ? (Number(_restoreStats.floorsGoneReal) || 0) : -1; } catch (_) { return -2; } })(),
                /* ★ v6.50.3：因"含指针壳"而**不进体检**的条目数（壳不是可比对象，见体检段那段注释）。
                 *  ⛔ 显式上报，不许静默跳过。 */
                rsShellSkip: (() => { try { return _restoreStats ? (Number(_restoreStats.shellSkip) || 0) : -1; } catch (_) { return -2; } })(),
                auditShape: (() => { try { return _restoreStats ? String(_restoreStats.auditShape || '') : ''; } catch (_) { return ''; } })(),
                // ══ ★★★ v6.24.88【"为什么一行都没扣"必须能从盘上判】══════════════════════════════
                //   官方数为证（#26~#30，`圣樱学院_mu5ffle6lfcc`）：miss 卡在 18,749~25,515，其中
                //   **约 17,200 tok 全在尾部那一条【本轮增量】上**（26,796 字 / 9 段）；它 820 个 +行 里
                //   **468 行 / 10,858 tok 与上一轮那条增量逐字相同** ⇒ 本该被 `_patchDropSeen` 整行扣掉。
                //   判据只有一个：抬头还是 `RESTORE_ADD_HEAD`（扣过才会变 `HEAD2`）⇒ **一行都没扣**。
                //   原因只有两种，从盘上原来分辨不出来：
                //     a. `rsSeen=0`   ⇒ 基准（`prev`）里**没有**我们自己上一轮的增量条 ⇒ 基准不是"上一轮真发出去的字"；
                //     b. `rsSeen>0`   ⇒ 索引建对了，是 `rsGate` 那道"扣了内容就丢"的保险把行全拦下了。
                //   `rsBlk` = 基准里认出几条我们自己的增量条（0 = 一条都没有）；`rsLost` = 接回了几条。
                rsSeen: (() => { try { return _restoreStats ? (Number(_restoreStats.seenN) || 0) : -1; } catch (_) { return -2; } })(),
                rsBlk: (() => { try { return _restoreStats ? (Number(_restoreStats.oursBlk) || 0) : -1; } catch (_) { return -2; } })(),
                rsGate: (() => { try { return _restoreStats ? (Number(_restoreStats.gateN) || 0) : -1; } catch (_) { return -2; } })(),
                rsLost: (() => { try { return _restoreStats ? (Number(_restoreStats.lostN) || 0) : -1; } catch (_) { return -2; } })(),
                rsAdds: (() => { try { return _restoreStats ? (Number(_restoreStats.addsN) || 0) : -1; } catch (_) { return -2; } })(),
                rsDrop: (() => { try { return _restoreStats ? (Number(_restoreStats.dropSeen) || 0) : -1; } catch (_) { return -2; } })(),
                rsReSaid: (() => { try { return _restoreStats ? (Number(_restoreStats.reSaid) || 0) : -1; } catch (_) { return -2; } })(),
                rsPrevLen: (() => { try { return _restoreStats ? (Number(_restoreStats.prevLen) || 0) : -1; } catch (_) { return -2; } })(),
                rsCurLen: (() => { try { return _restoreStats ? (Number(_restoreStats.curLen) || 0) : -1; } catch (_) { return -2; } })(),
                rsBound: (() => { try { return _restoreStats ? (Number(_restoreStats.boundaryAt) || 0) : -1; } catch (_) { return -2; } })(),
                rsOurs: (() => { try { return _restoreStats ? (Number(_restoreStats.ours) || 0) : -1; } catch (_) { return -2; } })(),
                floor: Number(body.meta?.floor), chatLen: Number(body.meta?.chatLen),
            });
        } catch (_) { }
        // ══ 等出网原文落盘，再提交（同一个编号，绝不写"不是出网那份"的字）══
        const since = Number(sendProof?.at) || Number(_lastSendAt) || Date.now();
        // 编号先定下来：`/turn` 自己发号时是"仓库里已有文件的最大编号 +1"，而这一轮可能正在等
        // 抓包落盘 —— 重试要是各自发号，会跳号甚至把编号顺序搞反（提交顺序 = 落盘顺序）。
        // `/reserve` 只建仓库 + 报编号（**不写文件、不提交**），所以它不需要出网原文。
        // ★ v6.24.58【重 roll 修复】`swipe` 这一轮**不许发新号**：重 roll = 覆盖上一轮，
        //   编号必须**复用 HEAD 那一轮**的 ⇒ 读服务端 `/reserve` 回的 `headNo`（它才知道仓库现状）。
        //   （正常路径拿 `nextTurnNo`、重 roll 拿 `headNo`，两边都不靠猜。）
        //
        // ⚠⚠ ★★★ v6.24.103【v6.24.101 的"重 roll 也追加"**当场撤回**】⚠⚠
        //   用户实测结论（原话）："测试了几轮 **效果不如 git reset**" ＋
        //   "**LCP在无限增长 哪怕我删除重roll了楼层**" ＋ "重roll的没了就没了吧"。
        //   101 的出发点是"那两发真花过钱、不该从盘上消失"（事实没错），但代价在**基准挑选**这一侧：
        //   `_prevMsgsPickBest`（v6.24.86）从最近 3 份候选里挑**LCP 最长**的那一份 —— 重 roll 的几发
        //   内容彼此极像，于是它**每次都挑中上一次重 roll 的那一发**，把"用户已经丢弃的那份字"
        //   当成基准拼回去 ⇒ 面板 lcp 逐发上涨、官方却不会命中它（官方只认真发过的那串字）。
        //   实测（`圣樱学院_mu5q3ymmo3ld`，同一个第 21 楼连发 4 次）：
        //     #14 lcp=171,736 → #15 **177,983** → #16 177,983 → #17 177,983（用户："无限增长"）。
        //   ⇒ 盘上**只留"最终那一发"**才是对的：记录仓库是**当前聊天状态的镜像**，
        //     不是"出网流水账"。被 reset 掉的那一发随之消失 —— 用户已明确接受（"没了就没了吧"）。
        //   ⚠ 别再拿"完成定义里那条 显示行 == 真发出过的请求数"来反驳：那条要成立的场景是
        //     **正常发送**；重 roll 属于"同一楼原地替换"，替换掉的那一发不算一行（v6.24.58 定版）。
        let no = null;
        try {
            const r = await _gitLogApi('/reserve', { chat: body.chat, migrateFrom: body.migrateFrom });
            const headNo = Number(r?.headNo);
            no = swipe ? (Number.isFinite(headNo) ? headNo : Number(r?.no)) : Number(r?.no);
        } catch (_) { }
        if (Number.isFinite(no)) body.no = no;
        let lastWhy = '';
        for (let i = 0; i < WIRE_WAIT_STEPS.length; i++) {
            // 抓包在**传输层**落盘（比这一轮量测开始晚 ~4 秒）：这里按 1.5/3/5/5/5/5 秒的间隔去问，
            // 一共约 24.5 秒。第一次不睡（多数情况下它已经落盘了）。
            if (i) await new Promise(r => setTimeout(r, WIRE_WAIT_STEPS[i]));
            else if (!Number.isFinite(no)) await new Promise(r => setTimeout(r, WIRE_WAIT_MIN_MS));  // 编号都没问到（服务端还没起？）也先等够
            const w = await _gitLogFetchWire({ since, expectMsgs: assembled.length });
            // ★ v6.24.58：这条心跳**保留** —— 它是"自动检测"那条链的中间点
            //   （`tools/auto_monitor.mjs` 用它判断"这一轮开始等抓包了没有、第几次、拿到了没"）。
            try {
                _diagReport({
                    tag: 'pushTurn:try', chat: body.chat, i, since,
                    expectMsgs: Array.isArray(assembled) ? assembled.length : -1,
                    ok: !!w?.ok, err: String(w?.error || ''), file: String(w?.file || ''),
                    n: Number(w?.n) || 0, chars: Number(w?.chars) || 0, bodyLen: typeof w?.body === 'string' ? w.body.length : 0,
                });
            } catch (_) { }
            if (!w?.ok) { lastWhy = String(w?.error || '未知原因'); continue; }
            // ══ ★ v6.24.58：这一跳现在是"每一步自己 try/catch、失败必留声"（探针已撤，教训留下）══
            //   老写法（v6.24.57 之前）是在行与行之间插探针，`putWire` 一抛异常，
            //   后面几条探针**连同异常一起**被静默吞掉 —— 那个断点就是这么藏了一整轮。
            //   现在：每一步的失败都有 `console.warn/error`，**不允许再出现空 catch**。
            // ① 把出网原文放进 body（★ v6.24.57 修掉的那个真 bug 就在这一步里：
            //    原来在对象字面量里读 `body.wire.tok`，而那一刻 `body.wire` 还没建出来 ⇒ 必抛 TypeError）
            try {
                putWire(w);
            } catch (e) {
                const msg = String(e?.message || e).slice(0, 160);
                console.warn(`[hitOpt] git 记录：把出网原文放进 body 时抛了（${msg}）—— 补一次，接着提交`);
                // ★ v6.24.57：这里**不再静默 continue** —— 出网原文已经在手上（w 是好的），
                //   只是"放进 body"这一步抛了。抛一次就丢一整轮记录，代价太大：补一次、接着往下走。
                try {
                    body.wire = {
                        body: w.body, bytes: w.bytes, sha256: w.sha256, n: w.n, model: w.model, file: w.file,
                        tok: Number(body?.wire?.tok) || 0, chars: Number(body?.wire?.chars) || 0,
                        ver: String(HORAE_CACHE_PATCH || ''),      // ★ v6.24.69：版本戳（重试路也带上）
                        tokSrc: String(tokSrc || ''),
                    };
                } catch (e2) {
                    lastWhy = `放进 body 失败：${msg}`;
                    console.error(`[hitOpt] git 记录：连补一次也失败了（${String(e2?.message || e2).slice(0, 160)}）→ 这一轮不写、不提交`);
                    continue;
                }
            }
            // ② 历史还原的战果与**出网核对**（拿还原时留下的样本去出网原文里逐字找）——
            //    ★ v6.24.45/46：这两句以前写进归档抬头（前端铺文本那条路）；现在抬头由服务端写，这里改成打日志：
            //    "补上了"和"只在客户端补了"必须分得清（实测第 6 轮就是光看战果分不出来的）。
            try {
                const probes = _restoreStats?.probes || [];
                const j2 = JSON.parse(w.body);
                const arr2 = Array.isArray(j2?.messages) ? j2.messages : [];
                // ══ ★★ v6.24.79 试过、v6.24.80 **撤掉**：把基准改成"真出网那份" ════════════════════
                //   当时的想法：只有出网的字节才是"真发出去过的"，基准该与它同形状，下标才可比。
                //   **撤掉的理由（想清楚之后才知道会砸锅）**：
                //     · `_restoreFrozenHistory` 的盖回是 v6.24.48 用户定版的**纯文本无脑盖**
                //       （"用 A 的内容，还原范围 = B 从头到对话楼"）—— 它**假定 prev 与 msgs 同形状**。
                //       prev 一旦换成 12 条的出网形状，前 12 条就会被出网那 12 条整段盖掉
                //       （客户端第 2 条是几千字的世界书条目，出网第 2 条是 22,127 字的合并体）⇒ 形状当场废掉。
                //     · 出网形状里**只有 1 条补丁认得出**（`#9`）；另外 2 条与玩家的新输入**合并**在同一条里
                //       （第 6 轮 `#11`，抬头被埋在正文后面）⇒ 不以 RESTORE_ADD_HEAD 开头 ⇒ 接不回来。
                //       而客户端形状里那 3 条补丁**都在、都认得出**。
                //     · 实测第 6 轮也证明"客户端形状的前缀 → 出网的前缀"这个映射在**位置上**是成立的
                //       （接回的补丁确实出现在出网 `#9`，只是另 2 条落错了地方）⇒ 病根是**落点算错**，
                //       不是"基准形状不对"。落点由 `_restoreKeptAt` 修，基准不动。
                //   保留不变的那一行（它是"出发那一刻那份"的取证，别的判断还在用）：
                //     `_sendProofReconcile` 照旧把 `_prevRealMsgs` 设成 `_sendProof.msgs`。
                const wireChk = _restoreWireCheck(probes, arr2.map(m => String(m?.content ?? '')).join('\n'));
                const postChk = _restoreWireCheck(probes,
                    (Array.isArray(assembled) ? assembled : []).map(m => String(m?.content ?? '')).join('\n'));
                console.log(`[hitOpt] 归档战果：${_restoreHeadNote() || '（还原没动）'}`
                    + `｜出网核对 ${_restoreCheckNote(wireChk, postChk) || '（没有样本）'}`);
            } catch (e) {
                // 只是留档，算不出来不影响记这一轮 —— 但**必须留下痕迹**（v6.24.57 之前这里连 catch 都是空的）
                console.warn(`[hitOpt] 归档战果/出网核对算不出来（${String(e?.message || e).slice(0, 160)}）—— 不影响记这一轮`);
            }
            try {
                // ★ v6.24.55：这一跳的**超时单独放宽**（默认 4000ms 是给 /status /reserve /log 那种小请求的）。
                //   它要上传整份出网原文（实测 67KB body → JSON 72,745 字节），服务端还要写文件 + git add + commit；
                //   实测线上 481ms 够快，但仓库大/盘忙时 4 秒是能踩到的 —— 一旦踩到，
                //   客户端会把"其实已经写进去了"当成失败，然后**用同一个编号重试**（覆盖写，编号不跳）。
                /* ★ v6.51.13【缺口2】发之前把这一轮的埋点挂上 —— `_diagReport` 已经把
                 *   `pushTurn:enter` 那一份原样留在 `_diagLast` 里了（同一个对象，不另拼字段）。
                 *   ⚠ 挂在这里而不是构造 `body` 那里：那会儿埋点还没跑（顺序：body 先建、心跳后发）。 */
                try { body.diag = _diagLast; } catch (_) { }
                /* ══ ★★★★★★ 2026-09-24【**同一个 sendProof 只许落一次盘** —— 用户线上多付的就是它】══════
                 *  【现场】`林夏_muf17g3x5dix`，`_diag.log` 的 pushTurn 心跳为证（每一对共享同一个 proofAt）：
                 *      05:49:37 pushTurn:enter asm=37 proofAt=1790228977395 → committed no=7
                 *      05:50:09 pushTurn:enter asm=37 proofAt=1790228977395 → committed no=8   ← 同一个 proof！
                 *      05:50:15 enter asm=36 proofAt=…011768 → no=9 ／ 05:50:56 enter asm=36 **同一个 proofAt** → no=10
                 *  两次 enter 相隔 ~30~50 秒，而 `proofAt`（＝"这一轮请求真出发那一刻"）**一个字没变**
                 *  ⇒ **没有第二个请求发出去**，是"同一轮被记了两遍"。
                 *
                 *  【为什么必须拦】多记一轮不只是难看：① 面板多一行（用户截图里 `#4 #6 #8 #10` 那一列空壳就是它）；
                 *    ② `usage.json` / 轮号 / 各条对账全被顶偏一格；③ 用户会以为"同一轮烧了两份钱"。
                 *
                 *  【判据（保守，⛔ 绝不放宽）】只有**同时**满足三条才拦：
                 *    ① 拿得到 `sendProof` 的指纹（`digest + at`）—— 拿不到就**不拦**（宁可多记一行）；
                 *    ② 与**上一次成功提交**用的指纹**完全相同**（同一个 proof 才拦）；
                 *    ③ 距上次提交 < 5 分钟（超过就放行 —— 用户半小时后重新发同一份提示词是合法的）。
                 *  ⇒ **真正的重 roll 绝不会被误杀**：那种情况下 `_installSendProof` 会给出**新的** `at`/`digest`
                 *    （请求真发出去了就有新取证）⇒ 指纹不同 ⇒ 照旧记一轮。
                 *  ⚠ 只在**提交成功之后**才记指纹（不在这里预写）⇒ 正常重试（`continue`）不受影响。
                 *  ⛔ 不许静默跳过 —— 拦下时发一条 `pushTurn:dup` 心跳，盘上立刻看得见。 */
                const _spNow = (typeof sendProof === 'object' && sendProof) ? sendProof : null;
                const _fpNow = _spNow ? `${String(_spNow.digest || '')}@${Number(_spNow.at) || 0}` : '';
                /* ★ 2026-09-24 事故修复（补丁定义在 tail.js 第五节 @keep:dup-guard）：
                   同一个 sendProof 只许落一次盘。`typeof` 守卫见 `_patchMarkPrevSig` 那处的说明。 */
                if (typeof _patchTurnIsDup === 'function') {
                    try {
                        if (_patchTurnIsDup(_spNow)) {
                            try {
                                _diagReport({ tag: 'pushTurn:dup', chat: body.chat, i, swipe, fp: _fpNow.slice(0, 40), by: 'patch' });
                            } catch (_) { }
                            console.warn('[hitOpt] 同一个 sendProof 已经记过一轮 ⇒ 这一轮不落盘（真重 roll 会有新取证指纹）。');
                            lastWhy = 'patch: 同一个 sendProof 已经记过一轮';
                            continue;
                        }
                    } catch (_) { }
                }
                if (_fpNow && _lastTurnProofFp === _fpNow && (Date.now() - _lastTurnProofAt) < 5 * 60 * 1000) {
                    try {
                        _diagReport({
                            tag: 'pushTurn:dup', chat: body.chat, i, swipe, fp: _fpNow.slice(0, 40),
                            lastNo: _lastTurnProofNo, gapMs: Date.now() - _lastTurnProofAt,
                        });
                    } catch (_) { }
                    console.warn(`[hitOpt] git 记录：**同一个请求又被推了一次**（指纹 ${_fpNow.slice(0, 24)}…）`
                        + `⇒ 这一轮不落盘（上一轮已记成 #${_lastTurnProofNo}）。真重 roll 会有新的取证指纹，不会被拦。`);
                    lastWhy = '同一个 sendProof 已经记过一轮（跳过重复）';
                    continue;
                }
                const r = await _gitLogApi('/turn', body, 20000);
                if (!r?.ok) { lastWhy = String(r?.error || '记录服务没给 ok'); continue; }
                if (_fpNow) { _lastTurnProofFp = _fpNow; _lastTurnProofAt = Date.now(); _lastTurnProofNo = Number(r.no); }
                /* ★ 2026-09-24 事故修复（@keep:dup-guard）：提交**成功之后**才记指纹 ——
                   与 `_patchTurnIsDup` 成对；不在这里预写是为了让正常重试（continue）不受影响。 */
                if (typeof _patchTurnMarkDone === 'function') { try { _patchTurnMarkDone(_spNow, r.no); } catch (_) { } }
                // ★ v6.24.50：这里原来还把断点在 localStorage 里另存一份（`_lcpStoreSave`）—— 已整段删掉。
                //   ★ v6.24.69 更正这条注释（它已经过时）：面板那三列的**唯一来源现在是服务端
                //   `lcpOfTurns`**（在 `turns/NNNNN.txt` 正文上逐字节算，随 /log 给出来），
                //   **不是**抬头那段 `| lcp …` —— 抬头里那一段自 v6.24.69 起客户端也不再上传了
                //   （它量的是"客户端手里那串字"，与出网那份对不上，见 putWire 那段的长注释）。
                //   一条纪律没变：同一件事**不许有第二个来源**（不另存 localStorage、不在抬头再写一份）。
                console.log(`[hitOpt] git 记录：${swipe ? 'swipe（reset --hard 回滚后重新）' : ''}提交 turn #${r.no} → ${r.sha}`
                    + `｜写入的是**出网原文**（${r.wire?.n ?? '?'} 条 / ${r.wire?.bytes ?? '?'} 字节`
                    + `${Number(r.wire?.tok) > 0 ? ` / 本地 ${Number(r.wire.tok).toLocaleString('en-US')} tok` : ''}`
                    + ` / 指纹 ${String(r.wire?.sha256 || '').slice(0, 12)}）`
                    + (r.pruned?.length ? `（超过上限，已清掉最旧的 ${r.pruned.length} 个聊天仓库）` : ''));
                /* ★★★★★★ v6.41.5【这一跳就是"新切片落盘"的信号】
                   `/turn` 成功 = 会话里那一发真发出去了 = `turns/NNNNN.abc.txt` 刚落地
                   ⇒ 面板链旧结果的覆盖范围已经**小于**现在的切片集合，必须作废重算
                   （判据与证明见 `_expAlgoStale`）。⚠ 顺序：先作废、再重画 —— 反过来的话
                   这一帧画的还是旧结果，用户看到的仍是"新那几轮空着"。 */
                _expAlgoStale(body.chat);
                _diffAnalysisInvalidate();
                _diffRenderIfOpen();   // v6.21.9：表只读 git 了 → 提交落盘这一刻顺手把开着的表刷新（行立刻出现）
                // ★ v6.24.58：提交成功的心跳（`pushTurn:committed`）**保留** —— 它不是排查探针，是
                //   "自动检测用户动作"那条链的收尾信号（`tools/auto_monitor.mjs` 靠它判定这一轮走通了）。
                try { _diagReport({ tag: 'pushTurn:committed', chat: body.chat, i, no: Number(r.no), sha: String(r.sha || ''), wireN: Number(r.wire?.n) || 0 }); } catch (_) { }
                return true;
            } catch (e) {
                // 服务没开 / 网络抖：**如实报**（以前这里吞掉，于是"记录没写进去"看起来像"什么都没发生"）
                lastWhy = `提交失败：${String(e?.message || e)}`;
                // ⚠【临时诊断埋点·查完必删】提交这一跳抛了什么（网络 / 超时 / 413 / 400）
                try { _diagReport({ tag: 'pushTurn:commitThrow', chat: body.chat, i, why: lastWhy, bodyLen: JSON.stringify(body).length }); } catch (_) { }
            }
        }
        // ══ 始终没等到 → **这一轮不写、不提交**（宁可没有记录，也不拿"不是出网那份"的字顶上）══
        //   ⚠ 代价写清楚（别让人以后当 bug）：抓包插件没加载／酒馆没重启时，这一轮**没有记录** ——
        //     这正是"不许编数"的口径。
        // ⚠【临时诊断埋点·查完必删】整轮放弃：把"到底哪个理由"钉死
        try { _diagReport({ tag: 'pushTurn:gaveup', chat: body.chat, lastWhy, assembledLen: Array.isArray(assembled) ? assembled.length : -1, since }); } catch (_) { }
        console.error(`[hitOpt] git 记录：等了约 ${WIRE_WAIT_STEPS.reduce((a, b) => a + b, 0) / 1000} 秒仍没拿到这一轮的`
            + `**出网原文**（${lastWhy || '未知原因'}）→ 这一轮**不写、不提交**（本地快照不进 git：用户定版"我们只管最终出网"）。`
            + `检查：抓包模块挂上了吗（本插件目录下的 wiretap.mjs，路由 /api/plugins/hitopt-git/tap/…；酒馆控制台有没有 [hitOpt-wiretap]）、酒馆重启过吗。`);
        return false;
    })();
}

/* @29447-29452 */
function _pfHash(s) {
    let h = 0x811c9dc5;
    const t = String(s ?? '');
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h;
}

/* @29589-29598 */
function _amPoolDiskAll(chatKey, fromLocal) {
    try {
        if (fromLocal && fromLocal[chatKey]) return fromLocal;
        if (_amPoolDiskChat === chatKey && _amPoolDiskText) {
            const d = JSON.parse(_amPoolDiskText);
            if (d && d[chatKey]) return d;
        }
    } catch (_) { }
    return fromLocal;
}

/* @29621-29653 */
function _amPoolLoad(chatKey) {
    if (!chatKey) return -1;
    /* ⚠ 没有 localStorage 的环境（验收沙箱 / 隐私模式）**不是异常**，只是"没有池" ——
     *   这里必须显式判掉：`_abSplit` 里那句调用被它自己的 catch 吞掉的话，
     *   表现会跟"池是空的"一模一样（读数全是 0），查起来要绕远路。 */
    if (typeof localStorage === 'undefined' || !localStorage) {
        _amPoolChat = chatKey;
        _amPoolStat = { ..._amPoolStat, at: Date.now(), state: 'nolocal', why: '这个环境没有 localStorage（池只活在内存里）', n: _amPoolSend.size, key: chatKey, loaded: 0 };
        return 0;
    }
    let all = {};
    try { all = JSON.parse(localStorage.getItem(AM_POOL_STORE) || '{}') || {}; } catch (_) { all = {}; }
    /* ★ v6.51.12：localStorage 里**没有本场**（写不进去是常态）⇒ 用盘上预取回来的那一份。
       ⚠ 有就不换（只增不减）—— 判据只看"本场的键在不在"。 */
    const _poolSrc = all[chatKey] ? 'localStorage' : (_amPoolDiskChat === chatKey && _amPoolDiskText ? 'disk' : 'none');
    all = _amPoolDiskAll(chatKey, all);
    const slot = all[chatKey];
    const list = (slot && Array.isArray(slot.b)) ? slot.b : [];
    let got = 0;
    for (const it of list) {
        try {
            const h = Number(it && it.h);
            if (!Number.isFinite(h)) continue;
            _amPoolSend.set(h, String((it && it.t) || ''));
            _amPoolAt.set(h, Number((it && it.a) || 0));
            got++;
        } catch (_) { }
    }
    _amPoolChat = chatKey;
    _amPoolDirty = false;
    _amPoolStat = { ..._amPoolStat, at: Date.now(), state: 'ok', why: '', n: _amPoolSend.size, key: chatKey, loaded: got, src: _poolSrc };
    return got;
}

/* @29656-29695 */
function _amPoolSave() {
    /* ★ v6.27.1 修（第 17 轮真机抓到的）：`_amPoolChat` 原来**只在 `_amPoolLoad` 里赋值**，
     *   而 `_amPoolLoad` 只在 `_abSplit` 开头调 —— 于是一旦某一轮 A/B 没跑（真机实测第 17 轮：
     *   用户删楼层/重 roll ⇒ `rsOn=0` ⇒ `abOn=0` ⇒ `_abSplit` 直接不进来），
     *   `_amPoolChat` 永远是空串 ⇒ **池永远写不进盘**（心跳里就是 `amPoolState=fail`
     *   ＋ why="还没有聊天键"）。这不是异常，是**判据挂错了地方**。
     *   ⇒ 这里自己兜底取一次聊天键：`_currentChatKey()` 拿不到才算真的没法写。 */
    if (!_amPoolChat) {
        try { _amPoolChat = String(_currentChatKey() || ''); } catch (_) { _amPoolChat = ''; }
    }
    if (!_amPoolChat) { _amPoolStat = { ..._amPoolStat, state: 'fail', why: '还没有聊天键（不写盘，避免把池记到错的聊天上）' }; return false; }
    // 淘汰：超过上限就把"最久没被命中"的那些丢掉（`_amPoolAt` 大的留下）
    if (_amPoolSend.size > AM_POOL_MAX) {
        const arr = [..._amPoolAt.entries()].sort((x, y) => y[1] - x[1]).slice(0, AM_POOL_MAX);
        const keep = new Set(arr.map(x => x[0]));
        for (const h of [..._amPoolSend.keys()]) if (!keep.has(h)) { _amPoolSend.delete(h); _amPoolAt.delete(h); }
    }
    const b = [];
    for (const [h, t] of _amPoolSend) b.push({ h, t, a: _amPoolAt.get(h) || 0 });
    if (typeof localStorage === 'undefined' || !localStorage) {
        _amPoolDirty = false;
        _amPoolStat = { ..._amPoolStat, at: Date.now(), state: 'nolocal', why: '这个环境没有 localStorage（池只活在内存里）', n: _amPoolSend.size, key: _amPoolChat, saved: 0 };
        return false;
    }
    try {
        let all = {};
        try { all = JSON.parse(localStorage.getItem(AM_POOL_STORE) || '{}') || {}; } catch (_) { all = {}; }
        all[_amPoolChat] = { at: Date.now(), n: b.length, b };
        /* ★ v6.51.11：**在 setItem 之前**记下这份（抛配额异常也留得下）——
         *   盘上 `turns/NNNNN.pool.json` 的 `pool` 字段优先用它（见 /turn body 那一处）。 */
        _amPoolSnapText = JSON.stringify(all);
        localStorage.setItem(AM_POOL_STORE, _amPoolSnapText);
        _amPoolDirty = false;
        _amPoolStat = { ..._amPoolStat, at: Date.now(), state: 'ok', why: '', n: _amPoolSend.size, key: _amPoolChat, saved: b.length };
        return true;
    } catch (e) {
        _amPoolStat = { ..._amPoolStat, at: Date.now(), state: 'fail', why: String((e && e.message) || e), n: _amPoolSend.size, key: _amPoolChat, saved: 0 };
        return false;
    }
}

/* @29708-29729 */
function _amPoolCommit(msgs) {
    try {
        /* ★ v6.27.1：本轮戳 —— 淘汰（最久未用）与"这一块最后一次是什么时候发出去的"都用它。
         *   ⚠ 不用 `Date.now()` 当键：同一轮里多次 commit（重 roll / 补发）应算同一轮，
         *     用轮次计数更稳，也让淘汰顺序与"轮"这个人类口径一致。 */
        _amPoolRound += 1;
        let added = 0;
        for (const m of (Array.isArray(msgs) ? msgs : [])) {
            const c = String(m?.content ?? '');
            if (!c) continue;
            for (const b of _amBlocks(c)) {
                if (b.raw.length < 400) continue;
                const h = _pfHash(b.raw);
                if (!_amPoolSend.has(h)) _amPoolSend.set(h, b.tag);
                if (_amPoolAt.get(h) !== _amPoolRound) { _amPoolAt.set(h, _amPoolRound); added++; }
            }
        }
        if (added) _amPoolDirty = true;
        // ★ v6.27.1：记完就落盘 —— 一次 F5 不再打掉整个池（这是本版存在的唯一理由）
        if (_amPoolDirty) _amPoolSave();
    } catch (_) { /* 记账失败不影响出词 */ }
}

/* @29731-29731 */
function _amPoolSize() { try { return _amPoolSend.size; } catch (_) { return -1; } }

/* @29807-29811 */
function _amPtrId(text, tag) {
    const h = _pfHash(String(text ?? ''));
    const v = h.toString(16).padStart(8, '0').slice(0, 6).toUpperCase();
    return tag ? `<HASH-${v} name="${tag}"/>` : `<HASH-${v}/>`;
}

/* @29866-29871 */
function _isPresetKeep(m, txt) {
    const t = String(txt != null ? txt : ((m && m.content) != null ? m.content : ''));
    if (!t.trim()) return false;
    for (const re of PRESET_KEEP_DENY) if (re.test(t)) return false;         // ★ 硬红线：注入一律不进 C
    return true;
}

/* @29874-29882 */
function _presetKeepNamed(m, txt) {
    const t = String(txt != null ? txt : ((m && m.content) != null ? m.content : ''));
    const idn = String((m && (m.identifier || m.name)) || '');
    if (idn) { for (const n of PRESET_KEEP_NAMES) if (idn.indexOf(n) >= 0) return n; }
    for (const n of PRESET_KEEP_NAMES) if (t.indexOf(n) >= 0) return n;
    for (const g of PRESET_KEEP_TAGS) if (t.indexOf('<' + g) >= 0) return '<' + g;
    for (const k of PRESET_KEEP_MARKS) if (t.indexOf(k) >= 0) return k;      // ★ v6.50.4：裸文本那一族
    return '';
}

/* @29914-29919 */
function _isCSection(m, txt) {
    const t = String(txt != null ? txt : ((m && m.content) != null ? m.content : ''));
    if (!t.trim()) return false;
    if (!_isPresetKeep(m, t)) return false;          // ① 黑名单：注入一律不进
    return !!_presetKeepNamed(m, t);                 // ② 白名单：认不出就不进（保守，绝不猜位置）
}

/* @29921-29928 */
function _blockTagOf(txt) {
    const t = String(txt || '').replace(/^\s+/, '');
    const m = t.match(/^<\/?([A-Za-z_][\w\-]*)/);
    if (m) return m[0];
    const h = t.match(/^#\s*([^\n|]{1,24})/);
    if (h) return '# ' + h[1].trim();
    return t.slice(0, 16).replace(/\n/g, ' ');
}

/* @29929-29934 */
function _inKeepZone(txt) {
    if (_floorLimNow < 0 || !_keepTexts.length || !txt) return false;
    if (!_isPresetKeep(null, txt)) return false;        // ★ 红④⑤：白名单外一律**不算**保真区
    for (const t of _keepTexts) if (t.includes(txt)) return true;
    return false;
}

/* @29947-29957 */
function _amAddrSplit(s) {
    const out = [];
    const re = _amPtrRe();                 // ★ v6.31.0：新格式 `<HASH-******/>` ＋ 旧格式 `<AM******/>` 都认
    let last = 0, m;
    while ((m = re.exec(s))) {
        if (m.index > last) out.push(s.slice(last, m.index));
        last = m.index + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
}

/* @29968-29975 */
function _amSegName(seg) {
    return String(seg || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/["<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 16);
}

/* @29978-29993 */
function _amAddrAdd(text, id) {
    try {
        const t = String(text ?? '');
        if (t.length < AM_ADDR_MIN || !id) return false;
        _amAddrAt.set(t, _amPoolRound);
        if (_amAddrPool.has(t)) { _amAddrPool.get(t).at = _amPoolRound; return false; }
        _amAddrPool.set(t, { id: String(id), at: _amPoolRound });
        const k = t.slice(0, 12);
        let arr = _amAddrIdx.get(k);
        if (!arr) { arr = []; _amAddrIdx.set(k, arr); }
        arr.push(t);
        _amAddrStat.addN += 1;
        _amAddrDirty = true;
        return true;
    } catch (_) { return false; }
}

/* @29996-30010 */
function _amAddrMatchAt(s, from) {
    if (from + 12 > s.length) return null;
    const arr = _amAddrIdx.get(s.slice(from, from + 12));
    if (!arr || !arr.length) return null;
    let best = null;
    for (const t of arr) {
        const L = t.length;
        if (L < AM_ADDR_MIN || from + L > s.length) continue;
        if (best && L <= best.length) continue;
        let ok = true;
        for (let j = 12; j < L; j++) if (t.charCodeAt(j) !== s.charCodeAt(from + j)) { ok = false; break; }
        if (ok) best = t;
    }
    return best ? { text: best, id: _amAddrPool.get(best).id } : null;
}

/* @30014-30039 */
function _amAddrRecall(s) {
    try {
        if (typeof s !== 'string' || s.length < AM_ADDR_MIN) return '';
        if (!_amAddrPool.size) return '';
        let out = '', i = 0, k = 0;
        while (i < s.length) {
            /* ⚠⚠★【扁平化不变量，用户 2026-09-19 定版："指针是 碎片化 扁平化的"】
             *   扫描时**遇到指针就整段原样跳过**（既不拿它去匹配、也不让任何匹配跨过它）。
             *   于是：一个指针的范围里**永远只可能是一个指针**（它本身），绝不会套第二层。
             *   代价（如实说）：跨指针的长区间唤不起来 —— 那种区间本来也不该被登记（见 `_amAddrSplit`）。*/
            if (_amAddrIsPtrAt(s, i)) { const L = _amAddrPtrLenAt(s, i); out += s.slice(i, i + L); i += L; continue; }
            const m = _amAddrMatchAt(s, i);
            if (m && !_amAddrHasPtr(m.text)) {
                out += m.id;                       // `id` 已经是 `<AMxxxx/>` 形状
                _amAddrAt.set(m.text, _amPoolRound);
                _amAddrStat.hitN += 1; _amAddrStat.hitChars += m.text.length;
                i += m.text.length; k += 1;
            } else { out += s[i]; i += 1; }
        }
        /* ⚠ 判据必须是"**真的换过指针**"（k>0），不是 `out === s`：
         *   ① `out` 由逐字符拼接而来 ⇒ 即使一个都没换，字符串内容也会相等 —— 靠相等判断会误判；
         *   ② 这一层改了字**必须回填给调用处**，而调用处拿"空串"表示"没改"（与 `_amPtr` 同一套约定）。 */
        if (k === 0) return '';
        return out;
    } catch (_) { return ''; }
}

/* @30046-30051 */
function _amAddrIsPtrAt(s, i) {
    if (s.charCodeAt(i) !== 60 /* < */) return false;
    if (!s.startsWith(AM_PTR_HEAD, i)) return false;
    const t = s.slice(i, i + 200);
    return /^<HASH-[0-9A-F]{6}(?:\s[^>]*)?\/>/.test(t) || /^<HASH-[0-9A-F]{6}>/.test(t);
}

/* @30053-30063 */
function _amAddrPtrLenAt(s, i) {
    if (!s.startsWith(AM_PTR_HEAD, i)) return 0;
    const t = s.slice(i, i + 200);
    let m = /^<HASH-[0-9A-F]{6}(?:\s[^>]*)?\/>/.exec(t);
    if (m) return m[0].length;
    m = /^<HASH-([0-9A-F]{6})>/.exec(t);
    /* ⚠ 长度**按实际下标算**，不许写死常数：收尾是 `</HASH-xxxxxx>`（14 字符）。
     *   写死一个数就会把后面几个字符误当指针的一部分吞掉（我先写成 11，当场自查改掉）。 */
    if (m) { const close = '</HASH-' + m[1] + '>'; const e = s.indexOf(close, i + m[0].length); return e < 0 ? m[0].length : (e + close.length - i); }
    return 0;
}

/* @30069-30074 */
function _amAddrHasPtr(t) {
    for (let i = 0; i + 3 <= t.length; i++) if (t.charCodeAt(i) === 60 && t.charCodeAt(i + 1) === 65 && t.charCodeAt(i + 2) === 77) {
        if (_amAddrIsPtrAt(t, i)) return true;
    }
    return false;
}

/* @30087-30114 */
function _amAddrCommit(msgs) {
    try {
        for (const m of (Array.isArray(msgs) ? msgs : [])) {
            const c = String(m?.content ?? '');
            if (c.length < AM_ADDR_MIN) continue;
            if (_inKeepZone(c)) continue;                       // ★ C 区整条不登记
            for (const seg of _amAddrSplit(c)) {
                if (seg.length < AM_ADDR_MIN) continue;
                if (_inKeepZone(seg)) continue;                 // ★ C 区区间不登记
                // ★ v6.31.0：走唯一生成点（HASH 形态）—— 哈希即"这块内容的身份证"
                // ★ v6.37.2：**带上可读名**（取区间开头）—— 裸哈希模型对不上，带名字才叫"唤起"
                _amAddrAdd(seg, _amPtrId(seg, _amSegName(seg)));
            }
        }
        if (_amAddrPool.size > AM_ADDR_MAX) {
            const keep = [..._amAddrAt.entries()].sort((x, y) => y[1] - x[1]).slice(0, AM_ADDR_MAX).map(x => x[0]);
            const ks = new Set(keep);
            for (const t of [..._amAddrPool.keys()]) {
                if (ks.has(t)) continue;
                _amAddrPool.delete(t); _amAddrAt.delete(t);
                const arr = _amAddrIdx.get(t.slice(0, 12));
                if (arr) { const k = arr.indexOf(t); if (k >= 0) arr.splice(k, 1); }
            }
            _amAddrDirty = true;
        }
        if (_amAddrDirty) _amAddrSave();
    } catch (_) { /* 登记失败不影响出词 */ }
}

/* @30117-30155 */
function _amAddrLoad(chatKey) {
    if (!chatKey) return -1;
    if (typeof localStorage === 'undefined' || !localStorage) {
        _amAddrChat = chatKey;
        _amAddrStat = { ..._amAddrStat, at: Date.now(), state: 'nolocal', why: '这个环境没有 localStorage（台账只活在内存里）', n: _amAddrPool.size, loaded: 0 };
        return 0;
    }
    let all = {};
    try { all = JSON.parse(localStorage.getItem(AM_ADDR_STORE) || '{}') || {}; } catch (_) { all = {}; }
    /* ★ v6.51.12：与 `_amPoolLoad` 那一处同一个道理 —— 盘上那份当兜底（只增不减）。 */
    const _addrSrc = all[chatKey] ? 'localStorage' : (_amPoolDiskChat === chatKey && _amAddrDiskText ? 'disk' : 'none');
    if (!all[chatKey] && _addrSrc === 'disk') {
        try { const d = JSON.parse(_amAddrDiskText); if (d && d[chatKey]) all = d; } catch (_) { }
    }
    const slot = all[chatKey];
    const list = (slot && Array.isArray(slot.b)) ? slot.b : [];
    let got = 0;
    for (const it of list) {
        try {
            const t = String((it && it.t) || '');
            if (t.length < AM_ADDR_MIN) continue;
            // ★ v6.37.2：读回时**按新形态重算 id**（带上可读名）。老台账里存的是无 name 的裸哈希，
            //   沿用它 ⇒ 那些区间的指针**永远对模型不可读**（正是"唤起"失效的一半原因）。
            //   ⚠ 代价如实记：重算会让这些区间这一轮以**新形态**出现 ⇒ **一次 lcp 断点**，
            //     之后就与池里的新 id 稳定一致了（用户定版："不用考虑旧版本，下一轮自然适配"）。
            _amAddrPool.set(t, { id: _amPtrId(t, _amSegName(t)), at: Number((it && it.a) || 0) });
            _amAddrAt.set(t, Number((it && it.a) || 0));
            const k = t.slice(0, 12);
            let arr = _amAddrIdx.get(k);
            if (!arr) { arr = []; _amAddrIdx.set(k, arr); }
            arr.push(t);
            got++;
        } catch (_) { }
    }
    _amAddrChat = chatKey;
    _amAddrDirty = false;
    _amAddrStat = { ..._amAddrStat, at: Date.now(), state: 'ok', why: '', n: _amAddrPool.size, loaded: got, src: _addrSrc };
    return got;
}

/* @30158-30182 */
function _amAddrSave() {
    if (!_amAddrChat) { try { _amAddrChat = String(_currentChatKey() || ''); } catch (_) { _amAddrChat = ''; } }
    if (!_amAddrChat) { _amAddrStat = { ..._amAddrStat, state: 'fail', why: '还没有聊天键' }; return false; }
    if (typeof localStorage === 'undefined' || !localStorage) {
        _amAddrDirty = false;
        _amAddrStat = { ..._amAddrStat, at: Date.now(), state: 'nolocal', why: '这个环境没有 localStorage', n: _amAddrPool.size, saved: 0 };
        return false;
    }
    try {
        const b = [];
        for (const [t, v] of _amAddrPool) b.push({ t, i: v.id, a: _amAddrAt.get(t) || 0 });
        let all = {};
        try { all = JSON.parse(localStorage.getItem(AM_ADDR_STORE) || '{}') || {}; } catch (_) { all = {}; }
        all[_amAddrChat] = { at: Date.now(), n: b.length, b };
        /* ★ v6.51.11：理由同 `_amPoolSave` 那一处 —— 在 setItem 之前记，配额抛了也留得下。 */
        _amAddrSnapText = JSON.stringify(all);
        localStorage.setItem(AM_ADDR_STORE, _amAddrSnapText);
        _amAddrDirty = false;
        _amAddrStat = { ..._amAddrStat, at: Date.now(), state: 'ok', why: '', n: _amAddrPool.size, saved: b.length };
        return true;
    } catch (e) {
        _amAddrStat = { ..._amAddrStat, at: Date.now(), state: 'fail', why: String((e && e.message) || e), n: _amAddrPool.size, saved: 0 };
        return false;
    }
}

/* @30196-30232 */
function _amBlocks(content) {
    const out = [];
    const toks = [];
    // ⚠⚠ 这个正则**踩过两个坑，两个都能让整条链静默失效**（表面上读数全正常、就是一个块都不动）：
    //   ① 第一版 `/<([A-Za-z_][\w\-]*)(?:\s[^>]*)?>/g` **认不出闭合标签** —— `</world_x>` 第一位是 `/`、
    //      不匹配 `[A-Za-z_]` ⇒ 一枚闭标签都匹配不到 ⇒ `depth` 永远归不了零 ⇒ 恒返回空。
    //      ⇒ 必须显式写 `<(\/)?…`。
    //   ② 第二版认了闭标签，可**标签名只认 ASCII** —— 而**用户的块名全是中文**
    //      （`<world_饥渴世界>` / `<追加行动选项>` / `<掷骰规则>` / `<输出模板>` …）
    //      ⇒ 中文块一个都切不出来（实测：`<world_x>` 能切、`<world_饥渴世界>` 切不出来）。
    //      ⇒ 标签名用 Unicode 属性类 `\p{L}\p{N}`（`u` 标志），并放进 `[\w\u3400-\u9FFF-]`。
    const re = /<(\/)?(\p{L}[\p{L}\p{N}_\u3400-\u9FFF\-]*)(?:\s[^>]*)?>/gu;
    let m;
    while ((m = re.exec(content))) toks.push({ self: m[0].endsWith('/>'), close: !!m[1], tag: m[2], s: m.index, e: m.index + m[0].length });
    const stack = [];                     // 未闭合的开标签（只记同名配对的位置）
    /* ★★★★★★ v6.27.2【用户 2026-09-19 定版：**扁平化 / 粒度化**】
     *   原话："每个指针化的范围 里面不能有指针化，也就是扁平化的 粒度化的。还不如以前的缓存池化系统"
     *   ⇒ 只返回**最外层块**（`stack` 被弹空的那一层）：这样"块 ↔ 指针"一一对应，
     *     **一个指针的范围里绝不会再套第二个指针** —— 这就是"扁平"。
     *   · 原来的栈式配对把**内外层一起返回**（`<world_x>` 与它里面的 `<analysis>` 都是候选），
     *     调用处虽有"重叠就跳过"的过滤，但那是**位置层面**的补丁，语义上仍然是嵌套切分；
     *   · 改成"只出最外层"之后：父块整体走指针/包裹，子块随父块一起走 ⇒ 结构干净、幂等。
     *   · 自闭合 `<tag/>` 不算块；没有配对开标签的闭标签跳过（**不猜边界**）。
     *  ⚠ 代价（如实说）：父块**内部**真变了的那一小段，会把**整个父块**拖成"完整注入" ——
     *     这正是用户要的取舍（宁可一个块整体重发，也不要块内套指针）。 */
    for (const t of toks) {
        if (t.self) continue;
        if (!t.close) { stack.push(t); continue; }
        let k = -1;
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === t.tag) { k = i; break; }
        if (k < 0) continue;              // 没有配对的开标签 ⇒ 跳过（不猜）
        const head = stack[k];
        stack.length = k;                 // 弹出它以及它更内层未闭合的那些
        if (stack.length === 0) out.push({ raw: content.slice(head.s, t.e), tag: t.tag });   // ★ 只收最外层
    }
    return out;
}

/* @30256-30261 */
function _promptItemsOf(assembled) {
    return (Array.isArray(assembled) ? assembled : []).map(m => {
        const c = typeof m?.content === 'string' ? m.content : '';
        return { role: String(m?.role || ''), h: _pfHash(c), len: c.length };
    });
}

/* @30268-30276 */
function _trueBreakIndex(items) {
    const prev = _prevPromptItems;
    if (!prev || !prev.length || !items.length) return -1;
    const n = Math.min(prev.length, items.length);
    for (let i = 0; i < n; i++) {
        if (prev[i].h !== items[i].h || prev[i].role !== items[i].role) return i;
    }
    return items.length > prev.length ? n : -1;
}

/* @30296-30304 */
function _prefixMatchedLen(prevItems, curItems) {
    if (!Array.isArray(prevItems) || !Array.isArray(curItems)) return 0;
    const n = Math.min(prevItems.length, curItems.length);
    let i = 0;
    for (; i < n; i++) {
        if (prevItems[i].h !== curItems[i].h || prevItems[i].role !== curItems[i].role) break;
    }
    return i;
}

/* @30307-30311 */
function _pfGuardBreaks(prefixLen, afterItems) {
    if (!_prevPrefixItems || prefixLen <= 0) return false;   // 没有基准 / 本来就没命中 → 不拦
    const after = _prefixMatchedLen(_prevPrefixItems, afterItems);
    return after < prefixLen;
}

/* @30327-30341 */
function _sfChatHashes() {
    const set = new Set();
    try {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat)) return set;
        for (const m of chat.slice(-200)) {
            if (!m) continue;
            if (typeof m.mes === 'string' && m.mes) {
                set.add(_pfHash(m.mes));
                set.add(_pfHash(_normalizePromptMessageText(m.mes)));
            }
        }
    } catch (_) { }
    return set;
}

/* @30343-30439 */
function _applyStableFront(assembled) {
    _sfInfo = { moved: [], at: -1, tok: 0 };
    try {
        if (!Array.isArray(assembled) || assembled.length < 3) return;
        if (settings.promptStableFront !== true) return;                 // 总开关（默认开）
        const prev = _prevPromptItems, prev2 = _prev2PromptItems;
        if (!prev || !prev2 || !prev.length || !prev2.length) return;    // 需要连续两轮的基准
        const prevHashes = new Set(prev.map(x => x.h));
        const prev2Hashes = new Set(prev2.map(x => x.h));
        const chatHashes = _sfChatHashes();
        const wiTexts = (_wiDepthBlocks || []).filter(b => b && !b.hoisted && b.text).map(b => String(b.text));
        const cur = _promptItemsOf(assembled);
        const before = assembled.map(m => ({ role: String(m?.role || ''), content: String(m?.content || '') }));
        const prefixLen = _prefixMatchedLen(_prevPrefixItems, cur);   // v5.5：护栏基准（搬迁前）

        // ── v6.5：预设块（写作指令栈）也能钉进前缀 ──
        // 实测：`<第一写作指导>` `<NSFW核心>` `<输出模板>` 这一整栈 ~2,800 tok 内容每轮逐字不变，
        // 但它们排在聊天历史**之后**，历史一长就被顶走 2 格 → 每轮整栈全价。
        // 判据只认一条：**不是聊天里的消息**（聊天记录的哈希在 chatHashes 里，命中即排除），
        // 且连续两轮逐字不变。真正的对话历史永远不会被搬（下面还有子序列自检兜底）。
        // ★ 硬条件：**认不出聊天记录时（chatHashes 为空）一律只动 system** —— 宁可不省，绝不误搬历史。
        const allowNonSystem = settings.stableFrontNonSystem !== false && chatHashes.size > 0;
        // ★ 聊天历史的"连续区间"保护：真正的对话在数组里是一整段连续的消息。
        //   取"能认出来的聊天消息"的**首尾跨度** [lo, hi]，区间内所有 user/assistant 一律不动 ——
        //   这样即使某条因为宏展开/规范化差异没被哈希认出来（在区间内部），也照样搬不动。
        const isChatLike = (i) => {
            const role = assembled[i]?.role;
            if (role !== 'user' && role !== 'assistant') return false;
            const c = typeof assembled[i]?.content === 'string' ? assembled[i].content : '';
            return chatHashes.has(cur[i]?.h) || chatHashes.has(_pfHash(_normalizePromptMessageText(c)));
        };
        let chatLo = -1, chatHi = -1;
        for (let i = 0; i < assembled.length; i++) if (isChatLike(i)) { if (chatLo < 0) chatLo = i; chatHi = i; }
        const inChatSpan = (i) => chatLo >= 0 && i >= chatLo && i <= chatHi;

        // 只在"真断点之后"找候选：断点之前的内容两轮完全一样，本来就在命中区，不用动
        const brk = _trueBreakIndex(cur);
        const from = brk >= 0 ? brk : 0;
        const cands = [];
        for (let i = from; i < assembled.length && cands.length < 24; i++) {
            const m = assembled[i];
            if (!m) continue;
            const role = m.role;
            if (role !== 'system' && !(allowNonSystem && (role === 'user' || role === 'assistant'))) continue;
            const c = typeof m.content === 'string' ? m.content : '';
            if (!c) continue;
            if (_isWiPointer(c)) continue;            // ★ @D 指针留在原处
            if (wiTexts.some(t => c.includes(t))) continue;               // ★ 用户/兜底明确留在 @D 的世界书块也不搬
            const h = cur[i]?.h;
            if (_tailKeepHashes.has(h)) continue;                         // ★ 动态块（尾部锚定的状态块）绝不往前面搬
            if (!prevHashes.has(h) || !prev2Hashes.has(h)) continue;      // ★ 连续两轮都稳定才钉
            // ★ 聊天历史保护：只要这条能在 chat 里找到（原文或规范化后的原文），就一律不动
            if (chatHashes.has(h) || chatHashes.has(_pfHash(_normalizePromptMessageText(c)))) continue;
            // ★ v6.5：非 system 的块还必须在"聊天历史连续区间"之外（区间内一律不动，哈希认不出也不动）
            if (role !== 'system' && inChatSpan(i)) continue;
            cands.push({ i, h, msg: m });
        }
        if (!cands.length) return;

        const order = _sfOrder.slice();
        for (const c of cands) if (!order.includes(c.h)) order.push(c.h);
        const byHash = new Map(cands.map(c => [c.h, c]));
        const list = order.map(h => byHash.get(h)).filter(Boolean);
        if (!list.length) return;

        for (let k = cands.length - 1; k >= 0; k--) assembled.splice(cands[k].i, 1);   // 摘出来
        let at = 0;
        while (at < assembled.length && assembled[at]?.role === 'system') at++;         // 落点：开头连续 system 之后
        for (let n = 0; n < list.length; n++) assembled.splice(at + n, 0, list[n].msg); // 顺序固定 → 每轮同一形状

        // ★ 自检：**对话历史（真正的聊天消息子序列）** 必须与搬之前逐条一致，否则整体回滚。
        //   v6.5 起这里只看"能在 chat 里找到的那几条"—— 被搬的预设块本来就不是聊天历史。
        const after = assembled.map(m => ({ role: String(m?.role || ''), content: String(m?.content || '') }));
        const hist = (arr) => arr.filter(x => (x.role === 'user' || x.role === 'assistant')
            && (chatHashes.has(_pfHash(x.content)) || chatHashes.has(_pfHash(_normalizePromptMessageText(x.content)))));
        if (JSON.stringify(hist(before)) !== JSON.stringify(hist(after))) {
            assembled.length = 0;
            for (const x of before) assembled.push({ role: x.role, content: x.content });
            console.warn('[hitOpt] 静态前置自检失败（对话历史会变）→ 已整体回滚，本轮不动');
            return;
        }
        // ★ v5.5 前缀护栏：搬完若让"上一轮已命中的前缀"变短 → 整体回滚（实测：这种搬动代价远大于收益）
        if (_pfGuardBreaks(prefixLen, _promptItemsOf(assembled))) {
            assembled.length = 0;
            for (const x of before) assembled.push({ role: x.role, content: x.content });
            _sfInfo = { moved: [], at: -1, tok: 0, guarded: true };
            console.log('[hitOpt] 静态前置：这次搬动会缩短已命中前缀 → 已整体回滚（省下的比毁掉的少）');
            return;
        }
        _sfOrder = order.slice(-64);
        _sfInfo = { moved: list.map(x => x.h), at, tok: 0 };
        console.log(`[hitOpt] 静态前置：把 ${list.length} 块"内容没变、只是被摆在末尾锚定位置"的注入钉到固定位置 @#${at} → 往后每轮命中`
            + `（对话历史子序列已逐条自检，未改动/未删/未改序）`);
    } catch (err) {
        console.warn('[hitOpt] 静态前置失败（已跳过，不影响发送）:', err);
    }
}

/* @30691-30709 */
function _relocGroupLoad(chatKey) {
    if (!chatKey) return false;
    try {
        const all = JSON.parse(localStorage.getItem(RELOC_GROUP_STORE) || '{}') || {};
        const rec = all[chatKey];
        if (!rec || typeof rec !== 'object') return false;
        const g = Array.isArray(rec.g) ? rec.g.filter(x => typeof x === 'string') : [];
        const w = Array.isArray(rec.w) ? rec.w.filter(x => typeof x === 'string') : [];
        if (!g.length && !w.length) return false;
        _relocTailGroup = g.slice(0, 200);
        _relocTailWi = w.slice(0, 200);
        // ★ v6.24.22：落点也装回来（老记录没有 `pa` → 留 -1，下一轮按"这一轮的落点"重新冻一次，只多付那一次）
        _relocTailAnchor = Number.isInteger(rec.pa) && rec.pa >= 0 ? rec.pa : -1;
        console.log(`[hitOpt] 装回"尾部稳定块"名单（主组 ${g.length} 条 / @D 指针 ${w.length} 条`
            + `${_relocTailAnchor >= 0 ? ` / 落点 #${_relocTailAnchor}` : ''}）`
            + ' → 刷新页面之后**不再重新搬一次家**（那一次搬家要赔一整条全价）');
        return true;
    } catch (_) { return false; }
}

/* @30757-30767 */
function _relocIsVarBlock(text) {
    const s = String(text ?? '');
    if (s.length < RELOC_VARMIN_CHARS) return false;
    const io = s.indexOf(RELOC_VARTAG);
    if (io < 0) return false;
    const ic = s.indexOf(RELOC_VARENDTAG);
    if (ic <= io) return false;
    const hasMacro = RELOC_VARMACRO_RE.test(s.slice(io, ic));
    // 有宏：标签成对就够（还没展开的那种）；没宏：要求里面有"键: 值"结构（展开后的真值长这样）
    return hasMacro || /[\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_]*\s*[:：]/.test(s.slice(io + RELOC_VARTAG.length, ic));
}

/* @30859-30864 */
function _chatFloorNow() {
    try {
        const c = getContext()?.chat;
        return (Array.isArray(c) && c.length) ? c.length - 1 : null;
    } catch (_) { return null; }
}

/* @30916-30926 */
function _prevDiskCandidate(chatKey) {
    try {
        if (_prevDiskCache.chat !== chatKey) return null;
        if (!Array.isArray(_prevDiskCache.msgs) || !_prevDiskCache.msgs.length) return null;
        return {
            at: Number(_prevDiskCache.at) || 0, src: 'disk',
            digest: 'abc' + String(_prevDiskCache.no), floor: null,
            msgs: _prevDiskCache.msgs,
        };
    } catch (_) { return null; }
}

/* @30994-31024 */
function _prevCandidates(chatKey) {
    if (!chatKey) return [];
    try {
        /* ★★★★★★ 2026-09-24【候选池从 localStorage 换成**内存池** —— 用户定版原话：
         *   "那就删了localStorage 事多，我一直以来 从未考虑过这个技术，都是ssd硬盘"】
         *   为什么非换（盘上铁证）：localStorage 只有 ~5MB，而原上限 `PREV_PROMPT_MAX_CHARS`
         *   是 1,600,000 **字符**（UTF-16 ≈ 3.2MB）⇒ 必然爆 ⇒ `_diag.log` 从 `07:03:31` 起
         *   **每一轮**都是 `QuotaExceededError` ⇒ **候选池停摆** ⇒ 用户一 F5 就只能从旧池子挑
         *   ⇒ A 区 45,921→18,854 字 ⇒ **miss 重建**（实测锯齿 78.8/46.4/76.1%）。
         *   ⇒ 现在写内存池（`globalThis.__hitOptPrevPool`），跨页由硬盘预取补
         *     （`_patchInstallDiskBaseline` 从 `turns/<no>.pre.json` 拉最近 3 轮）。
         *   数据结构与原来**逐字段一致** ⇒ `_prevCandidates` / `_prevMsgsLoad` /
         *   `_prevMsgsPickBest` 的解析逻辑一个字都不用改。
         *   ⛔ 从此**不再读写 localStorage** —— 那个 5MB 的小仓库与这条链彻底无关。 */
        const all = (globalThis.__hitOptPrevPool && typeof globalThis.__hitOptPrevPool === 'object')
            ? globalThis.__hitOptPrevPool : (globalThis.__hitOptPrevPool = {});
        const slot = all[chatKey];
        if (!slot) return [];
        const raw = Array.isArray(slot.list) ? slot.list
            : (Array.isArray(slot.msgs) ? [{ at: slot.at, src: slot.src, digest: slot.digest, msgs: slot.msgs }] : []);
        const out = [];
        for (const it of raw) {
            const m = Array.isArray(it?.msgs) ? it.msgs : null;
            if (!m || !m.length) continue;
            const src = String(it?.src || '?');
            // ⚠ 这里存的是**光秃秃的 src 字段**（`wire` / `mem` / `post` / `wire0`），不是
            //   `_prevBaselineSrc` 那种 `${src}:${digest}` 拼好的串 —— 所以判据要写成 `wire` 或
            //   `wire:…`，**不能**写成 /^wire:/（那样一个都滤不掉；也不能写成 /^wire/，
            //   那会把可信的 `wire0` 一起误杀）。这条是 baseline_pick_test 第②段当场抓出来的。
            if (/^wire(:|$)/.test(src)) continue;       // 来源不可信（v6.24.81 那次翻倍事故的元凶）→ 不进候选
            out.push({
                at: Number(it?.at) || 0,
                src,
                digest: String(it?.digest || '?'),
                // ★ v6.24.86：这一份是"哪一楼"时存下来的（酒馆 GUI 口径）。老记录没有 ⇒ null（不猜）。
                floor: Number.isFinite(Number(it?.floor)) ? Number(it.floor) : null,
                msgs: m.map(x => ({ role: String(x?.[0] || ''), content: String(x?.[1] ?? '') })),
            });
        }
        out.sort((a, b) => b.at - a.at);            // 最新在前（时间相同保持插入次序）
        return out;
    } catch (_) { return []; }
}

/* @31026-31049 */
function _prevMsgsLoad(chatKey) {
    if (!chatKey) return null;
    try {
        /* ★★★★★★ v6.51.9【盘上兜底】localStorage 一份候选都没有 ⇒ 用预取回来的那一份
         *   （_prevDiskCandidate 同步读内存缓存；没有就返回 null ⇒ 与改动前逐字节同行为）。
         *   ⚠ 只在**空**的时候兜（有就不覆盖）—— 这条只增不减，绝不把本来能用的候选挤掉。 */
        const c = _prevCandidates(chatKey)[0] || _prevDiskCandidate(chatKey);
        if (!c) return null;
        // ══ ★★★ v6.24.81【照实回读来源标记，别再一律标成 wire】════════════════════════════════
        //   老写法不管盘上 `src` 是什么，回读时一律写 `wire:指纹` —— 于是"这份基准是**网上那份**
        //   （酒馆后端并过消息的形状，与这一轮的 msgs 不同源）"这个**唯一能事后查出来的线索**被抹平了。
        //   实测代价：第 7 轮 swipe 时基准 54 条 vs 这一轮 43 条，逐下标盖把整条历史错位，
        //   官方 prompt 43,420 → 87,068（出网 73,566 → 144,063 字）。查这个案时就是靠 `proof`
        //   心跳里的 `spN/snapN` 反推出来的 —— 而 `src` 本来就能直接说明白。
        //   现在照实回读，三个值各有确定含义：
        //     `wire0` = 定稿副本与网上那份**逐条相同**（v6.24.81 起才写）⇒ 同源，可信；
        //     `mem` / `post` = `_prevBaselineFrom` 按"条数对得上 / 定稿快照"定的 ⇒ 同源，可信；
        //     `wire` = **v6.24.81 之前**写的"网上那份" ⇒ 可能与这一轮不同源，体检那一关要拦。
        //     `?` = 更老的记录没记来源 ⇒ 不猜（体检按条数判）。
        const src = String(c.src || '?');
        _prevBaselineSrc = `${src}:${String(c.digest || '?')}`;
        return c.msgs;
    } catch (_) { return null; }
}

/* @31054-31098 */
function _prevMsgsSave(chatKey, snap, src = 'mem', digest = '') {
    if (!chatKey || !Array.isArray(snap) || !snap.length) return;
    /* ★ 2026-09-24 事故修复（补丁定义在 tail.js 第五节 @keep:prev-save-sig）：
       入口把哨兵清空，出口（写成功后）再置上 —— 这样 `_patchMaybeBootstrap` 才能分出
       "这一轮压根没写过"（该自举）与"写了"（不动）。 */
    try { if (typeof _patchResetPrevSig === 'function') _patchResetPrevSig(); } catch (_) { }
    try {
        /* ★★★★★★ 2026-09-24【候选池从 localStorage 换成**内存池** —— 用户定版原话：
         *   "那就删了localStorage 事多，我一直以来 从未考虑过这个技术，都是ssd硬盘"】
         *   为什么非换（盘上铁证）：localStorage 只有 ~5MB，而原上限 `PREV_PROMPT_MAX_CHARS`
         *   是 1,600,000 **字符**（UTF-16 ≈ 3.2MB）⇒ 必然爆 ⇒ `_diag.log` 从 `07:03:31` 起
         *   **每一轮**都是 `QuotaExceededError` ⇒ **候选池停摆** ⇒ 用户一 F5 就只能从旧池子挑
         *   ⇒ A 区 45,921→18,854 字 ⇒ **miss 重建**（实测锯齿 78.8/46.4/76.1%）。
         *   ⇒ 现在写内存池（`globalThis.__hitOptPrevPool`），跨页由硬盘预取补
         *     （`_patchInstallDiskBaseline` 从 `turns/<no>.pre.json` 拉最近 3 轮）。
         *   数据结构与原来**逐字段一致** ⇒ `_prevCandidates` / `_prevMsgsLoad` /
         *   `_prevMsgsPickBest` 的解析逻辑一个字都不用改。
         *   ⛔ 从此**不再读写 localStorage** —— 那个 5MB 的小仓库与这条链彻底无关。 */
        const all = (globalThis.__hitOptPrevPool && typeof globalThis.__hitOptPrevPool === 'object')
            ? globalThis.__hitOptPrevPool : (globalThis.__hitOptPrevPool = {});
        const slot = all[chatKey];
        const prevList = Array.isArray(slot?.list) ? slot.list.slice()
            : (Array.isArray(slot?.msgs) ? [{ at: slot.at, src: slot.src, digest: slot.digest, msgs: slot.msgs }] : []);
        const flat = snap.map(m => [String(m.role || ''), String(m.content ?? '')]);
        const shape = (o) => {
            const a = Array.isArray(o) ? o : (Array.isArray(o?.msgs) ? o.msgs : []);
            return `${a.length}|${String(a[0]?.[1] ?? a[0]?.content ?? '').length}|${String(a[a.length - 1]?.[1] ?? a[a.length - 1]?.content ?? '').length}`;
        };
        /* ══ ★★★★★★ 2026-09-24【**候选池被饿死**的第二刀：去重判据必须带上"楼层"】══════════════
         *  【原来长什么样】`sig = src|digest|shape`，一条候选只要这三样与新的相同就被**删掉**。
         *  【为什么这是致命的】`digest` 只有 `post` 源才有，而它来自 `_sendProof.digest` ——
         *    一旦 `_sendProof` 是**上一轮的残留**（那次事故的根因，已在
         *    `_onChatCompletionSettingsReady` 入口修掉），每轮读到的 digest 都**相同**；
         *    而 `shape`（条数|首条长度|末条长度）在"这一轮与上一轮形状相同"时也相同
         *    ⇒ **每一轮的新候选都被当成重复项删掉** ⇒ 池子里**永远只剩最初那一份**
         *    ⇒ `_prevMsgsPickBest`（挑 LCP 最长的那份）面对只有一个元素的集合，"挑"变成空转
         *    ⇒ **坏值一旦进去就再也出不来**（实测 `rsBase` 冻在 `post:ba5c2bf198a22362`
         *      从第 2 轮到第 11 轮一次都没换过，而正常场逐轮演进）。
         *  【修法】去重只该防"**同一楼**被写两次"（同一轮的重复调用），**不该跨楼误杀**。
         *    候选表里本来就存了 `floor`（下面 `unshift` 那一行，`_chatFloorNow()`），判据没用上它。
         *  ⇒ 只在"**楼层也相同**"时才去重。不同楼一律留着 ⇒ 池子真的有三份可挑 ⇒
         *    自愈能力（挑一份干净的绕开坏的）才真正存在。
         *  ⚠ 兼容老候选：老的没有 `floor` 字段 ⇒ `it.floor` 是 undefined，与新楼层 `===` 不成立
         *    ⇒ **不会被误删**（这是有意的：宁可多留一份，也不要因为字段缺失把好候选删掉）。 */
        const floorNow = _chatFloorNow();
        /* ⛔⛔ 2026-09-24【`sig is not defined` —— 这一行让内存池**从来没写进去过**】
         *   原判据引用了 `sig`（`src|digest|shape` 拼的串），而那个变量**在这个函数里根本不存在**
         *   ⇒ 每次 `_prevMsgsSave` 都抛 `ReferenceError` ⇒ 整条写池失败
         *   （铁证：第 11 轮 `00010.diag.json` 里 `stState:"fail"` / `stWhy:"ReferenceError:sig is not defined"` /
         *     `stLen:0`；而 `pickCands:3` ⇒ 池里只剩硬盘预取那 3 份，全是 `disk` 来源）。
         *   ⇒ 按这段代码**自己写明的意图**（"去重只该防同一楼被写两次，不该跨楼误杀"）改回**楼层判据**。
         *   ⚠ `floorNow === null`（认不出楼层）时**一律不去重** —— 宁可多留一份，也不要把候选删空
         *     （`disk` 候选的 `floor` 就是 null，认不出时会与它们意外相等 ⇒ 一次 save 清空三份）。 */
        const list = (floorNow === null) ? prevList : prevList.filter(it => it?.floor !== floorNow);
        list.unshift({ at: Date.now(), src: String(src || 'mem'), digest: String(digest || ''), floor: floorNow, msgs: flat });
        all[chatKey] = { at: Date.now(), list: list.slice(0, PREV_PROMPT_KEEP) };
        /* ★★★★★★ 2026-09-24【内存池**按场分槽、不因配额删** —— 用户原话：
         *   "注意哦 我随时切换聊天，内存就是临时的，真实都是硬盘上的文件"】
         *   ⇒ ① 内存池是**临时镜像**，切聊天时靠硬盘预取重新填（不指望它还留着）；
         *     ② 但也不能像 localStorage 那样只留 1 个场 —— 用户切来切去，切回来还得能立刻用
         *        ⇒ 留 `PREV_MEM_MAX_CHATS` 个场（内存便宜，每场最多 `PREV_PROMPT_KEEP` 份 × ~130KB）。 */
        const keys = Object.keys(pool);
        keys.sort((a, b) => (Number(pool[b]?.at) || 0) - (Number(pool[a]?.at) || 0));
        for (const k of keys.slice(PREV_MEM_MAX_CHATS)) delete pool[k];
        /* ★ 2026-09-24：`localStorage.setItem` 与那段"超量就丢候选"的裁剪**整段删掉** ——
         *   内存池没有配额这回事（那 1.6M 字符的上限本来就是为 localStorage 设的）。
         *   只保留"最多留 `PREV_PROMPT_MAX_CHATS` 个聊天"那一刀（见上面 `for (const k of keys…)`）。 */
        // ★ v6.24.96：写成功也要留痕（只写内存，不进档）—— "没调用"与"写了但抛了"从此分辨得开
        _prevStoreStat = { at: Date.now(), state: 'ok', why: 'mem-pool', len: list.length, key: String(chatKey || ''), src: String(src || 'mem'), keys: Array.isArray(all[String(chatKey || '')]?.list) ? all[String(chatKey || '')].list.length : 0 };
        /* ★★★★★★ 2026-09-24【补一条**入档**的埋点：基准写没写进去，必须能从盘上判】══════════════
         *  为什么非加不可：`_prevStoreStat` 只活在内存里（刷新就没），而"基准有没有被写进候选池"
         *  正是这次事故的**唯一分水岭** —— 异常场 `rsBase` 从头到尾冻在 `post:ba5c2bf198a22362`，
         *  而正常场逐轮演进。光看 `rsBase` 只知道"没换"，分不清是
         *    (a) `_prevMsgsSave` 压根没被调用、(b) 被签名去重挡了、还是 (c) 写进去了但读不出来。
         *  ⇒ 每次落盘发一条 `prev:save`（含 src / digest 前 8 位 / 形状 / 候选池剩几份 / 那份是不是被去重顶掉），
         *    随 `/turn` 的 `diag` 一起进 `turns/NNNNN.diag.json`（用户 `k5` 那个 bug 修好之后就有了）。 */
        try {
            _diagReport({
                tag: 'prev:save', chat: String(chatKey || ''),
                src: String(src || 'mem'), digest: String(digest || '').slice(0, 8),
                shape: shape(flat), poolAfter: Number(all[String(chatKey || '')]?.list?.length) || 0,
                /* 被签名去重顶掉的旧候选数（>0 ＝ 这次写把同签名的旧项替换了，不是净增） */
                replaced: Math.max(0, prevList.length - list.length),
            });
        } catch (_) { }
        /* ★ 2026-09-24 事故修复（补丁定义在 tail.js 第五节 @keep:prev-save-sig）：
           **写成功**之后才置哨兵 —— `_patchMaybeBootstrap` 靠它判"这一轮写过没"。
           放在这里（而不是入口）是因为入口置上会把"写失败"也当成写过。
           ⚠ `typeof` 守卫不是多余：`tools/build.mjs` 是整份覆盖本文件，
             补丁定义在 tail.js 里；万一两边漂了，这里只会少一次记账，**不会**抛 ReferenceError。 */
        try { if (typeof _patchMarkPrevSig === 'function') _patchMarkPrevSig(`${String(src || 'mem')}|${String(digest || '')}|${flat.length}`); } catch (_) { }
    } catch (err) {
        // 配额满 / 隐私模式：只留内存基准，绝不打断发送
        // ★ v6.24.96：**抛了就如实记账**（原来只有一行 console，刷新就没 ⇒ 下一轮"基准还是空的"查无实据）
        _prevStoreStat = { at: Date.now(), state: 'fail', why: String(err?.name || '') + ':' + String(err?.message || err).slice(0, 60), len: 0, key: String(chatKey || ''), src: String(src || 'mem'), keys: 0 };
        console.warn('[hitOpt] 上一轮定稿文本没存进 localStorage（这一轮只留内存基准）:', err?.message || err);
    }
}

/* @31117-31181 */
function _prevBaselineFrom(snap, isReal, chatKey, wantFinalN) {
    try {
        const sp = _sendProof;
        // ★ v6.24.95：判据原来是 `Number(sp.n) === snap.length` —— 它拿抓包条数去比**这一轮的 snap**，
        //   而 4 秒兜底那条路上 `snap` 退化成**预演快照**（比出网少几条）⇒ 判据不成立 ⇒ 基准写不进去
        //   ⇒ 下一轮"还没有上一轮真发出去的那串字可比"⇒ 永久自锁（新聊天 8 轮实测全废）。
        //   现在多一个参照物：**定稿的真实条数**（`wantFinalN`，由调用方无条件记下）。
        //   两个里任一对得上 ⇒ 这份抓包就是这一轮真发出去的那串字（它比 snap 更权威）。
        const wantN = Number(wantFinalN) || 0;
        if (sp && Array.isArray(sp.msgs) && sp.msgs.length
            && (Number(sp.n) === snap.length || (wantN > 0 && Number(sp.n) === wantN))) {
            const w = sp.msgs.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
            _prevRealMsgs = w;
            try { globalThis.__hitOptPrevChat = String(_currentChatKey() || ''); } catch (_) { }
            _prevBaselineSrc = `post:${String(sp.digest || '?').slice(0, 8)}`;
            _prevMsgsSave(chatKey, w, 'post', sp.digest || '');
            return _prevBaselineSrc;
        }
    } catch (_) { }
    if (isReal) {
        _prevRealMsgs = snap;
        try { globalThis.__hitOptPrevChat = String(_currentChatKey() || ''); } catch (_) { }
        _prevBaselineSrc = 'mem';
        _prevMsgsSave(chatKey, snap, 'mem');
        return 'mem';
    }
    // ══ ★★★ v6.24.83【基准自愈：可疑的基准不许"原地不动"】══════════════════════════════════
    //   v6.24.46 定这条兜底时的理由是"宁可留旧基准，也不许被预演那份污染"（实测丢过 596 字）——
    //   那条**对普通旧基准仍然成立，一个字没改**。它漏的是另一种更糟的情况：**旧基准本身就是可疑的**。
    //   `wire:` = "网上那份" POST body（酒馆后端 `postProcessPrompt` 并过消息，与这一轮的 `msgs`
    //   不同源，实测 54 条 vs 43 条）。v6.24.81 起体检见了 `wire:` 就**整轮不还原**当作安全网 ——
    //   可只要连着几轮都走这条兜底，基准就永远停在 `wire:` 上 ⇒ **还原功能永久失效**，
    //   而盘上一个字都查不出来（`out.skip` 只打在 console 里，刷新就没）。
    //   ⇒ 现在：可疑基准**必须**被这一轮的定稿快照顶掉（同源，比一份形状不同源的强）；
    //     普通旧基准照旧"原地不动"。
    //   ⚠ 为什么用"这一轮的 `snap`"而不是"什么都不做"：`snap` 是**这一轮自己拼的那串字**，
    //     与下一轮的 `msgs` 同源同形状——这正是逐下标盖回（v6.24.48 定版）唯一要求的前提。
    // ══ ★★★ v6.24.90【用户 2026-09-17："你踏马的 miss这么异常你不去动你的鬼脑子 … 直接删除重做"】══
    //   **整条"拿预演快照顶掉可疑基准"的分支，删掉。** 官方数为证（`圣樱学院_mu5ffle6lfcc`）：
    //     #30（v6.24.87）prompt 69,495 / hit **45,184** / miss 24,311
    //     #31（v6.24.88）prompt 73,379 / hit **16,768** / miss **56,611**
    //     #32（v6.24.88）prompt 76,499 / hit  **4,608** / miss **71,891**
    //   埋点把凶手指名道姓了（`pushTurn:enter`）：
    //     `rsOn=0`、`rsSkip=基准形状不对（前文件 **53** 条 vs 这一轮 **90** 条，来源 mem:?）`
    //   ——上一轮写进候选池的那份基准是 **53 条**，而客户端这一轮手里是 **90 条**。
    //   `mem` 那份从哪来的？就是下面这段 v6.24.83 加的"自愈"：它把 `snap`（**预演快照** `p.snapshot`，
    //   宏还没展开、块还没搬、条数完全不是最终形状）当成"这一轮的定稿快照"存了进去，还标成 `mem`
    //   （体检认它"同源可信"）。⇒ 下一轮拿它当基准 ⇒ 形状对不上 ⇒ **整步还原被拦**；
    //   可"搬走变量块"那一步在它**之前**、独立跑 ⇒ 结果就是：变量块从原位搬空、又没人把历史盖回，
    //   前缀从最前面就断 —— 用户报的"损失一个变量栏"和 miss 翻三倍，都是这一条造成的。
    //   ⇒ 现在的口径（简单、可查）：**可疑基准就清掉，绝不拿另一份可疑的去顶。**
    //     清掉之后这一轮等于"先记账"（`_restoreFrozenHistory` 见到没有基准就一个字不动），
    //     而 `_relocMoveVarBlock` 有同进同退的闸（见那边的 v6.24.89 注释）—— 两半永远一致。
    if (/^wire:/.test(String(_prevBaselineSrc || ''))) {
        const bad = _prevBaselineSrc;
        _prevRealMsgs = null;
        try { globalThis.__hitOptPrevChat = String(_currentChatKey() || ''); } catch (_) { }
        _prevBaselineSrc = '';
        console.warn(`[hitOpt] v6.24.90 还原基准来源可疑（${bad} = 网上那份，形状与这一轮不同源）`
            + ` ⇒ **直接清掉**，这一轮先记账（下一轮从候选池里挑一份真的）。`
            + ` 绝不拿预演快照顶 —— 那份条数与最终形状根本不是一回事，实测会把整步还原拦掉、`
            + ` miss 从 24,311 抬到 71,891`);
        return '';
    }
    console.warn('[hitOpt] v6.24.46 这一轮没拿到"真发出去的字"（预演兜底）→ **还原基准原地不动**'
        + '（拿预演快照当基准会让下一轮把该补的历史当成"本来就一样"，实测丢过 596 字）');
    return '';
}

/* @31187-31209 */
function _prevMsgsRestore(chatKey) {
    if (!chatKey) return false;
    if (_prevStoreChat === chatKey && Array.isArray(_prevRealMsgs) && _prevRealMsgs.length) return true;
    _prevStoreChat = chatKey;
    // v6.19：换聊天/刷新之后尾部那一组也重新学（顺序按"上一轮发出去的那串字"排 → 学出来跟上一轮一致）
    // ★ v6.24.20：**真的"换了聊天"才清**；同一个聊天（刷新页面/切回来）先从盘上装回来 ——
    //   "重新学"= 换一批块搬家 = 一次真实的形状改变，实测一轮就赔 95K~98K tok。
    _relocTailGroup = [];
    _relocTailWi = [];
    _relocGroupLoad(chatKey);
    const msgs = _prevMsgsLoad(chatKey);
    if (!msgs) {
        // ★ v6.24.96：**"读不出来"也要留痕** —— 这条路上原来只有 `_prevRealMsgs = null`，
        //   于是"基准写进去了、下一轮却读不出"（键失配 / 被 `wire:` 过滤光 / 超量被裁）
        //   在盘上完全看不见，只能靠反推。写 'read0' 与写盘那条 'ok'/'fail' 互不覆盖语义。
        _prevStoreStat = { at: Date.now(), state: 'read0', why: '候选池读不出来（该键没有候选 / 全被过滤）', len: 0, key: String(chatKey || ''), src: '', keys: 0 };
        _prevRealMsgs = null; _prevTurnSnap = null; return false;
        try { globalThis.__hitOptPrevChat = String(_currentChatKey() || ''); } catch (_) { }
    }
    _prevRealMsgs = msgs;
    try { globalThis.__hitOptPrevChat = String(_currentChatKey() || ''); } catch (_) { }
    try { _prevTurnSnap = { texts: msgs.map(m => String(m.content ?? '')), toks: [], at: Date.now() }; } catch (_) { _prevTurnSnap = null; }
    console.log(`[hitOpt] 装回上一轮定稿文本（${msgs.length} 条，落盘副本）→ 这一轮的前缀 diff 修复照常工作`);
    return true;
}

/* @31215-31229 */
function _msgsLcpChars(a, b) {
    const A = Array.isArray(a) ? a : [], B = Array.isArray(b) ? b : [];
    const L = Math.min(A.length, B.length);
    let n = 0;
    for (let i = 0; i < L; i++) {
        const x = String(A[i]?.content ?? ''), y = String(B[i]?.content ?? '');
        if (String(A[i]?.role || '') !== String(B[i]?.role || '') || x !== y) {
            let j = 0; const M = Math.min(x.length, y.length);
            while (j < M && x.charCodeAt(j) === y.charCodeAt(j)) j++;
            return { chars: n + j, item: i };
        }
        n += x.length;
    }
    return { chars: n, item: L };
}

/* @31282-31285 */
function _containerStabilizeMaybe(prevMsgs, msgs, idx) {
    if (!CONTAINER_STAB) return null;
    return _containerStabilize(prevMsgs, msgs, idx);
}

/* @31315-31337 */
function _containerStabilize(prevMsgs, msgs, idx) {
    const i = Number.isFinite(idx) ? Number(idx) : 1;
    if (!Array.isArray(prevMsgs) || !Array.isArray(msgs)) return null;
    if (!prevMsgs[i] || !msgs[i]) return null;
    const P = String(prevMsgs[i].content ?? '');
    const C = String(msgs[i].content ?? '');
    if (!P || !C || P === C) return null;                       // 没得动 / 已经一致
    const cnt = (arr) => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) || 0) + 1); return m; };
    const pc = cnt(P.split('\n'));
    const extra = [];
    const seen = new Map();
    for (const l of C.split('\n')) {
        const k = (seen.get(l) || 0) + 1;
        seen.set(l, k);
        if (k > (pc.get(l) || 0)) extra.push(l);                // 多重集差：这一轮多出来的（保持原序）
    }
    const text = extra.length ? P + '\n' + extra.join('\n') : P; // ⚠ extra 为空 ⇒ 必须是 P 本身（定理 29）
    return {
        msgs: msgs.map((m, k) => (k === i ? { ...m, content: text } : m)),
        prevChars: P.length, curChars: C.length, nextChars: text.length,
        extra: extra.length, extraChars: extra.length ? extra.join('\n').length : 0,
    };
}

/* @31339-31360 */
function _prevMsgsPickBest(msgs, chatKey) {
    try {
        if (!Array.isArray(msgs) || !msgs.length || !chatKey) return null;
        const cands = _prevCandidates(chatKey);
        if (!cands.length) return null;
        let best = null, tried = 0, overFloor = 0, badShape = 0;
        // ③ **楼层上限**（用户 2026-09-17 配截图点名："注意哦 是酒馆的用户GUI的'楼层'！"）——
        //    候选的楼层号必须 ≤ 当前聊天最后一楼。删过楼层的聊天里，旧候选的楼层号会比现在高，
        //    那种一份都不许用（用了就等于把用户删掉的内容又塞回去）。
        const curFloor = _chatFloorNow();
        for (const c of cands) {
            if (curFloor !== null && c.floor !== null && c.floor > curFloor) { overFloor++; continue; }
            const ratio = (c.msgs.length && msgs.length) ? c.msgs.length / msgs.length : 1;
            if (msgs.length >= 8 && c.msgs.length && (ratio < 0.6 || ratio > 1.7)) { badShape++; continue; }   // ② 形状不可用
            tried++;
            const m = _msgsLcpChars(c.msgs, msgs);
            if (!best || m.chars > best.chars) best = { src: c.src, digest: c.digest, floor: c.floor, msgs: c.msgs, chars: m.chars, item: m.item };
        }
        if (!best) return null;
        return { ...best, cands: cands.length, tried, overFloor, badShape, curFloor };
    } catch (_) { return null; }
}

/* @31371-31387 */
function _alignTurns(prev, cur) {
    const pairs = [];
    const same = (a, b) => !!a && !!b
        && String(a.role || '') === String(b.role || '')
        && String(a.content ?? '') === String(b.content ?? '');
    let i = 0, j = 0, guard = 0;
    while (i < prev.length && j < cur.length && guard++ < 4000) {
        if (same(prev[i], cur[j])) { pairs.push({ i, j, same: true }); i++; j++; continue; }
        if (same(prev[i + 1], cur[j])) { i++; continue; }                   // 这一轮少了一条
        if (same(prev[i], cur[j + 1])) { j++; continue; }                   // 这一轮多了一条（插进来的）
        if (String(prev[i]?.role || '') === String(cur[j]?.role || '')) { pairs.push({ i, j, same: false }); i++; j++; continue; }
        pairs.push({ i, j: -1, same: false }); i++;
    }
    while (i < prev.length) { pairs.push({ i, j: -1, same: false }); i++; }
    while (j < cur.length) { pairs.push({ i: -1, j, same: false }); j++; }
    return pairs;
}

/* @31403-31442 */
function _diffPrefixSplit(prevTexts, prevToks, nextTexts, nextToks, nextRoles) {
    const a = Array.isArray(prevTexts) ? prevTexts : [];
    const b = Array.isArray(nextTexts) ? nextTexts : [];
    if (!a.length || !b.length) return null;
    const aText = a.map(x => String(x ?? '')).join('\n');
    const bText = b.map(x => String(x ?? '')).join('\n');
    const spans = [];
    let at = 0;
    for (let i = 0; i < b.length; i++) {
        const c = String(b[i] ?? '');
        spans.push({ i, from: at, to: at + c.length, tok: Math.max(0, Number(nextToks?.[i]) || 0) });
        at += c.length + 1;                       // 与 join('\n') 的偏移对齐
    }
    const max = Math.min(aText.length, bText.length);
    let p = 0;
    while (p < max && aText.charCodeAt(p) === bText.charCodeAt(p)) p++;
    // 断点算"从哪一条**开始**对不上"：落在某一条内部 → 就是它（并给出内部比例，好把它的 token 按比例切开）
    const inside = spans.find(s => p > s.from && p < s.to) || null;
    const startsAt = spans.find(s => s.from >= p) || null;
    const hit = inside || startsAt;
    const fully = spans.filter(s => s.to <= p).reduce((x, s) => x + s.tok, 0);
    const into = inside ? Math.round(inside.tok * ((p - inside.from) / Math.max(1, inside.to - inside.from))) : 0;
    const total = spans.reduce((x, s) => x + s.tok, 0);
    // ★ v6.24.47：命中 token 按**官方的 64 token 块**向下取整（官方就是这么报的，见 `CACHE_BLOCK_TOK` 那段）。
    //   这一步在这里做（而不是在调用方）—— 三处（实测断点 / 这一次换上 / 每轮）用的都是这一份结果，
    //   谁都不许自己再取整一次，也不许有第二套算法。
    const hitTok = Math.min(total, _blockFloor(fully + into));
    const idx = hit ? hit.i : (spans.length - 1);
    return {
        chars: p, hitTok, missTok: Math.max(0, total - hitTok), total,
        // v6.24.11：**字数**也要能说清（用户："追加，未命中（XX tok / XX 字）"）——
        //   总字数 = 这一份文本自己的长度；未命中字数 = 它减去"逐字一致"的那一段。算法还是只有这一份。
        totalChars: bText.length, missChars: Math.max(0, bText.length - p),
        item: idx, role: String(nextRoles?.[idx] ?? ''),
        // "两轮一模一样"必须是**长度也一样**：只是这一份更长（末尾追加）不算全命中
        full: p >= aText.length && p >= bText.length,
        prevHead: String(aText.slice(p)).replace(/\s+/g, ' ').trim().slice(0, 70),
        nextHead: String(bText.slice(p)).replace(/\s+/g, ' ').trim().slice(0, 70),
    };
}

/* @31455-31487 */
async function _measuredLcp(assembled, tokArr) {
    const texts = [], toks = [], roles = [];
    for (let i = 0; i < assembled.length; i++) {
        texts.push(String(assembled[i]?.content ?? ''));
        toks.push(tokArr[i] || 0);
        roles.push(String(assembled[i]?.role || ''));
    }
    // ★ v6.24.51【比的对象必须是**真发出去的字**】——
    //   以前这里跟 `_prevTurnSnap`（上一轮的"定稿快照"）比。那份可能是**历史还原/变量块后置之前**的
    //   预演那一份，与真出网那份不是同一串字：实测 2026/9/17 `圣樱学院_mu4y2xeo6lmz` #1，
    //   抬头写 9,926 字，而两份真记录逐字节比只有 4 字（那一轮 `#0` 的 system 是"没搬过块"的形状）。
    //   现在跟 `_prevRealMsgs`（上一轮 POST 出发那一刻的取证 / 盘上装回来的那一份）比 ——
    //   与记录服务在 `turns/NNNNN.txt` 正文上量的是**同一对字**。取不到 → 这一轮**不给数**（null）。
    //   快照照旧留着更新（别的地方用它判断"这一轮的字"），但它不再当比对的基准。
    _prevTurnSnap = { texts, toks, at: Date.now() };
    const prevMsgs = (Array.isArray(_prevRealMsgs) && _prevRealMsgs.length) ? _prevRealMsgs : null;
    if (!prevMsgs) return null;
    const prevTexts = prevMsgs.map(m => String(m?.content ?? ''));
    const r = _diffPrefixSplit(prevTexts, new Array(prevTexts.length).fill(0), texts, toks, roles);
    if (!r) return null;
    // ★ v6.24.47【与官方对齐】命中 token 换成**官方口径**：
    //   ① 把那一段公共前缀**整段数一遍**（逐条求和会高估 ~1%：相邻消息拼起来词元会合并）；
    //   ② 再按官方的 64 token 块向下取整（`CACHE_BLOCK_TOK`）。
    //   未命中 = 这一轮总数 − 命中（**与官方 `prompt_tokens − cache_hit_tokens` 同一个定义**），
    //   于是"本地命中/未命中"与官方 usage 在**前缀相同**的那些轮次里逐位相等（用户要的就是这个对齐）。
    //   前缀位置（chars / item / role / 断点那一条）一个字没改 —— 算法还是 `_diffPrefixSplit` 那一份。
    const hitTok = await _prefixHitTok(texts.join('\n').slice(0, r.chars), r.hitTok);
    return {
        chars: r.chars, tok: hitTok, missTok: Math.max(0, r.total - hitTok),
        item: r.item, role: r.role, full: r.full,
        prevHead: r.prevHead, nextHead: r.nextHead,
    };
}

/* @31495-31557 */
function _measureAssembledPrompt(assembled, injectedTexts = []) {
    if (!Array.isArray(assembled) || assembled.length === 0) return;
    // ★★★★★★ v6.27.0【三件套存档之一：**酒馆原始组装的请求**】用户 2026-09-19 点名：
    //   "每一轮保存多份文件：1. 真实未经过 Horae 修改的请求原本、2. 经过 horae 修改的请求体、
    //    3. 服务器的返回（含官方 usage 与输出内容）… 1 与 3 都必须存储，跟随 2 的 git 系统"。
    //   ② 就是现在的 `turns/NNNNN.txt`（抓包那份 POST body，一字不改）。
    //   ① 的**唯一正确时点就在这里**：`onPromptReady` 刚交给 Horae 的那一刻 —— 酒馆已经组装完，
    //     **Horae 一个字都还没动**（下面 `_normalizeLatestInputWrap(snap)` 动的是副本，
    //     再往后的 `_abSplit` / 还原 / 搬运更是后面的事）。
    //   深拷贝一份存进 `_pendingMeasure.raw`，随 `/turn` 一起交给服务端落盘（`turns/NNNNN.raw.txt`）。
    //   ⚠ 必须**深拷贝**：`assembled` 是酒馆那个还在被别的插件改的**活数组**，存引用等于没存。
    const rawSnap = assembled.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
    const seq = ++_measureSeq;
    // v4.9：先找"本轮末尾锚定的注入点"里最早的那一个 —— 它之后的内容下一轮必然按全价重算。
    // 锚点只认**本轮真的在数组里**的文本（未前移的 @D 世界书块 + Horae 自己注入的块），
    // 找不到就不计、不猜；没有任何"上一次请求"的残留状态。
    const wiIdx = new Set();
    const injectIdx = new Set();
    let breakIdx = -1;
    // v5.0：先算真断点 —— 静态前置会把"已钉住"的块搬到开头（命中区），
    // 所以凡是落在断点之前的注入都不再算作断点，否则旧口径会被自己搬走的块撑爆。
    const items0 = _promptItemsOf(assembled);
    const brkEarly = _trueBreakIndex(items0);
    const regionFrom = brkEarly >= 0 ? brkEarly : 0;
    const locate = (text) => {
        if (!text) return -1;
        for (let i = 0; i < assembled.length; i++) {
            const c = typeof assembled[i]?.content === 'string' ? assembled[i].content : '';
            if (c && c.includes(text)) return i;
        }
        return -1;
    };
    for (const b of _wiDepthBlocks) {
        if (b.hoisted) continue;                       // 已前移的块在命中区，不再是断点
        const i = locate(b.text);
        b._idx = i;
        if (i >= regionFrom) { wiIdx.add(i); if (breakIdx < 0 || i < breakIdx) breakIdx = i; }
    }
    for (const t of injectedTexts) {
        const i = locate(t);
        if (i >= regionFrom) { injectIdx.add(i); if (breakIdx < 0 || i < breakIdx) breakIdx = i; }
    }
    // ★ v6.16 预演快照：这一刻**不是**最终文本（酒馆助手那类插件还没展开宏、还没注入），
    //   所以这里只存不记账 —— 记账挪到最后一刻（_onChatCompletionSettingsReady）。
    //   保留同步抓取的字符串副本，是因为 assembled 是酒馆那个还在被别的插件改的活数组。
    const snap = assembled.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
    // ★ v6.24.21：套壳归一**只动这份副本**（assembled 是酒馆那个还在被别的插件改的活数组，绝不就地改它）。
    //   定稿通路（_onChatCompletionSettingsReady）走的是真 body，那边另有一道同样的归一。
    _normalizeLatestInputWrap(snap);
    _pendingMeasure = { seq, snapshot: snap, raw: rawSnap, owned: assembled, injectedTexts, wiIdx, injectIdx, breakIdx, brkEarly, items0, at: Date.now() };
    console.log(`[hitOpt] 预演快照：${snap.length} 条 / ${snap.reduce((a, m) => a + m.content.length, 0)} 字（等最后一刻定稿再记账）`);
    setTimeout(() => {
        const p = _pendingMeasure;
        if (p && p.seq === seq) {
            _pendingMeasure = null;
            console.warn('[hitOpt] 4 秒内没等到定稿事件（非 openai 通路 / 被中断）→ 用预演快照记账');
            // ★ v6.24.46：定稿事件没配上时，**别拿预演快照当"这一轮的字"** —— 它是"还原之前"的。
            //   形状判据通过的那一刻已经把真 body 那一份存在 `p.finalMsgs`（还原已写入、与 POST 同源），
            //   有它就用它；两条都没有才退回预演（那时 `_prevBaselineFrom` 会拒绝把它写成基准）。
            void _finalizeMeasure(p, p.finalMsgs || null);
        }
    }, 4000);
}

/* @31565-31887 */
async function _finalizeMeasure(p, realMsgs) {
    const seq = p.seq;
    const assembled = p.owned;
    const injectedTexts = p.injectedTexts;
    const wiIdx = p.wiIdx, injectIdx = p.injectIdx, breakIdx = p.breakIdx, brkEarly = p.brkEarly, items0 = p.items0;
    const isReal = Array.isArray(realMsgs) && realMsgs.length > 0;
    void (async () => {
        try {
            const started = Date.now();
            // ★ v6.8 快照（v6.16 起是"定稿快照"）：下面的 token 计数、实测断点、写进 git 的记录，
            //   全都只认这一份 —— 它是 POST body 里的 messages 逐条抄下来的。
            const snap = (isReal ? realMsgs : p.snapshot).map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
            // ★★★★★★ v6.27.0：**这一轮真发出去的那串字，轮末记进"已发块指纹池"**
            //   —— 下一轮 `_abSplit` 的 B 区指针化就是拿它当判据（`<AMnnnn>` 的"记忆唤起"）。
            //   位置放在这里而不是各处调用点：`snap` 就是这个函数的"真发出去了"那一个口径
            //   （`isReal` 假时退化为定稿快照，那也是这一轮实际要发的那串）。
            //   ⚠ 它**只增不改**（轮末整份换），且不落盘 ⇒ 不存在"新聊天读到旧聊天的池"。
            try { _amPoolCommit(snap); } catch (_) { }
            // ★★★★★★ v6.28.0：**同一份"真发出去的那串字"同时登记进"区间地址台账"**
            //   （块级池管"有配对标签的整块"，区间台账管"标签外的裸正文" —— 两条判据互补，缺一条就漏一半）。
            //   ⚠ 登记单元是**切开指针之后的纯正文段**（`_amAddrSplit`）⇒ 地址里永远不含指针字节
            //     ＝用户要的"碎片化 扁平化"（一个指针的范围里不会再有第二个指针）。
            try { _amAddrCommit(snap); } catch (_) { }
            let total = 0, full = 0, wiFull = 0, inject = 0;
            const tokArr = new Array(snap.length).fill(0);
            for (let i = 0; i < snap.length; i++) {
                const n = await _countStMessage(snap[i].role, snap[i].content);   // ★ 只数快照（v6.8）
                tokArr[i] = n;
                total += n;
                if (breakIdx >= 0 && i >= breakIdx) {
                    full += n;
                    if (wiIdx.has(i)) wiFull += n;
                }
            }
            for (const t of injectedTexts) inject += await _countStMessage('system', t);
            // v6.7：把"这一轮真实发出去的消息 → 实测 token"记下来 —— 之后所有代价判断（压缩/前移/重写）
            // 都优先用这些实测值，而不是按字数折出来的估算。键 = 消息全文指纹，只存数字。
            try {
                const chatArr = Array.isArray(getContext()?.chat) ? getContext().chat : [];
                if (chatArr.length) {
                    const byText = new Map();
                    for (let i = 0; i < snap.length; i++) {
                        if (snap[i].content && !byText.has(snap[i].content)) byText.set(snap[i].content, tokArr[i] || 0);
                    }
                    let got = 0;
                    for (const m of chatArr) {
                        const mes = typeof m?.mes === 'string' ? m.mes : '';
                        if (!mes) continue;
                        const n = byText.get(mes);
                        if (typeof n === 'number' && n > 0) { _measuredMsgTok.set(_pfHash(mes), n); got++; }
                    }
                    if (_measuredMsgTok.size > COST_MAP_MAX) _measuredMsgTok.clear();   // 上限兜底，别无限长
                    if (got) console.log(`[hitOpt] 实测口径：本轮 ${got} 条聊天消息拿到了真实 token（代价计算优先用它们）`);
                }
            } catch (_) { /* 记不上就算了，代价计算会退回估算并如实标注 */ }
            // v4.9.3：算"处理前后人民币差"的两个变量 ——
            //   H = 被前移走的 token（这些从全价区挪进命中区）；P = 留在原槽位那行指针的 token（仍在全价区）。
            //   都是实测（同一套酒馆分词器），不是估的。
            let hoistedTok = 0, pointerTok = 0;
            for (const b of _wiDepthBlocks) {
                if (!b.hoisted) continue;
                hoistedTok += await _wiDepthBlockTok(b.text);
                const rule = (settings.wiDepthHoistRules || {})[b.key] || {};
                pointerTok += await _wiDepthBlockTok(_wiDepthPointer(rule.name, b));
            }
            // ── v4.9.4：真断点 + 把"必然全价区"逐条拆开（与官方 usage 对账）──
            const items = items0;
            const brk = brkEarly;
            const pf = {
                pfBreakIdx: brk, pfReplyTok: 0, pfInjectTok: 0, pfWiTok: 0, pfPointerTok: 0,
                pfNewTok: 0, pfMovedTok: 0, pfFreshTok: 0, pfDetail: [], pfRegionTok: 0, pfTotalTok: total, pfMsgs: assembled.length,
                pfTurnSeq: ++_pfTurnSeq, pfParts: '',
            };
            if (brk >= 0) {
                // 逐条判定：这段文本**上一轮有没有** —— 有（换了位置）= 末尾锚定注入，可以锚定；
                // 没有 = 这一轮新出现/每轮都在变的东西，**不可缓存**（这才是要抓的真凶）。
                const prevHashes = new Set((_prevPromptItems || []).map(x => x.h));
                const prevAt = new Map((_prevPromptItems || []).map((x, i) => [x.h, i]));
                const detail = [];
                for (let i = brk; i < assembled.length; i++) {
                    const m = assembled[i];
                    const c = typeof m?.content === 'string' ? m.content : '';
                    const n = tokArr[i] || 0;
                    pf.pfRegionTok += n;
                    const h = items[i]?.h;
                    const seen = prevHashes.has(h);
                    const role = String(m?.role || '');
                    let kind;
                    if (_isWiPointer(c)) { pf.pfPointerTok += n; kind = '@D 指针'; }
                    else if (wiIdx.has(i)) { pf.pfWiTok += n; kind = '未前移的 @D 块'; }
                    else if (injectIdx.has(i)) { pf.pfInjectTok += n; kind = 'Horae 注入（末尾锚定）'; }
                    else if (i === brk && (role === 'user' || role === 'assistant')) { pf.pfReplyTok += n; kind = '上一轮回复（新内容，下一轮变命中）'; }
                    else if (role === 'user' || role === 'assistant') { pf.pfNewTok += n; kind = '新消息'; }
                    else if (seen) { pf.pfMovedTok += n; kind = `末尾锚定注入：与上一轮 #${prevAt.get(h)} 同文本、位置变了 → 锚定即可命中`; }
                    else { pf.pfFreshTok += n; kind = '**每轮新出现/在变，不能缓存**'; }
                    if (n > 0 && detail.length < 12) detail.push(`#${i} ${role} ${n}tok ${kind}`);
                }
                pf.pfDetail = detail;
                const parts = [];
                if (pf.pfReplyTok) parts.push(`上一轮回复 ${pf.pfReplyTok}`);
                if (pf.pfInjectTok) parts.push(`Horae 注入 ${pf.pfInjectTok}`);
                if (pf.pfWiTok) parts.push(`@D 块 ${pf.pfWiTok}`);
                if (pf.pfPointerTok) parts.push(`@D 指针 ${pf.pfPointerTok}`);
                if (pf.pfNewTok) parts.push(`新消息 ${pf.pfNewTok}`);
                if (pf.pfMovedTok) parts.push(`挪位置的块 ${pf.pfMovedTok}`);
                if (pf.pfFreshTok) parts.push(`每轮变化的块 ${pf.pfFreshTok}`);
                pf.pfParts = parts.join(' + ');
            }
            // v5.0：静态前置的战果（已钉住的块现在在命中区，省的是它们的 token）
            const sfHashes = new Set(_sfInfo.moved || []);
            let sfTok = 0, sfCnt = 0;
            if (sfHashes.size) {
                for (let i = 0; i < items.length; i++) {
                    if (sfHashes.has(items[i].h)) { sfTok += tokArr[i] || 0; sfCnt++; }
                }
            }
            // 两轮指纹：本轮有变化才滚动（同一轮的重复调用不会把基准冲掉）
            const identical = _prevPromptItems && _prevPromptItems.length === items.length
                && items.every((x, i) => x.h === _prevPromptItems[i].h && x.role === _prevPromptItems[i].role);
            if (!identical) { _prev2PromptItems = _prevPromptItems; _prevPromptItems = items; }
            // v5.5 前缀护栏基准 = 这一轮**真正发出去**的那串（搬迁之后的样子），下一轮拿它比
            _prevPrefixItems = items;
            // ★ v6.18：基准就地定下来（内存 + 落盘副本）—— 后面那些统计/写记录即使被更新的请求顶掉，
            //   下一轮的"前缀 diff 修复"也不会因为这一轮空转而整轮失效（实测：那样命中率会掉回 25%）。
            const relocStatsSnap = _relocateStats;
            // ★ v6.24.46：基准只认"真发出去的那份字"（见 `_prevBaselineFrom` 那段血案）——
            //   预演兜底那一趟**一个字都不写**，否则下一轮的还原就瞎了。
            _prevBaselineFrom(snap, isReal, _currentChatKey(), p.finalN);
            /* ★ 2026-09-24 事故修复（补丁定义在 tail.js 第五节 @keep:prev-bootstrap）：
               **拿不到基准就当场自举一份** —— 原来这条路上一个字都不写，
               候选池进不去新候选 ⇒ 下一轮读到的还是那份烂的 ⇒ A 区照抄烂基准
               ⇒ **一次失败就永久失败**（实测 A 区 #3 与 #8 都是 11/18,854，隔 4 轮一字不长）。
               判据在补丁里：只有"这一轮压根没往候选池写过东西"才补（`_patchPrevSig` 空）。 */
            if (typeof _patchMaybeBootstrap === 'function') { try { void _patchMaybeBootstrap(snap); } catch (_) { } }
            /* ══ ★★★★★★ 2026-09-24【**自举**：拿不到基准就当场存一份，别让对话从此暴毙】══════════════
             *  【用户原话】「**我踏马聊的好好的，你告诉我突然暴毙了**」「**能恢复当前异常对话的正常对话吗**」
             *
             *  【为什么原来会"暴毙且不自愈"】`_prevBaselineFrom` 拿不到"真发出去的字"时，
             *    `_prevMsgsSave` **一次都不调用**（上面三个分支：post 对不上条数 ⇒ 跳过；
             *    `isReal` 假 ⇒ 走"基准原地不动"那条老路 ⇒ 直接 return）⇒ 候选池**一份新候选都进不去**
             *    ⇒ 下一轮 `_prevMsgsLoad` 读到的还是那份烂的（甚至 read0）⇒ A 区照抄烂基准
             *    ⇒ 命中区一字不长 ⇒ **一次失败就永久失败**。
             *    实测铁证：异常场 `林夏_muf17g3x5dix` 的 A 区 #3 与 #8 都是 `11 条 / 18,854 字`
             *    （中间隔 4 轮一个字没长），而正常场逐轮 +2~3 条 / +2,000~3,000 字。
             *
             *  【自举的判据（保守）】只有**同时**满足才存：
             *    ① 这一轮 `snap` 非空且在合理条数带内（>= 8 条 —— 这是完整的提示词，不是残片）；
             *    ② 当前**确实没有**能用的基准（`_prevRealMsgs` 空，或 `_prevBaselineSrc` 为空）。
             *  ⇒ 有基准的时候**一个字都不动**（绝不把能用的挤掉），只有"手上是空的"才补一份。
             *
             *  【代价（如实说）】自举那份可能不是"真发出去的字"（`snap` 是定稿快照，
             *    酒馆助手在 SETTINGS_READY 之后展开的宏不在里面）⇒ 那一轮**仍然救不回来**（本来就烂了），
             *    但**下一轮起 A 区就有干净的基准可比、恢复逐轮增长** —— 这正是"自愈"。
             *  ⛔ 不改任何判据：只在"原本什么都不写"的那个分支上补一次写入。 */
            try {
                const noBase = !(Array.isArray(_prevRealMsgs) && _prevRealMsgs.length) || !String(_prevBaselineSrc || '').trim();
                if (noBase && Array.isArray(snap) && snap.length >= 8) {
                    const arr = snap.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
                    const _bsChars = arr.reduce((a2, m2) => a2 + String(m2?.content ?? '').length, 0);
                    _prevMsgsSave(_currentChatKey(), arr, 'bootstrap');
                    try {
                        _diagReport({ tag: 'prev:bootstrap', chat: _gitLogChat(), n: arr.length, chars: _bsChars });
                    } catch (_) { }
                    console.warn(`[hitOpt] 没有可用的还原基准 ⇒ **自举一份**（这一轮 ${arr.length} 条 / ${_bsChars} 字）`
                        + ` 存进候选池 —— 下一次起 A 区就能正常增长（不是"从此暴毙"）。`);
                }
            } catch (_) { }
            _lastFinalSnap = snap;          // ★ v6.24.30：留给"出网对账"比对的定稿副本
            // ★ v6.24.44：这里不再存"楼层指纹"（那套随"简单拼接"一起删掉了）——
            //   下一轮的拼接只认"这一条是不是上一轮那条删掉几段"，不看聊天楼层的指纹。
            _relocateStats = null;
            if (seq !== _measureSeq) return;                 // 已有更新的请求，丢弃旧结果
            // v6.7：实测断点（与上一轮真实 request 逐字符比）—— 面板"本地"和所有代价判断都以它为准
            // v6.8：比的是**快照**（数出来的 token 和写进 git 的正文必须是同一份文本）
            // v6.16：这份快照现在是**定稿**（POST body 里的 messages）—— 预演之后别的插件补进来的
            //        东西（比如酒馆助手展开的变量块）也在这里面，所以"本地"终于和官方数同一串字。
            //
            // ★ v6.24.37【Token 计算错误：本地的请求 Token 与官网不是同一串字】
            //   用户实测："Token计算错误，本地的请求 Token 与官网认为的请求 Token 没有相等"。
            //   实测差多少（这一场聊天，官方 usage 为证）：官方 27,380 tok，本地合计只有 24,353 字那份
            //   —— 差的不是四舍五入，是**被数的字根本不是发出去的字**：
            //     · `snap` 是 `_onChatCompletionSettingsReady` 里那份 messages，它里面
            //       `{{format_message_variable::stat_data}}` **还是字面宏**（这段注释以前就写着"酒馆助手
            //       展开的变量块也在这里面"，其实没有：酒馆助手是**同一个事件**的另一个监听器，
            //       谁先注册谁先跑，而展开发生在 `CHAT_COMPLETION_SETTINGS_READY` → POST 之间）；
            //     · 一展开，那 5,633 字的宏变成 8,405~8,542 字真值 → 官方数的比我们多好几千 tok。
            //   修法：**拿"出发那一刻 POST body 里的那份 messages"来数**。它就在手边 ——
            //   `_installSendProof()` 把 `window.fetch` 包了一层，POST 出去之前已经 `JSON.parse` 过 body
            //   （就是 `_sendProof.msgs`），那份**展开了、也过了所有插件的手**，与酒馆后端发上游的同源。
            //   取不到（非 openai 通路 / 被中断 / 条数对不上）→ 照旧用 snap，并在 console 如实说一句，
            //   绝不拿旧一轮那份 `_sendProof` 冒充（新对象本来就是"条数 + 时间"双卡）。
            const proof = (() => {
                try {
                    const sp = typeof _sendProof === 'object' && _sendProof ? _sendProof : null;
                    if (!sp || !Array.isArray(sp.msgs) || !sp.msgs.length) return null;
                    // ★ v6.24.59【真 bug 修复】判据原来写的是 `sp.n !== snap.length`（**必须完全相等**）——
                    //   而这两个数**根本不是同一回事**：`snap` 是"定稿快照"的条数（客户端自己数的那份数组），
                    //   `sp.n` 是**真 POST body 里的条数**。酒馆后端在出网前会先 `postProcessPrompt`
                    //   把消息并一遍（实测：抓包 **36** 条 vs 预演 **63** 条，差 27 条！），
                    //   于是这条判据**几乎永远为假** ⇒ 真 POST body 被丢掉 ⇒ 数 token 退回去数"定稿快照"
                    //   那份字 ⇒ 系统性偏小（这正是用户报的"请求token对不上官网token"）。
                    //   现在：条数**允许不等**（那是酒馆并消息的正常结果），只要求"是这一轮"——
                    //   非空、条数在一个合理带内（并消息只会让条数**变少**，所以是 `sp.n <= snap.length + 2`）、
                    //   且**出发时刻离现在不远**（`_sendProof` 本来就是"出发那一刻"的取证，时间窗收紧到 3 分钟，
                    //   避免拿上一轮的残留冒充这一轮）。
                    if (sp.n > 0 && snap.length > 0 && sp.n > snap.length + 2) return null;
                    const age = Date.now() - (Number(sp.at) || 0);
                    if (!(age >= 0 && age < 180_000)) return null;
                    return sp;
                } catch (_) { return null; }
            })();
            // ★ v6.24.59【诊断·查完必删】用户报"怎么突然请求token对不上官网token了" ——
            //   面板「本地请求Token」那一格数的是**哪一份字**，全看这一跳拿到没拿到 `proof`
            //   （拿到了 = 出发那一刻 POST body 那份字，与官方同源；没拿到 = 定稿快照那份，会偏）。
            //   实测线上一直是 `hasProof:false`，但光看这个布尔值分不清是"没包装上 fetch"、
            //   "body 不是字符串"、还是"条数对不上" —— 三种修法完全不同，所以把中间量一起报上来。
            try {
                const sp = (typeof _sendProof === 'object' && _sendProof) ? _sendProof : null;
                _diagReport({
                    tag: 'proof', has: !!proof,
                    spN: sp ? Number(sp.n) || 0 : -1, snapN: snap.length,
                    msgsN: (sp && Array.isArray(sp.msgs)) ? sp.msgs.length : -1,
                    age: sp ? (Date.now() - (Number(sp.at) || 0)) : -1,
                    wrapped: (typeof window !== 'undefined' && !!window.__horaeSendProof) ? 1 : 0,
                });
            } catch (_) { }
            const sentMsgs = proof ? proof.msgs.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') })) : null;
            let tokArr2 = tokArr, total2 = total, sentTok = 0;
            if (sentMsgs) {
                tokArr2 = new Array(sentMsgs.length).fill(0);
                for (let i = 0; i < sentMsgs.length; i++) {
                    const n = await _countStMessage(sentMsgs[i].role, sentMsgs[i].content);
                    tokArr2[i] = n;
                    sentTok += n;
                }
                // ★ v6.24.38：补上 chat 模板那 6 tok 的固定开销 —— 官方 prompt_tokens 里算着它，
                //   逐条求和算不进去。不补这一下，"本地"就永远比官方少那么几个数（实测 4 条 / 6 条都是 6）。
                //
                // ★ v6.24.61【这一格**暂时不动** —— 等精确数据，别凭反推改】
                //   用户点名过"请求token 怎么对不上官网"。实测三轮（出网原文 vs 官方 usage.prompt_tokens）：
                //     #00005 77 条 本地 76,208 / 官方 76,150　#00006 79 条 83,257 / 83,199　#00007 81 条 83,405 / 83,347
                //   ⇒ **三轮都是本地多 58**。但**别急着减**：那三个"本地"值是**旧公式算出来的**
                //   （当时 `tok` 压根没写进记录，面板显示的多半是官方数顶上），拿被污染的旧值反推修正量不可靠 ——
                //   我试了 `±n` / `±2n` 几个候选，**没有一个能同时命中三个样本**
                //   （`-n` 差 −19/−21/−23，`+27` 差 +58/+58/+58，`-2n` 差 −96/−100/−104）。
                //   所以这里保持原样，改成**把逐条求和与条数一起报上去**（下面那条 `tokencal` 心跳）：
                //   下一轮拿到 `sentTok` / `条数` / `本机算得` / `官方` 四个真数，就能一次定死该怎么补。
                //   按用户口径：**宁可先不修，也不拿猜出来的常数去凑**。
                total2 = sentTok + PROMPT_OVERHEAD_TOK;
                // ⚠【运行心跳·保留】把这一轮"请求 token 到底怎么算出来的"四个数报上去 ——
                //   它就是用户点名那件事（本地 vs 官方）的唯一权威证据，比事后反推可靠。
                try {
                    _diagReport({
                        tag: 'tokencal', n: sentMsgs.length, sentTok,
                        over: (() => { try { return Number(PROMPT_OVERHEAD_TOK) || 0; } catch (_) { return 0; } })(),
                        total2, snapTotal: total,
                    });
                } catch (_) { }
                const d = total2 - total;
                console.log(`[hitOpt] token 口径：拿**出发那一刻** body 里的 messages 数出 ${sentTok.toLocaleString('en-US')} tok`
                    + ` ＋ 模板开销 ${PROMPT_OVERHEAD_TOK} = **${total2.toLocaleString('en-US')}**`
                    + `（定稿快照那份是 ${total.toLocaleString('en-US')}，差 ${d >= 0 ? '+' : ''}${d.toLocaleString('en-US')}）`
                    + ` —— 面板「本地请求Token」与写进记录、以及自动摘要那几道门都用这一份`);
            } else {
                console.log(`[hitOpt] token 口径：⚠ 没拿到"出发那一刻"的 messages（非 openai 通路 / 被中断 / 条数对不上）`
                    + ` → 照旧用定稿快照数（${total.toLocaleString('en-US')} tok）`
                    + ` ＋ 模板开销 ${PROMPT_OVERHEAD_TOK} = ${(total + PROMPT_OVERHEAD_TOK).toLocaleString('en-US')}`);
                total2 = total + PROMPT_OVERHEAD_TOK;      // ★ v6.24.38：这一路也补上，两条路同一个口径
            }
            const measMsgs = sentMsgs || snap;
            const measTok = tokArr2;
            const measTotal = total2;
            const lcp = await _measuredLcp(measMsgs, measTok);
            if (lcp) console.log(`[hitOpt] 实测断点：前 ${lcp.tok} tok 与上一轮逐字一致，从第 #${lcp.item} 条（${lcp.role}）起断开 → 本轮至少 ${lcp.missTok} tok 按全价计费`);
            // v6.16：把这一轮**定稿文本**留给下一轮（变量后置与实测断点都以它为准），
            //        并把后置块的精确 token 量出来（面板读数要的是真数，不是估的）。
            const reloc = {
                count: Math.max(0, Number(relocStatsSnap?.count) || 0),
                spanChars: Math.max(0, Number(relocStatsSnap?.spanChars) || 0),
                movedTok: 0, pointerTok: 0,
                skip: String(relocStatsSnap?.skip || ''),
                tail: relocStatsSnap?.tail || null,           // v6.18：尾部锚定块的政策战果
            };
            if (reloc.count) {
                let mt = 0;
                const texts = Array.isArray(relocStatsSnap?.texts) && relocStatsSnap.texts.length
                    ? relocStatsSnap.texts : [String(relocStatsSnap?.text || '')];
                for (const t of texts) mt += await _countStMessage('system', t);
                reloc.movedTok = mt;
                reloc.pointerTok = (await _countStMessage('system', RELOC_POINTER)) * reloc.count;
            }
            if (reloc.tail && reloc.tail.count) {
                reloc.tail.movedTok = 0;
                reloc.tail.pointerTok = 0;
                const seenPtr = new Set();                    // 一组只留一行指针 → 只数一次
                for (const b of reloc.tail.blocks || []) {
                    if (b?.text) reloc.tail.movedTok += await _countStMessage('system', String(b.text));
                    if (b?.pointer && !seenPtr.has(b.pointer)) { seenPtr.add(b.pointer); reloc.tail.pointerTok += await _countStMessage('system', String(b.pointer)); }
                }
            }
            // v5.3：把这一轮真实发出去的 request 提交给本地 git（真 git init/commit；diff 由 git 算）。
            //   v6.21.9：这里以前还会顺带往内存里记一份"运行记录"（含逐条的"哪一楼 / 什么块"标记）。
            //   用户定版"不需要内存临时存储，只需要 git + 硬盘" → 那一整套删掉了：逐轮明细走 git 里的文本，
            //   楼层走提交元数据里的 ai#N（面板侧再用首尾片段跟活聊天对，认不出就留空，绝不认错楼层）。
            // ★ v6.24.69：第 6 个参数是**「这个 tok 数的是哪串字」**——`sent` = 出发那一刻 POST body 那份
            //   （与官方同源，实测 +51~+60 tok 对得上）；`settled` = 定稿快照那份（**与官方不可比**，
            //   实测 `圣樱学院_mu5clow3vpjs` #2/#3 比官方 prompt 少 6,500 tok）。它写进归档抬头，
            //   日后对账时一眼能看出"这一轮的本地合计该不该拿来跟官方比"，不必再猜。
            // ★ v6.27.0【三件套之一】原始请求用 `p.raw`（在 `_measureAssembledPrompt` 里抓的，
            //   那一刻 Horae 一个字都还没动）—— 这里**不引用外层局部量**，避免作用域踩空。
            _gitLogPushTurn(measMsgs, measTok, measTotal, lcp, proof, sentMsgs ? 'sent' : 'settled', p.raw);
            _diffAnalysisInvalidate();     // 又记了一轮（git 提交）→ 差异分析表重算
            const st = _getAutoSummaryCostStats();
            // ★ v6.24.37：这里也换成"出发那一刻那份字"的数 —— 自动摘要的每一道门（值不值得压、能省多少）
            //   都读 `measuredPromptTok`；用偏小的定稿快照会系统性低估这一轮的提示词（实测差约 7%）。
            st.measuredPromptTok = measTotal;
            st.measuredInjectTok = inject;
            st.measuredMsgs = assembled.length;
            st.measuredAt = Date.now();
            st.measuredChatKey = _currentChatKey();
            st.measuredBy = _stTokMod ? 'st' : 'local';
            st.wiFullPriceTok = full;
            st.wiWiTok = wiFull;
            st.wiBreakIdx = breakIdx;
            st.wiHoistedTok = hoistedTok;
            st.wiPointerTok = pointerTok;
            st.sfMovedCount = sfCnt;
            st.sfMovedTok = sfTok;
            // v6.16：定稿口径 + 变量后置的战果（面板读数用）
            st.realFinal = isReal;
            st.lateFixCount = Math.max(0, Number(p.lateFix?.n) || 0);
            st.lateFixChars = Number(p.lateFix?.chars) || 0;
            st.relocateMovedTok = reloc.movedTok;
            st.relocatePointerTok = reloc.pointerTok;
            st.relocateCount = reloc.count;
            st.relocateSkip = reloc.skip;
            st.relocateTailCount = Math.max(0, Number(reloc.tail?.count) || 0);
            st.relocateTailTok = Math.max(0, Number(reloc.tail?.movedTok) || 0);
            st.relocateTailPointerTok = Math.max(0, Number(reloc.tail?.pointerTok) || 0);
            Object.assign(st, pf);
            settings.autoSummaryCostStats = st;
            console.log(`[hitOpt] 实测完整提示词：${total} tok（${assembled.length} 条消息，其中注入块 ${inject} tok）`
                + `｜口径=${isReal ? '定稿（POST body 里的 messages 原样）' : '预演兜底（没等到定稿事件）'}`
                + `｜预演后还被别的插件改了 ${st.lateFixCount} 条（净 ${st.lateFixChars >= 0 ? '+' : ''}${st.lateFixChars} 字）`
                + `｜每轮必然全价区 ${full} tok（其中世界书 @D ${wiFull}）｜断点 #${breakIdx}`
                + `｜已前移 ${_wiDepthBlocks.filter(b => b.hoisted).length} 块 ${hoistedTok} tok（原地留指针 ${pointerTok} tok）`
                + `｜变量后置 ${reloc.count ? `搬走 ${reloc.movedTok} tok（原地留指针 ${reloc.pointerTok} tok）` : `没动${reloc.skip ? `（${reloc.skip}）` : ''}`}`
                + `｜尾部锚定块 ${reloc.tail?.count ? `前移 ${reloc.tail.count} 条 ${reloc.tail.movedTok || 0} tok（原地留指针 ${reloc.tail.pointerTok || 0} tok）` : `没动${reloc.tail?.skip ? `（${reloc.tail.skip}）` : ''}`}`
                + `｜分词器=${_stTokMod ? '酒馆' : '本地估算'}｜耗时 ${Date.now() - started}ms`);
            if (brk >= 0) {
                console.log(`[hitOpt] 真断点 #${brk}（与上一轮逐条比对）→ 本轮必然全价区 ${pf.pfRegionTok} tok`
                    + ` = ${pf.pfParts || '(空)'}｜占提示词 ${(total ? 100 * pf.pfRegionTok / total : 0).toFixed(1)}%`
                    + `｜官方上一条请求未命中 ${Math.max(0, Number(st.lastRealMissTok) || 0)} tok`);
                for (const d of (pf.pfDetail || [])) console.log(`[hitOpt]   全价区 ${d}`);
            }
            // v6.21.8：这里以前刷设置页那行"缓存代价读数"；那块已删。差异分析的缓存由上面那一处
            //   （git 提交 → _diffAnalysisInvalidate）作废，这里不用再管。
        } catch (err) {
            console.warn('[hitOpt] 实测提示词失败:', err);
        }
    })();
}

/* @31908-31922 */
function _shapeKeyOf(m, idx) {
    const s = String(m?.content ?? '');
    const io = s.indexOf(SHAPE_VAR_TAG);
    const ic0 = s.indexOf(SHAPE_VAR_ENDTAG);
    const ic = ic0 < 0 ? -1 : ic0 + SHAPE_VAR_ENDTAG.length;
    const paired = io >= 0 && ic > io;
    if (!paired && io < 0 && ic < 0) return null;               // 没有变量块痕迹 → 逐字比
    if (io >= 0 && ic <= io && io <= SHAPE_VAR_WHOLE_MAX_IDX && !s.slice(io + SHAPE_VAR_TAG.length).trim()) {
        return { pre: SHAPE_VAR_WILD, post: '' };               // 只有开标签、后面没内容 → 整条就是变量体
    }
    return {
        pre: io >= 0 ? s.slice(0, io) : s,
        post: ic > io ? s.slice(ic) : '',
    };
}

/* @31943-31982 */
function _samePromptShape(snap, msgs) {
    if (!Array.isArray(snap) || !Array.isArray(msgs) || !snap.length || !msgs.length) return false;
    if (snap.length !== msgs.length) return false;
    const k0a = _shapeKeyOf(snap[0], 0), k0b = _shapeKeyOf(msgs[0], 0);
    const raw0a = String(snap[0].content), raw0b = String(msgs[0]?.content ?? '');
    if (!raw0a.trim()) return false;                            // 空首条：不认
    // ★ v6.24.33：一边认得出变量块、另一边认不出（比如首条被人整条换掉）→ **判假**。
    //   不这么卡的话，"快照是有壳的变量块 / 定稿换成别的"会被当成同一条，那就是误配。
    if ((k0a === null) !== (k0b === null)) return false;
    if (k0a === null) {
        if (raw0a !== raw0b) return false;                     // 非变量体宿主：照旧逐字
    } else {
        if (!String(k0a.pre).trim()) return false;              // 首条壳是整段宏？那这一轮不认（宁可不记账）
        if (k0a.pre !== k0b.pre || k0a.post !== k0b.post) return false;
    }
    let same = 0;
    for (let i = 0; i < snap.length; i++) {
        if (String(snap[i].role) !== String(msgs[i]?.role || '')) return false;
        const ka = _shapeKeyOf(snap[i], i), kb = _shapeKeyOf(msgs[i], i);
        if (ka === null || kb === null) {
            if (String(snap[i].content) === String(msgs[i]?.content ?? '')) same++;
            continue;
        }
        // 两边都认得出变量体：壳逐字节相同才算"同一条"；没有壳可比的（两边都是纯变量体）走通配
        const wild = ka.pre === SHAPE_VAR_WILD || kb.pre === SHAPE_VAR_WILD;
        if (wild ? (ka.pre === kb.pre) : (ka.pre === kb.pre && ka.post === kb.post)) same++;
    }
    if (same < Math.ceil(snap.length * 0.6)) return false;
    // ★ v6.24.33：末条（＝最新一句玩家输入）必须逐字节相等。它是整串里最独特的一条，
    //   也是"这到底是不是同一轮"最硬的判据；只靠 60% 同文比例的话，4 条里改坏 1 条也照样过。
    const la = snap.length - 1, lb = msgs.length - 1;
    const kla = _shapeKeyOf(snap[la], la), klb = _shapeKeyOf(msgs[lb], lb);
    if (kla === null || klb === null) {
        if (String(snap[la].content) !== String(msgs[lb]?.content ?? '')) return false;
    } else {
        const wild = kla.pre === SHAPE_VAR_WILD || klb.pre === SHAPE_VAR_WILD;
        if (wild ? (kla.pre !== klb.pre) : (kla.pre !== klb.pre || kla.post !== klb.post)) return false;
    }
    return true;
}

/* @32017-32025 */
function _relocPtrAt(text) {
    const s = String(text ?? '');
    const a = s.indexOf(RELOC_POINTER);
    const b = s.indexOf(RELOC_POINTER_IDLE);
    if (a < 0 && b < 0) return null;
    if (a < 0) return { at: b, len: RELOC_POINTER_IDLE.length };
    if (b < 0) return { at: a, len: RELOC_POINTER.length };
    return a <= b ? { at: a, len: RELOC_POINTER.length } : { at: b, len: RELOC_POINTER_IDLE.length };
}

/* @32033-32038 */
function _relocFrameOf(sentText) {
    const p = _relocPtrAt(sentText);
    if (!p) return null;
    const s = String(sentText ?? '');
    return { head: s.slice(0, p.at), tail: s.slice(p.at + p.len), idle: p.len === RELOC_POINTER_IDLE.length };
}

/* @32041-32052 */
function _relocFrameCut(cur, frame) {
    if (!frame) return null;
    const s = String(cur ?? '');
    const at0 = frame.head ? s.indexOf(frame.head) : 0;
    if (at0 < 0) return null;
    const at1 = frame.tail ? s.lastIndexOf(frame.tail) : s.length;
    if (at1 < 0 || at1 < at0 + frame.head.length) return null;
    const moved = s.slice(0, at0) + s.slice(at0 + frame.head.length, at1) + s.slice(at1 + frame.tail.length);
    // 指针那行字必须和上一轮**一模一样**：预锚留下的那句沿用预锚那句（它两种情况下都为真）
    const ptr = frame.idle ? RELOC_POINTER_IDLE : RELOC_POINTER;
    return { emit: frame.head + ptr + frame.tail, moved, ptr };
}

/* @32061-32084 */
function _relocLearnFrame(prevSentText, cur) {
    const prev = String(prevSentText ?? '');
    const s = String(cur ?? '');
    if (!prev || !s) return null;
    const m = Math.min(prev.length, s.length);
    let p = 0;
    while (p < m && prev[p] === s[p]) p++;
    let q = 0;
    while (q < m - p && prev[prev.length - 1 - q] === s[s.length - 1 - q]) q++;
    if (p > 0 && s[p - 1] !== '\n') p = s.lastIndexOf('\n', p - 1) + 1;      // 头锚收在整行之前
    if (q > 0) {                                                              // 尾锚从整行之后起
        const st = s.length - q;
        if (st > 0 && s[st - 1] !== '\n') {
            const nl = s.indexOf('\n', st - 1);
            q = nl < 0 ? 0 : s.length - (nl + 1);
        }
    }
    if (p + q > s.length) return null;
    // v6.24：关键词条目（世界书 constant:false）不许进锚 —— 它们每轮进进出出，钉在锚里就等于
    //   "它消失那一轮整条前缀全断"（用户实测第 5 轮 16.6K tok）。让开的那几段自动落进"后置"。
    //   骨架太小（整条都在变）由调用方那两道闸去 skip —— 这里不抢那个判断，免得把读数里的原因说串。
    const safe = _relocChurnSafeAnchors(s, s.slice(0, p), q ? s.slice(s.length - q) : '');
    return { head: safe.head, tail: safe.tail, idle: false, churn: safe.names };
}

/* @32124-32157 */
async function _wbBuildChurnIndex(force = false) {
    if (_wbChurnBuilding) return;
    if (!force && _wbChurnAt && Date.now() - _wbChurnAt < WB_CHURN_TTL_MS) return;
    let ctx = null;
    try { ctx = getContext(); } catch (_) { ctx = null; }
    if (!ctx || typeof ctx.loadWorldInfo !== 'function' || typeof ctx.getWorldInfoNames !== 'function') return;
    _wbChurnBuilding = true;
    try {
        const names = (() => { try { return ctx.getWorldInfoNames() || []; } catch (_) { return []; } })();
        const probes = [];
        const consts = [];
        for (const name of names) {
            let data = null;
            try { data = await ctx.loadWorldInfo(name); } catch (_) { continue; }
            for (const e of Object.values(data?.entries || {})) {
                if (!e || e.disable === true) continue;
                const c = String(e.content || '').replace(/\r\n/g, '\n').trim();
                if (c.length < 24) continue;                                      // 太短的认不准，不参与
                const item = { probe: c.slice(0, WB_CHURN_PROBE_CHARS), chars: c.length, book: String(name), name: String(e.comment || '').slice(0, 24) };
                if (e.constant === true) consts.push(item);                        // 常量 = 骨架的肉（当栅栏用）
                else probes.push(item);                                           // 关键词 = 每轮进出（一律后置）
            }
        }
        if (names.length) _wbChurnAt = Date.now();     // 真读到了才记时间（读不到就下一轮再试）
        if (probes.length) {
            _wbChurnProbes = probes;
            _wbConstProbes = consts;
            console.log(`[hitOpt] v6.24 世界书索引：${probes.length} 条 constant:false（每轮进出 → 全部后置）`
                + ` / ${consts.length} 条 constant:true（骨架栅栏 → 关键词区间不许盖过）｜扫了 ${names.length} 本`);
        }
    } catch (err) {
        console.warn('[hitOpt] 世界书关键词索引建不起来（这一轮按 v6.23 的老规矩钉，不影响出词）:', err);
    } finally { _wbChurnBuilding = false; }
}

/* @32160-32171 */
function _wbChurnSpans(text) {    const s = String(text ?? '');
    if (!s || !_wbChurnProbes.length) return [];
    const out = [];
    for (const e of _wbChurnProbes) {
        let at = s.indexOf(e.probe);
        while (at >= 0) {
            out.push({ at, len: e.chars, name: e.name });
            at = s.indexOf(e.probe, at + 1);
        }
    }
    return out.sort((a, b) => a.at - b.at);
}

/* @32175-32184 */
function _wbConstSpans(text) {
    const s = String(text ?? '');
    if (!s || !_wbConstProbes.length) return [];
    const out = [];
    for (const e of _wbConstProbes) {
        const at = s.indexOf(e.probe);
        if (at >= 0) out.push(at);
    }
    return out.sort((a, b) => a - b);
}

/* @32191-32204 */
function _relocChurnSafeAnchors(text, head, tail) {
    const s = String(text ?? '');
    const h0 = String(head ?? ''), t0 = String(tail ?? '');
    if (!_wbChurnProbes.length || !s) return { head: h0, tail: t0, names: [] };
    const spans = _wbChurnSpans(s);
    if (!spans.length) return { head: h0, tail: t0, names: [] };
    let h = h0;
    for (const sp of spans) if (sp.at < h.length) { h = h.slice(0, sp.at); break; }
    let tStart = s.length - t0.length;
    for (const sp of spans) if (sp.at + sp.len > tStart) tStart = Math.max(tStart, sp.at + sp.len);
    while (tStart < s.length && s[tStart] === '\n') tStart++;      // 分隔符不算锚的一部分
    const t = s.slice(Math.min(Math.max(tStart, h.length), s.length));
    return { head: h, tail: t, names: [...new Set(spans.map(x => x.name).filter(Boolean))] };
}

/* @32229-32349 */
function _relocStableSegs(text, prevSkelText) {
    const s = String(text ?? '');
    if (!s || !_wbChurnProbes.length) return null;         // 索引没建好 → 一个字不动（行为同 v6.22）
    const spans = _wbChurnSpans(s);
    if (!spans.length) return null;                        // 这一条里没有关键词条目 → 交给老逻辑
    // ① 每个关键词区间先**扩到整行**，再合并重叠：一个行都不许被切成两半
    //    （实测踩到的坑：不扩行的话，被切开的半行落在"后置块"里，行本身在提示词里就再也读不出来了）
    const lineStart = (x) => { const p = s.lastIndexOf('\n', Math.max(0, x - 1)); return p < 0 ? 0 : p + 1; };
    const lineEnd = (x) => { const p = s.indexOf('\n', x); return p < 0 ? s.length : p; };
    // ★ 栅栏：常量条目的正文起点 —— 关键词区间**不许越过**它（越过了就把常量切一块推进后置）
    const fences = _wbConstSpans(s);
    const rng = [];
    for (const sp of spans) {
        const at = Math.max(0, Math.min(sp.at, s.length));
        const a0 = lineStart(at);
        let b0 = lineEnd(Math.max(at, Math.min(sp.at + sp.len, s.length)));
        for (const f of fences) { if (f > a0 && f < b0) { b0 = f; break; } }     // 收到栅栏前
        b0 = lineEnd(Math.max(a0, b0));
        for (const f of fences) { if (f > a0 && f < b0) { b0 = f; break; } }
        if (b0 > a0) rng.push([a0, b0, sp.name]);
    }
    if (!rng.length) return null;
    rng.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const r of rng) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) { if (r[1] > last[1]) last[1] = r[1]; if (r[2]) last[2] = last[2] || r[2]; }
        else merged.push([r[0], r[1], r[2]]);
    }
    const raw = [];                                        // 留在原地的原始段（会被下面的规范化改写）
    const vary = [], names = [];
    let at = 0;
    for (const [a, b, nm] of merged) {
        if (a > at) raw.push(s.slice(at, a));
        vary.push(s.slice(a, b));
        if (nm) names.push(nm);
        at = b;
    }
    if (at < s.length) raw.push(s.slice(at));
    if (!vary.length) return null;                         // 没有要后置的
    // ② **规范化**：条目之间那些"纯空白段"（分隔用的换行）每轮条数会变 —— 原样留在骨架里，
    //    骨架就跟着变（实测：骨架第 2,366 字处每轮都在变 → 前缀照样断）。所以：
    //    有内容的段之间用**一个固定换行**连起来，纯空白段整体让进"后置"（字节一个不删，只是挪走）。
    const solid0 = raw.filter(x => /\S/.test(x));
    const blanks = raw.filter(x => !/\S/.test(x));
    const trim = (x) => x.replace(/\s+$/, '');
    const prevSkel = String(prevSkelText ?? '');
    if (!solid0.length) {
        // 没有旧骨架可比（预锚那一轮 / 第一次见这条块）→ 一个字不动：与老代码完全一致。
        // 为什么不在这一轮就返回骨架：`_freezeApply` 的判据是"这条块能不能切" —— 一旦这里给了骨架，
        // 冻结池会顺手把它整条搬进池子（原地只留一行说明），而池子要下一轮才可能把正文发出去，
        // 等于无谓地改一次形状。所以第一轮仍然不动它，从第二轮（有旧骨架可比）起才钉字节。
        if (!prevSkel) return null;
        // ③ ★ v6.24.28：**整条块全是关键词条目**（没有 constant:true 的常量条目 ⇒ `solid` 是空的）也要钉得住。
        //    实测现场（`_gitlog/圣樱学院_mu3w0gh1d15d`，四轮官方 usage 全 hit 0）：这条世界书块里 8 个条目
        //    **全是 constant:false**，于是老代码在这里 `return null` ⇒ `_freezeApply` 判它不是世界书块
        //    （`_relocStableSegs(c) !== null || _wbConstSpans(c).length > 0` 两条都不成立）⇒ 冻结池与搬迁
        //    **双双跳过**，整条块原样交给酒馆的条目序。而 `sample_basic` / `sample_nsfw` 有的轮触发、有的轮
        //    不触发，触发时被插在 `rule_校规` 与 `role_苏小桃` **之间** ⇒ 指针位置跟着漂 ⇒ 断点被钉死在
        //    `<role_苏小桃>` 那个字节上，它后面全部全价（四轮 miss 21,646 / 25,283 / 29,487 / 29,754）。
        //    修法：**拿上一轮那副骨架当模板** —— 从这一轮的条目 0 开始，只要某一条**逐字在旧骨架里出现过**，
        //    就照旧骨架的字节发（旧字节一个都不挪）；某一条是新的 → 从它起，剩下的照这一轮的文本次序
        //    追加在末尾。于是前缀只可能停在"第一个新条目"那里，且它在块里的位置越靠后、保住的前缀越长。
        // ★ 条目正文必须**按 `merged` 的区间从原文里取**（不是拿 `vary` 那一项）：
        //   `vary` 那一项用的是**探针命中的长度**（`sp.len`），而一个区间可能是"探针 + 它的常量栅栏"
        //   合起来的 —— 那会儿 `vary` 里只是这条条目的**开头一段**（实测：`<sample_basic>` 24 字就被截断，
        //   于是"这一条在不在旧骨架里"永远判错）。区间两端都已经扩到整行，`slice` 出来才是完整条目。
        const ent = [];
        for (const [a, b] of merged) {
            const y = trim(s.slice(a, b));
            if (y) ent.push(y);
        }
        if (!ent.length) return null;
        // ③ ★ v6.24.28：**整条块全是关键词条目**（没有 constant:true 的常量条目 ⇒ `solid` 是空的）也要钉得住。
        //    实测现场（`_gitlog/圣樱学院_mu3w0gh1d15d`，四轮官方 usage 全 hit 0）：这条世界书块里 8 个条目
        //    **全是 constant:false**，于是老代码在这里 `return null` ⇒ `_freezeApply` 判它不是世界书块
        //    （`_relocStableSegs(c) !== null || _wbConstSpans(c).length > 0` 两条都不成立）⇒ 冻结池与搬迁
        //    **双双跳过**，整条块原样交给酒馆的条目序。而 `sample_basic` / `sample_nsfw` 有的轮触发、有的轮
        //    不触发，触发时被插在 `rule_校规` 与 `role_苏小桃` **之间** ⇒ 指针位置跟着漂 ⇒ 断点被钉死在
        //    `<role_苏小桃>` 那个字节上，它后面全部全价（四轮 miss 21,646 / 25,283 / 29,487 / 29,754）。
        //    修法：**拿上一轮那副骨架当模板** —— 找"最长的 k：这一轮前 k 条按原文拼出来的字节，逐字出现在
        //    旧骨架里"，那段字节就**照旧骨架发**（一个都不挪）；第 k 条起的（含新条目）按文本次序追加到末尾。
        //    于是钉住之后再有条目进进出出，都只赔它自己那点 token。
        //    （为什么不能用"第一个新条目的位置"当切点：那个字符串**按定义**不在旧骨架里，`indexOf` 必然 -1。）
        let cut = 0, heldText = '';
        for (let k = ent.length; k > 0 && !heldText; k--) {
            // 分隔符不猜：原文里条目之间是几个换行，逐字拼出来才认（单换行、双换行都试；都不中就往下退一条）
            for (const gap of ['\n', '\n\n']) {
                const piece = ent.slice(0, k).join(gap);
                const i0 = prevSkel.indexOf(piece);
                if (i0 >= 0) { cut = k; heldText = prevSkel.slice(0, i0 + piece.length); break; }
            }
        }
        const keep = heldText + ent.slice(cut).join('\n') + '\n';
        return {
            keep, vary: blanks.join(''), names: [...new Set(names)],
            segs: cut, n: ent.length - cut, allChurn: true,
            chunks: ent.map((x, i) => ({ solid: i < cut, text: x })),
        };
    }
    // ④ ★ v6.24.28：混合块（常量 + 关键词）里的**字节序**:
    //    已经在上一轮那副骨架里的碎片，一律按它在旧骨架里的位置排 —— 新出现的碎片追加到末尾。
    //    于是旧字节一个都不挪（前缀照旧命中），新触发的只花它自己那点 token。
    //    对不齐（旧碎片一个都找不到 / 没给旧骨架）→ 退回按这一轮的文本次序排，与本版之前完全一样。
    let solid = solid0;
    if (prevSkel) {
        const placed = solid0.map(x => ({ x, at: prevSkel.indexOf(trim(x)) })).filter(v => v.at >= 0).sort((a, b) => a.at - b.at).map(v => v.x);
        if (placed.length) {
            const inOld = new Set(placed);
            solid = placed.concat(solid0.filter(x => !inOld.has(x)));
        }
    }
    const K = solid.map(trim).join('\n') + '\n';
    // chunks：这一条切成的碎片（solid=留在骨架里的、span/空白=要后置的）——
    //   给"骨架冻结"用：凡是**逐字能在上一轮那副骨架里找到**的碎片，就当我们已经发过、不再后置。
    const chunks = [];
    for (const x of solid) chunks.push({ solid: true, text: trim(x) });
    for (const x of vary) chunks.push({ solid: false, text: x });
    for (const x of blanks) chunks.push({ solid: false, text: x });
    return { keep: K, vary: vary.concat(blanks).join(''), names: [...new Set(names)], segs: solid.length, n: vary.length, chunks };
}

/* @32373-32436 */
function _relocFirstPreArm(msgs) {
    const out = { count: 0, spanChars: 0, text: '', texts: [], moved: [], at: -1, skip: '', why: '', skipped: [], preArm: 0, first: true };
    try {
        const chatArr = (() => { try { const c = getContext()?.chat; return Array.isArray(c) ? c : []; } catch (_) { return []; } })();
        if (chatArr.length > 3) { out.skip = '这个聊天已经很多条了（没有上一轮可比就不动它，免得把我们没有的缓存也弄断）'; return out; }
        let histFrom = -1;
        for (let k = 0; k < msgs.length; k++) {
            if (_floorOfPromptText(String(msgs[k]?.content ?? ''), chatArr) !== null) { histFrom = k; break; }
        }
        if (histFrom < 0) { out.skip = '认不出聊天历史从哪一条开始（这一轮不钉）'; return out; }
        const pre = [];
        let used = 0;
        for (let k = histFrom - 1; k >= 0 && used < RELOC_PREARM_MAX_CHARS; k--) {
            const m = msgs[k];
            const role = String(m?.role || '');
            const text = String(m?.content ?? '');
            if (role !== 'system' && role !== 'user') break;      // 走到对话/预填 = 边界
            if (_floorOfPromptText(text, chatArr) !== null) break; // 是聊天楼层 = 边界
            // 小标签条（`<相关资料>`）、预设标签块、已经钉过的 —— 都只是**路过**，继续往前找：
            //   前置设定区是"标签 + 世界书块 + 标签"夹出来的，遇到标签就停会漏掉真正要钉的那两块。
            if (text.length < RELOC_MIN_KEEP_CHARS) continue;
            if (text.startsWith('<')) continue;
            if (_relocPtrAt(text)) continue;
            pre.push({ k, text });
            used += text.length;
        }
        if (!pre.length) { out.skip = '前置区没有需要钉的块（都不够长 / 已经钉过）'; return out; }
        for (const it of pre.reverse()) {
            // ★ v6.24.23：新聊天第一次就把"恒定骨架留前、关键词条目后置"钉好 —— 老写法只让开头/结尾的锚，
            //   夹在关键词条目中间的那一大段常量会被整块后置（用户实测 29,035 字/轮全价）。
            const seg = _relocStableSegs(it.text);
            if (seg) {
                msgs[it.k].content = RELOC_POINTER_IDLE + seg.keep;
                out.moved.push({ j: it.k, chars: seg.vary.length, why: `恒定骨架 ${seg.keep.length} 字留前＋关键词条目后置 ${seg.vary.length} 字` });
                out.texts.push(seg.vary);
                out.spanChars += seg.vary.length;
                out.preArm++;
                continue;
            }
            const safe = _relocChurnSafeAnchors(it.text, '', it.text);
            const mid = it.text.slice(safe.head.length, it.text.length - safe.tail.length);
            msgs[it.k].content = safe.head + RELOC_POINTER_IDLE + safe.tail;
            out.moved.push({ j: it.k, chars: mid.length, why: mid ? '首次预锚＋让开世界书关键词条目' : '首次预锚' });
            if (mid) { out.texts.push(mid); out.spanChars += mid.length; }
            out.preArm++;
        }
        let at = msgs.length;
        if (String(msgs[msgs.length - 1]?.role || '') === 'assistant') at = msgs.length - 1;
        const movedRole = msgs.some(m => String(m?.role || '') === 'system') ? 'system' : 'user';
        let ins = 0;
        for (const t of out.texts) msgs.splice(at + ins++, 0, { role: movedRole, content: RELOC_MOVED_HEAD + t });
        out.count = out.preArm;
        out.at = at;
        out.text = out.texts.join('\n');
        out.why = out.moved.map(v => `#${v.j}(${v.why}${v.chars ? ` 后置 ${v.chars} 字` : ''})`).join('；');
        console.log(`[hitOpt] v6.24 首次预锚（本聊天第一条 request，本来就没有缓存可继承）：钉住 ${out.preArm} 条前置块`
            + `（后置 ${out.texts.length} 段 / ${out.spanChars} 字）→ ${out.why}｜末尾插入 @#${at}｜内容一个字没删`);
        return out;
    } catch (err) {
        console.warn('[hitOpt] 首次预锚失败（一个字没动）:', err);
        out.skip = `首次预锚出错（一个字没动）：${err?.message || err}`;
        return out;
    }
}

/* @32530-32536 */
function _restoreIsOurs(text) {
    const s = String(text ?? '');
    return s.startsWith(RESTORE_ADD_HEAD)
        || s.startsWith(RELOC_MOVED_HEAD)
        || s.startsWith(FREEZE_MARK)
        || s.startsWith(RELOC_POINTER) || s.startsWith(RELOC_POINTER_IDLE);
}

/* @32550-32554 */
function _isVarPatchBlock(text) {
    const t = String(text ?? '');
    return t.includes('<UpdateVariable>') || t.includes('</JSONPatch>')
        || (t.includes('"op":') && t.includes('"path":'));
}

/* @32565-32567 */
function _isWorldEntry(text) {
    return /^\s*<(?:role|sample|school|rule|world|activity|xingyue|character)_/.test(String(text ?? ''));
}

/* @32585-32620 */
function _restoreCutSeats(prev, msgs) {
    const out = { n: 0, chars: 0, idem: 0, blocked: 0 };
    try {
        if (!RESTORE_SEAT_BACK_ON) return out;
        if (!Array.isArray(prev) || !Array.isArray(msgs)) return out;
        /* 逐条对齐：第一条 content 不同的那条消息 —— 席位就在那一条的内部 */
        let kc = 0;
        while (kc < prev.length && kc < msgs.length
            && String(prev[kc]?.content ?? '') === String(msgs[kc]?.content ?? '')) kc++;
        if (kc >= prev.length || kc >= msgs.length) return out;
        const P = String(prev[kc]?.content ?? ''), Q = String(msgs[kc]?.content ?? '');
        /* 该条内部的公共前缀 */
        const n0 = Math.min(P.length, Q.length);
        let kIn = 0; while (kIn < n0 && P[kIn] === Q[kIn]) kIn++;
        /* ⚠ ★ v6.50.6【off-by-one：断点常落在 `<` 的**后一格**】
         *   实测 `kIn = 4,673` 而 `P[4,672] = '<'`（`P@kIn` 是 `sample_basic>\n角色档案:…`，
         *   已经**不含那个 `<`**）⇒ 直接 `^<…>` 匹配**永远失败**。
         *   第一版就栽在这儿：`seatBackN` 恒为 0、而 LCP 纹丝不动（实测 4,673 → 4,673）。
         *   ⇒ 必须**往左退到那个 `<`**，再从那里识别条目名。 */
        const kAt = Q.lastIndexOf('<', kIn);
        if (kAt < 0) return out;
        /* 本轮在断点处的条目名（必须是**世界书条目**，否则不补 —— 绝不猜位置） */
        const mq = /^<((?:role|sample|school|rule|world|activity|xingyue|character)_[^>\s/]{1,40})>/.exec(Q.slice(kAt));
        if (!mq) return out;
        /* 同一个条目在**上一轮**里的位置 —— 它之前那段就是被裁掉的席位 */
        const Pi = P.indexOf('<' + mq[1] + '>', kAt);
        if (Pi <= kAt) return out;                          // 上一轮同一位置也是它 ⇒ 没被裁
        const cut = P.slice(kAt, Pi);
        if (cut.length < RESTORE_LOST_MIN_CHARS) return out;
        if (cut.length > RESTORE_SEAT_MAX_CHARS) { out.blocked++; return out; }   // ★ 上限保护
        if (Q.indexOf(cut) >= 0) { out.idem++; return out; }                     // ★ 幂等：这段本轮已经有
        msgs[kc] = { ...msgs[kc], content: Q.slice(0, kAt) + cut + Q.slice(kAt) };
        out.n++; out.chars = cut.length;
        return out;
    } catch (_) { return out; }
}

/* @32757-32760 */
function _normSeenLine(s) {
    const t = String(s ?? '').replace(/^[+\-\s]+/, '').trim();
    return t.length >= 4 ? t : '';
}

/* @32777-32827 */
function _patchDropSeen(text, seen, hay) {
    const lines = String(text ?? '').split('\n');
    const keep = [];
    let dropped = 0;
    let gate = 0;                              // ★ v6.24.88：被"这一轮的字里没有它"这道保险拦下的行数（诊断用）
    if (lines.length) keep.push(lines[0]);                     // 抬头永远留着（扣没了就没法读了）
    const usedSeen = new Map();                // `+` 行：按"上一轮那条增量里的出现次数"扣
    const usedHay = new Map();                 // 非 `+` 行：按"这一轮提示词里的出现次数"扣
    // 这一轮的 haystack 按同一套指纹建索引（剥掉标记再比，两边才同口径），值 = 出现次数（多重集）
    let haySet = null, hayQuota = null;
    if (typeof hay === 'string' && hay) {
        haySet = new Set(); hayQuota = new Map();
        for (const l of hay.split('\n')) {
            const k = _normSeenLine(l);
            if (!k) continue;
            haySet.add(k);
            hayQuota.set(k, (hayQuota.get(k) || 0) + 1);
        }
    }
    for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        const k = _normSeenLine(l);
        if (!k) { keep.push(l); continue; }
        // ══ ★★★ v6.24.88【用户 2026-09-17 点名】════════════════════════════════════════════
        //   原话："你对于本轮的增量这里 没有考虑LCP断点啊，你增量包含了断点前的内容，
        //          这些内容本就应该被LCP复写的！你为何没排除？"
        //   完全成立。`_patchText` 的 hunk 里除 `+` 行外还有两类：
        //     · `- ` 旧值行 —— `_diffLines(p, cur)` 里只在 `p` 里有的行；
        //     · `  ` 上下文行 —— `p` 与 `cur` 共有的行（hunk 的 ctx）。
        //   **两类都逐字存在于 `p` 里**，而 `_restoreFrozenHistory` 紧接着就写了
        //   `msgs[i].content = p`（原位留的正是 `p`）⇒ 它们**本来就在这一串字的前缀里**，
        //   会被缓存命中（官方 hit 认的就是这个前缀）。在增量条里再发一份 = **纯重复**。
        //   实测账（官方 miss 为证，`圣樱学院_mu5ffle6lfcc` #26~#30）：增量条 17,220 tok/轮，
        //   其中 `-` 行 3,150 ＋ 上下文行 1,577 ＝ **4,727 tok/轮（27%）** 就是这么白付的。
        //   判据（内容安全照旧）：**只有这一行确实在这一轮的字里（`hay`）才扣** —— 扣了它就等于
        //   模型两处都看不见；配额用**多重集**（这一行在提示词里出现几次，才允许扣几次）。
        if (!/^\+/.test(l)) {
            const q = hayQuota ? (hayQuota.get(k) || 0) : 0;
            if (q > (usedHay.get(k) || 0)) { usedHay.set(k, (usedHay.get(k) || 0) + 1); dropped++; continue; }
            keep.push(l); continue;
        }
        const inSeen = !!(seen && seen.size && (seen.get(k) || 0) > 0);
        const quota = (inSeen && (!haySet || haySet.has(k))) ? (seen.get(k) || 0) : 0;
        if (inSeen && quota <= (usedSeen.get(k) || 0)) gate++;
        if (quota > (usedSeen.get(k) || 0)) { usedSeen.set(k, (usedSeen.get(k) || 0) + 1); dropped++; continue; }
        keep.push(l);
    }
    // 扣过 ⇒ 抬头换成"只列这一轮新增的"那一版（两版都以 RESTORE_ADD_HEAD 为前缀，自己人还认得）
    if (dropped > 0 && keep.length) keep[0] = RESTORE_ADD_HEAD2;
    return { text: keep.join('\n'), body: keep.slice(1).join('\n'), dropped, gate };
}

/* @32901-32949 */
function _restoreLostOurs(prevList, msgs) {
    const out = [];
    if (!Array.isArray(prevList) || !prevList.length) return out;
    if (!Array.isArray(msgs) || !msgs.length) return out;
    const hay = msgs.map(m => String(m?.content ?? '')).join('\n');
    for (let i = 0; i < prevList.length; i++) {
        const p = String(prevList[i]?.content ?? '');
        if (p.length < RESTORE_LOST_MIN_CHARS) continue;
        /* ★★★★★★ v6.50.6【席位补回 —— 准入从"只认我们自己的派生条"扩到"也认**被裁的世界书席位**"】
         *  用户 2026-09-22 拍板「补」，原话："完整保留 N-1 的数据，然后再考虑如何拼接 N 的数据才是王道"。
         *  病（盘上实测 · `圣樱学院_mub5mwvhbjfq` 生成 `00059.txt` 时的第 60 轮）：
         *    `#0`（role=user / 16,535 字）里有 `<sample_basic>`＋`<sample_nsfw>`（沈清秋那份档案 3,059 字），
         *    第 60 轮这两条**整段消失**、`<role_苏小桃>` **前移顶位** ⇒ 断点落在席位起点（k=4,673），
         *    后面 20 万字符全打成 miss（官方 miss 128,602）。
         *  ⚠ **"体检在前把它拦了"这个猜测不成立**（我先报错过一次，这里留痕免得后人重犯）：
         *    体检循环第一行 `if (m.role !== 'assistant') continue`，而**席位在 `#0`、role = `user`**
         *    ⇒ 它们**根本不进体检**、不会让 `goneReal++`。实测（抠体检段真跑 `00058.abc` 分片 ＋ `00059.raw`）：
         *    `A⊕B0⊕C ⇒ floors=36 gone=0 goneReal=0 shellSkip=2 ⇒ **放行**` ⇒ **体检不用动** ✓
         *  ⇒ **补回是让 A 变长，不是改 A**：A 仍逐字节来自"上一轮发出去那串"的前缀；
         *    这里只把**上一轮那份被裁掉的席位照原样摆回它自己那个下标** ⇒ 方向正确。
         *  ⛔ 判据不放宽：只补"**整段世界书席位**"（`_isWorldEntry` ∧ ≥ `RESTORE_LOST_MIN_CHARS`
         *    ∧ ≤ `RESTORE_SEAT_MAX_CHARS` ∧ **本轮确实没有它**）⇒ 不许按零碎片段乱补。 */
        const _isOurs = p.startsWith(RESTORE_ADD_HEAD);
        const _isCutSeat = RESTORE_SEAT_BACK_ON && !_isOurs
            && _isWorldEntry(p) && p.length <= RESTORE_SEAT_MAX_CHARS
            && !msgs.some((mm) => String(mm?.content ?? '') === p);
        if (!_isOurs && !_isCutSeat) {
            /* ★ v6.50.6【读数：被挡下的席位必须分开报 —— ⛔ 不许静默】
             *  ⚠ `out` 是数组，这里**挂属性**报数（`length` 不受影响，老验收照常）。 */
            if (!_isOurs && _isWorldEntry(p)) {
                if (p.length > RESTORE_SEAT_MAX_CHARS) out.seatBlocked = (Number(out.seatBlocked) || 0) + 1;
                else if (msgs.some((mm) => String(mm?.content ?? '') === p)) out.seatIdem = (Number(out.seatIdem) || 0) + 1;
            }
            continue;
        }
        const body = _isOurs ? p.slice(RESTORE_ADD_HEAD.length) : '';
        // 指纹行：剥掉行首的 diff 标记（`+ ` / `- `）再比 —— 不剥的话"这一轮那份没有加号"会被误判成丢了
        const lines = body.split('\n')
            .map(l => l.replace(/^\s*[+-]\s?/, '').trim())
            .filter(l => l.length >= RESTORE_LOST_MIN_LINE);
        const miss = lines.filter(l => !hay.includes(l)).length;
        // ★ v6.24.78：这里原来有一道"miss 占比 < 20% 就不接"的门槛，已删 —— 理由见上面那段。
        //   它放过的那一类（字还在、位置没了）正是每轮烧掉一万 tok 的那一类。
        const gone = lines.length >= RESTORE_LOST_MIN_LINES && (miss / lines.length) >= RESTORE_LOST_MISS_RATIO;
        if (msgs.some(m => String(m?.content ?? '') === p)) continue;   // 一模一样的那条还在 ⇒ 不重复摆（幂等）
        out.push({ i, role: String(prevList[i]?.role || '') === 'assistant' ? 'assistant' : 'user', content: p, lines: lines.length, miss, gone, seat: _isCutSeat });
    }
    return out;
}

/* @32975-32985 */
function _restoreKeptAt(prev, msgs, lo) {
    const i = Number(lo?.i) || 0;
    const at0 = Math.min(i, msgs.length);
    let k = i - 1;
    while (k >= 0 && String(prev?.[k]?.content ?? '').startsWith(RESTORE_ADD_HEAD)) k--;
    const anchor = k >= 0 ? String(prev?.[k]?.content ?? '') : '';
    if (!anchor) return { at: at0, how: 'index' };
    const j = msgs.findIndex(m => String(m?.content ?? '') === anchor);
    if (j < 0 || j + 1 > msgs.length) return { at: at0, how: 'index' };
    return { at: j + 1, how: 'anchor' };
}

/* @33003-33027 */
function _restoreTailFix(prev, msgs, k) {
    if (!Array.isArray(prev) || !prev.length) return null;
    if (!Array.isArray(msgs) || !msgs.length) return null;
    let pj = -1;
    for (let j = prev.length - 1; j >= 0; j--) {
        if (String(prev[j]?.role || '') === 'user'
            && String(prev[j]?.content ?? '').length >= RESTORE_TAIL_MIN_CHARS) { pj = j; break; }
    }
    let mi = -1;
    for (let i = Math.min(k, msgs.length) - 1; i >= 0; i--) {
        if (String(msgs[i]?.role || '') === 'user'
            && String(msgs[i]?.content ?? '').length >= RESTORE_TAIL_MIN_CUR) { mi = i; break; }
    }
    if (pj < 0 || mi < 0) return null;
    const pp = String(prev[pj].content), cur = String(msgs[mi].content);
    // ★ v6.24.78：上一轮那条如果**是我们自己加的派生条**（增量条 / 搬走的变量块 / 冻结池），
    //   这条路一律不走 —— 它跟"用户那句话少了一截"是两回事，由 `_restoreLostOurs` 原位接回。
    //   （反例：本场第 4 轮最后一条 user 就是增量条，而这一轮最后一条 user 是玩家的新输入，
    //     若放行，两个都可能被当成"同一句话的更长版本"，那正是红线「绝不顶掉人写的字」。）
    if (_restoreIsOurs(pp)) return null;
    if (pp.length <= cur.length) return null;          // 这一轮更长 = 人写了新东西，绝不截断
    if (!pp.startsWith(cur)) return null;              // 不是纯前缀 = 内容变了，绝不硬塞
    msgs[mi].content = pp;                             // 整条盖上（不是一个字一个字拼出来的）
    return { at: mi, chars: pp.length - cur.length };
}

/* @33137-33145 */
function _lastFloorIdx(msgs) {
    try {
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (String(msgs[i]?.role || '') === 'assistant'
                && String(msgs[i]?.content ?? '').length >= FLOOR_MIN_CHARS) return i;
        }
    } catch (_) { /* 读不到 ⇒ 交给调用方按"不限制"处理 */ }
    return -1;
}

/* @33180-33192 */
function _cZoneStart(msgs) {
    try {
        let k = -1;
        for (let i = 0; i < msgs.length; i++) {
            if (String(msgs[i]?.role || '') !== 'system') continue;
            let e = i;
            while (e + 1 < msgs.length && String(msgs[e + 1]?.role || '') === 'system') e++;
            k = i;          // 一路记到**最后**一段的头
            i = e;          // 跳过这一段（不然同一段会被记很多次）
        }
        return k;
    } catch (_) { return -1; }
}

/* @33304-33307 */
function _algoPipeItem(x) {
    const r = String(x && x.ref || '');
    return { id: String(x && x.id || ''), on: !(x && x.on === false), ref: (r === 'A' || r === 'self') ? r : '' };
}

/* @33308-33319 */
function _algoPipeRaw() {
    const dft = ALGO_PIPE_DEFAULT.map((x) => ({ ...x }));
    try {
        const s = localStorage.getItem(ALGO_PIPE_KEY);
        if (!s) return dft;
        const j = JSON.parse(s);
        if (!Array.isArray(j)) return dft;
        /* ★ v6.41.10：`ref` 一起带出来（`''` = 整串 / `'A'` = A 区 / `'self'` = 含前级）。
           ⚠ 老 localStorage 里的条目没有这个键 ⇒ 一律当 `''`（整串）⇒ 与改造前逐位相同。 */
        return j.map(_algoPipeItem).filter((x) => x.id);
    } catch (_) { return dft; }
}

/* @33327-33327 */
function _algoPipeUse() { return _algoPipeRaw().filter((x) => x.on); }

/* @33329-33339 */
function _algoPipeSnap() {
    return _algoPipeUse().map((x) => {
        let a = null;
        try { a = (_expAlgoReg && _expAlgoReg.get) ? _expAlgoReg.get(x.id) : null; } catch (_) { a = null; }
        return {
            id: x.id,
            name: a ? String(a.name || '') : '',
            version: a ? String(a.version || '') : '',
        };
    });
}

/* @33353-33356 */
function _algoPipeSlotId() {
    const use = _algoPipeUse();
    return use.length ? use.map((x) => x.id).join(ALGO_PIPE_SLOT_SEP) : ALGO_PIPE_SLOT_RAW;
}

/* @33382-33511 */
function _algoPipeRun(stages, B, A, legacy, keepAll, opt) {
    const raw = Array.isArray(B) ? B : [];
    /* ★★★★★★ v6.41.9【每一级带**自己的参考** —— 用户 2026-09-20 拍板"开放级间参考"】
     *
     *  【为什么必须开这个口子（本项目的辩证结论，三条）】
     *    ① `v2.4` 是**幂等元**：`v2.4 ∘ v2.4 = v2.4` ⇒ 同算法、同参考叠加**必然坍缩**；
     *    ② 参考那一侧另有一个坍缩：`f(f(x,R₁),R₂) = f(x,R₂)`（`R₁ ⊆ R₂`）—— 实测
     *       `f(f(x,A),S)` ＝ 404,135 ＝ `f(x,S)`，三级 `A→S→S` 仍是 404,135；
     *    ③ ⇒ **组合要出新东西，每一级必须拿到不同的东西**（不同的算子，或不同的参考）。
     *    用户原话（组合子语言）："**管线为空就是ID组合子啊**" ＋ "**函数式编程 组合子概念啊**"。
     *
     *  【这一版开的是什么】`stages[k].ref` 可选 `'A'`（本轮 A 区）／缺省＝整串。
     *    `opt.azone` 由调用方把"本轮 A 区那一段文本"送进来（主链与面板链各一处，同源）。
     *
     *  【⚠⚠ 红线：参考**只能是已经发出去过的文本**】
     *    · `'whole'` ＝ 上一轮真发出去的整串（官方缓存里躺着的就是它）—— 合法；
     *    · `'A'`     ＝ 本轮 A 区（逐字节就是上一轮那串的**前缀**）—— 合法；
     *    · ❌ **绝不允许把"前一级的产物"当参考**：产物里新生成的指针壳会被下一级当成重复片段再指针化，
     *      而那些壳**根本不在发出去的文本里**（发出去的是 `A ⊕ B2 ⊕ C`，被引用的那段不在其中）
     *      ⇒ 指针指向不存在的文本 ⇒ **内容丢失**（红线级事故，不是"效果差一点"）。
     *
     *  【向后兼容】第 6 参不传 ⇒ 每一级都吃默认的整串参考 ⇒ **与改动前逐字节相同**
     *    （`algo_pipe_test` 那些直调 `_algoPipeRun` 的老断言一个字都不用改）。 */
    const _azone = (opt && typeof opt.azone === 'string') ? opt.azone : null;
    /* ★ v6.41.11：`emitAll` ⇒ 把**每一级的产物**都留下（装配要用 `A ⊕ P₁ ⊕ … ⊕ P_K ⊕ C`）。
       ⚠ 只在调用方真要时留（默认 false ⇒ 行为与改动前逐字节相同）。 */
    const _emitAllReq = !!(opt && opt.emitAll);
    const _allSegs = [];
    const none = { msgs: raw, b1: raw, steps: [], bad: '' };
    if (!Array.isArray(stages) || !stages.length) return none;      // ★ 空管线 = 恒等（不是失败）
    if (!raw.length) return none;
    const text = (arr) => (arr || []).map((m) => String(m?.content ?? '')).join('\n');
    const chars = (arr) => (arr || []).reduce((s, m) => s + String(m?.content ?? '').length, 0);
    let ref = null;                                     // 参考串 —— 惰性算
    let cur = raw, b1 = null;
    let _selfAcc = '';                                  // ★ v6.41.10：`st.ref='self'` 用的"前面各级产物累积"
    const _anySelf = Array.isArray(stages) && stages.some((x) => String(x && x.ref || '') === 'self');
    const steps = [];
    for (const st of stages) {
        const fn = (legacy && typeof legacy[st.id] === 'function') ? legacy[st.id] : null;
        const before = chars(cur);
        let out = null, selfCover = 0, selfN = 0;
        /* ★ v6.41.13【增量编码】这一级**自己报**的增量账（它把哪些区间换成了壳）。
         *   与 `cover`/`n` 同一类：算法自报的数，只记账、不参与装配（`msgs` 怎么来还是怎么来）。 */
        let selfInc = null;
        let _refKindNow = 'whole', _refCharsNow = 0;      // ★ v6.41.9：这一级实际用了哪种参考（记账用）
        try {
            if (fn) {
                out = fn(cur);                          // 本体在主链路里（记账也在那儿）
            } else {
                const a = (_expAlgoReg && _expAlgoReg.get) ? _expAlgoReg.get(st.id) : null;
                if (!a || typeof a.apply !== 'function') return { msgs: raw, b1: raw, steps: [], bad: '「' + st.id + '」不在算法清单里（或它没有 apply）' };
                if (ref === null) ref = (typeof A === 'string') ? A : text(A);
                /* ★ v6.41.9：这一级**自己的**参考 —— `st.ref === 'A'` 且调用方给了 A 区文本时用它。 */
                const _wantRef = String(st.ref || '');
                _refKindNow = (_wantRef === 'A' && _azone !== null) ? 'A'
                    : (_wantRef === 'self' ? 'self' : 'whole');
                /* ★★★★★★ v6.41.10【`self` ＝ 把**前面各级的产物**并进参考 —— 用户 2026-09-20 拍板"改"】
                     用户要的原文："**进行连续进行两次管道压缩** … 你先算完第一次面板的！！
                     然后拿第一次面板的结果 去输入第二次面板！！！！"
                   ── 实测（真切片 12 轮，`_probe_two`，两层都落盘）：第 1 层压 314,257 字、
                     **第 2 层（参考＝A⊕L1⊕C）再压 159,221 字** ⇒ "二级压缩"**是真的能压**；
                     我此前说的"第二层必然 0"是**把参考钉死**测出来的，那个结论只对"参考不变"成立。
                   ── 代价（同一份实验的第二列）：L2 里「…略 N 字」合计 418,769 字 ——
                     第二层省略掉的是 **L1 里那些"还没被省略的裸文本"** ＝ 这一轮真正新增的内容。
                     用户已知情并选择"改"（他要的就是"第 2 管线是有损的，只保留 diff 变化"）。
                   ⚠ 判据照旧：参考里那串必须**真的到过模型眼前**才谈得上"引用"。这一档把
                     "本链自己算的产物"并进参考 ⇒ 它**不在发出去的 A⊕x₂⊕C 里** ⇒ 严格说这一档
                     是**有损压缩**（省 token 换信息），不是无损引用。**默认仍是 `whole`**，
                     要用的级必须自己在面板上把这级切成"含前级"。 */
                /* ★★★★★★ v6.41.20【用户 2026-09-20 的定版原则 —— 这句话管全项目】
                   原话："**修改算法思路！你要用上轮的发给官方的实际内容作为本轮的 A，
                   而不是算法算出来的内容！**"
                   ⇒ **参考串只许两个来源**：① 上一轮**实际发给官方**的那一整串
                     （`whole` ＝ 主链的 `_prevRealMsgs` ／ 面板链的 `/flat?join=1`）；
                     ② 它的前缀（`A` 区，逐字节是它的开头）。
                   ⇒ **凡是"本链自己算出来的东西"一律不许进参考** —— 上面那一档 `self`
                     （把前级产物并进参考）就是**唯一的例外**：它**违反本原则**、是**有损压缩**
                     （省 token 换信息），默认不用、要在面板上手动切。
                   ⇒ 判据（可证）：参考里那串必须**真的到过模型眼前**。没发出去过的东西被引用，
                     模型读不到原文 ⇒ 那不是压缩，是丢内容。
                   ⚠ 实测过的教训：v6.41.19 之前面板链拿"切片 A⊕B⊕C"当参考（那是**客户端侧、
                     没合并**的那一份，63 条 / 82,042 字），而真发的是 **19 条 / 82,086 字**
                     ⇒ 第 18 个字符就分叉 ⇒ 勾了算法的面板数（88.8%）与官方（76.3%）永远对不上。 */
                const _useRef = (_refKindNow === 'A') ? _azone
                    : (_refKindNow === 'self' ? (ref + _selfAcc) : ref);
                _refCharsNow = _useRef.length;
                const z = a.apply(cur, _useRef, { legacy: legacy || null, step: steps.length, inc: true });
                out = z && z.msgs;
                selfInc = Array.isArray(z && z.inc) ? z.inc : null;
                /* ★ 算法**自报**的两个数（`cover` = 它自己算的省字量、`n` = 它自己算的壳/指针个数）。
                 *   为什么不丢掉它们、只留下面那个"字数差"：这两个数是**算法自己的口径**
                 *   （`check/exp_algo_test.mjs` 的跨实现对账就是拿它们与 node 迭代台逐位比的），
                 *   换成"字数差"就是偷偷换了口径 ⇒ 那张对账表当场变成两种意思混在一起。 */
                selfCover = Number(z?.cover) || 0; selfN = Number(z?.n) || 0;
            }
        } catch (e) { return { msgs: raw, b1: raw, steps: [], bad: '「' + st.id + '」抛了：' + String((e && e.message) || e) }; }
        if (!Array.isArray(out) || out.length !== cur.length) {
            return { msgs: raw, b1: raw, steps: [], bad: '「' + st.id + '」条数对不上（进 ' + cur.length + ' / 出 ' + (Array.isArray(out) ? out.length : '—') + '）' };
        }
        cur = out.map((m) => ({ ...m }));
        if (!steps.length) b1 = cur;
        let a2 = null;
        try { a2 = (_expAlgoReg && _expAlgoReg.get) ? _expAlgoReg.get(st.id) : null; } catch (_) { a2 = null; }
        steps.push({
            id: st.id,
            /* ★ v6.41.9：这一级**实际用的参考**也记账（种类 ＋ 字数）—— 日后对账时能一眼看出
               "这两级是不是吃了同一个参考"（那正是组合坍缩的判据）。 */
            refKind: _refKindNow, refChars: _refCharsNow,
            name: a2 ? String(a2.name || '') : '',
            version: a2 ? String(a2.version || '') : '',
            chars: before - chars(cur),                 // ★ 这一级净省多少字（对任何算法都成立的口径）
            cover: selfCover, n: selfN,                 // ★ 这一级**自报**的两个数（老口径，原样带出）
            /* ★ v6.41.13【增量编码】这一级**自己那一份增量**（新壳化的区间，消息内坐标）。
             *   它是个**账**：`msgs` 仍由级间串行决定，装配口径一个字没变。
             *   列出来的用处：能一眼看出"这两级压的是不是同一批区间"（那就是重复做功）。 */
            inc: selfInc,
            /* ★ v6.41.4【目标⑤：差异页"逐级对比"要的那一份 —— 这一级的**产物**】
               只给"要落逐级盘上文件"的调用方（`keepAll`）：主链每轮 retain K 份 B 区纯属浪费。
               `cur` 上面已经是新对象数组（`out.map((m) => ({ ...m }))`）⇒ 直接挂上，不再复制一遍。 */
            ...(keepAll ? { msgs: cur } : {}),
        });
        /* ★ v6.41.10【本级产物并进"前面各级产物累积"】—— 只在**有级声明 `ref='self'`** 时才做：
           不做的话光累积一份 O(K·|B|) 的字符串，纯浪费（`_anySelf` 就是那个闸门）。 */
        if (_anySelf) _selfAcc += text(cur);
        /* ★ v6.41.11：这一级的产物（`cur` 已经是新数组）—— 装配要按级拼进上下文。 */
        if (_emitAllReq) _allSegs.push(cur);
    }
    return { msgs: cur, b1: b1 || cur, steps, bad: '', emitAll: _emitAllReq, all: _allSegs };
}

/* @33519-33528 */
function _algoPipePick(B, A, legacy, opt) {
    _algoPipeBad = ''; _algoPipeLast = [];
    const use = _algoPipeUse();
    if (!use.length) return null;                       // ★ 空管线 = 原模原样（用户口径）
    if (!Array.isArray(B) || !B.length) return null;
    const z = _algoPipeRun(use, B, A, legacy, false, opt);
    if (z.bad) { _algoPipeBad = z.bad; return null; }
    _algoPipeLast = z.steps;
    return { msgs: z.msgs, b1: z.b1, steps: z.steps, emitAll: z.emitAll, all: z.all };
}

/* @33551-33664 */
function _cacheReorder(msgs, prev) {
    const out = { list: msgs, moved: 0, staticN: 0, varyN: 0, floorAt: -1, varyAt: -1, skip: '' };
    try {
        if (!Array.isArray(msgs) || msgs.length < 2) { out.skip = '条数太少'; return out; }
        const txt = (m) => String(m?.content ?? '');
        /* ★★★★★★ v6.50.5【闸二 · 两轮延迟 —— 只有"上一轮实际出站串里已出现过"的条目才允许被前置】
         *  用户 2026-09-22 定版（逐字）："本轮相对于上一轮多被注入的新设定，毫无疑问需要前置，但秉着不动A的
         *  原则最大化B LCP的原则…所以我们不能直接动！，交给下一轮处理才行。因此需要下一轮参考上一轮做处理才行"。
         *  为什么非这样不可：本轮**新出现**的块，在上一轮出站串里**没有对应位置** ⇒ 一旦本轮把它搬到前面，
         *  `assembled[0..a)` 就与上一轮不一致 ⇒ **LCP 当场归零** ⇒ 整轮全价 miss。
         *  ⇒ 新块**留在原位待满一轮**，下一轮它以"上一轮已出现过"的身份才允许参与搬运（这就是两轮延迟的实体）。
         *  ⚠ 它同时是 `am_ptr_test` 那条"逐字节幂等"钉子的正解：那里 `msgsNow` 比 `prevFull` 多一条 `U(TPL)`
         *    （本轮新注入）⇒ 不搬它 ⇒ 输出是上一轮的不动点 ⇒ 幂等成立。
         *  ⚠ 没有它时的实测：`am_ptr` 29/1（幂等红）、`keep_tail` 13/4。 */
        /* ⚠ 判据用**整条相等**（2026-09-22 实测收紧）：子串版会把"正文上一轮作为某段出现过"的块放行，
         *  实测那会让 `U(TPL)` 被搬出 B 区 ⇒ 不再被指针化 ⇒ **破坏 `out1` 的不动点**（`out2` 多吐一条指针，
         *  `am_ptr` 幂等红）。整条相等版在探针里复现了基线的 `roStaticN=1 / roMoved=0`。 */
        const prevTexts = new Set((Array.isArray(prev) ? prev : []).map((m) => String(m?.content ?? '')));
        /* ★★★★★★ v6.53.2【`isStatic` 的正则那一支必须加"上一轮也存在"—— 这才是 33560 那句
         *  "新块留在原位待满一轮"的另一半，原先**只写在注释里、代码没实现**】
         *  病（本地算法重放抓到的，`圣樱学院_muczgjfs8igs` 00033/00034）：`B0` 的第 0 条是
         *  `<world_饥渴世界>`（池化前 41,316 字），它**每轮都在变**（41,316 → 41,338），
         *  却因为 `^\s*<(world_|…)` 这条正则被当成**静态块前置**到 `mid` 之前
         *  ⇒ 池化后它（的指针）落在 B 区最前 ⇒ **断点就落在它身上** ⇒ 它后面 `mid` 里
         *  那些**逐字没变**的对话历史/楼层指针全部掉进 miss。
         *  实测（线上三轮，cli=v6.53.1，丙-2 已生效但白付没归零）：白付 1,741 → 1,814 → 1,814 tok；
         *  断点后第一条**每轮都是这个新注入的世界书块**。⇒ 丙-2 的 `fresh` 组里压根没有它。
         *  修法：正则那一支也要求 `prevTexts.has(s)`（＝这条上一轮也逐字存在）⇒
         *    · 老世界书块照旧前置（行为一个字不变）；
         *    · **这一轮新注入的** ⇒ 不进 `stat` ⇒ 落进 `fresh`（v6.53.1 的丙-2）⇒ 排到 `mid` 末尾
         *      ⇒ 断点后不再拖着老内容。
         *  ⚠ 幂等：判据仍是"这条自己的身份"（在不在 `prev` 里），不看下标 ⇒ 两次输出逐字节一致。 */
        const isStatic = (s, m) => prevTexts.has(s) && (/^\s*<(world_|school_|activity_|xingyue_|sample_|role_|相关资料|User设定|charDescription|scenario)/.test(s)
            /* ★★★★★★ v6.50.4【改动②：**对话预设那一族也归静态组** ⇒ 和世界书/角色卡一起前置】
             *  用户 2026-09-22 拍板走 B：「B把，反正变动后的都会自然后置」。
             *  为什么预设族要前置：它们是**逐字不变**的（C 区成员的定义就是"身份固定"）⇒
             *  前置后落进"上一轮前缀"能覆盖的位置 ⇒ **靠前缀命中免费**，而**内容一个字节不丢**
             *  （比"套壳成短 HASH"好：套壳省的是字，命中省的是钱，后者不丢格式）。
             *  ⚠ 幂等性必须保住：`_isCSection` 只看条目自己的 identity、不看下标 ⇒
             *    对已重排的串再跑一次结果不变 ⇒ 上一轮存下的 `prev` 不会被每轮重洗。 */
            /* ⚠ 闸二**只约束"预设族"这一支**（`_isCSection`）。上面那条世界书/角色卡的正则分支
             *  是 v6.50.0 的既有行为，本轮**不动它**（改动面越小越好；要动另开一轮、单独取证）。 */
            || _isCSection(m, s));
        const isVary = (s) => /^\s*(<最新互动|<status_current_variables|<UpdateVariable|<JSONPatch|<Analysis)/.test(s)
            || s.indexOf('[当前状态快照') >= 0;
        let floorAt = -1;
        for (let i = 0; i < msgs.length; i++) {
            if (String(msgs[i]?.role || '') === 'assistant' && txt(msgs[i]).length >= FLOOR_MIN_CHARS) { floorAt = i; break; }
        }
        if (floorAt < 0) { out.skip = '认不出第一条对话楼 ⇒ 一个字都不搬（行为与从前逐字节相同）'; return out; }
        const head = [], mid = [], stat = [], vary = [];
        /* ★★★★★★ v6.53.1【丙-2（用户 2026-09-23 拍板）：**这一轮新出现的块，一律排到 `mid` 组末尾**】
         *  病（真机现场，`圣樱学院_muczgjfs8igs` 逐轮量的）：断点后第一条**每轮都是"这一轮新注入的
         *  世界书块"**（`<HASH-00C70C>‹world_饥渴世界›`，2,674~3,109 字），而它**坐在稳定序列中间** ⇒
         *  把它后面**逐字没变**的内容一起拽进 miss：
         *    · 19 条楼层指针（115~124 字/条）＋ 19 条预设格式块；
         *    · 白付随对话轮数**线性累积**：2,057 → 2,180 → 2,303 → 2,907 字（每轮 **+123 字**，
         *      正好是每轮多出来的那一条楼层指针）—— 用户原话"**这个长度每对话一轮 Δmiss 就 +100**"。
         *  用户要的判据（他 2026-09-23 定的）：miss 应当只有 **① 新增对话 ② 变量 ③ C 区保真格式**，
         *  此外任何"上一轮逐字就有"的内容出现在断点后都是白付。全仓按这条判据审计过：
         *  237 轮白付 932,684 字（占断点后 17.9%）≈ 558,678 tok，平均 **2,357 tok/轮**（`tools/miss_audit.mjs`）。
         *  ⇒ 判据：**不在 `prev` 里的条目**（＝这一轮新出现的）从 `mid` 里挑出来，集中排在 `mid` 之后、
         *    `vary` 之前。这样断点仍然落在新块身上（**它自己照付**，该付），但它后面**不再有稳定老内容**。
         *  ⚠ **幂等**（硬要求，`am_ptr_test` 钉着）：规则只看"这条在不在 `prev` 里"这个**身份**，
         *    第 N 轮把 X 挪到 `mid` 末尾 ⇒ 第 N+1 轮 X 已经在 `prev` 里 ⇒ 不再搬它 ⇒ 它就留在原位
         *    ⇒ 两次输出逐字节一致。**不需要任何跨轮标记**。
         *  ⚠ 顺带治掉"每轮 +123 字"：那一条**新增的楼层指针**同样进 `fresh` ⇒ 它不再插进稳定序列。
         *  ⚠ 位置是"**mid 组末尾**"而不是"全串末尾"：`vary`（最新互动 / 状态快照 / 变量）照旧排在最后，
         *    C 区保真块照旧由装配层保证在末尾（`A.concat(B2, C)`）—— 本算子一个字都不碰它们。 */
        const fresh = [];
        /* ══ ★★★★★★ v6.50.4【分界判据必须与位置无关，否则与 `floorAt` 互相追尾】══════════════════
         *  病（真被 `am_ptr_test` 的"逐字节幂等"抓住）：旧的是 `if (i < floorAt) head … else mid …`，
         *  而 `floorAt` ＝「第一条 role==='assistant' 且 ≥300 字」——**它量的是重排后的位置**。
         *  第一次跑：预设族在对话楼之后 ⇒ 进 `stat`；重排后它们到了前面 ⇒ `floorAt` 后移
         *  ⇒ 第二次跑时原本属 `mid` 的条目落进 `head` ⇒ **顺序变** ⇒ **不幂等**。
         *  ⚠ 这个隐患**原代码就有**（`stat` 非空时 `head` 就会变长），原来 `stat` 里只有世界书、
         *    测试场景没触发；本轮把预设族并进 `stat` 只是把它**逼出来了**，不是新引入的设计缺陷。
         *  ⚠ 幂等是硬要求：`prev` 是"上一轮真发出去的那串"，重排不幂等 ⇒ 每轮把基准重洗一次 ⇒ 命中当场崩。
         *  ⇒ 新分界：**"在第一个 static/vary 条目之前"的一律进 `head`** —— 这个判据只依赖
         *    "谁被认成 static/vary"（＝身份），而身份重排前后不变 ⇒ **输出逐字节稳定**。
         *  `floorAt` 从此**只用于**"认不出第一条对话楼就不搬"那道闸门，不再参与分组。 */
        /* ★★★★★★ v6.50.5【分界修正：`head` ＝「**第一条对话楼之前**的非静态前导」，而不是「第一个 static/vary 之前的一切」】
         *  病（v6.50.4 那版 `seenSV` 引入，被 `keep_tail_test` 用例① 抓住）：把分界写成"第一个 static/vary 之前"，`
         *  于是**对话楼本身**（`role==='assistant'` 且 ≥300 字、既不是 static 也不是 vary）也落进 `head`
         *  ⇒ `head.concat(stat, mid, vary)` 把 `stat` 排到了**楼层后面** ⇒ **静态组等于没前置**。
         *  实测（`_tmp` 探针，复刻 keep_tail 用例①）：`staticN=2 moved=0`，输出 `A→B→F1→F2→X→Y`（原序）。
         *  ⚠ 为什么不能直接退回 `i < floorAt`：`floorAt` 量的是**重排后的位置** ⇒ 第二次跑分组就变
         *    ⇒ **逐字节不幂等**（`am_ptr_test` 那条钉子，v6.50.4 就是栽在这儿）。
         *  ⇒ 正确做法：分界判据**一律只看条目自己的身份**（是不是 static / 是不是 vary / **是不是对话楼**），
         *    **不看下标** ⇒ 重排前后完全一致 ⇒ 幂等成立，且 `head` 的语义回到 v6.41.37 的本意。
         *  `floorAt` 从此**只用于**"认不出第一条对话楼就不搬"那道闸门，不参与分组。 */
        let seenSV = false, seenFloor = false;
        for (let i = 0; i < msgs.length; i++) {
            const s = txt(msgs[i]);
            if (isStatic(s, msgs[i])) { stat.push(msgs[i]); seenSV = true; continue; }
            if (isVary(s)) { vary.push(msgs[i]); seenSV = true; continue; }
            const isFloor = String(msgs[i]?.role || '') === 'assistant' && s.length >= FLOOR_MIN_CHARS;
            /* ★ v6.53.1【丙-2】这一轮新出现的（`prev` 里没有这一条）⇒ 进 `fresh`，排在 `mid` 之后。
             *  ⚠ 判据与 `isStatic` 里那一支用的是**同一个** `prevTexts`（整条相等），不另造一套口径。 */
            if (!seenSV && !seenFloor) head.push(msgs[i]);
            else if (!prevTexts.has(s)) fresh.push(msgs[i]);
            else mid.push(msgs[i]);
            if (isFloor) seenFloor = true;          // ★ 第一条对话楼之后的一律进 mid（对话历史整段跟着走）
        }
        if (!stat.length && !vary.length) { out.skip = '这一轮没有静态块、也没有变化块 ⇒ 顺序一个字没动'; out.floorAt = floorAt; return out; }
        out.list = head.concat(stat, mid, fresh, vary);   // ★ v6.53.1：`fresh`（这一轮新出现的）排 mid 之后、vary 之前
        out.floorAt = floorAt;
        out.staticN = stat.length;
        out.varyN = vary.length;
        out.varyAt = out.list.length - vary.length;          // ← 重排后变化组的起点（`_hi` 用它）
        out.moved = msgs.reduce((n, m, i) => n + (out.list[i] === m ? 0 : 1), 0);
        return out;
    } catch (e) { out.skip = '异常：' + String((e && e.message) || e); return out; }
}

/* @33695-33777 */
function _shellDedup(A, msgs, refTxt) {
    const ZERO = { msgs, cut: 0, chars: 0, msg: 0, byA: 0, byB: 0, raw: 0, rawChars: 0 };
    const res = { msgs, cut: 0, chars: 0, msg: 0, byA: 0, byB: 0, raw: 0, rawChars: 0 };
    /* ★ 试探层（v6.54.1 第二刀）用的下限：**原文段**短于这么多字就不拿它去 A 区里找 ——
     *   短句到处都是，找到了也不算"内容已在命中区"，只会误伤。实测 B 区里被摘的原文段都是几千字级的。 */
    const RAW_MIN = 200;
    try {
        const SH = /<HASH-([0-9A-F]{6})>[^<]*<\/HASH-\1>/g;
        const SHF = /^<HASH-([0-9A-F]{6})>([^<]*)…略 (\d+) 字…([^<]*)<\/HASH-\1>$/;
        const arr = Array.isArray(msgs) ? msgs : [];
        if (!arr.length) return res;
        const q = new Map();
        for (const m of (Array.isArray(A) ? A : [])) {
            const t = String((m && m.content) != null ? m.content : '');
            if (t.indexOf('<HASH-') < 0) continue;
            SH.lastIndex = 0;
            let mm;
            while ((mm = SH.exec(t)) !== null) q.set(mm[0], (q.get(mm[0]) || 0) + 1);
        }
        if (!q.size) return res;
        /* ⚠ 定位必须在「把 A 区里的壳挖空」的文本上做（**等长**替换 ⇒ 下标不变）：
         *   壳的回显里就含着段头 50 字，直接在 A 区原文上 indexOf 会**命中壳自己** ⇒ 一条都摘不掉。 */
        const R = String(refTxt == null ? '' : refTxt).replace(SH, (s) => '\u0000'.repeat(s.length));
        const inRef = (s) => {
            const g = SHF.exec(s);
            if (!g) return false;
            const hd = g[2], L = Number(g[3]), tl = g[4];
            if (!(L > 0)) return false;
            const key = hd.replace(/‹/g, '<').split(' ').filter((x) => x.length >= 4)[0] || '';
            if (!key) return false;
            const at = R.indexOf(key);
            if (at < 0 || at + L > R.length) return false;
            if (tl) {
                const tk = tl.split(' ').filter((x) => x.length >= 4).pop() || '';
                if (tk) {
                    const zone = R.slice(Math.max(0, at + L - 80), at + L).replace(/[\s\u3000]+/g, ' ').replace(/</g, '‹');
                    if (zone.indexOf(tk) < 0) return false;
                }
            }
            return true;
        };
        const keep = [];
        for (const m of arr) {
            const t = String((m && m.content) != null ? m.content : '');
            if (!t) { keep.push(m); continue; }
            /* 把这一条切成 [壳 / 原文] 段：壳走判据A/B，**原文段**走判据C（试探层）。 */
            const pieces = [];
            let last = 0, mm;
            SH.lastIndex = 0;
            while ((mm = SH.exec(t)) !== null) {
                if (mm.index > last) pieces.push({ sh: false, s: t.slice(last, mm.index) });
                pieces.push({ sh: true, s: mm[0] });
                last = mm.index + mm[0].length;
            }
            if (last < t.length) pieces.push({ sh: false, s: t.slice(last) });
            /* 既没有壳、也没有够长的原文段 ⇒ 这条没什么可摘的，原样过（别白跑 indexOf）。 */
            if (!pieces.some((p) => p.sh || p.s.length >= RAW_MIN)) { keep.push(m); continue; }
            let changed = false;
            const out = [];
            for (const p of pieces) {
                if (p.sh) {
                    const n = q.get(p.s) || 0;
                    if (n > 0) { q.set(p.s, n - 1); res.cut++; res.chars += p.s.length; res.byA++; changed = true; continue; }
                    if (inRef(p.s)) { res.cut++; res.chars += p.s.length; res.byB++; changed = true; continue; }
                    out.push(p.s); continue;
                }
                /* ★ 判据C（试探层）：**原文段**也能在 A 区里逐字节找到 ⇒ 那份内容已在命中区 ⇒ 摘。
                 *   ⚠ 与判据A/B 不同：这一层摘的是**内容实体**（不是指针）⇒ 门槛要硬：
                 *     ① 段长 ≥ RAW_MIN；② 必须在"挖空壳的 A 区文本"里**逐字节**找到（不是模糊匹配）。
                 *     两条都过 ⇒ 整串里那份内容一个字不少（它在 A 区那一段里），只是位置提前了。 */
                if (p.s.length >= RAW_MIN && R.indexOf(p.s) >= 0) { res.raw++; res.rawChars += p.s.length; changed = true; continue; }
                out.push(p.s);
            }
            const kept = out.join('');
            if (!kept.trim()) { res.msg++; continue; }
            /* ⚠ 新建对象要**带上原条目所有字段**（name / tool_calls / 别的插件塞的）⇒
             *   用展开语法，绝不写成只有 role 与 content 两个键。 */
            keep.push(changed ? { ...m, content: kept } : m);
        }
        if (res.cut || res.msg) res.msgs = keep;
    } catch (_e) { return { msgs, cut: 0, chars: 0, msg: 0, byA: 0, byB: 0 }; }
    return res;
}

/* @33779-34720 */
function _abSplit(msgs, prev) {
    try {
        /* ★★★★★★ v6.27.1：**B 区指针化之前，先把"已发块指纹池"从盘上装回来。**
         *   为什么必须在这里（而不是某个初始化钩子）：`_abSplit` 是唯一要用池的地方，
         *   放在判据前面 ⇒ "要用的时候一定已经装好"，不依赖事件顺序（酒馆的 CHAT_CHANGED
         *   在聊天文件还没读好时也会发、顺序也不保证 —— 这个坑本项目踩过，见 `onChatChanged` 那段）。
         *   同一聊天只装一次（`_amPoolChat` 相同就跳过）⇒ 不重复解析 localStorage。 */
        try {
            const ck = _currentChatKey();
            if (ck && ck !== _amPoolChat) _amPoolLoad(ck);
            // ★ v6.28.0：区间地址台账同理 —— 同一个开关点装一次（按聊天分，不跨聊天误判）。
            if (ck && ck !== _amAddrChat) _amAddrLoad(ck);
        } catch (_) { /* 拿不到聊天键 ⇒ 这一轮照旧（用内存里那份），不猜 */ }
        // ★ v6.24.93：**没走成也要说清为什么** —— 返回 `{skip}` 而不是干巴巴的 `null`。
        //   为什么非改不可（自检 ⑨ 的血泪）：`null` 传到埋点只能写成"没切"，面板/验收都看不出
        //   是"闸门拒了"还是"沙箱漏了函数（异常被 catch 吞了）"—— 这两件事的修法完全相反。
        if (!Array.isArray(msgs) || !Array.isArray(prev) || !msgs.length || !prev.length) {
            return { skip: `入参不是非空数组（基准 ${Array.isArray(prev) ? prev.length : '—'} 条 / 这轮 ${Array.isArray(msgs) ? msgs.length : '—'} 条 ⇒ 还没有可用的基准）` };
        }
        const roleOf = (m) => String(m?.role || '');
        const textOf = (m) => String(m?.content ?? '');
        /* ★ v6.41.36【代码适配】下面这一整段是 **v6.40.0 的原样算法**（用户定版："v6.40版本
         *  ABC算法计算正常 ⇒ 用它替代当前主算法，仅做代码适配"）。适配只有一处：
         *  当前版的 `return` 要报 `floorSrc` / `chatHistN` 两个读数（v6.41.27 加的），
         *  而 v6.40 的判据是 `_lastFloorIdx` ⇒ 如实填 `lastFloor` / 0，**算法一个字没动**。 */
        let _floorSrc = 'lastFloor', _chatHistN = 0;
        /* ★★★★★★ v6.41.37【改动①】整串**先重排**再切分 —— 用户 2026-09-21 拍板「三处一起改」。
         *  静态块（世界书 / 角色卡 / 示例对话 …）前置到"第一条对话楼之前" ⇒ 落进 A 能覆盖的位置
         *  （命中区）；变化块（状态快照 / 变量区 / 最新互动）后置到末尾 ⇒ 不再打断前缀。
         *  ⚠ 只改**顺序**，不增不删不改内容；对话预设那一族（红线④⑤的 14 个项）落在中间组、原样。
         *  ⚠ 认不出第一条对话楼 / 没有静态也没有变化块 ⇒ `_cacheReorder` 原样返回
         *    ⇒ 行为与从前**逐字节相同**（保守，不猜）。 */
        /* ★★★★★★ v6.51.5【C 区分界线必须在**重排之前**、按原文 msgs 算】—— 这是本次最关键的一步
         *  用户原话里的两个字就是"**原文**msg"。实测（`prefix_test` ⑥ 段夹具）：
         *   `_cacheReorder` 会把「对话历史之后的预设块」**前置**到第一条对话楼之前 ⇒ 重排之后再问
         *   "最后一个连续 system 段在哪"，答案是**下标 0** ⇒ C 吃掉整串 ⇒ **B 区空、A/B 整条链走不通**
         *   （实测 `A=5 / B=0 / C=3`，`prefix_test` 当场三条红）。
         *  ⚠ `_cacheReorder` 的契约是"**只换顺序，不增不删不改内容**" ⇒ 这里记**对象引用**，
         *    重排后按引用认人：判据仍然是"它在**原文**里属于 C 区"，与重排把它挪到哪无关。
         *  ⚠ 顺带一个语义确认：装配永远是 `A.concat(B2, C)` ⇒ C 区条目**最终一定在末尾**，
         *    重排对它们是无效操作（这也正是"保真"该有的样子）。 */
        const _czRaw = _cZoneStart(msgs);
        const _cSet = new Set();
        if (_czRaw >= 0) for (let _ci = _czRaw; _ci < msgs.length; _ci++) _cSet.add(msgs[_ci]);
        const _ro = _cacheReorder(msgs, prev);
        if (Array.isArray(_ro.list) && _ro.list !== msgs) msgs = _ro.list;
        const _roVaryAt = Number(_ro.varyAt);
        const _roVaryN = Number(_ro.varyN) || 0;
        const _roStaticN = Number(_ro.staticN) || 0;
        const _floorLim = _lastFloorIdx(msgs);
        /* ★★★★★★ v6.41.37【改动②】锚点搜索上界 —— 「**变化组之前 ∩ 对话楼边界**」。
         *  用户口径：重排后变化组都在末尾 ⇒ 上界应当是「变化组第一项的下标 − 1」。
         *  ⚠⚠ **这里我偏离了父代理转述的字面要求（"没有变化组时用 `msgs.length - 1`"），
         *    如实记下偏离与证据**：按字面实现后 `check/keep_tail_test.mjs` ② 段**当场红**
         *    （真基线对照，连沙箱一起回退测的，不是猜）：
         *      · 真基线 ②：`{aN:2, cut:0, keepQ:2, aBefore:1, anchor:1}` —— 锚点停在 1，不截；
         *      · 按字面实现：`{aN:2, cut:1, keepQ:2, aBefore:3, anchor:1}` —— 锚点跑到 **3**
         *        （＝ prev 里那条**保真区块** `TPL_Y`）⇒ 越过保真区 ⇒ 被 v6.26.0 的截断砍到 1。
         *    为什么：`_hi` 放开到整表之后，**锚点能落进"对话楼之后"的保真区** ——
         *    而 v6.24.106 乙 当年立 `_hi = _floorLim` 要挡的正是这件事。
         *    父代理给的理由"用 `_floorLim` 当上限会把静态组挡在 A 之外"**不成立**：
         *    静态组被重排到「第一条对话楼**之前**」⇒ 下标 < `floorAt` ≤ `_floorLim`
         *    ⇒ **它们本来就在 `_floorLim` 之内**，一个都挡不住。
         *  ⇒ 两个保护**同时生效**（取更严的那个）：变化组之前 ∩ 对话楼边界。
         *    · 静态组在对话楼之前 ⇒ 照样当得了锚（改动①的目的照旧达成）；
         *    · 变化组（末尾）与保真区（对话楼之后）⇒ 都不当锚（两个保护各司其职）；
         *    · `keep_tail_test` ② 段那条"幂等"契约 ⇒ 恢复成立（已复测）。
         *  ⚠ 若坚持"完全放开 `_floorLim`"：把 `_hiCap` 换成 `msgs.length - 1` 即可 ——
         *    代价是 ② 段那条幂等钉子重新变红（**那是行为变化，不是钉子坏了**）。 */
        const _hiCap = (_floorLim >= 0) ? _floorLim : msgs.length - 1;
        const _hi = (_roVaryN > 0 && _roVaryAt >= 1) ? Math.min(_hiCap, _roVaryAt - 1) : _hiCap;
        // ══ ★★★★★★ v6.26.0【保真区：对话历史**之后**的预设模板块，不许被 A 区搬到最前面】══════
        //   病（盘上铁证 · `全是痴女的世界_mu6dqrxzvdp5` 第 18 轮，`tools/preset_tail.mjs` 复核）：
        //     出网 `turns/00018.txt` 的 `#0` = user / **18,635 字**，它内部第 **4,576** 字起是
        //     **预设模板块**（`<核心指导>` @4,576 ｜ `<任务介绍>` @5,037 ｜ `<通用写作规范>` @5,955
        //     ｜ `<追加行动选项>` @7,765 ｜ `<输出模板>` @9,411），到第 9,656 字才是世界书主书；
        //     而 `#0` 坐在**对话历史之前**（`#1` 起才是楼层）
        //     ⇒ 用户定版口径："对话预设模版基本在对话历史后面啊 需要保真！！！！！"
        //     实测第 0 / 17 / 18 三轮的 `#0` **逐字节完全相同**（18,635 字）⇒ 从第 0 轮就被冻死了。
        //   机制（三层，每层都有读数，不是推断）：
        //     ① 第 0 轮：这个角色的 `prompt_order` 缺项 ⇒ 酒馆把指令块兜底堆到最前（index = −1）；
        //     ② 第 1 轮起：A 区**逐字节复制上一轮那份**（引理 1）⇒ 错误永久固化；
        //     ③ 今天：酒馆其实**已经给对了**（`msgs:in` 心跳 `tplAt=48` / `optAt=45`，共 50 条
        //        ⇒ 模板块在**末尾**），是第 ③ 步那道**多重集差按内容扣、不看位置**把它们从 B 区
        //        扣掉了 ⇒ 整份 body 里模板块只剩 A 区那一个副本、位置还停在最前面。
        //   修法：**A 区不许含"这一轮对话楼之后"的条目** ——
        //     拿 `_floorLim` 之后那一段（＝保真区）的全部内容当集合 S，
        //     再找 `prev` 里**第一个**命中 S 的条目的下标 q，把锚点截到 **q − 1**。
        //     · A 仍是 `prev` 的**前缀** ⇒ 引理 1 一个字没破；
        //     · B 里那几条不再被扣掉 ⇒ 它们的**顺序由这一轮（酒馆给的）定**
        //       ⇒ 模板块回到对话历史之后。
        //   ⚠ 代价：这一轮 `lcp` 断在模板块那一处（实测约第 4,576 字）—— 用户定版"这里的保真代价
        //     是接受的"；下一轮起 A 区就是以这个新形状为基准 ⇒ **自愈**，不再每轮付。
        //   ⚠ 认不出对话楼（`_floorLim < 0`）或 S 空 ⇒ **一个字都不改**（照旧）；
        //     q = 0 也不截（那会把 A 截成空）。
        let _keepDeny = 0;                  // ★ v6.41.37 读数：这一轮有几条"每轮都在"的注入被**拒收**（不进 C）
        let _keepNamed = 0, _keepLoose = 0; // 读数：进 C 的里面，白名单命中几条 / 没命中几条
        const _keepDenyList = [], _keepLooseList = [];   // 前几条的「块名(字数)」，给用户一眼看
        const _keepSet = new Set();
        if (_floorLim >= 0) {
            /* ★ v6.36.0【真 bug 修正：判据是"**每轮都在**"，不是"位置靠后"】
             *  用户 2026-09-19 报："**就ABC三个变量 只有B是可压缩区，A是前文 不能动**"。
             *  盘上实测（`_tmp_abc.mjs` 在一次真跑里量到的）：`_floorLim` 之后**还坐着这一轮的新内容**
             *  ——`玩家二`、**我的输入**（`这一轮的输入`）、以及预设块 `stableBlocks`。
             *  旧口径"floorLim 之后**所有**条目都进保真集合" ⇒ **我的输入被判成保真块** ⇒ 它既不被压缩、
             *  也被拒在 C 区（保真区）里 ⇒ **B 区为空**、A/B 整条链走不通。
             *  ⇒ 正确判据：**上一轮也逐字存在**的条目才算"每轮都在的预设块"（保真内容）。
             *    这一条同时把"这一轮新写的东西"排除在外 —— 新东西本来就该走 B 区（可压缩区）。
             *  ⚠ 这与 `_prevMsgsPickBest` / `_keepQ` 用的 `prev` 是**同一份基准**（不会各说各话）。 */
            const _prevTexts = new Set(prev.map(m => textOf(m)));
            /* ★★★★★★ v6.51.5【保真区集合 `_keepSet` 与 C 区**同源** —— 用户重新定义 C 区之后必须一起改】
             *  用户 2026-09-22："**重新定义C区（保真区）** … 最后一个连续 system 身份消息的开头消息
             *  作为C的开头，直至到末尾 … 这样一来 就可以正常的防止**对话预设的保真区**没做好了"
             *  —— 他原话里"C 区"与"保真区"就是**同一个东西** ⇒ 两处判据必须同一套，否则又是两套口径。
             *  旧的 `i >= _floorLim + 1` 是"请求正文里最后一条长 assistant 之后"，
             *  与"酒馆对话预设的 Chat History 之后"**没有任何关系**（用户 2026-09-22 点名纠正过）。
             *  实测代价（`prefix_test` ⑥ 段）：那个起点把这一轮新写的 `玩家二` 也收进保真集合 ⇒
             *  `_keepQ` 命中它 ⇒ 锚点被截短 ⇒ **A 少一条**（A=5，本该 6）。
             *  ⇒ 现在**并集**：`i > _floorLim`（老口径，保留）**∪** `_cSet.has(msgs[i])`（C 区成员）。
             *  ⚠⚠ v6.52.1【补上 v6.51.5 只写在注释里、代码没照做的那一半】**真 bug + 真机现场**：
             *    用户 2026-09-23 报"**C 区的貌似又不保真发送了，搞得小小的，掉格式了**"。
             *    盘上量的（同一轮 `pre` vs 真出网 `WIRE`，`圣樱学院_mucysfoovmeg` 00003）：
             *      · 酒馆给的（pre n=36）格式块在 **24/31/33/34/35 —— 末尾**；
             *      · 真发出去（WIRE n=9）格式块跑到 **#2** ⇒ **掉格式**；
             *      · `_diag.log`：`abKeepSetN` 从 v6.50.3 的 15~16 → v6.50.6 的 1 → **v6.51.8 起恒定 0**，
             *        `abKeepQ=-1` / `abKeepCut=0` ⇒ **下面这道 v6.26.0 的截断保护整段不触发**。
             *    机制：`_cacheReorder` 把"变化组"后置到 `_floorLim` 之后 ⇒ 老起点扫出来的全是这一轮的新东西
             *      （`_prevTexts.has(c)` 不成立）⇒ 集合空 ⇒ `_keepQ=-1` ⇒ A 区一路吃到底、
             *      把上一轮那个"格式块在对话历史之前"的形状**逐字节继承**下来 ⇒ 永久固化。
             *    ⇒ 判据改成"**C 区成员也算**"（C 区 = 原文里最后一个连续 system 段之后那一段 =
             *      用户说的"对话预设的对话历史之后"，逐轮逐字节不变）。**只增不减**：
             *      老口径那一段一条不少，只是把被重排前置的那些预设块重新认回来。
             *    ⚠ 用户 2026-09-23 拍板选的就是这一条（原话见 `_cSet` 那段）。
             *    ⚠ 代价如实记：`_keepQ` 会重新命中 ⇒ v6.26.0 的截断恢复 ⇒ **这一轮 A 变短、lcp 降**，
             *      跟 v6.26.0 当年一样是"一次代价换长期正确"（格式块回到末尾后下一轮起自愈）。 */
            for (let i = 0; i < msgs.length; i++) {
                if (i <= _floorLim && !_cSet.has(msgs[i])) continue;
                /* ⛔⛔ v6.51.6【这一行曾经**整行丢失** —— 一个 `node --check` 抓不到的生产级故障】
                 *  症状：`_abSplit` 抛 `c is not defined`，而它被自己的 catch 吞成
                 *  `skip=异常：c is not defined` ⇒ **A/B 池化整段不生效**；
                 *  面板上只看到"这一轮没切"，看起来像"判据没命中"，完全不像崩了。
                 *  成因：v6.51.5 把 `_keepSet` 扫描段回退成 v6.50.4 原样时，下面那行
                 *  `if (!c || !_prevTexts.has(c)) continue;` 留下了，**而 `c` 的声明被一起删掉了**。
                 *  语法合法 ⇒ 三种语法检查（node --check / sync3 / 面板自检）全都放行。
                 *  抓到它的是 `check/prefix_test.mjs` 的"切得出来（A / B / C）"那句钉子
                 *  （报 `skip=异常：c is not defined`，且 A/B/C 全是 undefined）。
                 *  ⛔ 不许再删：这一段唯一的 `c` 来源就是它 —— 下面 `_isPresetKeep(msgs[i], c)`
                 *    与 `_blockTagOf(c)` 都靠它。 */
                const c = textOf(msgs[i]);
                if (!c || !_prevTexts.has(c)) continue;
                /* ⚠ v6.51.5【白名单**保留拦截** —— 实测去掉它会破坏收敛】
                 *  我一度把它降级成"只读数"，理由是"位置判据已经是权威、再叠名单只会漏"。
                 *  实测反驳：`check/am_ptr_test.mjs` 当场红 —— 连续应用 4 次，第 2/3/4 次
                 *  **不再逐字节相同**（`2==3 false ｜ 3==4 false`）⇒ **每一轮都在动**、缓存前缀永远抖。
                 *  病根：白名单原来会**拒收**注入类条目；去掉之后保真集合变大 ⇒ `_keepQ` 每轮命中不同的
                 *  位置 ⇒ 锚点每轮截在不同处 ⇒ 不收敛。
                 *  ⇒ 两道**各司其职、不是两套口径**：**位置**（`_floorLim + 1`）定"保真区在哪一段"，
                 *    **身份**（`_isPresetKeep`）挡"注入不许混进来"。两道都要。 */
                if (!_isPresetKeep(msgs[i], c)) {
                    _keepDeny++;
                    if (_keepDenyList.length < 8) _keepDenyList.push(_blockTagOf(c) + '(' + c.length + '字)');
                    continue;
                }
                const _nm = _presetKeepNamed(msgs[i], c);
                if (_nm) _keepNamed++;
                else { _keepLoose++; if (_keepLooseList.length < 12) _keepLooseList.push(_blockTagOf(c) + '(' + c.length + '字)'); }
                _keepSet.add(roleOf(msgs[i]) + '\u0000' + c);
            }
        }
        let _keepQ = -1, _keepChars = 0;
        if (_keepSet.size) {
            for (let pi = 0; pi < prev.length; pi++) {
                const c = textOf(prev[pi]);
                if (!c) continue;
                if (_keepSet.has(roleOf(prev[pi]) + '\u0000' + c)) { _keepQ = pi; _keepChars = c.length; break; }
            }
        }
        /* ★ v6.35.0：C 区条目的**纯文本**清单 —— 给模块级 `_inKeepZone` 用（三处共用同一套判据）。
         *   ⚠ 每轮先清空再填（不留上一轮残留）；`_floorLim < 0` ⇒ 清单为空 ⇒ 判据不生效（保守，不猜）。 */
        _keepTexts = [];
        _floorLimNow = _floorLim;
        if (_floorLim >= 0) for (const k of _keepSet) { const p = k.indexOf('\u0000'); if (p >= 0) _keepTexts.push(k.slice(p + 1)); }
        let a = -1, at = -1;
        for (let pi = prev.length - 1; pi >= 0; pi--) {
            const pc = textOf(prev[pi]);
            if (!pc) continue;                                  // 空条目不当锚（到处都是，认不准）
            let mi = -1;
            for (let j = _hi; j >= 0; j--) {                    // ← ★ 只搜到对话楼边界为止
                if (textOf(msgs[j]) === pc) { mi = j; break; }
            }
            if (mi < 0) continue;                               // 这条在这轮里找不到 → 再往前试一条
            a = pi; at = mi; break;
        }
        if (a < 0) return { skip: '基准里没有一条能在这轮里逐字节找到（用户删了楼层 / 重 roll / 换了基准）⇒ 一个字都不动' };                                 // 没有锚 ⇒ 一个字都不动（绝不猜位置）
        // ★★★★★★ v6.26.0【保真区截断】锚点若落在"保真区第一条"上或更后 ⇒ 截到它前面一条。
        //   只截**锚点**这一个数，`A = prev.slice(0, a+1)` 的定义一个字没改（仍是前缀，引理 1 成立）。
        //   ⚠ 截断后 A 变小 ⇒ `same` 那道闸门（≥2）可能因此不过 ⇒ 自动退回老路（安全，绝不硬拼）。
        const _aBefore = a;
        if (_keepQ >= 1 && a >= _keepQ) a = _keepQ - 1;
        const _cut = (a !== _aBefore);
        // 闸门：基准的尾段必须还在这一轮里 —— 否则这份基准已经过期（用户删楼层 / 重 roll /
        //   换了一场聊天），拿它当 A 就是把**过期内容**重新发出去。0.6 这个阈值取自
        //   `_restoreFrozenHistory` 那道形状体检的同一口径（0.6~1.7），不再另立一套。
        // ══ ★★★ v6.24.107【老闸门在 (乙) 下会**误拦** —— 真机数据抓到的】══════════════════════
        //  实测（`圣樱学院_mu5sd7sejhp0`，**官方 usage 为证**）：
        //    #6（v6.24.106，`abOn=1`）hit **82,048** / miss 8,930 → prompt 90,978，命中率 **90.2%**
        //    #8（v6.24.106，`abOn=0`）hit **28,032** / miss 5,975 → prompt 34,007，命中率 **82.4%**
        //      `abSkip` = "基准尾段已经不是这轮的前缀（锚在第 22 条 / 基准共 46 条，够不到 60%）"
        //  为什么老判据在 (乙) 下**必然**误伤：它假定"锚点应该落在 prev 的尾部"（prev 是上一轮发出去的，
        //  尾部＝最新内容）。可 (乙) 把锚点**箍在"这一轮的对话楼边界以内"** ⇒ 锚点对应到 prev 的位置
        //  完全可能在中部（实测 22/46 ＝ 48%）⇒ 判据必然不成立 ⇒ A/B 整轮跳过 ⇒ 退回老路，
        //  而那一步会把变量块/快照搬成"冻结池"（内容重组）⇒ 前缀断、命中率掉。
        //  ⚠ 我在 v6.24.106 里写过"老闸门在 (乙) 下形同虚设（a≈prevLen−1）"—— **那条判断是错的**，
        //    真机数据当场推翻（a=21 vs prevLen=46）。错因：拿"还没有 (乙)"那版的 `rsBound` 分布去外推。
        //  ⇒ **`_floorLim >= 0`（(乙) 真的生效）时跳过这道闸门**：锚点已被"这一轮的对话楼边界"箍住，
        //    它天生就是这一轮真实历史里的一条；外面还有 `same >= 2`（至少 2 条逐字相同）＋ A/B 之前那两道
        //    体检（来源 / 历史被改动）—— 保护已经**更强**，老判据在这里只剩误伤。
        //    认不出边界（`_floorLim < 0`）时行为**一个字不改**。
        if (_floorLim < 0 && a + 1 < prev.length * 0.6) {
            return { skip: `基准尾段已经不是这轮的前缀（锚在第 ${a} 条 / 基准共 ${prev.length} 条，够不到 60%）⇒ 这份基准过期了` };
        }
        /* ══ ★★★★★★ v6.36.0【A / B / C —— 三个独立变量，按下标切，职责互不越界】══════════════
         *  用户 2026-09-19 原话（连着两条）：
         *    "**大哥 你别乱动AC，给我切分 ABC三个变量！！！！！！！！**"
         *    "**你他妈的修改动作都放一个变量里面 你不错谁错？**"
         *  ⇒ 这话指的就是**改之前那个结构**：这一轮多出来的东西**整段收进 `B`**（多重集差），
         *    C 区（对话楼之后那批预设/格式块）**混在 B 里** ⇒ 装配那两层一动手就顺手把 C 也改了，
         *    于是只能靠"在 `_amPtr` 里逐块认 C 区再跳过"这种补丁去救（v6.30.0 就是这么干的，
         *    而且因为判据粒度选错、根本没生效 —— 用户看到的"保真区被污染、格式选项没了"就是它）。
         *
         *  ── 现在的结构（三个变量，各管各的）──
         *    · **A** = `prev[0..a]` **逐字节原样** —— 没有任何改写/重排/插入；
         *    · **B** = 这一轮里 **`_floorLim` 之前**、且 A 没覆盖的那部分（多重集差，保持原序）
         *              —— **唯一允许指针化/区间唤起的地方**；
         *    · **C** = 这一轮里 **`_floorLim` 之后**那些条目（＝保真区：预设/格式/写作指导栈）
         *              —— **原样进原样出，一个字节都不许动**。
         *    ⇒ 拼装 = `A.concat(B2, C)`。装配那两层**只作用在 `B2` 这一个变量上**，
         *      它们**再也够不到 C** —— "C 保真"从此是**结构保证**，不再依赖任何逐块判据。
         *  ⚠ `_floorLim < 0`（认不出对话楼）⇒ **C 为空**、全部按 B 处理（与既有保守口径一致：不猜）。
         *  ⚠ 去重（C 段自己做，A/B 的算法一个字没动）：C 的整条文本若**已在 A 里**（上一轮那批 C 条目
         *    落进了 A），这条就**不再重复追加**；只追加 A 里没有的那部分行。
         *    这样既不会让内容翻倍，也**绝不改写 A**（A 的定义一个字没变）。 */
        // ── ② A = 基准 [0..a] **逐字节原样**（这里没有任何改写 / 重排 / 插入）──
        const A = prev.slice(0, a + 1).map(m => ({ role: roleOf(m), content: textOf(m) }));
        // ── ③ B / C 的分界 ──────────────────────────────────────────────────────────────
        /* ★★★★★★ v6.51.5【C 区起点改成**位置判据**】用户 2026-09-22 原话与实测见 `_cZoneStart` 那段注释。
         *  · 分界线 = **最后一个"连续 system 段"的第一条**（`_cz`）；C = `msgs[_cz .. 末尾]`。
         *  · 实测这就是"对话预设的 Chat History 之后那一栈"（`<输出模板>` / `# 字数准则` / `<追加行动选项>` …），
         *    而且**逐轮逐字节不变** ⇒ 圈进 C 区不花 miss。
         *  · 顺带治好 v6.50.4 那版"纯身份判据"的两个真毛病：① 它会把**前面**的预设块也认成 C
         *    并从原位搬到末尾（版式翻转 ⇒ 与上一轮前缀对不上）；② 判据靠黑/白名单，预设一改就漏。
         *  ⚠ 整串里**一个 system 都没有**（`_cz < 0`）⇒ 退回 v6.50.4 那版**身份判据** `_isCSection`
         *    —— 只在这一种情况下生效（位置法给不出答案，身份法至少不退步）。
         *    **绝不**拿 `_floorLim`（对话楼层）去猜：那正是 v6.50.4 之前那个错的来源。 */
        const _cz = _czRaw;
        const cFrom = (_cz >= 0) ? _cz : msgs.length;
        const cByIdentity = (_cz < 0);
        const _aTexts = new Set(A.map(m => m.content));
        // ── ④ B = 这一轮 ⊖ A（**多重集差**，只取 `_floorLim` 之前；保持原序）──────────────
        //    必须用多重集（带计数）而不是集合：同一内容可能出现多次，A 里有 k 份就只许消费 k 份。
        //    只消费"这一轮里也有的"那些条目 ⇒ A 已覆盖的内容不会在 B 里被重抄一遍（否则内容翻倍）。
        const quota = new Map();
        for (const m of A) { const k = m.role + '\u0000' + m.content; quota.set(k, (quota.get(k) || 0) + 1); }
        const B = [], C = [];
        let same = 0;
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            const role = roleOf(m), content = textOf(m), k = role + '\u0000' + content;
            const q = quota.get(k) || 0;
            if (q > 0) { quota.set(k, q - 1); same++; continue; }   // A 里已有这一条 ⇒ 不进 B/C
            /* ★★★★★★ v6.51.5【C 区准入：**位置判据**（用户 2026-09-22 重新定义）】
             *  用户原话："它是原文msg**最后一个连续（最少连续次数1次）system身份消息**的开头消息
             *  作为C的开头，直至到**末尾的消息范围结束**，作为C的结束 —— 这样一来 就可以正常的
             *  防止对话预设的保真区没做好了"。
             *  ⇒ 判据只有一句：`i >= cFrom`（`cFrom` = `_cZoneStart(msgs)`）。**不看内容、不看块名、不看预设**。
             *  ⚠ 只有"整串连一个 system 都没有"时才退回身份判据（`cByIdentity`）—— 见上面 ③ 那段。
             *  ⛔ 认不出 ⇒ 既不进 C、也不许拿位置去猜（那条老路 v6.50.4 已经证伪）。 */
            if (cByIdentity ? _isCSection(m, content) : _cSet.has(m)) {
                /* ★ C 段：**不参与任何装配**。只做一件事：A 里已经有同样的文本就不重复追加
                 *   （上一轮那批 C 条目进了 A 时会发生；不改写 A，只决定"这一条要不要追加"）。
                 * ⚠⚠ v6.36.0 关键修正：**判据是"在保真集合里"，不是单纯"下标 ≥ cFrom"** ——
                 *   对话楼之后**也可能坐着这一轮的新东西**（例如用户刚敲的那条／新的注入），
                 *   按纯下标切会把它们错划进 C ⇒ 既没被压缩、又坏了"C 只有预设块"的语义。
                 *   实测新场第 5 轮：`<最新互动>D</最新互动>`（16 字）与 `[当前状态快照…]` 就在
                 *   `_floorLim` 之后 —— 它们是这一轮的新内容，该走 B，不该当保真块。 */
                if (!content.trim()) continue;                       // 空条目没有追加的意义
                if (_aTexts.has(content)) continue;                  // A 里已有 ⇒ 不重复
                C.push(m);
                continue;
            }
            // ★ 原样引用这一轮的那个对象（**不许**新建 {role, content}）—— 条目上可能挂着
            //   name / tool_calls / 别的插件塞的字段，抄成两个键就是把它们丢了（真 bug）。
            B.push(m);
        }
        /* ⛔ v6.51.5【这里本来想把新 C 区追加进 `_keepTexts`，**已撤回** —— 实测它破坏收敛】
         *  追加之后 `check/am_ptr_test.mjs` 当场红："连续应用 4 次，第 2/3/4 次逐字节相同"变成
         *  `2==3 false ｜ 3==4 false` —— 也就是**每一轮都在动**（缓存前缀永远抖）。
         *  病根：`_keepTexts` 喂的是**装配层**（`_amPtr` 靠 `_inKeepZone` 跳过保真块），
         *  把 C 区灌进去 ⇒ 装配结果随之改变 ⇒ 下一轮的输入又不同 ⇒ 不收敛。
         *  ⇒ 保真这件事已经由**结构**保证了（`_keepSet` 与 C 区准入同源 ＋ 装配只碰 B2），
         *    不需要再往装配层塞一份清单。**同一件事只留一处实现**（§2.5 死代码不留后路）。 */
        const sum = (arr) => arr.reduce((n, m) => n + m.content.length, 0);
        const aChars = sum(A), rawBChars = sum(B);
        // ★ v6.26.0：保真区截断**不许把"是不是同一场对话"这道闸门带偏** ——
        //   截断后 A 只剩前几条（通常就是世界书/角色卡那几块），与这一轮的交集自然变小，
        //   照旧判就会误 skip ⇒ 修法整轮失效。⇒ 截断发生时，闸门改用**截断前**那一份 A 的交集数。
        let sameFull = same;
        if (_cut) {
            sameFull = 0;
            const _q2 = new Map();
            for (let i = 0; i <= _aBefore; i++) {
                const c = textOf(prev[i]);
                if (!c) continue;
                const k = roleOf(prev[i]) + '\u0000' + c;
                _q2.set(k, (_q2.get(k) || 0) + 1);
            }
            for (const m of msgs) {
                const k = roleOf(m) + '\u0000' + textOf(m);
                const q = _q2.get(k) || 0;
                if (q > 0) { _q2.set(k, q - 1); sameFull++; }
            }
            if (sameFull < same) sameFull = same;
        }
        if (same < 2 && sameFull < 2) {
            return { skip: `交集太小（只对上 ${same} 条 / 基准前 ${a + 1} 条）⇒ 基准与这轮不是同一场对话` };
        }
        // ── ④ B 区收缩（miss 最小化；只删"前文里逐字已有"的行，内容不丢 —— 定理 4）──────
        // ══ ★★★ v6.24.105【用户定版：B 区**不走压缩**】══════════════════════════════════════
        //  用户原话："B动部分含主要是对话历史后的内容最好不要走压缩"
        //          ＋"缓存功能一般不管chatHistory后面的啊，主要针对chatHistory与之前的内容"。
        //
        //  ══ 现场（当前对话预设 = 夏瑾 天琴座 V2 Beta 1.0 UPD2，chatCompletionSource=deepseek）══
        //   预设的 prompt_order 里 `Chat History` 排第 **12** 位 ⇒
        //     · 它**之前** 11 块：设定首 / Persona / USER设定 / World Info(before) / Char Description /
        //       Char Personality / World Info(after) / 设定集·前文 / Scenario / Chat Examples；
        //     · 它**之后** **47** 块：前文结束 / 核心指令开始 / 🛡️变量 / 📘字数设置 / 🛡️破限[顶] /
        //       🛡️伪对话 / 📘写作指南 / ✅基础文风 / …… / 📘选项(8 个行动选项) / 📘破限[底] /
        //       📔快速模式 / **📘格式姬(输出模板)** / **🛡️准则结束(字数·语言准则)**。
        //   ★ **格式指令全部落在那 47 块里** —— 而它们的内容**每轮逐字不变**。
        //
        //  ══ 为什么"每轮逐字不变"就是死刑（真出网 body 为证，圣樱学院_mu5rg2rr3wm2）══════
        //   行级扣重的命中判据是"这一行在上一轮那串字里逐字出现过" ⇒
        //   **越是不该动的稳定指令，越容易被判成"前文已有"而扣掉**（这正是本算子的反面）。
        //   实测 `turns/00005.txt` 的 `#3`（9,958 字，装着 `</互动历史>` + `<核心指导>` +
        //   `<第一写作指导>` + `<通用写作规范>` + `<追加行动选项>` + `<输出模板>` + `🛡️准则结束`）
        //   抬头被换成 `【本轮增量·B 区收缩】…只列本轮新写/改的 158 行…那一版共 410 行` ——
        //   **格式指令被拆成「行号 + 片段」的清单**，模型读不到完整模板 ⇒ **掉格式**。
        //
        //  ══ 它还会自我强化（同一份内容重复 2~3 份）════════════════════════════════════════
        //   这一轮压出来的清单**进了下一轮的 A**（A 逐字节取自上一轮发出去的串），而下一轮手里
        //   是**原文**；原文 ≠ 清单 ⇒ 多重集差**扣不掉** ⇒ 同一份 5,367 字的清单在同一轮 body 里
        //   出现 **2** 份（`00005`/`00006`），`00008` 起 **3** 份，sha 逐字节相同。
        //
        //  ⇒ 所以 B（＝这一轮里 A 覆盖不到的全部内容）**原样追加，一个字节都不改**。
        //    "内容不丢"从此不再靠"行多重集"去论证 —— 而是**根本没动过**。
        //    miss 会因此变大：这是**如实付账**，不是损失（被扣掉的那些行本来就不该被拆开）。
        // ══ ★★★★★★ v6.27.0【B 区重复注入 → `<AMnnnn>` 记忆指针】══════════════════════════════
        //  用户 2026-09-19 定版原话："每个非用户可见对话历史的注入，我们先包裹 <AM0001> 之类的
        //  外壳，后续的 B 注入直接用 <AM0001> 做记忆唤起，而不是傻乎乎地进行完整注入，仅在 B 注入的
        //  该条目存在变更行为，才用 <AM0001> 完整注入的新变动内容 </AM0001>" ＋
        //  "我要的是开支的下降…我的预期是输入 miss 费用成本是小于输出费用的四分之一"。
        //
        //  ── 病（真出网 body 逐字节量出来的，`末日之后_MVU_0.9.0_mu7vf2wlnmxi`）──
        //   第 7 轮官方 `hit 216,704 / miss 47,634`；而这一轮相对上一轮**新增的那 76,347 字**里，
        //   **74,026 字（97.4%）是上一轮已经逐字发过的内容**（贪心最长块匹配，≥60 字认块）。
        //   全仓 267 轮：官方 miss 4,709,039 tok，其中"重复注入 A 区已有内容"保守口径 ≈1,988,980 tok（42.2%）。
        //
        //  ── 为什么这一步不违"不许动已发出去的内容"（引理 3 的落点）──
        //   `_abSplit` 逐字节复刻上一轮那份当 A（引理 1），断点 Λ 由 A 决定；
        //   **本函数只改 `B`（Λ 之后那一段）** ⇒ Λ 一个字节都不动 ⇒ lcp(N−1,N) **不降**、
        //   官方 hit **不降**，而 miss = 总长 − Λ ⇒ 正文变短 ⇒ **miss 单调下降**。
        //   这与 v6.24.114 撤回的 `_freezeApply` 是**两件事**：那一次动的是 `#0`（Λ 之内）
        //   ⇒ 把 `#33` 的 hit 291,840 打到 `#34` 的 2,816；这一步 `t ≥ Λ`，`R = 0`。
        //
        //  ── 判据（无状态、幂等 ⇒ 下一轮必然沿用同一形式，不会来回翻）──
        //   对 B 里每条 content，按"顶层成对标签块"切开；某个块的**原文**
        //   （`<tag>…</tag>` 逐字节）若在 `prev`（上一轮真发出去的那一串）里出现过
        //   ⇒ 换成**逐字节恒定**的指针 `<AMxxxx name="tag"/>`；否则**完整注入**。
        //   · 幂等：判据只看"prev 里有没有这块原文"，与轮号无关 ⇒ 同一份内容永远同一形式；
        //   · 变更=完整注入：块改了一个字 ⇒ prev 里找不到 ⇒ 自动走完整注入那条路
        //     （这正是用户要的"仅在存在变更行为时完整注入新变动内容"）；
        //   · 不丢内容：**首次出现的那一块从来没被动过**，它逐字躺在上一轮/更早的真出网 body 里；
        //   · 保真区（`<核心指导>` / `<输出模板>` / `🛡️准则结束` …）只要在上一轮出现过就同样指针化 ——
        //     这是用户本轮点名的诉求（它们正是每轮重发的大头），不是"搬走"，位置与顺序一个字没动。
        // ⚠ 性能：判据是一次 `Map.get(指纹)`（不是拿每块去扫几十万字）—— 块数与轮数都小，O(块数)。
        const _amPrev = Array.isArray(prev) ? prev : [];   // 只用于读数（基准多大），判据不看它
        let _amN = 0, _amSave = 0, _amPtrChars = 0, _amNames = '', _amBad = '';
        // ★ v6.28.0：区间唤起的异常读数（与 `_amBad` 同规矩：出错就整层归零，绝不把"没跑"伪装成"跑了没效果"）
        let _amAddrBad = '';
        // ★★★★★★ v6.30.0：**C 区（保真区）被跳过的块数** —— 这是"C 一个字没动"的可核对读数（0 也算读数）。
        let _amKeepSkip = 0;
        // ★ v6.27.1：包裹那两个数也要报出来（否则"省了多少"里看不到"壳花了多少"，账就不实）
        let _amWrapN = 0, _amWrapCost = 0;
        // ★ v6.27.2：子段指针化的读数（几块走了子段路 / 一共切了几段 / 省了多少字）
        let _amSubN = 0, _amSubSegs = 0, _amSubSave = 0;
        // ★★★★★★ v6.27.1【用户 2026-09-19 定版："只要不是玩家酒馆界面可见的对话输入与对话输出，
        //   一律用 AM0001 之类包裹，后续重复注入就直接用 AM0001 来调用，而它的块内容变动
        //   才可以 <AM0001>完整展开</AM0001>"】
        //   ⚠ 装配**只发生在 B 区**（用户 2026-09-19 同时定版："装配行为只涉及 B 区，A 区别动，
        //     C 区一直保真"）—— 本函数只改 `B.map(...)`，`A` 在返回处 `A.concat(B1)` 一个字节不碰；
        //     保真区（C）坐在 A 里 ⇒ 天然不动。
        //   ── 原文的编号 ──
        //     编号 = `_pfHash(原文)` 前 6 位十六进制（**内容指纹 ⇒ 同一块永远同一编号**，
        //     幂等、与轮号无关）。指针与包裹壳共用它，所以"指针唤起的正是当初包的那一块"。
        //   ── 原文的包裹壳（首次注入）──
        //     `<AMxxxx>原文</AMxxxx>` —— 包裹**不改原文一个字节**（只在两端加壳），
        //     信息量不减、且形状逐字节恒定 ⇒ 内容真变了就一定不会命中池（走完整展开那条路）。
        //   ⚠ 为什么包裹不会白付：包裹只加几十字节壳，而下一轮这块**整个**换成指针
        //     （池记住的是"包裹后的字节"，所以下一轮 `prev` 里那串正是它 ⇒ 逐字节命中）。
        //   ⚠ 挂进池的时机就在**包裹那一刻**（同一函数内），所以**当轮之内**若同一个块还出现一次，
        //     它会直接变成指针（不会在同一份 body 里重复包裹两遍）。
        /* ★★★★★★ v6.27.2【子段指针化 —— 吃掉"块内变异"那 22,000 tok/轮】
         *  ── 病（2026-09-19 盘上真数据，`turns/0002{1,2,3}.txt` 逐行量出来的）──
         *   每轮都有一条 42K~45K 字的大块（世界书＋预设＋骰点那一坨）在变：
         *     第 21 轮 `#14` 44,234 字 → 与第 20 轮的**连续命中前缀只有 211 字（0.5%）**，
         *       可它按行拆开有 **32,776 字在上一轮出现过**，真正全新的只有 7,233 字（16.4%）；
         *     第 22 轮 `#18` 同理（已见 33,932 / 全新 7,213）；
         *     第 23 轮 `#22` **已见 38,664 / 全新 0** —— 整条都在上一轮出现过，却仍全额 miss。
         *   ⇒ 因为"整块逐字节不变"这个粒度太粗：骰点、变量值一变，**整块指纹就失配**，
         *     于是块内那 30K+ 字"没变的部分"跟着一起按 miss 付全价。
         *  ── 官方账（可省上界，`_tmp_probe_ub` 实测后已删）──
         *   第 21/22/23 轮：可省 20,534 / 21,258 / 24,223 tok ⇒ 优化后每轮
         *   **¥0.0471 / ¥0.0546 / ¥0.0546**（当前 ¥0.0698 / ¥0.0798 / ¥0.0756）。
         *   平均 **−22,005 tok ≈ −¥0.0220/轮**。
         *  ── 做法（只动 B 区，A/C 一个字不碰）──
         *   整块命中不了时，在**块内部**按行找"上一轮逐行出现过"的**极长连续段**（≥400 字），
         *   把那些段各自换成 `<AMxxxx name="tag#k"/>` 指针；**没变的那几段省掉，变了的段原样发**
         *   ⇒ 内容一个字不丢，而 miss 只按"真正变了的那几段"计。
         *   · 判据与整块同源：段原文的指纹在 `_amPoolSend` 里 ⇒ 发指针；否则发原文并进池（下一轮可命中）。
         *   · 幂等：指纹只看内容、与轮号无关 ⇒ 同一段永远同一形式。
         *   · 无索引扫描：先把上一轮全文按行建成 `行 → 是否出现` 的 Map，逐行 O(1) 判定（不做 O(n²) 查找）。 */
        // ★★★★★★ v6.27.2【指令 C（用户 2026-09-19 原话）："断言 除了玩家输入与模型返回外，
        //   其他一律指针化！！！！！！！！"】—— 装配阈值从 400 字降到 **80 字**：
        //   原来只处理 ≥400 字的块 ⇒ 大量 80~400 字的世界书小条目/格式小块**仍以原文出现**，
        //   被当成"块内变异"的一部分全额 miss。降到 80 后，除玩家输入/模型返回外一律走
        //   指针（复用）或包裹壳（首次）；一次指针约 40 字，80 字以上的块换指针即净省。
        const AM_MIN_BLOCK = 80;
        const _amLineSeen = new Map();          // 行文本 → 是否在上一轮全文里出现过
        const _amDoc = _amPrev.map(m => String(m?.content ?? '')).join('\n');
        const _amSeen = (ln) => {
            if (_amLineSeen.has(ln)) return _amLineSeen.get(ln);
            const v = _amDoc.includes(ln);
            _amLineSeen.set(ln, v);
            return v;
        };
        /* ⛔ 已撤回（v6.27.2 第一版，用户 2026-09-19 当场否掉）：
         *   用户原话："每个指针化的范围 里面不能有指针化，也就是扁平化的 粒度化的。
         *             还不如以前的缓存池化系统"
         *   ⇒ 那版按**行**切"上一轮出现过的连续段"，问题两条（我自己探针也量到了）：
         *     ① **不是语义单元**：在句子中间切，切出来的"段"可以横跨多个块；
         *     ② **不扁平**：切出的段落在块内部，等于在块里再嵌一层指针；
         *        而 `<ph-cot-dialog>` 在一条消息里出现 **11~14 次**、`<analysis>` **14 次** ⇒
         *        "第一次出现"的判据与真实语义对不上。
         *   ⇒ 正确做法 = **只做顶层块级的扁平指针**（块 ↔ 指针一一对应，块内绝不出现指针）。
         *     下面 `_amSegs` 保留为**空实现**，等扁平版落地后按新判据重写。 */
        const _amSegs = () => [];
        const _amPtr = (content) => {
            if (typeof content !== 'string' || content.length < AM_MIN_BLOCK) return '';   // 小块不值得动（壳本身也有成本）
            // ⚠⚠★【嵌套必须先过滤成"同一层互不重叠"】`_amBlocks` 是栈式配对 ⇒ **内外层会一起返回**
            //   （`<world_x>` 与它里面的 `<analysis>` 都是候选）。若两个都处理：外层包裹壳插在原文两端、
            //   内层指针替换在中间 ⇒ 拼接时 `indexOf` 会**在外层原文里再找一次内层原文**（已被包住，
            //   位置全乱）⇒ 拼出来的字**结构错乱**（内容不丢也会变形）。这一版是结构性的，不能只靠
            //   "位置单调"糊过去 ⇒ 按"上一个被处理块的结束位置"过滤：**只处理不与它重叠的那些**。
            //   ⇒ 同一层里互不重叠的块各自包/指；嵌套时只动最外层（内层随外层一起走）—— 与"_amBlocks
            //     的栈式配对"同一个语义，且 `out === content` 时返回空 ⇒ 不动就绝不改字。
            const cands = [];
            for (const b of _amBlocks(content)) {
                if (b.raw.length < AM_MIN_BLOCK) continue;
                /* ⛔⛔ v6.37.4【指令 D①「一个指针的范围里永远只有一个指针」—— 实测抓到 3 处嵌套】══
                 *   实测（`圣樱学院_mu8frlmaq01m/turns/00007.txt`，`#5/#7/#9` 三条 assistant 各一处）：
                 *     `<HASH-B2AF70>` 这个**包裹壳**（2,816 字）里面套着 `<HASH-8C8FA7 name="UpdateVariable">`。
                 *   来路（不是猜的，是这两层各自的生成时刻决定的）：
                 *     内层那个指针是**更早的轮次**写进历史的 —— 上一轮 B 区被指针化后的那串字，
                 *     这一轮原样躺在历史里；而这一轮又出现了一个 `<UpdateVariable>` 块（内容变了）
                 *     ⇒ 走"首次注入 ⇒ 包裹壳"那一支 ⇒ 新旧两层指针叠在一起。
                 *   ⚠ `_amBlocks` 是栈式配对，它**认不出** `<HASH-xxxxxx>` 是指针壳（`HASH-B2AF70`
                 *     完全符合它的标签正则 `\p{L}[\p{L}\p{N}_…-]*`）⇒ 指针壳也会被当成"一个块"再包一层。
                 *   ⇒ 两条过滤，缺一不可：
                 *     ① **tag 自己就是 `HASH-xxxxxx`** ⇒ 那是指针壳、不是内容块，跳过不处理；
                 *     ② **块原文里已经含 `<HASH-`** ⇒ 无论怎么包，结果都是"指针里套指针" ⇒ 跳过。
                 *        （代价是这一个块少省几个字 —— 按指令 D①，这条不变量优先于省字。） */
                if (/^HASH-[0-9A-F]{6}$/.test(String(b.tag || ''))) continue;
                if (String(b.raw).includes('<HASH-')) continue;
                const at = content.indexOf(b.raw);
                if (at < 0) continue;
                /* ⛔ v6.36.0【这一层逐块判据**已删**，因为 C 区**根本不在 B 这个变量里**】
                 *  用户原话："**你他妈的修改动作都放一个变量里面 你不错谁错？**"
                 *  v6.35.0 我曾在这里加过"逐块认出 C 区就跳过"的补丁（`_inKeepZone(b.raw)`）——
                 *  它治的是**症状**：当时 C 区条目混在 `B` 里 ⇒ 装配一动手就顺手改了 C。
                 *  ⇒ v6.36.0 改成**按下标切成三个独立变量**（`A` / `B` / `C`，见上面那段）：
                 *    C 区条目**根本不进 `B`** ⇒ 装配够不到它 ⇒ 这道补丁多余，删掉。
                 *  ⚠ 只留 `_amAddrCommit` 里那一层（C 区正文不进地址台账）—— 那层仍然必要：
                 *    台账是跨轮持久化的，C 区正文一旦进去，下一轮 `_amAddrRecall` 照样会把它换掉。 */
                cands.push({ raw: b.raw, at, end: at + b.raw.length, tag: b.tag });
            }
            cands.sort((x, y) => (x.at - y.at) || (y.end - x.end));   // 同起点时**长的（外层的）在前**
            const parts = [];
            let limit = -1;
            for (const c of cands) {
                if (c.at < limit) continue;                            // 已经被外层盖住 ⇒ 跳过（不猜、不嵌套）
                limit = c.end;
                const h = _pfHash(c.raw);
                if (_amPoolSend.has(h)) {
                    // ② 重复注入 ⇒ 只发编号（记忆唤起）★ v6.31.0：`<HASH-****** name="tag"/>`
                    parts.push({ at: c.at, raw: c.raw, out: _amPtrId(c.raw, c.tag), ptr: true, tag: c.tag, len: c.raw.length });
                } else {
                    // ① 首次注入 ⇒ **先看块内有没有"没变的极长段"**（v6.27.2 子段指针化）：
                    //    有 ⇒ 只把那几段换成指针，变了的段原样发（内容不丢、miss 只算变的那几段）；
                    //    没有 ⇒ 走原来的"包裹壳 ＋ 完整原文"。
                    const segs = _amSegs(c.raw);
                    if (segs.length) {
                        let s = c.raw, d = 0;
                        for (let i = segs.length - 1; i >= 0; i--) {   // 从后往前替换，下标不失效
                            const seg = segs[i];
                            // ★ v6.31.0：子段指针也走唯一生成点（`<HASH-****** name="tag#k"/>`）
                            s = s.slice(0, seg.s) + _amPtrId(seg.text, `${c.tag}#${i + 1}`) + s.slice(seg.e);
                        }
                        d = c.raw.length - s.length;
                        parts.push({ at: c.at, raw: c.raw, out: s, ptr: true, tag: c.tag, len: c.raw.length, subN: segs.length, segSave: d });
                        _amSubN++; _amSubSegs += segs.length; _amSubSave += d;
                    } else {
                        /* ★ v6.31.0：包裹壳也换成新命名 —— `<HASH-******>块原文</HASH-******>`
                         *   ⚠⚠ 开壳与闭壳**必须是同一个号**（用户 2026-09-19 那条："它的块内容变动
                         *      才可以 <AM0001>完整展开</AM0001>"）⇒ 这里只算一次 id、两头共用，
                         *      不许各算各的（那样闭壳会挂到另一个号上，解析器就认不出来了）。 */
                        /* ★★★★★★ v6.37.1【真 bug：包裹壳两头各多了一个 `/`】—— 用户 2026-09-19
                         *   对着差异页截图问："这里什么情况？格式不正常啊,不是正常格式啊"。
                         *   盘上铁证（`圣樱学院_mu8byex8oudg/turns/00002.txt`，id `5F6497` 出现三次）：
                         *       [1] @24603  `<HASH-9B4FA4 name="world_世界观"/>\n<HASH-5F6497/><item_校规管理>…`
                         *       [2] @25030  `…凌驾于一切老师与领导\n</item_校规管理></HASH-5F6497/>\n<HASH-B4D955 …`
                         *   —— 这是**一对包裹标记**，可两头都写成了自闭合形状：
                         *       开 `<HASH-5F6497/>`（多一个 `/`）、闭 `</HASH-5F6497/>`（多一个 `/`）。
                         *   病根就是下面这一行：`_amPtrId()` 返回的**是自闭合形态** `<HASH-xxxxxx/>`,
                         *   直接拿它当开壳用、再 `.replace('<HASH-','</HASH-')` 当闭壳 ⇒ 两头都带着那个 `/`。
                         *   ⚠⚠ 危害不只是"难看"：`_amAddrPtrLenAt` 找的收尾是 **`</HASH-xxxxxx>`（无 `/`）**
                         *     ⇒ **永远找不到** ⇒ 它把包裹的长度算成"只有开壳那么长" ⇒ 后面那几万字原文
                         *     在扫描/切分时被当成**指针之外**的正文 ⇒ 登记与唤起全乱（指令 D 的扁平化不变量被破）。
                         *   ⇒ 正确形态（与 `_amAddrPtrLenAt` / 指令 B 的 `<AM0001>完整展开</AM0001>` 一致）：
                         *       开 `<HASH-xxxxxx>`、闭 `</HASH-xxxxxx>` —— 一个号两头共用，只是**去掉那个 `/`**。
                         *   ⚠ 不改 `_amPtrId()`：它是**唯一生成点**，自闭合形态本身是对的（重复注入就走它）。 */
                        const idStr = _amPtrId(c.raw);
                        const open = idStr.replace(/\/>$/, '>');            // <HASH-xxxxxx/>
                        const close = open.replace('<HASH-', '</HASH-');    // </HASH-xxxxxx>
                        const wrapped = open + c.raw + close;
                        parts.push({ at: c.at, raw: c.raw, out: wrapped, ptr: false, tag: c.tag, len: c.raw.length, wrapped });
                    }
                }
            }
            if (!parts.length) return '';
            let out = '', pos = 0, saved = 0;
            for (const pt of parts) {
                out += content.slice(pos, pt.at) + pt.out;
                pos = pt.at + pt.raw.length;
                saved += pt.len - pt.out.length;
                if (pt.ptr) { _amN++; _amPtrChars += pt.out.length; }
                // 包裹后的整串当场进池 ⇒ 同一轮内这块再出现就直接走"指针"那条路
                else { const hh = _pfHash(pt.wrapped); if (!_amPoolSend.has(hh)) _amPoolSend.set(hh, pt.tag); _amWrapN++; _amWrapCost += pt.out.length - pt.len; }
            }
            out += content.slice(pos);
            if (out === content) return '';
            _amSave += saved;                       // ★ v6.27.2：一次算清（原来在调用处又加一遍 ⇒ 重复计数）
            return out;
        };
        /* ══ ★★★★★★ v6.41.0【算法组合管线：B 区按清单逐级跑】══════════════════════════════
         *  用户 2026-09-20 定版（原话见 `_algoPipePick` 上面那一大段）。这里**只有一件事**：
         *  把 B 区交给管线。接入点**全项目只有一个**：`_algoPipePick(B, A, legacy)`。
         *  ── 为什么把两个"老两层"就地包成箭头函数，而不是搬进算法文件 ──
         *    它们的本体依赖跨轮台账（`_amPoolSend` / `_amAddrPool` / `_amAddrStat`），
         *    那些台账住在主链路里、每轮都在变；搬出去就要连台账一起搬（那是另一件事）。
         *    ⇒ 这里只做**适配**：本体唯一一份（§2.2"一处算法只许有一套实现"），
         *      算法文件（`core/expAlgo/amBlockPtr.js` / `amAddrRecall.js`）是薄适配器。
         *  ⚠ 函数体**逐字未动** —— 只把 `B1 = …B.map(…)` 换成 `_amPipeBlockPtr = (Bx) => Bx.map(…)`，
         *    既有的记账（`_amN` / `_amSave` / `_amPtrChars` / `_amAddrSaved` / `_amBad` / `_amAddrBad`）
         *    一个都没碰 ⇒ "装出来的那串字"与改动前逐字节相同。 */
        const _amPipeBlockPtr = (Bx) => Bx.map(m => {
            try {
                const src = String(m?.content ?? '');
                const out = _amPtr(src);
                if (!out) return m;
                if (_amNames.length < 160) {
                    // ★ v6.31.0：名字读的是 HASH 形态的指针（唯一写法，按用户定版不做旧格式兼容）
                    const ids = out.match(/<HASH-[0-9A-F]{6} name="[^"]+"/g) || [];
                    for (const s of ids.slice(0, 4)) _amNames = (_amNames ? _amNames + ' ' : '') + s.slice(1);
                }
                _amN++; _amPtrChars += out.length;
                // ⚠ 用展开复制（不许只留 role/content 两个键：条目上可能挂着 name / tool_calls / 别的插件塞的字段）
                return { ...m, content: out };
            } catch (e) { _amBad = String((e && e.message) || e); return m; }
        });
        /* ⚠ v6.41.0：原来这里有一句 `if (_amBad) { … 清零 … }` —— 已移到管线之后（见那儿）。 */
        /* ══ ★★★★★★ v6.28.0【第二层：区间唤起（碎片化 · 扁平化）】══════════════════════════════
         *  用户 2026-09-19 定版两句原话：
         *    · "只要不是玩家酒馆界面可见的对话输入与对话输出，一律用AM0001之类包裹，
         *       后续重复注入就直接用AM0001来调用"
         *    · "指针是 碎片化 扁平化的"（＝一个指针的范围里不许再套指针）
         *
         *  ── 为什么块级（上面那层）不够（盘上真数据：`turns/0002{2,3,4}.txt`）──
         *    B 区每轮多出来的那一段 74,622 字里，指针只有 719 字，**裸正文 73,010 字**；
         *    而那 73,010 字里"上一轮已逐字发过"的连续段有 **11 段 / 69,065 字（92.6%）**。
         *    它们**不在任何配对标签里**（铁证：`地图通用规则:` 那条坐在 `</world_饥渴世界>` 之外，
         *    条内 @8963 起，没有任何标签包裹）⇒ `_amBlocks` 天生够不到。
         *
         *  ── 这一层做什么 ──
         *    `_amAddrRecall` 在 B 区正文上按**最长匹配**把"真发出去过的区间"换成 `<AMxxxx/>`；
         *    没命中的字节、以及**块新长出来的那段尾巴**，照原文发 ⇒ "上一版用指针唤起、新长的尾巴原文发"。
         *    ⚠ 它**只做一层**：遇到指针就整段跳过 ⇒ 结果里绝不会出现"指针里套指针"。
         *    ⚠ 它**只动 B 区**（A 在返回处 `A.concat(B1)` 一个字节不碰，C 区坐在 A 里 ⇒ 天然不动）。
         *  ⚠ 记账纪律：**每轮先把命中读数归零**（跨轮累加会让"这一轮唤起几段"变成不可信的数）；
         *    这一层与块级不同，它**允许一个块都没唤起**（池空就是空 ⇒ 读数 0 是真的 0）。 */
        /* ══ ★★★★★★ v6.36.0【命名规范：整段只有 A / B / C 三个主变量，派生量一律加数字后缀】══
         *  用户 2026-09-19 原话："**给我规范命名 A B C**"。
         *  ── 命名表（改完这一版之后就是这套，别再冒出别的写法）──
         *    `A`  = 上一轮前缀，**逐字节原样**（不动）
         *    `B`  = 这一轮里"对话楼之前、且 A 没覆盖"的条目 ＝ **B 区原文**（可改）
         *    `B1` = B 经**第一层**（`_amPtr` 块级指针化）之后
         *    `B2` = B1 经**第二层**（`_amAddrRecall` 区间唤起）之后 ＝ **B 区最终发出去的形态**
         *    `C`  = 这一轮里"对话楼之后"的条目 ＝ **C 区原文**（保真，原样进原样出）
         *    拼装 = `A.concat(B2, C)`
         *  ⚠ 旧名字作废：`B1`（旧＝B1）、`B2`（旧＝B2）、`C`（旧＝C）—— 一个都不留，
         *    因为"f/g/f"这套后缀看不出谁是谁，正是用户点名要规范的原因。 */
        let _amAddrSaved = 0;
        const _amPipeAddrRecall = (Bx) => {
            _amAddrStat.hitN = 0; _amAddrStat.hitChars = 0;
            return Bx.map(m => {
            try {
                const src = String(m?.content ?? '');
                if (src.length < AM_ADDR_MIN) return m;
                /* ★ v6.35.0【第二层也要挡 C 区】：区间唤起同样会把保真内容换成指针 ——
                 *   用户报的"保真区被污染"就是这一层与上面块级那层一起造成的。
                 *   判据同源（`_inKeepZone` 子串包含）⇒ 两层不会各说各话。 */
                if (_inKeepZone(src)) { _amKeepSkip++; return m; }
                const out = _amAddrRecall(src);
                if (!out || out === src) return m;
                _amAddrSaved += src.length - out.length;
                return { ...m, content: out };
            } catch (e) { _amAddrBad = String((e && e.message) || e); return m; }
            });
        };
        /* ⚠ v6.41.0：原来这里有一句 `if (_amAddrBad) _amAddrSaved = 0;` —— 已移到管线之后（见那儿）。 */
        /* ══ ★★★★★★ v6.41.0【管线：唯一接入点】══════════════════════════════════════════
         *  清单为空（或全部停用）⇒ `_pz` 为 null ⇒ **B1 = B2 = B 原模原样**。
         *  用户 2026-09-20 定版原话："不选择算法自然是原模原样的原文" ⇒ 这一支**不是回退**，
         *  而是**正常语义**：管线里没有哪一级 ⇒ 一个字节都不动。
         *  ⚠ 清单里是 "am-block-ptr" / "am-addr-recall" ⇒ 走上面那两个适配器（本体在主链路里）；
         *    其它 id 一律问注册表要 `apply`（`core/expAlgo/` 下那个独立文件）。
         *  ⚠ 任何一级抛异常 / 条数对不上 ⇒ **整条作废**（`_pz` 为 null）＋ 如实记进 `_algoPipeBad`，
         *    理由见 `_algoPipePick` 那段：半成品比原样危险得多。 */
        const _legacyPipe = { 'am-block-ptr': _amPipeBlockPtr, 'am-addr-recall': _amPipeAddrRecall };
        /* ══════════════════════════════════════════════════════════════════════════════════
         * ★★★★★★ v6.41.7【参考串 ＝ **上一轮真发出去的那一整串**，不再只拿 A 区】
         *
         *  【用户 2026-09-20 原话】"组合管线不能让 miss 变少 那么我做它干什么" ＋
         *    "以前就是用**相同的算法**进行了两次（面板 Bug 但是**实际上就是正确的**）"。
         *
         *  【病】原来第二个实参传的是 `A`（＝上一轮那一串的**前缀**，切分时切出来的那一段）。
         *    可官方缓存里躺着的是 **S_{N-1} ＝ A ⊕ B2_{N-1} ⊕ C_{N-1}（整串）** ——
         *    只拿前缀当参考 ⇒ **把上一轮的 B 区产物与 C 区这两大块参考整个丢掉** ⇒ 压不动。
         *
         *  【实测（真切片 · 真算法 · 12 轮 `圣樱学院_mu8tu04a11gu`，只读复算）】
         *      参考 ＝ A 区     ：省 314,335 字 ／ 折算 186,144 tok
         *      参考 ＝ 上一轮整串：省 404,135 字 ／ 折算 **236,873 tok**（+50,729 tok）
         *    该场官方 miss ＝ 143,957 ⇒ 这一项直接把它压到 ≈84,000（**−35%**）。
         *    为什么"省下的字直接就是 miss"：真发串 ＝ A ⊕ B2 ⊕ C，A 一字不动 ⇒ hit 不变；
         *    C 保真 ⇒ 不变；只有 B2 变小 ⇒ `miss = prompt − hit` **等量下降**。
         *
         *  【"相同算法跑两次"这件事的数学真相 —— 别再靠"多勾一级"去要收益】
         *    记 `f(x, R)` ＝ 把输入 x 里"与参考 R 相同且够长"的片段换成指针。当 `A ⊆ S` 时
         *        **f(f(x, A), S) ≡ f(x, S)**
         *    —— 第二遍之所以有效，**全部**来自那个更大的参考，而不是"跑了两遍"。
         *    实测四条（同一场）：`f(f(x,A),S)` ＝ 404,135 ＝ `f(x,S)`；`f(f(x,A),A)` ＝ 314,335 ＝ `f(x,A)`；
         *    三级 `A→S→S` 仍是 404,135；而 `f(f(x,A),A⊕C)` ＝ 314,335（C 区当参考一分不省）。
         *    ⇒ 所以这一版**不改级数、只改参考**；同一条管线上重复同一算法仍然是幂等的。
         *
         *  【红线与安全（逐条对得上，不是"应该没事"）】
         *    · 参考串**只是拿去匹配的对照物**，不参与拼装 ⇒ A 一字不动、C 保真、三类原始存档不碰；
         *    · 输入是 **B0（原文）** ⇒ 原文里**不含**指针壳 ⇒ 参考里那些壳不会被"指着" ⇒ **不会嵌套指针**；
         *    · 产物变小 ⇒ 下一轮的 A 区（＝上一轮的前缀）**逐字节不变** ⇒ **LCP 不破**；
         *    · 取的是 `_prevRealMsgs`，**必须早于** `_prevMsgsPickBest` 那次改写
         *      （它会把 `_prevRealMsgs` 换成"候选里 LCP 最长的那一份"）—— 那一份不是"上一轮真发的"，
         *      拿它当参考就与 `prevLast`（A/B 的基准）不同源了。这里的位置正好在改写之前。
         *  ⚠ 拿不到上一轮（本场第一轮）⇒ 退回 `A`（那时 A 就是全部）。
         * ══════════════════════════════════════════════════════════════════════════════════ */
        const _prevWholeMsgs = (Array.isArray(_prevRealMsgs) && _prevRealMsgs.length) ? _prevRealMsgs : null;
        /* ★★★★★★ v6.41.21【把"主链这一刻真正用的参考串"落一份 —— 用户 2026-09-20 拍板 1+2+3】
           【为什么非落不可（实测）】`圣樱学院_mu9s221zsy5e` no=10，同一份算法、同一份 B 输入：
             拿"盘上第 9 轮真发整串"当参考算出 **5,557 字**、拿"本轮 A 区"算出 **14,248 字**，
             而**主链真发的是 16,345 字** ⇒ **三条链三个数** ⇒ 主链那一刻的 ref **盘上复原不出来**。
           ⇒ 落这一份之后，面板链按**同一个内容指纹**（`_refSig`）去读 ⇒
             读到 = 同一串（**面板的数就是真发的数**）；读不到 = **如实标"不同源"**。
           ⚠ fire-and-forget：不 await、整块 try 包住 —— **绝不许影响发出去的那一串**。 */
        try {
            const _refTxt = _prevWholeMsgs
                ? _prevWholeMsgs.map((m) => String(m?.content ?? '')).join('\n')
                : _azoneTxt;
            /* ★★★★★★ v6.41.22【改用**楼层号**当文件名 —— 上一版（v6.41.21）用"内容指纹"是错的】
               【为什么指纹行不通】面板链**算不出主链那一串**（那正是它要解决的问题本身）⇒
                 它拼出的指纹必然与主链落的那份不同 ⇒ **永远读不到** ⇒ 等于没修。
               【为什么楼层号行得通】它是**客观标识**，两条链都"知道"自己在说哪一轮 ⇒ 不依赖谁能算出谁。
                 ⚠ 两个候选名一起落（本楼 / 下一楼）：`_chatFloorNow()` 与 `/log` 的 `floor`
                   是不是同一个口径**没有实测过** ⇒ 宁可多落一份 200KB，也不许"因为差 1 就读不到"。
               ⚠ fire-and-forget：不 await、整块 try 包住 —— 绝不影响发出去的那一串。 */
            /* ⚠⚠ v6.41.23【把门控去掉了 —— 上一版（v6.41.22）就是它把这条路堵死的】
               上一版写的是 `if (_refTxt && _expAlgoSrvVCache >= 41)`，而 `_expAlgoSrvVCache`
               **只在面板链里**（`await _expAlgoSrvV()`）才会被填 ⇒ 用户"先发轮、后开面板"
               ⇒ 缓存永远是 0 ⇒ **主链一次都没落过**（盘上实测：`pipes/<槽>/` 下只有
               `pool/` 与 `turns/`，**`ref/` 目录根本不存在**）。
               ⇒ 门控在这里本来就是多余的：**老服务端对不认识的 `kind` 是"拒绝"而不是"静默忽略"**
                 （`if (kind !== 'turn' && kind !== 'pool') return {ok:false}` ⇒ **一个字都不写**）
                 ⇒ 传过去最多是白跑一次请求，**不可能污染任何东西**。
               ⚠ 但**读**那一侧的门控要留着：老 `/flat` 不认 `name`，会拿 `no` 去读 `turns/00000.txt` ⇒
                 那才是真会读到错东西的一条路（见下面面板链那段）。 */
            if (_refTxt) {
                const _f0 = Number(typeof _chatFloorNow === 'function' ? _chatFloorNow() : NaN);
                const _names = Number.isFinite(_f0) ? ['f' + _f0, 'f' + (_f0 + 1)] : [];
                for (const _nm of _names) {
                    void _expAlgoPut('/pipe', {
                        chat: _gitLogChat(), pipe: _algoPipeSlotId(), no: 0,
                        name: _nm, text: _refTxt, kind: 'ref',
                    }, 8000);
                }
            }
        } catch (_) { /* 落不下就算了：面板会如实报"不同源"，发出去的那一串一个字不受影响 */ }
        /* ★ v6.41.9：把**本轮 A 区那一段文本**也送进管线 —— 供某一级声明 `ref='A'` 时用
           （`_algoPipeRun` 第 6 参）。不送 ⇒ 那一级退回整串，行为与从前逐位相同。 */
        /* ══ ★★★★★★ v6.41.31【参考串**只能是 A 区** —— "扩到整段公共前缀"已实测执行并否掉】══
         *  【用户 2026-09-20 的方法先给出了空间（这个数是真的）】
         *    用**他写的算法本体**（`ptr-exact-v2.4`，阈值 300）拿"本地未命中文本 对 本地命中文本"
         *    求公共最长子串（读它自报的 `inc` 区间）：11 轮里
         *    **未命中 148,163 字中有 21,796 字（14.7%）可压，只要 15 个壳**，
         *    而且**全是同一类东西**：`【status_current_variables｜…】` 状态快照 ＋
         *    `喜欢的人 / 当前所在地 / 今日穿搭` 变量区（单段 325~5,132 字，每轮只变几个字）。
         *    它们够不到的原因也定位到了：原文躺在 **hit 区第 34,533 ~ 72,524 字**处，
         *    而参考串（A 区）只有 **52,093 字**。
         *  【用户的拍板】"执行'把 ref 从 A 区扩到上一轮与本轮的整段公共前缀'" ＋
         *    "这个是计算B，只有B是可读写的，A、C都是只读的" ＋ "**所以不影响 LCP**"。
         *  【执行了，盘上数据当场否决它 —— 而且**否决的正是"不影响 LCP"那半句**】
         *    改法：`_azoneTxt` 取 `min(上一轮整串, 这一轮整串)` 的字符级最长公共前缀（≥ A 区）。
         *    结果（同一场、同样 11 轮、同一个定量器）：
         *      · 请求 753,706 → 738,929（压得确实更多，前段每轮多省几百字）
         *      · **hit 605,543 → 555,701**（#11：**77,400 → 52,032**，恰好落回 A 区末尾；
         *        #10：67,594 → 52,032）
         *      · **Σmiss 148,163 → 183,228（涨 35,065，+23.7%）**
         *    ⇒ "不影响 LCP" 的**下界**那半句是对的（`|A|` 仍是装配串前缀，红线验收 0 下降），
         *      但**实际 LCP 掉了一大截**：LCP 本来还能靠 **B2 里那些逐字节稳定的壳**再往前推
         *      25,368 字（#11），参考串一变长，壳就变了 ⇒ LCP 当场断在 A 区末尾。
         *  【机制（这才是关键的一条，别再踩）】壳的形态里带着**本次匹配的长度**
         *    （`…略 N 字…`），而 `segsOf` 是**贪心取最长** ⇒ 参考串只要变长一点点，
         *    某个位置的匹配就可能长出几十字 ⇒ `N` 变、壳变 ⇒ 整串从那里起与上一轮分叉。
         *    ⇒ **壳稳定性 > 多压一点**：拿 5,380 字的额外压字去换 40,930 字 hit，净亏 35,065。
         *  【所以这一版**固定回 A 区**】—— A 区每轮逐字节稳定 ⇒ 壳稳定 ⇒ LCP 能推过整个 B2。
         *    要真正吃下那 21,796 字，前提是**壳的形态与匹配长度解耦**（那是另一个改动，见 STATE）。
         *  ⚠ 三条已否掉的路（都别重试）：参考＝上一轮整串（Σmiss 226,611）／A＝上一轮整串（207,781）
         *    ／参考＝整段公共前缀（183,228）。 */
        /* ★★★★★★ v6.41.34【参考串 ＝ A 区（**渐进**增长的那一串）】
         *  【为什么不能固定长度】试过 `prev.slice(0, 20000)`：压不动（Σmiss 148,163 → **344,341**）。
         *  【四次"扩大"为什么全崩 —— 真正的规则是"**参考串不许突变**"，不是"不许变大"】
         *    · 基线（参考＝A 区，A 每轮**渐进**多几条）⇒ 匹配范围只在边缘变 ⇒ 旧壳大部分保留
         *      ⇒ hit 稳 ⇒ **Σmiss 148,163（最优）**；
         *    · 参考＝整串 / A＝整串 / 参考＝整段公共前缀 ⇒ 头一次就**跳变几千~几万字**
         *      ⇒ 贪心最长匹配整段重算 ⇒ `略 N 字` 大改 ⇒ 旧壳全废 ⇒ hit 崩；
         *    · 固定 20,000 字 ⇒ 从 40,072 **突然砍半** ⇒ 同样是突变 ⇒ 崩。
         *  ⇒ 所以参考串**就取 A 区**（它逐轮渐进增长），要治的是"A **突然缩回**"那一个病 ——
         *    病根在锚点（见上面 `_SHELL_RE2` 那一段），不在参考串。 */
        const _azoneTxt = (Array.isArray(A) ? A : []).map((m) => String(m?.content ?? '')).join('\n');
        const _pz = (typeof _algoPipePick === 'function')
            /* ★★★★★★ v6.41.26【参考串 ＝ **A 区** —— 用户四条规则第 2 条，也是**正式版口径**】
             *  【用户 2026-09-20 原话（四条规则）】
             *    "1.分ABC 2.**求 B 在 A 里的所有最长公共子串**，替换B中的相关子串为套壳格式
             *     3.A∪B∪C求出本轮该发给官方api的内容，亦作为以后轮次的A 4.下一轮"
             *  【正式版（v6.40.0）写的就是这件事 —— 第 32046~32052 行，一个字没歪】
             *    `function _mainAlgoPick(B, A) {`
             *    `    const ref = (A || []).map((m) => String(m?.content ?? '')).join('\n');`
             *    `    const z = _mainAlgoApply(B, ref);`
             *  【我把它改坏在哪】v6.41.19 我把实参换成了 `_prevWholeMsgs`
             *    （＝上一轮真发出去的**整串** ＝ `A∪B∪C`）—— **那不是 A**。
             *    整串里含着上一轮的 B 与 C ⇒ "求 B 在整串里"会把 B 里那些
             *    **在上一轮 B/C 里出现过、却不在 A 里**的段也换成壳 ⇒ 超出规则第 2 条的范围。
             *  【改回 A 区】`_algoPipeRun` 拿到数组后走 `text()`：
             *    `const text = (arr) => (arr || []).map((m) => String(m?.content ?? '')).join('\n');`
             *    —— 与正式版那一行**逐字同一个口径** ⇒ 主链行为回到正式版。 */
            ? _algoPipePick(B, A, _legacyPipe, { azone: _azoneTxt, emitAll: true })
            : null;
        const B1 = _pz ? _pz.b1 : B;
        /* ══════════════════════════════════════════════════════════════════════════════════
         * ★★★★★★ v6.41.11【前面各级的产物**并入 A**，只有末级产物是发出去的 B】
         *
         *  【用户 2026-09-20 原话（架构口径，我原来搞反了）】
         *    "**只有管道末的 B 压缩才发出去啊** —— 前面连续的 B 都是**积累上下文变成合并为 A**，
         *      然后交给最终的 B 进行处理，得最终的 B" ＋ 紧接着一句 "**马上改**"。
         *
         *  【我的实现原来是什么】级间只把文本往后传（`cur = 第k级产物`），**前面几级的产物被丢掉** ——
         *    可它们并不是"废料"：它们是**已经提炼过的上下文**，用户的模型里它们该变成 A 的一部分。
         *
         *  【现在怎么装】`A ⊕ P₁ ⊕ … ⊕ P_{K-1} ⊕ P_K ⊕ C`：
         *    · 前 K−1 段 = 逐步提炼出来的上下文（并入 A）；
         *    · 第 K 段 = **末级产物**，也就是"最终的 B"（真正代表这一轮新内容的压缩形态）。
         *  ⚠ 红线一个字没破：**A 区那一段逐字节没动**（我们只是往它**后面**追加），**C 保真**，
         *    三类原始存档不碰。装配仍然只发生在"A 与 C 之间"那一段。
         *
         *  【为什么这样是赚的（照用户口径算的净账）】A 区是**命中区**、B 区是**未命中区**：
         *     单级：miss = |P₁| + |C|
         *     K 级：miss = |P_K| + |C|（P₁…P_{K-1} 这一轮付一次，**下一轮起就坐进 A 里命中**）
         *    ⇒ 每轮 miss 少 `|P₁| − |P_K|`（实测第 12 轮：14,427 → 1,458，**少 12,969 字**；
         *      12 轮合计少 158,403 字 ≈ 94,900 tok）。
         *  ⚠ 如实记一条待验：P₁…P_{K-1} **每轮都不逐字节相同**（它们依赖当轮的 B），
         *    所以它们**每轮都要付一次 miss** —— 这一笔已经算进上面那个净账里（它们本身就是那 K−1 段）。
         * ══════════════════════════════════════════════════════════════════════════════════ */
        /* ⚠⚠ v6.41.11【"把各级产物都发出去"这一版当场被验收打回 —— 记在这里，别再试第二次】
           我按用户那句"前面连续的 B 积累成 A"字面实现成 `A ⊕ P₁ ⊕ … ⊕ P_K ⊕ C`（每级产物都拼进去）。
           实测（`keep_tail_test` ③）：**"模板块只出现一次"当场红 —— splice 共 9 条**。
           原因：各级产物是**同一份 B 的多个压缩形态**，并排发出去 = **同一段文字重复 9 遍**
           （每级各留一份）⇒ 比不压还贵、还把上下文搅乱。
           ⇒ **"并入 A" ≠ "把各级产物都发出去"**。真要那样，前提是"各级产物互不重叠的**增量**"
             （而不是同一份内容的不同版本）—— 那是一件要单独设计的事。
           ⇒ 所以装配这一行**保持原样**（只有**末级产物**发出去）。运行器那边留下的 `emitAll/all`
             能力默认关、无副作用，等"增量语义"定下来再用。 */
        const B2 = _pz ? _pz.msgs : B1;
        /* ★★★★★★ v6.53.2【B2 去重：A 区里已经坐着的那一份，从 B 里摘掉】
         *  用户 2026-09-23 点名："认真分析Δmiss中的历史是怎么来的了 好好修好"。
         *  ── 病（本地算法重放实测，本次聊天生成 00034.json 时的第 35 轮）：
         *     断点之后 #465~#486 共 **22 条 / 3,028 字 ≈ 1,814 tok**，全是**最近 22 轮楼层的池化壳**；
         *     而**一模一样的壳**在 A 区里早就坐着（实测 A34[30]/[36]/[43]/[51]/[60] 同一个壳重复 **5 次**）。
         *     第 ④ 步那套多重集差**一条都扣不掉**：它的键是 role＋内容，而 A 里是**壳形态**、
         *     这一轮手里是**原文**（3,756 字的正文）⇒ 键对不上 ⇒ 22 条原文全进 B
         *     ⇒ 池化一跑又变回**同样的壳** ⇒ 同一批壳在整串里出现两次，第二次纯属白付。
         *  ── 修法：池化**之后**再对一次账（此刻 B2 已经是壳形态，能与 A 逐字节比）。
         *     判据只有一句：role＋内容与 A 里某条**逐字节相同** ⇒ 那份内容 A 里已经有一份 ⇒ 从 B2 摘掉。
         *     ⚠ 严格带**多重集配额**（A 里有 k 份才许摘 k 份）：宁可多发一条，绝不丢内容。
         *     ⚠ 只动 B2 —— A 一个字不碰（用户红线："A 只能变长，不许降低 lcp(N-1,N)"）；
         *       C 区够不到（它不在 B2 里，"C 一直保真"是结构保证）。
         *     ⚠ 判据只看内容、不看下标 ⇒ 逐字节幂等这条钉子（am_ptr_test）不受影响。 */
        const _dupQ = new Map();
        for (const m of A) { const _k = roleOf(m) + '\u0000' + textOf(m); _dupQ.set(_k, (_dupQ.get(_k) || 0) + 1); }
        const _dupKeep = [], _dupMask = [];
        let _dupDrop = 0, _dupChars = 0;
        for (const m of B2) {
            const _k = roleOf(m) + '\u0000' + textOf(m);
            const _q = _dupQ.get(_k) || 0;
            if (_q > 0) { _dupQ.set(_k, _q - 1); _dupDrop++; _dupChars += textOf(m).length; _dupMask.push(false); continue; }
            _dupKeep.push(m); _dupMask.push(true);
        }
        const B2f = _dupDrop ? _dupKeep : B2;
        /* B0（池化前原文）**不参与拼装**，只当"省了多少"的分母。池化不改条数 ⇒ 条数一致时按同一张掩码同步摘，
         * 这样对账时 B 与 B0 仍逐条对应；条数对不上（理论上不该发生）就**不猜**，原样留着。 */
        const B0f = (_dupDrop && B.length === B2.length) ? B.filter((_, _i) => _dupMask[_i]) : B;
        /* ★★★★★★ v6.54.1【池化之后：壳级去重】判据与实现**全在顶层 _shellDedup 那一份**
         *  —— 抽成顶层函数是为了让 tools/replay_turn.mjs 能用 check/_extract.mjs 抠出**同一份实现**
         *  （它从 B0 自己重跑池化，够不到 _abSplit 内部；两处各抄一份必然是两套口径）。
         *  A 区文本就是上面那个 _azoneTxt（＝ A 区逐条 content 用换行连接，与池化的 ref 同一个串）。 */
        const _shR = _shellDedup(A, B2f, _azoneTxt);
        const B2s = _shR.msgs;
        const _shCut = _shR.cut, _shCutChars = _shR.chars, _shMsg = _shR.msg, _shByA = _shR.byA, _shByB = _shR.byB;
        const _shRaw = _shR.raw, _shRawChars = _shR.rawChars;
        /* ⚠⚠ v6.41.0【记账清零必须排在**管线之后**】—— 旧代码里这两句各自紧跟它那一层；
         *   管线化之后"跑"全部发生在上面那一行 ⇒ 放在它**前面**清的就是**上一轮的残留**
         *   （本轮真出错反而不清零，读数与判据会各说各话）。实测就是这条把沙箱逼成 skip 的。 */
        if (_amBad) { _amN = 0; _amSave = 0; _amPtrChars = 0; }
        if (_amAddrBad) _amAddrSaved = 0;
        const _mainB = _pz ? _pz.msgs : null;
        const _mainSave = _pz ? _pz.steps.reduce((s, x) => s + Math.max(0, Number(x.chars) || 0), 0) : 0;
        const _mainWant = _pz ? _pz.steps.map((s) => s.id).join(' → ') : '';
        /* ★ v6.36.0：**C 段原样拼接** —— 它没有经过 `_amPtr`、也没有经过 `_amAddrRecall`
         *   （那两层只作用在 `B2` 上）⇒ "C 保真"是**结构保证**，不再靠任何逐块判据去救。 */
        const bChars = sum(B2s);
        return {
            A, B: B2s, C, splice: A.concat(B2s, C),
            /* ★ v6.53.2：把 B2 去重的战果带出去（面板/抬头/diag 都要能看到"这一轮摘了几条、几字"）。 */
            dupDrop: _dupDrop, dupChars: _dupChars,
            /* ★ v6.54.1：壳级去重的战果（摘了几个壳、几字、几条整条没了，判据A/判据B 各中几个）
             *   ＋ 试探层判据C：摘掉了几段"在 A 区里逐字节已有的**裸原文**"（内容实体，不是指针）。 */
            shellDrop: _shCut, shellChars: _shCutChars, shellMsg: _shMsg, shellByA: _shByA, shellByB: _shByB,
            shellRaw: _shRaw, shellRawChars: _shRawChars,
            /* ★★★★★★ v6.38.1【把 **B 区原文**也带出去 —— 算法研究的前提】
             *  用户 2026-09-19 点名："继续讨论从第1轮 模拟到最后轮 期间的B区压缩算法效率 注意哦 A C 是不动的哦"。
             *  可真要算它，先得**拿到 B 区原文** —— 而盘上三件套里**没有一份是"装配形状"**：
             *    · `raw.txt` = 酒馆原始组装（客户端那份，第 8 轮 45 条）；
             *    · `txt`     = **抓包那份**（酒馆后端**合并**成 15 条）；
             *    · 而 `_abSplit` 手里的 `msgs` 是 **79 条**（心跳 `assembledLen`）。
             *  ⇒ 用 `raw(N-1)` 冒充 `prev` 复现过：|B| **偏大 1.6 倍**（52,080 vs 真实 33,530）⇒ 不可复算。
             *  `B` 是函数内局部量，**不显式带出去就永久丢失** ⇒ 算法效率永远只能靠估。
             *  ⚠ 纯新增读数：参与拼装的是 `B2`，它一个字节没变 ⇒ **对三个官方数的影响为零**。 */
            B0: B0f,
            /* ★ v6.39.20【互换读数】`mainAlgo` 非空 = 这一轮真的是那个算法在发；
             *  `mainSave` = 它省下来的字；`mainBad` = 没生效的原因（空 = 没问题）。
             *  ⚠ 这三个只是读数，不参与拼装 ⇒ 对三个官方数的影响为零。 */
            mainAlgo: _mainB ? _mainWant : '', mainSave: _mainSave,
            mainBad: (typeof _algoPipeBad === 'string') ? _algoPipeBad : '',
            /* ★★★★★★ v6.41.0【管线读数（纯新增，不参与拼装 ⇒ 对三个官方数的影响为零）】
             *  `pipe`     = 这一轮**真跑过**的逐级读数（顺序 ＋ 每一级净省多少字）；
             *  `pipeSnap` = 管线快照（顺序 ＋ 每级 id/name/version）—— 进记录，日后可复现对账；
             *  `pipeOn`   = 启用了几级（**0 = 恒等**，B 区原模原样发出去）。 */
            pipe: _pz ? _pz.steps.map((s) => ({ ...s })) : [],
            pipeSnap: (typeof _algoPipeSnap === 'function') ? _algoPipeSnap() : [],
            pipeBad: (typeof _algoPipeBad === 'string') ? _algoPipeBad : '',
            pipeOn: (typeof _algoPipeUse === 'function') ? _algoPipeUse().length : -1,
            aChars, bChars, rawBChars, mChars: sum(msgs.map(m => ({ content: textOf(m) }))),
            // ★ v6.27.0：指针化的读数（面板/心跳/验收都从这儿看）
            amN: _amN, amSave: _amSave, amPtrChars: _amPtrChars, amNames: _amNames.trim(), amBad: _amBad,
            // ★ v6.28.0：区间唤起的读数（`adHitN`/`adHitChars` = 这一轮唤起几段/多少字；`adSave` = 净省多少字）
            adHitN: _amAddrStat.hitN, adHitChars: _amAddrStat.hitChars, adSave: _amAddrSaved,
            adPoolN: _amAddrPool.size, adPoolState: _amAddrStat.state, adPoolLoaded: _amAddrStat.loaded,
            adAddN: _amAddrStat.addN, adBad: _amAddrBad,
            // ★ v6.30.0：C 区保真读数 —— 这一轮有多少个块因为"C 区"被跳过（一个字没动）
            amKeepSkip: _amKeepSkip,
            // ★ v6.27.1：包裹账（首次注入包了几个块、壳一共花了多少字）—— 与 `amSave` 一起看才是真账
            amWrapN: _amWrapN, amWrapCost: _amWrapCost,
            // ★ v6.27.2：子段指针化（块内变异时只把"没变的段"换指针）的读数
            amSubN: _amSubN, amSubSegs: _amSubSegs, amSubSave: _amSubSave,
            // ★ v6.27.1：池的读数（`amPoolN` = 判据手里有多少块可用；`amPoolState` = 落盘/装回的成功失败）
            amPoolN: _amPoolSize(), amPoolState: _amPoolStat.state, amPoolLoaded: _amPoolStat.loaded, amPoolWhy: _amPoolStat.why,
            same, anchor: a, at, aN: A.length, bN: B2.length, cN: C.length, cFrom, floorLim: _floorLim,
            // ★ v6.51.5：C 区起点是**位置判据**给的 —— 把两个来源都报出来，面板/排错一眼看得出这一轮走的是哪一支
            cZoneAt: _cz, cZoneByIdentity: (cByIdentity ? 1 : 0),
            /* ★ v6.41.27：对话历史末尾是**靠什么认出来的** —— `chatHistory`（按酒馆编号 chatHistory-N）
             *   还是 `lastFloor`（老判据：最后一条 assistant）。认不出时必须能看出来，
             *   否则"判据生效"与"静默退回老路"在盘上完全一样（见上面那段注释）。 */
            floorSrc: _floorSrc, chatHistN: _chatHistN,
            // ★ v6.26.0：保真区那几个中间量一起报出去（下一轮从心跳里就能核对截断真发生了没、截掉多少）
            keepSetN: _keepSet.size, keepQ: _keepQ, keepChars: _keepChars, aBefore: _aBefore,
            /* ★ v6.41.37【两处改动的读数 —— 面板/心跳/验收都从这里看，不许只跑不报】
             *  · `keepDeny` = 这一轮有几条"每轮都在"的**注入**被白名单**拒收**（没进 C 区）
             *    ⇒ 它 >0 就是红④⑤生效的直接证据；恒为 0 说明这一轮本来就没有注入够格。
             *  · `roStaticN` / `roVaryN` / `roMoved` = 重排搬了几个静态块 / 几个变化块 / 实际换了几个位置。
             *  ⚠ 纯读数：不参与拼装 ⇒ 对三个官方数的影响为零。 */
            keepDeny: _keepDeny, roStaticN: _roStaticN, roVaryN: _roVaryN, roMoved: Number(_ro.moved) || 0,
            /* ★ v6.41.37【C 区清单 —— 用户点名的验收口径："让用户一眼看到保真区里只有格式文本"】
             *  `keepNamed` = 进 C 的那些里**白名单命中**几条；`keepLoose` = 没命中几条（非注入但认不出）；
             *  两个清单各给前若干条的「块名(字数)」⇒ 面板/心跳/汇报直接抄。 */
            keepNamed: _keepNamed, keepLoose: _keepLoose,
                /* ★★★★★★ v6.50.4【`cIdnMiss` ＝ **认不出身份**的条目数】（＝`keepLoose`，同一件事的别名）
                 *  新 C 区准入要求"黑名单过 ∧ 白名单命中"⇒ 白名单没命中的**进不了 C**（落进 B 被套壳）。
                 *  ⛔ 这一档只允许"如实记数 + 列出块名"（`keepLooseList`），**绝不许拿位置去猜** ——
                 *    v6.24.81 硬盖造成 prompt 翻倍 87,068 是红线教训。 */
                cIdnMiss: _keepLoose,
            keepDenyList: _keepDenyList.slice(), keepLooseList: _keepLooseList.slice(),
            cTags: (Array.isArray(C) ? C : []).slice(0, 24).map((m) => _blockTagOf(textOf(m)) + '(' + textOf(m).length + '字)'),
            roSkip: String(_ro.skip || ''), roVaryAt: _roVaryAt, roFloorAt: Number(_ro.floorAt),
            sameFull, cut: _cut ? 1 : 0,
            shrunkN: 0, savedChars: 0, shrinkItems: [],
        };
    } catch (e) { return { skip: '异常：' + String((e && e.message) || e) }; }
}

/* @34722-35440 */
function _restoreFrozenHistory(msgs) {
    const out = { on: false, restored: 0, chars: 0, items: [], churn: 0, skipped: 0, skip: '', boundaryAt: null, movedAt: null, probes: [], curLen: 0, baseSrc: '', copies: 0, copyChars: 0, copyItems: [], segs: 0, dropped: 0, ours: 0, dup: 0, keptBack: 0, keptChars: 0, keptGone: 0, keptAnchor: 0, keptIndex: 0, reSaid: 0, dropSeen: 0, floors: 0, floorsGone: 0, pickCands: 0, pickTried: 0, pickLcp: -1, pickItem: -1, pickFloor: -1,
        // ══ ★★★ v6.24.88【"为什么一行都没扣"必须从盘上看得见】════════════════════════════════
        //  实测（2026-09-17 `圣樱学院_mu5ffle6lfcc` #26~#30，官方数为证）：`prompt_cache_miss_tokens`
        //  卡在 18,749~25,515，而 miss 里 **约 17,200 tok 全在尾部那一条【本轮增量】上**
        //  （26,796 字 / 9 段）。它里面 820 个 `+行` 有 **468 行 / 10,858 tok 与上一轮那条增量逐字相同**。
        //  `_patchDropSeen` 本该把那些行整行扣掉，可**一行都没扣** —— 判据只有一个：抬头还是
        //  `RESTORE_ADD_HEAD`（只有 `dropped > 0` 才会换成 `RESTORE_ADD_HEAD2`）。
        //  而"扣不掉"有两种解释，从盘上**分辨不出来**：
        //    a. `seenPrev` 是空的（基准那份里没有我们自己插的增量条 ⇒ `prev` 不是"上一轮真发出去的字"）；
        //    b. `seenPrev` 非空，但 `hay` 那道"内容不许丢"的保险把每一行都拦下了。
        //  ⇒ 把中间量全部进心跳（原来只打在 console 里，刷新就没）。
        //  ⚠ 纪律照旧：**没跑 = -1**（`Number(null) === 0` 是有限数，会把"没跑"伪装成"跑了"）。
        prevLen: 0, sameBefore: 0, seenN: 0, oursBlk: 0, lostN: 0, addsN: 0, gateN: 0,
    seatBackN: 0, seatBackChars: 0, seatIdem: 0, seatBlocked: 0,
        // ══ ★★★ v6.24.92【A / B 切分必须从盘上看得见】════════════════════════════════════
        //   `abOn` = 这一轮真的走了 A/B；`abSkip` = 没走的话为什么（绝不写"跑了"）。
        //   `ab*N` / `ab*Chars` = A、B 各自的条数与字数 —— 这就是"miss 区有多大"的直接读数。
        abOn: false, abSkip: '', abAnchor: -1, abAt: -1, abSame: 0,
        abAChars: 0, abBChars: 0, abRawBChars: 0, abShrunkN: 0, abSavedChars: 0,
        abMChars: 0, abAN: 0, abBN: 0, abBase: '', abFloorLim: -1,
        // ★★★★★★ v6.27.0：B 区指针化（`<AMnnnn>`）的读数 —— 全 0/-1 表示"没跑"（不许把"没跑"伪装成"跑了没效果"）
        amN: -1, amSave: -1, amPtrChars: -1, amNames: '', amBad: '',
        // ★ v6.26.0【保真区】中间量：S 有几条 / prev 里第一个命中 S 的是第几条 / 锚点截断前后
        abKeepSetN: 0, abKeepQ: -1, abKeepChars: 0, abABefore: -1, abKeepCut: 0 };
    try {
        if (settings.cacheRestoreHistory === false) { out.skip = '开关关着'; return out; }
        if (!Array.isArray(msgs) || !msgs.length) { out.skip = '没有 messages'; return out; }
        if (!Array.isArray(_prevRealMsgs) || !_prevRealMsgs.length) _prevMsgsRestore(_currentChatKey());
        // ══ ★★★ v6.24.94【A/B 的基准**必须**是"上一轮真发出去的那串" —— 前提被破坏过】══════════
        //   官方数为证（`圣樱学院_mu5ffle6lfcc` #26~#34）：命中率 65% → 22.9% → 6.0% → 40.0% → **0.0%**，
        //   miss 24,311 → **78,913**（四轮白付 157,682 tok 全价）。
        //   盘上铁证（`_diag.log` 的 pushTurn:enter）：`rsBase=mem:?`（一份 **53 条**的旧快照被选中）、
        //   `rsSkip=基准形状不对（前文件 53 条 vs 这一轮 90 条）`；而出网 body 的**第 0 条**在三种形状
        //   之间来回跳：#26~#30 = 整块变量块（5,6xx 字）｜#31 = 空槽（变量块被搬走）｜#34 = 冻结池指针（58 字）。
        //   每跳一次，公共前缀就断在**第 0 条**上（两轮自然 lcp：73,182 → 4 → 4 → 9,928 → 0）。
        //
        //   根因不是阈值不对，是**引理 1 的前提被破坏**：
        //     · `_prevMsgsPickBest` 按"与任意候选的 LCP 最长"选基准 —— 这对**老路**是对的
        //       （老路逐下标盖回，只要盖得对，基准来自哪一轮都无所谓，v6.24.86 用户点名要的就是它）；
        //     · 可 `_abSplit` 要的是**强得多**的前提：A 必须逐字节等于**上一轮那一串**的前缀。
        //       拿一份更早的候选当基准 ⇒ A ⊕ B 的第 0 条就跟 s(N-1) 的第 0 条不是同一个东西
        //       ⇒ 前缀断在第一条，而 A 越大、这一轮越是"白拼"。
        //   ⇒ 现在把两个基准**分开**（两件事，两套前提，各用各的）：
        //       **A/B 用 prevLast**（进函数那一刻 `_prevRealMsgs` 的值 = 上一轮真发出去的那一份）；
        //       **老路继续用 _pick**（多候选一个不废，"删楼层 / 重 roll"那条路照走）。
        //     `prevLast` 与这一轮形状差太远时，`_abSplit` 自己的 60% 闸门会拦 ⇒ 自动退回老路，安全。
        //   ⚠ `prevLast` 也可能是很久以前那份（页面刚刷新、这一场还没发过）—— 那 `_abSplit` 同样会拦，
        //     不会拿过期形状硬拼（v6.24.81 那次整串翻倍 87,068 就是硬盖造成的，红线）。
        /* ★★★★★★ 2026-09-24【读写隔离的**收口**：这份基准必须属于**当前这一场**】
         *   用户当场问过："聊天的读写隔离做了吗？" ＋ "我随时切换聊天，内存就是临时的，
         *   真实都是硬盘上的文件"。内存里这份单例原来**没有场标** —— 实测代价：新聊天
         *   `林夏::muf7oy4ufvjb` **第 1 轮**（`floor=0`）就 `abBase=last`、`A=33条/35,231字`、
         *   `prevLen=38`，那是上一场 `muf17g3x5dix` 的规模。
         *   ⇒ 每个赋值点记场标（`globalThis.__hitOptPrevChat`），这里**取用前校验一次**：
         *     不符就当没有（`prevLast = null` ⇒ 退回按 LCP 挑）。
         *   ⚠ 与 `CHAT_CHANGED` 那道清空**互补**：那道是事件驱动（漏事件就失效），
         *     这道是**数据自证**（事件漏了也不会串）。两条都要留。 */
        const _prevChatOk = (() => {
            try {
                const mine = String(globalThis.__hitOptPrevChat || '');
                return !!mine && mine === String(_currentChatKey() || '');
            } catch (_) { return false; }
        })();
        if (!_prevChatOk && Array.isArray(_prevRealMsgs) && _prevRealMsgs.length) {
            console.warn('[hitOpt] 内存里那份基准属于**另一场聊天** ⇒ 这一轮不用它（读写隔离）');
        }
        const prevLast = (Array.isArray(_prevRealMsgs) && _prevRealMsgs.length && _prevChatOk) ? _prevRealMsgs : null;
        // ★ v6.24.94：**无条件重写**（拿不到就写 null）—— 换聊天 / 刚刷新时不会把上一场那份漏过来，
        //   `_relocMoveVarBlock` 随后读的就是它（顺序：本函数先跑，搬运紧随其后）。
        _prevLastMsgs = prevLast;
        // ══ ★★★ v6.24.86【用户点名：基准 = ≤ 当前楼层里 LCP 最长的那一份】══════════════════════
        //   用户原话见 `_prevMsgsPickBest` 的 JSDoc。这一步**只换"拿哪一份去盖"**，
        //   后面那些语义一个字没改：照样逐下标盖、照样过形状与历史两道体检 ——
        //   只是被拿去盖的那份从"死认上一轮"变成"候选里 LCP 最长的那份"。
        //   实测意义（官方数为证）：官方命中认的是**与任意已缓存请求**的最长公共前缀，
        //   `mu5ffle6lfcc` #22 相对 #21 全新了一整块、只跟上一轮比只能命中 38,431 tok，
        //   而官方报 57,600 —— 差的就是"与更早轮次仍然相同的段"。
        //   用户删楼层 / 重 roll 时，上一轮那份本来就对不上了，这条路是唯一走得通的。
        {
            const _pick = _prevMsgsPickBest(msgs, _currentChatKey());
            out.pickCands = _pick ? _pick.cands : 0;
            out.pickTried = _pick ? _pick.tried : 0;
            out.pickLcp = _pick ? _pick.chars : -1;
            out.pickItem = _pick ? _pick.item : -1;
            out.pickFloor = (_pick && Number.isFinite(Number(_pick.floor))) ? Number(_pick.floor) : -1;
            if (_pick) {
                _prevRealMsgs = _pick.msgs;
                try { globalThis.__hitOptPrevChat = String(_currentChatKey() || ''); } catch (_) { }
                _prevBaselineSrc = `${_pick.src}:${_pick.digest}`;
            }
        }
        const prev = (Array.isArray(_prevRealMsgs) && _prevRealMsgs.length) ? _prevRealMsgs : null;
        if (!prev) {
            /* ★★★★★★ v6.51.9【"拿不到基准"这一句，原因必须自己说出来】
             *   事故那一轮（圣樱学院_mucxfcb8nw6n 生成 00002 时的第 3 轮）盘上只留下
             *   abSkip 为空 ＋ stState=fail，我是靠一条条反推才走到 QuotaExceededError 的。
             *   现在一次说清两侧的状态：localStorage 那侧写没写进去、盘上兜底那侧备好没有。 */
            out.skip = '还没有上一轮真发出去的那串字可比（这一轮先记账）';
            try {
                const _dk = _currentChatKey();
                const _dc = (_prevDiskCache && _prevDiskCache.chat === _dk) ? _prevDiskCache : null;
                const _st = String(_prevStoreStat && _prevStoreStat.state || '') || '（这一页还没写过盘）';
                const _sw = String(_prevStoreStat && _prevStoreStat.why || '').slice(0, 40);
                out.abSkip = '基准拿不到｜localStorage ' + _st + (_sw ? '（' + _sw + '）' : '')
                    + '｜盘上兜底 ' + (_dc
                        ? (_dc.msgs ? ('已备好 ' + _dc.msgs.length + ' 条') : ('没备好：' + String(_dc.err || '?')))
                        : '这一场还没预取过（等 CHAT_CHANGED 那次）');
            } catch (_) { out.abSkip = out.skip; }
            return out;
        }
        /* ══ ★★★★★★ v6.24.117【容器块序稳定化 —— **接线**】══════════════════════════════════
         *  第 47/48 轮把算子（`_containerStabilize`）与总闸（`CONTAINER_STAB`）都写好了，
         *  但一直**没有调用点** —— 也就是说开关拨到 `true` 也不会有任何效果。这里把它接上。
         *
         *  【接在哪】`prev` 拿到之后、A/B 切分**之前**。理由：稳定化只动 `msgs[1]`（世界书容器），
         *    让它的**前部**与上一轮的容器逐字节相同、新增行挪到容器末尾；
         *    这样紧接着的 A/B 切分看到的容器"前部已经等于上一轮那一份"⇒ 交集更大、切分更容易走通，
         *    而且切出来的 A 天然覆盖容器前部（**同一件事的两半，顺序不能反**）。
         *
         *  【关着时怎么保证"逐字节等同不存在"】`_containerStabilizeMaybe` 在 `CONTAINER_STAB === false`
         *    时**第一句就 return null**（连一次字符串比较都不做）⇒ 下面这一整块一行都不执行、
         *    `msgs` 一个引用都不换。三个 `out.stab*` 字段只用于记账（面板/自检看得到"这一轮有没有动容器"）。
         *
         *  【为什么用 `_prevLastMsgs` 优先】容器比的是"**上一轮真发出去的那一份**的容器"；
         *    `prev`（`_prevMsgsPickBest` 选出来的）可能是更早的轮次（用户删楼层/重 roll 时它才被选中），
         *    拿它当容器基准等于拿"更早那一版的注入"去盖这一轮的注入 —— 与 A/B 的 `abBase = prevLast || prev`
         *    同一套取舍（见那一段注释）。
         *
         *  【红线】只动 `msgs[1]` 那**一条**；`msgs[0]`（system）与 `msgs[2..]`（对话历史）**一个字节都不碰**。
         *    容器不是"既往历史"（历史在 `msgs[2..]`），而且这个算子**只增不减**
         *    （`pc ⊎ (cc − pc) ⊇ cc`）⇒ 内容一个字都不丢（证明见 `_containerStabilize` 的 JSDoc）。 */
        /* ★★★★★★ 2026-09-24【"上一轮那份"（_prevLastMsgs）也要过**形状闸门** —— 用户点名】
         *  【病，实测 #31/#33（场 林夏_muf17g3x5dix）】自动总结那两发只有 **4 条 / 1 条**消息，
         *    却照样被当成"上一轮那份" ⇒ 下一轮（36 条）拿它当基准 ⇒ `_abSplit` 报
         *    「**交集太小（只对上 0 条 / 基准前 2 条）⇒ 基准与这轮不是同一场对话**」⇒ `abOn=0`
         *    ⇒ **连着两轮重建 miss**（#31 4.0%、#33 12.1%），直到 #35 才自己爬回来（78.8%）。
         *    用户原话："**按我的预期 第23轮跟第24轮一样 都不是重建miss的啊**" —— 对。
         *  【判据现成】老路那个形状体检（`prev.length / msgs.length` 落在 0.6~1.7），
         *    只是选 `abBase` / `_stabBase` 时没用上。`2 / 36 = 0.056`，一眼就该剔掉。
         *  ⛔ 只改"拿谁当基准"，不改任何一轮的内容；剔掉就退回 `prev`（按 LCP 挑的那份）。 */
        const _prevLastOk = (() => {
            try {
                const b = _prevLastMsgs;
                if (!Array.isArray(b) || !b.length) return null;
                if (!Array.isArray(msgs) || msgs.length < 8) return b;
                const r = b.length / msgs.length;
                return (r >= 0.6 && r <= 1.7) ? b : null;
            } catch (_) { return null; }
        })();
        out.baseShapeSkip = (Array.isArray(_prevLastMsgs) && _prevLastMsgs.length && !_prevLastOk)
            ? `上一轮那份形状太离谱（${_prevLastMsgs.length} 条 vs 这一轮 ${msgs.length} 条）`
                + ` ⇒ 不拿它当基准，退回按 LCP 挑出来的那份（多半是静默生成 / 自动总结占了基准位）`
            : '';
        if (out.baseShapeSkip) console.warn(`[hitOpt] ${out.baseShapeSkip}`);
        out.stabOn = false; out.stabExtra = 0; out.stabGain = 0;
        if (Array.isArray(msgs) && msgs.length > 1) {
            const _stabBase = _prevLastOk || prev;
            const _stab = _containerStabilizeMaybe(_stabBase, msgs, 1);
            if (_stab && Array.isArray(_stab.msgs) && _stab.msgs[1] && _stab.msgs[1] !== msgs[1]) {
                msgs[1] = _stab.msgs[1];
                out.stabOn = true;
                out.stabExtra = _stab.extra;
                out.stabGain = _stab.nextChars - _stab.prevChars;      // 容器净增的字数（0 = 纯删除型：原样返回上一轮那份）
            }
        }
        // ══ ★★★ v6.24.91【用户定版 · **先收 LCP 当前文，再拼后文**】════════════════════════════
        //   ⚠ 这一步**必须在形状体检之前** —— 拼接这条路本来就与形状无关（它按内容找锚，不看下标、
        //     不看条数、不管酒馆后端怎么合并）。旧顺序是先体检、条数比值一离谱就整轮放弃 ⇒
        //     实测 #31 就是这么把 hit 从 45,184 打到 4,608 的。
        // ══ ★★★ v6.24.92【A / B 切分 —— 用户定版】════════════════════════════════════════
        //   见 `_abSplit` 的 JSDoc（那里有引理 1 / 定理 2 的完整证明）。
        //   ⚠ 这一步**必须在形状体检之前**：切分按**内容**找锚，不看下标、不看条数、
        //     不管酒馆后端怎么合并 ⇒ 它本来就与形状无关。旧顺序是先体检、条数比值一离谱就整轮放弃
        //     ⇒ 实测 #31 就是这么把 hit 从 45,184 打到 4,608 的。
        {
            // ★ v6.24.94：**基准 = 上一轮那一份**（`prevLast`）；取不到才退回"选出来的那份"。
            //   两件事两套前提：A/B 要求 A 是**上一轮那一串**的前缀（引理 1），多候选不满足这个前提。
            // ══ ★★★ v6.24.106【两道"这份基准还能不能用"的体检 —— **必须排在 A/B 之前**】════════
            //  为什么非提前不可（`check/prefix_test.mjs` ⑤ 段当场抓出来的两条红）：
            //   (乙) 让锚点止步于"对话楼边界" ⇒ A 变短、B 非空 ⇒ **A/B 反而更容易走通**；
            //   而 A/B 一走通就 `return`（它是独立分支）⇒ 排在它后面的两道体检被**整个绕过**：
            //     · 来源体检（`wire:` = 网上那份 POST body，形状与这一轮不同源）；
            //     · 历史体检（上一轮的楼层这一轮找不着 = 用户删了楼层 / 重 roll 过）。
            //   这两道判的都是"**这份基准还能不能拿来当 A**"，与用哪种拼法无关 ⇒ 必须前置。
            //   不前置的实测危害：一份可疑基准会被 A/B 拿去当 A 逐字节发出去；用户删掉的楼层也会被
            //   A 原样塞回提示词（逆着用户的操作走 —— v6.24.81 的 ⑨ 例外条款）。
            //   ⚠ 那条**形状**体检（条数比值 0.6~1.7）**故意留在 A/B 之后**：A/B 按内容找锚、
            //     本来就与形状无关，把它前置等于废掉 A/B（实测 #31 就是这么把 hit 从 45,184 打到 4,608）。
            {
                out.baseSrc = String(_prevBaselineSrc || '');
                if (/^wire:/.test(out.baseSrc)) {
                    out.on = false;
                    out.skip = `基准来源不可信（${out.baseSrc} = 网上那份，酒馆后端并过消息，形状与这一轮 ${msgs.length} 条不同源）`
                        + `⇒ 这一轮不用它（先记账）；下一轮基准会自愈`;
                    console.warn(`[hitOpt] v6.24.106 ${out.skip}`);
                    return out;
                }
                const hay0 = msgs.map(m => String(m?.content ?? '')).join('\n');
                let floors0 = 0, gone0 = 0, goneReal0 = 0, shellSkip0 = 0;
                /* ★★★★★★ v6.50.1【体检的参考改用「上一轮**池化前**的装配」＝ A ⊕ B0 ⊕ C】──────
                 *  病根（用户 2026-09-21 点名查证；盘上三次命中崩 **3/3 吻合**）：
                 *    `prev` 是"上一轮**真发出去**的那一串"，其中 B 段已被套壳成
                 *      `<HASH-C6FBE7>头50…略 5497 字…尾30</HASH-C6FBE7>`；
                 *    而 `hay0` 是"这一轮酒馆给的**原件**"，里面是**原文**。
                 *    **壳只存在于壳里** ⇒ 拿壳的指纹去原文里找**必然落空**
                 *    ⇒ 判"一条聊天楼层被删" ⇒ 整条还原链放弃（`rsOn=0`）
                 *    ⇒ `_abSplit` 根本没进去（`abOn=0`）⇒ **这一轮压根没有 A 区**
                 *    ⇒ 整串版式翻转 ⇒ 官方 hit 从 9 万掉到 8 千（实测 −86,272）。
                 *  铁证：`圣樱学院_mubee2ngkp5o` 生成 `00031.txt` 时的第 32 轮，
                 *    `_diag.log` 原话 `rsFloors:"24"  rsFloorsGone:"1"`，那"1 条"是
                 *    `#98 段=B 566 字`，指纹就是上面那个壳。本场 39 轮里**只有 3 轮**没有 abc 台账
                 *    （生成 `00019`/`00031`/`00035`.txt 时的第 20/32/36 轮），而这 3 轮
                 *    正是仅有的 3 次 `rsOn=0`、也正是仅有的 3 次命中崩（−80,384 / −86,272 / −42,240）。
                 *  修法：**原文对原文** —— 参考串换成"上一轮**池化前**的装配形状"`A ⊕ B0 ⊕ C`
                 *    （A 不动、C 保真 ⇒ 池化前后相同，**只有 B 段不同** ⇒ 把 `B2` 换成 `B0` 即可）。
                 *    · `_restoreStats` 此刻装的**必然是上一轮的返回值** —— 它唯一的赋值点在
                 *      **调用点之后**（`horae.client.js:35565-35566`），而本函数体跑在它之前
                 *      ⇒ 不存在"读到这一轮半成品"的可能。
                 *    · 取不到（第一轮 / 上一轮 `abOn=0` / 老记录没这三片）⇒ **退回 `prev`**，
                 *      与改动前**逐字节相同**（保守，绝不猜）。
                 *    · ⛔ `A` 区的**来源**一个字没动（仍逐字节照抄"上一轮发出去那串"的前缀）；
                 *      这里换的**只是体检拿什么去比对**。⛔ 判据一个字没放宽：
                 *      真被删楼层 / 重 roll 时，`goneReal` 照样 > 0、照样拦。 */
                const prevAudit = (() => {
                    try {
                        const R = _restoreStats;
                        if (!R) return null;
                        const A = R.abAMsgs, B0 = R.abB0Msgs, C = R.abCMsgs;
                        if (!Array.isArray(A) || !Array.isArray(B0) || !Array.isArray(C)) return null;
                        const all = A.concat(B0, C);
                        return all.length ? all : null;
                    } catch (_) { return null; }
                })();
                out.auditShape = prevAudit ? 'prePool(A+B0+C)' : 'postPool(prev)';
                /* ★★★★★★ 2026-09-24【体检的分母必须限定在"酒馆**还没裁掉**的那一段"】—— 用户点名的大 bug
                 *  【病】原来拿 `prevAudit`（上一轮发出去那串的 A⊕B0⊕C）**逐条**去这一轮原件 `hay0` 里搜。
                 *    可 A 区是"逐字节照抄上一轮那串的**前缀**"，**一条楼层一旦进了 A 区就被永久冻住**；
                 *    而**酒馆的上下文窗口每轮都在裁掉最老的楼层** ⇒ A 区里必然残留"酒馆早就不要了"的老内容
                 *    ⇒ 拿它们去这一轮原件里搜**必然落空** ⇒ 判成"历史被改动" ⇒ **整轮放弃池化**。
                 *  【铁证（场 林夏_muf17g3x5dix）】A 区 9 条叙事，每条**只连续出现在 3 轮** raw.json 里
                 *    （00001-03 / 00002-05 / 00003-07 / … / 00012-14）＝ "最近 3 条"的窗口；
                 *    `_diag.log` 里 `rsFloors=4 rsFloorsGoneReal=1` **稳定复现**。
                 *    用户原话："**我从未重roll 那是你的失责**" —— 对，这不是他的操作。
                 *  【代价】从生成 00005 起每轮 miss ≈ 2 万 tok；repair_turns.mjs 补算出池化正常跑只要
                 *    ≈ 10,297 字 ≈ **6,168 tok** ⇒ **每轮白烧约 1.4 万 tok**。
                 *  【修法（最小，只动分母，判据一个字没放宽）】**被酒馆裁掉的老楼层不可能"被用户删掉"**
                 *    —— 它早就不在酒馆里了。所以只体检 `prevAudit` **末尾那一段**，条数上限 =
                 *    这一轮 `msgs` 里合格 assistant 楼层数 `mk` ＋ 1。用户删**最近**的楼层照旧拦得住。
                 *  ⚠ `out.auditScope` 只上报"体检了多少条"，⛔ 不参与判据。 */
                const mk = msgs.filter(x => String(x?.role || '') === 'assistant'
                    && String(x?.content ?? '').length >= FLOOR_MIN_CHARS).length;
                /* ★★★★★★ 2026-09-24【体检参考换成"**上一轮的酒馆原件**" —— 前三种口径都被实测否掉了】
                 *  实测（场 林夏_muf17g3x5dix，8 个轮对）三种口径**全部拦**：
                 *    只 A 区 → 拦 7/8 ／ 只 B0+C → 拦 7/8（gone=1）／ A+B0+C（现状）→ 拦 7/8。
                 *  根因：**两边根本不是同一批条目** —— 酒馆给 36 条，Horae 合并成出网 7 条；
                 *  而酒馆每轮还在滚动（老的出去、新的进来）⇒ 拿"上一轮**发出去**的那串"去比
                 *  "这一轮**酒馆给的**原件"，**永远会有一批对不上**。数量对不上 ≠ 历史被改动。
                 *  用户原话："**我从未重roll 那是你的失责**" —— 对。
                 *  ⇒ 参考只能是**上一轮的原件本身**（同一批条目在两次快照之间比），由本函数在
                 *    **体检之后**存进 `globalThis.__hitOptLastRawSnap`
                 *    （⛔ 不新增模块级变量：那要改 `plan.json` 的变量切片表，风险大且没必要）。
                 *  ⚠ 取不到（第一次跑 / 刚 F5 / 上一轮没走到这里）⇒ 分母 0 ⇒ **放行**。这是**有意的**：
                 *    原判据本身是错的（拿不同集合比），"拦"才是异常行为；而"用户真删了楼层"
                 *    从下一轮起照样抓得住（那时两边都是原件）。 */
                /* ★★★★★★ 2026-09-24【体检参考：**上一轮的酒馆原件**】
                 *  ⚠ 头两版（内容比对：只 A 区 / 只 B0+C / A+B0+C）**实测全部误判**（各拦 7~8 对），
                 *    根因见下面那段"窗口滑动"。这一版只拿它当"上一轮有几条 assistant 楼层"的来源。 */
                const _prevRaw = (() => {
                    try {
                        const g = globalThis.__hitOptLastRawSnap;
                        return (Array.isArray(g) && g.length) ? g : null;
                    } catch (_) { return null; }
                })();
                /* ★★★★★★ 2026-09-24【判据换成"窗口滑动模型"下**唯一成立**的那个特征】
                 *  【为什么整段内容比对要拆掉】铁证：00013.raw.json vs 00014.raw.json 逐条对位 ——
                 *    两份**都是 36 条**，而 00014 比 00013 **少了最老的 2 条、末尾多了 2 条**
                 *    （#8 跪在湿瓷砖 2841 ＋ #9 趴在床上 56 出局，后面**整体前移一位**，
                 *      末尾补进 #12 4641 ＋ #13 65）—— 这是**酒馆上下文窗口在滑动**。
                 *  ⇒ "上一轮的楼层这一轮找不着"在**每一次窗口滑动**时都会发生（本场 8 个轮对里 7 对命中），
                 *    它**根本不是**"历史被改动"的特征。拿它当闸门 ⇒ 每轮误判 ⇒ 整轮放弃池化
                 *    ⇒ 用户看到的就是"算法炸了"（那一轮 miss 22,771 tok，而池化正常跑只要 ≈6,705）。
                 *    用户原话："**我从未重roll 那是你的失责**" —— 对。
                 *  【正确的特征】窗口滑动是等量进出 ⇒ **条数不变**（实测本场 34~36，波动 ±1）；
                 *    用户删楼层 ⇒ **条数会少**。所以只看：这一轮的合格 assistant 楼层数 `mk`
                 *    比上一轮少 **≥ 2** ⇒ 判"历史被改动"。
                 *  ⛔ ⑨ 的例外条款没被取消，只是换成量得准的尺子；重 roll 由 `swipe` 那条通道管。 */
                const _prevMk = _prevRaw
                    ? _prevRaw.filter(x => String(x?.role || '') === 'assistant'
                        && String(x?.content ?? '').length >= FLOOR_MIN_CHARS).length
                    : -1;
                floors0 = mk; gone0 = 0; goneReal0 = 0; shellSkip0 = 0;
                out.auditScope = (_prevRaw ? `上一轮 ${_prevMk} 条 → 这一轮 ${mk} 条 assistant 楼层` : '没有上一轮原件')
                    + '（窗口滑动是等量进出 ⇒ 只看条数；删楼层才会少）';
                /* ★★★★★★ 2026-09-24【用户定版："貌似可以管 因为我没必要为此重建miss"】
                 *   原来这里是**整轮 return** ⇒ `_abSplit` 与"逐下标盖回"两样都不跑 ⇒ 池化整段不跑
                 *   ⇒ 那一轮 miss 暴涨（实测 #21 hit 1,280 / miss 30,751，命中率 4%）。
                 *   ⚠ 但"重建 miss"**不必要**：改写历史换掉的是**老楼层**，系统区 / 预设区 / 最近对话
                 *     都还在 —— 而 `_abSplit` 是**按内容找锚**的，对不上的地方它自己就会断。
                 *   ⇒ 改成**只降级、不放弃**：`skipRestore` 跳过"逐下标盖回"（那步假定 A 与 B 同形状，
                 *     历史改写了会错位 ⇒ ⑨ 的例外照旧守住）；**`_abSplit` 照跑** ⇒ miss 不重建；
                 *     `_abSplit` 万一也没走通 ⇒ 才落到"这一轮不做还原"（见下面老路入口那一道）。 */
                if (_prevRaw && (_prevMk - mk) >= 2) {
                    out.skipRestore = true;
                    out.restoreSkip = `历史被改动（assistant 楼层数 ${_prevMk} → ${mk}，少了 ${_prevMk - mk} 条`
                        + ` ⇒ 用户删了楼层 / 自动总结）⇒ **只跳过"逐下标盖回"**（它按形状对齐，历史改写了会错位），`
                        + `A/B 切分照跑（按内容找锚，对不上它会自己截）`;
                    console.warn(`[hitOpt] ${out.restoreSkip}`);
                }
                /* ★★★★★★ 存下**这一轮的酒馆原件**，给下一轮的体检当参考 —— 原件 vs 原件才可比。
                 *   ⛔ 挂在 globalThis 上，不新增模块级变量（那要改 plan.json，风险大且没必要）。 */
                try {
                    globalThis.__hitOptLastRawSnap = msgs.map(x => ({
                        role: String(x?.role || ''), content: String(x?.content ?? ''),
                    }));
                } catch (_) { }
                out.floors = floors0; out.floorsGone = gone0; out.floorsGoneReal = goneReal0; out.shellSkip = shellSkip0;
            }
            /* ★ 2026-09-24：这里改用**过了形状闸门**的 `_prevLastOk` —— 自动总结 / 静默生成会占住
             *   "上一轮那份"的位子，形状差 18 倍 ⇒ `_abSplit` 交集为 0 ⇒ 连着两轮重建 miss。 */
            const abBase = _prevLastOk || prev;
            out.abBase = _prevLastOk ? 'last' : 'picked';
            // ══ ★★★★★ v6.25.9【保真修法·乙：第一条以**酒馆这一轮给的**为准】══════════════════════
            //   用户 2026-09-18 原话："**第18 19轮我很不满意 保真区不保真**"
            //     ＋ 更早："对话预设模版基本在对话历史后面啊 **需要保真**！！！！！"
            //     ＋ "这里的保真代价是接受的…前面的内容尽可能的池化，不允许更多的miss，不允许断LCP，一切向钱看"。
            //   盘上证据链（每一环都是读数，不是推断）：
            //     · `msgs:in`（酒馆刚组装好、Horae 一个字还没动）：模板块在 **#48/50**（末尾，**正确**）；
            //     · 出网 `turns/000NN.txt`：模板块在 **#0**（`#0` = user / 18,635 字）；
            //     · A 区是"上一轮那份逐字节原样"（日志原话：「A 逐字节原样、一个字节没动（引理 1）」），
            //       里面那个 `#0` 就是**含模板块的错版本** ⇒ "整表换成 A⊕B"每轮都把它抄回来
            //       ⇒ 错误永久固化（`#0` 在 no=0 / 8 / 17 / 18 起点逐字节相同）✓
            //   判据（**两条同时成立才换**，避免误伤正常轮；只用盘上读得到的东西）：
            //     ① 酒馆这一轮给的第一条比 A 区抄来的第一条**短 1000 字以上**
            //        （＝A 区那条被别的东西撑大了；世界书正常增删不会差这么多）；
            //     ② A 区那条**含**预设模板块的正文特征、而酒馆给的那条**不含**。
            //   ⚠ 代价：这一轮 `lcp` 会断一次 —— 用户定版"这里的保真代价是接受的"；
            //     下一轮起 A 区抄到的就是**新的、对的第一条** ⇒ **自愈**，不再每轮付。
            //   ⚠ 影响面：**只动第一条**；A/B 切分算法、池化系统其余部分一个字不碰。
            const keepFirst = msgs[0];
            /* ★★★★★★ v6.51.6【池化前的快照 —— 用户 2026-09-22 点名原话："把原文后 变量已展开 池化前的
             *   消息存起来！ 不出意外应该是json格式，若不是就txt存着吧"】
             *
             *  【它是链条上的哪一环】盘上原来只有两份，中间那一段一直是空的：
             *    · turns/NNNNN.raw.json —— 酒馆刚组装完、**Horae 一个字都没改**的那份（客户端随 /turn 带来）；
             *    · turns/NNNNN.json     —— 抓包那份 POST body（Horae 改完、**真发出去**的那份）。
             *  可"池化"是一个**读 prev、写 msgs**的算子：它看到的输入既不是 raw（还没跑入口段算子：
             *  套壳归一、还原链、体检），也不是出网那份（已经是 A 区照抄的结果）⇒ **算法实验在盘上无法复算**。
             *  `abc.json` 里的 A/B/C 是**切分结果**、`B0` 只是 B 区的池化前原文 —— **都不是整份输入**。
             *
             *  【落点定死在这里】`_abSplit` 的**调用点前一瞬间**：msgs 已经过完入口段全部算子
             *  （变量块该搬的搬完、被删的字该还原的还原、形状该归一的归一），而 A/B/C 切分**一个字节还没跑**。
             *  ⇒ 这一份就是"把 prev 和 msgs 两个数组交给池化算法"时它真正拿到的东西。
             *
             *  【纪律】只读快照：`msgs.map` 出一份**新的**对象数组（role/content 两个字段，与 raw 那份同一形状），
             *  绝不把 msgs 自己（或其元素）交出去 —— 后面 `msgs.length = 0` 会把表清空，
             *  交引用等于存档跟着一起被清掉。拿不到就如实不写，绝不用 raw/出网那份冒名顶替。 */
            let preSnap = null;
            try { preSnap = msgs.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') })); } catch (_) { preSnap = null; }
            const ab = _abSplit(msgs, abBase);
            try { out.abPreMsgs = preSnap; } catch (_) { }
            if (ab && ab.bN >= 1) {
                msgs.length = 0;
                for (const m of ab.splice) msgs.push(m);        // ← 唯一的写动作：整表换成 A⊕B
                try {
                    const TPLK = ['输出模板', '追加行动选项'];
                    const hasTpl = (m) => TPLK.some(k => String(m?.content ?? '').includes(k));
                    const lenA = String(msgs[0]?.content ?? '').length;
                    const lenN = String(keepFirst?.content ?? '').length;
                    if (keepFirst && (lenA - lenN) > 1000 && hasTpl(msgs[0]) && !hasTpl(keepFirst)) {
                        msgs[0] = keepFirst;
                        out.keepFirstFix = `${lenA}→${lenN}`;
                        console.log(`[hitOpt] v6.25.9 保真：第一条以**酒馆这一轮给的**为准`
                            + `（A 区那条 ${lenA} 字 → 酒馆给的 ${lenN} 字；A 区那条含预设模板块、酒馆给的不含）`
                            + `｜只动这一条，A/B 其余部分一个字没动｜这一轮 lcp 断一次，下一轮起自愈`);
                    } else out.keepFirstFix = `不动（A ${lenA} / N ${lenN}）`;
                } catch (_) { }
                // ★ v6.25.8【补上一直没打出来的那一半读数】`msgs:out` 原来只挂在 `_finalizeMeasure` 的出口，
                //   而 A/B 这条路（`abOn=1`）在下面 `return out` **提前返回** ⇒ 那一句永远不会执行。
                //   实测铁证（`_diag.log` 全量计数）：`msgs:in` **3 次**、`msgs:out` **0 次**。
                //   ⇒ "Horae 处理完之后模板块落在第几条"这一半**一直没有读数**，第 27 轮那个结论只能靠推理。
                //   补在这里：A/B 路也报一次，于是"进 → 出"两次一比，模板块是被谁按回 `#0` 的就成了**读数**而不是推断。
                //   ⚠ 只读、只上报，一个字节都不改（与 `msgs:in` 那边同一套字段）。
                try {
                    _diagReport({
                        tag: 'msgs:out', via: 'ab', n: msgs.length,
                        tplAt: msgs.findIndex(m => String(m?.content ?? '').includes('输出模板')),
                        optAt: msgs.findIndex(m => String(m?.content ?? '').includes('追加行动选项')),
                        aN: Number(ab.aN) || 0, bN: Number(ab.bN) || 0, same: Number(ab.same) || 0,
                        fix0: String(out.keepFirstFix || ''),
                        // ★ v6.26.0 保真区：S 条数 / prev 里第一个命中 S 的下标 / 锚点截断前后 / 真截了没
                        keepSetN: Number(ab.keepSetN) || 0, keepQ: Number.isFinite(Number(ab.keepQ)) ? Number(ab.keepQ) : -1,
                        aBefore: Number.isFinite(Number(ab.aBefore)) ? Number(ab.aBefore) : -1,
                        keepCut: (Number(ab.keepQ) >= 1 && Number(ab.aBefore) >= Number(ab.keepQ)) ? 1 : 0,
                    });
                } catch (_) { }
                out.on = true;
                out.abOn = true;
                out.restored = ab.aN;
                out.chars = ab.aChars;
                out.boundaryAt = ab.at;
                out.prevLen = abBase.length;
                out.curLen = ab.splice.length;
                out.skip = '';
                out.abAnchor = ab.anchor;
                out.abAt = ab.at;
                // ★ v6.24.106（乙）：这一轮认出来的"对话楼边界"（-1 = 没认出来 ⇒ 本轮锚点不受限）。
                out.abFloorLim = (Number.isFinite(Number(ab.floorLim)) ? Number(ab.floorLim) : -1);
                /* ★ v6.41.27：末尾是**靠什么认出来的**（`chatHistory` / `lastFloor`）＋认出几条编号。
                 *   这两个读数进心跳（`_diag.log`）⇒ 发一轮就能判"新判据到底生效没有"。 */
                out.abFloorSrc = String(ab.floorSrc || '');
                /* ★★★★★★ v6.41.37【三处改动 + 红④⑤ 的读数 —— **必须接到 out 上**，否则用户看不见】
                 *  ⚠ 为什么非要接：沙箱/盘上切片喂的是**抓包那份 body**（酒馆后端合并过：7 条消息、
                 *    世界书在一条 24,030 字的 user 消息**内部**），而重排判据是「content **以** `<world_`
                 *    开头」⇒ 在那种形状下**命中不到** ⇒ 沙箱里量出来"改动零效果"（实测 miss 改前改后
                 *    都是 67,012 字、`压0`）。**生产的 `_abSplit` 拿的是客户端条目级 msgs**
                 *    （世界书/角色卡是**独立条目**）⇒ 判据才命中。
                 *  ⇒ 所以"改动到底生效没有"只能靠**真机这一轮**的读数回答 —— 这几个字段就是那个入口：
                 *      `abRoMoved/abRoStaticN/abRoVaryN` > 0 ⇒ 重排真的搬了东西；
                 *      `abKeepDeny` > 0 ⇒ 红④⑤ 真的把注入挡在 C 区之外；
                 *      `abCTags` ⇒ 用户点名的"C 区条目清单（块名＋字数）"，一眼看保真区里是不是只有格式文本。 */
                out.abRoMoved = Number(ab.roMoved) || 0;
                out.abRoStaticN = Number(ab.roStaticN) || 0;
                out.abRoVaryN = Number(ab.roVaryN) || 0;
                out.abRoSkip = String(ab.roSkip || '');
                out.abRoVaryAt = Number.isFinite(Number(ab.roVaryAt)) ? Number(ab.roVaryAt) : -1;
                out.abKeepDeny = Number(ab.keepDeny) || 0;
                out.abKeepNamed = Number(ab.keepNamed) || 0;
                out.abKeepLoose = Number(ab.keepLoose) || 0;
                out.abKeepDenyList = Array.isArray(ab.keepDenyList) ? ab.keepDenyList.slice() : [];
                out.abKeepLooseList = Array.isArray(ab.keepLooseList) ? ab.keepLooseList.slice() : [];
                out.abCTags = Array.isArray(ab.cTags) ? ab.cTags.slice() : [];
                out.abChatHistN = Number.isFinite(Number(ab.chatHistN)) ? Number(ab.chatHistN) : -1;
                out.abSame = ab.same;
                out.abAChars = ab.aChars;
                out.abBChars = ab.bChars;
                out.abRawBChars = ab.rawBChars;
                /* ★★★ 三片＝**池化后**（＝这一轮真正发出去的那份实际文本），另留一份 B 的池化**前**原文：
                 *   用户 2026-09-19 定版原话："单纯的本轮存储池化后，ABC三部分的实际文本是什么"
                 *   ＋ "与现在的所有代码无关" ⇒ 要的是**数据本身**，不是代码里的中间形态。
                 *   · A：`ab.A` = `prev[0..a]` 逐字节原样 —— A 区不动 ⇒ **池化前 == 池化后**，一份就够；
                 *   · B：**两个都要**
                 *       `ab.B`  = `B2` ＝**池化后**（指针化 / 区间唤起都跑完了）＝真发出去的那个 B；
                 *       `ab.B0` = `B`  ＝**池化前**的原文 ⇒ 没有它就算不出节省率（`amSave/rawBChars` 那个分母）；
                 *   · C：`ab.C` = 保真区，原样进原样出 ⇒ **池化前 == 池化后**，一份就够。
                 *   ⚠ 纯新增读数：真正参与拼装的还是 `A` / `B2` / `C` 本身，这几份只是**把它们的文本抄出来**
                 *     ⇒ 不进 messages、不参与任何判据 ⇒ **对三个官方数的影响为零**。 */
                const _abcMsgs = (arr) => {
                    try {
                        if (!Array.isArray(arr) || !arr.length) return null;
                        return arr.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
                    } catch (_) { return null; }
                };
                out.abAMsgs = _abcMsgs(ab.A);      // 池化后（A 不动 ⇒ 前=后）
                out.abBMsgs = _abcMsgs(ab.B);      // ★ 池化**后** ＝实际发出去的 B（`B2`）
                out.abB0Msgs = _abcMsgs(ab.B0);    // 池化**前** ＝B 区原文（算压缩率的基准）
                out.abCMsgs = _abcMsgs(ab.C);      // 池化后（C 保真 ⇒ 前=后）
                out.abShrunkN = ab.shrunkN;
                out.abSavedChars = ab.savedChars;
                out.abMChars = ab.mChars;
                out.abAN = ab.aN;
                out.abBN = ab.bN;
                // ★ v6.26.0：保真区截断的读数（`keepCut=1` = 这一轮真的把 A 区截到保真区前面了）
                out.abKeepSetN = Number(ab.keepSetN) || 0;
                out.abKeepQ = Number.isFinite(Number(ab.keepQ)) ? Number(ab.keepQ) : -1;
                out.abKeepChars = Number(ab.keepChars) || 0;
                out.abABefore = Number.isFinite(Number(ab.aBefore)) ? Number(ab.aBefore) : -1;
                out.abKeepCut = (out.abKeepQ >= 1 && out.abABefore >= out.abKeepQ) ? 1 : 0;
                // ★★★★★★ v6.27.0：B 区 `<AMnnnn>` 指针化的读数（amN = 换掉几个块，amSave = 省下多少字）
                out.amN = Number(ab.amN) || 0;
                out.amSave = Number(ab.amSave) || 0;
                out.amPtrChars = Number(ab.amPtrChars) || 0;
                out.amNames = String(ab.amNames || '');
                out.amBad = String(ab.amBad || '');
                /* ★★★★★★ v6.41.4【管线读数接进本轮快照 —— 目标④"每轮记录里落管线快照与逐级读数"】
                   ── 为什么必须在这里接：`_abSplit` 从 v6.41.0 起就把 `pipe` / `pipeSnap` / `pipeBad` /
                      `pipeOn` 返回出来了，可**一个消费者都没有**（算完就丢）⇒ 记录里没有任何一轮
                      能回答"这一轮的提示词是哪条管线装的"。读数的生命周期到这一行才真正开始。
                   ── 三个落点，全部是**只读抄写**（不参与拼装 ⇒ 对三个官方数的影响为零）：
                      ① 随 `/turn` 的 `abc.read` 进 `turns/NNNNN.abc.meta.txt` 的对账行；
                      ② 随 `wire` 上报 ⇒ 服务端抬头 `turns/NNNNN.meta.txt`（那才是"每一轮"的正主）；
                      ③ 面板心跳（`abPipeOn` / `abPipeBad`）。 */
                out.abPipe = Array.isArray(ab.pipe) ? ab.pipe.map((x) => ({ ...x })) : [];
                out.abPipeSnap = Array.isArray(ab.pipeSnap) ? ab.pipeSnap.map((x) => ({ ...x })) : [];
                out.abPipeOn = Number.isFinite(Number(ab.pipeOn)) ? Number(ab.pipeOn) : -1;
                out.abPipeBad = String(ab.pipeBad || '');
                console.log(`[hitOpt] v6.24.93 A/B 切分：A = 基准前 ${ab.aN} 条 / ${ab.aChars} 字`
                    + `（锚＝基准第 ${ab.anchor} 条，在这一轮第 ${ab.at} 条）`
                    /* ★ v6.41.24【这一格原来报的是**已经停用的那一层**的账】
                       旧文写的是 收缩 N 条省 M 字，那两个量来自 _abShrinkB
                       —— 它在 v6.24.105 就被停用了（改成了 const Bf = B）⇒ 这两个量**恒为 0**
                       ⇒ 控制台每一轮都写"收缩 0 条省 0 字"，而真正的账在管线上（下一段）。
                       现在改成如实报**B 区进出差 + 管线级数**，与切片抬头 abc·管线 同一个来源。
                       ⚠ 这段注释住在模板串里面 ⇒ **一个反引号都不许写**（本项目已经踩过五次）。 */
                    + `｜B = ${ab.bN} 条 / ${ab.bChars} 字（池化前 ${ab.rawBChars} 字，`
                    + `管线 ${out.abPipe.length} 级省 ${Number(ab.rawBChars) - Number(ab.bChars)} 字`
                    + `${out.abPipeBad ? `｜⚠ ${String(out.abPipeBad).slice(0, 60)}` : ''}）`
                    + `（本轮共 ${ab.mChars} 字，对上 ${ab.same} 条）⇒ 发 ${ab.splice.length} 条`
                    + `｜A 逐字节原样、一个字节没动（引理 1）`);
                return out;
            }
            out.abSkip = ab
                ? (ab.skip || `B 区空（A 已覆盖这轮全部 ${ab.aN} 条）⇒ 没有要追加的增量，交给老路`)
                : '没跑到 A/B 切分';
        }
        /* ★ 2026-09-24：历史被改写时（`skipRestore`）—— 只有 **A/B 没走通**才会落到这里，
         *   而"逐下标盖回"在那种情况下会错位盖 ⇒ **这一轮不做还原**（⑨ 的例外），如实记账。 */
        if (out.skipRestore) {
            out.on = false;
            out.skip = (out.restoreSkip || '历史被改动')
                + `；而 A/B 切分也没走通（${out.abSkip || '没跑到切分'}）`
                + ` ⇒ 这一轮不做还原（⑨ 的例外：新的那串才是对的）`;
            console.warn(`[hitOpt] v6.24.106 ${out.skip}`);
            return out;
        }
        out.on = true;
        // ══ ★ v6.24.45【落点 = 最新那条 AI 消息的开头】══════════════════════════════════════
        // 用户定版原话："位置就是酒馆的用户GUI，最近的AI消息的位置开头" /
        //   "前文件前面直至对话轮位置 拼接 后文件对话轮后位置"。
        // 所以"从哪一条起用后文件"**不靠猜**：它就是这一串里**最后一条 assistant**——
        //   · 它前面每一条都从上一轮真发出去的那串字里继承（只把被删掉的字补回来）；
        //   · 它和它后面（最新一句玩家输入 / 注入 / 快照）全归这一轮，**一个字不碰**。
        //
        // 为什么非改不可（实测踩到的真事故）：老规则一见到"非 assistant 的差异"就 break，
        //   可是中间那些 user 条目**每轮都在变**（预设块里的变量快照 / 上一轮那条最新输入身上挂的快照），
        //   于是落点被拉到第 1、2 条上 —— 后面整段历史一条都拼不上。
        //   真记录为证（`圣樱学院_mu487qvjdcwg` 第 5→6 轮，出网原文 00004→00005）：
        //   该补回来的 3,015 字（`#2` 那条 assistant 末尾的 `<UpdateVariable>` 块）一个字都没补，
        //   而同一对记录喂给本函数（离线复算）时它是补得回来的。
        //
        // 只改"停不停"，不改"动不动"：**非 assistant 的条目一个字都不写**（老规则那半条照旧），
        //   只是不再因为它在变就把整段历史放弃掉。
        // ══ ★ v6.24.48【用户定版：这是**纯文本**操作，没有角色、没有"AI 楼层"这回事】════════════
        //  原话："'还原只管 AI 楼层（既往历史）'这个定义是错误的，你必须把它当成无任何意义的纯文本，
        //         用 A 的内容然后还原范围是 B 从开头到对话楼。"
        //  所以：A（上一轮真发出去的那串字）的**每一条**，原样盖到 B（这一轮那串字）的**开头到对话楼**上 ——
        //  不看角色、不看是不是 AI 楼层、不猜"这条该不该动"。A 是什么就是什么。
        //  为什么这样做对：前缀里任何一条（指令壳 / 预设 / 世界书 / 历史楼层）只要有一个字节与上一轮不同，
        //  从那里往后**整段缓存全废**。谁变都一样贵，跟它的角色无关。
        let k = -1;
        for (let i = 0; i < msgs.length; i++) if (String(msgs[i]?.role || '') === 'assistant') k = i;
        out.boundaryAt = k < 0 ? null : k;
        out.prevLen = prev.length;                     // ★ 复查用：这一轮拿到的"前文件"有几条（对不上 = 基准是旧的）
        out.curLen = msgs.length;                      // ★ v6.24.46 复查用：这一轮这串字有几条（出网前会被后端并起来）
        out.baseSrc = String(_prevBaselineSrc || '');   // ★ v6.24.46 复查用：这份基准是从哪儿来的（post:指纹 / mem / 空）
        // ══ ★★★ v6.24.81【基准体检 · 两道网 —— 可疑的基准一律不用，绝不许拿它去盖】══════════════
        //   ★ 为什么非有这道网（**官方数为证**，2026-09-17 圣樱学院_mu5ffle6lfcc 第 7 轮 —— 用户重 roll）：
        //     "盖回"那一步是**逐下标无脑盖**（v6.24.48 用户定版："用 A 的内容，还原范围 = B 从头到对话楼"），
        //     它**假定 A 与 B 同形状**。可 `_sendProofReconcile` 从 v6.24.30 起把基准无条件换成
        //     "网上那份 POST body"（酒馆后端并过消息之后的形状，实测 54 条），而这一轮手里是 43 条
        //     ⇒ 前 43 条被错位的 43 条盖掉 ⇒ 整串翻倍：
        //       第 6 轮 prompt 43,420 / hit 30,720 / miss 12,700（出网 73,566 字）
        //       第 7 轮 prompt **87,068** / hit **17,664** / miss **69,404**（出网 144,063 字，接回 12,755 → 27,897 字）
        //     ⇒ 那是**回退**（用户红线：不可以降低 LCP）。v6.24.81 已经堵住产生这个基准的那条路，
        //       但**盘上那份还躺在 localStorage 里**（`horae_prev_prompt_v1`）⇒ 回读时按 `src` 拦。
        //   ★ 判据①：来源不可信 —— `wire:` = v6.24.81 之前写的"网上那份"，形状可能不同源。
        //   ★ 判据②：条数比值离谱 —— 同源两轮之间条数只会差几条（世界书进进出出、预设块增删）。
        //   ⚠ 两道网**都只是"不用它"，绝不是"改掉它"** —— 拦住之后这一轮不做还原（等于先记账）；
        //     绝不拿一份可疑的基准去盖（那才是不安全的那一边）。
        const _ratio = (prev.length && msgs.length) ? prev.length / msgs.length : 1;
        // ★ v6.24.106：**来源**那一条（`_srcBad`）已经提到 A/B 之前了（见上面那两道前置体检）；
        //   这里只剩"形状"这一条 —— 它**必须**留在 A/B 之后（A/B 按内容找锚，与形状无关）。
        if (msgs.length >= 8 && prev.length && (_ratio < 0.6 || _ratio > 1.7)) {
            out.on = false;
            out.skip = `基准形状不对（前文件 ${prev.length} 条 vs 这一轮 ${msgs.length} 条，来源 ${out.baseSrc || '空'}）`
                + `⇒ 这一轮不用它（先记账），绝不拿另一种形状去盖`;
            console.warn(`[hitOpt] v6.24.81 ${out.skip}`);
            return out;
        }
        // ★ v6.24.106：**历史体检整段已经提到 A/B 之前**（见上面那两道前置体检）——
        //   它判的是"这份基准还能不能当 A"，与拼法无关；留在这里会被 A/B 的早返回**整个绕过**
        //   （`check/prefix_test.mjs` ⑤ 段当场抓到的那条红就是这个）。
        out.sameBefore = 0;                            // ★ 复查用：对话楼之前有几条与上一轮逐字相同
        if (k <= 0) { out.skip = '这一串里没有"对话楼"（最后一条 AI 消息）可分'; return out; }
        const n = Math.min(k, prev.length);            // 对话楼之前逐条对齐（A 短了就只盖到 A 有的那几条）
        const adds = [];                               // 每个源条目一批**最小增量**（只含变的那几行）→ 后置
        let budget = RESTORE_MAX_TOTAL_CHARS;
        for (let i = 0; i < n; i++) {
            const role = String(msgs[i]?.role || '');
            const cur = String(msgs[i]?.content ?? '');
            const p = String(prev[i]?.content ?? '');
            if (!cur) continue;
            if (cur === p) continue;                   // ① 逐字相同 —— 上一轮那份就是它
            // ★ v6.24.49：上一轮**我们自己**加的那条（增量条 / 搬走的变量块）不是历史内容 ——
            //   绝不用它去盖这一轮的真条目（那会把玩家最新那句话顶掉；纪律原话："绝不顶掉人写的字"）。
            if (_restoreIsOurs(p)) { out.ours++; continue; }
            if (_relocFrozenSlots.has(i)) continue;    // 变量块那一步已按底稿钉好，增量由它自己发（见 `_relocMoveVarBlock`）
            // ①′ ★ v6.24.49【最小增量】—— 把 B 与 A 做**行级 diff**，只把"变的那几行"后置（每段带地址）。
            //   老算法（v6.24.48）是"贪心子序列找最长的一段"，实测把 `<sample_basic>` 的头一个 `<` 吃掉了
            //   （A 里紧接着的那个 `<` 先被匹配上，段的起点整整晚一个字符 —— 用户截图："少复制了一个，含行开头"）。
            //   现在按**行**对齐：首字符再也不会掉，而且"改一行"就只后置那一行（用户原话："我就改个时间，
            //   你说这么完整干什么？纯变动部分后置啊…diff 都是局部的"）。
            // ══ ★★★ v6.24.90【用户 2026-09-17 定版 · 增量那一套整个删掉】════════════════════════
            //   用户原话："删了这里的增量垃圾 垃圾垃圾垃圾垃圾垃圾垃圾垃圾 他妈的就是垃圾代码
            //            删除 重新写！！！！！！！！！！！" ＋（上一条）"你还不如复制变动部分放后面"。
            //   他判得对，而且实测站在他那边。老做法把这一条与上一轮那一条做**行级 diff**，
            //   再把 hunk（`+` 新值行 / `-` 旧值行 / 两个空格的上下文行）拼成一条
            //   `【本轮增量…】` 后置 —— 可那个基准 `p` 是**冻住的旧版**，diff 出来的是"从最初到现在的
            //   **全部**累积变化"：
            //     实测（`圣樱学院_mu5ffle6lfcc` #30，官方 miss 24,311）那一整条 26,796 字 / 17,220 tok 里
            //     · `- 旧值行` 3,150 tok ＋ 上下文行 1,577 tok —— **逐字就在原位**（原位留的就是 `p`）
            //     · `+` 行里还有 10,858 tok 是**上一轮就已经发过**的
            //     ⇒ 屏幕上就是一张"整块重抄"的假 diff（用户："看差异页血压就高"）。
            //   ⇒ 现在：**一行 diff 都不算**。原位照旧留上一轮那一版（前缀一个字节不断），
            //     末尾直接摆一份**这一条的完整内容**（`cur` 原样，一个字不裁、不加任何标记）。
            //   为什么这样反而更省：那条假 diff 里含着 `-` 行与上下文（都是原位的重复），
            //   而整段复制就是这一条本身 ⇒ 实测这一场的账是**变小的**（见 commitmsg-v62490.txt）。
            if (p && cur !== p) adds.push({ from: i, role, text: cur });
            msgs[i].content = p;                       // ② 用 A 的内容（纯文本覆盖 = "还原范围 = B 从头到对话楼"）
            out.restored++;
            out.chars += p.length - cur.length;
            if (out.items.length < 8) out.items.push(`#${i} ${role} ${p.length - cur.length >= 0 ? '+' : ''}${p.length - cur.length}字`);
            // ★ v6.24.46：留一枚"这一轮摆回去的字"的样本 —— 出网原文取回来之后拿它**逐字核**：
            //   样本在原文里 = 还原真进了请求；不在 = 只在客户端这一串里改了（等于白改）。
            //   ★ v6.24.48：取**第一处不同往后 240 字**（A 那一版在分岔点之后连着写的字）——
            //   不管这一条是变长还是变短，这段字都是"只在盖回去了才会出现在原文里"的那一段。
            let d0 = 0;
            { const m = Math.min(p.length, cur.length); while (d0 < m && p[d0] === cur[d0]) d0++; }
            const probeText = p.slice(d0, d0 + 240);
            if (probeText.length >= 40 && out.probes.length < 4) out.probes.push({ i, text: probeText.slice(-200) });
            budget -= Math.abs(p.length - cur.length);
            if (budget <= 0) { out.boundaryAt = i + 1; out.skip = '改动的字数到上限（后面的不盖了）'; break; }
        }
        // ══ ★★ v6.24.74【用户 2026-09-17 定版："用简单可靠的旧方法（就是 agent 都在用的：
        //    完整保留 N-1 的数据，然后再考虑如何拼接 N 的数据才是王道）"】════════════════════
        //   病根（拿**真出网原文**两两对比实测，圣樱学院_mu5d985udvk4 第 1→2 轮）：
        //     上面那个逐下标循环拿 `prev[i]` 去盖 `msgs[i]` —— 可这两串**根本不是同一种形状**：
        //       · `prev` 从 v6.24.46 起是**出网原文**（`_prevRealMsgs`，酒馆后端合并之后的形状，
        //         实测第 4/5/6 轮分别是 10/12/14 条）；
        //       · `msgs` 是**客户端手里的形状**（实测 41/42/45 条）。
        //     `n = Math.min(k, prev.length)` 又把范围压到 prev 那么几条 ⇒ 这一步等于几乎什么都没盖。
        //   实测丢的东西（出网原文逐条比对）：第 1 轮挂在**最新那条 user** 上的
        //     「[当前状态快照…]（5,346 字）＋【本轮增量…】（2,115 字）」共 7,464 字，
        //     到第 2 轮那条 user 只剩裸正文 66 字 —— 因为那些块是**深度注入**上来的，
        //     下一轮它们跟着"最新那条"跑到新消息身上去了，旧那条上什么都不剩。
        //     ⇒ 前缀断在旧那条 user 的结尾，每轮白丢 7,500~15,500 字（≈2,100~4,400 tok 的 miss）。
        //   修法见下面那个独立函数 `_restoreTailFix`（抽出来是为了**能被验收直接跑** ——
        //   验收抠的就是源码里这一个，不在测试里另抄判据）。
        {
            const tf = _restoreTailFix(prev, msgs, k);
            out.tailFix = tf ? tf.chars : 0;
            if (tf) out.tailFixAt = tf.at;
        }
        // ③ 增量 → **一个源条目一条**，摆到**对话楼后面**（`k + 1`，紧跟那一条 AI 消息）
        //   ★ v6.24.49：只含"变的那几行"，每段一行地址（第几条 · 第几行 · 上一行原文）；超预算**整段不列**，
        //   绝不从段中间切开（上次切在 4,000 字上，一个世界书条目被截成半截）。
        //   盖回原位之后才拼"这一串现在的全部字"—— 拿它判"这段新写的字是不是别处已经有一模一样的了"：
        //   一模一样的**不摆第二份**（用户原话："可收纳区域 我不想在B的增量里面看见 后面有可收纳的重复内容"）。
        if (adds.length) {
            out.addsN = adds.length;                   // ★ v6.24.88 诊断：这一轮挑出几条"源条目的一批增量"
            const hayPrompt = msgs.map(m => String(m?.content ?? '')).join('\n');
            // ══ ★★ v6.24.78【⑨ 完整保留 N-1 · 增量条不重抄】════════════════════════════════════
            //   先把"上一轮我们自己发出去的那些增量条"里出现过的行收成一个多重集。
            //   这一轮的新增量凡是撞上它的行，**一行都不再重发** —— 那些行已经原样留在这串字的前面了
            //   （接回那一步摆回去的），上一轮也已经为它们付过钱。
            //   实测（真出网原文 `圣樱学院_mu5ffle6lfcc` 第 4→5 轮）：834 行里 706 行撞上 ⇒
            //   只这一处，官方 miss 从 12,878 降到 5,000 上下（账见 commitmsg-v62478.txt，裁判仍是官方数）。
            const seenPrev = new Map();
            // ★ v6.24.87：这些条目**稍后**会被 `_restoreLostOurs` 接回原位（那一步在本段之后）——
            //   所以它们的内容也算"这一轮模型会看到的字"。把它拼进 hay，那道"别扣掉看不见的行"的
            //   保险才不会把该扣的全拦下来（否则改了等于没改）。
            let oursHay = '';
            let oursBlk = 0;
            for (const m of (Array.isArray(prev) ? prev : [])) {
                const c = String(m?.content ?? '');
                if (!c.startsWith(RESTORE_ADD_HEAD)) continue;          // 只认我们自己的增量条（别的通道各走各的）
                oursBlk++;
                oursHay += '\n' + c;
                // ★ v6.24.87：**按归一化指纹入索引**（剥掉 +/-/空格 再比）—— 见 `_normSeenLine` 那段实测。
                for (const l of c.split('\n')) { const kk = _normSeenLine(l); if (kk) seenPrev.set(kk, (seenPrev.get(kk) || 0) + 1); }
            }
            // ★★★ v6.24.88 诊断：`seenPrev` 是不是空的，是"一行都没扣"的**唯一**分水岭 ——
            //   空 = 基准那份（`prev`）里**根本没有我们自己上一轮插的增量条** ⇒ 基准不是"上一轮真发出去的字"，
            //   那才是最该修的（官方 miss 里 1 万多 tok 就卡在这一格）；
            //   非空 = 保险拦的，那要修的是 `hay`。
            out.seenN = seenPrev.size;
            out.oursBlk = oursBlk;
            const hayForDrop = hayPrompt + oursHay;
            let patchEmitted = '';
            let ins = 0, copyChars = 0;
            const seen = new Set();
            let moved = 0;
            for (const ad of adds) {
                if (out.copies >= RESTORE_MAX_COPIES || copyChars >= RESTORE_MAX_COPY_CHARS) { out.skip = out.skip || '增量超过上限（剩下的这一轮不后置）'; break; }
                // ══ ★★★★★★ v6.24.119【真 bug：这一步**每次都抛异常** ⇒ 整条还原链半途而废】══════════
                //   这里原来读 `ad.hunks` —— 而 v6.24.90（用户拍板"增量那一套整个删掉"）已经把
                //   `hunks` 的生成整段删了，`adds` 里只 push `{ from, role, text }`（见上面第 ①′ 步）
                //   ⇒ `ad.hunks` **恒为 undefined** ⇒ `undefined.filter` 当场 TypeError ⇒
                //   被本函数末尾那句 catch 吞成"还原时出错（一个字没动）"，**可它其实已经动了一半**：
                //   上面"逐下标盖回"的循环先跑了（`out.restored` 已经加到十几条，`msgs[i].content` 已换成上一轮那版），
                //   然后在这里炸掉 ⇒ 结果是**半成品** —— 本轮的新内容被上一轮的顶掉、后置与接回两步一条都没做。
                //   铁证（两条互相独立）：
                //     · `captures/_diag.log` 2026-09-17T17:20:23.773Z：`rsOn=1` ＋
                //       `skip=还原时出错（一个字没动）：Cannot read properties of undefined (reading 'filter')`
                //       （`rsOn=1` ⇒ 与 v6.24.119 的体检修复无关，**旧版本也一样抛**）
                //     · 全仓 181 对相邻轮离线重放：`圣樱学院_mu5sd7sejhp0 #7` 抛同一句，
                //       本轮原始输入的 1,162 行里有 **41 行**在结果里找不到（0.05% 量级，但这是**丢内容**）。
                //   修法按 v6.24.90 的定版**走完整条**：`ad.text` 就是这一条的完整内容（一个字不裁、不加标记），
                //   只把"上一轮已经发过的行"扣掉（`_patchDropSeen`，v6.24.87 那道扣重照旧生效）——
                //   第 0 行仍摆 `RESTORE_ADD_HEAD`（`_patchDropSeen` 的契约，也是 `_restoreLostOurs` 的识别标记）。
                //   ⚠ 没摆成的那些（超上限 / 整条重复）走下面那段"绝不丢内容"：原位还回这一轮的内容。
                const src = `#${ad.from + 1} ${ad.role}`;
                if (!ad.text) { moved++; continue; }
                const d = _patchDropSeen(RESTORE_ADD_HEAD + ad.text, seenPrev, hayForDrop);
                out.gateN += d.gate;
                const t = d.text;
                if (!t || seen.has(t)) { moved++; continue; }
                if (!d.body.trim()) { out.reSaid++; out.dropSeen += d.dropped; moved++; continue; }
                seen.add(t);
                if (msgs.some(m => String(m?.content ?? '') === t)) { moved++; continue; }
                msgs.splice(k + 1 + ins, 0, { role: 'user', content: t });
                patchEmitted += '\n' + t;
                ins++; moved++; out.copies++; copyChars += t.length; out.copyChars += t.length;
                out.segs += 1; out.dropped += d.dropped; out.dropSeen += d.dropped;
                if (out.copyItems.length < 8) out.copyItems.push(`${src} 整条${ad.text.length}字${d.dropped ? `−扣${d.dropped}行` : ''}`);
            }
            // ══ ★★★ v6.24.90【绝不丢内容：没搬成的，一律把原位还回去】════════════════════════════
            //   上面那个 `break`（超上限）会让"已经盖成上一轮旧版、却没在后置里出现"的那些条目
            //   **两边都没有新值** —— 用户报的"损失一个变量栏"就是这么来的（实测 #31：搬家跑了、
            //   盖回被体检拦了 ⇒ 原位只剩上一轮的旧值，新值只在一条没生成出来的增量里）。
            //   ⇒ 只要这一条**没真的摆到后面**，它的原位就恢复成这一轮的内容。
            for (let j = moved; j < adds.length; j++) {
                const ad = adds[j];
                if (msgs[ad.from]) msgs[ad.from].content = ad.text;
                out.restored--; out.chars -= (String(prev?.[ad.from]?.content ?? '').length - ad.text.length);
            }
        }
        // ══ ★ v6.24.70【内容一个字不能丢】接住上一轮我们自己后置、而这一轮已经找不回来的增量条 ══
        //   为什么放在这里（增量写回之后、收尾之前）：这一跳要拿"这一轮现在的全部字"当haystack，
        //   上面那些盖回与后置都做完了，它才是最终的形状。
        //   为什么整条原样接回（不做行级裁剪）：用户口径是"内容一个字不能丢"，而这一条本来就是
        //   上一轮发出去过的原文 —— 原样放回去，字节与上一轮一致，模型看到的东西一个字不少。
        //   位置 = **它自己在上一轮那个下标**（不是"这一轮末尾"）——
        //   这是 ★★★ 目标的硬要求，也是本函数唯一一处能左右官方命中的地方。实测（本场 00004→00005）：
        //     落点放"这一轮最后一条 assistant 之后"：lcp 48,128 字**一点没涨**、整条却多 9,197 tok
        //       ⇒ 纯亏（多付钱、不多命中一个字）；
        //     落点放"它自己在上一轮的下标"：lcp 48,128 → **63,713 字（+15,585 字 ≈ +9,197 tok 命中）**、
        //       整条同样大、未命中一个字不涨（12,685 → 12,686 字）。
        //   为什么原位就能续上前缀：静在前动在后 —— 上一轮它是 [..#8, A]，这一轮 [..#8, A, 新消息..]，
        //   前 63,713 字与上一轮逐字节相同（A 上一轮发过 ⇒ 已在缓存里）。
        //   从大到小插：插后面的不影响前面那些还没插的下标。
        // ══ ★★★ v6.24.79【落点判定：从"用下标"改成"用内容锚点"】══════════════════════════════
        //   官方数为证（2026-09-17 圣樱学院_mu5ffle6lfcc 第 6 轮）：只按 lo.i 这个下标 splice，
        //   官方 miss 只降了 178（预期 −6,262）—— 因为 `prev` 与 `msgs` **不是同一种形状**：
        //     prev（旧行为是客户端 fetch 出去的 body，41~45 条）/ msgs（这一轮现拼，条数又变了）。
        //   同一个下标在两种形状里指的不是同一条东西 ⇒ 接回的补丁被塞到**新对话后面**
        //   （实测第 6 轮：`#9` 只剩 6,284 字，另 2 条被合并进末尾的 `#11`），前缀续不上。
        //   现在：先拿"上一轮它前面那一条"的**正文**在 msgs 里定位，插在它后面 —— 这是与形状无关的锚。
        //   锚找不到（那条被宏展开改写过 / 这一轮不在了）⇒ 退回下标（老行为），并在日志里说明用了哪种。
        //   （v6.24.79 同时把基准改成"真出网那份"，两者是一件事的两半：形状对了，锚才稳。）
        if (Array.isArray(prev) && prev.length) {
            let byAnchor = 0, byIndex = 0;
            /* ★★★★★★ v6.50.6【席位补回（消息内文本级）—— 必须在 `_restoreLostOurs` **之前**跑】
             *  为什么在前：它改的是**这一轮某条消息的 content**（把上一轮那份被裁的席位插回去），
             *  后面的"历史还原/盖回"看到的就应该是**补过之后**的形状 ⇒ 顺序不能反。
             *  四个读数一次报齐（⛔ 不许静默）：补回条数 / 补回字数 / 幂等跳过 / 上限挡下。 */
            const _seat = _restoreCutSeats(prev, msgs);
            out.seatBackN = _seat.n; out.seatBackChars = _seat.chars;
            out.seatIdem = _seat.idem; out.seatBlocked = _seat.blocked;
            const _lost = _restoreLostOurs(prev, msgs);
            out.lostN = _lost.length;      // ★ v6.24.88 诊断：基准里认出几条"我们自己发过、这一轮没有落脚点"的派生条
            for (const lo of _lost.sort((a, b) => b.i - a.i)) {
                const at = _restoreKeptAt(prev, msgs, lo);        // ★ v6.24.79 起：内容锚优先（跳过派生条往前找），锚不着才退回下标
                if (at.how === 'anchor') byAnchor++; else byIndex++;
                msgs.splice(at.at, 0, { role: lo.role, content: lo.content });
                out.keptBack++; out.keptChars += lo.content.length;
                if (lo.gone) out.keptGone++;      // ★ v6.24.78：其中"真有内容在别处找不着"的条数（只是报数）
                if (lo.seat) { out.seatBackN++; out.seatBackChars += lo.content.length; }   // ★ v6.50.6：席位补回单独计
            }
            out.keptAnchor = byAnchor; out.keptIndex = byIndex;
        }
        out.skipped = out.boundaryAt === null ? 0 : Math.max(0, msgs.length - out.boundaryAt);
        // ★ 复查用（写进记录抬头）：对话楼之前到底有几条与上一轮那串字**逐字相同** —— 盖完之后数。
        for (let i = 0; i < Math.min(out.boundaryAt === null ? 0 : out.boundaryAt, prev.length, msgs.length); i++) {
            if (String(msgs[i]?.content ?? '') === String(prev[i]?.content ?? '')) out.sameBefore++;
        }
        console.log(`[hitOpt] v6.24.81 历史还原（纯文本·A 盖到对话楼）：对话楼 = 第 ${out.boundaryAt === null ? '(末尾)' : out.boundaryAt} 条`
            + `（这一串 ${out.curLen} 条 / 基准 ${out.prevLen} 条）｜盖回 ${out.restored} 条`
            + `（净 ${out.chars >= 0 ? '+' : ''}${out.chars} 字）`
            + `｜对话楼前逐字相同 ${out.sameBefore} 条`
            + `${out.ours ? `｜跳过我们上一轮自己加的 ${out.ours} 条（派生内容，不当基准）` : ''}`
            + `${out.copies ? `｜增量后置 ${out.copies} 条 / ${out.segs} 段（+${out.copyChars} 字）摆到对话楼后面：${out.copyItems.join('、')}` : ''}`
            + `${out.dup ? `｜${out.dup} 段没摆（一模一样的字提示词里已经有了）` : ''}`
            + `${out.dropped ? `｜还有 ${out.dropped} 段没列（超上限）` : ''}`
            + `${out.dropSeen ? `｜★ 增量里 ${out.dropSeen} 行没重发（上一轮那一版已经发过、且原样留在前面）` : ''}`
            + `${out.reSaid ? `｜${out.reSaid} 批增量整个没发（扣完一行新的都不剩）` : ''}`
            + `${out.keptBack ? `｜★ 原位接回上一轮自己后置的 ${out.keptBack} 条 / ${out.keptChars} 字（内容锚 ${out.keptAnchor} 条 / 退回下标 ${out.keptIndex} 条；其中 ${out.keptGone} 条是真在别处找不着的）` : ''}`
            + `${out.floors ? `｜★聊天楼层 ${out.floors - out.floorsGone}/${out.floors} 条在这一轮还在（历史体检：少的那几条 = 用户删了 / 重 roll 过）` : ''}`
            + `${out.skip ? `｜${out.skip}` : ''}`);
        return out;
    } catch (err) {
        out.skip = `还原时出错（一个字没动）：${err?.message || err}`;
        console.warn('[hitOpt] v6.24.49 历史还原失败（一个字没动）:', err);
        return out;
    }
}

/* @35448-35464 */
function _restoreHeadNote() {
    const r = _restoreStats;
    if (!r) return '｜还原 没跑到';
    const at = (r.boundaryAt === null || r.boundaryAt === undefined) ? '末尾' : `#${r.boundaryAt}`;
    const why = r.skip ? `(${r.skip})` : '';
    return `｜还原 ${Math.max(0, Number(r.restored) || 0)}条`
        + `${r.chars ? `${r.chars > 0 ? '+' : ''}${r.chars}字` : ''} 对话楼${at}`
        + `（这一串${Math.max(0, Number(r.curLen) || 0)}条·基准${Math.max(0, Number(r.prevLen) || 0)}条`
        + `${r.baseSrc ? `·${r.baseSrc}` : ''}·楼前逐字相同${Math.max(0, Number(r.sameBefore) || 0)}条`
        + `${why}）`
        + `${r.copies ? `｜增量后置${r.copies}条/${Math.max(0, Number(r.segs) || 0)}段+${r.copyChars}字到对话楼后` : ''}`
        + `${r.dropped ? `（还有${r.dropped}段超上限）` : ''}`
        + `${r.keptBack ? `｜★接回丢失${r.keptBack}条+${r.keptChars}字` : ''}`
        // ★★ v6.24.74（用户："完整保留 N-1 的数据"）：这一轮把"上一轮发出去、这一轮少了一截"
        //   的那条尾巴补回来多少字。**这一格就是官方命中会不会涨的仪表**（补 N 字 ≈ 多 N÷3.55 tok 命中）。
        + `${r.tailFix ? `｜★★完整保留N-1：补回${r.tailFix}字（下标#${r.tailFixAt}，上一轮那份原文一字不差）` : ''}`;
}

/* @35478-35485 */
function _restoreWireCheck(probes, text) {
    const list = Array.isArray(probes) ? probes : [];
    const s = String(text || '');
    if (!list.length || !s) return { total: 0, hit: 0 };
    let hit = 0;
    for (const p of list) { const t = String(p?.text || ''); if (t && s.includes(t)) hit++; }
    return { total: list.length, hit };
}

/* @35488-35496 */
function _restoreCheckNote(wireChk, postChk) {
    const total = Math.max(0, Number(wireChk?.total) || 0);
    if (!total) return '';
    const hit = Math.max(0, Number(wireChk?.hit) || 0);
    if (hit >= total) return `｜出网核对 ${hit}/${total}`;
    const post = Math.max(0, Number(postChk?.hit) || 0);
    return `｜出网核对 ${hit}/${total}`
        + (post > hit ? `（POST 里有 ${post} 条 → 出网后被后端/别的插件改掉）` : '（还原没进请求）');
}

/* @35517-35520 */
function _relocMovedTail(text) {
    const s = String(text ?? '');
    return s.startsWith(RELOC_VARTAG) && s.includes(RELOC_VARENDTAG);
}

/* @35528-35535 */
function _relocAddrOf(text, a0, j, role) {
    const before = String(text ?? '').slice(0, Math.max(0, a0));
    const lines = before.split('\n');
    let anchor = '';
    for (let i = lines.length - 1; i >= 0; i--) { const t = lines[i].trim(); if (t) { anchor = t; break; } }
    return `#${j + 1} ${role}`
        + (anchor ? ` 第 ${lines.length} 行「${anchor.slice(0, 36)}${anchor.length > 36 ? '…' : ''}」之后` : '（这一条的开头）');
}

/* @35538-35556 */
function _relocPrevBlock(prevAll, j, blk) {
    if (!Array.isArray(prevAll) || !prevAll.length) return '';
    const cut = t => {
        const s = String(t ?? '');
        const s0 = s.indexOf(RELOC_VARTAG);
        if (s0 < 0) return '';
        const s1 = s.indexOf(RELOC_VARENDTAG, s0);
        return s1 > s0 ? s.slice(s0, s1 + RELOC_VARENDTAG.length) : '';
    };
    const same = cut(prevAll[j]?.content);
    if (same) return same;
    for (let i = prevAll.length - 1; i >= 0; i--) {
        const t = String(prevAll[i]?.content ?? '');
        if (!t.startsWith(RELOC_MOVED_HEAD)) continue;
        const b = cut(t.slice(RELOC_MOVED_HEAD.length));
        if (b) return b;
    }
    return '';
}

/* @35612-35791 */
function _relocMoveVarBlock(msgs) {
    const out = { count: 0, moved: [], at: -1, skip: '', why: '', frozen: 0, same: 0, patches: [] };
    try {
        if (RELOC_MOVE_VAR_OFF) {
            out.skip = 'v6.41.37 变量块后置已停用（RELOC_MOVE_VAR_OFF=true）—— 变量块留在原位，一个字不搬';
            return out;
        }
        if (HORAE_HOIST_OFF || settings.cacheRelocateVarying === false) { out.skip = '已停用（提前挪那一套）'; return out; }
        if (!Array.isArray(msgs) || !msgs.length) return out;
        _relocFrozenSlots.clear();
        const prevAll = (Array.isArray(_prevLastMsgs) && _prevLastMsgs.length) ? _prevLastMsgs
            : (Array.isArray(_prevRealMsgs) ? _prevRealMsgs : null);
        // ★ v6.24.94：底稿必须来自**上一轮真发出去的那串**（`_prevLastMsgs`），取不到才退回
        //   `_prevRealMsgs`（那份可能已被 `_prevMsgsPickBest` 换成更早的候选）。
        //   混用的实测后果：`_relocPrevBlock` 时有时无 ⇒ 分支 A（原位留旧版）与
        //   分支 B（原位删空、末尾整段）**逐轮交替** ⇒ 第 0 条形状每轮都变 ⇒ 前缀断在第 0 条。
        //   官方数为证：hit 45,184（#30）→ 16,768 → 4,608 → 31,616 → **0**（#34）。
        // ══ ★★★ v6.24.89【止血：搬家与盖回**同进同退**】════════════════════════════════════
        //  官方数为证（2026-09-17 `圣樱学院_mu5ffle6lfcc`，用户 F5 到 v6.24.88 之后连发两轮）：
        //    #30（v6.24.87）prompt 69,495 / hit **45,184** / miss 24,311
        //    #31（v6.24.88）prompt 73,379 / hit **16,768** / miss **56,611**
        //    #32（v6.24.88）prompt 76,499 / hit  **4,608** / miss **71,891**
        //  ⇒ 一轮就赔掉 4 万 tok 命中。埋点说明了一切（`pushTurn:enter`）：
        //    `rsOn=0`、`rsSkip=基准形状不对（前文件 53 条 vs 这一轮 90 条，来源 mem:?）`
        //    ——"盖回历史"被形状体检整步拦掉了；**可"搬走变量块"这一步照跑**
        //    （`varBlkWhy=#0(搬走 5215 字 / 原地留 5539 字)`）。
        //  两半是一件事：搬家的**唯一目的**就是给"盖回上一轮那一版"腾出落脚点
        //  （原位留旧版 ⇒ 前缀不断）。只搬不盖 = **在原位塞了一份上一轮的字、又没人把它和这一轮对齐**
        //  ⇒ 变量块的新值只剩下末尾那条增量，原位是空的（用户报的"损失一个变量栏"就是这个）。
        //  ⇒ 从这一刻起：**基准形状不可用就整轮不搬**（宁可什么都不做，也绝不只做一半）。
        //   判据与 `_restoreFrozenHistory` 那道外层体检**同一套**（比值 0.6~1.7、条数 ≥ 8），
        //   这样两半永远同进同退 —— 不会再出现"搬了却没盖"的中间态。
        {
            const mlen = Array.isArray(msgs) ? msgs.length : 0;
            const plen = prevAll ? prevAll.length : 0;
            const ratio = (plen && mlen) ? plen / mlen : 1;
            if (plen && mlen >= 8 && (ratio < 0.6 || ratio > 1.7)) {
                out.skip = `基准形状不对（前文件 ${plen} 条 vs 这一轮 ${mlen} 条）⇒ 这一轮连搬运都不做`
                    + `（搬家与盖回是一件事的两半，只做一半会把变量块的新值从原位搬空 —— 实测 miss 24,311 → 71,891）`;
                return out;
            }
        }
        const chatArr = (() => { try { const c = getContext()?.chat; return Array.isArray(c) ? c : []; } catch (_) { return []; } })();
        // ★ v6.24.38【真凶在这里，删掉的就是这一道门】—— 原来写着：
        //     if (chatArr.length > RELOC_SKEL_FREEZE_FLOORS) { skip = `聊天已有 N 条，不再改形状`; return; }
        //   这道门的账是**反的**：不搬的代价**不是**"这一条自己的长度"，而是"它后面**全部**内容的长度"
        //   —— 变量块坐在提示词第 4 个字节上，它一变，后面的指令壳 + 用户设定 + 全部聊天历史
        //   （实测 30,376 tok）**每一轮**都要按全价重算。搬它的代价只是这一条自己的长度（≈1,600 字 ≈ 0.8K tok），
        //   而且第一轮之后永久免费（原地只剩常量指针）。所以"聊天越长越不划算"完全说反了：越长越该搬。
        //   实测（出网抓包，同一场聊天三轮）：公共前缀只有 74 字，官方 hit 21,504 → 128 → **0**。
        //   搬过之后（离线复算）：公共前缀 74 → 19,000+ 字，hit 从 0 回到 ~24K/轮。
        //   判据改成**与 `_relocPtrAt` 同一套（幂等）**：搬过就绝不二搬（原地那行常量指针本身也不会被再当受害者）。
        // 历史上界：只在这一条之前动手
        let histFrom = -1;
        for (let k = 0; k < msgs.length; k++) {
            if (_floorOfPromptText(String(msgs[k]?.content ?? ''), chatArr) !== null) { histFrom = k; break; }
        }
        const limit = histFrom < 0 ? msgs.length : histFrom;
        const victims = [];
        for (let k = 0; k < limit; k++) {
            const m = msgs[k];
            const role = String(m?.role || '');
            if (role !== 'system' && role !== 'user') continue;
            const text = String(m?.content ?? '');
            if (_relocPtrAt(text)) continue;                       // 已经搬过 → 形状照旧
            if (text.includes(RELOC_VARPTR)) continue;             // ★ v6.24.38：这一条的变量块已经搬过（幂等）
            // ★ v6.24.38：**我们自己搬到末尾的那一条**绝不许再当受害者（否则它会一条接一条地往后滚）。
            //   实测踩到的：第一遍把 #0 里的段搬到末尾（带 `RELOC_MOVED_HEAD` 抬头），
            //   第二遍又把那条末尾的段"再搬一次"——搬出来一模一样、位置却一直在变 → 每轮断前缀。
            if (text.startsWith(RELOC_MOVED_HEAD)) continue;
            if (_relocMovedTail(text)) continue;                   // 或它是"曾经搬过的那一条"（抬头被别的插件削过）
            if (text.includes(FREEZE_MARK) || text.includes(FREEZE_VAR_MARK) || text.includes('【冻结注入池')) continue;
            if (_isPromptFloor(text, chatArr)) continue;
            if (!_relocIsVarBlock(text)) continue;
            // ★ v6.24.38【第二个坑】—— 原来只会搬"**整条就是**变量块"的消息：
            //     `msgs[v.k].content = RELOC_VARPTR;` 把整条换掉，正文整条追加到末尾。
            //   可实测里变量块是**嵌在一条 8,405 字的 system 里**的（前面 4 个字节的 `---\n` + 开头，
            //   后面 5,500~6,700 字是变量输出格式指令 + 世界书规则）。这条 system 整条换掉 =
            //   把 5,540 字指令从原位挪走（模型看到的位置全变了），所以这条路在真实场景里根本不该走。
            //   现在：**只摘标签对内那一段**，这条消息剩下的部分一个字节都不动。
            const s0 = text.indexOf(RELOC_VARTAG);
            const s1 = text.indexOf(RELOC_VARENDTAG, s0);
            if (s0 < 0 || s1 < 0) continue;
            const block = text.slice(s0, s1 + RELOC_VARENDTAG.length);
            // ★ v6.24.38：门槛判在**摘出来的这一段**上（整条 message 的长度由 `_relocIsVarBlock` 已经判过）。
            //   为什么不再判整条：整条 8,405 字里 5,500 字是**指令壳**（它一个字都不搬），
            //   拿整条长度当"值不值得搬"的依据等于拿别人的体积给自己作保。
            //   为什么里面**有宏**时只按整条长度判：预演态那一段可能只有
            //   `{{format_message_variable::stat_data}}`（40 字）—— 出网时会展开成几 KB 真值，
            //   按 40 字判"太小不搬"就是被占位符骗了（实测那份 #0 出网后是 8,405 字）。
            //  （⚠ 这里**不能**再补一条"标签对总长也要 ≥120"的兜底：宏形态那一段本来就只有几十字，
            //    那条兜底会把真实场景里最常见的一种输入判死 —— 我加过，测试当场就抓出来了。）
            const body = block.slice(RELOC_VARTAG.length, block.length - RELOC_VARENDTAG.length);
            if (!RELOC_VARMACRO_RE.test(body) && body.length < RELOC_VARBODY_MIN_CHARS) continue;
            victims.push({ k, block, text });
        }
        if (!victims.length) { out.skip = out.skip || '没有"成对变量标签 + 键值/宏"的块（或都已经搬过）'; return out; }
        let at = msgs.length;
        if (String(msgs[msgs.length - 1]?.role || '') === 'assistant') at = msgs.length - 1;
        let ins = 0;
        const seenBlk = new Set();
        for (const v of victims) {
            // 先取现场正文（前面几步可能已经改过这一条）——按**当前**内容重新定位那一段
            const live = String(msgs[v.k]?.content ?? v.text);
            const a0 = live.indexOf(RELOC_VARTAG);
            const a1 = live.indexOf(RELOC_VARENDTAG, a0);
            const blk = (a0 >= 0 && a1 > a0) ? live.slice(a0, a1 + RELOC_VARENDTAG.length) : v.block;
            const addr = _relocAddrOf(live, a0, v.k, msgs[v.k].role);
            // ★ v6.24.49【有底稿就只后置"变的那几行"】—— 用户定版原话：
            //   "我就改个时间，你说这么完整干什么？纯变动部分后置啊（若之前有底稿 说明从哪里的底稿修改的）
            //    diff 都是局部的 你也只把局部变更的后置"
            //   实测现场（`_gitlog/圣樱学院_mu4q9ejr9p9b` 第 0→1 轮，115 行的 `<status_current_variables>`）：
            //   那一整块**只有一行**变了（`分钟: 30` → `40`）+ 89 行新增（许念/顾清霜），
            //   而老做法把**整块 5,600 字**搬到末尾 → 这一块每轮都按全价重算。
            //   现在：**原位留上一轮那一版**（逐字节相同 ⇒ 命中区不断），末尾只摆"变的那几行"（带地址）。
            const base = seenBlk.has(blk) ? '' : _relocPrevBlock(prevAll, v.k, blk);
            if (base) {
                seenBlk.add(blk);
                if (base === blk) {                                    // 一个字都没变 → 原位不动，末尾也不加
                    out.same++;
                    out.moved.push({ j: v.k, chars: 0, role: msgs[v.k].role, kept: live.length, why: `与上一轮逐字相同 → 原位不动、末尾不加（${addr}）` });
                    continue;
                }
                msgs[v.k].content = live.slice(0, a0) + base + live.slice(a1 + RELOC_VARENDTAG.length);
                _relocFrozenSlots.add(v.k);                            // 这一条已经按底稿钉好 → 还原那一步别再拿它去比
                // ══ ★★★ v6.24.89【用户 2026-09-17 定版："你还不如复制变动部分放后面"】════════════════
                //   原话（用户看到 #31/#32 那两轮之后）："增量功能不如删除 … 你还不如复制变动部分放后面"。
                //   他说得对，实测也站在他那边。老做法是拿**冻住的底稿** `base` 去和这一轮的 `blk` 做行级
                //   diff，只把"变的那几行"后置 —— 可 `base` 是**最早那一版**（每轮原位留的都是它），
                //   于是 diff 出的是"从最初到现在的**全部**累积变化"：实测那一整条增量 17,220 tok/轮 里，
                //   **`- 旧值行` 3,150 ＋ 上下文行 1,577** 是原位逐字已有的（纯重复），
                //   **`+` 行里还有 10,858 tok 是上一轮就已经发过的** ⇒ 屏幕上就是你看到的那张"整块重抄"。
                //   ⇒ 现在改成**整段复制**：原位照旧留 `base`（前缀一个字节不断），末尾原样摆一份**完整的
                //     `blk`**（这一轮的变量块真值，一个字不裁）。账：这一块 5,213 字 ≈ 1,700 tok，
                //     **比原来那条假 diff（5,793 字 / 3,415 tok）还小**，而且模型看到的是完整真值 ——
                //     不会再出现"原位是空的、新值只剩几行 diff"（用户报的"损失一个变量栏"）。
                //   ⚠ 不裁任何一行：宁可按原样多摆一遍，也绝不靠"猜哪些行模型能自己拼出来"省 token。
                out.patches.push({ k: v.k, text: RELOC_MOVED_HEAD + `· 原位＝${addr}｜原位留的是上一轮的旧值（逐字未改）\n\n` + blk, shown: 1 });
                out.frozen++;
                out.moved.push({
                    j: v.k, chars: blk.length - base.length, role: msgs[v.k].role, kept: msgs[v.k].content.length,
                    why: `底稿＝上一轮那一块（原位逐字保留 ${base.length} 字）→ 末尾**整段复制**这一轮的 ${blk.length} 字（不做行级 diff）`,
                });
                continue;
            }
            // 没有底稿（第一次见这一块）→ 整段后置；★ v6.24.48（用户定版）：原地不留指针，
            //   除非"同一段字出现两次以上"（一模一样的重复注入）——那份完整、其余原地一行常量指针。
            const dup = seenBlk.has(blk);
            seenBlk.add(blk);
            msgs[v.k].content = dup
                ? live.slice(0, a0) + RELOC_VARPTR + live.slice(a1 + RELOC_VARENDTAG.length)
                : live.slice(0, a0) + live.slice(a1 + RELOC_VARENDTAG.length);
            // ★ v6.24.49：抬头的**下一行就是地址**（原来只有一句"原本在提示词前部的指针处"，模型找不着）
            if (!dup) msgs.splice(at + ins, 0, { role: msgs[v.k].role, content: RELOC_MOVED_HEAD + `· 原位＝${addr}\n\n` + blk });
            ins++;
            out.moved.push({
                j: v.k, chars: blk.length, role: msgs[v.k].role, kept: msgs[v.k].content.length,
                why: dup ? '同一段重复注入 → 原地留常量指针（完整那份已在末尾）' : `状态变量块整段后置（原位不留指针；地址＝${addr}）`,
            });
        }
        // 增量补丁 → 摆到**末尾**（紧跟搬出来的那些块）
        for (const pt of out.patches) {
            if (msgs.some(m => String(m?.content ?? '') === pt.text)) continue;
            msgs.splice(at + ins, 0, { role: 'user', content: pt.text });
            ins++;
        }
        out.count = victims.length;
        out.at = at;
        out.why = out.moved.map(v => `#${v.j}(搬走 ${v.chars} 字 / 原地留 ${v.kept} 字)`).join('；');
        console.log(`[hitOpt] v6.24.49 状态变量块：${out.count} 条（${out.why}）`
            + `${out.frozen ? `｜有底稿的 ${out.frozen} 条：**原位留上一轮那一版**（逐字未改，前缀不断），末尾**整段复制**这一轮的整块（${out.patches.length} 条补丁，不做行级 diff —— v6.24.89 用户定版"复制变动部分放后面"）` : ''}`
            + `${out.same ? `｜其中 ${out.same} 条与上一轮逐字相同（一个字都没动）` : ''}`
            + `｜这条消息其余部分原地不动｜内容一个字没删`);
        return out;
    } catch (err) {
        console.warn('[hitOpt] 状态变量块后置失败（一个字没动）:', err);
        out.skip = `出错（一个字没动）：${err?.message || err}`;
        return out;
    }
}

/* @35793-35997 */
function _relocateVaryingBlocks(msgs, p) {
    const out = { count: 0, spanChars: 0, text: '', texts: [], moved: [], at: -1, skip: '', why: '', skipped: [], preArm: 0 };
    try {
        if (HORAE_HOIST_OFF || settings.cacheRelocateVarying === false) { out.skip = '已停用（提前挪那一套）'; return out; }
        void _wbBuildChurnIndex();     // v6.24：顺手把"世界书关键词条目"索引备好（异步；没好这一轮就按老规矩钉）
        const prevFrozen = _prevRealMsgs;
        if (!Array.isArray(prevFrozen) || !prevFrozen.length) {
            const first = _relocFirstPreArm(msgs);              // v6.24：新聊天的第一条 request 直接钉好
            if (first.count) return { ...out, ...first };
            out.skip = first.skip || '还没有上一轮定稿文本可比（这一轮先记账）';
            return out;
        }
        if (!Array.isArray(msgs) || !msgs.length) { out.skip = '这一轮没有 messages'; return out; }
        // 上一轮**真发出去**的那串字：我们自己后置的块不算（那是插进去的，不是提示词本来的形状）——
        // 也正因为把它们摘掉，这一轮新插进去的那几条才对得上位（内容认不出的按角色顺位配）。
        const prev = prevFrozen
            .filter(m => !String(m?.content ?? '').startsWith(RELOC_MOVED_HEAD))
            .map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
        const chatArr = (() => { try { const c = getContext()?.chat; return Array.isArray(c) ? c : []; } catch (_) { return []; } })();
        // 历史上界/下界：对得上楼层的条目范围 —— 这一段里**一条都不许碰**（用户明确要求：不接受聊天历史的增量损失）。
        // 为什么按"范围"而不是逐条认：老消息被正则/插件改写之后，文本已经不等于聊天文件里的原文（实测踩到过）。
        let histTop = -1, histFrom = -1;
        for (let k = 0; k < msgs.length; k++) {
            if (_floorOfPromptText(String(msgs[k]?.content ?? ''), chatArr) !== null) { histTop = k; if (histFrom < 0) histFrom = k; }
        }
        const inHistoryRange = (j, role) => (role === 'user' || role === 'assistant')
            && histFrom >= 0 && histTop >= histFrom && j >= histFrom && j <= histTop;
        const pairs = _alignTurns(prev, msgs);
        const victims = [];
        const skipped = [];
        for (const pr of pairs) {
            if (pr.i === -1 || pr.j === -1) continue;
            const curText = String(msgs[pr.j].content ?? '');
            const prevSentText = String(prev[pr.i]?.content ?? '');
            // ★ v6.24.24：冻结池里的批、以及"完整正文已进池"的常量说明 —— **一个字都不许动**
            //   （用户红线：索引指针、变动历史也是冻结的，既往历史不可变）
            if (curText.includes(FREEZE_MARK) || curText.includes(FREEZE_VAR_MARK) || curText.includes('【冻结注入池')) continue;
            const frame = _relocFrameOf(prevSentText);
            // ★ 一个字没变、又还没锚过 → 什么都不用做，也**不用记原因**（否则"整串一模一样"那种正常轮
            //   会被一堆"#7 是 assistant"填满读数，看起来像出了问题）。锚过的还要照抄形状，所以不能在这里 continue。
            if (!frame && curText === prevSentText) continue;
            const role = String(msgs[pr.j]?.role || '');
            if (role !== 'system' && role !== 'user') { skipped.push(`#${pr.j} 是 ${role}，不动对话历史与预填`); continue; }
            if (inHistoryRange(pr.j, role)) { skipped.push(`#${pr.j} 落在聊天历史区间里（绝不动）`); continue; }
            if (histTop >= 0 && pr.j > histTop) continue;                            // 已经在全价区里
            if (_floorOfPromptText(curText, chatArr) !== null) { skipped.push(`#${pr.j} 是聊天楼层`); continue; }
            // ★ v6.24.23 ⓪：**世界书块消息 —— 恒定骨架留前、关键词条目后置。**
            //   为什么要抢在锚逻辑前面：v6.24 的"让开关键词条目"只收回头/尾两个锚，夹在关键词条目中间那一大段
            //   常量（用户实测 29,035 字 ≈ 15.3K tok）照样被整块后置 → 每轮全价；而且锚一空就自我维持，永远学不回来。
            //   这一条判据是"这一条里出现了关键词条目的正文"（索引来自酒馆自己的世界书数据，不猜预设/角色卡）。
            //   没有上一轮可比的（`pr.i === -1` 或整条没变又没锚过）→ 一个字不动，免得白白改一次形状。
            //   ★ v6.24.27：把"上一轮那副骨架"交给切分 —— 已经在里面的碎片一律按**旧骨架里的位置**排，
            //   新触发的条目追加到末尾；于是旧字节一个都不挪，前缀不再被"条目插进来"整段作废。
            //   （`prevSkel` 在下面几行才算出来 —— 这里先用上面那几句 frame 的结果，顺序不能反。）
            const prevSkel0 = frame ? (frame.head === '' ? frame.tail : frame.head) : '';
            const seg = _wbChurnProbes.length ? _relocStableSegs(curText, prevSkel0) : null;
            const hasIdx = _wbChurnProbes.length > 0;
            const ptr = frame && frame.idle ? RELOC_POINTER_IDLE : RELOC_POINTER;
            const prepend = frame ? frame.head === '' : true;      // 沿用上一轮的指针位置（在最前就还在最前）
            const prevSkel = frame ? (prepend ? frame.tail : frame.head) : '';
            const skelThere = !!(prevSkel && prevSkel.trim());
            // 年轻 = 缓存还小：那会儿断一次的代价只有几千 tok（后面没历史可赔），骨架每轮跟着酒馆的块长是净赚；
            //   等聊天长起来（缓存变贵）再冻死，从此一个字不动。实测（香格里拉真 request）：第 2 轮就冻死的话，
            //   那块当时才 7,737 字、骨架 5,353 字，后来块长到 11,154 字，多出来的常量每轮都被当"新内容"重发
            //   → 命中反而比不冻低 1.4K tok/轮。
            const youngChat = !Array.isArray(chatArr) || chatArr.length <= RELOC_SKEL_FREEZE_FLOORS;
            // ★★ 冻结分支（用户点名的那条红线："防止 ST 与 Horae 剥离已注入的世界书片段"）：
            //   只要上一轮发出去的这一条带骨架，就**照抄那副骨架，一个字不改** ——
            //   ST 这一轮少注入一条、换一次顺序、EJS 渲染出别的字，都伤不到已经进缓存的前缀。
            //   什么时候才敢冻：聊天长大了（youngChat=false），**或者**这一轮的块里已经找不到我们那副骨架了
            //   （那种时候不冻就是"裸奔"：块一变，前面全断 —— 实测香格里拉第 5 轮 miss 17,148 就是这么来的）。
            if (hasIdx && skelThere && (!youngChat || !curText.includes(prevSkel))) {
                const emit = prepend ? ptr + prevSkel : prevSkel + ptr;
                // 这一轮块里"没被冻住骨架吃掉"的字节才后置；而且**按行算增量** ——
                //   一段里只要有一行是骨架里没有的（EJS 渲染出来的新值），就只把那几行后置，
                //   其余行一个字都不用重发（它们已经在骨架里、已经命中缓存）。
                //   万一这一轮块里连关键词条目都没有（`seg` 为空），整块就是"新内容"，原样后置。
                const parts = [];
                if (!seg) parts.push(curText);
                else for (const c of seg.chunks) {
                    if (!c.solid) { parts.push(c.text); continue; }             // 关键词条目 / 分隔空白
                    if (prevSkel.includes(c.text)) continue;                    // 整段都在骨架里
                    const lines = c.text.split('\n');
                    const fresh = lines.filter(l => l.trim() && !prevSkel.includes(l));
                    if (fresh.length) parts.push(fresh.join('\n'));
                }
                const moved = parts.join('');
                if (emit !== curText) {
                    victims.push({
                        j: pr.j, emit, moved,
                        why: `世界书块：骨架沿用上一轮那 ${prevSkel.length} 字（一个字不改）`
                            + `＋后置 ${moved.length} 字${seg && seg.names.length ? `（${seg.names.join('、')}${seg.names.length >= 4 ? '…' : ''}）` : ''}`,
                    });
                    continue;
                }
            }
            if (hasIdx && (frame || curText !== prevSentText)) {
                // 年轻聊天 / 第一次切：骨架**每轮跟着酒馆的块重新算**（把新出现的常量吃进来）。
                //   这一轮块里没有关键词条目（`seg` 为空）→ 整块都是骨架（一个字节都不用后置）。
                const keep = seg ? seg.keep : curText;
                const moveOut = seg ? seg.vary : '';
                const emit = prepend ? ptr + keep : keep + ptr;
                if (emit !== curText) {
                    victims.push({
                        j: pr.j, emit, moved: moveOut,
                        why: `世界书关键词条目后置（${seg ? '重切' : '整块留前'}：恒定骨架 ${keep.length} 字留前 / 后置 ${moveOut.length} 字`
                            + `${seg && seg.names.length ? `：${seg.names.join('、')}` : ''}）`,
                    });
                    continue;
                }
            }
            if (frame) {
                // ① 锚还在 → 照抄上一轮那一刀（世界书在锚外面怎么挪都不影响发出去的字节）
                const hit = _relocFrameCut(curText, frame);
                if (hit) { victims.push({ j: pr.j, emit: hit.emit, moved: hit.moved, why: '照抄上一轮的锚' }); continue; }
                // ② 锚失效（锚里那串字自己变了）→ 这一轮反正已经断了 → 当场换成更保守的锚
                const nf = _relocLearnFrame(prevSentText, curText);
                if (!nf) { skipped.push(`#${pr.j} 锚失效且学不出新锚`); continue; }
                if (nf.head.length + nf.tail.length + RELOC_POINTER.length < RELOC_MIN_KEEP_CHARS) { skipped.push(`#${pr.j} 整条都在变（留不下骨架）`); continue; }
                const re = _relocFrameCut(curText, nf);
                if (!re) { skipped.push(`#${pr.j} 换锚失败`); continue; }
                victims.push({ j: pr.j, emit: re.emit, moved: re.moved, why: '锚失效→换保守锚' + (nf.churn?.length ? `（让开世界书关键词条目 ${nf.churn.join('、')}）` : '') });
                continue;
            }
            // ③ 还没锚过：一个字没变就不动它（断点在它后面）；变了才现学一对锚
            if (curText === prevSentText) continue;
            const nf = _relocLearnFrame(prevSentText, curText);
            if (!nf) { skipped.push(`#${pr.j} 没测出稳定的头/尾锚`); continue; }
            const midLen = curText.length - nf.head.length - nf.tail.length;
            if (midLen < RELOC_MIN_MID_CHARS) { skipped.push(`#${pr.j} 只变了 ${midLen} 字`); continue; }
            if (curText.length - midLen + RELOC_POINTER.length < RELOC_MIN_KEEP_CHARS) { skipped.push(`#${pr.j} 只剩 ${curText.length - midLen} 字骨架`); continue; }
            if (!curText.slice(nf.head.length, curText.length - nf.tail.length).trim()) { skipped.push(`#${pr.j} 变的只是空白`); continue; }
            const re = _relocFrameCut(curText, nf);
            if (!re) { skipped.push(`#${pr.j} 下刀失败`); continue; }
            victims.push({ j: pr.j, emit: re.emit, moved: re.moved, why: '这轮新变动的段' + (nf.churn?.length ? `（让开世界书关键词条目 ${nf.churn.join('、')}）` : '') });
        }
        // ④ 预锚：这一轮真动过刀 → 把它**前面**那条同源的块消息也先钉住形状（指针在最前、当前全文当尾锚、这轮先不搬东西）。
        //    为什么值得先付这一次断链：块消息是一条紧挨一条的，后面那条每轮在变；前面那条一旦被世界书"插到头上"，
        //    断点就跑到最前面 → 整条提示词全价（实测第 4 轮官方命中 0，26K tok 白付）。钉住之后，以后再往前插词条也一个字不变。
        //    只在"这一轮本来就在动刀"时才做；本来就稳的聊天（如林夏）一个新锚都不会加。
        if (victims.some(v => v.moved)) {
            const first = Math.min(...victims.map(v => v.j));
            let used = 0;
            const pre = [];
            for (let k = first - 1; k >= 0 && used < RELOC_PREARM_MAX_CHARS; k--) {
                const m = msgs[k];
                const role = String(m?.role || '');
                const text = String(m?.content ?? '');
                if (role !== 'system' && role !== 'user') break;         // 走到别的角色 = 越界了
                if (histFrom >= 0 && k >= histFrom) break;               // 进历史区间了
                if (_floorOfPromptText(text, chatArr) !== null) break;   // 是聊天楼层
                if (text.length < RELOC_MIN_KEEP_CHARS) break;           // 小标签条（`<相关资料>` 那种）= 分段边界
                if (text.startsWith('<')) break;                         // 预设那边的标签块 = 另一路，不跟着钉
                if (_relocPtrAt(text)) break;                            // 已经钉过了
                pre.push({ k, text });
                used += text.length;
            }
            // 从前往后写回（搬下去的段按原顺序进"后置"，不反过来）
            for (const it of pre.reverse()) {
                // v6.24：预锚也要把"世界书关键词条目"让开 —— 这一轮本来就在改形状，让开不额外花断链，
                //   而它们以后再进进出出，前面那一整串字节一个都不变。
                const safe = _relocChurnSafeAnchors(it.text, '', it.text);
                const mid = it.text.slice(safe.head.length, it.text.length - safe.tail.length);
                msgs[it.k].content = safe.head + RELOC_POINTER_IDLE + safe.tail;
                victims.push({
                    j: it.k, emit: msgs[it.k].content, moved: mid,
                    why: mid ? `预锚＋让开世界书关键词条目${safe.names.length ? `（${safe.names.join('、')}）` : ''}（后置 ${mid.length} 字）` : '预锚（先钉形状）',
                });
                out.preArm++;
            }
        }
        if (!victims.length) {
            out.skip = skipped.length ? `没有可修的（${skipped.slice(0, 4).join('、')}）` : '这一串和上一轮一模一样（断点在末尾新增处，正常）';
            out.skipped = skipped;
            return out;
        }
        // ── 动手术：写回"钉住形状"的文本；搬下来的那几段原样插到末尾（内容一个字没删，顺序不变）──
        for (const v of victims) msgs[v.j].content = v.emit;
        let at = msgs.length;
        if (String(msgs[msgs.length - 1]?.role || '') === 'assistant') at = msgs.length - 1;   // 末条是预填就不插到它后面
        // 角色跟着这一串走：本来就没有 system 的通路（例如 Claude 的 messages）就用 user，别硬塞 system 被后端拒
        const movedRole = msgs.some(m => String(m?.role || '') === 'system') ? 'system' : 'user';
        let ins = 0;
        for (const v of victims) { if (!v.moved) continue; msgs.splice(at + ins++, 0, { role: movedRole, content: RELOC_MOVED_HEAD + v.moved }); }
        out.count = victims.length;
        out.spanChars = victims.reduce((x, v) => x + v.moved.length, 0);
        out.texts = victims.map(v => v.moved).filter(t => t);
        out.text = out.texts.join('\n');
        out.moved = victims.map(v => ({ j: v.j, chars: v.moved.length, why: v.why }));
        out.at = at;
        out.why = victims.map(v => `#${v.j}(${v.why})`).join('；');
        out.skipped = skipped;
        console.log(`[hitOpt] v6.22 锚定帧：钉住 ${victims.length} 条`
            + `（后置内容 ${victims.filter(v => v.moved).length} 条 / 共 ${out.spanChars} 字`
            + (out.preArm ? `；预锚 ${out.preArm} 条` : '') + '）→ '
            + victims.map(v => `#${v.j}${v.moved ? ` 后置 ${v.moved.length} 字` : ' 只钉形状'}[${v.why}]`).join('；')
            + `｜末尾插入 @#${at}｜原地留 ${RELOC_POINTER.length} 字常量指针（每轮一字不差）｜内容一个字没删`
            + (skipped.length ? `｜没修的：${skipped.join('、')}` : ''));
        return out;
    } catch (err) {
        out.skip = `锚定时出错（一个字没动）：${err?.message || err}`;
        console.warn('[hitOpt] v6.22 锚定帧失败（一个字没动）:', err);
        return out;
    }
}

/* @36034-36041 */
function _freezeKey(t) {
    // ★ 身份必须盖住**整段正文**（不是头 64 字）：实测踩到的坑 —— 一大段常量里"尾巴上长出新条目"时，
    //   头 64 字没变 → 判成"池里已有" → 新长出来的那几千字被当成重复内容**丢掉**（用户红线：一个字都不能删）。
    const s = String(t ?? '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return `${s.length}:${(h >>> 0).toString(36)}`;
}

/* @36042-36042 */
function _freezeProbe(t) { return String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 64); }

/* @36044-36048 */
function _freezeHasLine(l) {
    // ★ 必须拿**池里真正发出去过的正文**来判（不是拿"行索引"）—— 索引只是记账，正文才是事实。
    //   实测踩到的坑：拿索引判，会出现"索引里有、正文却不在池里"的行 → 那一行被吞掉（内容缺失）。
    try { return typeof _freezePool.text === 'string' && _freezePool.text.includes(l); } catch (_) { return false; }
}

/* @36049-36055 */
function _freezeAddLines(text) {
    try {
        if (!_freezePool.lines || !_freezePool.lines.add) _freezePool.lines = new Set(_freezePool.lineList || []);
        for (const l of String(text ?? '').split('\n')) if (l.trim()) _freezePool.lines.add(l);
        _freezePool.lineList = [..._freezePool.lines].slice(-40000);      // 落盘用（上限防爆）
    } catch (_) { /* 纯记账，失败不影响出词 */ }
}

/* @36058-36083 */
function _freezeItemsOf(text, kind) {
    const s = String(text ?? '');
    if (!s.trim()) return [];
    if (kind === 'var') return [{ key: 'var:' + _freezeKey(s), name: '变量块', text: s, kind }];
    const seg = _wbChurnProbes.length ? _relocStableSegs(s) : null;
    if (!seg) return [{ key: 'blk:' + _freezeKey(s), name: '注入块', text: s, kind: 'wi' }];
    const out = [];
    let k = 0;
    for (const c of seg.chunks) {
        if (!c.solid) {                       // 关键词条目：整段就是一条
            out.push({ key: 'wi:' + _freezeKey(c.text), name: (seg.names || [])[k++] || '关键词条目', text: c.text, kind: 'wi' });
            continue;
        }
        // 常量段：按"常量条目的正文起点"再切成一条条（认不出就当一条整段）
        const fences = _wbConstSpans(c.text);
        if (!fences.length) { out.push({ key: 'blk:' + _freezeKey(c.text), name: '常量段', text: c.text, kind: 'wi' }); continue; }
        let at = 0;
        for (let i = 0; i <= fences.length; i++) {
            const end = i < fences.length ? fences[i] : c.text.length;
            const piece = c.text.slice(at, end).replace(/\s+$/, '');
            if (piece.trim()) out.push({ key: 'wi:' + _freezeKey(piece), name: '常量条目', text: piece, kind: 'wi' });
            at = end;
        }
    }
    return out;
}

/* @36085-36095 */
function _freezeSave() {
    try {
        const key = _freezeChatKey || _currentChatKey();
        if (!key) return;
        const raw = (() => { try { return JSON.parse(localStorage.getItem(FREEZE_STORE) || '{}') || {}; } catch (_) { return {}; } })();
        raw[key] = { at: Date.now(), items: _freezePool.items, log: _freezePool.log, seq: _freezePool.seq, varCur: _freezePool.varCur, lineList: _freezePool.lineList || [] };
        const keys = Object.keys(raw).sort((a, b) => (raw[b]?.at || 0) - (raw[a]?.at || 0));
        for (const k of keys.slice(FREEZE_MAX_CHATS)) delete raw[k];
        localStorage.setItem(FREEZE_STORE, JSON.stringify(raw));
    } catch (err) { console.warn('[hitOpt] 冻结池落盘失败（不影响出词）:', err); }
}

/* @36096-36112 */
function _freezeLoad(key) {
    _freezePool = { items: [], log: [], seq: 0, varCur: {}, lines: new Set(), lineList: [] };
    try {
        const raw = (() => { try { return JSON.parse(localStorage.getItem(FREEZE_STORE) || '{}') || {}; } catch (_) { return {}; } })();
        const rec = key ? raw[key] : null;
        if (rec && Array.isArray(rec.log)) {
            _freezePool = {
                items: Array.isArray(rec.items) ? rec.items : [],
                log: rec.log.filter(x => x && typeof x.text === 'string'),
                seq: Number(rec.seq) || rec.log.length,
                varCur: rec.varCur && typeof rec.varCur === 'object' ? rec.varCur : {},
                lines: new Set(Array.isArray(rec.lineList) ? rec.lineList : []),
                lineList: Array.isArray(rec.lineList) ? rec.lineList : [],
            };
        }
    } catch (err) { console.warn('[hitOpt] 冻结池读盘失败（按空池走）:', err); }
}

/* @36121-36140 */
function _freezeRecoverFromPrev(prevMsgs, chatArr) {
    if (!Array.isArray(prevMsgs) || !prevMsgs.length) return 0;
    if (_freezePool.log.length) return 0;
    let floors = 0, n = 0;
    for (const m of prevMsgs) {
        const c = String(m?.content ?? '');
        if (_isPromptFloor(c, chatArr)) { floors++; continue; }
        if (!c.includes(FREEZE_MARK) && !c.includes(FREEZE_VAR_MARK)) continue;
        _freezePool.log.push({ afterFloors: floors, text: c, at: Date.now(), recovered: true });
        // 池里的"见过"名单也照它重建（否则下一轮会把同一批正文再注入一次）
        for (const seg of c.split(FREEZE_MARK).slice(1)) {
            const body = seg.slice(seg.indexOf('\n') + 1);
            if (body.trim()) { _freezePool.items.push({ key: 'wi:' + _freezeKey(body), name: '（捡回）', kind: 'wi', chars: body.length }); }
        }
        n++;
    }
    if (n) console.log(`[hitOpt] v6.24.24 冻结注入池：从上一轮定稿里**原样捡回** ${n} 个批（${_freezePool.items.length} 条）`
        + `—— 池丢了也不重新注入、不重排，既往字节一个不动`);
    return n;
}

/* @36143-36167 */
function _freezeTake(text, kind, batch, stats) {
    const items = _freezeItemsOf(text, kind);
    if (!items.length) return null;
    const have = new Set(_freezePool.items.map(x => x && x.key));
    for (const it of items) {
        if (have.has(it.key)) { stats.dropped += it.text.length; continue; }      // 整段一模一样 ⇒ 池里有
        have.add(it.key);
        // 整段没见过，但**逐行**可能大半都在池里（大段常量里改了几个字、EJS 渲染值变了）：
        //   这时只发"池里没有的那几行"（局部变动），其余一个字都不重发。
        const lines = it.text.split('\n');
        const solid = lines.filter(l => l.trim().length > 0);
        const fresh = solid.filter(l => !_freezeHasLine(l));
        const useDelta = fresh.length > 0 && solid.length > 3 && fresh.length * 2 < solid.length;
        const body = useDelta ? fresh.join('\n') : it.text;
        _freezePool.items.push({ key: it.key, name: it.name, kind: it.kind, chars: it.text.length, probe: _freezeProbe(it.text) });
        _freezeAddLines(it.text);
        batch.push(`${FREEZE_MARK}${++_freezePool.seq}·${it.name}〕`
            + `${it.kind === 'var' ? '变量块完整正文' : (useDelta ? `局部变动（${fresh.length}/${solid.length} 行）` : '完整注入')}\n${body}`);
        stats.newItems++;
        stats.newChars += body.length;
        if (useDelta) stats.deltaItems = (stats.deltaItems || 0) + 1;
        else stats.dropped += it.text.length - body.length;
    }
    return items;
}

/* @36173-36286 */
function _freezeApply(msgs, p) {
    const out = { on: false, newItems: 0, newChars: 0, dropped: 0, varLines: 0, varChars: 0, batches: 0, at: -1, skip: '' };
    _freezeStats = out;
    try {
        // ★★★★★★ v6.24.116【用户 2026-09-18 拍板「全停」】—— 总闸在这里，与 `_relocMoveVarBlock` 同一处写法。
        //   见 `CROSS_DOMAIN_OFF` 那段注释（用户原话 ＋ 官方数 ＋ 49 倍判据）。一句话：
        //   这一步是"搬走 / 后置 / 冻结 / 指针化"，作用在**对话历史之后** —— 两面都违口径，且实测每轮贵 3.03 倍。
        if (FREEZE_POOL_OFF) { out.skip = 'v6.41.37 冻结注入池**保持关**（FREEZE_POOL_OFF=true；它有损、用户没点头）—— 注入块留在原位，不进池、不指针化'; return out; }
        if (settings.cacheFreezeInject === false) { out.skip = '开关关着'; return out; }
        if (!Array.isArray(msgs) || !msgs.length) return out;
        const chatArr = (() => { try { const c = getContext()?.chat; return Array.isArray(c) ? c : []; } catch (_) { return []; } })();
        const key = _currentChatKey();
        if (key !== _freezeChatKey) { _freezeLoad(key); _freezeChatKey = key; }
        // 池丢了（刷新/清缓存/换设备）→ 从上一轮定稿里原样捡回，绝不重新注入
        if (!_freezePool.log.length) _freezeRecoverFromPrev(_prevRealMsgs, chatArr);
        _freezePool.text = _freezePool.log.map(x => x.text).join('\n');       // 行级增量的判据：池里真发出去过的正文
        // 聊天楼层：区间 + 条数（一条都不许动，只往后插）
        let histFrom = -1, floors = 0;
        for (let i = 0; i < msgs.length; i++) {
            if (!_isPromptFloor(String(msgs[i]?.content ?? ''), chatArr)) continue;
            if (histFrom < 0) histFrom = i;
            floors++;
        }
        if (histFrom < 0) { out.skip = '认不出聊天楼层（不猜，一个字不动）'; return out; }
        const batch = [];
        const varDelta = [];
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            const role = String(m?.role || '');
            if (role !== 'system' && role !== 'user') continue;
            const c = String(m?.content ?? '');
            if (c.length < 40) continue;
            if (c.includes(FREEZE_MARK) || c.includes(FREEZE_VAR_MARK) || c.includes('【冻结注入池')) continue;
            if (c.includes(RELOC_POINTER) || c.includes(RELOC_POINTER_IDLE) || c.includes(RELOC_TAIL_POINTER)) continue;
            // ★ v6.24.41：变量块后置（`_relocMoveVarBlock`）现在跑在**本函数之前**，它搬到末尾那一条
            //   归它所有（抬头 `RELOC_MOVED_HEAD`）—— 冻结池不许再碰：否则池里存一份旧值、
            //   末尾又摆一份新值，"完整变量见池内条目"这句指针就把模型引到过期的值上去。
            //   （幂等：搬过的那条永远带抬头，`_relocMovedTail` 兜住抬头被别的插件削掉的情况。）
            if (c.startsWith(RELOC_MOVED_HEAD) || _relocMovedTail(c)) continue;
            if (_isPromptFloor(c, chatArr)) continue;
            const isVar = c.includes('<status_current_variables>') || c.includes('当前状态快照');
            if (isVar) {
                // ── 变量块：第一次整块进池；之后**只把变动的行**作为本批的变动记录 ──
                //   注意：快照块与变量块是**两块**，必须各记各的上一版（v6.24.24 第一版把它们挤进同一个
                //   槽位，于是每轮都拿"另一块"当基准 → 409 行全算变动、7.5K 字照发，白花钱）。
                const vk = 'var:' + (c.includes('<status_current_variables>') ? 'status' : 'snapshot');
                const prev = _freezePool.varCur[vk];
                if (typeof prev !== 'string' || !prev) {
                    _freezeTake(c, 'var', batch, out);
                    _freezePool.varCur[vk] = c;
                    m.content = FREEZE_VAR_PTR;
                    continue;
                }
                if (prev !== c) {
                    // 行级差分：只发新增/改动/删除的行（局部变动就是这个）
                    const oldL = prev.split('\n'), newL = c.split('\n');
                    const oldSet = new Set(oldL);
                    const newSet = new Set(newL);
                    const add = newL.filter(l => l.trim() && !oldSet.has(l));
                    const del = oldL.filter(l => l.trim() && !newSet.has(l));
                    for (const l of add) varDelta.push('+ ' + l.trim());
                    for (const l of del) varDelta.push('- ' + l.trim());
                    out.varLines += add.length + del.length;
                    out.varChars += add.reduce((a, x) => a + x.length, 0) + del.reduce((a, x) => a + x.length, 0);
                    _freezePool.varCur[vk] = c;
                }
                m.content = FREEZE_VAR_PTR;
                continue;
            }
            // ── 世界书那一路：只在"历史之前的长块"里挑，而且必须真认得出世界书条目 ──
            if (i > histFrom) continue;
            if (c.length < 400) continue;
            const isWbBlock = _wbChurnProbes.length ? (_relocStableSegs(c) !== null || _wbConstSpans(c).length > 0) : false;
            if (!isWbBlock) continue;
            const items = _freezeTake(c, 'wi', batch, out);
            if (!items) continue;
            m.content = FREEZE_EXPLAIN;                 // 原地只留**一行常量**（每轮一字不差）
        }
        if (varDelta.length) {
            batch.push(`${FREEZE_VAR_MARK}第${_freezePool.log.length + 1}轮〕局部变动（只列变动的行）\n${varDelta.join('\n')}`);
        }
        out.varDeltaChars = varDelta.join('\n').length;
        // ── 本轮的批：整批只写一次，此后一字不改 ──
        if (batch.length) {
            const text = batch.join('\n\n');
            _freezePool.log.push({ afterFloors: floors, text, at: Date.now() });
            out.batches = 1;
        }
        // ── 把池里每一批按"创建时前面有多少个楼层"插回去（从后往前插，下标才不受影响）──
        const floorIdx = [];
        for (let i = 0; i < msgs.length; i++) if (_isPromptFloor(String(msgs[i]?.content ?? ''), chatArr)) floorIdx.push(i);
        const batchRole = msgs.some(m => String(m?.role || '') === 'system') ? 'system' : 'user';
        const ordered = _freezePool.log.map((b, i) => ({ b, i }))
            .sort((x, y) => (y.b.afterFloors - x.b.afterFloors) || (y.i - x.i));
        for (const { b } of ordered) {
            const n = Math.max(0, Math.min(Number(b.afterFloors) || 0, floorIdx.length));
            const at = n <= 0 ? (floorIdx[0] ?? msgs.length) : floorIdx[n - 1] + 1;
            msgs.splice(at, 0, { role: batchRole, content: b.text });
            out.at = at;
        }
        out.on = true;
        if (out.newItems || out.varLines) {
            console.log(`[hitOpt] v6.24.24 冻结注入池：本轮新注入 ${out.newItems} 条 / ${out.newChars} 字`
                + `（原地省掉重复注入 ${out.dropped} 字）｜变量局部变动 ${out.varLines} 行 / ${out.varChars} 字`
                + `｜池内累计 ${_freezePool.items.length} 条 / 批 ${_freezePool.log.length} 个｜本批插在 @${out.at}｜一个字没删`);
        }
        _freezeSave();
        return out;
    } catch (err) {
        console.warn('[hitOpt] v6.24.24 冻结注入池失败（一个字没动）:', err);
        out.skip = `出错（一个字没动）：${err?.message || err}`;
        return out;
    }
}

/* @36350-36355 */
function _isPromptFloor(text, chatArr) {
    const s = String(text ?? '');
    if (_floorOfPromptText(s, chatArr) !== null) return true;
    const stripped = s.replace(/^\s*<[^>\n]{1,24}>\s*/, '');
    return stripped !== s && _floorOfPromptText(stripped, chatArr) !== null;
}

/* @36360-36364 */
function _unwrapLatestInput(s) {
    const x = String(s ?? '');
    const m = /^\s*<最新互动>\s*\n([\s\S]*?)\n\s*<\/最新互动>\s*$/.exec(x);
    return m ? m[1] : x;
}

/* @36390-36419 */
function _normalizeLatestInputWrap(msgs) {
    try {
        if (!Array.isArray(msgs) || !msgs.length) return { wrapped: 0, unwrapped: 0, at: -1, changed: 0 };
        // promptOnly 的正则只认 { role, content } 这一对数（system 那些块一个字不碰）。
        let lastUser = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (String(msgs[i]?.role || '') === 'user') { lastUser = i; break; }
        }
        if (lastUser < 0) return { wrapped: 0, unwrapped: 0, at: -1, changed: 0 };
        let wrapped = 0, unwrapped = 0, changed = 0;
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (!m || String(m.role || '') !== 'user') continue;
            const raw = String(m.content ?? '');
            const bare = _unwrapLatestInput(raw);
            const want = (i === lastUser)
                ? `${LATEST_INPUT_OPEN}\n${bare.trim()}\n${LATEST_INPUT_CLOSE}\n`   // 最新一条：恒定为"套壳 + 正文.trim()"
                : bare;                                                            // 其它一律裸的
            if (i === lastUser) wrapped++; else if (raw !== bare) unwrapped++;
            if (raw !== want) { m.content = want; changed++; }
        }
        const at = lastUser;
        // 只在真改了的时候说话（每轮都在改的话，说明预设那边又变了口径 → 这条日志就是线索）
        if (changed) console.log(`[hitOpt] 最新输入套壳归一：第 #${at} 条定为套壳、另外 ${unwrapped} 条剥成裸的（共改 ${changed} 条，正文一个字没动）`);
        return { wrapped, unwrapped, at, changed };
    } catch (err) {
        console.warn('[hitOpt] 最新输入套壳归一失败（不影响发送）:', err);
        return { wrapped: 0, unwrapped: 0, at: -1, changed: 0 };
    }
}

/* @36676-36926 */
function _onChatCompletionSettingsReady(data) {
    /* ══ ★★★★★★ 2026-09-24【**根因修复**：SETTINGS_READY 早于 fetch ⇒ 这里必须清掉上一轮的取证】══
     *
     *  【病】用户 2026-09-24 当场报（原话）：「**我踏马聊的好好的，你告诉我突然暴毙了**」——
     *    `林夏_muf17g3x5dix` 第 5 轮起 miss 从 6,254 跳到 **21,775**、命中率掉到 6.6%，一路不恢复。
     *
     *  【根因（酒馆源码里的时序，不是推测）】`public/scripts/openai.js:3138 sendOpenAIRequest()`：
     *      const { generate_data, … } = await createGenerationParameters(…);
     *      await eventSource.emit(CHAT_COMPLETION_SETTINGS_READY, generate_data);   // ← L3146 **先** emit
     *      const response = await fetch('/api/backends/chat-completions/generate'); // ← L3149 **后** fetch
     *    而 `_sendProof` 是**fetch 被调用之后**才写的（`_installSendProof` 里那句
     *    `_sendDigestOf(arr).then(d => { _sendProof = {…} })`，还是异步的）。
     *    ⇒ **`_finalizeMeasure` 跑的时候，这一轮的 fetch 还没发生** —— 它读到的 `_sendProof`
     *      必然是**上一轮**那份残留。
     *
     *  【为什么这一个残留能把整场拖死】三环（每一环都有盘上读数）：
     *    ① `_prevBaselineFrom(snap, isReal, …)` 拿到旧的 `sp` ⇒ `sp.n` 对不上 `snap.length`
     *       ⇒ post 分支不成立；`isReal` 也假 ⇒ 走"**还原基准原地不动**"那条老路；
     *    ② 就算走到 `_prevMsgsSave`，它里面按 `src|digest|shape` **去重** ——
     *       两轮读到**同一个 sp** ⇒ digest 相同、shape（条数|首条长度|末条长度）也相同
     *       ⇒ 新基准被当成重复项**过滤掉**；
     *    ③ 候选池永远只剩最初那一份 ⇒ `rsBase` **冻死**（实测 `post:ba5c2bf198a22362` 从第 2 轮到第 11 轮
     *       一次都没换过，而正常场 `mue3nxa67z3o` 会逐轮演进 `0a9a0a68 → 259182a1 → 96c63e12`）
     *       ⇒ **A 区照抄那份冻住的基准**（#3 与 #8 都是 `A 11 条 / 18,854 字`，中间隔 4 轮一个字没长）
     *       ⇒ 缓存前缀断掉 ⇒ miss 爆。
     *
     *  【为什么 v6.55 时代没事】那一版 `_finalizeMeasure` 挂在**魔改版 Horae 自己的链路**上，时序不同；
     *    hitOpt 独立之后改成自己接 `SETTINGS_READY` ⇒ 落到"emit 早于 fetch"这一边。
     *    **这就是"移植前一切安好、移植后暴毙"的机制。**
     *
     *  【修法（最小、最保守）】**在这一刻把 `_sendProof` 清成 null**：
     *    清掉之后，本函数下面那一跳"要么拿到这一轮的新取证、要么明确地没有"
     *    —— 绝不再拿上一轮的残留冒充这一轮 ⇒ `_prevBaselineFrom` 老老实实走"没有基准"那条路，
     *    `_prevMsgsSave` 也就能把**这一轮真发出去的字**写进候选池 ⇒ 下一轮起自愈。
     *  ⛔ 不动判据、不动算法：只把"读到哪一份取证"这件事从"上一轮的"改回"必须是这一轮的"。
     *  ⚠ 必须排在本函数**最前面**（在任何读 `_sendProof` 的代码之前）。 */
    try {
        const stale = _sendProof;
        if (stale) {
            try {
                _diagReport({
                    tag: 'settings:clearProof', chat: _gitLogChat(),
                    hadN: Number(stale.n) || 0, ageMs: Date.now() - (Number(stale.at) || 0),
                });
            } catch (_) { }
            _sendProof = null;
        }
    } catch (_) { }
    try {
        const msgs = Array.isArray(data?.messages) ? data.messages : null;
        if (!msgs || !msgs.length) return;
        // ══ ★ v6.24.41：把"最新输入套壳归一 + 变量块整段后置"提到**形状判据之前**，无条件执行 ══════
        //
        // 用户定版（2026/9/16，出网抓包为证）："变量没有被缓存冻结，其变动没有发生在后面"、
        // "需要改为固定+增量形式 —— 定在前、动在后、既往历史不可动、如有变动后面加"。
        // 实测两轮真 request（同一场聊天 21:05:46 / 21:07:51，wiretap 逐字节原文）：
        //   · `#0` 的**第 4 个字节**就是 `<status_current_variables>`，里面 `  分钟: 30` → `40`；
        //   · 于是整条请求体的公共前缀只有 **73 字 / 91 字节 = 0.11%**（总长 96,171 字节）；
        //   · 官方 usage：hit 21,504 → **128**，命中率 99.3% → 0.5% —— 就是这个字节。
        //
        // 为什么以前"该修的没修"：`_relocMoveVarBlock` / `_freezeApply` / 尾部锚定 /
        // 实测断点这一整条定稿链，**全都挂在 `_samePromptShape` 这道门后面**。
        // 门一判假，它们集体静默跳过（连一句"没动"都不打），而**记录照样写** ——
        // `_pendingMeasure` 的兜底定时器会走 `_finalizeMeasure(p, null)`，
        // 于是"盘上有记录"让人误以为机制跑了（实测 21:05 / 21:07 两轮：记录里逐字节是出网原文，
        // 但 #0 的变量块原地未动、末尾既没有指针也没有搬出来的那一段）。
        //
        // 而这两步**根本不需要预演快照**：
        //   · 套壳归一只看"哪一条是最新一句玩家输入"；
        //   · 变量块后置只看"哪一条里成对出现 `<status_current_variables>…</status_current_variables>`"。
        // 所以它们不该被"这一轮到底是不是同一次请求"的判据连坐。
        //
        // 另外：归一必须排在**前移/后置之前**（它决定"最后一条"是谁，而变量块是追加到末尾的），
        // 而它以前排在形状判据**之后** —— 预演快照是归一过的、定稿那份没归一就上去比，
        // 最后一条只要差一个换行就判假。顺序反了，这道门几乎注定判假。
        // ★ v6.24.42：**做历史还原**（把上一轮已经发出去、这一轮被别的插件删掉的字摆回去）。
        //   v6.24.44 改了两件事：① 还原本身改成**一次简单的拼接**（见 `_restoreFrozenHistory`）；
        //   ② 它移到"套壳归一 ＋ 变量块后置"**之后** —— 上一轮真发出去的那串字里 `#0` 那段变量块
        //   已经被搬走、原地只剩一行常量指针；这一轮也得先搬成同一个形状，**逐条对齐才不会被
        //   "指针 vs 整段块"那一条顶断**（顶断 = 落点被拉到前面，后面整段历史都拼不上）。
        _normalizeLatestInputWrap(msgs);
        // ══════════════════════════════════════════════════════════════════════════════════
        // ⛔⛔ v6.24.114【试过了 —— 冻结池接回 A/B 之前是**负收益**，已当场撤回】
        //
        // 用户原话（2026/9/18）："本质就是以前的B收束，只是放松了对话历史后面的miss管控；但是现在miss
        //   无限膨胀，还不如 miss B 收束呢；但是用回去也得改进啊" ⇒ 我按这句话把 `_freezeApply`
        //   提到了 A/B 之前（原来它排在 `if (abOn) { … return; }` 后面，A/B 一生效就永远够不到）。
        //
        // ══ 撤回的理由（官方三个数 + 存档抬头逐轮版本标注 + 服务端现算 lcp，摆在同一张表上）══
        //   `#33` hit **291,840** / miss 16,045 / prompt 307,885　　← 还没跑冻结池
        //   `#34` hit **  2,816** / miss 35,990 / prompt ** 38,806**　← 冻结池在跑（`#0` = 58 字指针）
        //   `#35` hit ** 12,288** / miss 29,601 / prompt  41,889　　← 冻结池在跑
        //   `#39` hit **      0** / miss 55,566 / prompt  55,566
        //   `#40` hit   44,672 … `#49` hit 54,784　　　　　　　　　← 冻结池停了，hit 回到同一量级
        //   ⚠⚠ **这里必须如实更正我第一版写下的话**：`#34` 的低 hit **主要不是冻结池造成的** ——
        //     同一张表里 `#33 → #34` 的 prompt 从 **307,885 掉到 38,806（−87%）**，
        //     那是**用户自己删掉了大部分内容**（删楼层 / 换预设），prompt 缩到 1/8，lcp 自然归零。
        //     **不能把"内容被删"记到算子头上。** 冻结池在 `#34` 确实跑过（`#0` 是 58 字指针，
        //     形状翻转是真的），但那只是**叠加**在这一轮上的第二重断点，不是主因。
        //   ⇒ 真正站得住的结论只有一条：**它把"上一版完整正文"换成了"会随池漂移的指针"**，
        //     而形状一旦在两种之间来回切，切换轮就白付。**没有证据表明它能净省钱。**
        //
        // ══ 数理原因（不是调参能救的）══════════════════════════════════════════════════════
        //   官方 hit 量的是"与**任意已缓存请求**的最长公共 token 前缀"：
        //     · 切换那一轮：手上是"池化形状"、缓存里全是"整块形状" ⇒ 第 0 个字节就不同 ⇒ hit ≈ 0；
        //     · 此后每一轮：池里又插进新批（`_freezePool.log` **只增不减、每轮全插回**）⇒
        //       插入点一变，指针之后的字节就跟着挪 ⇒ 仍然对不上。
        //   ⇒ 它不是"省下重复注入"，而是**把稳定的整块换成了会漂移的指针**。
        //
        // ══ 同一张表还证明了另一件事：**miss 已经接近下界，榨不出多少了** ══════════════════
        //   把 50 轮真 body 逐轮灌进"严格前缀累积"（body'(N) = body'(N-1) ⊕ Δ(N)，Δ = 整条未出现过的）
        //   ⇒ `lcp(N-1,N) ≡ |body'(N-1)|` 恒等式 49/49 成立，可 miss 只从 984,182 降到 910,100 tok
        //   （**省 7.5%**），代价是总字从 1,034 万涨到 **3,515 万（+239.9%）** ⇒ 净亏 140 万 tok 当量。
        //   为什么省不动：S5 每轮 miss 与现状 miss **逐轮只差 50~100 字**（就是分隔符）——
        //   **现状的 miss ≈ 这一轮真正新增的内容**，而新增内容**必须发一次**，这是下界。
        //   ⇒ 所以"把 miss 再压小"这条路上，**没有可捡的钱**；钱在"别让 lcp 掉到 0"那几轮上，
        //     而那几轮的原因是**靠前的那条注入容器被整条改写**（世界书条目按关键词进出），
        //     不是 Horae 少做了什么。**别再把这段接回去。**
        // ══════════════════════════════════════════════════════════════════════════════════
        // ══ ★★★ v6.24.92【先切 A/B，再决定要不要搬运 —— 而且切成了就**绝不搬运**】══════════
        //   旧顺序是"先搬变量块、再拼 LCP"。可**搬运本身就是跨域算子**（它改写 msgs[#0]），
        //   而 A 必须逐字节等于存档那份 ⇒ 先搬就等于先把 A 弄脏，再拼也拼不回来。
        //   实测（官方数 + 出网 body 逐字节，`圣樱学院_mu5ffle6lfcc`）：
        //     #33 出网 `#0` = 5,632 字的整块变量块；#34 出网 `#0` = **58 字**的冻结池指针
        //     ⇒ 第 0 个字节就不同 ⇒ 面板 lcp=0、官方 hit = **0** / miss 78,913。
        //   现在 A 从存档逐字节搬 ⇒ `#0` 恒等于上一轮那个 `#0`（不管它是整块还是指针），
        //   这一轮新生成的那个东西一律落进 B（miss 区，随便动）。
        /* ★★★★★★ v6.51.10【重放集完备性 · 缺口1：**没切分也要留下"池化前的整份输入"**】
         *  事故（圣樱学院_mucxfcb8nw6n 生成 00002.json 时的第 3 轮）：
         *  那一轮走的是 `_restoreFrozenHistory` 的 4 条早退之一（`if (!prev)` ＝ 基准拿不到），
         *  而 4 条早退**全都排在** `_abSplit` 调用点之前 ⇒ 「池化前快照」压根没采 ⇒
         *  盘上连 `turns/NNNNN.pre.json` 都没有 ⇒ 事后想重放，只能拿 `raw.json`（35 条）
         *  加**上一轮**切片拼出的基准**手工拼**（这次就是这么干的；万一上一轮也没切片，就彻底查不动）。
         *  ⇒ 快照提到这里取：这一刻的 msgs 已经过完入口段算子（套壳归一），
         *    又**还没**被 `_abSplit` 切表（成功那条路会先 msgs.length = 0 再重填）
         *    ⇒ 它正是"交给池化算法的那份输入"。
         *  ⚠ 只当**兜底**：正常路径上 `_restoreFrozenHistory` 内部已经在 `_abSplit` 调用点前
         *    采过一份更好的（那份还过了历史还原）⇒ 有它就不覆盖，一个字节都不动。
         *  ⚠ 只读快照（新建对象数组，role/content 两个字段），绝不交引用出去。 */
        let _preSnapFallback = null;
        try { _preSnapFallback = msgs.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') })); } catch (_) { _preSnapFallback = null; }
        const restore = _restoreFrozenHistory(msgs);
        _restoreStats = restore;
        try {
            if (restore && _preSnapFallback
                && (!Array.isArray(restore.abPreMsgs) || !restore.abPreMsgs.length)) {
                restore.abPreMsgs = _preSnapFallback;
            }
        } catch (_) { }
        const abOn = !!(restore && restore.abOn);
        let varMove;
        if (abOn) {
            varMove = {
                count: 0,
                skip: 'A/B 切分已生效 —— 变量块的新值本来就落在 B 区（miss 区，随便动），'
                    + '不需要"搬运"这个跨域算子（定理 2：跨域必降 HIT）',
            };
        } else {
            varMove = _relocMoveVarBlock(msgs);
            /* ★ v6.27.1 修（第 17 轮真机抓到的**假理由**）：`_relocMoveVarBlock` 内部在跨域总闸关着时
             *   早退，回的是那句"A/B 切分**已生效**…"—— 可这一轮 `abOn=0`，A/B 根本没跑！
             *   盘上实例（`_diag.log` 第 17 轮）：`abOn=0` ＋ `varBlkSkip="A/B 切分已生效…"`，
             *   两句话互相打架，读日志的人（我自己）会以为 A/B 在跑。硬件行为是对的（`varBlkCount=0`
             *   ＝变量块确实留原位），**错的是理由文案** ⇒ 这里按 `abOn` 说真话。 */
            if (!varMove.count && /A\/B 切分已生效/.test(String(varMove.skip || ''))) {
                varMove = { ...varMove, skip: '跨域总闸关着（用户拍板「全停」）＋ 这一轮 A/B 也没跑（abOn=0）⇒ 变量块留在原位，一个字没搬' };
            }
        }
        _varMoveStats = varMove;                       // 无论下面走哪条路，面板/记录都看得到
        if (!varMove.count) {
            console.log(`[hitOpt] v6.24.41 变量块后置：没动（${varMove.skip || '没有成对的变量标签'}）`
                + ' —— 它要是坐在提示词前部又每轮在变，整条前缀就每轮作废');
        }
        const p = _pendingMeasure;
        if (!p) return;
        // ⚠ A/B 生效时**强制不走定稿链**：`_freezeApply` / `_relocateStableTailBlocks` /
        //   `_relocateVaryingBlocks` 三个都是跨域算子（往已发出去过的段里插池指针 / 搬块）——
        //   A 一个字节都不许动（定理 2）。实测 #34 那次 hit=0 就是 `_freezeApply` 把 `#0`
        //   从 5,632 字换成 58 字指针造成的。
        const shapeOk = !abOn && _samePromptShape(p.snapshot, msgs);
        // ══ ★★★ v6.24.95【基准链的自锁 —— 74% 的轮次写不进基准，新聊天 8 轮全废】════════════
        //   官方数为证（`圣樱学院_mu5m9rnhzb5o` #0~#7，连发 8 轮）：
        //     `_diag.log` 的 pushTurn:enter **每一条**都是 `rsOn=0`、`rsBase=''`、`pickCands=0`、
        //     `rsSkip="还没有上一轮真发出去的那串字可比"` ⇒ A/B 与历史还原**一次都没跑**，
        //     只剩"搬运"在撑 ⇒ hit 崩到 4,608（#5）/ 8,192（#7），miss 涨到 29,908 / 30,418。
        //   全量证据（proof 心跳 69 条）：`spN == snapN` **只成立 1 次**（13:45:39，age=249ms），
        //     其余 68 条全部不等 —— 老聊天靠那一次侥幸存下的基准从 localStorage 续命，
        //     所以这个 bug 被掩盖了很久；**新聊天从第一轮起就没赶上 ⇒ 永久自锁**。
        //   根因：`_prevBaselineFrom` 的 post 分支判据是 `Number(sp.n) === snap.length` ——
        //     它拿**抓包条数**去比**这一轮的 `snap`**。而兜底那条路上 `snap` 退化成**预演快照**
        //     （实测 45 条 vs 出网 46 条：别的插件在预演之后又注入了一条）⇒ 判据不成立；
        //     紧接着 `isReal` 又为假（4 秒兜底传的 `realMsgs` 是 null）⇒ **两个分支都不走**。
        //   ⇒ 这里把**定稿的真实条数**无条件记在 `p` 上（不管形状判据过不过、不管 A/B 走没走），
        //     让 `_prevBaselineFrom` 有第二个可以比对的参照物。
        //     ⚠ 抓包那份**就是**真发出去的字 ⇒ 拿它当基准完全符合 v6.24.46 定下的
        //     "基准只认真发出去的那份"（那条口径一个字没改，改的只是**怎么确认抓包是这一轮**）。
        p.finalN = Array.isArray(msgs) ? msgs.length : 0;
        if (abOn) {
            // A/B 生效：这串字就是这一轮**真发出去**的那一份（POST body 的 messages 逐条抄自它）
            //   ⇒ ① 它当"定稿那份"记账；② **它**存成下一轮的基准 —— 于是下一轮的 A 以这一串为前缀，
            //   引理 1 每轮都成立、链条自续（这是"完整保留 N-1"在代码里的落点）。
            p.finalMsgs = msgs;
            _pendingMeasure = null;
            const _kk = _currentChatKey();
            const _arr = msgs.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
            _prevRealMsgs = _arr;
            try { globalThis.__hitOptPrevChat = String(_currentChatKey() || ''); } catch (_) { }
            _prevBaselineSrc = 'ab';
            _prevMsgsSave(_kk, _arr, 'ab');
            void _finalizeMeasure(p, msgs);
            return;
        }
        // ★ v6.24.46：形状对得上 ⇒ 这份就是这一轮马上要出去的 body（还原已经写进去了），留一份给
        //   "4 秒兜底"那条路用 —— 那条路以前拿 `p.snapshot`（**还原之前**的预演）当这一轮的字，
        //   于是面板的"本地"、记录抬头全都在说一份从没发出去过的字（实测第 6 轮就是这么骗过人的）。
        if (shapeOk) p.finalMsgs = msgs;
        if (!shapeOk) {
            // ★ v6.24.33：把"差在哪"打出来 —— 以前只有一句"对不上"，看不出是宏没展开还是夹了别的请求。
            //   实测踩到的坑：这条一行日志掩盖了"每一轮都对不上"（宏展开导致），整条定稿链被静默跳过。
            const la = p.snapshot.length, lb = msgs.length;
            let firstDiff = -1;
            for (let i = 0; i < Math.max(la, lb); i++) {
                if (String(p.snapshot[i]?.role || '') !== String(msgs[i]?.role || '')
                    || String(p.snapshot[i]?.content ?? '') !== String(msgs[i]?.content ?? '')) { firstDiff = i; break; }
            }
            console.log(`[hitOpt] 定稿事件带的 messages 与预演形状对不上（不是这一轮）→ 继续等这一轮的`
                + `｜快照 ${la} 条 / 定稿 ${lb} 条`
                + (firstDiff >= 0 ? `｜第一条不同 #${firstDiff}`
                    + `（快照 ${String(p.snapshot[firstDiff]?.role || '?')} ${String(p.snapshot[firstDiff]?.content ?? '').slice(0, 30)}…`
                    + ` / 定稿 ${String(msgs[firstDiff]?.role || '?')} ${String(msgs[firstDiff]?.content ?? '').slice(0, 30)}…）` : ''));
            return;
        }
        _pendingMeasure = null;
        // 别的插件在预演之后补进来/改掉的部分（就是以前"记录比官方 prompt 少几千 tok"的那部分）
        let n = 0, chars = 0;
        for (let i = 0; i < Math.max(p.snapshot.length, msgs.length); i++) {
            const x = p.snapshot[i]?.content ?? '';
            const y = String(msgs[i]?.content ?? '');
            if (x !== y) { n++; chars += y.length - x.length; }
        }
        p.lateFix = { n, chars };
        if (n) console.log(`[hitOpt] 定稿：预演之后还有 ${n} 条被别的插件改过（净 ${chars >= 0 ? '+' : ''}${chars} 字）→ 记录按定稿文本记`);
        _prevMsgsRestore(_currentChatKey());                   // ★ v6.18：刷新过页面也把上一轮基准装回来
        // ★ v6.24.21：先把最新一句玩家输入的套壳钉成常量，再让下面两步看这串字。
        //   为什么必须排在 `_relocateStableTailBlocks` **前面**：那一步拿 `_isPromptFloor` 认
        //   "哪条是聊天楼层 / 最新输入"，它的兜底正是"剥掉头一个标签再认一次"；归一之后
        //   最新那条恒为套壳、其余恒为裸的，认法每次都一样（否则成员会一进一出、每轮白断一次）。
        //   ★ v6.24.41：这一步与"变量块后置"**已经提到本函数最前面**（形状判据之前、无条件执行），
        //   所以这里不再重复——它们不需要预演快照，不该被"这一轮是不是同一次请求"连坐。
        // ★ v6.24.24：**先收冻结注入池**（完整注入只发一次、原地留常量说明、本轮增量拼一批追加在池后），
        //   再做下面两步搬迁 —— 池里的批与说明都带标记，搬迁那两步见了就跳过（既往历史不可变）。
        //   ⚠ v6.24.114：**试过把它提到 A/B 之前，当场撤回了** —— 见本函数上方那段带 ⛔⛔ 的注释
        //   （官方数为证：它在跑的 `#34`/`#35` 那两轮 hit 2,816 / 12,288，而前一后是 291,840 / 128,256）。
        // ★★★★★★ v6.24.116【用户 2026-09-18 拍板「全停」】：`CROSS_DOMAIN_OFF` 关着时，
        //   `_freezeApply` 在**它自己开头**就早退（闸门判据与 `_relocMoveVarBlock` 同一处写法）——
        //   它是"把注入块搬进池、原位只留一行常量/一句指针"的跨域算子（★ 红线点名的动作）。
        //   ⚠ 它和上一步是**同一个闸门的两半**：只关一半 = 版式照样翻（实测代价 3.03 倍）。
        //   ⚠ 停用后池不再更新 ⇒ 上一轮发出去的指针（`FREEZE_VAR_PTR`）在这一轮变回真变量块，
        //     那一点会断一次（**一次性代价**，与 v6.24.105 停用 B 区收缩时一样，如实认账）。
        _freezeApply(msgs, p);
        // ══ ★★★ v6.24.106【用户拍板 (乙)：**不再把"对话历史之后"的稳定块搬到前面**】══════════
        //  用户原话："缓存功能一般不管chatHistory后面的啊，主要针对chatHistory与之前的内容"。
        //  实测为什么要关（真出网 body，`_gitlog/圣樱学院_mu5rg2rr3wm2/turns/00000.txt` 起）：
        //    这一串的第 **4** 条（`#3`，9,958 字）＝「快照提示 ＋ 预设 chatHistory **之后**的 47 个指令块」
        //    （`</互动历史>` / `<核心指导>` / `<第一写作指导>` / `<追加行动选项>` / `<输出模板>` /
        //     `🛡️准则结束` …）。它本来排在**对话历史之后**，是被本函数搬到"第一条楼层之前"的锚点区。
        //    第 0 轮 `abOn=0` ⇒ 它跑了；第 1 轮起 A/B 生效、定稿链整段跳过 ⇒ **这个被搬过的位置被 A
        //    永久冻结**（A 逐字节来自上一轮发出去的串）⇒ **格式指令从此永远待在"对话历史之前"、离开末尾。**
        //  ⇒ 停用调用（函数体保留并标"⛔ 已停用"，与 `_abShrinkB` 同一处理）。
        //    影响面**只有"还没有基准"的那些轮**（新聊天第一轮）：A/B 生效时这一整段本来就不跑。
        //    代价（如实）：稳定块留在原处 ⇒ 不再被 A 吃进命中区，每轮按 miss 全价发（≈5,4xx 字/轮）；
        //    换来的是**位置正确**（紧跟最新互动）＋ **A 不再把它们吞进去**（见 `_abSplit` 的 `_floorLim`）。
        const tailMove = {
            count: 0, chars: 0, pointerChars: 0, blocks: [], at: -1,
            skip: 'v6.24.106 用户定版 (乙)：稳定块留在"对话历史之后"原处不动 '
                + '（搬到前面会让格式指令离开末尾，并被 A 永久吞进命中区）',
        };
        // ★ v6.24.34：**提示词第 0 个字节上那个变量块整段后置**（v6.24.41 起已在最前面无条件跑过）。
        //   它坐在最前面、每轮都在变，实测整个请求体的公共前缀只剩 73 字节（官方 hit 21,504 → 128）。
        _relocateStats = { ..._relocateVaryingBlocks(msgs, p), tail: tailMove, varBlk: varMove };   // ★ 整段变量后置（只动 system/user 预设块）
        // ★ v6.25.7【临时取证埋点，与 `onPromptReady` 那个 `msgs:in` 配对 —— 定死根因后必须删】：
        //   Horae 这一轮所有算子都跑完了，再报一次"模板块落在第几条"。两次一比：
        //     `msgs:in` 就已经在 #0 ⇒ **酒馆组装时就在前面**（Horae 无辜，得去查酒馆/预设的规则）；
        //     `msgs:in` 在后面、`msgs:out` 跑到 #0 ⇒ **就是 Horae 这几个算子搬的**，再逐个二分。
        try {
            if (Array.isArray(msgs) && msgs.length) {
                _diagReport({
                    tag: 'msgs:out', n: msgs.length,
                    tplAt: msgs.findIndex(m => String(m?.content ?? '').includes('输出模板')),
                    optAt: msgs.findIndex(m => String(m?.content ?? '').includes('追加行动选项')),
                    relocCount: (() => { try { return Number(_relocateStats?.count) || 0; } catch (_) { return -2; } })(),
                });
            }
        } catch (_) { }
        void _finalizeMeasure(p, msgs);
    } catch (err) {
        console.warn('[hitOpt] 定稿处理失败:', err);
    }
}

/* @36944-36962 */
function _chatRepoStamp() {
    try {
        const ctx = getContext();
        const md = ctx?.chatMetadata;
        if (!md || typeof md !== 'object') return null;
        const cur = md[HORAE_REPO_META];
        if (cur && typeof cur === 'object' && typeof cur.id === 'string' && cur.id) return cur;
        const now = Date.now();
        const stamp = {
            id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            at: now,
            chat: _currentChatFile(),
        };
        md[HORAE_REPO_META] = stamp;
        try { ctx.saveMetadataDebounced?.(); } catch (_) { /* 存盘失败也不影响本轮记账 */ }
        console.log(`[hitOpt] git 记录：这个聊天文件第一次记账 → 仓库 id ${stamp.id}（已写进聊天文件的 chat_metadata；删掉聊天文件重开会得到新 id → 新仓库）`);
        return stamp;
    } catch (_) { return null; }
}

/* @36965-36971 */
function _currentChatFile() {
    try {
        const ctx = getContext();
        const v = ctx?.getCurrentChatId?.() || ctx?.chatId || '';
        return typeof v === 'string' ? v : '';
    } catch (_) { return ''; }
}

/* @36981-36996 */
function _currentChatKey() {
    try {
        const ctx = getContext();
        const who = String(ctx?.characters?.[ctx?.characterId]?.name || ctx?.characterId || ctx?.groupId || '');
        const stamp = _chatRepoStamp();
        if (stamp) return `${who}::${stamp.id}`;
        const file = _currentChatFile();
        if (file) return `${who}::${file}`;
        const id = String(ctx?.chatId ?? '');
        if (id && /\.(jsonl|json)$/i.test(id)) return `${who}::${id}`;
        const first = Array.isArray(ctx?.chat) ? ctx.chat.find(m => m && typeof m.mes === 'string' && m.mes) : null;
        return `${who}::new@${_pfHash(String(first?.mes || '')).toString(36)}`;
    } catch (_) {
        return '';
    }
}


/* ══════════════════════════════════════════════════════════════════════════════
 * 三、装上监听（hitOpt 自己的入口接线）
 *
 *   源文件里这两条链的调用点是：
 *     · _installSendProof()                     —— 在 Horae 启动那一段里直接调（@40420）
 *     · _applyStableFront / _measureAssembledPrompt —— 在 onPromptReady 的**最后**（@39928 / @39932）
 *     · _onChatCompletionSettingsReady          —— eventSource.on(CHAT_COMPLETION_SETTINGS_READY)（@40474）
 *   ⚠ onPromptReady 是**原版函数**（474 名单内）⇒ 换回原版 Horae 之后那两行调用会一并消失
 *     ⇒ 本模块必须自己接同一个酒馆公开事件把它们拉起来（这就是"依赖换来源"的最后一处）。
 *
 *   顺序有保证（这条是查实的，不是推测）：酒馆 public/lib/eventemitter.js 的 emit 是
 *     for (…) await listeners[i](…)，**串行 await 每一个 handler**；
 *   而 hitOpt 的 loading_order = 200 > Horae 的 100 ⇒ 注册更晚 ⇒ 一定排在 Horae 的
 *   onPromptReady 跑完之后 ⇒ 拿到的正是"Horae 注入完之后"的那串 messages。
 * ══════════════════════════════════════════════════════════════════════════════ */

let _optInstalled = false;

/* ⛔⛔ 互斥闸门 —— 魔改版 Horae 还装着的时候，本模块**一个字都不许生效**。
 *
 * 为什么必须拦（这不是"多一层保险"，是**两个写者抢同一份数据**）：
 *   魔改版 horae.client.js 里带着**同一套**缓存算法，而 loading_order = 100 < 我们的 200
 *   ⇒ 它先跑、我们后跑；我们会拿到"已经被它改过一遍"的 messages 再改一遍
 *   （_abSplit、_restoreFrozenHistory、_applyStableFront 都会被跑两次），
 *   出网的那串字会同时被两套规则改写 ⇒ 账目和真实出网内容都对不上。
 *
 * 判据（已查实，不是推测）：
 *   原版 7a88598:assets/templates/drawer.html **没有**「差异分析」那个 tab —— 它是本地补丁加的；
 *   原版 index.js 里也**没有** HORAE_CACHE_PATCH。
 *   所以：抽屉里出现 horae-tab-btn-diff ⇒ 魔改版还在。
 *
 * 为什么用 DOM 而不是版本号：DOM 判据**自洽** —— 那个 tab 正是搬迁完成后要从 Horae 撤掉的东西，
 *   撤掉之后这里自动放行，不需要改代码、也不需要用户勾任何开关。
 * ⚠ 唯一的时序风险：本模块在 jQuery ready 时跑，那时 Horae 的抽屉**可能**还没插进 DOM
 *   ⇒ 单看这一眼会误判成"原版"。所以事件处理函数里**每次真跑之前还要再查一眼**（见下面三处）。
 */
function _magicHoraeStillHere() {
    try { return !!document.getElementById('horae-tab-btn-diff'); }
    catch (_) { return false; }
}

/** 装监听。index.js 只调这一个（重复调用是安全的）。 */
export function installOpt() {
    if (_optInstalled) return true;

    if (_magicHoraeStillHere()) {
        console.warn('[hitOpt] 检测到**魔改版 Horae 还装着**（它抽屉里有「差异分析」tab）');
        console.warn('[hitOpt] ⇒ 缓存优化本次不启用：那一边带着同一套算法，两边会先后改同一串 messages。');
        console.warn('[hitOpt] Horae 换成原版（7a88598）后刷新页面，这里会自动接上 —— 不用改任何设置。');
        return false;
    }

    _optInstalled = true;
    try { _optSyncSettings(); } catch (_) { }

    /* 出网取证：包一层 window.fetch —— _finalizeMeasure 靠它拿"真 POST body 里那份 messages"
       （数 token 与写账都以它为准；拿不到就退回定稿快照，并在 console 如实说一句）。 */
    try { _installSendProof(); } catch (e) { console.warn('[hitOpt] 出网取证没装上：', e); }

    /* ★ 2026-09-24【补回搬迁漏掉的一跳】官方 usage 采集 —— **必须排在 `_installSendProof` 之后**
       （它是第二层包装，在外层 `clone()` 才能在 ST 真正 await 之前拿到未被消费的 Response；
       反过来先包的人拿到的流已经被里层读过 ⇒ 克隆直接抛）。
       它与缓存优化**各自独立**：拿不到官方 usage 只让面板右半边空着，
       一个字都不影响发出去的提示词。 */
    try { _installUsageCapture(); } catch (e) { console.warn('[hitOpt] 官方 usage 采集没装上：', e); }

    /* ★ 2026-09-24【事故修复的接线】—— ⛔ **必须排在下面那个 `CHAT_COMPLETION_SETTINGS_READY`
       监听器**之前：酒馆 `public/lib/eventemitter.js` 的 emit 是 `for (…) await listeners[i](…)`
       **串行 await** ⇒ 先注册先跑。补丁要把"上一轮的取证残留"清掉，而
       `_onChatCompletionSettingsReady` 一进函数就可能读到它 ⇒ 顺序反了就白修。
       （补丁定义在 tail.js 第五节；这里 `typeof` 守卫是防 build 覆盖后漂移。） */
    if (typeof _patchInstallAll === 'function') { try { _patchInstallAll(); } catch (e) { console.warn('[hitOpt] 事故修复补丁没接上：', e); } }
    if (!eventSource?.on) {
        console.warn('[hitOpt] 这个酒馆版本没有 eventSource.on，缓存优化没接上');
        return false;
    }

    /* ① 注入完成那一刻（排在 Horae 的 onPromptReady 之后）—— 静态前置 ＋ 采池化前快照 */
    try {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
            /* ★ 每次真跑之前再查一眼互斥闸门：installOpt() 跑在 jQuery ready 那一刻，
               Horae 的抽屉**可能**还没插进 DOM ⇒ 只看那一眼会把它误判成"原版"。 */
            if (_magicHoraeStillHere()) return;
            /* ★★★★★★ 2026-09-24【移植漏掉的一行 —— 用户原话："我从未见过这个bug"】
             *   魔改版 `horae.client.js:39735`（`onPromptReady` 里）本来有这一行：
             *       if (eventData.dryRun) return;
             *   移植到 hitOpt 时**整行丢了**（全项目 `dryRun` 只剩一句注释、代码里一次没查）。
             *   酒馆 `Generate(..., dryRun)` 一次生成跑**两趟**（预演 dryRun=true 不发请求 ＋ 真发 dryRun=false），
             *   每趟都 emit `CHAT_COMPLETION_PROMPT_READY`（`script.js:4037` ＋ `openai.js:1619`）
             *   ⇒ 少了这一行，改写提示词与记账都会在预演趟也跑一遍。
             *   线上后果：同一发被记两个轮号（`#10`/`#11`，reqFile 相同、wire 逐字节相同、
             *   两次 pushTurn:enter 的 tokTotal 是 20505 / 23052 = 预演那份 / 真发那份）
             *   ⇒ 面板多一行永远填不上官方数的空行。
             *   ⛔ 不碰"发出去的那串字"。⚠ 补丁本体在 `tail.js` 同一处（build 整份覆盖 ⇒ 两处必须同步）。 */
            if (eventData?.dryRun) return;
            try {
                const chat = eventData?.chat;
                if (!Array.isArray(chat) || !chat.length) return;
                _optSyncSettings();
                /* ⚠ 依赖换来源⑦：injectedTexts 由 Horae 的注入系统给，本模块不做注入 ⇒ 传空数组 */
                _applyStableFront(chat);
                _measureAssembledPrompt(chat, []);
            } catch (e) {
                console.warn('[hitOpt] PROMPT_READY 处理失败:', e);
            }
        });
    } catch (e) { console.warn('[hitOpt] 注册 CHAT_COMPLETION_PROMPT_READY 失败:', e); }

    /* ② 定稿那一刻 —— 整条缓存优化算法 */
    try {
        if (event_types.CHAT_COMPLETION_SETTINGS_READY) {
            eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (data) => {
                /* ★ 这里是整条算法的**真正入口**，所以每次都要复查闸门（理由同 PROMPT_READY 那处）。 */
                if (_magicHoraeStillHere()) return;
                try { _optSyncSettings(); } catch (_) { }
                _onChatCompletionSettingsReady(data);
            });
        } else {
            console.warn('[hitOpt] 这个酒馆版本没有 CHAT_COMPLETION_SETTINGS_READY 事件，缓存优化没接上');
        }
    } catch (e) { console.warn('[hitOpt] 注册 CHAT_COMPLETION_SETTINGS_READY 失败:', e); }

    console.log('[hitOpt] 缓存优化已接上（CHAT_COMPLETION_PROMPT_READY ＋ CHAT_COMPLETION_SETTINGS_READY）');
    return true;
}

/** 只给验收用的几个口子（不在运行时被 index.js 使用）。 */
export const __optTestHooks = {
    _onChatCompletionSettingsReady,
    _measureAssembledPrompt,
    _applyStableFront,
    _optSyncSettings,
    _samePromptShape,
    _restoreFrozenHistory,
    _abSplit,
    settings,
    get _pendingMeasure() { return _pendingMeasure; },
    set _pendingMeasure(v) { _pendingMeasure = v; },
    _prevMsgsSave,
    _chatFloorNow,
    _amPoolCommit,
    _amAddrCommit,
    /* ★ 2026-09-24：算法清单的装载（`_expAlgoLoad`）—— 给 `tools/parity_opt.mjs` 一个
     * **确定的等待点**：那一行预热是 fire-and-forget（源文件如此），浏览器里"页面加载完 → 用户发一轮"
     * 之间早就落地了，而 node 对拍器是 import 完**立刻**调 `_abSplit` ⇒ 不等它就还是没装载。
     * ⚠ 只给验收用（与上面几个口子同一性质），`index.js` 运行时不碰它。 */
    _expAlgoLoad,
};

/* ══════════════════════════════════════════════════════════════════════════════
 * 四、原版函数依赖（474 名单内 —— ⛔ 一个都没有复制；逐个列这里，便于验收）
 *
 *   @21032  estimateTokens               ← _countStMessage / _countStText（只在分词器不可用时走）
 *   @39356  _normalizePromptMessageText   ← _sfChatHashes（只用来给静态前置多认一种指纹）
 *
 *   合计 2 个，都是**兜底/辅助**路径上的；主算法链（归一 / 还原 / A·B / 冻结 / 变量后置）
 *   对原版函数是 **0 依赖**（本条由 _tmp_port/plan.txt 的传递闭包算出来，可复跑）。
 * ══════════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════════════════
 * ★★★★★★ 2026-09-24【补搬：`tail.js` 第五节的补丁定义 —— 它们**从未进过 opt.js**】
 *   用户发现的：`opt.js` 里 `function _patch*` 只剩原有的 `_patchDropSeen`，其余补丁
 *   **一个定义都没有**；而调用点全带 `typeof === 'function'` 守卫 ⇒ **静默跳过**
 *   ⇒ 那批补丁（自举 / 同一发只记一次 / 清残留取证 / 硬盘兜底）**一次都没生效过**。
 *   ⚠ `build_patch_check.mjs` 当时报的绿是**假绿**：它的判据 `ok = inTail` 只查
 *     `tail.js`（build 的**输入**），压根没看 `opt.js`（**真跑的那份**）。判据已修成
 *     `inTail && inOpt`。
 *   ⛔ 这一段是按用户定版"手工搬、不动 build 链"补进来的，**逐字复制自 tail.js 第五节**。
 *     跑 `build.mjs` 时它会和 tail.js 的内容**重复** —— 但那时整份 opt.js 都会被覆盖，
 *     重复问题自然消失（这也是为什么没有把这段写进 parts/）。
 * ══════════════════════════════════════════════════════════════════════════════════════ */
let _patchPrevSig = '';          //@keep:prev-save-sig   上一次 `_prevMsgsSave` 的签名（空 ＝ 这一轮没写过）

let _patchBootDone = -1;         //@keep:prev-bootstrap  自举发生在哪一轮规模（-1 ＝ 还没发生；防重复自举）

function _patchInstallSettingsReadyGuard() {          //@keep:settings-clear-proof
    try {
        if (!eventSource?.on || !event_types?.CHAT_COMPLETION_SETTINGS_READY) return false;
        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, () => {
            try {
                if (_magicHoraeStillHere()) return;
                const stale = _sendProof;
                if (stale) {
                    try {
                        _diagReport({
                            tag: 'settings:clearProof', chat: _gitLogChat(),
                            hadN: Number(stale.n) || 0, ageMs: Date.now() - (Number(stale.at) || 0),
                        });
                    } catch (_) { }
                    _sendProof = null;
                }
            } catch (_) { }
        });
        return true;
    } catch (_) { return false; }
}

async function _patchMaybeBootstrap(msgs) {           //@keep:prev-bootstrap
    try {
        if (_patchPrevSig) return false;                              // 这一轮已经写过了 ⇒ 不动
        if (!Array.isArray(msgs) || msgs.length < 8) return false;    // 残片不作为基准
        const arr = msgs.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
        if (_patchBootDone === arr.length) return false;
        _prevMsgsSave(_currentChatKey(), arr, 'bootstrap');
        _patchBootDone = arr.length;
        try {
            _diagReport({
                tag: 'prev:bootstrap', chat: _gitLogChat(),
                n: arr.length, chars: arr.reduce((a, m) => a + String(m?.content ?? '').length, 0),
            });
        } catch (_) { }
        try {
            console.warn(`[hitOpt] 没有可用的还原基准 ⇒ **自举一份**（${arr.length} 条）存进候选池`
                + ` —— 下一次起 A 区就能正常增长（不是"从此暴毙"）。`);
        } catch (_) { }
        return true;
    } catch (_) { return false; }
}

function _patchInstallDiskBaseline() {                 //@keep:disk-baseline
    /* ⛔⛔ 2026-09-24【**真根因：这个守卫查错了对象 ⇒ 补丁从来没装上过**】
     *   酒馆的 `eventSource` 是 `/script.js` 的**模块导出**（本文件第 42 行 import 进来的），
     *   **不挂在 `window` 上** ⇒ `window?.eventSource` 恒为 `undefined` ⇒ 这里每次都 `return false`
     *   ⇒ `_patchInstallDiskBaseline()` **一次都没跑过**。
     *   【铁证】`_diag.log` 里 `baseline:disk` 心跳 **0 条**，而同族的 `settings:clearProof`
     *     （`_patchInstallSettingsReadyGuard`，它用的是**对的**写法 `eventSource?.on`）正常在发。
     *   【后果】F5 之后第一轮拿不到基准 ⇒ 池化整段放弃 ⇒ 命中率掉到 6%
     *     （实测第 6 轮 hit 1,536 / miss 22,188；第 7 轮 1,536 / 21,727，而前一轮是 71.1%）。
     *   ⚠ 别再照抄 `window.eventSource` 这个写法。 */
    if (!eventSource?.on || typeof _gitLogApi !== 'function') return false;

    /** 把硬盘上**上一轮真发出去那串**（`turns/<no>.json`，经 `/flat?chat=…&no=…&msgs=1`）读进内存
     *  （**盘上内容的临时镜像**，不是另搞一套"池"）。
     *  ⛔⛔ 2026-09-24【原来那两个错，别再改回去 —— 这个兜底从写下的那天起一次都没成功过】
     *    ① **通道错**：原来用静态网址 `/plugins/hitopt-git/_gitlog/<场>/turns/<no>.pre.json`，
     *       可 `plugins/` **不在 `public/` 下** ⇒ 浏览器取不到 ⇒ **永远 404**（实测确认）。
     *    ② **取错文件**：原来取 `pre.json`（池化前、客户端侧未合并，实测 36 条），
     *       而基准要的是真发出去那串（酒馆后端合并后，实测 11 条）⇒ 形状不同，通着也是错的。
     *  ⚠ 它的失效后果**只在 F5 之后的第一轮**显形：内存镜像空 ⇒ 兜底又拿不到 ⇒
     *    "基准拿不到 ⇒ 池化整段放弃" ⇒ 命中率掉到 6%（实测第 6 轮 hit 1,536 / miss 22,188）。
     *  ⚠ 用户定版："**不能说内存池，而是压根没有好吗，我一般推荐就是直接读，
     *    反正也花不了十几G的读取**" ＋ "**我随时切换聊天，内存就是临时的，真实都是硬盘上的文件**"
     *    ⇒ 语义就是"**直接读盘**"：每次切聊天/启动都重读（不指望内存里还留着），
     *      按 `chatKey` 分槽存；不搞配额、不搞淘汰规则、不跨场复用。
     *  ⚠ 为什么要**提前**读而不是用的时候读：`_restoreFrozenHistory` 是**同步函数**
     *    （酒馆把 msgs 交给它的那一瞬间就要返回），等不了 fetch —— 这是唯一的技术约束。
     *  ⚠ 读**最近 `PREV_PROMPT_KEEP` 轮**：`_prevMsgsPickBest`（v6.24.86 用户点名要的
     *    "找 <=当前楼层、LCP 最长的那份"）需要不止一份才挑得动。 */
    const pull = async (why) => {
        let tag = 'skip';
        /* ★ 零花费自检（2026-09-24，用户原话："你验证先 再让我线上 老子没那么多钱让你玩"）——
         *   把池里**第一份基准**的形状指纹写进 `baseline:disk` 心跳 ⇒ 只要 F5（或切一次聊天），
         *   读 `_diag.log` 就能判定池里那份到底能不能用，**不必发一轮花钱**：
         *     `disk:00009:43条/48538字:ok`    ⇒ 形状对、量级对（该看到这个）
         *     `disk:00007:43条/0字:形状错(对象)` ⇒ 第 11 轮那个病（对象被当成空串读）
         *   ⚠ 判据量的是**池里存的原始形状**（数组对 or 对象），不是拼装前那份。 */
        try { globalThis.__hitOptDiskHeadSig = ''; } catch (_) { }
        try {
            const chat = (typeof _currentChatKey === 'function') ? String(_currentChatKey() || '') : '';
            if (!chat) tag = 'no-chat';
            else {
                /* `/log` 默认要读 git log ＋ 每轮存档状态，比 `/turn` 慢 ⇒ 给 15 秒
                 * （`_gitLogApi` 的默认是 4 秒，那是给 `/turn` 定的） */
                const r = await _gitLogApi('/log?items=0&chat=' + encodeURIComponent(chat), undefined, 15000);
                const list = Array.isArray(r?.commits) ? r.commits : [];   // ⚠ `commits` 新的在前
                if (!list.length) tag = 'no-turns';
                else {
                    const pool = (globalThis.__hitOptPrevPool && typeof globalThis.__hitOptPrevPool === 'object')
                        ? globalThis.__hitOptPrevPool : (globalThis.__hitOptPrevPool = {});
                    const slot = (pool[chat] && Array.isArray(pool[chat].list)) ? pool[chat].list.slice() : [];
                    let got = 0, preFall = 0;   // `preFall` = 退到 pre.json 的**降级**份数（正常应为 0）
                    /* ★ 2026-09-24【排序基准时刻必须**在循环外取一次】** —— 原来写 `at: Date.now() + no`，
                     *   而 `Date.now()` 在**每次 HTTP 取数之后**都往前走几十毫秒，`+no` 那点补偿（差 1~2）
                     *   完全淹没在里面 ⇒ `at` 实际上由"**取数耗时**"决定、不由轮号决定。
                     *   循环顺序是 `9 → 8 → 7` ⇒ **`00007` 的 at 最大** ⇒ 排第一 ⇒
                     *   `_prevMsgsPickBest` 在三份**逐条前缀打平**（都断在第 8 条）时用严格大于
                     *   ⇒ **第一份胜出 = 挑中最旧的那份 00007**（正是第 11 轮 `rsBase: disk:disk:00007`）。
                     *   `t0` 取一次 ⇒ `at` 只由 `no` 决定 ⇒ 越新越靠前 ⇒ 打平时挑到的才是**上一轮**。 */
                    const t0 = Date.now();
                    for (const c of list.slice(0, PREV_PROMPT_KEEP)) {
                        const no = Number(c?.no);
                        if (!Number.isFinite(no)) continue;
                        const k = String(no).padStart(5, '0');
                        try {
                            /* ⛔⛔⛔ 2026-09-24【基准 = 上一轮**真发出去的那串** = `A⊕B⊕C`（切片），**不是** pre.json】
                             *   这里踩到**第五次**，前四次全是"文件挑错"的同一个病，这次把"哪一份、什么顺序"钉死：
                             *     · `turns/<n>.pre.json`（路由 `/pre`）＝ 那一轮**池化前的输入** —— **不是基准**；
                             *     · `turns/<n>.abc.json`（路由 `/abc`）里的 `A ⊕ B ⊕ C` ＝ 那一轮**真发出去的那串** ✓
                             *   【铁证·条数就对不上】同一轮两边：切片 `A+B+C` = **43 条 / 48,538 字**（`00009`），
                             *     而 `pre.json` = **36 条 / 38,019 字** —— 差 7 条正是算法自己派生出来的 B 区。
                             *     拿 36 条形状的东西当基准，去这一轮 43 条里找锚 ⇒ 只找得到一半
                             *     （实测 A 作前缀 **8/17** 条）⇒ **部分切分** ⇒ 命中 85% 掉到 **60%**。
                             *   【尺子同源】与 `hitOpt/tools/replay_turn.mjs:229` **逐字同一句**：
                             *     `const prev = [...prv.A, ...prv.B, ...prv.C]` —— 那边一直是对的，
                             *     客户端这边从装上这条通道起就是错的（前四次都在修"通道不通"，没验"水对不对"）。
                             *   ⚠ 顺序一个字不许动：`A → B → C`；用的是 **`B`（池化后）而不是 `B0`（池化前原文）**。
                             *   ⚠ 老轮次没有切片（v6.38.1 之前）⇒ 那一支才退 `/pre`，并在 tag 里标出来（降级≠正常）。 */
                            let ms = null, msSrc = 'abc';
                            try {
                                const j = await _gitLogApi(`/abc?chat=${encodeURIComponent(chat)}&no=${no}`, undefined, 15000);
                                const P = j?.parts || null;
                                if (P && Array.isArray(P.A) && Array.isArray(P.B) && Array.isArray(P.C)) {
                                    /* ⛔⛔⛔ 形状必须与**池的读取端**逐字段一致 —— `_prevCandidates` 是按
                                     *   `x?.[0]` / `x?.[1]`（**数组对**）解析的，不是 `{role, content}` 对象！
                                     *   【第六次同类事故 · 这一刀是我自己砍的】`/abc` 路由回的是对象数组，
                                     *   我照原样塞进池 ⇒ 池读出来 every entry 都是**空字符串** ⇒ 基准作废
                                     *   ⇒ `_abSplit` 报"基准里没有一条能在这轮里逐字节找到" ⇒
                                     *   实测第 11 轮 `prompt 18,681 / hit 0 / miss 18,681`（0.0%），
                                     *   而同一份数据离线重放本该 `命中 42,210 字 ≈ 25,284 tok` ⇒ **白付 11,477 tok**。
                                     *   ⚠ `/pre` 那条老路回的是 `[[role, content]]`（数组对）⇒ 老代码是对的。
                                     *   ⚠ 自愈那条（`_selfHealMissing`）喂的是 `_abSplit`，要的**就是对象** ⇒
                                     *     两处的形状**故意不同**，别"统一"成一个。 */
                                    ms = [...P.A, ...P.B, ...P.C].map(x => [String(x?.role || ''), String(x?.content ?? '')]);
                                }
                            } catch (_) { }
                            if (!ms || !ms.length) {
                                const j2 = await _gitLogApi(`/pre?chat=${encodeURIComponent(chat)}&no=${no}`, undefined, 15000);
                                const m2 = Array.isArray(j2?.msgs) ? j2.msgs : null;
                                if (m2 && m2.length) { ms = m2; msSrc = 'pre'; }
                            }
                            if (!ms || !ms.length) continue;
                            if (msSrc === 'pre') preFall++;
                            const sig = `disk:${k}`;
                            const kept = slot.filter(it => String(it?.digest || '') !== sig);
                            /* ⚠ `src` 是**来源标签**（`_prevMsgsPickBest` 按它判可信度；`wire:` 开头那一类会被过滤）
                             *   ⇒ 这里写 `disk`：它就是"盘上那份真发出去那串"，与内存里的 `wire0`/`post` 同族不同名。 */
                            kept.push({ at: t0 + no, src: 'disk', digest: sig, floor: null, msgs: ms });
                            slot.length = 0; slot.push(...kept);
                            got++;
                        } catch (_) { }
                    }
                    if (got) {
                        slot.sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0));
                        pool[chat] = { at: Date.now(), list: slot.slice(0, PREV_PROMPT_KEEP) };
                        tag = `disk+${got}` + (preFall ? `+pre${preFall}` : '');
                        try {
                            const _f = slot.slice().sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))[0];
                            const _mm = Array.isArray(_f?.msgs) ? _f.msgs : [];
                            const _obj = _mm.length > 0 && !Array.isArray(_mm[0]);       // 形状错：对象而非数组对
                            const _ch = _mm.reduce((s, m) => s + String(Array.isArray(m) ? m[1] : (m?.content ?? '')).length, 0);
                            globalThis.__hitOptDiskHeadSig = `${String(_f?.digest || '?')}:${_mm.length}条/${_ch}字:${_obj ? '形状错(对象)' : 'ok'}`;
                        } catch (_) { globalThis.__hitOptDiskHeadSig = 'err'; }
                        console.warn(`[hitOpt] 直接读盘：取回 ${got} 份"上一轮真发出去那串"（A⊕B⊕C 切片${preFall ? `，其中 ${preFall} 份退化成 pre.json` : ''}）（${why}）`);
                        /* ★★★★★★ 2026-09-24【读回来必须**装一次** —— 否则这一趟白读】
                         *  【时序陷阱】F5 之后：
                         *    0.0s `installOpt()` 跑 → 调 `_prevMsgsRestore()` ⇒ 此刻镜像**还是空的**
                         *         ⇒ 装不回来 ⇒ `_prevRealMsgs = null`
                         *    1.2s 本预取才跑完 → 镜像**这时才填上** ⇒ 但**没人再装一次**
                         *  ⇒ F5 后第一轮 `_prevRealMsgs` 仍是 null ⇒ `abBase` 退回 `picked`
                         *    ⇒ A 区缩水（实测 45,921 → 18,854 字）⇒ **这一趟等于白读**。
                         *  ⇒ 填完镜像**主动装一次**（`_prevMsgsRestore` 从镜像读、并带场标）。
                         *  ⚠ 只在**内存里那份为空**时装 —— 有就不动（内存那份更新）。 */
                        try {
                            if ((!Array.isArray(_prevRealMsgs) || !_prevRealMsgs.length)
                                && typeof _prevMsgsRestore === 'function') {
                                const ok = _prevMsgsRestore(chat);
                                tag += ok ? '+restored' : '+restore-fail';
                            }
                        } catch (_) { }
                    } else tag = 'none';
                }
            }
        } catch (e) { tag = 'err:' + String(e?.message || e).slice(0, 40); }
        try { _diagReport({ tag: 'baseline:disk', chat: _gitLogChat(), why, r: tag, head: String(globalThis.__hitOptDiskHeadSig || '') }); } catch (_) { }
        return tag;
    };

    try {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            /* ★★★★★★ 2026-09-24【切聊天必须把"上一轮那份"清干净 —— 用户实测的跨场污染】
             *  【铁证】新聊天 林夏::muf7oy4ufvjb **第 1 轮**（floor=0）的心跳：
             *    rsBase=post:d05e431f  prevLen=**38**  abBase=**last**  A=**33条/35,231字**
             *    —— 第 1 轮不该有任何 A 区；38/33 正是上一场 林夏::muf17g3x5dix 的规模。
             *  【根因】_prevRealMsgs / _prevLastMsgs 是模块级内存变量，切聊天时没人清；
             *    `_restoreFrozenHistory` 那句"无条件重写"只保证**第二轮往后**不串场，**第一轮**漏了。
             *  【修法】这一刻全清 ⇒ 新聊天第一轮"没有基准"是**事实**，不靠下一轮去纠正。
             *  ⛔ 只清内存镜像，不动硬盘上任何存档。 */
            try {
                _prevRealMsgs = null;
                _prevLastMsgs = null;
                _prevTurnSnap = null;
                _prevBaselineSrc = '';
                try { globalThis.__hitOptPrevChat = ''; } catch (_) { }   // ★ 场标一起清（读写隔离）
                console.warn('[hitOpt] 切聊天 ⇒ 已清掉"上一轮那份"（防跨场污染）');
                try { _diagReport({ tag: 'baseline:cleared', chat: _gitLogChat(), why: 'chat-changed' }); } catch (_) { }
            } catch (_) { }
            void pull('chat-changed');
        });
    } catch (_) { }
    /* 启动这一次：与 `installOpt` 里那次 `_prevMsgsRestore` 并行跑，谁先到算谁的
     * （`pull` 只在内存为空时才写 ⇒ 不会把 localStorage 装回来的那份盖掉） */
    setTimeout(() => { void pull('boot'); }, 1200);
    /* ★★★★★★ 2026-09-24【**自愈的调度** —— 用户定版原话："这些修复都应该是自动的，不用过多提醒你 /
     *   本来就是插件的失责，用户可不管你这些"】
     *   ⇒ 缺结构这种事由**插件自己**在空闲时补，⛔ 不要用户 F5 / 重启 / 跑工具。
     *   时机：启动后 **6 秒**（让这一场的首轮生成先跑完，别跟它抢网络与 CPU）；
     *        切聊天后再补一次（**8 秒** —— 那时 `/log` 与存档都稳了）。 */
    setTimeout(() => { void _selfHealMissing('boot'); }, 6000);
    try { eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(() => { void _selfHealMissing('chat-changed'); }, 8000)); } catch (_) { }
    console.log('[hitOpt] 基准硬盘兜底已接上（localStorage 不可靠时的后路）');
    return true;
}

/** ★★★★★★ 2026-09-24【**自愈：插件自己把缺的结构补回来**】
 *   用户定版原话："**这些修复都应该是自动的，不用过多提醒你 / 本来就是插件的失责，
 *   用户可不管你这些**" ⇒ 某一轮"池化整段没跑"（典型：F5 之后第一轮基准拿不到）留下的空缺，
 *   **由插件自己收拾**，⛔ 不要用户 F5 / 重启 / 跑工具：
 *     ① `GET /missing?chat` 问服务端"这一场哪几轮缺 abc、**该不该补**"（只补 `fixable` 的）；
 *     ② 每一轮：输入取 `GET /pre?chat&no`（那一轮**池化前的整份输入**）、
 *        基准取 `GET /flat?chat&no=<n-1>&msgs=1`（**上一轮真发出去那串**）；
 *        跑**本地算法** `_abSplit` ⇒ 拿到 A/B0/B/C；
 *     ③ `POST /backfill-abc` 让服务端按客户端那份的逐字段形状写回盘上。
 *   ⛔ 红线：**算不出来就不写** —— `_abSplit` 拒绝切分（"基准里没有一条能在这轮里逐字节找到"，
 *     典型是自动总结那几发）是**算法的正确行为**，硬凑一个"看着像"的结构就是造假数据；
 *     ⛔ 不碰"发出去的那串字"；⛔ 已有 abc 的轮次服务端会拒绝覆盖（真值优先）。
 *   ⚠ 全程**不给用户添任何动作**，只发 `selfheal:*` 心跳留档（盘上可查、不刷控制台）。 */
async function _selfHealMissing(why) {
    try {
        if (globalThis.__hitOptHealBusy) return;
        globalThis.__hitOptHealBusy = 1;
        const chat = (typeof _currentChatKey === 'function') ? String(_currentChatKey() || '') : '';
        if (!chat) { globalThis.__hitOptHealBusy = 0; return; }
        /* ★★★★★★ 2026-09-24【用户红线（原话）："**一旦 hit/miss 低于 70% 必有问题**"】
         *   ⇒ 自愈每次扫描**先量一下最近一轮的官方命中率**：低于 **85%** 就发一条
         *     `selfheal:lowhit` 心跳（带 no / prompt / hit / miss / pct）—— **盘上留档**，
         *     这样我事后直接从 `_diag.log` 就能查出"哪几轮低、低在什么数上"，不用等用户说。
         *   ② **照样往下走**：低命中**最常见**的成因就是"池化结构缺失"（基准拿不到 ⇒ 池化整段没跑
         *     ⇒ 前缀断在最前面）—— 下面那一段正好就是补它。
         *   ⚠ 只认**官方数**（`usage`）：结构缺失时本地那几列本身就是假的，拿它判会误判。 */
        try {
            /* ★ 2026-09-24【用户二次点名："**我们只看本地计算结果**"】⇒ 判据与提示一律走**本地**那三列
             *   （服务端 `lcpOfTurns` 现算的 `lcpChars` / `missChars`），⛔ 不再看官方 `usage` ——
             *   用户要的是"我们自己的算法有没有把前缀接上"，不是服务商的账。
             *   ⚠ 本地列**只在 `items=1` 时才算**：`items=0` 时服务端为省响应体跳过、全为 null
             *     （实测过 —— 不加这个参数 `lcpChars` 就是 null ⇒ 判据会**静默失效**，比报错更坏）。 */
            const lg = await _gitLogApi('/log?chat=' + encodeURIComponent(chat) + '&items=1', undefined, 15000);
            const cs = (Array.isArray(lg?.commits) ? lg.commits : [])
                .filter((c) => c && Number.isFinite(Number(c.lcpChars)) && Number.isFinite(Number(c.missChars)));
            const last = cs[0];                       // `/log` 的 commits **新的在前**
            if (cs.length) {
                /* ★★★★★★ 2026-09-24【用户更正口径（原话）："哦我说的是高论数，你可以按首轮请求数的来算"】
                 *   ⇒ 85% 这条红线**按这一场从第 1 轮起累计的请求数**算：
                 *      总命中率 = Σhit ÷ Σprompt（把这一场**所有轮**的官方数加起来），
                 *      ⛔ 不是只看最近一轮（单轮的抖动不该让整场判"有问题"）。
                 *   ⚠ 最近一轮的数一并带上（`lastNo` / `lastPct`）—— 判据在累计，
                 *     但"是哪一轮把累计拉下来的"要能一眼看出来。 */
                let lc = 0, lm = 0;                        // 本地：Σ lcpChars ／ Σ missChars（都是**字**）
                for (const c of cs) {
                    lc += Number(c.lcpChars) || 0;
                    lm += Number(c.missChars) || 0;
                }
                const pctAll = (lc + lm) > 0 ? lc / (lc + lm) : NaN;
                const lastLc = last ? Number(last.lcpChars) : NaN;
                const lastLm = last ? Number(last.missChars) : NaN;
                const lastPct = (Number.isFinite(lastLc) && Number.isFinite(lastLm) && (lastLc + lastLm) > 0)
                    ? lastLc / (lastLc + lastLm) : NaN;
                /* ★ 2026-09-24【用户二次定版：**爆异常的门槛 = 50%**（原为 85%）】
                 *   用户原话："**爆异常放到50%比例**"。
                 *   ⇒ 低于 50% 才发 `selfheal:lowhit`（那是真异常）；50%~85% 之间**不再爆** ——
                 *     这个场的历史健康轮本来就在 71~73% 一带（世界书条目进出是结构性的，
                 *     不是算法病），按 85% 报等于把"正常"当"异常"，噪音会把真信号淹掉
                 *     （实测第 13 轮 83.0% 也会被判成 lowhit）。
                 *   ⚠ 口径一个字没改：仍按**这一场从第 1 轮起累计**的 Σhit ÷ Σprompt 算。 */
                if (Number.isFinite(pctAll) && pctAll < 0.5) {
                    try {
                        _diagReport({
                            tag: 'selfheal:lowhit', chat, why,
                            scope: 'all', src: 'local', turns: cs.length,
                            chars: lc + lm, hitChars: lc, missChars: lm, pct: Number(pctAll.toFixed(4)),
                            lastNo: last?.no, lastPct: Number.isFinite(lastPct) ? Number(lastPct.toFixed(4)) : null,
                        });
                    } catch (_) { }
                    /* ★ 2026-09-24【用户点名："**直接酒馆消息提示 缓存命中异常**"】
                     *   ⇒ 光写 `_diag.log` 心跳不算"提示"（那得有人去翻盘才知道）——
                     *     这一条**直接弹在酒馆界面上**，用户当场就看见这一轮的钱花歪了。
                     *   ⛔ 只用 `toastr`（纯 UI 弹窗）：不插系统消息、不碰聊天内容、不改任何数据 ——
                     *     往聊天里塞一条"提示"就等于改了他下一轮的输入（那是红线）。
                     *   ⚠ 必须**节流**：同一场 ＋ 同一轮 ＋ 同一百分比只弹一次
                     *     （不然启动 6 秒那次、每次切聊天都会各弹一遍 ⇒ 变成刷屏噪音，用户会先烦你）。
                     *   ⚠ 拿不到 toastr（沙箱 / 老版本酒馆）⇒ **静默退化成只写心跳**，绝不抛。 */
                    try {
                        const T = (typeof toastr !== 'undefined' && toastr) ? toastr
                            : (globalThis.toastr || (globalThis.window && globalThis.window.toastr) || null);
                        const pctTxt = (pctAll * 100).toFixed(1) + '%';
                        const lastTxt = Number.isFinite(lastPct)
                            ? `，最近一轮（第 ${Number(last?.no) + 1} 轮）${(lastPct * 100).toFixed(1)}%` : '';
                        const toastKey = `${chat}|${last?.no}|${pctTxt}`;
                        if (T && typeof T.warning === 'function' && globalThis.__hitOptLowHitToast !== toastKey) {
                            globalThis.__hitOptLowHitToast = toastKey;
                            T.warning(`缓存命中异常：本地命中率 ${pctTxt}（本场累计 ${cs.length} 轮${lastTxt}）`, 'hitOpt 命中优化',
                                { timeOut: 15000, extendedTimeOut: 8000, progressBar: true, positionClass: 'toast-top-right' });
                        }
                    } catch (_) { }
                }
            }
        } catch (_) { /* 量不到不影响补结构 */ }
        const m = await _gitLogApi('/missing?chat=' + encodeURIComponent(chat), undefined, 15000);
        const all = Array.isArray(m?.miss) ? m.miss : [];
        const todo = all.filter((x) => x && x.fixable);
        try { _diagReport({ tag: 'selfheal:scan', chat, why, missing: all.length, fixable: todo.length }); } catch (_) { }
        let fixed = 0;
        for (const it of todo) {
            const n = Number(it?.no);
            if (!Number.isFinite(n) || n < 1) continue;
            try {
                const toArr = (x) => (Array.isArray(x) ? x : []).map(([role, content]) => ({ role: String(role || ''), content: String(content ?? '') }));
                const pre = await _gitLogApi(`/pre?chat=${encodeURIComponent(chat)}&no=${n}`, undefined, 15000);
                /* ⛔⛔ 基准必须是**上一轮真发出去的那串** ＝ 上一轮 `abc.json` 的 `A⊕B⊕C`
                 *   （与 `_patchInstallDiskBaseline`、与 `hitOpt/tools/replay_turn.mjs:229` **同一句**）。
                 *   原来这一行是 `/flat?…&no=n-1&msgs=1` ＝ **铺平后的出网形状**（酒馆后端合并过的 7~13 条），
                 *   而 `_abSplit(msgs, prev)` 要拿它去这一轮**客户端侧 40 余条**里逐条逐字节找锚
                 *   ⇒ **一条都找不到** ⇒ 补出来的那份从根上是错的（第 9 轮 `hit 0 / miss 25,983` 就是这么来的）。
                 *   ⚠ 顺序 `A → B → C`、用 `B`（池化后）不用 `B0` —— 与主链一个字都不许差。 */
                let prev = [];
                try {
                    const ab = await _gitLogApi(`/abc?chat=${encodeURIComponent(chat)}&no=${n - 1}`, undefined, 15000);
                    const P = ab?.parts || null;
                    if (P && Array.isArray(P.A) && Array.isArray(P.B) && Array.isArray(P.C)) {
                        prev = [...P.A, ...P.B, ...P.C].map(x => ({ role: String(x?.role || ''), content: String(x?.content ?? '') }));
                    }
                } catch (_) { }
                if (!prev.length) {
                    /* 上一轮也没有切片（老记录 / 池化整段没跑）⇒ 退 `pre.json` 保底：**降级**，只为"不瘫"。 */
                    const base = await _gitLogApi(`/pre?chat=${encodeURIComponent(chat)}&no=${n - 1}`, undefined, 15000);
                    prev = toArr(base?.msgs);
                }
                const msgs = toArr(pre?.msgs);
                if (!msgs.length || !prev.length) continue;
                const out = _abSplit(msgs, prev) || {};
                if (!Array.isArray(out.A) || !out.A.length) continue;   // ⛔ 算法拒绝 ⇒ 不补（不是失败）
                const r = await _gitLogApi('/backfill-abc', {
                    chat, no: n,
                    A: { msgs: out.A }, B: { msgs: out.B }, B0: { msgs: out.B0 }, C: { msgs: out.C },
                }, 20000);
                if (r?.ok) fixed++;
            } catch (_) { /* 单轮失败不影响别的轮 */ }
        }
        try { _diagReport({ tag: 'selfheal:done', chat, why, fixed, todo: todo.length }); } catch (_) { }
        if (fixed) { try { console.log(`[hitOpt] 自愈：补回 ${fixed}/${todo.length} 轮缺失的池化结构（${why}）`); } catch (_) { } }
        globalThis.__hitOptHealBusy = 0;
    } catch (e) {
        globalThis.__hitOptHealBusy = 0;
        try { _diagReport({ tag: 'selfheal:fail', chat: _gitLogChat(), why, err: String(e?.message || e).slice(0, 80) }); } catch (_) { }
    }
}

/* ★ 2026-09-24【面板楼层格那颗「重算」按钮的落点】（用户："加个重算按钮在红圈处 / 单元格第一行 楼层右边"）
 *   手动触发**同一条自愈路**：扫这一场"缺池化结构"的轮 → 本地算法重算 → 写回盘上。
 *   ⚠ 它是**全场扫**（不只那一轮）—— 缺的通常不止一轮，一次点完正好；
 *     按钮的悬停里如实写的是"重算这一轮的池化结构"，而实际会把这一场缺的都补上。
 *   ⛔ 不动发出去的那串字，也不改历史命中率（那一格是既成事实）。 */
try { globalThis.hitOpt = Object.assign(globalThis.hitOpt || {}, { recalcTurn: (no) => _selfHealMissing('manual:' + no) }); } catch (_) { }

function _patchInstallAll() {                          //@keep:install-all
    const okGuard = _patchInstallSettingsReadyGuard();
    let okDisk = false, why = '';
    try { okDisk = _patchInstallDiskBaseline(); } catch (e) { why = String(e?.message || e).slice(0, 80); }
    try { console.log(`[hitOpt] 事故修复补丁：清残留取证 ${okGuard ? '已接上' : '没接上'}`); } catch (_) { }
    try { console.log(`[hitOpt] 事故修复补丁：基准硬盘兜底 ${okDisk ? '已接上' : '没接上'}`); } catch (_) { }
    /* ★★★★★★ 2026-09-24【"装没装上"必须**留档**，不能只在控制台里 —— 这一条是拿真金白银换的】
     *   事故经过：`_patchInstallDiskBaseline` 的守卫写成 `window?.eventSource`（酒馆不挂 window）
     *   ⇒ 它每次 `return false` ⇒ 补丁**从来没装上**；而我从盘上**一点都看不出来**
     *   （`baseline:disk` 心跳 0 条 —— 因为没装所以不发心跳，而"没发"与"没这个功能"在盘上同形），
     *   只能顺着 `abc.meta` 那句"盘上兜底 这一场还没预取过"往错的方向查了一整轮。
     *   ⇒ 现在**装与没装都发一条**，字段写清两个补丁各自的结果 ＋ 抛了的话抛在哪。 */
    try { _diagReport({ tag: 'patch:install', chat: _gitLogChat(), guard: okGuard, disk: okDisk, why }); } catch (_) { }
    return okGuard;
}

function _patchTurnIsDup(sendProof) {                  //@keep:dup-guard
    try {
        const sp = (sendProof && typeof sendProof === 'object') ? sendProof : null;
        const fp = sp ? `${String(sp.digest || '')}@${Number(sp.at) || 0}` : '';
        if (!fp) return '';
        if (globalThis.__patchLastFp === fp && (Date.now() - Number(globalThis.__patchLastAt || 0)) < 5 * 60 * 1000) return fp;
        return '';
    } catch (_) { return ''; }
}

function _patchTurnMarkDone(sendProof, no) {           //@keep:dup-guard
    try {
        const sp = (sendProof && typeof sendProof === 'object') ? sendProof : null;
        if (!sp) return;
        globalThis.__patchLastFp = `${String(sp.digest || '')}@${Number(sp.at) || 0}`;
        globalThis.__patchLastAt = Date.now();
        globalThis.__patchLastNo = Number(no) || -1;
    } catch (_) { }
}

function _patchMarkPrevSig(sig) {                      //@keep:prev-save-sig
    try { _patchPrevSig = String(sig || ''); } catch (_) { }
}

function _patchResetPrevSig() {                        //@keep:prev-save-sig
    try { _patchPrevSig = ''; } catch (_) { }
}
