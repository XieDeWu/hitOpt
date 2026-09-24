/**
 * ==============================================================================
 * Horae 缓存账本（horae-ledger）—— 账表模块 ledger.js
 *
 * 【这是什么】
 *   从 Horae 扩展本体（_horae_patch/horae.client.js，40603 行）里搬出来的
 *   「缓存账本 / 差异表」：把每一轮真实发出去的 request 画成一张固定列的表
 *   （官方 usage 那几列 ＋ 本地 lcp 那几列 ＋ 费用 ＋ 断点位置）。
 *
 * 【第一设计约束：自包含】
 *   · 不 import 源文件的任何东西 —— 本文件里所有函数都是从 horae.client.js **逐字搬来**的；
 *   · 不读 window.Horae；
 *   · 只 import 酒馆自己的模块（当前只用到 /scripts/extensions.js 的 getContext）；
 *   · 不碰 Horae 的 DOM id —— 画表的容器由调用方传进来（否则用本模块自己的 id）。
 *
 * 【★★ 搬来的全部是"我们的魔改"，没有一份是原版代码的副本（2026-09-24 逐个核过）】
 *   原版锚点 = 上游 v1.15.1 的最后一个提交 7a8859897bbfc6f0781ac5eb2451bc607e2bab95。
 *   本文件 88 个顶层声明名，在那份原版的 8 个 js 文件里**一个都不存在** ——
 *   既没有同名声明，也没有裸串出现过一次。含 _diffTok / _getPrice / _getPriceMode / _yuan /
 *   _diffName / _diffFmtPct / _diffClock / _diffKindShort 这些"名字很短、很像原版就有"的。
 *   方法自检（防假绿）：拿 horae.client.js 的 1133 个顶层名去比**同一份原版**，
 *   有 561 个命中 —— 上游原样保留的那批代码是查得出来的 ⇒ 上面那个 0 是真的 0。
 *   旁证：原版全文里 prompt_cache_hit_tokens / usage.json / lcpChars / turns/ / horae-git /
 *   chat_metadata 各出现 0 次 ⇒ 整套「缓存账本 / 差异面板」本来就是我们的新增。
 *   ⛔ 原版就有的东西（settings / DEFAULT_SETTINGS / 摘要系统 _autoSummary* / RPG 与时间线面板 …）
 *      一个字都没进这个文件，**别再加进来** —— 那会变成"同一份逻辑两处存在"的分叉。
 *
 * 【搬不动的部分（如实列出，逐条见交付报告）】
 *   · 摘要系统操作台：_autoSummary* / _diffReplacePlan / _diffPlanContext / _diffPlanReady /
 *     _diffCard* / _diffTrajectoryLinesOf / _diffSim* / _diffSummarizeUi / _diffManualSummarize /
 *     checkAutoSummary / _pickAutoSummary* / _scoreAutoSummary* / _collectAutoSummary* / _resummaryGate
 *     —— 一个都没搬（任务明令），相关的那一列 / 那一块降级成 null 或 —。
 *   · 实验算法链 _expAlgo* —— 不在任务清单里，但它读 Horae 的管线注册表与内存产物，同样搬不动；
 *     按源文件里"开关关着"的默认路径固定下来（表头那组恒写「本地」）。
 *   · 差异页入口 _dvLinks / _dvPage / _dvTurnUrl —— 差异页没搬，表格里那串 ↗ 链接整块摘掉。
 *   · Horae 的诊断上报 _diagReport（写抓包插件的 _diag.log）—— 降级成 console.warn。
 *   · 记录服务的写接口 _gitLogPushTurn / _gitLogFetchWire / _gitLogStatusHtml /
 *     _refreshGitLogStatus / _gitLogScheduleRetry —— 一个都没搬（只搬"读"）。
 *   · Horae 的摘要卡指纹 _diffSummaryStateKey —— 属于摘要系统，没搬；缓存那 5 秒只看时间窗。
 *
 * 【依赖换来源的三个口子（源文件直接读 Horae 内部状态，这里改成注入）】
 *   ① 当前记录 id：源文件是 () => _currentChatKey()（读 chat_metadata 的 horae_repo 章）
 *      => setChatKey()；不注入就是空串，一切按"查不到记录"如实处理。
 *   ② 状态行重画：源文件 _refreshGitLogStatus() 画进 Horae 的 #horae-git-status
 *      => setStatusPainter()；不注入就是空实现。
 *   ③ 画布：源文件写死 document.getElementById('horae-diff-table')
 *      => 容器参数 / 本模块自己的 id（LEDGER_BOX_ID）。
 *
 * ！本文件的注释里一律不写反引号（项目硬约束：模板串与注释里提代码名不带反引号）。
 * ==============================================================================
 */
import { getContext, extension_settings } from '/scripts/extensions.js';

/* 源文件 @28782：function _gitEsc(s) { return _wiEsc(s); } —— 逐字搬（_wiEsc 本身在下面的切片里）。 */
function _gitEsc(s) { return _wiEsc(s); }

/* ══ 依赖换来源：调用方注入的三个口子 ══════════════════════════════════════════ */

let _ledgerChatKey = '';                 // ① 当前记录 id（＝源文件的 _currentChatKey() 结果）
let _ledgerStatusPaint = () => { };      // ② 状态行重画回调（＝源文件的 _refreshGitLogStatus）
let _ledgerBoxEl = null;                 // ③ 账表容器（＝源文件的 #horae-diff-table）
/* ④ 记录服务地址（＝面板自己探到的真实挂载名，形如 /api/plugins/horae-git）。
 *    只给"楼层格底下那两行入口"拼查看页网址用；没注入就退回本模块自己探到的（_gitLogBase）。
 *    ⚠ 面板（index.js）走的是它自己那套探活 ⇒ 这个模块自己那份 _gitLogBase 常常是空的，
 *      所以必须由调用方注入 —— 否则拼出来的网址会指着一个没探过的默认名。 */
let _ledgerApiBase = '';
const LEDGER_BOX_ID = 'horae-ledger-diff-table';

export function setChatKey(k) { _ledgerChatKey = String(k || ''); }
export function setStatusPainter(fn) { _ledgerStatusPaint = (typeof fn === 'function') ? fn : (() => { }); }
export function setApiBase(b) { _ledgerApiBase = String(b || ''); }

/* ══ 常量（原值来源：horae.client.js 的行号） ══════════════════════════════════ */

/* 源文件 @196：DEFAULT_SETTINGS.autoSummaryPriceMode = 'auto'。
   本模块拿不到 Horae 的 settings 对象，按任务要求把取值来源换成这个常量
   （后果见 _getPriceMode 里那段注释）。 */
const PRICE_MODE_OVERRIDE = 'auto';

/* 源文件 @30631：PROMPT_OVERHEAD_TOK = 28（串首固定开销）。 */
const PROMPT_OVERHEAD_TOK = 28;
/* 源文件 @30637：TEMPLATE_PER_MSG_TOK = 2（每条消息的角色标记 ＋ 结束符）。 */
const TEMPLATE_PER_MSG_TOK = 2;

/* 源文件 @18532：HORAE_CACHE_PATCH = 'v6.55.0' —— 只出现在逐行的算法标注文案里，
   不参与任何判据（搬过来只为让那一格的字与源文件一致）。 */
/* 源文件 @18532：HORAE_CACHE_PATCH —— ⚠ 名字是历史遗留，**值是 hitOpt 自己的版本**（用户：
 *   "没有HORAE_CACHE_PATCH，我们只有独立插件hitOpt"）。只出现在逐行的算法标注文案里。 */
const HORAE_CACHE_PATCH = 'v7.3.7';

/* 源文件 @13250 / @13251：PANEL_FRESH_MS = 800 与 _panelForceRenderAt = 0。
   后者只由 Horae 抽屉的打开路径写（那个路径没搬）=> 在本模块里它恒为 0
   => _diffFreshAfterPanelShow() 恒为 false（这道闸门恒放行，等于没有）。
   两个常量照搬过来，是为了让那一段逻辑与源文件逐字一致。 */
const PANEL_FRESH_MS = 800;
let _panelForceRenderAt = 0;

/* ══ 价格表常量（源文件 @18441-18446） ══ */
const HORAE_PRICE_TABLE = {
    idle: { label: '空闲', hitIn: 0.02, missIn: 1, out: 4 },
    peak: { label: '高峰', hitIn: 0.04, missIn: 2, out: 8 },
};
const HORAE_OFFPEAK_START = 0.5;   // 北京时间 00:30
const HORAE_OFFPEAK_END = 8.5;     // 北京时间 08:30

/* ══ 取价与折算（源文件 @19605-19623） ══ */
/** 当前时段：自动按北京时间空闲窗口(00:30-08:30)判断。
 *  v6.21.8：面板上那个「按空闲价 / 按高峰价」的手动选择删了（跟着"缓存代价观测"那块一起走），
 *  这里仍认旧配置里的 autoSummaryPriceMode（老存档如果是 idle/peak 就照旧用），没配就是时段自动。 */
/* ⚠ 依赖换来源：源文件这一行（@19608）读的是 Horae 的 settings.autoSummaryPriceMode
   （默认值 'auto' 见源文件 @196）。本模块拿不到那个设置对象，按任务要求把取值来源换成
   常量 PRICE_MODE_OVERRIDE（恒为 'auto'）=> **一律走时段自动**（北京时间 00:30-08:30 = 空闲价），
   不再认用户在 Horae 设置里手选的 idle / peak。
   后果（如实列）：用户手选过时段覆盖时，本模块的单价会与 Horae 面板不一致（可差一倍）。 */
export function _getPriceMode() {
    /* ★ 2026-09-24【唯一的 Horae 依赖，按用户口径收成"读一点变量"】
       源文件这里读的是 Horae 的 settings.autoSummaryPriceMode。用户定版："我们顶多用到一点变量而言"
       ⇒ 这里**只读那一个字段**（读得到就用，用户在 Horae 里手选的 idle/peak 照旧生效；读不到退回时段自动）。
       ⚠ 读一个配置值**不是代码依赖、也不造成副本** —— 与"搬原版函数进来"是两回事。 */
    let mode = PRICE_MODE_OVERRIDE;
    try {
        const v = extension_settings?.horae?.autoSummaryPriceMode;
        if (v === 'idle' || v === 'peak' || v === 'auto') mode = v;
    } catch (_) { /* 读不到就用默认：时段自动 */ }
    if (mode === 'idle' || mode === 'peak') return mode;
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    return (h >= HORAE_OFFPEAK_START && h < HORAE_OFFPEAK_END) ? 'idle' : 'peak';
}

export function _getPrice() {
    const mode = _getPriceMode();
    return { mode, ...HORAE_PRICE_TABLE[mode] };
}

/** tokens → 元（price 单位：元/百万 tokens） */
export function _yuan(tokens, pricePerM) {
    return (Math.max(0, Number(tokens) || 0) / 1000000) * (Number(pricePerM) || 0);
}

/* ══ HTML 转义（源文件 @21490-21494） ══ */
function _wiEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ══ 缓存与失效（源文件 @21637-21647） ══ */
let _diffCache = { rows: [], at: 0, source: '' };
/** ★ v6.24.20：**这张表是按哪一份聊天建的** —— 老代码只作废 at（时间戳），
 *  rows 一直是上一次 build 出来的那些行；一旦"换聊天"这件事没走到重画那一步
 *  （酒馆的 CHAT_CHANGED 在文件还没读好时也会发、事件顺序也不保证），
 *  面板上就会把**上一场聊天的表格**原样留着（用户实测："我打开了新聊天文件 但是还是旧聊天文件的表格
 *  没有刷新，但手动刷新后正常！"）。点「刷新」= force → 重建 → 才对。
 *  ⇒ 把"这表属于哪一场"钉死在数据里，每次渲染前对一遍：对不上就不许显示、当场按现在这场重建。 */
let _diffCacheChatKey = '';
const DIFF_CACHE_MS = 5000;

export function _diffAnalysisInvalidate() { _diffCache.at = 0; }

/* ══ 缓存身份守卫与回退闸门（源文件 @21649-21684） ══ */
/** 这份缓存是不是**现在这场聊天**的（换过聊天 → 一律不算数，哪怕它 5 秒都没过） */
function _diffCacheForThisChat() {
    try { return !!_diffCacheChatKey && _diffCacheChatKey === _gitLogChat(); } catch (_) { return false; }
}
/* ★★★★★★ v6.41.6【新聊天不许带上一场的记忆 —— 用户 2026-09-20 原话："新的聊天 有前世的面板记忆？"】
 *
 *  【病】_gitLogQueryLog 那条回退（v6.24.60 加的，治的是"老聊天刚刷新、chat_metadata 还没读回来
 *    ⇒ 当前 key 是**现场新生成**的 ⇒ /log 查不到 ⇒ 面板一片空白"）。它的做法是：
 *    本场 key 查不到时，拿**上一次真查到过记录的那个 key** 再查一次。
 *    可 **新聊天与那个瞬间在接口上完全同形**：_chatRepoStamp() 在 chat_metadata 里没有 stamp 时
 *    **现场生成一个新 id**（见那个函数），于是两种情况都是"新 id、服务端查不到" ⇒ 都回退。
 *    后果不止是行：_renderDiffAnalysis 还把 servedKey 喂给面板链（_rk = servedKey || _gitLogChat()）
 *    ⇒ 链拿**上一场**的切片重算 ⇒ **本地那几列的数也是上一场的**。
 *
 *  【判据（只用两个已经在手里的数，可证伪）】设
 *      f_max = commits 里最大的 floorGit（那一发发送那一刻 AI 回复落在第几楼）
 *      L     = 当前聊天条数（chatNow.length）
 *    回退来的记录若 **f_max ≥ L** ⇒ 它连"最新一轮"都还没发生在这个聊天里 ⇒ **它不是本场的**。
 *    · 新聊天：L=1~2、上一场 f_max=9 ⇒ 9 ≥ 2 ⇒ **拦** ✓
 *    · 老聊天（已加载完）：L=44、本场 f_max=43 ⇒ 43 < 44 ⇒ **放行** ✓ 行为一字不变
 *    · 老聊天刷新那一瞬间（L=2、还没加载完）：也会被拦 —— **代价不对称，选保守那一边**：
 *      拦错只是少一帧、且如实说"还在加载，点一次刷新就有"；放行则是整场面板（含本地那几列）都是上一场的数。
 *  ⚠ 只在 _servedKey ≠ nowKey（＝这一份真是**别场的 key** 给的）时才可能拦 —— 本场数据永远走不到这里。
 *  ⚠ 抽成独立函数是为了**能被验收真跑**（抠源码里这一个，不在测试里另抄判据）。 */
export function _diffFallbackDrop(commits, chatNow, nowKey) {
    const rows = Array.isArray(commits) ? commits : [];
    const served = String(rows._servedKey || '');
    if (!served || served === String(nowKey || '')) return { drop: false, maxFloor: -1, chatLen: 0, served };
    const chatLen = Array.isArray(chatNow) ? chatNow.length : 0;
    let maxFloor = -1;
    for (const c of rows) {
        const f = Number(c?.floorGit);
        if (Number.isFinite(f) && f > maxFloor) maxFloor = f;
    }
    return { drop: chatLen > 0 && maxFloor >= chatLen, maxFloor, chatLen, served };
}

/* ══ token 写法与断点工具（源文件 @21686-21742） ══ */
/** ★ v6.24.61：**全项目只有这一套 token 写法** —— 精确整数 + 千位分隔，**不做任何 K/M 缩写**。
 *  用户原话："所有缩写样式也可以先删除 因为我知道里面的整数代表Token"。
 *  ⚠ 这里原来有两个缩写函数（_diffFmtK：12.3k；_diffTokCell：12.3K / 1.23M），
 *    它们存在的理由是"怕窄列把 12,341 截成 12,3…"。现在按用户口径**整段删掉**：
 *      · 数字他就是要把每一位看清楚（缩写了他反而要悬停才知道真值，那是本末倒置）；
 *      · 列宽这件事本来就有实测兜底 —— _diffFitColumns 量 scrollWidth > clientWidth，
 *        哪列真被截了就从最后一列（断点位置）让宽给它，不需要靠"少写几个字符"硬撑。
 *    留一条就等于留了第二套口径，违反"一处参数栏只许有一套算法"。 */
export function _diffTok(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    return Math.round(Number(n)).toLocaleString('en-US');
}
/** 这一轮的编号（git 提交里的 turn #N；没有就显示 ?） */
const _diffTurnNo = (row) => (Number.isFinite(Number(row?.turn)) ? Number(row.turn) : '?');
/** 一条块的"人话名字"：角色 + 开头 26 个字（认得出是哪一块，而不是一个看不懂的下标） */
export function _diffName(row) {
    const role = _diffBrkRole[row?.role] || (row?.role ? String(row.role) : '块');
    const head = String(row?.head || '').replace(/\s+/g, ' ').trim();
    if (!head) return `【${role}】`;
    return `【${role}】“${head.slice(0, 26)}${head.length > 26 ? '…' : ''}”`;
}
export function _diffFmtPct(hit, miss) {
    const t = (Number(hit) || 0) + (Number(miss) || 0);
    if (!t) return '—';
    return `${(100 * (Number(hit) || 0) / t).toFixed(1)}%`;
}
/** ★ v6.24.64【用户定版，原话："命中率的红到绿的 0~100 线性 RBG 渐变颜色你给我写好，
 *  现在没颜色提示 我都难看见这个请求到底命中有无问题"】——
 *  「官方命中率」那一格的**文字颜色**：0% = 红 → 100% = 绿，按百分比做 **RGB 线性插值**
 *  （不是分档、不是阈值、不是 HSL —— 就是 t = pct/100 的线性混合）。
 *  端点取面板里已经在用的那对红绿（损伤红 #e07070 = rgb(224,112,112) / 收益绿 #7dd87d = rgb(125,216,125)）：
 *  "纯红 (255,0,0) → 纯绿 (0,255,0)"的线性中点是 (128,128,0)，在这套深底上几乎看不清字，
 *  而这对端点是早前在真浏览器里定过的（对比度 7:1 上下）。
 *  ⚠ 拿不到百分比（官方 usage 还没回来 → 那一格是 —）→ 返回空串 = **不上色**（不猜、不按 0% 涂红）。
 *  ⚠ 这是全表**唯一**给"数值格本体"上色的地方；v6.24.62 那条"统一风格"没有被推翻：
 *    现在颜色一共两个含义，且两个都写在悬停里 —— ① 命中率的**高低**（就这一格）；
 *    ② 每一格第二行的**好坏**（★ v6.24.73 起是"绿 = 收益 / 红 = 损伤"，不再是"正负"）。别的数值格一律白、一律 w400。 */
export function _diffPctColor(pct) {
    // ⚠ Number(null) === 0、Number('') === 0 都是**有限数** —— 这个坑在本项目已经踩到第四次了：
    //   不先把"没有数"这几种写法挡掉，— / null / '' 全都会被当成 **0% 涂成纯红**。
    //   （验收钉子就在 panel_lcp_test ④：_diffPctColor(null) 必须回空串。）
    const s = String(pct === null || pct === undefined ? '' : pct).replace('%', '').trim();
    if (s === '' || s === '—' || s === '-') return '';
    const p = Number(s);
    if (!Number.isFinite(p)) return '';
    const t = Math.max(0, Math.min(100, p)) / 100;
    const mix = (a, b) => Math.round(a + (b - a) * t);
    return `rgb(${mix(224, 125)},${mix(112, 216)},${mix(112, 125)})`;
}
/** ★ v6.24.62：老那个 _diffColor(pct)（≥60% 绿 / ≥30% 黄 / 否则红 ＋ font-weight:600）
 *  已**整段删掉**，谁也别再加回来。当时删它的理由 —— 用户原话："单元格的数值渲染 统一风格啊
 *  有些有颜色 有些没有"：同一张表里只有「官方命中率」「本地合计」两格的数字会变色＋加粗，
 *  别的数值格永远白、永远 w400，看着就是两套风格。
 *  ★ v6.24.64：用户点名要的**是命中率这一格的连续渐变**（见上面 _diffPctColor）——
 *  它是"从 0 到 100 一根轴上的位置"，跟老那种"三档拍脑袋的阈值色"不是一回事；
 *  而且**不许再带 font-weight**（加粗是用户明确骂过的那半条）。 */
const _diffBrkRole = { system: '系统块', user: '用户消息', assistant: 'AI 回复' };

/* ══ 断点坐标（第几楼/在哪/片段/标签）（源文件 @21744-21836） ══ */
/** 断点**那一条自己**是聊天里的第几楼；认不出就 null（绝不编一个数）。
 *  ① 运行记录的 f —— 发送那一刻拿全文跟活聊天认出来的（最准）；
 *  ② 拿这一条的开头跟活聊天对（面板侧只剩首 80 字，认法跟发送时同一套"唯一命中"）；
 *  ③ 最新一句玩家输入在提示词里常被套一层标签（用户的预设是 <最新互动> …），
 *     削掉头一个标签再认一次 —— 不削就永远认不出它是楼层。 */
export function _diffBreakItemFloor(info, i) {
    const it = Array.isArray(info.items) ? info.items[i] : null;
    if (!it) return null;
    const ctx = info.planCtx || null;
    const own = _diffItemFloor(it, ctx);
    if (own !== null) return own;
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    if (!chat.length) return null;
    const head = String(it.head || '');
    const cut = head.replace(/^\s*<[^>\n]{1,24}>\s*/, '');
    if (cut === head || cut.length < 8) return null;
    return _floorOfPromptText(cut, chat);
}

/** 断点落在**酒馆界面里的第几楼**（这一列只说这一件事，所以给个能对上界面的坐标）
 *  返回 { f, exact }；exact=false 时**整个坐标都标 ≈**（≈ 放在"聊天"前面：≈聊天 #17（…），
 *  用户实测定版：写在数字前面「聊天 ≈#17」看着很怪）。
 *  ★ v6.21.6 修掉的坑：以前只有一条路 —— 按"断点后面还剩几条"往回数。可是请求尾巴上那一串
 *    （状态快照 / 指针 / 预设块）**不是聊天楼层**却被当成楼层数，一数就爆到 0 再被夹成 1
 *    （用户实测：换了聊天之后整列全是 聊天 #1，而真实断点在第 7 楼）。
 *    现在三级：认得出断点这条是哪一楼 → 说准的；认不出 → 拿**离它最近、认得出楼层的**那条当锚；
 *    都认不出 → 才退回老估算，而估算落到 1 以下就**不给楼层**（宁可只报"是什么内容"，也不编）。
 *  猜与不猜的分界：exact=false 就一定会带 ≈，用户一眼看得出哪个是估的。 */
export function _diffBreakFloor(info) {
    const bi = Number.isFinite(Number(info.lcpItem)) ? Number(info.lcpItem)
        : (Number.isFinite(Number(info.d?.breakIdx)) ? Number(info.d.breakIdx) : -1);
    if (!(bi >= 0)) return null;
    const n = Array.isArray(info.items) ? info.items.length : 0;
    // ① 断点这一条本身就是聊天里的一条 → 直接给它的楼层（准，不打 ≈）
    const own = _diffBreakItemFloor(info, bi);
    if (own !== null) return { f: Math.max(0, own), exact: true };
    // ② 断点落在"不是聊天楼层"的块上（注入 / 指针 / 快照）→ 用前后最近的、认得出楼层的那条当锚：
    //    请求里聊天楼层是**按聊天顺序**排的，所以往后找一条 = 断点在它上一楼之后；往前找一条 = 正好在它之后
    for (let d = 1; d < n; d++) {
        if (bi + d < n) {
            const fa = _diffBreakItemFloor(info, bi + d);
            if (fa !== null) return { f: Math.max(0, fa - 1), exact: false };
        }
        if (bi - d >= 0) {
            const fb = _diffBreakItemFloor(info, bi - d);
            if (fb !== null) return { f: Math.max(0, fb), exact: false };
        }
    }
    // ③ 整串请求里一条聊天楼层都没认出来（正文被正则改写过等）→ 退回老估算；估算落到 1 以下
    //    说明这一套前提已经不成立（尾巴那串块不是楼层），那就**不给楼层**
    const f = Number(info.floor);
    if (Number.isFinite(f) && f > 0) {
        const after = n ? Math.max(0, n - 1 - bi) : 0;
        const est = f - 1 - after;
        if (est >= 1) return { f: est, exact: (Number(info.newFrom) === bi) || after === 0 };
    }
    return null;
}
/** 断点的短坐标（不再重复"断点"两个字，列标题已经说了）：
 *  聊天 #34（#58 user）；估算时 ≈聊天 #30（#22 assistant） */
export function _diffBreakWhere(info) {
    const bi = Number.isFinite(Number(info.lcpItem)) ? Number(info.lcpItem)
        : (Number.isFinite(Number(info.d?.breakIdx)) ? Number(info.d.breakIdx) : -1);
    if (!(bi >= 0)) return '';
    const role = String(info.lcpRole || info.items?.[bi]?.role || info.dCur?.role || '');
    const roleTxt = role === 'system' ? '系统块' : (role || '块');
    const fl = _diffBreakFloor(info);
    if (!fl) return '';
    return `${fl.exact ? '' : '≈'}聊天 #${fl.f}（#${bi} ${roleTxt}）`;
}
/** 断点附近的原文（很短，就一小截）：变了就给"上一轮 → 这一轮"，没变就给这一轮的 */
export function _diffBreakSnippet(info) {
    const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const bi = Number.isFinite(Number(info.lcpItem)) ? Number(info.lcpItem)
        : (Number.isFinite(Number(info.d?.breakIdx)) ? Number(info.d.breakIdx) : -1);
    const it = (Array.isArray(info.items) && bi >= 0) ? info.items[bi] : null;
    const cur = clip(it?.head || info.dCur?.head, 15);
    const prev = clip(info.dPrev?.head, 15);
    if (cur && prev && cur !== prev) return `「${prev}…」→「${cur}…」`;
    return cur ? `「${cur}…」` : (prev ? `「${prev}…」` : '');
}
/** 一句话的断点结论（短标签，越短越好） */
export function _diffBreakTag(kind) {
    switch (kind) {
        case 'ideal': return '纯追加';
        case 'oldchurn': return '★ 老内容被改写';
        case 'incr': return '正常增量';
        case 'moved': return '被挪了位置';
        case 'churn': return '有块每轮在变';
        case 'shrunk': return '前缀被挤掉';
        default: return '断点';
    }
}

/* ══ 断点说明（源文件 @21838-22002） ══ */
/**
 * 断点说明（**v6.21 简化版**：这一列只回答两件事 —— 断点在哪一楼、断点附近是什么内容。
 * 详细的逐行差异点每行的「差异↗」看，计价说明看概述行末尾「替换费用」那个数的悬停）
 *   · text   —— 显示在表格里的短句
 *   · detail —— 悬停时给的完整说明（原来的长文原样留着，不丢信息）
 * 事实来源：官方 usage（权威）+ 逐条比对上一轮真实 request（推断处会写明「推断」）。
 */
export function _diffBreakReason(info) {
    const d = info.d;
    const full = Number.isFinite(info.mustFull) ? info.mustFull : 0;
    const price = full > 0 ? `；它和它后面共 ${_diffTok(full)} tok 按未命中（全价）计费` : '';
    const at = _diffBreakWhere(info);
    const snip = _diffBreakSnippet(info);
    /* ★★★★★★ v6.51.6【★ 白付（漂移税）—— 面板第一次能回答"这一轮贵，是因为我写了新东西，还是前缀被撞断了"】
     *  用户 2026-09-22 问的就是这件事（原话"钱到底花在哪一轮"）。判据与算法全在服务端 taxOfTurns
     *  （在这两份盘上正文上现算，与 lcp 同一对文件）—— 客户端**一个字都不自己算**，只负责显示。
     *  ⚠ 三态必须分清：null（算不出，如实说）｜0（断点后没有旧内容，已在账单下界）｜>0（白付了这么多）。
     *    把 null 显示成 0 就是"面板自我冲突"的老毛病，这一格专门不犯。 */
    const _tax = Number(info.taxChars);
    const _taxOk = (info.taxChars !== null && info.taxChars !== undefined && Number.isFinite(_tax));
    const taxTxt = (_taxOk && _tax > 0) ? `；白付 ${_tax.toLocaleString('en-US')} 字` : '';
    const taxLine = !_taxOk ? ''
        : (_tax > 0
            ? `\n【本轮白付（漂移税）】${_tax.toLocaleString('en-US')} 字`
                + ` —— 这些内容是上一轮就发过、一个字都没变的，只因为断点落在它们前面，`
                + `就跟着按未命中（全价）重付了一遍。它不是"这一轮新写的东西"（那部分该付、是下界），`
                + `而是纯粹被前缀断裂挤出去的钱。`
            : `\n【本轮白付（漂移税）】0 字 —— 断点之后没有一行是上一轮发过的`
                + `（这一轮付的全是真新增，已经到这份账单的下界了）。`);
    const short = (kind, extra = '') => `${at || ''}${snip ? `${at ? '：' : ''}${snip}` : ''}${extra}${taxTxt}｜${_diffBreakTag(kind)}`;
    if (info.first) {
        const h = Number(info.hit) || 0;
        return {
            kind: 'first',
            text: h > 0 ? `本聊天第一次请求（前 ${_diffTok(h)} tok 是更早的请求缓存下来的）` : '本聊天第一次请求：整段全价（第一轮都这样）',
            detail: h > 0
                ? `本聊天第一次请求。官方命中 ${_diffTok(h)} tok —— 这段前缀在更早的请求里就已经缓存过（角色卡/世界书是共用的），不是这一轮省下来的`
                : '本聊天第一次请求，没有可命中的前缀（整段全价，第一轮都这样）',
        };
    }
    // ══ ★ v6.24.51（用户定版 2026/9/17）：**断点位置以「官方命中」为准 —— 官方是权威** ══════════
    //   用户原话："断点位置：用「官方命中」作为推断 —— 官方是权威；本地瞎写的自嗨没用" ＋
    //             "官方值回来时：官方命中 = usage.prompt_cache_hit_tokens；官方没回来 → 写「官方 usage 还没回来」，
    //              不许填本地数当结论。"
    //   ⇒ 这个顺序是**硬要求**：官方那一段必须排在"本地实测断点"那一段**前面**。
    //     （v6.24.50 写反了：本地那段先 return，于是只要记录抬头带 | lcp …，这一格讲的就成了本地推算 ——
    //       正是用户点名不许的那件事。这里已经把它挪到官方后面，并且本地那段只在官方缺位时出现。）
    //   怎么推：官方命中 h（tok）先折回字（拿**官方自己的** prompt_tokens ÷ 这一轮总字数，不用本地字数比），
    //           再用**记录服务给的逐条字数**（itemChars）说出这个字位置落在第几条上、离那条开头多远 ——
    //           本地这里只干"定位落在哪一条上"这一件事，**数字本身是官方的**。
    const scene = _diffChangeScene(info);      // v6.12：到底哪儿变了（现场片段对比）
    // v6.12：断点那条是"老内容被改"还是"这一轮新增/移位" —— 一句话回答"这次断得正常吗"。
    //   判据用的是**两轮真实请求里的那一条本身**（同角色 + 开头逐字相同 + 内容变了 = 老内容被改写）；
    //   断点正好落在上一轮末尾 = 纯追加（最理想）。
    const verdict = (brkIdx) => {
        const pureAppend = Number.isFinite(Number(info.breakAtPrevEnd)) && Number(info.breakAtPrevEnd) >= 0
            && brkIdx >= Number(info.breakAtPrevEnd);
        if (pureAppend) return { kind: 'ideal', text: `→ 断点正好落在上一轮末尾 → 纯追加（最理想：旧内容一条没动，只有新内容要全价）` };
        if (info.churned) return { kind: 'oldchurn', text: `→ ★ 断点落在"老内容"上，不是新增内容的位置：这一条上一轮就有、开头一模一样，只是内容变了 → 缓存是在老内容上被改掉的` };
        return { kind: 'incr', text: `→ 断点落在这一轮新增/移位的第一条 → 正常的增量断点（不是被老内容改写弄的）` };
    };
    // ⚠ 判据里的 Number.isFinite **必须排在 null 判断之后**：Number(null) === 0 是有限数，
    //   光看 isFinite 会把"官方 usage 还没回来"（hit = null）当成"官方命中 0 tok"，
    //   于是那一格会拿 0 当官方结论说事（用户定版里明令不许）。
    const hasOff = (info.hasUsage === true) && info.hit !== null && info.hit !== undefined;
    const offHitTok = hasOff && Number.isFinite(Number(info.hit)) ? Math.max(0, Number(info.hit)) : null;
    const offPromptTok = (info.offPrompt !== null && info.offPrompt !== undefined && Number.isFinite(Number(info.offPrompt)))
        ? Number(info.offPrompt) : null;
    const offMissTok = (offHitTok !== null && offPromptTok !== null) ? Math.max(0, offPromptTok - offHitTok) : null;
    const offCharPerTok = (offPromptTok > 0 && Number.isFinite(Number(info.myCharTotal)) && Number(info.myCharTotal) > 0)
        ? Number(info.myCharTotal) / offPromptTok : null;          // 官方那一轮自己的"字/token"
    const offHitChars = (offHitTok !== null && offCharPerTok !== null) ? Math.round(offHitTok * offCharPerTok) : null;
    // 官方命中那个字位置落在第几条：只拿**记录服务给的那份逐条字数**（itemChars）累加，不做任何估算。
    //  ⚠ v6.24.50 这里读的是 info.items[i].content —— 而面板手里那些逐条明细**只有 head/tail**
    //    （整份正文不进 /log 响应），于是每条长度恒为 0、定位全错。现在改成服务端数好的 itemChars。
    const charLens = Array.isArray(info.itemChars) ? info.itemChars.map(n => Number(n) || 0) : null;
    const offHitItem = (offHitChars !== null && charLens && charLens.length)
        ? (() => {
            // 逐条累加（每条之间那一个 \n 也算进去 —— 与总长、与 lcp 同一个拼串口径），
            // 找出官方命中的字位置落在哪一条内。只做定位，不做任何估算。
            let at = 0;
            for (let i = 0; i < charLens.length; i++) {
                if (offHitChars <= at + charLens[i]) return { i, into: Math.max(0, offHitChars - at), len: charLens[i] };
                at += charLens[i] + 1;
            }
            return null;
        })()
        : null;
    const offRole = offHitItem ? String(info.items?.[offHitItem.i]?.role || '') : '';
    const offWhere = (offHitItem ? `第 ${offHitItem.i} 条${offRole ? `（${offRole}）` : ''}` : (offHitChars !== null ? '第 1 条之前' : ''));
    const offBasis = (offHitItem && offHitChars !== null)
        ? `官方命中 ${_diffTok(offHitTok)} tok`
            + `（官方 prompt ${_diffTok(offPromptTok)} tok 折回字 ≈ ${Math.round(offHitChars).toLocaleString('en-US')} 字，`
            + `按这一轮自己的字/token 比 ${offCharPerTok.toFixed(3)} 折算）`
            + ` → 落在「${offWhere}」的第 ${offHitItem.into.toLocaleString('en-US')} 字处`
        : `官方命中 ${offHitTok === null ? '—' : `${_diffTok(offHitTok)} tok`}`
            + `（这一轮没有可比对的总字数，推不出落在第几条 → 只报官方数，不编位置）`;
    // 官方断点推出来的那一条，当判词（正常增量 / 纯追加 / 老内容被改写）用的坐标
    const verdictIdx = offHitItem ? offHitItem.i : (d && Number.isFinite(Number(d.breakIdx)) ? Number(d.breakIdx) : -1);
    const vOff = verdict(verdictIdx);
    // ── 本地那一段（**只用来定位落在哪一条上，数字不是它**）：唯一入口给的字口径读数 ──
    const myLoc = (info.myCharLcp !== null && info.myCharLcp !== undefined && Number.isFinite(Number(info.myCharLcp)))
        ? `公共前缀 ${Number(info.myCharLcp).toLocaleString('en-US')} 字`
            + (Number.isFinite(Number(info.lcpItem)) && Number(info.lcpItem) >= 0
                ? ` → 落在第 ${Number(info.lcpItem)} 条${info.lcpRole ? `（${info.lcpRole}）` : ''}` : '')
            + (Number.isFinite(Number(info.myCharTotal)) ? `；这一轮合计 ${Number(info.myCharTotal).toLocaleString('en-US')} 字`
                + `，未命中 ${Number(info.myCharMiss).toLocaleString('en-US')} 字` : '')
        : '';
    if (offHitTok !== null) {
        return {
            kind: (offHitTok <= 0 ? 'oldchurn' : vOff.kind),
            text: short(vOff.kind),
            detail: `【官方断点（权威）】${offBasis}`
                + (offMissTok !== null ? `；官方未命中 ${_diffTok(offMissTok)} tok（= 官方 prompt − 官方命中），它和它后面按全价计费` : '')
                + `。判据：官方 usage 的 prompt_cache_hit_tokens —— 官方说命中到哪里，缓存就从哪里往后作废`
                + (vOff.text ? `。${vOff.text}` : '')
                + (scene ? `。${scene}` : '')
                + taxLine
                + `\n【本地推算（只用来定位落在哪一条上，数字不是它）】`
                + (myLoc || '这一轮记录里还没有可比的两份正文（第一轮 / 服务端还是旧模块）→ 只能报官方数')
                + `。本地推算 = 把这一轮与上一轮的记录正文逐字节比出来的公共前缀（服务端算好给面板，`
                + `与 node check/prefix_test.mjs 打印的三个数逐位相同）；官方按 64 token 块向下取整、`
                + `且缓存里任何一条更早的 request 的前缀都算命中，所以本地这个数天然 ≤ 官方那一段`,
        };
    }
    if (info.hasUsage === false || offHitTok === null) {
        // ★ 官方 usage 还没回来 → 不许拿本地数当结论（用户定版）。这一格如实说"还没回来"，
        //   本地推算只在悬停里报（写明它是本地推算、不是结论）。
        return {
            kind: 'na',
            text: '官方 usage 还没回来｜断点位置等官方出账',
            detail: '官方 usage 还没回来（这一轮刚发出去、回复还在流式生成）→ 断点位置以官方命中为准，现在还没有官方数。'
                + (myLoc
                    ? `\n【本地推算（不是结论）】${myLoc}`
                        + `。它只是"跟上一轮逐字节比"的结果，官方一回来就以官方为准`
                    : '\n这一轮记录里也没有可比的两份正文（第一轮 / 服务端还是旧模块）→ 本地连推算都没有'),
        };
    }
    if (!d) {
        return {
            kind: 'na',
            text: '没有上一轮的逐条记录 →「本地」给不了（官方数值照看）',
            detail: '没有上一轮的逐条记录（本聊天的运行记录是这次页面加载之后才开始的）→「本地」三列给不了，官方数值照看',
        };
    }
    if (d.breakIdx < 0) {
        return { kind: 'same', text: '两轮逐条一模一样（命中率本该接近 100%）', detail: '两轮请求逐条一模一样 → 官方命中率本该接近 100%' };
    }
    // ── 走到这里只可能是"官方 usage 在、但上面那两支都没接住"的极端情形 —— 如实说，不编 ──
    //  （v6.24.50 及更早那几支"本地推算当结论"的老路已按用户定版整段删掉：
    //    ① 「实测断点（抬头里那段 | lcp …）先说」—— 它量的是客户端还原/后置之前那串字，
    //       与真出网那份字不是同一串（实测 2026/9/17：抬头 9,926 字 vs 两份真记录逐字节比 4 字），
    //       而它当时还排在官方那一段前面 ⇒ 直接违反"官方是权威"；
    //    ② 「按逐条首尾指纹推」那几支（changed / moved / shrunk / churn / normal / other）——
    //       同一件事的第三套算法。
    //   现在断点位置只有一条路：官方命中折回字 → 落在第几条；本地公共前缀只用来定位。） 
    return {
        kind: 'na',
        text: '断点位置给不了（记录里没有可比的两份正文）',
        detail: '这一轮没有可比对的上一轮正文 →「本地」那三个字和断点位置都给不了。'
            + '两种常见原因：① 记录服务版本旧了（它还没把两份正文比过）——'
            + '重启一次酒馆就补齐（服务端只在启动时加载）；② 上一轮的记录正文不在（被清过 / 太久了）。'
            + '官方那三列照旧是权威读数（它们不依赖本地比对）。',
    };
}

/* ══ 时间戳（源文件 @22004-22009） ══ */
/** 时间戳 → HH:MM:SS（没时间就给空串，绝不编一个时间） */
export function _diffClock(ts) {
    const n = Number(ts) || 0;
    if (n <= 0) return '';
    try { return new Date(n).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return ''; }
}

/* ══ 钱：¥ 写法/方案标签/一次请求的价（源文件 @22011-22060） ══ */
/* ══════════════════════════════════════════════════════════════════════
 * ── v6.11：两列钱 ——「费用」与「替换费用」（全部本地算，不调 AI、不猜）────
 *   v6.24.2 起「替换费用」**不再单占一列**（用户："删除替换费用列"）：表里只剩「费用」那一列，
 *   替换那一笔在**概述行末尾**只给一个数 —— 盈亏（绿 − 省 / 红 + 多付，见 _diffStatusHtml）。
 *   下面这一整段算法照旧（每一行都还在算 plan），只是不再逐行铺在表面上：逐项账在悬停里。
 *
 *   费用     = 命中 × 命中单价 ＋ 未命中 × 全价 ＋ 输出 × 输出单价
 *              命中/未命中优先用**官方 usage**（权威值）；还没有官方值时用「本地」那一列并标明。
 *   替换费用 = 把这一轮**真实请求**里「本地总结能替代的正文」换成摘要行之后，重新数一遍
 *              请求 token / 命中 / 未命中，再用同一套单价折成钱。
 *
 * 替换方案只认本地已经存在的东西（缺哪样就不算哪样，绝不虚构一段"假如压了"的正文）：
 *   · 摘要 L1~LN —— 活跃摘要已经覆盖、但正文还在请求里的那些楼（token 是**实测**的）
 *   · 合并       —— 同层摘要上卷成更高层（注入行省下来的部分）；轨迹瘦身没开时的那一笔
 *   · 注入       —— 替代之后摘要卡开始注入（本地按卡片文字算）／掉出注入的轨迹行
 *   · 候选摘要   —— 本地还没有摘要覆盖这些楼，但按本地规则（有事件、保留最近 N 层 AI）可压的正文
 *
 * 替换后的命中怎么算（这是"费用会变成多少"的关键）：
 *   缓存从**最早被替换的那一条**起断开 —— 那一条的内容变了，它后面整串都没得命中（这一次要重算）；
 *   被替换的部分本来就落在「每轮全价区」里时，命中不受影响，省的就是纯钱。
 *   之后每一轮，替换后的布局自己又成了稳定前缀，所以还要报"稳态每轮省/多付多少"。
 * ══════════════════════════════════════════════════════════════════════ */
const DIFF_LINE_OVERHEAD = 14;   // 与 _injectedTimelineTokens 同口径：一行轨迹的固定开销

/** ¥ 的紧凑写法（列里用；单轮的钱常常小于 1 分，四位小数才看得见差别） */
export function _diffYuan(v) {
    const n = Math.max(0, Number(v) || 0);
    if (n <= 0) return '¥0';
    if (n < 0.00005) return '<¥0.0001';
    if (n < 1) return '¥' + n.toFixed(4);
    return '¥' + n.toFixed(2);
}

/** 方案种类的短标签（格子窄，只有 70px 上下） */
export function _diffKindShort(kind) {
    const s = String(kind || '');
    if (s.startsWith('候选')) return '候选';
    if (/^摘要L\d+$/.test(s)) return s;
    if (s.startsWith('合并L')) return s.replace('→', '→');
    if (s.includes('轨迹')) return '轨迹合并';
    return s.slice(0, 4);
}

/** 一次请求的钱：命中×命中价 ＋ 未命中×全价 ＋ 输出×输出价（单价随空闲/高峰时段） */
export function _diffCostOf(hit, miss, out, price) {
    const p = price || _getPrice();
    const input = _yuan(hit, p.hitIn) + _yuan(miss, p.missIn);
    const output = _yuan(out, p.out);
    return { input, output, total: input + output, price: p };
}

/* ══ 逐条楼层（源文件 @22062-22090） ══ */
/** 这一轮请求逐条的「聊天楼层」：v6.11 记录里直接带着（f）；老记录用内容哈希/正文回推。
 *  逐级匹配、**每一级都要求唯一命中** —— 发送前正文常被正则改写（实测：AI 楼开头的"好的，这是你
 *  需求的最终输出："被削掉），所以除了前缀，还要试"包含"和"结尾"。多个候选就对不上了 → 宁可返回
 *  null（那一楼不算进替换方案），也不认错楼层。 */
export function _diffItemFloor(it, ctx) {
    if (!it) return null;
    const raw = it.f;
    if (raw !== null && raw !== undefined && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    if (!chat.length) return null;
    if (it.h !== undefined && it.h !== null && ctx?.hashToFloor?.has(it.h)) return ctx.hashToFloor.get(it.h);
    const norm = Array.isArray(ctx?.normText) ? ctx.normText : [];
    const head = String(it.head || '').replace(/\s+/g, ' ').trim();
    const tail = String(it.tail || '').replace(/\s+/g, ' ').trim();
    const pick = (pred) => {
        let hit = null;
        for (let i = 0; i < norm.length; i++) {
            if (!norm[i] || !pred(norm[i])) continue;
            if (hit !== null) return null;      // 不止一个候选 → 不认
            hit = i;
        }
        return hit;
    };
    const h48 = head.slice(0, 48), h32 = head.slice(0, 32), t24 = tail.slice(-24);
    if (h48.length >= 8) { const v = pick(x => x.startsWith(h48)); if (v !== null) return v; }
    if (h32.length >= 12) { const v = pick(x => x.includes(h32)); if (v !== null) return v; }
    if (t24.length >= 12) { const v = pick(x => x.endsWith(t24)); if (v !== null) return v; }
    return null;
}

/* ══ 按全文认楼层（源文件 @22092-22112） ══ */
/** 发送那一刻用**全文**认楼层（比面板侧的首尾片段强）：同文 → 前缀 → 包含，逐级唯一命中才算 */
export function _floorOfPromptText(text, chatArr) {
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

/* ══ 当前聊天（源文件 @22153-22159） ══ */
/** 现在这份聊天（读不到就给空数组）—— 差异分析页到处要用同一份读法 */
function _diffChatNow() {
    try {
        const c = getContext()?.chat;
        return Array.isArray(c) ? c : [];
    } catch (_) { return []; }
}

/* ══ 命令块名与"谁删的"（源文件 @22680-22756） ══ */
/** 从一个片段里认出"命令块"的名字：<UpdateVariable> / <JSONPatch> / <horae> … 认不出给空串。
 *  先认已知的命令块名（外层那个更有说明力：<UpdateVariable> 里面才是 <JSONPatch>），再退回通用标签。 */
const _DIFF_KNOWN_BLOCKS = ['UpdateVariable', 'JSONPatch', 'Analysis', 'StatusPlaceHolderImpl', '最新互动', 'SUOT', 'horae', 'horaeevent', 'horaerpg', 'think'];
function _diffBlockName(snippet) {
    const s = String(snippet || '');
    for (const name of _DIFF_KNOWN_BLOCKS) {
        if (new RegExp(`<\\s*/?\\s*${name}\\b`, 'i').test(s)) return `<${name}>`;
    }
    const m = /<\s*\/?\s*([A-Za-z_][\w.:-]{1,40})\s*[>/]/.exec(s);
    if (!m) return '';
    const name = m[1];
    if (/^(br|p|div|span|b|i|em|strong|img|a|li|ul|ol|hr)$/i.test(name)) return '';
    return `<${name}>`;
}

/** v6.13：断点落在"老内容"上时，**点名到底是谁在发送前动的手**。
 *
 *  扫 ST 的正则脚本（全局 extensionSettings.regex + 当前角色卡内嵌 data.extensions.regex_scripts），
 *  找那种「删掉我们认出来的那个命令块」**并且带最小/最大深度限定**的规则 —— 这类规则的作用范围
 *  随"楼龄"滑动（只留最近几楼），于是**同一条回复的文本会在发送时变一次**：
 *  刚生成那两轮还带着块，楼一老就被删掉 ⇒ 缓存前缀每轮正好在它那里断。
 *
 *  没有深度限定的规则（每条楼一视同仁）不会造成这种"每轮改一次"，直接跳过。
 *  纯只读、带 try/catch，拿不到上下文就返回 null，不影响任何既有逻辑。 */
let _diffBlameCache = { key: '', at: 0, val: null };
function _diffBlameRegex(blockName) {
    try {
        const bare = String(blockName || '').replace(/[<>]/g, '').trim();
        if (!bare) return null;
        // ⚠ 依赖换来源：源文件这里读 globalThis.SillyTavern?.getContext?.()，
        //   本模块改成酒馆自己的模块 API（文件头 import 的那个 getContext）。
        const ctx = getContext();
        if (!ctx) return null;
        const ch = (ctx.characters || [])[Number(ctx.this_chid)];
        const key = `${bare}|${ctx.this_chid}|${ch?.avatar || ''}`;
        const now = Date.now();
        if (_diffBlameCache.key === key && (now - _diffBlameCache.at) < 10000) return _diffBlameCache.val;
        const lists = [];
        const glob = ctx.extensionSettings?.regex;
        if (Array.isArray(glob)) for (const r of glob) lists.push({ r, src: '正则脚本' });
        const allowed = ctx.extensionSettings?.character_allowed_regex;
        const cardOn = !Array.isArray(allowed) || !ch?.avatar || allowed.includes(ch.avatar);
        if (cardOn) {
            const cr = ch?.data?.extensions?.regex_scripts;
            const arr = Array.isArray(cr) ? cr : (Array.isArray(cr?.scripts) ? cr.scripts : []);
            for (const r of arr) lists.push({ r, src: '卡内正则' });
        }
        const hit = new RegExp(bare, 'i');
        let best = null;
        for (const { r, src } of lists) {
            if (!r || r.disabled) continue;
            const find = String(r.findRegex || r.find || '');
            if (!find || !hit.test(find)) continue;
            const mdRaw = r.minDepth, xdRaw = r.maxDepth;      // ★ null 不能当 0 用（Number(null) === 0 会把"没限定"误判成"限定 0"）
            const hasNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
            const hasMin = hasNum(mdRaw) && Number(mdRaw) > 0;
            const hasMax = hasNum(xdRaw) && Number(xdRaw) >= 0;
            if (!hasMin && !hasMax) continue;       // 无深度限定 → 楼楼一样 → 不会每轮改一次
            const item = {
                where: src, name: r.scriptName || r.name || '(无名)',
                depth: hasMin ? `最小深度 ${Number(mdRaw)}` : `最大深度 ${Number(xdRaw)}`,
                promptOnly: !!r.promptOnly, minDepth: mdRaw, maxDepth: xdRaw,
                score: (hasMin ? 2 : 0) + (r.promptOnly ? 1 : 0),
            };
            if (!best || item.score > best.score) best = item;
        }
        _diffBlameCache = { key, at: now, val: best };
        return best;
    } catch (_) { return null; }
}

/** 把"谁删的"拼成一句话（查不到就说清是哪一类机制，别乱指认）。 */
function _diffBlameText(blockName) {
    const b = _diffBlameRegex(blockName);
    if (!b) return '（是外部的正则/扩展在发送前删的：带"最小深度"、只留最近几楼那种规则）';
    return `（动手的是${b.where === '卡内正则' ? '这张卡自己的正则' : '正则脚本'}「${b.name}」，`
        + `${b.depth}${b.promptOnly ? '、只作用发送内容' : ''} —— 它按楼龄只留最近几楼，`
        + `所以同一条回复的文本在发送时会变一次，缓存前缀每轮就在这儿断）`;
}

/* ══ 断点现场（源文件 @22758-22796） ══ */
/** 断点现场的人话：**说清到底哪儿变了 + 是谁动的**（这一句就是"分析"里最该有的东西）
 *  · 有实测断点（lcp）时：用发送那一刻记下的两段现场文字（上一轮 / 这一轮各 70 字）比。
 *  · 只有 git 明细（刷新过）时：用两轮同一条的**首/尾片段**比 —— 头一样、尾不同 = 结尾被削了一段。
 *  认得出来就点名是哪个块，并顺着块名把"动手的那条正则"揪出来（Horae 自己从不碰这些块）。 */
function _diffChangeScene(info) {
    const L = info.lcp;
    const parts = [];
    const nameOf = (s) => _diffBlockName(s);
    if (L && (L.prevHead || L.nextHead)) {
        const prev = String(L.prevHead || '').slice(0, 46);
        const next = String(L.nextHead || '').slice(0, 46);
        const bn = nameOf(prev && prev.startsWith('<') ? prev : '');
        if (prev && next) {
            parts.push(`分歧处：上一轮这里是「${prev}」，这一轮这里是「${next}」`);
            if (bn && !next.startsWith('<')) {
                parts.push(`→ 上一轮那一段 ${bn} 命令块在这一轮没了${_diffBlameText(bn)}`);
            }
        } else if (prev && !next) {
            parts.push(`上一轮在断点后还有「${prev}」，这一轮到这里就结束了`);
        } else if (!prev && next) {
            parts.push(`这一轮在断点后多了「${next}」`);
        }
        return parts.join('；');
    }
    // git 明细：比同一条的首/尾片段
    const row = info.dPrev, rowNow = info.dCur;
    if (!row || !rowNow) return '';
    const hSame = String(row.head || '').slice(0, 40) === String(rowNow.head || '').slice(0, 40);
    const tSame = String(row.tail || '') === String(rowNow.tail || '');
    if (hSame && !tSame) {
        const bn = nameOf(row.tail);
        parts.push(`这条的结尾被削掉了一段：上一轮结尾是「…${String(row.tail || '').slice(-40)}」，`
            + `这一轮结尾是「…${String(rowNow.tail || '').slice(-40)}」`);
        if (bn) parts.push(`→ 少掉的是 ${bn} 那段${_diffBlameText(bn)}`);
    } else if (!hSame) {
        parts.push(`这条的开头就不同了：上一轮「${String(row.head || '').slice(0, 32)}」／这一轮「${String(rowNow.head || '').slice(0, 32)}」`);
    }
    return parts.join('；');
}

/* ══ 本地三列的唯一入口（源文件 @22798-22852） ══ */
/**
 * ★ v6.24.51（用户定版 2026/9/17）：**「本地」三列只有这一个入口。**
 *
 * 口径（用户原话："多处相同的参数栏不许有两套算法 —— 全项目只留一个 lcp 入口"）：
 *     lcp   = 这一轮真发出去的字 与 上一轮真发出去的字 逐字节相同的开头长度（字）
 *     miss  = 这一轮总长 − lcp
 *     合计   = lcp + miss = 这一轮总长
 *
 * 三个数**在记录服务里算好**（index.mjs 的 lcpOfTurns：拿两轮 turns/NNNNN.txt 的正文
 * 逐字节比 —— 与 check/prefix_test.mjs 的 readTurn + lcpOf 逐字同一个读法），
 * 由 /log 每轮给：lcpChars / missChars / totalChars（都是**字**）。
 * **面板一个字都不算**，只把这三个数摆上去 —— 于是"网页表格三列 == prefix_test 打印的
 * lcp / miss / lcp+miss、逐位相同"这条验收由构造保证。
 *
 * ⚠ 为什么不读记录抬头里那段 | lcp …（那是客户端发送那一刻量的）：它量的是**客户端自己手里
 *   那串字**（历史还原／变量块后置**之前**的预演快照），与真出网那份字不是同一串 ——
 *   实测（2026/9/17 圣樱学院_mu4y2xeo6lmz #1）：抬头写 9,926 字，两份真记录逐字节比只有 4 字。
 *   官方 usage 也是按真发出去的那份字算的，所以面板一律以**记录**为准；抬头那段留在记录里当留档。
 *   同一条纪律：_lcpStore*（本地留档）与"逐条 token 求和"那两条后路**整段删掉**，一个都不留。
 *
 * @param {{lcpChars?:number, missChars?:number, totalChars?:number, chars?:number, charHead?:number,
 *          itemChars?:number[], lcpItem?:number, lcpRole?:string, lcpSrc?:string, tok?:number, srcWire?:string}} c
 * @returns {{chars:number|null, missChars:number|null, totalChars:number|null, item:number|null, role:string,
 *            itemChars:number[]|null, charsBody:number|null, charHead:number|null, src:string,
 *            srcWire:string, available:boolean}}
 */
function _diffPanelLcp(c) {
    const o = (c && typeof c === 'object') ? c : {};
    const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
    const lcpChars = num(o.lcpChars);        // lcp（字）—— 两份记录正文的公共前缀
    const missChars = num(o.missChars);      // miss（字）—— 这一轮总长 − lcp
    const totalChars = num(o.totalChars);    // 合计（字）—— 这一轮正文拼起来的总长
    return {
        chars: lcpChars, missChars, totalChars,
        item: num(o.lcpItem), role: String(o.lcpRole || ''),
        itemChars: Array.isArray(o.itemChars) ? o.itemChars : null,
        charsBody: num(o.chars),             // 正文逐条之和（对账用）
        charHead: num(o.charHead),           // 抬头那格「N 字」（老口径会偏，只当对账）
        src: (o.lcpSrc === 'file') ? 'file' : '',
        srcWire: (o.srcWire === 'wire' || o.srcWire === 'snapshot') ? o.srcWire : '',
        // ★★★★★ v6.24.115：**官方裁判口径**（服务端 /log 新给的三个键）—— 与**任意更早轮次**的
        //   最大公共前缀，**不只上一轮**。为什么必须单列而不是改上面那三个数：官方
        //   prompt_cache_hit_tokens 命中的就是"与任意已缓存请求"（用户 v6.24.86 点名），
        //   实测本场 11 轮 Σ|与上一轮−官方| = 132,800 tok → Σ|池内最大−官方| = 768 tok；
        //   而 chars/missChars/totalChars 是"与上一轮"，管的是 ★★★★★ 那条
        //   「第 N 轮必须把第 N−1 轮当逐字节前缀、lcp(N−1,N) 不许降」—— 两条判据不许混。
        //   ⚠ 老服务端（ROUTE_V < 26）没有这三个键 ⇒ 一律 null，面板给 —，**不拿别的数顶上**。
        hitChars: num(o.hitChars),
        hitItem: num(o.hitItem),
        hitBestNo: num(o.hitBestNo),
        // 三个数齐了才算"这一轮给得出本地"（缺一个就如实说没有，绝不拼一个半套的出来）。
        // ⚠ hitChars 不进这个判据：它是另一条尺子，缺了只该让那一格给 —，不该让整行变成"没有本地"。
        available: !!(lcpChars !== null && missChars !== null && totalChars !== null),
    };
}

/* ══ 逐轮建行（源文件 @23871-24375） ══ */
export function _diffBuildRows(commits, chatNow = [], servedKey = '') {
    // v6.11：两列钱（费用/替换费用）的公共依据 —— 拿不到就整表不算替换（表照常显示，不报错）
    let planCtx = null;
    /* ★★★★★★ v6.39.6【实验链取数用的聊天键，必须与 /log **实际服务的那个键**同源】
     *   _gitLogQueryLog() 里有一条**回退**：当前记录 id（_gitLogChat()）在服务端还查不到时
     *   （刚刷新、chat_metadata 还没读回来的那一小段），它会拿"上次成功的那个键"再查一次，
     *   并把**真正服务的键**放在 _servedKey 上。v6.27.0 那段注释写得明明白白：
     *   "**不许再拿 _gitLogChat() 当'这份数据的身份'**"。
     *   ⚠ 我 v6.39.x 的实验链正是犯了这个错：preload 与这里都拿 _gitLogChat() 去取实验值，
     *     而面板画的行可能是**回退键**查回来的 ⇒ 两把钥匙不同 ⇒ 面板有数据、实验值一行都取不到
     *     —— 屏幕上表现成"**表头换了但四列数字一个都没动**"（用户 2026-09-19 两次报障都是它）。
     *   ⇒ 现在一律用**这一份数据的身份**（servedKey）；调用方没给才退回 _gitLogChat()（行为不变）。 */
    const _expKey = String(servedKey || _gitLogChat() || '');
    /* ⛔ 摘掉：源文件这里算 planCtx = _diffPlanContext(chatNow)（替换方案那条链的上下文）——
       _diffPlanContext 在任务明令**不许搬**的清单里（它内部要跑自动摘要的评分与梯子）。
       降级：planCtx 恒为 null => 每一行的 row.plan 恒为 null => 「替换费用」那一笔整块没有
       （表格里那一列在源文件 v6.24.2 就删了；少的是概述行末尾那个盈亏数，而概述行本身也没搬）。 */
    planCtx = null;
    // 表里默认不显示这种轮次（否则会出现"表格数据还在、聊天里早没了"的假象），只在一行小字里报出来。
    //
    // ⚠⚠ ★ v6.24.59【真 bug 修复·用户实测"差异页压根没数据"】⚠⚠
    //   这里原来只判 chatLen 是不是数组，**没判它是不是空的** —— 而 _diffChatNow() 在
    //   "聊天文件还没读完 / 刚换聊天 / 页面刚起来"的那一段返回的是 **空数组**（getContext().chat 还没填）
    //   ⇒ chatLen = 0 ⇒ 下面 stale 的判据 floor >= chatLen 对**每一行**都成立
    //   ⇒ **整表被判成"轮次都已删除"而隐藏**，用户看到的就是"还没有可比对的轮次"（记录一条没少）。
    //   实测数据（/log 那一场 4 条记录）：floor 分别是 33/35/37/39，只要 chatLen 拿到 0~33 就全军覆没。
    //   修法两条，缺一不可：
    //     ① 聊天还没加载出来（chatLen <= 0）时**一律不判 stale** —— "读不到当前聊天"不等于"记录过期"，
    //        宁可多显示一行（它本来就还在 git 里），也绝不把用户的记录藏起来；
    //     ② 判据收紧成 floor >= chatLen 且 chatLen >= 2（只有 0/1 条消息的聊天没有"可比对的轮次"，
    //        那种情况下这个判据本来就没有意义）。
    const chatLen = (Array.isArray(chatNow) && chatNow.length > 0) ? chatNow.length : 0;
    /** 当前聊天读不出来时**不做任何 stale 判定**（见上面那段：藏记录的代价远大于多显示一行） */
    const canJudgeStale = chatLen >= 2;
    // ★ 老坑（这次又踩了一次）：Number(null) === 0 是"有限数" —— 服务端没给（null）时会被静默算成 0，
    //   于是"这一轮没有可比的两份正文"看起来就像"lcp = 0 字"。所有可选数字一律先过这一道。
    const nz = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
    const list = (Array.isArray(commits) ? commits : []).map(c => {
        // 提交标题里本来就写着 turn #N | 18832tok/34msgs | ai#9 —— 服务端万一没给这些字段（旧模块），还能从这儿捞回来
        const m = /(\d+)\s*tok\s*\/\s*(\d+)\s*msgs/.exec(String(c?.subject || ''));
        const f = /ai#(\d+)/.exec(String(c?.subject || ''));
        return {
            no: Number(c?.no), sha: c?.sha || '', at: String(c?.at || ''), usage: c?.usage || null,
            tok: Number(c?.tok) || (m ? Number(m[1]) : 0), msgs: Number(c?.msgs) || (m ? Number(m[2]) : 0),
            // ★ 注意：Number(null) === 0 是"有限数" —— 老提交里 floor / chatLen 是 null 时
            //   会被这条静默算成 0（用户实测踩到过：整列楼层都变 #0）。必须先判 null / undefined。
            floorGit: (c?.floor !== null && c?.floor !== undefined && Number.isFinite(Number(c.floor)))
                ? Number(c.floor) : (f ? Number(f[1]) : null),
            chatLenGit: (c?.chatLen !== null && c?.chatLen !== undefined && Number.isFinite(Number(c.chatLen)))
                ? Number(c.chatLen) : null,
            // ★ v6.24.59【真 bug 修复·白名单漏带】这里原来**没有 tok** ——
            //   于是下面 const tok = c.tok || 0 恒为 0 ⇒ 「本地请求Token」那一格永远是 0/—，
            //   连带 myHit / myMiss / myPct（都是按 tok 折算的）恒为 null ⇒
            //   面板上"本地"那条线的 token 数永远是空的（用户看到的就是"对不上官网 token"）。
            //   /log 每轮本来就给了 tok，只是这一层搬运时漏了 —— 典型的老坑（见上面 v6.24.51 那段）。
            tok: nz(c?.tok),
            // ★★ v6.24.76【用户 ⑩：本地与官方 0 偏差】tokExact = **服务端在盘上那份真出网原文上、
            //   用酒馆那份真 DeepSeek 分词器现算**的 prompt token（/log 给的新字段）。
            //   它才是"本地"那一组该用的数：与官方 prompt_tokens 实测 21/21 逐位相等。
            //   而上面那格 tok 是**客户端在它自己手里那份预演数组上**数的 —— 酒馆后端出网前会把同角色
            //   消息并一遍（实测 77 条 → 44 条），并掉一条就少算 2 tok 的模板 ⇒ 面板上恒挂着 +58 / +51，
            //   最刺眼的一轮因为走了"定稿快照"兜底差了 −6,945。那个差不是算法错，是**数错了字**。
            //   服务端没给（老模块 / 拿不到分词器）⇒ null，如实退回旧行为，**不编数**。
            tokExact: nz(c?.tokExact),
            // ★ v6.24.51：**「本地」那三列要的那几个数一个都不能漏带**（这里是白名单式的搬运）——
            //   v6.24.50 那次就是这样丢的：/log 明明给了抬头那份断点，可这一层没带，
            //   面板手里空空如也 ⇒ 三列全 —（用户看到的就是"数据没了"）。
            //   现在带的是记录服务算好的：lcp / miss / 合计（字）＋ 定位用的逐条字数和下标。
            lcpChars: nz(c?.lcpChars),
            /* ★★★★★★ v6.39.11【这一轮记录里标的算法 —— 用户 2026-09-19：
                 "一旦取消勾选，那么**记录文件的算法标识符就可以起作用了**，
                  比如前三轮A算法 3~6轮B算法 7~12轮C算法"
               ── 于是"取消勾选"的语义是：**每一轮按它自己记录里那个算法取数**（如实反映历史），
                  而不是"退回主算法"。这里把服务端从抬头解析出来的三个字段搬进行里。
               ── 老记录没有这一段 ⇒ 空串 ⇒ 那一轮如实按主算法处理（**不猜**）。 */
            algoId: String(c?.algoId || ''), algoVer: String(c?.algoVer || ''), algoKind: String(c?.algoKind || ''),
            missChars: nz(c?.missChars),
            /* ★★★★★★ v6.41.24【真分词器劈出来的"命中 / 未命中"两半 —— 用户点名的"真实性"】
               服务端在**盘上那份冻结正文**上用酒馆那份真词表算的（见 index.mjs exactPrefixTok）：
               tokHit + tokMiss ≡ tokExact 按定义恒成立 —— 面板那两格从此与「本地合计」**同一个来源、
               同一套分词**，不再拿"字数 × 一个比例"编。老服务端 / 没词表 ⇒ null ⇒ 如实退回旧折算，
               并在悬停里写明"这两格是折算的"（**不冒充**）。 */
            tokHit: nz(c?.tokHit), tokMiss: nz(c?.tokMiss), tokHitBest: nz(c?.tokHitBest),
            totalChars: nz(c?.totalChars),
            lcpItem: nz(c?.lcpItem),
            lcpRole: String(c?.lcpRole || ''), lcpSrc: String(c?.lcpSrc || ''),
            itemChars: Array.isArray(c?.itemChars) ? c.itemChars.map(n => Number(n) || 0) : null,
            charsBody: nz(c?.chars),
            charHead: nz(c?.charHead),
            // ★ v6.24.39：这一轮的记录是**出网原文**还是**本地快照**（服务端抬头里那句话解析出来的）
            //   —— 「本地请求Token」那一列的悬停拿它解释"数的是哪一份字"。
            srcWire: (c?.srcWire === 'wire' || c?.srcWire === 'snapshot') ? c.srcWire : '',
            bytes: Number.isFinite(Number(c?.bytes)) && Number(c?.bytes) > 0 ? Number(c.bytes) : null,
            // ★ v6.25.1【用户第 17 轮："正常推进、原地重roll、删改楼层roll…每一轮我都能看到他在干嘛？"】
            //   重 roll 的**唯一硬标记**：服务端在"重新生成"那一发的 git 提交标题最前面写 swipe
            //   （判据是酒馆 GENERATION_AFTER_COMMANDS 的 type，见 index.mjs v6.24.58 那一段）。
            //   ⚠ 这里只是**读已有的标题**（/log 本来就把它给了），不是新字段、不动任何后台记录。
            swipe: /^swipe\b/i.test(String(c?.subject || '')),
            items: Array.isArray(c?.items) && c.items.length ? c.items : null, git: true,
            /* ★★★★★★ 2026-09-24【楼层格底下那几颗入口的"这一轮到底有没有那份东西"】
               服务端 `/log` 每轮给的两个状态（判据在服务端 `archiveStateOf` **一处**，三态互不混用）：
                 res   = { state, file, bytes }              官方返回 `turns/NNNNN.res.txt`
                 files = { body: {…}, raw: {…} }             池化后真发出去那份 / 酒馆原文那份
               state: present（有真数据）/ placeholder（占位文件，不是数据）/ absent（盘上没有）
               ⚠ 这里只**原样搬运**，一个字都不自己判（项目铁律：判据只有一处）——
                 拿不到（老服务端 / 还没重启）⇒ null ⇒ 那几颗入口**如实不画**，不猜。 */
            res: (c?.res && typeof c.res === 'object') ? c.res : null,
            files: (c?.files && typeof c.files === 'object') ? c.files : null,
        };
    }).filter(c => Number.isFinite(c.no)).sort((a, b) => a.no - b.no);
    const rows = [];
    let prev = null;   // 逐轮"旧 → 新"走一遍：prev 一定是时间上更早的那一轮（算断点/较上轮的前提）
    for (const c of list) {
        // 这一轮的逐条明细：git 里那一轮真实 request 的文本（服务端解析好的 role / tok / head / tail）
        const t = c.items ? { msgs: c.items, fromGitItems: true } : null;
        const msgs = t ? t.msgs.length : c.msgs;
        // 请求 token = 提交头行里记下的**实测总量**（写记录那一刻量的；官方 prompt 另有 usage.json 对账）
        //  ★ v6.24.59：c.tok 为 0/缺（老记录、或写记录时没量出来）时**退回官方 promptTok** ——
        //   官方那个数就是这一轮真发出去的 prompt token，权威；再没有才留 0（面板显示 —，不编数）。
        //  ★★ v6.24.76【用户 ⑩：本地与官方必须 0 偏差】优先级改成：**服务端在真出网原文上现算的
        //   tokExact 最优先**。理由（实测取证，见 index.mjs v6.24.76 那一段）：
        //     官方 prompt_tokens == Σ_每条 enc(role+换行+content) + 27，**只在"真出网那一串字"上成立**；
        //     抬头那格 tok 是客户端在**它自己那份预演数组**上数的（后端并消息之后条数会变少）⇒
        //     恒偏 +58 / +51；走"定稿快照"兜底的那一轮偏 −6,945。差的是**字**，不是算法。
        //   所以"本地"这一组的分子只认 tokExact；没有它才退回旧值，并且面板会写明这一格是退回来的。
        const tokExact = (c.tokExact !== null && c.tokExact > 0) ? c.tokExact : null;
        const tok = tokExact !== null ? tokExact : (c.tok || Number(c.usage?.promptTok) || 0);
        const d = (t && prev?.t) ? _diffTurnItems(prev.t, t) : null;
        // 官方值：服务端把 gitignore 的 usage.json 合并进来的那一份（硬盘上的权威值）
        const us = c.usage || null;
        const pick = (a, b) => (Number.isFinite(Number(a)) ? Number(a) : (Number.isFinite(Number(b)) ? Number(b) : null));
        const hitRaw = pick(us?.hit, null);
        const missRaw = pick(us?.miss, null);
        const outRaw = pick(us?.out, null);
        const hasUsage = Number.isFinite(hitRaw) && Number.isFinite(missRaw) && (hitRaw + missRaw) > 0;
        // 断点那一条自身 / 断点之后全部（= 这轮注定按未命中计费的部分）
        let brkTok = 0, mustFull = 0;
        if (t && d && d.breakIdx >= 0) {
            brkTok = t.msgs[d.breakIdx]?.tok || 0;
            mustFull = t.msgs.slice(d.breakIdx).reduce((a, b) => a + (b.tok || 0), 0);
        }
        // ── 本地的命中/未命中 ──
        //  ★ v6.24.51（用户定版）：**只有一个入口** —— _diffPanelLcp（见它上面那段说明）。
        //   三个数（字）是记录服务拿**这一轮与上一轮的记录正文**逐字节比出来的，面板一个字都不算；
        //   于是这三列与 node check/prefix_test.mjs 在真出网原文上量出来的 lcp / miss / 合计
        //   **逐位相同**（验收口径就这一条）。
        //   ⚠ 以前这里有两条后路：抬头没有 lcp 就退回**本地留档** _lcpStoreGet、再退回"逐条 token 求和"。
        //     用户点名删掉（"多处相同的参数栏不许有两套算法"）—— 少了哪一半就如实说少了，
        //     绝不换一套算法接着算（那样同一张表里会同时存在两种口径的数）。
        let panelLcp = _diffPanelLcp(c);
        /* ★ v6.39.7：**主算法那串字的总字数** —— 只读一行，专门喂给下面那个实验算法的独立代码段
         *   当"字 → tok"折算尺子的分母（tok 就是这串字自己的 token 数 ⇒ 同源才叫比例）。
         *   为什么必须先留一手：下面实验分支会把 panelLcp 整个换成实验链的三个字，
         *   到时候就再也拿不到主算法这份字数了。
         *   ⚠ 主算法路径**一个字节都不受影响**（这里只读，不写）。 */
        const _mainTotal = panelLcp.totalChars;
        /* ★★★★★★ v6.39.0【实验算法 · 面板切换点】用户原话："一旦切换 则面板里面所有的数据显示
         *   也是按新算法计算"。
         *   ⚠ 只换**那三个字**（命中/总长/未命中）—— 下面的 kLocal（字→tok 的比例）与官方三列
         *     **一个都不动** ⇒ 两种口径用的是**同一把尺子**，差值是算法的差，不是折算的差。
         *   ⚠ 官方三列（请求/命中/未命中/输出）**照旧显示真值**：官方跑的是主链路那一发请求，
         *     那是既成事实；拿实验值去折算官方格＝编数，违反"不编数"那条硬纪律。
         *   ⚠ 实验链是异步算的（_expAlgoGet 在 _renderDiffAnalysis 里已 await 过）⇒ 这里同步取。 */
        let expTag = '';
        /* ★★★★★★ v6.41.24【当前管线的重算**不再覆盖**「本地」三列 —— 用户 2026-09-20 定的铁律】
           【用户原话】"现在已经不按面板链了 而是每一轮独立的调用算法管线，每一轮的结果是独立且
             固定在磁盘上的。你算法怎么切都不影响！！！"
           【病】原来这里写的是 panelLcp = { …chars: _e.aChars, missChars: _e.missChars, … } ——
             把**面板链按当前算法重算**出来的三个数**盖掉**了盘上冻结件的那三个数。两个后果：
               ① 用户一改管线（换算法 / 调 MIN / 动分片），**历史每一行的「本地」三列全跟着变**
                  —— 这正是"你算法怎么切都不影响"被违反的地方（用户点名的"面板自我冲突"）；
               ② 两套数的**定义本来就不同**（盘上：与上一轮的公共前缀；重算：参考串长度）
                  ⇒ 同一列里混着两种口径。
           【修法】「本地」三列**只认盘上冻结件**（/log 在 turns/NNNNN.txt 上现算的那一份）。
             当前管线重算的那一份降级成 expLcp，**只作对照**（悬停里如实标"当前管线重算，非真发值"）。
           【⚠ 一个字都没删】_expAlgoRun 那条链照旧跑、差异页「🧪池化↗」照旧用它 ——
             本改动只切断它**改写面板数字**这一条路。
           ── ⚠ _expAlgoRowFor 的第三参是"接口支持按槽取数"（_expAlgoSlotId(algoId) 那一族还在）；
              生产里不再传别的槽 ⇒ 一律走**当前管线**那一槽（不传第三参 = _expAlgoSlotId()）。 */
        let expLcp = null;
        let algoTag = '';
        /* ⛔ 摘掉：源文件这一整块是**实验算法链**（_expAlgoOn / _expAlgoRowFor / _expAlgoNameNow /
           _expAlgoHitCount）—— 它读 Horae 的管线注册表与内存里逐轮重算的产物，搬不过来。
           降级：expTag / expLcp 恒为空 => 每一行都走下面 if (!algoTag) 那一支（标注成主算法），
           「本地」那几列只认盘上冻结件那一份 —— 与源文件里"实验模式关着"时是**同一条路**。 */
        /* ★ v6.39.10：**落空的行仍然是主算法那一套数** —— 如实标出来（不冒充实验值、也不留空），
         *   这正是"同一张表里混着两种算法"必须逐行标的原因。 */
        if (!algoTag) {
            algoTag = `主算法（最长公共子串） ${String(HORAE_CACHE_PATCH || '')} · 盘上产物（turns/ 里那份）`;
        }
        const myCharLcp = panelLcp.chars;             // 命中**字**（公共前缀长度，逐字节比出来的）
        const myCharTotal = panelLcp.totalChars;      // 这一轮总长（字）
        const myCharMiss = panelLcp.missChars;        // 未命中（字）= 总长 − 公共前缀
        // token 那一侧的折算：这一轮自己的"字/token"比 —— 只给「费用」「替换模拟」那几条要 token 的路用，
        // 面板上那三列显示的是**字**（与 prefix_test 打印的逐位对齐），官方那三列才是 token（权威）。
        let myHit = null, myMiss = null, mySrc = '';
        if (myCharLcp !== null && myCharTotal !== null && myCharTotal > 0 && tok > 0) {
            myHit = Math.round(myCharLcp * tok / myCharTotal);
            myMiss = Math.max(0, tok - myHit);
            mySrc = 'file';
        }
        // ★ v6.24.59【用户："换成token单位啊 你自己看 还有怎么突然请求token对不上官网token了"】
        //   「本地」那三列改成 **token 单位**。折算法与上面 myHit **完全同一套**（一个比例、不另开算法）。
        // ★ v6.24.61【用户："单元格第二行 写上差异数（与官方usage）…能抓到问题才是好的面板"】
        //   ⚠ 比例 k 从"借官方的"改成**本地自己的** —— 这一格是"本地"，就不能拿官方当锚：
        //     比值 k = 本地逐条求和 tok ÷ 这一轮总字数（本地自己量出来的字/token 比）
        //     合计 = 本地 tok（**独立量出来的**，不是官方的数换个说法）
        //     命中 = round(lcp 字 × k)；未命中 = 合计 − 命中（⇒ 命中＋未命中 正好等于合计，行内自洽）
        //   旧口径 k = 官方 prompt ÷ 总字数、合计 = 官方 prompt —— 那样「合计」与官方**恒等**，
        //   第二行那个差永远是 0，看着像"算法完美"（其实什么都没测）。改成自己的数之后，
        //   第二行的差才真的是**算法的差**（实测 #00005~00007 全是 +58 = 2×条数，就是这么看出来的）。
        //   ⚠ 老记录（抬头写着 0 tok，v6.24.60 之前写的）本地没有 token 数 → k 退回借官方 prompt 的比例，
        //     那时合计＝官方、第二行如实显示 0，悬停里写明"这一格是借官方比例折的"（不编数、不猜）。
        const kLocal = (tok > 0 && myCharTotal > 0) ? tok / myCharTotal : null;
        const kOff = (Number(us?.promptTok) > 0 && myCharTotal > 0) ? Number(us.promptTok) / myCharTotal : null;
        const kTokPerChar = kLocal !== null ? kLocal : kOff;
        const myTokBasis = kLocal !== null ? 'own' : (kOff !== null ? 'off' : '');
        // ⚠ v6.39.7：这三行从 const 改成 let —— **算式一个字没动**，
        //   改 let 只是为了让下面那个**实验算法的独立代码段**能把它们整组换掉。
        //   关着开关时那个段一次都不进 ⇒ 这里算出来的就是最终值（＝原来那一版，逐位相同）。
        let myTokTotal = kLocal !== null ? tok : (kOff !== null ? Number(us.promptTok) : null);
        /* ★★★★★★ v6.41.24【命中 / 未命中改读**真分词器**劈出来的两半（用户点名的"真实性"）】
           【病】原来这两格是 round(字数 × kTokPerChar) —— 一把"字→tok"的比例尺乘出来的**折算值**，
             而同一组里的「本地合计」是 tokExact（服务端拿真词表在盘上冻结正文上**数**出来的）。
             ⇒ 同一行四格混着**两种性质的数**：一个真数、两个折算 —— 这就是"面板自我冲突"。
           【修法】服务端用**同一个分词器、同一份盘上正文**，把 tokExact 按 lcpChars 劈成两半
             （tokHit / tokMiss）⇒ 两格与「合计」同源，且 命中 + 未命中 ≡ 合计 **按定义恒成立**。
           【诚实】拿不到（老服务端 / 这台机器没词表）⇒ 照旧退回那把比例尺，并把 myTokSrc 标成
             fold，悬停里写明"这两格是折算的" —— **绝不拿折算值冒充分词器数**。 */
        const _exHit = nz(c?.tokHit), _exMiss = nz(c?.tokMiss);
        const _hasExact = (_exHit !== null || _exMiss !== null);
        let myTokLcp = (_exHit !== null) ? _exHit
            : ((kTokPerChar !== null && myCharLcp !== null) ? Math.round(myCharLcp * kTokPerChar) : null);
        let myTokMiss = (_exMiss !== null) ? _exMiss
            : ((myTokTotal !== null && myTokLcp !== null) ? Math.max(0, Number(myTokTotal) - myTokLcp) : null);
        const myTokSrc = _hasExact ? 'tok' : (kTokPerChar !== null ? 'fold' : '');
        /* ══════════════════════════════════════════════════════════════════════════════
         * ★★★★★★ v6.39.7【实验算法 · **独立代码段**（与主算法彻底分开）】
         *   用户 2026-09-19 定版原话："实验算法必须独立代码段，你别跟主算法搅浑，
         *   我切换算法回正常模式 面板必须正常，算法是内核 但是可以切换。"
         *   ── 纪律：上面主算法那几行**一个字的算式都不改**，算出来的就是**最终值**；
         *      只有下面这个 if 块会把四格**整组换掉**（换的是**结果**，不是**算式**）。
         *   ── 为什么非换不可（这是用户第三次报障的后半截）：主算法那句
         *      myTokTotal = kLocal ? tok : … 里 tok 是**主算法那串字**的 token 数
         *      ⇒ 它在主算法模式下**恒等于 tok**、与算法无关 ⇒「本地·实验 合计」被死钉在
         *      主算法的 token 上，切换后**那一格一动不动**（命中/未命中倒是动了，
         *      看着就像"只有半张表生效了"）。
         *   ── 尺子 _k = tok / _mainTotal：分子分母**同源**（都来自主算法那一份字）
         *      ⇒ 拿它去量**实验链**的字数才叫比例。若用 tok / myCharTotal，
         *      分母已被实验值换掉 ⇒ 跨了两串字，量出来的不是比例。
         *   ── 「切换回正常模式面板必须正常」是**可证**的：开关关着 ⇒ expTag !== 'exp'
         *      ⇒ 这个块一次都不执行 ⇒ 上面那几行就是最终值（与 v6.39.6 逐位相同）。
         * ══════════════════════════════════════════════════════════════════════════════ */
        /* ★ v6.41.24：加 !_hasExact —— 服务端已经把**真分词器**劈出来的两半交过来了，
           这里就**一个字都不许再动**（原来这一段是"拿主算法那把尺子把实验链的字数折成 tok"，
           在 v6.41.24 之后它的分子分母已经同源 ⇒ 跑起来只会把真数换成折算值，纯亏）。
           它现在只在"服务端给不出两半"时当兜底 —— 那时它算的仍是一把比例尺，myTokSrc='fold' 会如实标出来。 */
        if (!_hasExact && expTag === 'exp' && tok > 0 && Number(_mainTotal) > 0 && Number(myCharTotal) > 0) {
            const _k = tok / _mainTotal;                       // 主算法那串字的"字 → tok"比（同源尺子）
            myTokTotal = Math.round(Number(myCharTotal) * _k);
            myTokLcp = (myCharLcp !== null) ? Math.round(Number(myCharLcp) * _k) : null;
            myTokMiss = (myTokLcp !== null) ? Math.max(0, myTokTotal - myTokLcp) : null;
            myHit = myTokLcp;                                  // 官方未回时的费用兜底：跟着实验链一起换
            myMiss = myTokMiss;
        }
        // 楼层 = 提交元数据里发送那一刻实测的 ai#N（没有就 null → 表里写"第N轮"，绝不编一个楼层）
        const floorVal = c.floorGit ?? null;
        const chatLenAt = c.chatLenGit ?? null;
        // v6.8：把"逐条之和"与"官方 prompt_tokens"对一下 —— 两者本该只差零点几个百分点；
        // 差得多就说明有条目的 token 记错了（实测踩到过：世界书条目被记成 1,612，真值 1,091）。
        const offPrompt = Number.isFinite(Number(us?.promptTok)) ? Number(us.promptTok) : null;
        const promptGap = (offPrompt > 0 && tok > 0) ? tok - offPrompt : null;
        // ★ v6.24.39：这一轮的记录到底是**出网原文**还是**本地快照**（抬头里那句话，服务端解析后给的）
        //   —— 「本地请求Token」那一列的悬停拿它说清"数的是哪一份字"。null = 老记录/没说。
        const wireSrc = (c.srcWire === 'wire') ? true : (c.srcWire === 'snapshot' ? false : null);
        const row = {
            turn: c.no, at: c.at || '', sha: c.sha, tok, msgs, fromGit: c.git,
            /* ★★★★★★ 2026-09-24【楼层格底下那几颗入口要用】原样带进这一行 ——
               见上面 `list` 里那两个字段的注释（三态判据在服务端一处，这里只搬运，不自己判）。 */
            res: c.res || null, files: c.files || null,
            // 楼层 = 聊天里那一楼（#9 就是你看到的 #9）：取自提交元数据里发送那一刻实测的 ai#N（没有就是未知）
            floor: floorVal,
            // 已被删除/回滚：那一楼在现在的聊天里已经不存在了
            //   ★ v6.24.59：canJudgeStale 为假（当前聊天读不出来）时**一律 false** —— 见上面那段注释
            stale: canJudgeStale && floorVal !== null && floorVal !== undefined
                && Number(floorVal) >= chatLen,
            // ══ ★★★ v6.24.98【用户两次纠正后定版：**一次请求一行，一次不缺**】════════════════════
            //   用户原话："面板没有显示我重roll的价格…我希望面板能如实统计 现在缺了重roll 有点滑稽"
            //          ＋ "不止哦 我的意思是 **面板应该是多少轮多少行**哦　你说改完就多3行，我可不认！"
            //   定义（全部来自这一条提交自己的元数据，一个数都不估）：
            //     设第 k 发发送那一刻 AI 回复落在 f 楼（ai#f）、那一刻聊天共 L 条（cl#L），
            //     此刻聊天共 L_now 条。
            //       **这一发的内容已经不在当前聊天里**  ⟺  f ≥ L_now
            //   （楼层 0..L_now−1 活在聊天里，f ≥ L_now 说明它那一楼已经被回滚掉了。）
            //   实测（圣樱学院_mu5mwldwtk2h，15 个提交，L_now = 12 —— 取自 15:03:02 的 panel:diff 心跳）：
            //       f < 12 的 **9** 条 : no 0,1,2,3,4,5,12,13,14 —— 存活（面板上本来就画着）
            //       f ≥ 12 的 **6** 条 : no 6,7,8,9,10,11 ← 被重 roll 掉的那几次（**面板一行都没画**）
            //     ⇒ 面板原样只画 9 行，而**真实发出去过 15 次请求** ⇒ 少的正是这 6 次重 roll。
            //       9 + 6 = 15 = 提交总数 = turns/ 文件数 = usage.json 键数（四者恒等）。
            //   ⚠ 为什么**不**拿 f == L 当判据（v6.24.97 的第一版就是那么写的，当场被上面这张表否掉）：
            //     实测 f == L 对**全部 15 条**都成立（提交那一刻回复总在最后一条）⇒ 它一条都区分不了，
            //     拿它当判据会把 6 条"还在聊天里"的行也标成重 roll（多算钱、多画行）。
            //   ⇒ 恒等式（唯一判据）：**一次请求一行** —— 面板把**所有**提交都画出来，
            //     行数 = turns/ 文件数 = usage.json 键数 = git 提交数（四者恒等，实测 15=15=15=15）。
            //   ★★ v6.24.100：原来这里还有一个 rerolled 字段，判据跟上面 stale **逐字一样**
            //     （同一条 Number(floorVal) >= chatLen）⇒ 那是个**永远等于 stale 的重复字段**，
            //     只会让人以为"两者能区分"（连我自己上一轮都被它骗了：以为 hidden 会非 0）。
            //     真值：f >= L_now 判的是"这一发的内容已经不在当前聊天里"——用户重 roll 与删楼层
            //     在这个判据下**本来就是同一件事**，分不开也不需要分（两者都是真花过的钱）。
            //     ⇒ 删掉重复字段，全项目一律只看 stale（_diffRenderTable 的「⟲ 已回滚」标记同源）。
            chatLenAt, chatLenNow: chatLen,
            hasUsage, pending: !hasUsage,
            hit: hasUsage ? hitRaw : null, miss: hasUsage ? missRaw : null,
            out: Number.isFinite(outRaw) ? outRaw : null,
            pct: hasUsage ? _diffFmtPct(hitRaw, missRaw) : '—',
            myHit, myMiss, mySrc, offPrompt, promptGap, wireSrc,
            // ★ v6.24.59：命中率跟着**显示口径**走 —— 官方回来时那三列是 token（折算），命中率就用 token 算；
            //   官方没回来时显示"字"，命中率就用字算（原口径，不变）。
            myPct: (() => {
                if (myTokSrc !== '' && myTokLcp !== null && myTokMiss !== null) return _diffFmtPct(myTokLcp, myTokMiss);
                return (myCharLcp !== null && myCharTotal > 0) ? _diffFmtPct(myCharLcp, myCharMiss) : '—';
            })(),
            gapHit: (hasUsage && myHit !== null) ? hitRaw - myHit : null,
            // ★ v6.24.51：「本地」那三列的**字口径**（面板上显示的就是这三个数，验收口径）
            myCharLcp, myCharMiss, myCharTotal,
            /* ★★★★★★ v6.51.6【★ 白付（漂移税）—— 服务端在**这两份盘上正文**上现算的（index.mjs 的 taxOfTurns）。
               它与 myCharLcp **同一对文件、同一个拼串口径** ⇒ 这一格与「本地命中」同源，不会各说各话。
               ⚠ 拿不到（老服务端 / 第一轮没有可比的那一轮 / 正文缺失）⇒ null，面板如实说"算不了"，**不拿 0 顶**
                 —— "白付 = 0"（断点后没有一行是旧的）与"算不出白付"是两件事，混起来这一格就没诊断价值了。 */
            taxChars: nz(c?.taxChars),
            // ★ v6.24.59【用户要求："换成token单位啊"】「本地」三列的 **token 口径**：
            //   官方 prompt_tokens 是**按这一轮真发出去的那串字**算的，而我们只量得到"字"
            //   （抓包在传输层截下的正文里没有逐条 token）⇒ 按 官方 prompt_tok ÷ 这一轮总字数
            //   的**同一比例**折算。官方没回来（没得折算）时这三格显示**字**，并在数字后面挂一个
            //   字 标记，一眼能看出单位（绝不把两种单位混着显示而不说明）。
            myTokLcp, myTokMiss, myTokTotal, myTokSrc, myTokBasis,
            /* ★ v6.39.10【逐行的算法标注】用户："给每一轮的数据 标记 来自什么版本算法，
             *   跟BS双端版本一个性质" —— 实验模式下同一张表里混着两种算法，只有逐行标才分得清。 */
            algoTag,
            /* ★★★★★★ v6.41.4【这一行归**当前管线**那一槽】
               用户 2026-09-20："这个功能可以删了 因为默认就是全部用管线 **不关心已经存档的算法戳**"
               —— "按每一行自己记录里的算法戳取数"（_rowAlgo）随那个勾选框一起删了。
               现在 algoId 恒＝**当前管线槽名** ⇒ 差异页与三个入口按它推盘上路径
               （algos/<槽>/turns/NNNNN.txt）永远指到"产物真在的地方"。
               ⚠ 主算法那几行（expTag !== 'exp'）给空串 —— 它们归主算法管，没有管线目录。
               ⚠ 记录抬头里的算法戳 / 管线快照**照旧写**（那是存档的事实），只是面板不按它取数。 */
            /* ★★★★★★ v6.41.4【改成**存档抬头**口径 —— 每一行都有，不管本页算没算过】
               为什么必须改：徽标要标的是"**真发出去那一发**是谁装的"，而那一发**每一轮都存在**
               （没切片的那几行同样有 raw / txt / res 三份）。
               老写法只在"面板按管线取到数"时才填 ⇒ 恰恰是这几行标不出来。
               ⚠ 安全：r.algoId 现在的唯一消费者就是那个徽标（_dvLinks 的 _aid 早已改成
                 _expAlgoSlotId()）⇒ 改口径不会连带影响取数。 */
            algoId: String(c?.algoId || ''),
            /* ★★★★★★ v6.41.4【这一轮**真发出去的那一发**是哪条管线组合装的 —— 读存档，不现算】
               用户 2026-09-20："我的建议是**可复现**，我们已经拿到了发给请求 api 的原文（无任何变更）
               ＋ 输出原文（无任何变更）。我们需要**标记面板的池化**，表示这个池化发给官方所得的
               实际官方值，是由某个**管线组合**计算而来。"
               ── 数据来源：这一轮的**存档抬头**（/log 把 | 管线 pipe=<槽名>@<各级版本> (pipe) 解析成
                  这三个字段）⇒ 中途改过管线也不会认错：**每一行记的是它自己那一轮的装配者**。
               ── 老记录（v6.41.3 之前）抬头写的是 算法 algo=…@… ⇒ 这里就是那一个算法的版本，
                  **照实显示**（不冒充成管线）。 */
            algoVer: String(c?.algoVer || ''), algoKind: String(c?.algoKind || ''),
            /* ★ v6.39.9：**主算法那串字的总字数**（只读地摆进 row）——
             *   差异页要把实验链的"字"折成 tok，尺子的分母必须是**主算法那一份字数**
             *   （tok 就是它自己的 token 数 ⇒ 分子分母同源才叫比例）。
             *   ⚠ 实验模式下 myCharTotal 已经被换成实验链的字数了，拿它当分母就是跨两串字。 */
            mainChars: _mainTotal,
            // ★ v6.24.59：与官方那三格对比、悬停里说清"折算过来的、不是独立量的" —— 都要官方 prompt
            offPrompt: (Number.isFinite(Number(us?.promptTok)) && Number(us.promptTok) > 0) ? Number(us.promptTok) : null,
            lcpItem: panelLcp.item, lcpRole: panelLcp.role, itemChars: panelLcp.itemChars,
            lcpSrc: panelLcp.src, charBody: panelLcp.charsBody, charHead: panelLcp.charHead,
            brkTok, mustFull, d,
            delta: prev ? tok - (Number(prev.tok) || 0) : 0,
            breakAtPrevEnd: (t && prev?.t) ? prev.t.msgs.length : -1,
            // v6.11：这一轮真实请求的逐条明细（算「替换费用」那一笔要用它认出"哪一条是哪一楼"）
            items: (t?.msgs && t.msgs.length) ? t.msgs : null,
        };
        // ★ v6.24.51：断点落在第几条，只认**唯一那个入口**给的下标（记录服务拿两份正文逐字节比出来的）——
        //   原来这里写的是 lcp.item（const lcp = c.lcp || _lcpStoreGet(...)），那半套已按用户定版整段删掉，
        //   而这一行**忘了跟着改** ⇒ lcp is not defined 抛出去、整张表停在"正在取这一场聊天的记录…"（真事故）。
        const brkTokNow = (panelLcp.item !== null && Number.isFinite(Number(panelLcp.item)))
            ? Number(panelLcp.item) : (Number.isFinite(Number(d?.breakIdx)) ? Number(d.breakIdx) : -1);
        const curItems = (t?.msgs && t.msgs.length) ? t.msgs : null;
        const dCur = (brkTokNow >= 0 && Array.isArray(curItems)) ? (curItems[brkTokNow] || null) : null;
        const dPrev = (brkTokNow >= 0 && Array.isArray(prev?.t?.msgs)) ? (prev.t.msgs[brkTokNow] || null) : null;
        // v6.12：这一轮**真正新增的内容**从第几条开始 —— 逐条问一句"上一轮这条存在吗"（存在=平移/未变）。
        //   有了它才能回答那个关键问题：断点是"正常增量"，还是缓存被**改老消息**弄掉的。
        const newFrom = (() => {
            const pm = prev?.t?.msgs, cm = curItems;
            if (!Array.isArray(pm) || !Array.isArray(cm) || !pm.length) return -1;
            for (let i = 0; i < cm.length; i++) {
                if (!pm.some(p => _rlSame(p, cm[i]))) return i;
            }
            return -1;
        })();
        // v6.12：断点那条**本身**是不是"老内容"——用两轮真实请求里的那一条直接比：
        //   · 同角色 + 开头逐字相同（= 就是同一条消息）但内容变了 ⇒ 断点落在老内容上（不是新增内容的位置）
        //   · 否则 ⇒ 断点落在新增/移位的第一条（正常增量）
        const churned = (() => {
            const pm = prev?.t?.msgs;
            if (!Array.isArray(pm) || !Array.isArray(curItems) || brkTokNow < 0) return false;
            const a = pm[brkTokNow], b = curItems[brkTokNow];
            if (!a || !b) return false;
            if (String(a.role) !== String(b.role)) return false;
            if (String(a.head || '').slice(0, 40) !== String(b.head || '').slice(0, 40)) return false;
            return !_rlSame(a, b);
        })();
        row.newFrom = newFrom;
        row.churned = churned;
        // v6.21.6：把"认楼层用的聊天上下文"一起带进去 —— 断点位置那一列要拿断点那一条跟活聊天对，
        //   才能说出准的楼层（以前只按"后面还剩几条"数，尾巴上那串注入块会被当成楼层 → 整列全是 #1）
        /* ══ ★★★ v6.37.3【用户 2026-09-19 报："你有三个第一次？" —— 真凶就在这一行】═════════════
         * 原来写的是 first: prev === null，而 prev 是**循环变量**（上一发算出来的比较对象，
         * 见下面 _pred 那一段：floor === 0 / 楼层未知 / 前面没有更低楼层 ⇒ _pred = null）。
         * prev === null 把**两件完全不同的事**混成了一个字段：
         *   (a) **这一发之前一次提交都没有** —— 这才配叫"本聊天第一次请求"；
         *   (b) 这一发自己没得比（floor = 0、楼层没记下、前面没有更低的楼层）—— **根本不是第一次**。
         * 更要命的是**它会传染**：prev 是上一行末尾留下的值 ⇒ 某一行算出 null 之后，
         * **紧跟着的下一行**读到的还是那个 null ⇒ 也被打成"第一次"。
         * 真数据（圣樱学院_mu8frlmaq01m，2026-09-19 21:5x，GET /log 实测 floor = 7,5,3,**0**,**0**）：
         *   第 1 轮 floor=0 ⇒ prev=null ⇒ "第一次"（**对**）
         *   第 2 轮 floor=0（「同层重发」—— 在第 0 楼重 roll，楼层不动）⇒ prev=null ⇒ "第一次"（**错**）
         *   第 3 轮 floor=3 ⇒ 读到**上一行留下的那个 null** ⇒ 又"第一次"（**错**）
         *   ⇒ 一列里正好三个 —— 就是用户截图那一列。
         * 判据改成唯一说得通的那条：**rows 里一条都还没有**。
         *   （rows.push(row) 在下面几行才执行 ⇒ 此刻 rows 不含这一行，length === 0 就是第一发。） */
        row.reason = _diffBreakReason({ ...row, first: rows.length === 0, dPrev, dCur, planCtx });
        /* ★★★★★★ v6.39.2【实验模式下的「断点位置」列 —— 用户 2026-09-19："面板里面**所有的**数据显示
         *   也是按新算法计算"】
         *   ── 病在哪（这是"同一格里两套口径"的典型）──────────────────────────────
         *     _diffBreakReason 算的是"**真发出去那一发**断在第几楼" —— 它读的是盘上真出网正文的
         *     逐条 diff（dPrev/dCur）⇒ 那是**主算法口径**。而这一行左边的「本地」四格在实验模式下
         *     已经换成了实验链的数 ⇒ 同一行里"命中的字"是实验的、"断点在第几楼"是主算法的，
         *     两套口径挤在一行，正是项目最恨的"各说各话"。
         *   ── 为什么不给实验链也算一个"第几楼"──────────────────────────────────
         *     实验链的参考串 ref 在 N≥2 时**是一整串文本**（T_{N-1} = 上一轮产物），
         *     它**没有消息结构** ⇒ 硬编一个楼号就是编数。它真正说得清的只有一件事：
         *     **命中到参考串末尾为止**（chars == |ref|，之后全是未命中）。
         *   ── 改法（口径不混、信息不丢）────────────────────────────────────────
         *     格子里改说实验口径那一句；**主算法那句话原样搬进悬停**（"留档对照"），一个字不丢。
         *   ⚠⚠ 开关关着时 expTag 恒为 '' ⇒ 这一整段不执行，row.reason **逐字节等于改动前**
         *     （用户："不能瞎改 我只要不切换下拉框的算法，就必须维持原样"）。 */
        if (expTag === 'exp') {
            const _keepR = row.reason;
            row.reason = {
                kind: 'exp',
                /* ★ v6.39.13【用户 2026-09-19 第二句："**断点位置**也是 **悬浮看也看不到断点详情位置**"】
                   两处一起改（只重排与缩短，**一个数都不改**）：
                     · 格子里那句原来写「实验链：断点在参考串末尾」—— 11 字，而这一格只有 109px
                       ⇒ 屏幕上只剩「实验链：断点在…」，等于没说 ⇒ 缩成 9 字，刚好放得下；
                     · 悬停里**把"位置"提到第一行**：原来第一行是一段解释，位置被埋在
                       【主算法那一轮真发出去的那一发】那一行的中间 —— 用户"悬浮也看不到"说的就是这个。
                       现在第一行直给位置，解释退到后面。 */
                text: '管线：参考串末尾',
                detail: `【断点位置（主算法真发出去的那一发）】${_keepR?.text || ''}`
                    + `${_keepR?.detail ? `：${_keepR.detail}` : ''}`
                    + `\n【管线这一行】命中 = 参考串长度（＝左边「本地·实验」那四格里的命中字），之后全是未命中；`
                    + `参考串在 N≥2 时是一整串文本、没有消息结构 ⇒ 它给不出"第几楼"，只有"到参考串末尾"这一步。`
                    + `\n（上面那一段主算法的位置留在悬停里仅供对照，不参与实验模式的任何判据。）`,
            };
        }
        // 两笔钱（v6.11）：费用 = 这一轮实际单价；替换 = 按本地总结替换后的单价（v6.24.2 起不再单占一列，
        //   只在概述行末尾给一个盈亏数 —— 算法与字段一字未动，仍然每行都算）。
        // 依据分得清：命中/未命中优先官方 usage（权威），没有官方值就用「本地」并标明。
        // 算不出来（极简环境缺单价/本地依赖）就留空 —— 表照常显示，绝不因为两列钱把整表搞崩。
        try {
            const p = _getPrice();
            const outTok = Number.isFinite(Number(row.out)) ? Number(row.out) : 0;
            const hasUs = row.hasUsage === true;
            // ★ v6.24.50（用户定版）：**这一笔钱只认官方 usage** —— 官方没回来 → cost = null（面板给 —），
            //   也不参与顶部「总费用/命中/丢失/输出/最近一轮」。以前这里会退回「本地」把钱算出来，
            //   结果汇总里混着"本地推算的钱"（口径与官方那三列不是一回事）。
            //   ⚠ v6.24.13 那条纪律（这一格与「替换费用」的「前」必须同一套 token）照旧成立：
            //     现在两边都只走官方这一条路。
            row.cost = hasUs ? _diffCostOf(row.hit, row.miss, outTok, p) : null;
            row.costBasis = hasUs ? '官方' : '';
            // ★ v6.24.13：这一格用的三个 token 数也存下来 —— 「替换费用」那一格的「前」**必须是这一格的同一套数**，
            //   不许再自己去 usage.json 里另取一份。
            row.costTok = hasUs ? { hit: row.hit, miss: row.miss, out: outTok } : { hit: null, miss: null, out: outTok };
        } catch (err) { row.cost = null; row.costBasis = ''; }
        /* ⛔ 摘掉：row.plan = _diffReplacePlan(row, planCtx) —— _diffReplacePlan 在任务明令
           不许搬的清单里（它是摘要系统那条"换上手动摘要要花多少钱"的链）。
           降级：row.plan 恒为 null。表面上只少两样：① 概述行末尾那个盈亏数（概述行没搬）；
           ② 每一行悬停里那份逐项账。表格里本来就没有「替换费用」这一列（v6.24.2 删的）。 */
        row.plan = null;
        rows.push(row);
        // ══ ★★★ v6.24.97【"本地"那三列的上一轮 = **真正的前一发**，不是 no - 1】══════════════
        //   旧写法 prev = {…} 走的是**数组里的前一个元素**（= 轮号小 1 的那个提交）。可重 roll 之后
        //   "前一发"根本不是轮号小 1 的那个 —— 它是"上一发**还在聊天里**的请求"。
        //   真数据验算（圣樱学院_mu5mwldwtk2h，15 个提交逐条对上）：no=10（ai#15）的数组前一个是
        //   no=9（ai#17，那是**比它更深**的一次尝试），而真正的前一发是 no=6（ai#13）；
        //   no=11（ai#13）的前一个更离谱，是 no=10（ai#15）。这类行上"断点位置"那一列原来指的是**别人**。
        //   判据（只用提交自带的两个元数据，不猜）：**楼层严格小于这一轮、且轮号最大**的那一发。
        //   ⚠⚠ 范围**只限 d / brkTok / mustFull（"断点位置"那一列的明细）**：
        //     面板「本地」那三格（lcp 字）走的是 _diffPanelLcp(c) = **服务端 lcpOfTurns**
        //     （拿 turns/(no-1).txt 与这一份逐字节比），它是**全项目唯一那套 lcp 入口**
        //     （用户 §2.2），且经四视图验收钉死（面板那三格 == prefix_test 逐位相同）。
        //     这里改的是"哪一份当比较对象"的**读法**，不动那一套 —— 一个字节都不发出去。
        //   delta / breakAtPrevEnd 仍按 no-1（它们量的是"与上一轮相比涨了多少"，
        //     服务的对象是**面板的上一行**，不是 LCP）。 */
        const _pf = (row.floor !== null && Number.isFinite(Number(row.floor))) ? Number(row.floor) : null;
        const _pred = (_pf !== null && _pf > 0)
            ? rows.filter(r => r.floor !== null && Number(r.floor) < _pf).pop() || null
            : null;
        prev = _pred
            ? { t: _pred.items ? { msgs: _pred.items, fromGitItems: true } : null, tok: _pred.tok, c: _pred }
            : null;
    }
    // v6.24.7：把认楼层那套上下文挂在数组上，给"替换模拟"复用（省得再对每条消息哈希一遍）
    rows.planCtx = planCtx;
    return rows;   // list 是"旧 → 新"，所以 rows 天然就是按轮次从小到大 —— 跟聊天从上往下读一致
}

/* ══ 正在取数据的标记（源文件 @24377-24390） ══ */
/** ★ v6.24.20：这一次"正在取数据"是从哪一刻开始的（0 = 没在取）。
 *  只用来把空表分成"正在取"和"真的还没有轮次"两种情况（见 _diffRenderTable）。 */
/** ★ v6.24.20：这一次"正在取数据"是从哪一刻开始的（0 = 没在取）。
 *  只用来把空表分成"正在取"和"真的还没有轮次"两种情况（见 _diffRenderTable）。
 *  读写成下面两个小工具、调用处一律走 typeof 兜底：它只是个提示文案的判据，
 *  **不是正确性依赖** —— 老测试沙箱只抠 _diffRenderTable / _renderDiffAnalysis 这两个函数
 *  （没有这两个小工具）时不许抛。 */
let _diffBuildingSince = 0;
export function _diffBuildingSinceGet() {
    try { return typeof _diffBuildingSince === 'number' ? _diffBuildingSince : 0; } catch (_) { return 0; }
}
export function _diffBuildingSinceSet(v) {
    try { _diffBuildingSince = Number(v) || 0; } catch (_) { }
}

/* ══ 画表（源文件 @24392-24981） ══ */
/* ⚠ 依赖换来源：多一个第四参 container（源文件写死 Horae 的 DOM id，见下面那一行）。 */
export function _diffRenderTable(rows, sourceNote, buildingSinceAt = 0, container = null) {
    const sinceSet = (typeof _diffBuildingSinceSet === 'function') ? _diffBuildingSinceSet : null;
    const sinceGet = (typeof _diffBuildingSinceGet === 'function') ? _diffBuildingSinceGet : (() => 0);
    if (buildingSinceAt) { if (sinceSet) sinceSet(buildingSinceAt); }
    else if (!sinceGet() || (Date.now() - sinceGet()) > 30000) { if (sinceSet) sinceSet(0); }
    const buildingSinceAt2 = sinceGet();
    /* ⚠ 依赖换来源：源文件这里写死 document.getElementById('horae-diff-table')。
       本模块改成第四参 container；没给就用本模块自己的 id（见 _ledgerBox）。 */
    const box = _ledgerBox(container);
    if (!box) return;
    // ══ ★★★ v6.24.97【用户点名："面板没有显示我重roll的价格…我希望面板能如实统计"】══════════════
    //   用户原话："1.我现在郁闷的是 面板没有显示我重roll的价格　2.只要发给官方就烧钱，官方回没回是另一件事"
    //     ＋ "7~11轮的空缺不出意外应该在git有记载　我希望面板能如实统计 现在缺了重roll 有点滑稽"。
    //   现场（真数据，圣樱学院_mu5mwldwtk2h）：git 有 15 个提交、官方 usage 15 条**一条不少**，
    //     no=7 那次重 roll 的官方三数 hit 64,128 / miss 7,406 / out 1,578 / prompt 71,534
    //     就躺在盘上（usage.json 按 turn 号存，而每次重 roll 都占一个新 turn 号 ⇒ **从不互相覆盖**）。
    //   所以"缺了重roll"**不是数据丢了，是渲染把他花过的钱滤掉了**。
    //   ⚠ 与用户 §2 的硬口径一致：**官方没回来的行一律不进合计**（下面的 official(r) 那道闸一个字没改）。
    // ★ v6.24.100【一句话说清这三行】：
    //   stale = "这一发的内容已经不在当前聊天里了"（f ≥ L_now，可能是重 roll、也可能是删楼层）。
    //   这些行**照常显示**（那是真花过的钱，用户定版："一次请求一行，一次不缺"）⇒ shown 恒等于
    //   全部行、hidden 恒为 0。保留 shown/hidden 两个名字只为心跳/自检的口径不变。
    //   ⚠ chatLen 读不出来时（canJudgeStale 为假）所有行 stale=false —— 这是 v6.24.59 的护栏，
    //     那时面板会**全画**（宁可多画也不许因为读不到聊天长度就把整表藏起来）。
    const hidden = 0;
    const rerollRows = rows.filter(r => r.stale);
    const shown = rows;
    // ★ v6.24.59【诊断·查完必删】面板到底拿到了什么 —— 用户报"差异页压根没数据"，
    //   而 /log 明明回得来 4 个提交。唯一能把这件事钉死的是**渲染那一刻的数**：
    //   chatLen（当前聊天条数，stale 判定全靠它）＋ 每行的 floor/chatLenAt/stale。
    //   ⚠ 如果 chatLen 比记录里的 floor 还小，**所有行都会被判成"已被删除"**从而整表隐藏
    //   （表现就是"还没有可比对的轮次"，可记录一条没少）。
    /* ⛔ 摘掉：源文件这里往抓包插件的 _diag.log 上报一条 panel:diff 心跳（_diagReport）——
       那是 Horae 与它那几个诊断工具之间的通道，本模块不依赖 Horae。
       信息没丢：下面那两行仍然算出 rows / shown / hidden / rereoll 的个数，只是不再外发。
       （_currentChatKey 也只在这一块里用过。） */
    // v6.22（用户："删除这个tips"）：表下面**不再有任何说明段**。
    //   以前这里拼了四段：传入的 sourceNote（"git 提交 N 条 / 「本地」= … / 健康的一轮长这样 / 「费用」= …"）、
    //   隐藏轮数、老消息被改写的诊断、两个链接怎么点 —— 现在全删。
    //   留下来的只有**真出问题**时那一句（sourceNote 现在只装警告：记录服务没接上 / 内置服务版本旧），
    //   正常状态下表下面一个字都没有。想知道的细节都在**悬停**里（表头、每个格子都带 title）。
    const note = sourceNote;
    if (!shown.length) {
        // ★ v6.24.20：空表要分两种 —— **正在重取**（换聊天 / 点刷新之后那一小段）与**真的还没有轮次**。
        //   以前一律写"还没有可比对的轮次"，于是换聊天的那一瞬间会先弹一句假话（用户："我打开了新聊天文件"）。
        const loading = !note && !!buildingSinceAt2 && (Date.now() - buildingSinceAt2) < 30000;
        box.innerHTML = `<div class="horae-empty-hint" style="padding:14px;text-align:center;opacity:.7;">`
            + (loading
                ? '正在取这一场聊天的记录…'
                : '还没有可比对的轮次：发一条消息（并等官方 usage 回来）就会出现第一行。')
            + `</div>`
            + (note ? `<div style="padding:5px 7px;font-size:10px;opacity:.6;line-height:1.6;">${_gitEsc(note)}</div>` : '');
        return;
    }
    // 固定列宽 + table-layout:fixed → 列宽可控（关键列在前），数字列不会被某一列的长内容推着左右跑
    //   （v6.24.6 曾让最后一列 sticky 钉边，v6.24.99 按用户"跟其他单元格一样，别搞特殊"整段删掉，
    //     见下面 TH 之后那一段注释 —— 那张表本来就不横向滚）。
    const TH = 'padding:4px 6px;font-weight:600;font-size:10px;line-height:1.25;white-space:nowrap;border-bottom:1px solid var(--horae-border);background:var(--horae-bg-secondary);text-align:right;overflow:hidden;';
    const THL = TH + 'text-align:left;';
    // v6.23：**只有「断点位置」那一列许截断**（用户实测："除了断点位置外 我都不想被…简化"）。
    //   所以 base 里去掉了 text-overflow:ellipsis —— 别的格子宁可把列宽量准（每个单元格都真跑过
    //   scrollWidth ≤ clientWidth 的检查），也不许把命中率 100.0% 显示成「100.…」。
    //   overflow:hidden 只作兜底：万一窄窗口下真放不下，也不许压到隔壁格子上。
    // ══ ★★ v6.24.99【用户报的两个显示问题 + 用户定版"跟其他单元格一样，别搞特殊"】═════════
    //   问题①"断点位置的单元格背景不正常"：真浏览器逐格量出来的事实是 —— **数据行 12 格里
    //     只有第 12 格有底色**（rgb(15,13,22) = --horae-bg），前 11 格全是 rgba(0,0,0,0)。
    //     成因：那一列原来被当成"右粘性列"（STICKY_TD 给它涂不透明底 + 向左 8px 的模糊影），
    //     而这张表**根本不横向滚动** ⇒ 那层底色与那圈影就是屏幕上唯一一处特殊渲染。
    //     ⇒ **整段删掉**（含表头的 STICKY、数据格的 STICKY_TD、以及那个只为它加的表格 id）：
    //     最后一格现在走的是**和其余 11 格一模一样的** TD/TDL，没有任何 position/阴影/底色。
    //   问题②"断点位置与费用的分隔符不存在了"：分组线 SEP 一直在 DOM 里，
    //     消失是**被那圈向左 8px 的模糊影盖掉的** —— 影删了，线自己就露出来了。
    //   ⚠ 分隔线**恢复原样**（var(--horae-border)，与其余三条分组线、表头下边框同一套主题色）——
    //     用户点名"其他的别乱动"，所以不借这个机会换配色。
    const TD = 'padding:4px 6px;font-size:11px;white-space:nowrap;border-bottom:1px solid rgba(128,128,128,.18);text-align:right;overflow:hidden;';
    const TDL = TD + 'text-align:left;';
    const SEP = 'border-left:1px solid var(--horae-border);';
    // ── v6.24.6（用户："我刚改的排版／这样也更直观"）：**最后一列钉在右边** ──────────────
    //   实测（check/_layout_v6245.mjs，真 Chrome，941px 面板）：官方输出挪进官方那一组之后，
    //   前 10 列一共 774px 正好放得下，「断点位置」只剩 246px，而它那两句内容（"……"→"……"｜正常增量）
    //   要 380~700px —— 于是整张表横向滚，**数字列跟着内容一起左右跑**，看着就不直观了。
    //   ⚠⚠ **v6.24.99：v6.24.6 为此给那一列加的"钉在右边"（表头 STICKY + 数据格 STICKY_TD）
    //     整段删掉了** —— 用户定版原话："跟其他单元格一样，别搞特殊，都是一个表格别乱玩"。
    //     实测事实：面板 941px ≥ 表格最小宽 906px ⇒ **那张表从来不横向滚**，sticky 一次都没生效，
    //     留下的只有屏幕上一处特殊渲染：12 格里只有那一格有不透明底色
    //     （用户报的"断点位置的单元格背景不正常"），外加一圈向左 8px 的模糊影
    //     （它正好把「费用｜断点位置」之间那条分组线糊掉了 —— 用户报的"分隔符不存在了"）。
    //     ⇒ 现在最后一格走**与其余 11 格完全相同的** TD/TDL：没有 position、没有阴影、没有底色。
    //   ★ 删掉那段就不许再加回来：用户要的是"一个表格别搞特殊"，不是"把特殊渲染换个写法"。
    // v6.23：钱的说明全进悬停 —— 面板上「费用」那格是**三行**（绿 hit: / 红 miss: / 黄 out:），
    //   与概述行那三笔同一套颜色；v6.24.1 起三行都带标签（用户："别的都有 hit:、miss:。就输出没有名字"）。
    // ★ v6.24.60【用户："表格的所有悬浮提示也是啰嗦 删了也无所谓 你留简化提示就好 我都知道怎么算的"】
    //   下面这些常量原来是**排查时写给自己的长篇说明**（算法怎么来、实测多少、为什么官方偏高…），
    //   悬停一放就是几百字。现在一律压成**一句话**：只说"这一格是什么、数从哪来"，
    //   需要细看的（断点位置、与官方的差）留在格子里或那一格的短提示里。
    const TIP_COST = '这一轮的钱。三行从上到下：① 命中 × ¥' + _getPrice().hitIn + '/M　② 未命中 × ¥' + _getPrice().missIn + '/M'
        + '　③ 输出 × ¥' + _getPrice().out + '/M。命中/未命中优先用官方 usage。';
    const TIP_OUT = '官方输出 token（completion_tokens）。这部分不打折，钱在「费用」第三行。';
    // ★ v6.24.64【用户："它对比前一轮"】：官方那几格的第二行说的是**这一轮 vs 前一轮**，规则与
    //   「本地」那行同款（+ 红 / − 绿 / 0 灰，只给数字）—— 两个方向的差都在悬停里写明，别让人猜。
    // ★★ v6.24.73【用户 2026-09-17 定版："很无语 绿色是收益红色是损伤啊，乱标颜色"】：
    //   这条规则以前写的是"+ 红 = 这一轮比上一轮多，− 绿 = 少" —— 那是**数值方向**，不是**好坏方向**。
    //   命中和命中率是越高越好，于是那四列全标反了（命中涨了涂红、命中率掉了涂绿）。
    //   现在唯一口径：绿 = 收益，红 = 损伤，按这一列的好坏方向判（命中/命中率越大越好；
    //   请求/未命中/输出/合计/费用越小越好）；符号仍然只有 +/−/不画 三种。
    const PREV_RULE = '绿 = 收益，红 = 损伤（按这一列的好坏方向判：命中与命中率越大越好，'
        + '请求/未命中/输出/合计越小越好）。符号 +/− 只表示这一轮比上一轮多还是少。'
        + '差为 0（与上一轮一模一样）时这一行不画（没变化不是信息）。'
        + '（上一轮还没出账 / 它就是第一轮 → 也不画，不拿 0 顶。）';
    const TIP_RATE = '官方命中率 ＝ 命中 ÷ (命中 ＋ 未命中)。'
        + '文字颜色 = 0%（红）→ 100%（绿）的线性 RGB 渐变（t = 命中率 ÷ 100 直接混色），一眼看出这一轮缓存命中有没有问题。'
        + `\n【第二行】与上一轮比的是百分点（+3.2% ＝ 这一轮高 3.2 个点，数字后面的 % 就是"点"）。${PREV_RULE}`;
    // ★ v6.24.50（用户定版）：「本地」三列的抬头悬停 —— 唯一那套算法（服务端 lcpOfTurns，面板一个字不算）。
    const MY_RULE = '拿这两轮的记录正文（turns/NNNNN.txt）逐字节比：相同的开头长度 = lcp，'
        + '这一轮总长 − lcp = miss，合计 = lcp + miss = 这一轮总长。'
        + '服务端现算、面板一个字不算（全项目只有这一处算法）。';
    // ★★ v6.24.76【用户 ⑩ 定版："我的要求是0偏差"】：本地那一组的合计不再是"推算"——
    //   它是服务端拿酒馆那份真 DeepSeek 分词器、在盘上那份真出网原文上现算的 prompt token，
    //   与官方 prompt_tokens 实测 21/21 轮逐位相等（差 0）。所以下面这句口径也要跟着改，
    //   不能再写着"本地推算、官方回来后会标出差多少"—— 那是旧行为，现在第二行常态就是 0。
    const MY_VS_OFF = '官方是权威：左边那三列取自 API 的 usage。这一组的合计是服务端在盘上那份'
        + '真出网原文上用酒馆那份分词器现算的（同一串字、同一套分词），与官方 prompt_tokens 应差 0；'
        + '第二行不是 0 就说明出网原文被改写 / 模型词表换了 / 这一轮的分词器没接上，先查那三条。';
    const TIP_MY2 = `本地未命中 ＝ 这一轮总长 − lcp。${MY_RULE}`;
    const TIP_MY3 = `本地合计 ＝ lcp ＋ 未命中 ＝ 这一轮总长；token 那一份由服务端在盘上那份真出网原文上现算`
        + `（与官方 prompt_tokens 同一个口径，应差 0）。${MY_RULE}`;
    const TIP_MY1 = `本地命中 ＝ lcp（与上一轮逐字节相同的开头长度）。${MY_RULE}`;
    // ★ v6.24.64【用户："还有本地计算的命中率"】：本地命中率单占一列了（以前只藏在「本地合计」的悬停里），
    //   颜色与「官方命中率」同一根轴（0% 红 → 100% 绿，_diffPctColor），下面那一行是与上一轮比的百分点。
    const TIP_MY4 = `本地命中率 ＝ 本地命中 ÷ 本地合计（与上面那三列同一套数、同一个入口）。`
        + `\n颜色与「官方命中率」同一根轴：0%（红）→ 100%（绿）线性 RGB 渐变。`
        + `\n【第二行】与上一轮比的百分点差（+3.2% ＝ 这一轮高 3.2 个点）：+ 红 = 这一轮高 / − 绿 = 这一轮低；`
        + `差为 0 时那一行不画。`;
    // v6.23：列宽重新量过（见 check/_panel_fit.mjs：每个单元格 scrollWidth ≤ clientWidth）——
    //   命中率两列 48→54px（100.0% 就是被 48px 截成「100.…」的），输出那列 58→46px（钱搬去「费用」了），
    //   「费用」74px（要放下「miss:¥0.0519」这一行）。v6.24.2 起「替换费用」列删掉 → 它那 74px 归「断点位置」。
    //   v6.24.5：输出那一列挪到官方三列之后并改名「官方输出」（它跟官方命中/未命中/命中率同出一份官方
    //   usage），列宽 46px 一个字没动（「官方」比「AI」宽，实际仍在 46px 内 —— 真 Chrome 逐格量过）。
    //   这些数是基线：真放不下时 _diffFitColumns 会在真浏览器里量出缺口、从「断点位置」那列补过来。
    //   v6.24.38（用户定版）：**请求 token 拆成两列** ——
    //     「官方请求Token」= 官方 usage 的 prompt_tokens（**权威**，官方还没回来时给 —）；
    //     「本地请求Token」= 本地用酒馆分词器数**出发那一刻那串字** + 模板开销（每条 2 + 整串 21；口径与官方对齐，见 PROMPT_OVERHEAD_TOK）。
    //     两列都不许被截断（与其余数字列同一条纪律）。
    // ★ v6.24.60【用户："(tok) 别写啊 正常的标题名就行非要追加(tok)"】列名就写**正常标题**，
    //   不在后面追加单位标记（(字) / (tok) 都不加）—— 单位在哪一列是什么，悬停里已经说了。
    // ★ v6.24.62【用户："这列连分隔符一起删了 也就是官方之间无分隔"】—— 两条一起做的：
    //   ① **删掉「本地请求」那一整列**。它是 v6.24.38 拆出来的，而 v6.24.61 把「本地合计」
    //      改成本地自己数出来的 token 之后，**这两列就是同一个数**（用户截图里 88,911 / 88,911 并排），
    //      留着只是重复；那个"与官方的差"（+58）在「本地合计」那一格照样有。
    //   ② **「官方」那五列之间不再画竖分隔线**（原来"官方命中"左边有一条）——
    //      分组靠线表达：官方一组、本地一组、费用、断点位置，**组内不画线**。
    // ★★ v6.24.64【用户："排版问题 按 合计 | 命中 | 未命中 | 命中率 的列顺序排" ＋ "还有本地计算的命中率"】：
    //   两组现在**形状完全一样**，读法一致（左边官方=权威，右边本地=本地推算）：
    //     官方：  请求(＝命中＋未命中，就是 prompt_tokens) | 命中 | 未命中 | 命中率 | 输出
    //     本地：合计(＝命中＋未命中，就是这一轮总长)   | 命中 | 未命中 | 命中率
    //   ⇒ 「本地」那一组从**旧序 命中|未命中|合计** 改成 **合计|命中|未命中|命中率**，
    //     并**把本地命中率补成一列**（以前只在「本地合计」的悬停里，用户："还有本地计算的命中率"）。
    //   ⚠ 「官方请求」没改名：它就是 prompt_tokens（合计），名字是用户看惯的那个；
    //     本地那组的"请求/合计"本来就叫「本地合计」（v6.24.5 起），两组各用各的叫法。
    /* ★★★★★★ v6.39.0【实验算法的**面板标记** —— 用户 2026-09-19："一旦切换算法 你必须标记颜色或者实验提示"】
     *   ── 为什么"只换数不标记"不可接受（这不是审美问题）──────────────────────
     *     这张表上**同时坐着两套口径**：官方那五列是**真值**（那一发请求真花掉的），
     *     「本地」那四列在实验模式下是**另一条链算出来的**。不标记的后果不是"不好看"，
     *     是用户会把实验值**当成这一轮真实发生的本地命中**去跟官方对账 —— 那等于编数。
     *   ── 标记三条（缺一条都会被看漏）──────────────────────────────────────────
     *     ① 表头这一组染紫 ＋ 写「本地·实验」（一眼看到这一列不姓"本地"了）；
     *     ② 下拉框旁边的常驻提示（_expAlgoPaintBtn 画 horae-diff-exp-note）；
     *     ③ 每行那三个入口前面挂 🧪（_dvLinks）。
     *   ⚠ 紫色是**实验专用色**，绝不借红/绿 —— 那两个已经被定义成"损伤 / 收益"（v6.24.62 定版：
     *     "颜色只有一个含义"）。
     *   ⚠⚠【默认路径一个字节都不许变】用户："不能瞎改 我只要不切换下拉框的算法，就必须维持原样"。
     *     开关关着 ⇒ EXP_HEAD_TXT = '本地'、EXP_HEAD_CSS = ''、EXP_TIP = ''
     *     ⇒ 拼出来的表头与改动前**逐字节相同**。 */
    /* ⛔ 降级（依赖换来源）：源文件这里读 _expAlgoOn() 与 _expAlgoNameNow()（实验算法管线）。
       那两条链没搬 => 按源文件里"实验模式关着"的默认路径把它固定下来：
       EXP_HEAD_TXT 恒为 '本地'、EXP_HEAD_CSS 与 EXP_TIP 恒为空串 ——
       这正是开关关着时的逐字节行为（表头与源文件那一版相同）。 */
    const _expOn = false;
    const EXP_HEAD_CSS = '';
    const EXP_HEAD_TXT = '本地';
    const EXP_TIP = '';
    const head = `<tr>`
        + `<th style="${THL};width:78px;" title="楼层号（与酒馆里的 #N 一致）。下面小字：第几轮 + 发送时间，再下面是「原文↗ / 同上轮↗ / 池化↗ / 输出↗ / 同轮↗ / 跟上轮↗」六个入口，末尾那个 ⛓ 版本号 = 这一轮真发出去的那一发是由哪条管线组合装出来的（点它看完整的复现链：raw 原文 ＋ 这条管线 ⇒ 这一发 ⇒ 官方那五列）。最近的排第一行">楼层</th>`
        + `<th style="${TH}${SEP};width:64px;" title="官方 usage 的 prompt_tokens（权威值，单位就是 token）。官方还没回来时给 —；与「本地合计」那一格第二行的差就是它俩之差（本地 − 官方）。下面那一行：与上一轮比。${PREV_RULE}">官方<br>请求</th>`
        + `<th style="${TH};width:52px;" title="官方 usage 的 prompt_cache_hit_tokens。下面那一行：与上一轮比。${PREV_RULE}">官方<br>命中</th>`
        + `<th style="${TH};width:56px;" title="官方 usage 的 prompt_cache_miss_tokens。下面那一行：与上一轮比。${PREV_RULE}">官方<br>未命中</th>`
        + `<th style="${TH};width:54px;" title="${_gitEsc(TIP_RATE)}">官方<br>命中率</th>`
        + `<th style="${TH};width:46px;" title="${_gitEsc(TIP_OUT + ' 下面那一行：与上一轮比。' + PREV_RULE)}">官方<br>输出</th>`
        + `<th style="${TH}${SEP}${EXP_HEAD_CSS};width:52px;" title="${_gitEsc(TIP_MY3 + EXP_TIP)}">${EXP_HEAD_TXT}<br>合计</th>`
        + `<th style="${TH}${EXP_HEAD_CSS};width:52px;" title="${_gitEsc(TIP_MY1 + EXP_TIP)}">${EXP_HEAD_TXT}<br>命中</th>`
        + `<th style="${TH}${EXP_HEAD_CSS};width:56px;" title="${_gitEsc(TIP_MY2 + EXP_TIP)}">${EXP_HEAD_TXT}<br>未命中</th>`
        + `<th style="${TH}${EXP_HEAD_CSS};width:54px;" title="${_gitEsc(TIP_MY4 + EXP_TIP)}">${EXP_HEAD_TXT}<br>命中率</th>`
        + `<th style="${TH}${SEP};width:74px;" title="${_gitEsc(TIP_COST)}">费用</th>`
        + `<th style="${THL}${SEP}" title="断点在第几楼、断点附近那一小段。要看实际差异点，点这一格下面的「同轮↗ / 跟上轮↗ / 同上轮↗」">断点位置<br><span style="opacity:.6;">（悬停看详情）</span></th>`
        + `</tr>`;
    // ★ v6.24.62【用户："单元格的数值渲染 统一风格啊 有些有颜色 有些没有"】顺手清掉同一类东西：
    //   「断点位置」那一列原来拼的是 kindColor[kind]，而它的值是**裸色值**（#e07070）——
    //   拼进 style="…;#e07070" 是**非法声明**（少了 color:），也就是说那套着色**从来没生效过**。
    //   现在整表颜色只有一个含义（第二行的差异方向），文字列也不上色；只留 opacity 那两档
    //   （第一轮 / 没有数据 → 淡一点），那是"有没有数"的语义，不是"好/坏"。
    const kindDim = { first: 'opacity:.72;', na: 'opacity:.72;' };
    /* ★ 2026-09-24：轮号 -> 提交 sha（楼层格底下「同上轮↗ / 跟上轮↗」要用**轮号小 1 那一轮**的 sha）。
     *   为什么不能拿数组前一行：重 roll 之后"数组里前一个"与"轮号小 1 的"不是同一发
     *   （这一段上面 v6.24.97 那段注释写过同一件事）⇒ 判据一律用轮号。 */
    const shaByTurn = new Map();
    for (const _r of shown) {
        if (!_r || _r.turn === null || _r.turn === undefined) continue;
        const _n = Number(_r.turn);
        if (Number.isFinite(_n) && _r.sha) shaByTurn.set(_n, String(_r.sha));
    }
    // v6.11：楼层**倒序** —— 最近的一轮排第一行，越久远越靠后（算的时候仍然是旧→新，这里只倒显示顺序）
    const body = shown.slice().reverse().map((r, ri) => {
        // ★ v6.24.64【用户："它对比前一轮"】这一行的**前一轮**是谁 —— shown 是旧→新，这里倒着显示，
        //   所以第 ri 行对应 shown 里的第 (len-1-ri) 个，它的前一轮就是再往前一个。
        //   官方那几格（请求/命中/未命中/输出/命中率）的第二行要拿它做对比。第一轮没有前一轮 → null。
        const prevRow = (shown.length - 1 - ri) > 0 ? shown[shown.length - 2 - ri] : null;
        const no = _diffTurnNo(r);
        const gitMark = r.fromGit ? '' : `<span style="opacity:.45;font-size:9px;" title="这一轮 git 里还没有提交，数据来自运行记录">·</span>`;
        // v6.24.17（用户："老实黄字提醒（等待流生成结果）"）：这一轮**还在流式生成**（官方 usage 没回来）时，
        //   这一行不给任何数（官方三列本来就是 —），楼层下面挂一句黄字提醒 —— 与概述行末尾那一句同一套字。
        const wait = r.pending
            ? `<span style="color:#e0c060;font-size:9px;display:block;white-space:nowrap;" title="请求已发出、回复还在流式生成，官方 usage 还没回来">等待流生成结果…</span>`
            : '';
        // 主标签用**聊天里的楼层**（#9 就是酒馆里那个 #9），副标签才是第几轮 + 时间
        /* ★ 2026-09-24【用户点名："加个重算按钮在红圈处（单元格第一行 楼层右边）"
         *   ＋ "这样也能手动重算此楼层的文档结构"】⇒ 楼层号右边挂一颗「重算」：
         *   点它 ＝ **手动触发同一条自愈路**（`globalThis.hitOpt.recalcTurn(no)`）——
         *   插件用本地算法把这一场缺的池化结构（A/B0/B/C）重算出来、写回盘上。
         *   ⚠ 如实说清两件事（悬停里）：① ⛔ 它**不动已经发出去的那串字**；
         *     ② 因此它**不会改变这一格的历史命中率**（那一发是既成事实，钱已经花了）——
         *        它修的是"盘上缺的那份结构"，让重放 / 核对 / 差异页重新读得到。
         *   ⚠ 事件用**委托**（`index.js` 里一次绑在 document 上）：这一格是 HTML 字符串画的，
         *     而本项目禁 inline onclick（不赌宿主 CSP 放不放）。 */
        const recalcBtn = `<button data-hlg-recalc="${Number(no)}"`
            + ` title="重算这一轮的池化结构（A/B0/B/C）并写回盘上 —— 与自动自愈同一条路。`
            + `⛔ 不动已经发出去的那串字，所以也不会改变这一格的历史命中率（那一发是既成事实）。"`
            + ` style="margin-left:4px;font:inherit;font-size:8px;line-height:1;padding:1px 4px;`
            + `border:1px solid rgba(128,128,128,.45);border-radius:3px;background:rgba(128,128,128,.16);`
            + `color:#cfd6e6;cursor:pointer;vertical-align:middle;">重算</button>`;
        /* ⚠⚠ 2026-09-24【这里踩过一次，记着】：下面 `tCell` 里 `main` 会被 `_gitEsc()` **转义**，
         *   所以**按钮绝不能拼进 main** —— 拼进去就变成一串文字（`&lt;button…&gt;`），
         *   页面上根本没有按钮（用户当场问的："还有 按钮呢"）。
         *   ⇒ 正文与按钮**分开**：`mainText` 走转义，`recalcBtn` 作为独立片段拼在转义**外面**。 */
        const mainText = r.floor !== null && r.floor !== undefined ? `#${r.floor}` : `第${Number(no) + 1}轮`;
        const sub = r.floor !== null && r.floor !== undefined ? `第${Number(no) + 1}轮 · ${r.at || ''}` : `#${no} · ${r.at || ''}`;
        // ══ ★★★ v6.24.98【一次请求一行：那一行标的是"它已经不在聊天里"】════════════════════════
        //   用户两次纠正定版（原话）："面板没有显示我重roll的价格…我希望面板能如实统计 现在缺了重roll 有点滑稽"
        //     ＋ "不止哦 我的意思是 **面板应该是多少轮多少行**哦　你说改完就多3行，我可不认！"
        //   ⇒ 面板对**每一次真实发出去的请求**都要有一行（行数 = 提交数 = turns/ 文件数 = usage.json 键数）。
        //   这一行标出来的语义是**"它的内容已经不在当前聊天里了"**（判据 f ≥ L_now）——
        //   不是"删除楼层"的同义词（那种行 f < L_k，本来就在这条判据之外）。
        const reMark = r.stale
            ? `<span style="color:#e0c060;font-size:9px;display:block;white-space:nowrap;"`
                + ` title="这一发已经不在当前聊天里了：它落在第 ${r.floor} 楼，而聊天现在只有 ${r.chatLenNow} 条`
                + `（楼层 0…${r.chatLenNow - 1} 还活着）⇒ 这一楼被回滚掉了（重 roll / 重发）。`
                + `但它真的发出去过、真的花过钱（官方 usage：命中 ${r.hit ?? '—'} / 未命中 ${r.miss ?? '—'} / 输出 ${r.out ?? '—'} tok），`
                + `所以照样画一行、照样进合计，并在上面单列一笔「已回滚 花掉」。">⟲ 已回滚</span>`
            : '';
        // ══ ★★ v6.25.1【用户第 17 轮原话："正常推进、原地重roll、删改楼层roll、…之类的 是对于每一轮 我都能看到
        //   他在干嘛？ 实际 diff 对比前一轮的是什么轮？" ＋ "给我放这里，别放断点那里"】═════════════════════
        //   这一格（楼层格）加**两行小字**，都只用**盘上读得到的数**，一个新字段都不造：
        //     ① actMark  = 这一轮在干嘛 —— 判据只有两个：记录里的楼层（/log 的 floor）＋ 提交标题里的 swipe。
        //     ② baseMark = 「差异↗」那一页 a 侧真正读的那份文件（turns/<no-1>.txt）—— 与 _diffViewOpen
        //                  里的 fA **同一个式子**，所以面板这一行与差异页抬头那行**逐字对得上**。
        //   ⚠⚠ 一件必须如实说的事（用户第 5 条：拿不到证据就如实说，不许编）：
        //     用户定版过的口径是"**前文件 = 池化系统实际挑中那一份**"。而池化挑中的那份**没有落盘** ——
        //     它在"拼提示词那一刻"只活在内存里（_prevMsgsPickBest 的返回值），发完就没了。
        //     ⇒ 事后（用户点开面板／差异页这个时候）**物理上取不到**。所以这里写的是"差异页真正读的那一份"，
        //     并在悬停里把这件事说明白 —— 绝不写一个"看着像、其实不是"的轮号顶上。
        //     （要做到面板显示池化那份，唯一办法是**在发请求那一刻把挑中的候选记一行台账**；
        //       那要碰记录链 ⇒ 属于"后台"，用户 2026-09-18 明确的红线之外，得他点头才做。）
        const actText = (() => {
            if (!prevRow) return '第一轮';                    // 这一场的第一发：前面没有可比的那一轮
            if (r.swipe) return '重 roll';                    // 服务端认出来的"重新生成"
            const f0 = (prevRow.floor === null || prevRow.floor === undefined) ? null : Number(prevRow.floor);
            const f1 = (r.floor === null || r.floor === undefined) ? null : Number(r.floor);
            if (f0 === null || f1 === null || !Number.isFinite(f0) || !Number.isFinite(f1)) return '';   // 认不出就不写
            if (f1 === f0) return '同层重发';                  // 同一楼又发了一发（原地重 roll / 改了再发）
            if (f1 < f0) return '删楼重发';                    // 楼层被删到这一楼之后重发
            return '正常推进';                                 // 新楼层
        })();
        const actTip = '这一轮在干嘛 —— 只用盘上读得到的两个数判：① 记录里的楼层（/log 的 floor）；'
            + '② 服务端在"重新生成"那一发的提交标题上写的 swipe。'
            + '\n· 正常推进 = 楼层比上一行大（新发一楼）'
            + '\n· 同层重发 = 楼层与上一行相同（同一楼又发了一发）'
            + '\n· 删楼重发 = 楼层比上一行小（楼层被删到这一楼之后重发）'
            + '\n· 重 roll = 服务端把这一发认成重新生成（提交标题写着 swipe）'
            + '\n⚠ 重 roll 时服务端会把上一个提交回滚掉、并复用轮号 ⇒ 这里看到的是回滚之后的序列，'
            + '所以"重 roll 过几次"从盘上数不出来（被顶掉那几发连记录一起没了）。';
        const actMark = actText
            ? `<span style="opacity:.55;font-size:9px;display:block;white-space:nowrap;"`
                + ` title="${_gitEsc(actTip)}">${_gitEsc(actText)}</span>`
            : '';
        // 「差异↗」那一页 a 侧真读的那份文件 —— 式子与 _diffViewOpen 的 fA 一个字不差（No.1 行右边那句也是它）
        const baseFileNo = Math.max(0, Number(no) - 1);
        const baseTip = '差异页 --- 那一侧真正读的文件：turns/'
            + String(baseFileNo).padStart(5, '0') + '.txt`。面板这一行与差异页抬头那一行逐字同源（同一个式子）。'
            + '\n⚠ 池化系统（挑"前文件"提示词那一套）按最长公共前缀在候选里另挑一份 —— 那一份没有落盘：'
            + '它只在拼提示词那一刻活在内存里，事后取不到 ⇒ 这里不显示它，也不拿一个"看着像"的轮号顶上。'
            + '\n【两处红绿分别对谁】① 官方那组各格第二行 = 与上一行（数组里前一轮）比；'
            + '② 「本地」组的第二行 = 本地 − 官方（同一轮的两个口径之差）。两个都跟这里这个基准文件无关。';
        /* ★ v6.36.0【用户 2026-09-19 点名："还有这里的比 xxxx.txt 你踏马的是对比第几轮！！！！！！"】
         *   旧文本只有光秃秃一个 比 00001.txt —— 看不出那是第几轮（文件名 0 起算、轮号 1 起算，
         *   两个口径差一，用户看到 00001 会以为是第 1 轮，其实是生成 00001.txt 时的第 2 轮那条要求）。
         *   ⇒ 按项目定版口径写全：**比 00001.txt（生成时的第 2 轮）** —— 括号里那个号与面板
         *     「本轮 · 第 N 轮」同口径（＝文件名编号 ＋ 1）。 */
        const baseMark = `<span style="opacity:.55;font-size:9px;display:block;white-space:nowrap;"`
            + ` title="${_gitEsc(baseTip)}">比 ${_turnName(baseFileNo)}（生成时的第 ${baseFileNo + 1} 轮）</span>`;
        const tCell = `<span style="font-weight:600;">${_gitEsc(mainText)}</span>${recalcBtn}${gitMark}`
            + `<span style="opacity:.45;font-size:9px;display:block;">${_gitEsc(sub)}</span>`
            /* ════════════════════════════════════════════════════════════════════════════
             * ★★★ 2026-09-24【用户报的 UI 缺失：这一格底下原来一个 ↗ 都没有】
             *   这里原来是一句注释 ＋ 一个空串：源文件的 _dvLinks(r) 被整块摘掉
             *   （它开的是 Horae 的差异页 _dvPage 与实验算法产物，整条链都没搬）⇒
             *   用户看到的就是"没有按钮"。用户原话：
             *     "嗯 但是没有按钮　之前的按钮分两排　放到单元格行内的第5行第6行吧
             *      　第一行是文档，第二行是对比"
             *   现在换成**本模块自己实现**的两排入口（见 _ledgerTurnLinks 那段注释）：
             *     第 5 行（第一排，横排 4 颗）＝ 原文↗ 同上轮↗ 池化↗ 输出↗；
             *     第 6 行（第二排，横排 2 颗）＝ 同轮↗ 跟上轮↗。
             *   ⚠⚠ **落点钉死在四行文字的正下方**（用户点名"第5行第6行"，而那一格前四行是
             *      #楼层 / 第N轮·时间 / 在干嘛 / 比哪一份）。所以它排在 reMark / wait **之前** ——
             *     那两句是**警告**（⟲ 已回滚 / 等待流生成结果…），只在部分行出现；
             *     要是把入口放在它们后面，出警告的行里入口就整体下移了，
             *     与用户点名的"第5行第6行"对不上。警告顺次落进第 7 行，仍然同一个格子里。
             *   ⚠ 全是普通链接；两排各包一层 flex（横排）＋ 字号 9px ⇒ **不撑宽这一列**
             *     （实测表宽 906 一分不变，见 _notes/hitOpt-输出按钮.md）。
             *   ⛔ 不碰任何数值、不碰"发出去的那串字" —— 纯多几个只读入口。
             * ════════════════════════════════════════════════════════════════════════════ */
            + `${actMark}${baseMark}${_ledgerTurnLinks(r, shaByTurn, shown)}`
            + `${reMark}${wait}`
        // 官方命中 − 本地命中：0 = 推算与官方一致；差值大就在这里点出来（不再单占一列）
        //  v6.19（用户实测问到的）：**官方比「本地」高是正常的，不是算错** ——
        //   「本地」只拿**上一轮那一条** request 逐字比，所以它是**下限**；
        //   官方数是缓存里**任何一条**更早的 request 都算命中（DeepSeek 的前缀缓存是全局的、按账号共用），
        //   实测第 2 轮：本地 17.8K，官方 37.9K —— 因为同一个聊天更早那条 request
        //   （旧版本发出去的、骨架相同的提示词）前 38.0K tok 与这一轮逐字一样，缓存直接给了。
        // v6.21：这一段（官方 vs 本地 / 记录 vs 官方 prompt）只说给**悬停**听 —— 表格里不再铺开
        let gapNote = '';
        if (r.gapHit !== null && r.tok > 0 && Math.abs(r.gapHit) > Math.max(8, r.tok * 0.01)) {
            gapNote = r.gapHit > 0
                ? `官方比「本地」多命中 ${Math.abs(r.gapHit)} tok（本地只跟上一轮比，是下限；官方把缓存里任何更早那条 request 的前缀也算命中）`
                : `官方比这里算的少命中 ${Math.abs(r.gapHit)} tok（上一轮那段前缀没能整体命中：缓存被别的请求挤掉，或断点比预估更靠前）`;
        }
        // v6.8 / v6.16：记录逐条之和 vs 官方 prompt_tokens（同样只进悬停）
        let promptNote = '';
        if (r.promptGap !== null && r.offPrompt > 0 && Math.abs(r.promptGap) > Math.max(64, r.offPrompt * 0.015)) {
            promptNote = `本轮记录逐条之和比官方 prompt ${r.promptGap > 0 ? '多' : '少'} ${_diffTok(Math.abs(r.promptGap))} tok（记录已经是 POST body 里的 messages；还差说明有插件在记账之后又改了提示词，「本地」这几列要打折看）`;
        }
        // ── 费用：**三行钱**（v6.23 用户定版）—— 绿 hit:（命中×缓存价）、红 miss:（未命中×全价）、黄 out:（输出×输出价）
        //   · 三行用的是**同一套 token**：命中/未命中官方 usage 优先，没有官方值时才用「本地」。
        //   · 第三行 v6.24.1 按用户要求补上 out: 标签（"别的都有 hit:、miss:。就输出没有名字"），三行齐名。
        //   · v6.24.4：三行**都不再带 ≈**（用户实测："它里面的 hit 不用约等于符号，看起来很怪异"）——
        //     那一格原来只有第一行带 ≈（v6.17.1 缩到 9px 防挤），三行里就它一个带符号反而更扎眼；
        //     是不是"本地"照旧写在悬停的依据里（costTip 最后一句），面板上不再标。
        //   · v6.22 那版把输出这笔放在「AI 输出」列的小字里，v6.23 按用户要求挪回本列第三行。
        //   ★ v6.24.50（用户定版）：**官方 usage 缺 → 这一格显示 —，且不参与任何合计**。
        //     以前这里会退回「本地」接着算钱 —— 那张表顶部"总费用/命中/丢失/输出"就会把
        //     "本地推算出来的钱"当成真钱加进去（用户口径："官方是权威，本地瞎写的自嗨没用"）。
        //     于是：这一格的钱**只认官方 usage**；要跟本地那三列比，去看那三列的悬停。
        const pNow = (r.cost && r.cost.price) || _getPrice();
        const oTok = Number.isFinite(Number(r.out)) ? Number(r.out) : null;
        const yuanOf = (tok, unit) => (tok === null ? null : Number(tok) * Number(unit || 0) / 1e6);
        const hitYuan = yuanOf(r.hit, pNow.hitIn), missYuan = yuanOf(r.miss, pNow.missIn), outYuan = yuanOf(oTok, pNow.out);
        /** 一行钱：颜色 + 标签 + 金额（没有这一笔就给 —）。三行都是 block，右对齐跟着整列走。 */
        const moneyLine = (color, label, v) => `<span style="display:block;white-space:nowrap;font-weight:600;font-size:9.5px;line-height:1.45;color:${color};">`
            + `${label}${v === null ? '—' : _diffYuan(v)}</span>`;
        const costTip = r.cost
            ? `这一轮实际花的钱（三行）：命中 ${_diffTok(r.hit)} tok × ¥${pNow.hitIn}/M ＝ ${_diffYuan(hitYuan || 0)}；`
                + `未命中 ${_diffTok(r.miss)} tok × ¥${pNow.missIn}/M ＝ ${_diffYuan(missYuan || 0)}；`
                + `输出 ${_diffTok(oTok)} tok × ¥${pNow.out}/M ＝ ${_diffYuan(outYuan || 0)}。`
                + `合计 ${_diffYuan(r.cost.total)}（${pNow.label}时段）；命中/未命中全部取自官方 usage（权威值）。`
                + `${r.myHit === null ? '' : '左边「本地」那三列是本地推算（公共前缀），要看它们的钱就按同一套单价乘一下 —— 这一格不混着用。'}`
            : (r.pending
                ? `这一轮的官方 usage 还没回来（回复还在流式生成）→ 这一格与顶部汇总里都不给数（显示 —、不计入合计）。`
                    + `等它出账，这一行与汇总自己就填上真数（不在这一格里混用「本地」的数）`
                : '这一轮没有官方 usage → 这一格显示 —，也不计入顶部汇总（官方是权威，本地推算不当钱用）');
        const costCell = r.cost
            ? `${moneyLine('#7dd87d', 'hit:', hitYuan)}`
                + `${moneyLine('#e07070', 'miss:', missYuan)}`
                + `${moneyLine('#e0c060', 'out:', outYuan)}`
            : `<span style="opacity:.55;" title="${_gitEsc(costTip)}">—</span>`;
        // ── 官方输出（v6.24.5 前叫「AI 输出」）：只留 token 数（钱在「费用」第三行，v6.23 搬过去了），精确值在悬停里
        const outTip = oTok === null
            ? '这一轮的输出 token 还没有：官方 usage 没回来，回复也可能还在生成'
            : `官方输出 ${_diffTok(oTok)} tok（这一轮回复的长度，官方 usage）＝ ${_diffYuan(outYuan || 0)}（输出 × ¥${pNow.out}/M，${pNow.label}时段）；`
                + '这笔钱写在「费用」那一列的第三行（黄色）。输出的钱跟缓存无关，任何时候都不打折。';
        // ★ v6.24.62【用户："单元格的数值渲染 统一风格"】这里原来套了一层 <span style="opacity:.85;">
        //   （+ 单元格本身也有 opacity:.85）—— 同一张表里只有这一格淡一点，属于"有些有颜色/有些没有"
        //   的同一类不一致。现在数值格一律同一个前景色、同一个不透明度（缺数的格子除外：
        //   官方请求那格在官方没回来时整格 opacity:.55，那是"这一格空的"的语义，保留）。
        const outCell = _diffTok(r.out);
        // ── 替换费用：v6.24.2 起**表里没有这一格了**（用户："删除替换费用列"）。
        //   这一轮"如果换上本地摘要会花多少"的账仍然照算（row.plan = _diffReplacePlan(...)，见 _diffBuildRows），
        //   但只在**概述行末尾那一个数**（盈亏，见 _diffStatusHtml）和它的悬停里露面：
        //   表里少了这一列 → 「断点位置」那列自动多 74px，一格都不用再挤。
        // v6.21：断点这一列只留一句短的 —— 明细和计价都搬到悬停里，整行不再被这一格撑高
        const brkIdx = Number.isFinite(Number(r.lcpItem)) ? Number(r.lcpItem)
            : ((r.d && Number.isFinite(Number(r.d.breakIdx)) && r.d.breakIdx >= 0) ? Number(r.d.breakIdx) : -1);
        // ★ v6.24.37（用户第四次点名，原话）："第四次要求你删除的断点位置的 diff 超链接 你踏马的就是不删除"。
        //   前两次都删错了对象：v6.24.35 删的是**概述行**的 差异↗，v6.24.37 又删了**表格每一行**的 差异↗；
        //   用户指的是**这一格**——「断点位置」列里那个字面写着 diff↗ 的锚点。它一直在这里，一直没人动过。
        //   现在整个删掉：这一格只留纯文字（断点理由仍在悬停里），**这一格**再没有任何 diff↗ 链接。
        //   ★ v6.24.43 现状（别再把这几处混在一起）：页面上活着的两个 diff 入口是 ——
        //     ① 表格**每一行**楼层下面的「差异↗」（相邻两轮）；② 「替换费用」旁边那个「差异↗」
        //     （这一轮真 request ↔ 换上之后）。**「断点位置」这一格**仍然是纯文字，谁也不许再加回来。
        //   注意：brkIdx 与它上面那段 reason 文本一个字没动 —— 删掉的只是那个 <a>。
        const reasonTip = [r.reason.detail, gapNote, promptNote].filter(Boolean).join('；');
        // ══ ★ v6.24.51：「本地」三列的**唯一口径说明 + 与官方的差**（用户定版）══
        //   用户原话："官方值在 → 三列后面标注差多少；官方值没回 → 三列照 lcp 显示但标「（官方未回）」"。
        //   这三个数出自唯一那个入口（服务端 lcpOfTurns → /log 的 lcpChars/missChars/totalChars）：
        //   公共前缀（字）／未命中（字）／合计（字）—— **面板上一格一个字都不缩写、不做换算**，
        //   单元格里那几个数字就是 node check/prefix_test.mjs 打印的那几个数字（验收口径就这一条）。
        //   token 那一侧的折算值只出现在悬停里（说明"官方 miss 是多少 tok"这类话时才用）。
        const isZi = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)));
        // 官方命中折回字（按**官方自己的** prompt_tokens ÷ 这一轮总字数，与断点位置那一列同一个折法）
        const offChars = (isZi(r.hit) && isZi(r.offPrompt) && Number(r.offPrompt) > 0 && isZi(r.myCharTotal))
            ? Math.round(Number(r.hit) * Number(r.myCharTotal) / Number(r.offPrompt)) : null;
        const gHitZi = (offChars !== null && isZi(r.myCharLcp)) ? offChars - Number(r.myCharLcp) : null;
        const sign = (n) => `${n > 0 ? '+' : (n < 0 ? '−' : '')}${Math.abs(n).toLocaleString('en-US')}`;
        // ★ v6.24.61【用户定版】「本地」那几格的**第二行 = 与官方 usage 同项的差**（本地 − 官方），
        //   + 红、− 绿、相等写 0，**只给数字**。用户原话：
        //   "单元格第二行 写上差异数（与官方usage） 注意格式是+-红绿 数字就行 别搞太复杂"。
        //   为什么是「本地 − 官方」：这一格叫"本地"，第二行说的是**我这个数偏了多少**；
        //   而且 AGENTS.md 那份对账表（+58 = 2×条数）就是这个方向，面板与它对得上。
        //   官方那一边没有数（usage 没回来）→ **不画**第二行（官方列本来就在显示 —，再画一个"差 —"是废话）。
        // ══ ★★ v6.24.73【用户 2026-09-17 定版："很无语 绿色是收益红色是损伤啊，乱标颜色"】══
        //   以前全表只有一条规则：**数值涨了涂红、落了涂绿** —— 那是把"数值方向"当成了"好坏方向"。
        //   可这张表里**命中和命中率是越高越好**（涨了是收益），于是四列全标反：
        //   命中 +2,560 涂红（其实是大好事）、命中率 −2.4% 涂绿（其实是掉下来了）。
        //   现在按**这一列的好坏方向**上色（唯一实现 dColor，谁也别再写第二处）：
        //     goodUp=true  —— 命中 / 命中率 这类"越大越好"的列：涨 = 收益 = 绿，落 = 损伤 = 红；
        //     goodUp=false —— 请求 / 未命中 / 输出 / 合计 / 费用 这类"越小越好"的列：涨 = 损伤 = 红。
        //   口径一句话：**绿色 = 收益，红色 = 损伤**（不是"正负"）。差为 0 仍然不画（v6.24.65）。
        const dColor = (d, goodUp) => (((d > 0) === !!goodUp) ? '#7dd87d' : '#e07070');
        const diffLine = (mine, off, goodUp) => {
            const a = (mine === null || mine === undefined || !Number.isFinite(Number(mine))) ? null : Number(mine);
            const b = (off === null || off === undefined || !Number.isFinite(Number(off))) ? null : Number(off);
            if (a === null || b === null) return '';
            const d = Math.round(a - b);
            // ★ v6.24.65【用户："对了 0的第二行不用显示"】：**差为 0 就不画那一行** ——
            //   "没变化"不是信息，画出来只是白占一行高度（面板整表 12 列，每格都多一行很显眼）。
            //   全表的三处第二行（本地 vs 官方、官方 vs 上一轮、命中率的百分点）**同一条口径**。
            //   ⚠ 信息没丢：悬停里仍然写明"差 0（完全一致）时这一行不画"。
            if (d === 0) return '';
            const txt = `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')}`;
            return `<span style="display:block;font-size:9px;line-height:1.25;color:${dColor(d, goodUp)};">${txt}</span>`;
        };
        // ══ ★ v6.24.64【用户："这里的类似本地的第二行提示，给我添加+-红绿与数值 它对比前一轮"】══
        //   官方那几格（请求 / 命中 / 未命中 / 输出 / 命中率）下面也加一行，**样式与「本地」那行逐字同款**
        //   （display:block + 9px + + 红 #e07070 / − 绿 #7dd87d / 0 灰 #9a9aa8 + 只给数字），
        //   只有**对比对象**不同：「本地」比的是官方（我这个数偏了多少 = 算法差在哪），
        //   官方这几格比的是**前一轮**（这一轮涨了还是落了 = 缓存从哪一条断的）。
        //   ⚠ 前一轮没有这一项的数（官方 usage 还没回来 / 它就是第一轮）→ **不画那一行**，
        //     绝不拿 0 或者"本地"顶上（用户硬口径 §2.3）。
        const pnum = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Number(v);
        const dSpan = (d, txt, goodUp) => `<span style="display:block;font-size:9px;line-height:1.25;color:${dColor(d, goodUp)};">${txt}</span>`;
        /** 官方 token 那几格的第二行 = 这一轮 − 前一轮（整数，千位分隔，不缩写）。**差 0 不画**（v6.24.65）。
         *  ★ v6.24.73：方向由调用点给（命中/命中率 goodUp=true，请求/未命中/输出 goodUp=false）。 */
        const prevTok = (cur, pv, goodUp) => {
            const a = pnum(cur), b = pnum(pv);
            if (a === null || b === null) return '';
            const d = Math.round(a - b);
            if (d === 0) return '';
            return dSpan(d, `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')}`, goodUp);
        };
        /** 命中率的第二行 = 这一轮 − 前一轮，单位是**百分点**（一位小数，与上面那格同一个精度）。
         *  ★ v6.24.65【用户："命中率的第二行 建议加%"】：统一带 % —— 与它上面那格（82.4%）同一个单位写法，
         *  不然上面是 82.4%、下面是 −2.4，还得自己回想这行是什么单位。
         *  ★ 同一版【用户："对了 0的第二行不用显示"】：差 0（不到 0.05 个点）**不画那一行**。 */
        const prevPct = (cur, pv, goodUp) => {
            const a = pnum(cur), b = pnum(pv);
            if (a === null || b === null) return '';
            const raw = a - b;
            const d = Math.abs(raw) < 0.05 ? 0 : raw;
            if (d === 0) return '';
            return dSpan(d, `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%`, goodUp);
        };
        /** 命中率那一格的文本（68.4% / —）→ 数字。**直接解析屏幕上那个字符串**，
         *  不另算一遍（免得"显示的"和"拿来做差的"不是同一个数）。 */
        const pctOf = (v) => {
            if (v === null || v === undefined) return null;
            const s = String(v).replace('%', '').trim();
            if (s === '' || s === '—') return null;
            const p = Number(s);
            return Number.isFinite(p) ? p : null;
        };
        const pctDelta = prevPct(pctOf(r.pct), pctOf(prevRow?.pct), true);      // 命中率：越高越好
        // 三格各自的官方同项（命中 / 未命中 / 合计），只在 token 口径下才有得比
        // ★ v6.24.73：命中越大越好（true），未命中/合计越小越好（false）
        const dHit = diffLine(r.myTokSrc !== '' ? r.myTokLcp : null, r.hit, true);
        const dMiss = diffLine(r.myTokSrc !== '' ? r.myTokMiss : null, r.miss, false);
        const dTotal = diffLine(r.myTokSrc !== '' ? r.myTokTotal : null, r.offPrompt, false);
        // ★ v6.24.60：悬停文案按用户口径压短（"我都知道怎么算的"）—— 只留**这一格是什么 + 数从哪来**，
        //   长篇解释（为什么官方偏高、老记录怎么读…）全删。
        const mySelfText = `命中 ${_diffTok(r.myCharLcp)} / 未命中 ${_diffTok(r.myCharMiss)} / 合计 ${_diffTok(r.myCharTotal)} 字`
            + (isZi(r.myHit) ? `　≈ ${_diffTok(r.myTokLcp ?? r.myHit)} / ${_diffTok(r.myTokMiss ?? r.myMiss)} / ${_diffTok(r.tok)} tok` : '');
        const myOffNote = r.hasUsage
            ? `官方（权威）：命中 ${_diffTok(r.hit)} / 未命中 ${_diffTok(r.miss)} tok`
                + (offChars === null ? '' : `（官方命中折回字 ≈ ${offChars.toLocaleString('en-US')}，与本地相差 ${sign(gHitZi)} 字）`)
            : '官方 usage 还没回来 —— 这一格此刻只有本地，官方回来就以官方为准。';
        // v6.14：token 单元格统一走「紧凑数字 + 悬停精确值」—— 列宽再也不会把数字截成「12,3…」
    const tokTd = (n, extra = '', delta = '') => {
        const exact = _diffTok(n);
        const tip = (exact === '—' ? '这一项没有数（官方 usage 和运行记录都没给）' : `${exact} tok`)
            + (delta ? `\n【第二行】与上一轮比：${PREV_RULE}` : '');
        return `<td style="${TD}${extra}" title="${_gitEsc(tip)}">${_diffTok(n)}${delta}</td>`;
    };
    // ★ v6.24.38：两列请求 token —— 左「官方请求」（权威，官方 usage 的 prompt_tokens），
    //   右「本地请求」（本地同一串字复算 + 模板开销）。
    //   同一个格子里的悬停把两个数并排说清，差几个数也一并说出来（差得多就是两边数的不是同一串字）。
    //   ★ v6.24.61：右列**第二行**直接给这个差（+ 红 / − 绿），不用再悬停才看得到。
    const offTok = Number.isFinite(Number(r.offPrompt)) ? Number(r.offPrompt) : null;
    const myTok = Number.isFinite(Number(r.tok)) && Number(r.tok) > 0 ? Number(r.tok) : null;
    // 模板开销那两个常量：测试沙箱只抠 _diffRenderTable 这一个函数时它们不在作用域里 —— 兜底成真值
    // （串首 21 + 每条 2，见 PROMPT_OVERHEAD_TOK 那段实测表）。这只是文案里的数，不是正确性依赖。
    const ovTok = (() => { try { return Number(PROMPT_OVERHEAD_TOK) || 21; } catch (_) { return 21; } })();
    const ovMsgTok = (() => { try { return Number(TEMPLATE_PER_MSG_TOK) || 2; } catch (_) { return 2; } })();
    const tokGap = (offTok !== null && myTok !== null) ? offTok - myTok : null;
    const tokNote = tokGap === null
        ? '（两边还没凑齐：官方 usage 没回来，或者本地这一轮没数出来）'
        : (tokGap === 0
            ? '★ 两边完全相等 —— 本地与官方数的是同一串字的同一个量'
            : `差 ${tokGap > 0 ? '+' : ''}${tokGap.toLocaleString('en-US')} tok`
                + (Math.abs(tokGap) <= ovMsgTok ? '（就在模板开销的取整范围内：官方内部按 64 token 块向下取整）'
                    : r.wireSrc === false
                        ? '（这一轮的记录是本地快照：抓包没取到出网原文，酒馆后端出网前并进去的世界书不在里面 —— 这就是差得多的直接原因）'
                        : '（差得多了：两边数的不是同一串字 —— 看这一行的「原文↗」与上面那行小字）'));
    const offTokTip = offTok === null
        ? '官方请求 token 还没有：官方 usage 没回来（回复还在流式生成），或这一轮没有被量到'
        : `官方请求 token ${offTok.toLocaleString('en-US')} —— 官方 usage 的 prompt_tokens，权威值。`
            + `与「本地合计」那一格第二行的差同源（本地 − 官方）`
            + `${myTok === null ? '；这一轮本地没数出 token' : `：${myTok.toLocaleString('en-US')} 是本地数出来的那份`}${tokNote}`;
    // ★ v6.24.62：myTokTip 整段删掉 —— 它是「本地请求」那一列专用的悬停，而那一列已经删掉
    //   （与本地合计重复），留着就是没人读的死代码。myTok 本身还在用（tokGap / offTokTip）。
    // ★ v6.24.51：「本地」那三格 —— 逐位不缩写（验收口径）；悬停里是唯一那套算法的完整口径、
    //   token 折算和与官方的差。
    // ★ v6.24.59【用户要求 token 单位】：有官方 prompt 时就显示 token 口径，没有时退回字。
    // ★ v6.24.61【用户："第二行 写上差异数（与官方usage）"】第二行就是那个差（diffLine），
    //   原来那枚「差+N tok /（官方未回）/（第一轮）」的标记整段删掉 —— 用户要有数就看数，
    //   不要"（官方未回）"这种话（官方没回来时官方那几列本来就是 —，一眼就知道）。
    const ziTd = (charV, tokV, extra = '', what = '', delta = '') => {
        // ⚠ 这里的 extra 是样式串（SEP 那种 border-left:…），不是选择器/正则 ——
        //   拼进 <td style="…${extra}"…> 之前先收成字符串，免得别处传进来一个对象把它拼成非法属性
        //   （验收脚本 panel_lcp_test 里同名变量 SEP 其实是正则，那边一传进来属性就散架了）。
        const extraCss = (typeof extra === 'string') ? extra : '';
        const v = (r.myTokSrc !== '') ? tokV : charV;
        const has = (v !== null && v !== undefined && Number.isFinite(Number(v)));
        const exact = has ? Number(v).toLocaleString('en-US') : '—';
        // ★ v6.24.60：单位说明压成一句（用户："我都知道怎么算的"）—— 只说这一格是 token 折算还是字。
        // ★ v6.24.61：折算比例换成"本地自己的"之后，这里要按 myTokBasis 如实说清是哪一种。
        // ★★★★★★ v6.41.24【myTokSrc 现在有三档，这一句必须如实分档（用户点名的"真实性"）】
        //   tok  = 服务端用酒馆那份真词表在盘上这份冻结正文上数出来的（与「合计」同源，真数）；
        //   fold = 这台机器拿不到分词器 ⇒ 退回"字数 × 一把比例尺"的折算值（不是真数）；
        //        = 连折算都做不了（官方还没回来） ⇒ 这一格显示的是字。
        //   ⚠ 三档的措辞必须区分得开 —— 把折算值说成"数出来的"就是编数。
        const unitLine = (r.myTokSrc === 'tok')
            ? '（token：酒馆那份真 DeepSeek 词表、在盘上这一轮的冻结正文上数出来的 —— 与「本地合计」同一个来源）'
            : (r.myTokSrc === 'fold'
                ? (r.myTokBasis === 'own'
                    ? `（token：${Number(charV).toLocaleString('en-US')} 字 × 本地自己的字/token 比 —— 折算值，不是数出来的）`
                    : `（token：本地这一轮没数出 token，这一格按官方 prompt 的比例折的 —— 合计与官方必然相等，折算值）`)
                : '（官方还没回来，这一格是字）');
        const tip = has
            ? `${what} ${exact}　${mySelfText}${unitLine}\n${myOffNote}`
            : `${what}：这一项没有数`;
        // ★ v6.24.59：把两个口径都挂成 data- 属性 —— 面板上显示的是当前口径（有官方=token，
        //   没有=字），而验收脚本要按"字口径"逐位对 prefix_test。挂属性 = 让脚本读精确值，
        //   不用去猜屏幕上的文本里有没有单位标记（那种解析很脆）。
        const dattr = ` data-char="${charV === null || charV === undefined ? '' : Number(charV)}"`
            + ` data-tok="${tokV === null || tokV === undefined ? '' : Number(tokV)}"`;
        return `<td style="${TD}${extraCss}"${dattr} title="${_gitEsc(tip)}">${exact}${delta}</td>`;
    };
    const myTotalShown = (r.myTokSrc !== '') ? r.myTokTotal : r.myCharTotal;
    const myPctTip = r.hasUsage
        ? `本地命中率 ${r.myPct}（公共前缀 ÷ 合计）。${mySelfText}\n${myOffNote}`
        : `本地命中率 ${r.myPct}（官方还没回来，本地推算）`;
    // ★ v6.24.61：这一格下面那一行现在是与官方同项的差（本地 − 官方，+ 红 / − 绿）。
    const annoTip = '下面那一行：本地 − 官方（同项相比）。绿 = 收益，红 = 损伤（按这一列的好坏方向判）；'
        + '差为 0（完全一致）时那一行不画。'
        + '官方是权威；本地只跟上一轮比，是个下限。';
    // ★ v6.24.62【用户："单元格的数值渲染 统一风格啊 有些有颜色 有些没有"】—— 那条口径仍然成立：
    //   除了"命中率"这一根轴，所有数值格都同一个白（rgb(216,216,222) / 11px / w400），
    //   老那个 _diffColor（≥60% 绿 / ≥30% 黄 / 否则红 ＋ font-weight:600）已整段删掉，谁也别加回来。
    // ★ v6.24.64【用户："命中率的红到绿的 0~100 线性 RGB 渐变颜色你给我写好…还有本地计算的命中率"】：
    //   现在**两个命中率格**（官方那格 / 本地那格）按 0%→100% 做红→绿线性渐变（_diffPctColor），
    //   拿不到数就**不上色**；每一格下面那一行是与**前一轮**同项之差（官方 token 那几格是整数，
    //   两个命中率格是**百分点**）。全表颜色就这两个含义，两个都写在悬停里。
    //   ⚠ 渐变**只给颜色、不给 font-weight** —— "一个加粗一个不加粗"是用户明确骂过的那半条。
    //   ⚠ 测试沙箱（panel_lcp_test）里老把 _diffColor 桩成空串 ⇒ **HTML 快照里看不见颜色**，
    //     "看着一不一样"只能靠真浏览器（panel_style_test / dv_browser_test）。
    const pctColor = _diffPctColor(r.pct);
    const myPctColor = _diffPctColor(r.myPct);
    const myPctDelta = prevPct(pctOf(r.myPct), pctOf(prevRow?.myPct), true);    // 命中率：越高越好
    return `<tr>`
            + `<td style="${TDL}">${tCell}</td>`
            + `<td style="${TD}${SEP}${offTok === null ? 'opacity:.55;' : ''}" title="${_gitEsc(offTokTip)}">${_diffTok(offTok)}${prevTok(offTok, prevRow?.offPrompt)}</td>`
            + tokTd(r.hit, '', prevTok(r.hit, prevRow?.hit, true))
            + tokTd(r.miss, '', prevTok(r.miss, prevRow?.miss))
            + `<td style="${TD}${pctColor ? `color:${pctColor};` : ''}" title="${_gitEsc(TIP_RATE)}">${r.pct}${pctDelta}</td>`
            + `<td style="${TD}" title="${_gitEsc(outTip)}">${outCell}${prevTok(r.out, prevRow?.out)}</td>`
            + `<td style="${TD}${SEP}line-height:1.35;" data-char="${r.myCharTotal === null || r.myCharTotal === undefined ? '' : Number(r.myCharTotal)}" data-tok="${r.myTokTotal === null || r.myTokTotal === undefined ? '' : Number(r.myTokTotal)}" title="${_gitEsc(`${myPctTip}\n${annoTip}`)}">${myTotalShown !== null && myTotalShown !== undefined ? Number(myTotalShown).toLocaleString('en-US') : '—'}`
                + dTotal + `</td>`
            + ziTd(r.myCharLcp, r.myTokLcp, '', '本地命中', dHit)
            + ziTd(r.myCharMiss, r.myTokMiss, '', '本地未命中', dMiss)
            + `<td style="${TD}${myPctColor ? `color:${myPctColor};` : ''}" title="${_gitEsc(myPctTip + '\n' + TIP_MY4)}">${r.myPct}${myPctDelta}</td>`
            + `<td style="${TD}${SEP}" title="${_gitEsc(costTip)}">${costCell}</td>`
            + `<td style="${TDL}${SEP}white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5;${kindDim[r.reason.kind] || ''}" title="${_gitEsc(reasonTip)}">${_gitEsc(r.reason.text)}</td>`
            + `</tr>`;
    }).join('');
    // v6.24.6：表宽**就占满这一行**（width:100%），给前 11 列定一个最小宽度（= 表头那些 px 之和 852）——
    //   ★ v6.24.38：请求 token 拆成两列（50 → 64 + 64），10 列变 11 列，最小宽度 774 → 852。
    //   ★ v6.24.62：「本地请求」删掉，11 列不变（852 不动）。
    //   ★ v6.24.64：本地命中率单占一列（12 列）⇒ 最小宽度 852 → 906（= 新增那一列的 54px）。
    //   v6.24.5 实测（真 Chrome，941px 面板）：这 10 列原本正好 774px，「断点位置」拿剩 167px；
    //   它那两句内容放不下就自己省略号结尾（悬停看全文），
    //   于是**表正好占满抽屉，不会为了那一列的长内容把整张表顶出去**（用户截图里就是被顶出去了：
    //   表比抽屉宽 → 左右滚 → #34 那些数字被推到看不见）。真的窄到 906px 以下才出横向滚动条。
    //   ★ v6.24.99：这个数就是"12 列的 px 之和"——**只在这里定义一份**。
    const COLS_MIN = 906;
    box.innerHTML = `<table style="border-collapse:collapse;width:100%;min-width:${COLS_MIN}px;table-layout:fixed;">`
        + `<thead>${head}</thead><tbody>${body}</tbody></table>`
        + (note ? `<div style="padding:5px 7px;font-size:10px;opacity:.6;line-height:1.6;">${_gitEsc(note)}</div>` : '');
    _diffFitColumns(box);      // v6.23：量一遍真格子，缺宽的列从「断点位置」那列补过来
}

/* ══ 列宽自适应（源文件 @24983-25023） ══ */
/** v6.23：**除最后一列（断点位置），谁都不许被截断**。
 *  用户实测原话："被…简化 —— 严格来说除了断点位置外 我都不想被…简化"
 *  （现场就是「本地命中率」的 100.0% 被 48px 列宽截成了「100.…」）。
 *
 *  上面表头里那些列宽是**基线**（常见字体/窗口下本来就放得下），真正说了算的是这里：
 *  渲染完在真浏览器里逐个单元格量 scrollWidth > clientWidth（= 真的被截了），
 *  哪一列缺多少，就按缺口比例从**唯一允许截断的那一列**让出来补给谁：
 *    · 一个字都不缺（绝大多数情况）→ 直接返回，什么都不改，不会让表抖；
 *    · 抽屉没展开 / 还没布局（量出来全是 0）→ 也直接返回，绝不让它把表搞崩；
 *    · 断点位置留一个下限（再窄就没法看了），到下限就不给了。
 *  为什么要这么写：列宽是靠 px 猜的，而字体、主题、窗口宽都会变 —— 猜不准就必然出现
 *  「平时放得下、正好 100.0% 放不下」这种 bug。所以把"有没有被截"变成**实测**，而不是估计。 */
export function _diffFitColumns(box) {
    try {
        const table = box && box.querySelector ? box.querySelector('table') : null;
        if (!table) return;
        const ths = Array.from(table.querySelectorAll('thead th'));
        if (ths.length < 2) return;
        const last = ths.length - 1;                       // 断点位置：唯一允许截断的一列
        const need = new Array(ths.length).fill(0);
        for (const tr of table.querySelectorAll('tr')) {
            const cells = tr.children;
            for (let i = 0; i < cells.length && i < ths.length; i++) {
                if (i === last) continue;
                const over = cells[i].scrollWidth - cells[i].clientWidth;
                if (over > need[i]) need[i] = over;
            }
        }
        const total = need.reduce((a, b) => a + b, 0);
        if (total <= 0) return;
        const FLOOR = 110;                                  // 断点位置的下限（px）
        const give = Math.min(total, Math.max(0, ths[last].getBoundingClientRect().width - FLOOR));
        if (give <= 0) return;
        for (let i = 0; i < last; i++) {
            if (!need[i]) continue;
            const w = parseFloat(ths[i].style.width) || 0;
            if (w > 0) ths[i].style.width = (w + Math.max(1, Math.round(need[i] * give / total))) + 'px';
        }
        console.log(`[hitOpt] 面板列宽自适应：缺口 ${total}px，从「断点位置」让出 ${give}px（除断点位置外不许截断）`);
    } catch (err) { console.warn('[hitOpt] 列宽自适应跳过（表照常显示）:', err); }
}

/* ══ 别重复画第二遍（源文件 @25025-25038） ══ */
/** ★ v6.24.19：**这一页刚被重画过，就别再画第二遍。**
 *   现场：抽屉刚打开 → _refreshActivePanelTab() 已经 force 重算了一遍；
 *   同一小段里"发给模型那一刻"那条路（GENERATION_AFTER_COMMANDS 里的 _diffRenderIfOpen）
 *   又叫一次 —— 那一次是**从头再建一遍行**（要重读 git 记录），对着刚画好的同一份数白干，
 *   而且两个异步同时回来还会互相抢 _diffCache。⇒ 打开后这一小段窗口里，**非 force** 的那一路
 *   直接不打（force 的一律照画：点「刷新」、切到这一页、发请求那一趟都还是要算）。
 *   （写成独立函数是为了 typeof 兜底：老测试沙箱里没有那两个全局变量时**不许抛**，
 *   只是"这道闸没装"而已 —— 它是个优化，不是正确性依赖。） */
function _diffFreshAfterPanelShow() {
    try {
        if (typeof PANEL_FRESH_MS !== 'number' || typeof _panelForceRenderAt !== 'number') return false;
        return (Date.now() - _panelForceRenderAt) < PANEL_FRESH_MS;
    } catch (_) { return false; }
}

/* ══ 取记录并画表（外壳）（源文件 文件 render_analysis.js） ══ */
/* ══════════════════════════════════════════════════════════════════════════════
 * 逐轮拼出分析行、画进容器。
 *
 * 与源文件（horae.client.js @25040）的差别只有三类，逐条如下：
 *   ① 容器：源文件写死 document.getElementById('horae-diff-table') => 改成参数 / 本模块自己的 id；
 *   ② 摘掉：_ensureDiffPanelUi（Horae 面板模板）、_diffSummaryStateKey（摘要卡指纹）、
 *      _diffPlanContext ＋ _diffSimKick（替换模拟）、_diffSummarizeUi（手动总结按钮）、
 *      _diffStatusHtml ＋ #horae-diff-status（概述行）、_diffVersionStamp（表下版本戳）、
 *      _expAlgo* 预加载（实验算法链）—— 全部属于 Horae 的摘要系统 / 实验链 / 它自己的 DOM；
 *   ③ 新增最后一行 _ledgerStatusPaint(...)：把"表已经重画完"这件事交给调用方
 *      （源文件是直接去改那几个 Horae 的 DOM id；本模块不碰别人的 DOM）。
 * 除此之外**一个判据、一个数、一句文案都没改**。
 * ══════════════════════════════════════════════════════════════════════════════ */
export async function _renderDiffAnalysis(force = false, container = null) {
    const box = _ledgerBox(container);
    if (!box) return;
    if (!force && _diffFreshAfterPanelShow()) return;      // v6.24.19：刚打开这一页算过的那份数就是现在的数
    if (!force && _diffCache.at && Date.now() - _diffCache.at < DIFF_CACHE_MS && _diffCacheForThisChat()) {
        // v6.24.15 的摘要卡指纹那一道没搬（见文件头第 ② 条）—— 这里只剩"5 秒 ＋ 是不是这一场"。
        _diffRenderTable(_diffCache.rows, _diffCache.source, 0, box);
        return;
    }
    // v6.21.9：这里以前先取本聊天的"内存运行记录"当兜底数据源。用户定版"不需要内存临时存储，只要 git ＋ 硬盘"，
    //   于是逐轮明细的唯一来源是 git 提交（turns/NNNNN.txt）＋ 硬盘上的 usage.json —— 服务端没接上时表就是空的，
    //   但表里绝不会出现"只在内存里待过、刷新前后两套口径"的数字。
    let chatNow = [];
    try { chatNow = _diffChatNow(); } catch { chatNow = []; }
    // v6.24.20：这一次要真去问 git 了 => 先给概述行一个"正在取数据"的临时样（计时用）。
    const t0 = Date.now();
    try { _diffRenderTable(_diffCache.rows, '', t0, box); } catch (_) { }
    // v6.21.10：表下面那一大段说明（tips）整段删掉（用户："删除这个tips"）——
    //   只有**真出问题**（记录服务没接上 / 内置服务版本旧）时才在表下写一行。
    const warn = [];
    let commits = [];
    let gitOk = false;
    /* v6.39.6：这一份数据到底是**哪个聊天键**的 —— /log 回退时会与 _gitLogChat() 不同。 */
    let servedKey = '';
    try {
        const log = await _gitLogQueryLog();
        commits = Array.isArray(log?.commits) ? log.commits : [];
        servedKey = String(log?._servedKey || '');
        /* v6.51.1：把这一场每一轮存档的**盘上真名**记下来 —— 表里那个「比 NNNNN.txt」文案要跟着真名走。 */
        _turnRelRemember(commits);
        gitOk = true;
    } catch (_) {
        warn.push('记录服务没接上 → 没有数据可显示：这张表读的是盘上记录（turns 里的每一轮真 request）＋ usage.json；接上后按「刷新」或重开这一页就有了');
    }
    if (gitOk && _gitLogInfo?.native && Number(_gitLogInfo?.v || 0) < 2) {
        warn.push('⚠ 记录服务还是旧版本：它不返回 token / 官方 usage 字段，所以官方那三列会是空的 —— 重启一次酒馆就补齐（只在启动时加载）');
    }
    // v6.24.51：记录服务没到 v8 = 它还没把「本地」那三个字算出来给面板 -> 那三列会是 —
    if (gitOk && _gitLogInfo?.native && Number(_gitLogInfo?.v || 0) < 8) {
        warn.push('⚠ 记录服务版本旧了：它还没把「本地」那三列（两份记录正文比出来的 lcp / miss / 合计）算出来 —— 那三列会是 —。重启一次酒馆就补齐');
    }
    /* v6.24.60：空结果不写缓存 —— 见 _renderDiffAnalysis 的源文件注释（一个字节没改）。 */
    /* v6.41.6【回退闸门 —— 判据与代价的证明见 _diffFallbackDrop 的注释】
       /log 回退来的那一份，若连"最新一轮"都还没发生在这个聊天里（f_max >= L），
       就不是本场的记录 => 丢掉它，并按"这一场还没有记录"如实显示。 */
    const _fbd = _diffFallbackDrop(commits, chatNow, _gitLogChat());
    if (_fbd.drop) { commits = []; servedKey = ''; }
    const emptyNow = gitOk && commits.length === 0;
    if (emptyNow) {
        // v6.24.62【真 bug，真酒馆里抓到的】这里读的必须是同一层真有的那个数组（chatNow）。
        const chatLen = Array.isArray(chatNow) ? chatNow.length : 0;
        warn.push(_fbd.drop
            /* v6.41.6：这一支是"上一场的记录被丢掉了" —— 说清真相，不许拿"还在加载"糊弄 */
            ? `刚才那份记录属于上一场聊天（它最新一轮落在第 ${_fbd.maxFloor} 楼，而本场现在只有 `
                + `${_fbd.chatLen} 条消息）⇒ 已经丢掉，按"这一场还没有记录"显示。`
                + `（本场发一条消息就会开始记；上面那张表不会显示别场的轮次。）`
            : (chatLen < 4
                ? `这场聊天看起来还在加载（现在只读到 ${chatLen} 条消息）—— 记录是按"聊天文件 id"查的，`
                    + `加载完再点一次「刷新」就有了。`
                : '这场聊天还没有记过轮次（发一条消息就会开始记）。'));
    }
    const built = _diffBuildRows(commits, chatNow, servedKey);
    if (!emptyNow) {
        _diffCache = { rows: built, at: Date.now(), source: warn.join('；') };
        // v6.27.0【串场 bug 的落点】：键要用数据自己带回来的 _servedKey（谁给的记录就记谁）。
        _diffCacheChatKey = String(commits._servedKey || _gitLogChat() || '');
    }
    if (typeof _diffBuildingSinceSet === 'function') _diffBuildingSinceSet(0);   // v6.24.20：取完了
    _diffRenderTable(built, _diffCache.source, 0, box);
    // 源文件这里还有：替换模拟（_diffSimKick）、概述行（_diffStatusHtml -> #horae-diff-status）、
    // 表下版本戳（_diffVersionStamp）、手动总结按钮（_diffSummarizeUi）—— 全部属于 Horae 的
    // 摘要系统与它自己的 DOM id，没搬（逐条见交付报告）。改成把"画完了"交给调用方。
    _ledgerStatusPaint(built, _gitLogInfo);
}

/* ══ 记录服务：候选地址与学真名（源文件 @26378-26400） ══ */
/* ★ 2026-09-24（第二十三批）：记录服务的挂载名 —— 服务端 `info.id` 从 `horae-git` 改成 `hitopt-git`。
 *   候选**新的在前、旧的兜底**：服务端模块是酒馆启动时加载的 ⇒ 没重启时旧路由还在，
 *   面板照常能用（状态条会如实标出"还是旧挂载名"），重启之后自动切到新名。 */
const GIT_LOG_IDS = ['hitopt-git', 'horae-git'];
const GIT_LOG_BASES = GIT_LOG_IDS.map((x) => `/api/plugins/${x}`);
/** ★ v6.24.55【可移植性】探到服务之后**学到的真实挂载名**（酒馆按 info.id 挂路由，见
 *  src/plugin-loader.js → app.use('/api/plugins/' + info.id, router)）。
 *  为什么非学不可：原来两张表都是**写死**的 —— 记录服务写死 /api/plugins/horae-git，
 *  抓包服务更是靠"把 horae-git 字符串替换成 horae-wiretap"推出来的。宿主把 info.id 一改、
 *  或有人想 fork 一套并列装两遍，前端就整条链断掉，而且报错只会是"没接上"（看不出是名字对不上）。
 *  现在：/status 会回 id / peer，前端把它们记下来，之后**按真实名字拼地址**。 */
let _gitLogId = '';                // 记录服务真实挂载名（探到之后才有值）
let _wiretapId = '';               // 抓包服务真实挂载名（同上）
/** ★ v6.24.36：抓包的地址 —— 酒馆把所有 server plugin 挂在 `/api/plugins/<id>`。
 *  ★ v6.24.55：**只在"还没学到真名"时**才用字符串替换兜底；学到之后一律按真实 id 拼。
 *  ★★★★★★ 2026-09-24【合并】抓包**已经不是独立插件**了 —— 它并进了记录服务，挂在自己的
 *   `/tap` 下面（服务端 `hitopt-git/wiretap.mjs`，路由 `/api/plugins/hitopt-git/tap/…`）。
 *   ⇒ 原来那套"把 `-git` 字符串替换成 `-wiretap`、再把几个候选名都列一遍"整个退休：
 *     地址就是**记录服务那几个 base ＋ `/tap`**，一处都不用猜。
 *   ⚠ `_wiretapId` 仍然认：它来自服务端 `/status` 报的 `peer`，合并后那个值就是记录服务自己的
 *     id（`hitopt-git`）⇒ 拼出来与 `GIT_LOG_BASES` 那条**同一个地址**，去重后只剩一条。
 *   ⚠ 不支持"老版独立抓包插件"了（用户定版："**没有horae-wiretap，只有hitopt**"）。 */
export function _wireBases() {
    const out = [];
    if (_wiretapId) out.push(`/api/plugins/${_wiretapId}/tap`);
    for (const b of GIT_LOG_BASES) out.push(b.replace(/\/+$/, '') + '/tap');
    if (_gitLogId) out.push(`/api/plugins/${_gitLogId}/tap`);
    return out.filter((v, i, a) => v && a.indexOf(v) === i);
}
let _gitLogBase = null;            // 探到的可用地址（null=还没探到）
let _gitLogOk = null;              // null=未探测 / true=可用 / false=不可用
let _gitLogInfo = null;            // /status 的返回（git 版本、仓库根、是否原生）
let _gitLogTried = 0;              // 探测次数（面板上显示"已自动重试 N 次"）

/* ══ 记录服务：当前记录 id（改成注入）（源文件 @26408-26408） ══ */
/* ⚠ 依赖换来源：源文件这一行是 const _gitLogChat = () => _currentChatKey(); ——
   _currentChatKey() 是 Horae 的"当前记录 id"（读 chat_metadata 的 horae_repo 章 / 聊天文件名）。
   本模块不 import Horae、也不读 window.Horae => 改成**由调用方注入**的取键函数：
   不注入就是空串，一切按"查不到记录"如实处理（不猜一个键顶上）。 */
const _gitLogChat = () => _ledgerChatKey;

/* ══ 面板查询（带回退）（源文件 @26425-26467） ══ */
let _gitLogChatOk = '';        // 最近一次**真查到过记录**的那个 chat key

/** 面板查询专用：查不到就换上一次成功的 key 再试一次；两次都空就返回空。
 *  ⚠ **只给面板读用**（/log）—— /turn 那边绝不能回退（新聊天必须用新 id，否则记录会串场）。 */
export async function _gitLogQueryLog() {
    const now = _gitLogChat();
    const tryOne = async (key) => {
        if (!key) return null;
        try {
            const j = await _gitLogApi(`/log?chat=${encodeURIComponent(key)}`);
            if (j && j.ok && Array.isArray(j.commits) && j.commits.length) return j;
            return null;
        } catch (_) { return null; }
    };
    const hit = await tryOne(now);
    if (hit) { _gitLogChatOk = now; return Object.assign(hit, { _servedKey: now, _fellBack: 0 }); }
    if (_gitLogChatOk && _gitLogChatOk !== now) {
        const alt = await tryOne(_gitLogChatOk);
        if (alt) {
            console.warn(`[hitOpt] 差异分析：按当前记录 id（${now}）查不到记录 → 用上次成功过的那个（${_gitLogChatOk}）查到了`
                + `（多半是刚刷新、chat_metadata 还没读回来，见 _gitLogChatForQuery 那段注释）`);
            // ══ ★★★★★★ v6.27.0【**这一条就是"新聊天被旧聊天污染"的根因**，2026-09-19 实测抓到的】══
            //   _diag.log 铁证（用户连开两个新聊天 mu7v4a8un29l → mu7vf2wlnmxi）：
            //     04:11:58.075 panel:diff 的 chat 字段**已经是新聊天**、chatLen=1，
            //     可同一发里 rows=2、per="#0…;#1:floor=4,atLen=4,stale=0,lcp=35875"
            //     —— #1 的 floor=4/lcp=35875 是**上一场**第 2 轮的读数；
            //     而且这 2 行一直黏到 04:12:10（**12 秒**），期间用户一直在看它。
            //   机制（就是这一条 fallback）：新聊天刚开时 _gitLogChat()（＝当前记录 id）在服务端
            //     还查不到记录 ⇒ 这里**回退**用上一次成功的 key 查 ⇒ 拿回来的是**旧聊天的 commits**
            //     ⇒ _diffBuildRows 把它们建成旧聊天的行。
            //   为什么 _diffCacheForThisChat() 那道防线没拦住（它本来是对的）：
            //     上面那行 _diffCacheChatKey = _gitLogChat() 记的是**新聊天的 id**，
            //     而这一份数据其实是旧聊天的 ⇒ 键与实际内容**对不上却判"一致"** ⇒ 缓存被当成有效。
            //   ⇒ 修法：**把"这份数据到底是哪个 chat key 的"如实带出来**（_servedKey），
            //     缓存与渲染一律用它，不许再拿 _gitLogChat() 当"这份数据的身份"。
            //     ★ 回退本身**保留**（它是为了"刚刷新、chat_metadata 还没读回来"那一小段，
            //       删了会让老聊天开面板时也是一片空）；改的是"回退来的数据不许冒充当前聊天"。
            return Object.assign(alt, { _servedKey: _gitLogChatOk, _fellBack: 1 });
        }
    }
    // 两次都空：如实返回一个空结果（**不**把空结果写进缓存，见 _renderDiffAnalysis）
    return { ok: true, commits: [], v: _gitLogInfo?.v };
}

/* ══ CSRF 令牌（源文件 @26469-26486） ══ */
/** 酒馆的 CSRF 令牌（server plugin 走酒馆的 /api，POST 需要它；独立服务不需要，多带一个头无害）
 *  ★ v6.24.55：酒馆的令牌是**页面加载那一刻**从 /csrf-token 取来存在 script.js 模块变量里的
 *  （firstLoadInit），此后**只有 /csrf-token 会换新的**。而酒馆这个会话是 **cookie-session**
 *  （服务端无状态、存在加密 cookie 里）：cookie 一被顶掉/过期/换标签页登入，前端手里那枚就作废，
 *  酒馆 csrf-sync 直接 403 Invalid CSRF token。实测（用户贴的酒馆窗口日志）：
 *  一连串 ForbiddenError: Invalid CSRF token，而那一轮 turns/ 一个字都没写。
 *  ⇒ 这里加一层**缓存**：_gitLogApi 收到 403 时自动向 /csrf-token 讨一枚新的、重试一次
 *  （见那里的 csrfNew）。用户不用再"刷新页面"。 */
let _gitLogCsrfCache = '';
export function _gitLogCsrf() {
    if (_gitLogCsrfCache) return _gitLogCsrfCache;
    try {
        const ctx = getContext();
        return ctx?.getRequestHeaders?.()?.['X-CSRF-Token']
            || ctx?.getRequestHeaders?.()?.['x-csrf-token']
            || '';
    } catch (_) { return ''; }
}

/* ══ 探活（源文件 @26792-26819） ══ */
/** 依次探候选地址：第一个 /status 通的就是它（原生 server plugin 排最前） */
export async function _gitLogProbe() {
    for (const base of GIT_LOG_BASES) {
        try {
            const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(2500) });
            if (!res.ok) continue;
            const j = await res.json();
            if (j?.ok) {
                _gitLogBase = base;
                _gitLogInfo = j;
                // ★ v6.24.55【可移植性】把服务报出来的**真实挂载名**记下来：
                //   记录服务自己的 id（酒馆就是拿它拼 /api/plugins/<id> 的），
                //   以及它声明的同伴名 peer（抓包插件）。之后 _wireBases() 按真名拼地址，
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

/* ══ 一次读请求（源文件 @26821-26871） ══ */
/** 一次请求：没探到地址就先探；请求失败就把地址扔掉，下次自动重探（服务中途起来也能自己接上） */
export async function _gitLogApi(pathname, body, timeoutMs = 4000) {
    if (!_gitLogBase) {
        const ok = await _gitLogProbe();
        if (!ok) throw new Error('git 服务未就绪');
    }
    const base = _gitLogBase;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    // ★ v6.24.58：这一跳的"进/出"诊断探针（turn:send / turn:res / turn:send:throw）已撤 ——
    //   它们当初是为了找"willCommit 有、/turn 却没下文"那个断点（真因是 putWire 抛 TypeError，已修）。
    //   留下来的只有**真失败**那条 api:throw（见下面 catch）：它不是探针，是"这一跳到底怎么了"的如实留痕。
    try {
        const headers = { 'content-type': 'application/json' };
        const csrf = _gitLogCsrf();
        if (csrf) headers['X-CSRF-Token'] = csrf;
        const res = await fetch(`${base}${pathname}`, body === undefined
            ? { signal: ctl.signal }
            : { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
        // ★ v6.24.55：**403 = 手里那枚 CSRF 令牌作废了**（酒馆 csrf-sync 的原话：
        //   Invalid CSRF token. Please refresh the page and try again.）。
        //   老代码在这里什么都没做 ⇒ res.json() 把 403 的错误体当成正常返回值，
        //   调用方看到的是 {ok:false}，而**这一轮就永远写不进去了**（实测：用户酒馆窗口里
        //   一连串 ForbiddenError，turns/ 一直空着）。
        //   现在：向酒馆讨一枚新的 /csrf-token（它会把新令牌写进同一个 session），
        //   然后**原样重试一次** —— 用户不用刷新页面，记录自己接上。
        //   令牌是从 /csrf-token 换的、不猜、不编；换不到就照旧如实失败。
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
        /* ⛔ 摘掉：源文件这里发一条 _diagReport({tag: api:throw}) —— 那是 Horae 的诊断上报通道
           （写抓包插件的 _diag.log），本模块不依赖它。降级成一行 console.warn，信息不丢。 */
        try { console.warn('[ledger] 记录服务这一跳失败', pathname, base, String(err?.message || err)); } catch (_) { }
        throw err;
    } finally { clearTimeout(t); }
}

/* ══ 探活并刷新状态行（源文件 @26911-26917） ══ */
/** 探一次并刷新状态行；force=false 时如果刚探过就跳过（避免开设置页时白探一轮） */
export async function _gitLogStatusRefresh(force = false) {
    /* ⚠ 依赖换来源：源文件这里调 _refreshGitLogStatus()（画进 Horae 的 #horae-git-status），
       那个 DOM 与那个函数都没搬 => 改成调用可注入的状态画法（默认空实现）。 */
    if (!force && _gitLogOk === true) { _ledgerStatusPaint(_gitLogInfo); return _gitLogInfo; }
    const info = await _gitLogProbe();
    _ledgerStatusPaint(_gitLogInfo);
    return info;
}

/* ══ 存档真名（源文件 @28852-28877） ══ */
const _turnRelMap = new Map();          // 键的形状：轮号|种类 -> 相对路径
                                        // （源文件这一行的注释里用了反引号，本项目硬约束：注释不带反引号）
/** 把 /log 报上来的真名记下来（每轮调一次，幂等）。 */
function _turnRelRemember(commits) {
    if (!Array.isArray(commits)) return;
    for (const c of commits) {
        /* ⚠ 显式挡掉 null：Number(null) === 0 会把机械提交那一行写成 0|body（踩过四次的老坑）。 */
        if (!c || c.no === null || c.no === undefined) continue;
        const no = Number(c.no);
        if (!Number.isFinite(no) || no < 0 || !c.rel || typeof c.rel !== 'object') continue;
        for (const k of ['body', 'raw', 'abc']) if (typeof c.rel[k] === 'string' && c.rel[k]) _turnRelMap.set(`${no}|${k}`, c.rel[k]);
    }
}
/** 这一轮某一类存档的相对路径：**服务端报过的真名优先**，否则按新名拼。 */
function _turnRel(no, kind) {
    const n = Math.max(0, Math.floor(Number(no) || 0));
    const hit = _turnRelMap.get(`${n}|${kind}`);
    if (hit) return hit;
    const k = String(n).padStart(5, '0');
    if (kind === 'raw') return `turns/${k}.raw.json`;
    if (kind === 'abc') return `turns/${k}.abc.json`;
    return `turns/${k}.json`;
}
/** 这一轮正文的**文件名**（不带目录）—— 给文案用（"生成 00016.json 时的第 17 轮"）。
 *  ⚠ 用户点名的轮号写法里那个文件名必须**跟着真名走**：文件从 .txt 改成 .json 之后，
 *    再写 生成 00016.txt 时的第 17 轮 就指着一个盘上不存在的文件了。 */
function _turnName(no) { return _turnRel(no, 'body').replace(/^.*\//, ''); }

/** 一颗入口的**名字**（＝那个 anchor 自己的文字，如 `原文↗`）。
 *
 *  ⛔⛔ 2026-09-24【v7.0.6 真 bug 的根因就在"量错了东西"】——
 *    分两排那一段原来拿**整串 `<a …>名字</a>` HTML** 去跑分类正则 `/同上轮|同轮|跟上轮/`，
 *    而 `池化↗` 的 `title=` 悬停文字里**恰好写着**「…点下面的「同轮↗」。」——
 *    ⇒ 整串命中「同轮」⇒ `池化↗` 被判进**第二排**（对比差异排）。
 *    真页面实测（1920 / 场 圣樱学院_muczgjfs8igs）：第一排只剩 `原文↗ 输出↗`（2 颗），
 *    第二排挤成 4 颗 —— 用户看到的就是"按钮没了"。
 *  ⇒ 判据只许看**名字**：那是这六颗里唯一有语义的那个字。
 *    ⚠ 别改成"看 href"：六颗的 href 都是 view.html 那几个 query，判不出语义（也一样会踩同类的坑）。 */
function _ledgerLinkName(h) {
    const m = /<a\b[^>]*>([^<]*)<\/a>/.exec(String(h || ''));
    return m ? m[1] : '';
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 楼层格底下那**两排**入口（第 5 行 / 第 6 行，各 3 颗横排、按语义分）
 *
 *  ⚠ 排版口径变过三次，**只认最后这一版**（v7.0.5 起，用户两句原话定版：
 *    "是 123 456 排列" ＋ "第一行 是原始信息超链接／第二行 是对比差异"）：
 *      第 5 行 = **原始信息**：原文↗ 池化↗ 输出↗
 *      第 6 行 = **对比差异**：同上轮↗ 同轮↗ 跟上轮↗
 *    （v7.0.4 是 4＋2、v7.0.5 初版是 3＋3 按 push 顺序切 —— **都已作废**，别再照抄。
 *      v7.0.6 修的是"分排判据量错东西"那个 bug，见文件里 `_ledgerLinkName` 那段。）
 *
 * 【为什么有这一段 —— 用户 2026-09-24 报的 UI 缺失】
 *   源文件里这一格底下挂的是 _dvLinks(r)：一串开 Horae 差异页与实验算法产物的链接
 *   （原文↗ / 同上轮↗ / 池化↗ / 输出↗ / 同轮↗ / 跟上轮↗）。搬迁时整条链一个都没搬
 *   （差异页 _dvPage / _dvPageScript 与实验算法 _expAlgo* 都不在清单里）⇒ 那一行被
 *   降级成空串 ⇒ 面板里一个 ↗ 都没有。用户原话：
 *     "嗯 但是没有按钮　之前的按钮分两排　放到单元格行内的第5行第6行吧　第一行是文档，第二行是对比"
 *   （"单元格" = 这张表第 1 列的**楼层格**；它上面本来就有 4 行文字：#51 / 第26轮 · 时间 /
 *     正常推进 / 比00024.json（生成时的第26轮）⇒ 这两排就接在第 5、第 6 行。）
 *   ★★ 2026-09-24 修正（我第一版理解错了，用户当场否："很丑,没按要求排…就两行的按钮硬是一个
 *      超链接一行，而且还改了文字"）：他那句里"第一行/第二行"说的是**两排**，
 *      不是"两颗各占一行" ⇒ 每一排各自**横排**；名字**一律用原名**
 *      （`池化↗` 不许写成「文档↗」、`跟上轮↗` 不许写成「对比↗」）。
 *   ★★★ 2026-09-24【v7.0.6】两排各 **3 颗**（按语义分，见本段抬头那三行）。
 *
 * 【★ 在 hitOpt 侧独立实现 —— 不是把源文件那个 _dvLinks 抄过来】
 *   · 6 颗、两排、名字与顺序全按源实现；每排内部**横排**（flex），排间换行；
 *   · 目标**不是静态文件网址**：记录根在 plugins/hitopt-git/_gitlog 下、**不在 public/ 里**，
 *     浏览器静态取不到（实测 /plugins/... 与 /scripts/extensions/third-party/hitOpt/_gitlog/...
 *     都是 404）⇒ 指静态网址就是死链。改成指向本扩展自己的只读查看页 view.html；
 *   · 查看页再走服务端那几条只读 GET 路由（池化 /flat、原文 /flat?src=raw、差异 /diff、输出 /res）。
 *
 * 【样式：沿用源文件那一套普通链接，不自己发明按钮】
 *   用户当年点名过："池化差异为什么有div按钮样式 给我删了" ⇒ 六个入口统一普通链接
 *   （color:#8fb8ff + 下划线）。两排各包一层 flex 容器（横排），字号 9px（理由见下）。
 *
 * 【拿不到就不画 —— 绝不画死链】
 *   第一轮（没有上一轮）**不给「同上轮↗」与「跟上轮↗」**（源文件里那两颗也是这个规矩：
 *   没得比的东西不画死链）；盘上没有的那一份（`absent` / `placeholder`）同样不画那一颗。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 本扩展自己的网址前缀（view.html 就在本模块旁边）。用模块自己的网址推，不写死目录名。 */
function _ledgerViewerUrl() {
    try { return new URL('view.html', import.meta.url).href; } catch (_) { return ''; }
}

/** 记录服务地址：调用方注入的优先 → 本模块自己探到的 → 候选表第一项（全都得是 /api/plugins/<id> 形状）。 */
function _ledgerRecordBase() {
    const ok = (b) => (/^\/api\/plugins\/[A-Za-z0-9_.-]+$/.test(String(b || '')) ? String(b) : '');
    return ok(_ledgerApiBase) || ok(_gitLogBase) || GIT_LOG_BASES[0];
}

/**
 * 楼层格底下那几行入口（第 5 行起，竖排）。
 *
 * ── 它们是**源文件那一族**（`horae.client.js` 的 `_dvLinks`，定义 @28971 / 唯一调用点 @24687）──
 *  原来第一排 / 第二排一共 **6 个**，本次按**原语义**逐个补回来（不发明含义、不改名字的含义）：
 *
 *  | 排 | 入口 | 源文件行 | 点开看到的是什么（源 tooltip 的原话） |
 *  |---|---|---|---|
 *  | 一 | 原文↗ | 29048 | `turns/NNNNN.raw.json` —— 酒馆组装好、Horae **还没动过**的原文（未经池化） |
 *  | 一 | 同上轮↗ | 29067 | `turns/(N-1).raw.json` ↔ `turns/N.raw.json` —— 跨轮，两侧都是**原文**，不含池化 |
 *  | 一 | 池化↗ | 29102 | `turns/NNNNN.json` —— 主算法**池化后**、这一轮**真发出去**的 request 全文 |
 *  | 一 | 输出↗ | 29120 | `turns/NNNNN.res.txt` —— **官方返回**内容，逐字节（流式就是 SSE 原文） |
 *  | 二 | 同轮↗ | 29255 | `turns/N.raw.json` ↔ `turns/N.json` —— **同一轮内部**：池化做了什么 |
 *  | 二 | 跟上轮↗ | 29264 | `turns/(N-1).json` ↔ `turns/N.json` —— 跨轮，两侧都是池化后产物 |
 *
 * ★★★★★★ 2026-09-24【用户定版：**两排 4＋2，名字/顺序全按原实现**】用户原话（配截图）：
 *   "很丑,没按要求排，你自己排吧，就两行的按钮硬是一个超链接一行，而且还改了文字"
 *   ── 他早先那句"之前的按钮分两排 放到单元格行内的第5行第6行吧 第一行是文档，第二行是对比"里，
 *      "第一行/第二行"指的是**两排**（不是两颗）：第 5 行 ＝ **第一排那 4 颗横排**，
 *      第 6 行 ＝ **第二排那 2 颗横排**。我第一版理解成"一颗一行（六行）"⇒ 当场被否。
 *   ── 名字**一律用原名**，不许换（我第一版把「池化↗」写成「文档↗」、「跟上轮↗」写成「对比↗」⇒ 也是错的）：
 *      `原文↗` ｜ `同上轮↗` ｜ `池化↗` ｜ `输出↗` ｜ `同轮↗` ｜ `跟上轮↗`
 *   ── 顺序也照原实现：第一排 `原文 / 同上轮 / 池化 / 输出`，第二排 `同轮 / 跟上轮`。
 *
 * ⚠ **"合并"那条结论仍然成立，但它说的是"不用再造同义按钮"，不是"改名"**：
 *   · `池化↗`（@29102）读的就是 `turns/NNNNN.json`（`_dvTurnUrl(no)` 第二参省略 = `_turnRel(no,'body')`）
 *     —— 与上一版那颗「文档↗」**同一份盘上文件**；现在名字回到 `池化↗`，路由一个字节没变（仍走 `/flat`）。
 *   · `跟上轮↗`（@29264）与上一版那颗「对比↗」**参数逐字相同**；现在名字回到 `跟上轮↗`。
 *   ⇒ 源头 6 颗，这里就是 6 颗，一颗不多一颗不少。
 *
 * 【样式：沿用源文件那一套普通链接，不自己发明按钮】
 *   用户当年点名过："池化差异为什么有div按钮样式 给我删了" ⇒ 普通链接（color:#8fb8ff + 下划线）。
 *   ★ 两排各用一个 flex 容器（`display:flex; flex-wrap:wrap; gap`）⇒ 排内**横排**、排间**换行**。
 *   字号 9px（比原来竖排时那 10px 小一档）：4 颗挤在 138px 那一列里，10px 放不下会折行
 *   （实测值见 `_notes/hitOpt-输出按钮.md` 的排版那一节；撑宽表是绝对不行的 —— 那一列一宽整张表就变形）。
 *
 * 【拿不到就不画 —— 绝不画死链】
 *   每一颗都先问服务端给的那个**三态**（`r.res` / `r.files`，判据在服务端 `archiveStateOf` 一处）：
 *     · `absent`（盘上没这份，实测两个老场 97 轮的 `.raw` 一份都没有）
 *     · `placeholder`（占位文件不是数据）⇒ 都不画那一颗；
 *     · 跨轮的那两颗（`同上轮↗` / `跟上轮↗`）还要"轮号小 1 那一轮"也在（第一轮没有 —— 源文件同一条规矩）。
 *
 * @param {object} r         这一行的 row（要 r.turn / r.sha / r.res / r.files）
 * @param {Map} shaByTurn    轮号 -> 提交 sha（跨轮那两颗要**上一轮那一发**的 sha）
 * @param {Array} rows       本表**全部**行（按轮号找"上一轮那一行"的真名与三态；不拿数组前一行）
 * @returns {string} **两排**链接的 HTML（第一排 = 原始信息类、第二排 = 对比差异类；
 *                  某颗不满足条件就不出现，整排一颗都没有时那一排整个不画）；
 *                  拿不到必要的判据时返回空串。
 */
function _ledgerTurnLinks(r, shaByTurn, rows) {
    const v = _ledgerViewerUrl();
    const chat = String(_ledgerChatKey || '');
    const no = Number(r?.turn);
    if (!v || !chat || !Number.isFinite(no) || no < 0) return '';
    /* 一颗链接自己的样式（普通链接；`white-space:nowrap` ⇒ 一颗不许从中间断开）。 */
    const st = 'color:#8fb8ff;text-decoration:underline;white-space:nowrap;';
    /* 一排的容器：**恰好一行，绝不折行**。
     * ★ 2026-09-24【用户定版，两句原话】：
     *   "按钮我都说了就两行！！！！ 两行！！！" ＋
     *   "断点位置列这么大有个屁用，我都是简单看一眼，转头就超链接看具体了"
     * ⇒ 上一版写的是 flex-wrap:wrap（"排不下就折行、宁折也不撑宽这一列"）—— **那个取舍是错的**：
     *   4 颗在 138px 里只余 6px，用户视口一变就折成 4 行，成了"一颗一行"。
     *   现在改成 nowrap：**排内永远一行**，需要多宽就占多宽；
     *   多出来的宽度由 _diffFitColumns 从**最后一列（断点位置）**让过来 —— 用户本来就说那一列
     *   "简单看一眼、转头点超链接看具体"，让宽给它正是他要的方向（一举两得，不是将就）。 */
    const rowSt = 'display:flex;flex-wrap:nowrap;align-items:baseline;gap:0 5px;'
        + 'font-size:9px;line-height:1.75;white-space:nowrap;';
    const chatQ = 'chat=' + encodeURIComponent(chat);
    const baseQ = '&base=' + encodeURIComponent(_ledgerRecordBase());
    const nm = _turnName(no);
    const me = `生成 ${nm} 时的第 ${no + 1} 轮`;
    const row1 = [];        // 第一排：原文 / 同上轮 / 池化 / 输出
    const row2 = [];        // 第二排：同轮 / 跟上轮

    /* 三态判据（服务端给的，客户端只读）—— 拿不到（老服务端）时一律 "" ⇒ 不画。 */
    const stOf = (o) => String((o && o.state) || '');
    /* ★★★★★★ 2026-09-24【老服务端（还没重启酒馆）时的兜底 —— 这一条必须留着】
     *   三态是**本次新加**的服务端字段（`/log` 的 `res` / `files`）。酒馆没重启时那份 `/log`
     *   里没有它们 ⇒ 要是照新判据走，**连原来那两颗（文档/对比）都会消失** ——
     *   用户 F5 之后会看到"一个按钮都没有了"，比不改还糟（实测过同一类事故：
     *   判据升级把老数据判成"没有" ⇒ 整块入口消失）。
     *   ⇒ 判据分两档，与源文件 `_dvStaticOk()` 那条闸门同一个意思：
     *     · 拿得到 `files`（新服务端）：按三态，`present` 才画；
     *     · 拿不到（老服务端）：**池化↗ / 跟上轮↗ 照旧画**（＝v7.0.2 那颗「文档/对比」的行为，逐字不变），
     *       而依赖新字段的四颗（原文/同上轮/输出/同轮）**不画**（无从判断，不猜）。 */
    const hasFiles = !!(r?.files && typeof r.files === 'object');
    const hasBody = hasFiles ? stOf(r.files.body) === 'present' : true;
    const hasRaw = hasFiles && stOf(r.files.raw) === 'present';
    const hasRes = stOf(r?.res) === 'present';
    /* 盘上**真名**：raw 有 `.raw.json` 与老的 `.raw.txt` 两可，服务端把真名报在 `file` 里。
       ⚠ 拿不到就不画（不猜名字 —— 猜错就是死链，源文件当年正是靠"静态文件网址"避开这件事的）。 */
    const relOf = (o, kind) => (typeof o?.file === 'string' && o.file ? o.file : _turnRel(no, kind));

    /* 跨轮那两颗的**上一轮**（按轮号，不拿数组前一行：重 roll 之后两者不是同一发）。 */
    const prevNo = no - 1;
    const shaPrev = (shaByTurn && shaByTurn.get(prevNo)) || '';
    const shaCur = String(r?.sha || '');
    const prevOk = (kind) => {
        if (!hasFiles) {
            /* 老服务端：退回 v7.0.2 那套（按轮号拼兜底名）—— 跟上轮↗ 那一颗照旧出现。 */
            return (kind === 'body' && prevNo >= 0) ? _turnRel(prevNo, 'body') : null;
        }
        const o = (kind === 'raw') ? r?.files?.raw : r?.files?.body;
        if (stOf(o) !== 'present') return null;
        return _ledgerRowByTurn(rows, prevNo, kind) || null;
    };
    /** 跨轮差异那一页的网址（两侧都是同一类存档；`kind` 只决定用哪一对真名）。 */
    const crossHref = (kind, lbl) => {
        const relPrev = prevOk(kind);
        if (!relPrev) return '';
        /* ⛔ 2026-09-24【v7.0.6 差分实验抓到的第二个 bug】这里原来是 `r.files.raw : r.files.body` ——
         *   `files` 整块拿不到时（老服务端 / 没重启酒馆）`hasBody` 走**兜底判据恒为 true**，
         *   而 `prevOk('body')` 也照旧给得出兜底名 ⇒ 「跟上轮↗」会走到这一行 ⇒ **整个表格渲染抛异常**
         *   （实测：TypeError: Cannot read properties of null (reading 'body')）。
         *   被 index.js 的 catch 吞掉 ⇒ 面板一个字都不画（比少一颗严重得多）。
         *   ⇒ 一律用 `r?.files?.…`；拿不到时 `relOf` 退回按轮号拼的兜底名，与 prevOk 那套**同一口径**。 */
        const relCur = relOf(kind === 'raw' ? r?.files?.raw : r?.files?.body, kind);
        return `${v}?mode=diff&${chatQ}${baseQ}`
            + `&from=${encodeURIComponent(shaPrev + ':' + relPrev)}`
            + `&to=${encodeURIComponent(shaCur + ':' + relCur)}`
            + `&prevno=${prevNo + 1}&no=${no + 1}`
            + `&label=${encodeURIComponent(lbl)}`;
    };

    /* ══ 第一排（单元格第 5 行）：原文↗ 同上轮↗ 池化↗ 输出↗ —— 顺序照源文件 ══════════ */

    /* ① 原文↗（源 29048）—— 酒馆组装好、Horae 还没动过的原文（未经池化） */
    if (hasRaw) {
        const relRaw = relOf(r?.files?.raw, 'raw');
        const rawHref = `${v}?mode=doc&src=raw&${chatQ}${baseQ}&no=${no}&label=${encodeURIComponent(me)}`;
        row1.push(`<a href="${_gitEsc(rawHref)}" target="_blank" rel="noopener" style="${st}"`
            + ` title="【原文】酒馆组装好的原文（未经池化）—— 算法的输入。\n`
            + `【盘上文件】${relRaw}\n`
            + `这一轮：${me}">原文↗</a>`);
    }

    /* ② 同上轮↗（源 29067）—— 跨轮，两侧都取**原文**（与「跟上轮↗」成对） */
    if (prevNo >= 0 && shaPrev && shaCur && hasRaw && prevOk('raw')) {
        const relPrevRaw = prevOk('raw');
        const relRaw = relOf(r?.files?.raw, 'raw');
        const prevNm = _turnName(prevNo);
        const lblR = `${prevNm} ↔ ${nm}（原文 · 第 ${prevNo + 1} 轮 ↔ 第 ${no + 1} 轮）`;
        row1.push(`<a href="${_gitEsc(crossHref('raw', lblR))}" target="_blank" rel="noopener" style="${st}"`
            + ` title="【同上轮】原文跨轮差异（两侧都未经池化）。\n`
            + `【前】${relPrevRaw}　第 ${prevNo + 1} 轮\n`
            + `【后】${relRaw}　第 ${no + 1} 轮\n`
            + `池化后那一对看旁边的「跟上轮↗」。">同上轮↗</a>`);
    }

    /* ③ 池化↗（源 29102）—— 主算法池化后、这一轮真发出去的 request 全文。
       ⚠ 走 `/flat`（全项目唯一铺平入口）把盘上那份 `turns/NNNNN.json` 摊成可读文本；
         源文件当年是一颗静态文件网址（浏览器直接把 JSON 吐出来）—— 记录根搬出 `public/` 之后
         那条路 404 了，所以现在必须经服务端读（见 `_notes/hitOpt-输出按钮.md` §③）。 */
    if (hasBody) {
        const relBody = relOf(r?.files?.body, 'body');
        const poolHref = `${v}?mode=doc&${chatQ}${baseQ}&no=${no}&label=${encodeURIComponent(me)}`;
        row1.push(`<a href="${_gitEsc(poolHref)}" target="_blank" rel="noopener" style="${st}"`
            + ` title="【池化】这一轮真发出去的 request 全文（池化后的产物）。\n`
            + `【盘上文件】${relBody}\n`
            + `池化前的原文看「原文↗」；这一轮池化动了什么看「同轮↗」。\n`
            + `这一轮：${me}">池化↗</a>`);
    }

    /* ④ 输出↗（源 29120）—— 官方对「真发出去那一发」的返回内容 */
    if (hasRes) {
        const relRes = String(r.res.file || `turns/${String(no).padStart(5, '0')}.res.txt`);
        const nB = Number(r.res.bytes);
        const resHref = `${v}?mode=res&${chatQ}${baseQ}&no=${no}&label=${encodeURIComponent(me)}`;
        row1.push(`<a href="${_gitEsc(resHref)}" target="_blank" rel="noopener" style="${st}"`
            + ` title="【输出】官方对「真发出去那一发」的返回内容。\n`
            + `【盘上文件】${relRes}${Number.isFinite(nB) && nB > 0 ? `（${nB.toLocaleString('en-US')} 字节）` : ''}\n`
            + `流式就是 SSE 原文（每行一条 data: chunk，结尾 data: [DONE]）；传统非流式就是一条完整 JSON；\n`
            + `末尾那条带官方 usage（prompt / cache_hit / cache_miss / completion）。\n`
            + `这一轮：${me}">输出↗</a>`);
    }

    /* ══ 第二排（单元格第 6 行）：同轮↗ 跟上轮↗ —— 顺序照源文件 ══════════════════════ */

    /* ⑤ 同轮↗（源 29255）—— **同一轮内部**：池化前 ↔ 池化后 */
    if (shaCur && hasRaw && hasBody) {
        const relRaw = relOf(r?.files?.raw, 'raw');
        const relBody = relOf(r?.files?.body, 'body');
        const lblS = `${relRaw} ↔ ${relBody}（同一轮 · 第 ${no + 1} 轮）`;
        const hrefS = `${v}?mode=diff&${chatQ}${baseQ}`
            + `&from=${encodeURIComponent(shaCur + ':' + relRaw)}`
            + `&to=${encodeURIComponent(shaCur + ':' + relBody)}`
            + `&no=${no + 1}&label=${encodeURIComponent(lblS)}`;
        row2.push(`<a href="${_gitEsc(hrefS)}" target="_blank" rel="noopener" style="${st}"`
            + ` title="【同轮】同一轮内部：原文 → 池化后（这一轮池化做了什么）。\n`
            + `【前】${relRaw}\n`
            + `【后】${relBody}">同轮↗</a>`);
    }

    /* ⑥ 跟上轮↗（源 29264）—— 跨轮，两侧都是池化后产物（"这就是原来那个「差异↗」的行为"） */
    if (prevNo >= 0 && shaPrev && shaCur && hasBody && prevOk('body')) {
        const relPrev = prevOk('body');
        const relBody = relOf(r?.files?.body, 'body');
        const prevNm = _turnName(prevNo);
        const lbl = `${prevNm} ↔ ${nm}（第 ${prevNo + 1} 轮 ↔ 第 ${no + 1} 轮）`;
        row2.push(`<a href="${_gitEsc(crossHref('body', lbl))}" target="_blank" rel="noopener" style="${st}"`
            + ` title="【跟上轮】池化后的跨轮差异。\n`
            + `【前】${relPrev}　第 ${prevNo + 1} 轮\n`
            + `【后】${relBody}　第 ${no + 1} 轮\n`
            + `池化前那一对看旁边的「同上轮↗」。">跟上轮↗</a>`);
    }

    /* 两排各包一层 flex 容器 ⇒ **排内横排、排间换行**（每排一颗都没有时那一排整个不画）。 */
    const out = [];
    /* ★★★★★★ 2026-09-24【用户定版：**按语义分两排**】—— 他原话：
     *   "是 123 456 排列" ＋ "第一行 是原始信息超链接／第二行 是对比差异"。
     *   上面各处按 push 顺序把链接放进 row1 / row2（4＋2：原文/同上轮/池化/输出 ｜ 同轮/跟上轮），
     *   **那个分配已经作废**（v7.0.4 的排法）。而且这里也**不能**按"前 3 颗 / 后 3 颗"切
     *   （v7.0.5 初版那样切过 ⇒ 对比类的「同上轮↗」混进第一行）。
     *   ⇒ 不去动上面那些 push（它们还兼着"这一颗该不该画"的三态判断），
     *     在这里按**名字判类**重排一次 —— 缺颗时自动前移，不留空洞、不补假链接。 */
    {
        const _all = row1.concat(row2);
        row1.length = 0;
        row2.length = 0;
        for (const h of _all) {
            /* ★ 按**语义**归排 —— 用户 2026-09-24 两句原话：
             *   "是 123 456 排列" ＋ "第一行 是原始信息超链接／第二行 是对比差异"
             * ⇒ 123（第一行）＝ **原始信息**类：原文↗ 池化↗ 输出↗
             *   456（第二行）＝ **对比差异**类：同上轮↗ 同轮↗ 跟上轮↗
             * ⚠ 不能再按"前 3 颗 / 后 3 颗"切 —— 那样会把对比类的「同上轮↗」
             *   混进第一行（上一版就是这么错的）。
             * ⚠ 判类是看链接**名字**（这三个词都带"轮"且都属对比），判不出来的一律进第一行。
             * ⛔⛔ 2026-09-24【v7.0.6 修的真 bug：判据量错了东西】
             *   上一版这一行是 `/同上轮|同轮|跟上轮/.test(h)`，而 h 是**整串 `<a …>` HTML** ——
             *   `池化↗` 的 title 里写着「…点下面的「同轮↗」。」⇒ 整串命中「同轮」⇒ 池化↗ 掉进第二排。
             *   真页面实测（1920 / 场 圣樱学院_muczgjfs8igs）：第一排只剩 原文↗ 输出↗（2 颗）、
             *   第二排挤成 4 颗（同上轮↗ 池化↗ 同轮↗ 跟上轮↗）—— 用户体感就是"按钮没了"。
             *   ⇒ 改成只看 `_ledgerLinkName(h)`（那颗链接自己的名字）。
             *   A/B 对照（同一份源码只换这一行，真页面真数据）见 `_notes/hitOpt-输出按钮.md`：
             *     换前 第一排 2 颗 / 第二排 4 颗；换后 第一排 3 颗 / 第二排 3 颗；**六颗计数一个不差**。 */
            (/同上轮|同轮|跟上轮/.test(_ledgerLinkName(h)) ? row2 : row1).push(h);
        }
    }
    if (row1.length) out.push(`<span style="${rowSt}">${row1.join('')}</span>`);
    if (row2.length) out.push(`<span style="${rowSt}">${row2.join('')}</span>`);
    return out.join('');
}

/** 表里某一轮那一类存档的**盘上真名** —— 按**轮号**取那一行的 row（不拿数组前一行：重 roll 时两者不同）。
 *  ⚠ 只认 `present`；找不到 / 不是真数据 ⇒ 返回空串（调用方据此**不画**那一颗）。 */
function _ledgerRowByTurn(rows, turn, kind) {
    const n = Number(turn);
    if (!Number.isFinite(n)) return '';
    const row = (Array.isArray(rows) ? rows : []).find((x) => Number(x?.turn) === n);
    if (!row) return '';
    const o = (kind === 'raw') ? row?.files?.raw : row?.files?.body;
    if (String(o?.state || '') !== 'present') return '';
    return (typeof o.file === 'string' && o.file) ? o.file : '';
}


/* ══ 内容指纹（源文件 @29446-29452） ══ */
/** FNV-1a 32 位：只用来判断"这条消息与上一轮是不是同一段文本" */
function _pfHash(s) {
    let h = 0x811c9dc5;
    const t = String(s ?? '');
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h;
}

/* ══ 同一条的判定（源文件 @30447-30455） ══ */
/** 「首80字 + 尾40字」指纹：跨来源比较用（两边都只有存下来的文本首尾；有整段哈希时优先哈希） */
function _rlHeadKey(m) { return _pfHash(`${m?.head || ''}\u0000${m?.tail || ''}`); }
/** 同一条的判定：两边都有整段哈希时以哈希为准（能抓出 80 字之后的改动）；只有一边有就退回首尾指纹 */
function _rlSame(a, b) {
    if (!a || !b) return false;
    if (a.role !== b.role) return false;
    if (a.h && b.h) return a.h === b.h;
    return _rlHeadKey(a) === _rlHeadKey(b);
}

/* ══ 两轮逐条差异（源文件 @30457-30516） ══ */
/**
 * 纯函数：两轮 request 的逐条差异（位置逐一对应；v6.21.9 起比对的是 git 里读回来的两轮明细）
 * 返回 { breakIdx, rows, sum:{same,new,moved,gone,changed,tokNew,tokMoved,tokGone,...} }
 *   row = { kind:'same'|'new'|'moved'|'gone'|'changed', iPrev, iCur, role, tok, tokPrev, head }
 */
function _diffTurnItems(prev, cur) {
    const out = { breakIdx: -1, rows: [], sum: { same: 0, new: 0, moved: 0, gone: 0, changed: 0, tokNew: 0, tokMoved: 0, tokGone: 0, newAI: 0, tokNewAI: 0, newSys: 0, tokNewSys: 0, newUser: 0, tokNewUser: 0 } };
    const pm = Array.isArray(prev?.msgs) ? prev.msgs : [];
    const cm = Array.isArray(cur?.msgs) ? cur.msgs : [];
    if (!pm.length || !cm.length) return out;
    const n = Math.min(pm.length, cm.length);
    let brk = n;
    for (let i = 0; i < n; i++) {
        if (!_rlSame(pm[i], cm[i])) { brk = i; break; }
    }
    out.breakIdx = brk;
    out.sum.same = brk;
    const prevAt = new Map(), curAt = new Map();
    for (let i = brk; i < pm.length; i++) { const k = _rlHeadKey(pm[i]); if (!prevAt.has(k)) prevAt.set(k, i); }
    for (let i = brk; i < cm.length; i++) { const k = _rlHeadKey(cm[i]); if (!curAt.has(k)) curAt.set(k, i); }
    const usedPrev = new Set();
    for (let i = brk; i < cm.length; i++) {
        const c = cm[i];
        const pi = prevAt.get(_rlHeadKey(c));
        if (pi !== undefined) {
            usedPrev.add(pi);
            if (pi === i) {
                if (_rlSame(pm[i], c)) { out.sum.same++; continue; }
                // **同一个位置、内容换了** → 是 changed，不是 moved（首尾预览一样也不算同一条）
                out.sum.changed++; out.sum.tokGone += pm[i].tok;
                out.rows.push({ kind: 'changed', iPrev: i, iCur: i, role: c.role, tok: c.tok, tokPrev: pm[i].tok, head: c.head });
                continue;
            }
            out.sum.moved++; out.sum.tokMoved += c.tok;
            out.rows.push({ kind: 'moved', iPrev: pi, iCur: i, role: c.role, tok: c.tok, head: c.head });
            continue;
        }
        const prevSame = (i < pm.length) ? pm[i] : null;
        if (prevSame && !_rlSame(prevSame, c) && !curAt.has(_rlHeadKey(prevSame))) {
            // 同一位置换了内容、且上一轮那条在这一轮彻底不见了 → 内容变了
            usedPrev.add(i);
            out.sum.changed++; out.sum.tokGone += prevSame.tok;
            out.rows.push({ kind: 'changed', iPrev: i, iCur: i, role: c.role, tok: c.tok, tokPrev: prevSame.tok, head: c.head });
            continue;
        }
        out.sum.new++; out.sum.tokNew += c.tok;
        // 分析盯的是 AI 轮：新来的 AI 回复是增量大头，用户消息是零头（单独列，不再混在一起看）
        if (c.role === 'assistant') { out.sum.newAI++; out.sum.tokNewAI += c.tok; }
        else if (c.role === 'user') { out.sum.newUser++; out.sum.tokNewUser += c.tok; }
        else { out.sum.newSys++; out.sum.tokNewSys += c.tok; }
        out.rows.push({ kind: 'new', iPrev: -1, iCur: i, role: c.role, tok: c.tok, head: c.head });
    }
    for (let i = brk; i < pm.length; i++) {
        if (usedPrev.has(i)) continue;
        out.sum.gone++; out.sum.tokGone += pm[i].tok;
        out.rows.push({ kind: 'gone', iPrev: i, iCur: -1, role: pm[i].role, tok: 0, tokPrev: pm[i].tok, head: pm[i].head });
    }
    out.rows.sort((a, b) => (a.iCur >= 0 ? a.iCur : a.iPrev) - (b.iCur >= 0 ? b.iCur : b.iPrev));
    return out;
}

/* ══ 本模块自己的入口（新写的接线层，不是从源文件搬的） ═══════════════════════ */

/** 账表容器：调用方给了就用它，否则用本模块自己的 id（绝不碰 Horae 的 DOM id）。
 *  顺手在容器上给两个 Horae 主题变量一份兜底值 —— 源文件那些内联样式里写着
 *  var(--horae-border) / var(--horae-bg-secondary)，本模块不读宿主扩展的样式表，
 *  而 CSS 变量是**继承**的：在容器上设一次，容器里所有元素都能用（作用域不外泄）。 */
function _ledgerBox(container) {
    if (container && container.nodeType === 1) _ledgerBoxEl = container;
    const box = _ledgerBoxEl || document.getElementById(LEDGER_BOX_ID);
    try {
        if (box && box.style) {
            if (!box.style.getPropertyValue('--horae-border')) box.style.setProperty('--horae-border', 'rgba(128,128,128,.35)');
            if (!box.style.getPropertyValue('--horae-bg-secondary')) box.style.setProperty('--horae-bg-secondary', 'rgba(128,128,128,.08)');
        }
    } catch (_) { /* 设不上不影响画表 */ }
    return box || null;
}

/**
 * 同步路径：调用方手里**已经有** /log 的 commits 时用它（不再额外发一次请求）。
 * 与异步路径（_renderDiffAnalysis）走的是同一套 _diffBuildRows ＋ _diffRenderTable，
 * 所以两条路画出来的表逐字节相同。
 *
 * @param {Element} container 画表的容器元素
 * @param {Array} commits     /log 回的 commits（与源文件 _gitLogQueryLog 的形状一致）
 * @param {{chatKey?:string, servedKey?:string, chatNow?:Array, note?:string}} opts
 *        chatKey   —— 当前记录 id（喂给 _diffBuildRows 的实验链取数键 / 回退闸门）
 *        servedKey —— 这一份 commits 到底是哪个键的（/log 回退时与 chatKey 不同）
 *        chatNow   —— 当前聊天数组（不给就现场读 getContext().chat）
 *        note      —— 表下面那行小字（只装警告；正常状态下不传）
 * @returns {Array|null} 建出来的行（失败返回 null）
 */
export function renderLedgerInto(container, commits, opts = {}) {
    const box = _ledgerBox(container);
    if (!box) return null;
    setChatKey(opts.chatKey || '');
    /* ★ 2026-09-24：记录服务地址由调用方注入（面板走的是它自己那套探活）——
     *   楼层格底下那两行入口要靠它拼查看页网址。见 _ledgerRecordBase 那段注释。 */
    if (typeof opts.apiBase === 'string' && opts.apiBase) _ledgerApiBase = opts.apiBase;
    const list = Array.isArray(commits) ? commits : [];
    /* ★★ 2026-09-24【真 bug 修复 · 顺手抓到的】这里原来**没有** _turnRelRemember ——
     *   源文件里它在 _renderDiffAnalysis 的取数那一步（@2018）调用，而面板这条路
     *   （renderLedgerInto 直接把 commits 交进来）**跳过了那一步** ⇒ _turnRelMap 恒为空
     *   ⇒ _turnRel 一律退回兜底名 turns/NNNNN.json，_turnName 跟着错。
     *   实测（记录服务 /log）：老轮次的真名是 turns/00000.txt，而这一格第 4 行会写
     *   「比00000.json（生成时的第 1 轮）」—— **指着一个盘上不存在的文件**。
     *   这一行同时喂饱第 4 行那句文案与新的「同上轮↗ / 跟上轮↗」（它们要拿真名去问 git diff）。 */
    _turnRelRemember(list);
    const chatNow = (Array.isArray(opts.chatNow) && opts.chatNow.length) ? opts.chatNow : _diffChatNow();
    const servedKey = String(opts.servedKey || opts.chatKey || '');
    const rows = _diffBuildRows(list, chatNow, servedKey);
    _diffRenderTable(rows, String(opts.note || ''), 0, box);
    return rows;
}

/** 账表容器在本模块里的默认 id（调用方要自己建容器时用它）。
 *  与源文件那个 #horae-diff-table 是**两个** id —— 不抢 Horae 的地盘。 */
export function ledgerBoxId() { return LEDGER_BOX_ID; }
