/**
 * hitOpt（命中优化插件）—— **独立的酒馆扩展**
 *
 * 【它是什么】
 *   把每一轮 request 的缓存账（官方 usage / 服务端现算的本地 lcp / 断点后未命中 / 白付）
 *   从**记录服务**（酒馆的 server plugin）读出来，画成一张表。
 *
 * 【它刻意不是什么 —— 这是本扩展的第一设计约束】
 *   它**不依赖 Horae 扩展本体**：
 *     · 不 import Horae 的任何模块（只 import 酒馆自己的 /scripts/extensions.js 与 /script.js）
 *     · 不读 window.Horae
 *     · 不碰 Horae 的 DOM（不往它的抽屉里塞东西、不用它的类名、不 import 它的样式）
 *   ⇒ Horae 装没装、升不升级，本扩展照常工作。
 *   ⚠ 与 Horae 的**联动**（挂进它的抽屉、读它的池化读数）是**以后单独做的配置项**，
 *     这一版里一个字都没有。
 *
 * 【数据从哪来】
 *   酒馆把每个 server plugin 挂在 /api/plugins/<info.id> 下：
 *     · hitopt-git   —— 记录服务（每轮出网原文 + 官方 usage + 本地现算）
 *     · wiretap —— 抓包服务（**本插件自己的一个模块**，传输层截真 POST body，是记录的唯一内容来源）
 *   两个 id 都是**服务端模块里写死的**。本扩展**不写死地址**：先向 /status 问一次，
 *   把真实挂载名学下来再拼地址（宿主改了 id、或有人并列装两套时，写死的地址会整条断掉）。
 *   ★ 2026-09-24（第二十三批）：记录服务的 `info.id` 从 `horae-git` 改成 `hitopt-git`
 *     （用户原话："这里的 horae 的 id 也没改 hitopt"）⇒ 候选表**新的在前、旧的兜底**：
 *     服务端是酒馆启动时加载的，没重启时旧路由还在 ⇒ 面板照常能用，重启后自动切到新名。
 *
 * 【怎么知道"现在看哪一场"（定位规则，不猜）】
 *   ① 按聊天算一个 id：`chat_metadata.horae_repo.id`（Horae 盖的章）→ 聊天文件名。
 *      **只读，绝不盖章** —— 盖章是写记录那一侧（/turn）的职责，读的一侧乱生成 =
 *      查一个不存在的仓库，还会把"空结果"当成真相。
 *   ② 把它按**服务端 safe() 的同一套规则**规范化，去 /status 的 chats 列表里**核对**。
 *      核对上 ⇒ 用列表里那个名字查（一定存在）。
 *      核对不上 ⇒ **如实说"定位不到"**，并把所有场列出来让用户自己选（**不猜一个顶上**）。
 */
import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types, doNavbarIconClick } from '/script.js';
// ★ 账表（从 Horae 搬来的差异表）—— 自包含模块，见 ledger.js。它不 import Horae、不读 window.Horae。
import { renderLedgerInto, _getPrice, _diffCostOf } from './ledger.js';
// ★★ 缓存优化算法（从 horae.client.js 整段搬来，只改了依赖来源）—— 见 opt.js 文件头。
//    它在酒馆的 CHAT_COMPLETION_PROMPT_READY / CHAT_COMPLETION_SETTINGS_READY 上各挂一个监听；
//    manifest 里 loading_order = 200 > Horae 的 100 ⇒ 注册更晚 ⇒ 一定排在 Horae 之后、等它跑完。
import { installOpt } from './opt.js';

const MODULE_NAME = 'hitOpt';
/* ⛔⛔ 版本号纪律（用户 2026-09-24 **两次**当场纠正，别再忘）：
 *   · 写成三段是 `A.B.C` —— **前两段 `A.B` 是"主版本"，只有用户亲口说才能动**
 *     （他说"升主版本号"就是那一次授权，动的时候**第三段归 0**）；
 *   · **只有第三段（小版本）是我能自己改的**：`7.1.0` → `7.1.1` → `7.1.2` …；
 *   · 反例就在眼前（同一天挨了两次）：
 *     ① `7.0.7` 之后我自己涨到 `v7.1.3` —— 前两段是我动的 ⇒ 他："升主版本号，还有小版本号
 *        只能0.0.\*\*这里改，你又忘记原则了"；
 *     ② 我据此把号改成 `v7.3.0`（又动了第二段）⇒ 他："**现在才是7.1版本哦，不是7.2，
 *        我亲口说才能改前面的两个版本，你只能改小版本**" ⇒ 落成 `v7.1.0`。
 *   · ⚠ **没有"另一条线"了** —— 用户 2026-09-24 原话："**没有HORAE_CACHE_PATCH，我们只有独立插件hitOpt**"。 */
/* ★ 2026-09-24【**用户亲口升大版本** —— 原话："升大版本"】
 *   ⇒ `v7.1.6` → **`v7.3.0`**（大版本 +1、小版本归 0）。
 *   ⚠ 纪律不变：前两段（`7.2`）**只有用户亲口说才能动**；我自己只能改第三段。
 *   ⚠ 那个常量名是历史遗留（改名要动构建链 `tools/parts/__var_*.js` ＋ `tools/plan.json`），
 *     但**它的值就是本插件的版本号**（抬头与面板报的 `cli=` 读的正是它）⇒ 升版本时与 `APP_VERSION` 一起改。 */
const APP_VERSION = 'v7.3.6';
/* ★ 2026-09-25【服务端那一半够不够新 —— 让它自己说】我提议、用户答"可以"。
 *   为什么非有这个不可：服务端**不会自动更新** —— 酒馆的 `enableServerPluginsAutoUpdate`
 *   只对 **git 仓库**生效（`src/plugin-loader.js` L259-267：`checkIsRepo` 不通过就 `continue`），
 *   而我们是用 `install-server.bat` 拷进去的**两个文件**。⇒ 用户忘了重跑那个 bat，
 *   就会**一直用着旧服务端还以为是最新的**：新路由、新字段一个都不生效，而面板上**看不出来**。
 *   判据：服务端 `/status` 报的 `v` 就是它的 `ROUTE_V`（本项目纪律 = 服务端动一次涨一次）
 *   ⇒ 客户端声明"我这一版至少要 ≥ N"，比它小就是旧的。
 *   ⚠ `REQUIRED_SRV_ROUTE` 与 `index.mjs` 的 `ROUTE_V` **必须相等**，有验收钉子钉着
 *     （`check/srv_gate_test.mjs` ⇒ 服务端涨了这里忘了跟，钉子是红的，不会悄悄漂移）。 */
const REQUIRED_SRV_ROUTE = 57;
/* ★ 2026-09-24（第二十三批）：记录服务的挂载名 —— 服务端 `info.id` 从 `horae-git` 改成 `hitopt-git`。
 *   候选**新的在前、旧的兜底**（服务端模块只在酒馆启动时加载 ⇒ 没重启时旧路由还在）。 */
const LEDGER_IDS = ['hitopt-git', 'horae-git'];
const DEFAULT_LEDGER_ID = LEDGER_IDS[0];
/** 与 Horae 同一个键名（读它盖的章）。写成字面量而不是 import —— 就是为了不依赖 Horae。 */
const HORAE_REPO_META = 'horae_repo';

const DEFAULTS = {
    enabled: true,
    ledgerId: DEFAULT_LEDGER_ID,   // 记录服务的 info.id（探到真名后会被真实值覆盖，见 apiId）
    autoRefresh: true,             // 换聊天 / 生成结束后自动拉一次
    pick: '',                      // 手动选定的场（空 = 按当前聊天自动定位）
};

const settings = { ...DEFAULTS };

let apiId = '';          // 探到的**真实**挂载名（/status 回的 id）
let lastStatus = null;   // /status 的响应
let lastLog = null;      // /log 的响应
let lastErr = '';
let busy = false;

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function el(id) { return document.getElementById(id); }

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
}

function log(...a) { try { console.log('[ledger]', ...a); } catch (_) { /* 控制台不可用也不影响 */ } }

/** 数：能显示就显示，拿不到一律 `—`（**绝不拿 0 顶** —— 0 是"真的是零"，— 是"没有这个数"）。 */
function num(v) {
    return Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v).toLocaleString('en-US') : '—';
}
function pct(h, p) {
    const H = Number(h); const P = Number(p);
    if (!Number.isFinite(H) || !Number.isFinite(P) || P <= 0) return '—';
    return `${(H / P * 100).toFixed(1)}%`;
}

/** 服务端 safe() 的同一套规则（记录目录名就是它算的，核对时必须一字不差）。 */
function safeKey(chat) {
    return String(chat || 'default').replace(/[^0-9A-Za-z\u4e00-\u9fa5_.@-]+/g, '_').slice(0, 80);
}

/* ── 记录服务的读接口 ───────────────────────────────────────────────────────
 * 全是 GET ⇒ **不需要 CSRF**（酒馆的 csrf-sync 只管 POST/PUT/DELETE）。
 * 为什么带超时：探活失败时不能让界面一直转（Horae 那边踩过"没超时的探针占满连接池"的坑）。 */

async function api(pathname, timeoutMs = 8000) {
    /* ★ 2026-09-24：候选**逐个试** —— 探到的真名 ＞ 设置里存的 ＞ 候选表（新名在前、旧名兜底）。 */
    const ids = [];
    if (apiId) ids.push(apiId);
    if (settings.ledgerId) ids.push(settings.ledgerId);
    for (const x of LEDGER_IDS) ids.push(x);
    const bases = [...new Set(ids)].filter(Boolean).map((x) => `/api/plugins/${x}`);
    if (!bases.length) throw new Error('没有可用的记录服务地址');

    let err = '';
    for (const base of bases) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const r = await fetch(base + pathname, { signal: ctl.signal });
            clearTimeout(timer);
            if (!r.ok) { err = `${base}${pathname} → HTTP ${r.status}`; continue; }
            return await r.json();
        } catch (e) {
            clearTimeout(timer);
            err = `${base}${pathname} → ${e?.name === 'AbortError' ? '超时' : (e?.message || e)}`;
        }
    }
    throw new Error(err || '请求失败');
}

/** 探活 + 学真实挂载名。每次都重学（服务端重启/改名后能自己跟上）。 */
async function probe() {
    try {
        const j = await api('/status', 4000);
        lastStatus = j && typeof j === 'object' ? j : null;
        if (lastStatus?.ok) {
            if (typeof lastStatus.id === 'string' && lastStatus.id && lastStatus.id !== apiId) {
                apiId = lastStatus.id;
                log('学到记录服务的真实挂载名', apiId);
            }
            lastErr = '';
        } else {
            lastErr = '记录服务回了 ok:false';
        }
    } catch (e) {
        lastStatus = null;
        lastErr = e?.message || String(e);
    }
    return lastStatus;
}

/* ── 定位"看哪一场" ───────────────────────────────────────────────────────── */

/** 当前聊天的记录 id（**只读**版，与 Horae 的 _currentChatKey 同一套口径的前两条）。 */
function chatKeyRead() {
    try {
        const ctx = getContext();
        const who = String(ctx?.characters?.[ctx?.characterId]?.name || ctx?.characterId || ctx?.groupId || '');
        const md = ctx?.chatMetadata;
        const stamp = (md && typeof md === 'object') ? md[HORAE_REPO_META] : null;
        if (stamp && typeof stamp.id === 'string' && stamp.id) return `${who}::${stamp.id}`;
        const file = ctx?.getCurrentChatId?.() || ctx?.chatId || '';
        if (typeof file === 'string' && file) return `${who}::${file}`;
        return '';
    } catch (_) { return ''; }
}

/** 决定这一发查哪个场。返回 { key, how } —— how 是**这一发凭什么查它**，要如实显示出来。 */
function resolveTarget() {
    const chats = Array.isArray(lastStatus?.chats) ? lastStatus.chats.map(String) : [];
    if (settings.pick) {
        return { key: settings.pick, how: '手动选定', sure: true };
    }
    const raw = chatKeyRead();
    if (!raw) return { key: '', how: '算不出当前聊天的记录 id', sure: false };
    const want = safeKey(raw);
    if (!chats.length) return { key: want, how: `按当前聊天（记录服务没给 chats 列表）`, sure: false };
    if (chats.includes(want)) return { key: want, how: '按当前聊天', sure: true };
    return { key: '', how: `当前聊天（${want}）在记录服务里没有对应的场`, sure: false };
}

async function fetchLog() {
    const t = resolveTarget();
    if (!t.key) { lastLog = { ok: true, commits: [], _target: t, _empty: true }; return lastLog; }
    try {
        const j = await api(`/log?chat=${encodeURIComponent(t.key)}`);
        const commits = (j && j.ok && Array.isArray(j.commits)) ? j.commits : [];
        lastLog = Object.assign({}, j, { commits, _target: t, _empty: !commits.length });
    } catch (e) {
        lastLog = { ok: false, commits: [], _target: t, _empty: true, _err: e?.message || String(e) };
    }
    return lastLog;
}

/* ── 渲染 ─────────────────────────────────────────────────────────────────── */

/** 账表的列（**固定**，就是缓存账本身要看的那些；要看全部字段点"原始"） */
const COLS = [
    { k: 'no', t: '轮', n: 1 },
    { k: 'at', t: '时间', n: 0 },
    { k: 'floor', t: '楼层', n: 1 },
    { k: 'msgs', t: '条数', n: 1 },
    { k: 'totalChars', t: '出网字', n: 1 },
    { k: '__p', t: '官方请求', n: 1 },
    { k: '__h', t: '官方命中', n: 1 },
    { k: '__m', t: '官方未中', n: 1 },
    { k: '__pct', t: '官方率', n: 1 },
    { k: 'tokExact', t: '本地exact', n: 1 },
    { k: 'hitChars', t: '本地命中字', n: 1 },
    { k: 'missChars', t: '本地未中字', n: 1 },
    { k: 'taxChars', t: '白付字', n: 1 },
    { k: 'verCli', t: 'cli', n: 0 },
];

function cell(c, k) {
    if (k === '__p') return num(c?.usage?.promptTok);
    if (k === '__h') return num(c?.usage?.hit);
    if (k === '__m') return num(c?.usage?.miss);
    if (k === '__pct') return pct(c?.usage?.hit, c?.usage?.promptTok);
    /* ★ 2026-09-25（用户："这里的 cli 记得附上 srv 啊"）：这一格原来只报**客户端**那一半，
     *   而记录抬头上本来就写着两个（`| 版本 cli=v7.3.3 srv=57 tok=sent`）⇒ 只显示一半，
     *   出问题时对不出"这一轮到底是哪个**组合**写下的"。现在照抬头那一格的同款格式拼成
     *   `v7.3.3 · srv57`（与面板右上角 `APP_VERSION · srvNN` 同一个写法）。
     *   ⚠ 老记录可能没有 srv 那一段（`srv=` 是 v6.24.69 才进抬头的）⇒ **有几个报几个**：
     *     缺的那个不编一个出来，两个都没有才写 `—`（全项目通用的"没有这个数"记号）。 */
    if (k === 'verCli') {
        const cli = String(c?.verCli || '').trim();
        const srvRaw = c?.verSrv;
        const srv = (srvRaw === null || srvRaw === undefined || String(srvRaw).trim() === '')
            ? '' : 'srv' + String(srvRaw).trim();
        if (!cli && !srv) return '—';
        return [cli, srv].filter(Boolean).join(' · ');
    }
    const v = c?.[k];
    if (typeof v === 'number') return num(v);
    return v == null || v === '' ? '—' : String(v);
}

/* ★★ 2026-09-25【没接通时，把"怎么装服务端"直接写进面板】用户三句原话：
 *   "光提示不够啊 我自己都不知道扩展目录在哪" ／ "记录服务哪里" ／
 *   "建议这个 div 里面放第二行信息（仅在未连接 hitopt-git 时出现）"
 *   ＋ "xxxx如何安装服务端插件之类的新手教程 我自己都不会别说别人了"。
 *   为什么非要有：扩展是**两半**，而"服务端那一半要手动放一次"对新手**完全无从下手** ——
 *   原来的提示只写"找到本扩展目录里的 scripts/install-server.bat"，
 *   可**"扩展目录在哪"**恰恰是他不知道的那一件事（那是酒馆内部的目录结构，不是他建的）。
 *   ⇒ 这里给出**从酒馆根目录出发的完整相对路径**，并把"酒馆根目录"解释成
 *     **"你双击启动酒馆的那个文件所在的文件夹"** —— 这句话谁都能对上号。
 *   ⛔ 不写死任何盘符路径（别人的机器不一样；写死了就是错的）。
 *   ⚠ 只在**未接通**时画（调用点判 `lastStatus?.ok`）：装好了它就一个字都不占。
 *   ⚠ 它**不进 bits** —— 上面那一行是用 ` ｜ ` 连接的，教程块不能被那样连。 */
const HLG_INSTALL_HELP = '<div class="hlg-help">'
    + '<b>服务端插件还没装</b> —— 这个扩展是两半，"记录服务"就是缺的那一半'
    + '（它负责把每一轮<b>真发出去的那份请求</b>存下来，面板上的数才算得出来）。'
    + '<ol>'
    + '<li>打开你的 <b>酒馆文件夹</b>：<b>你双击启动酒馆的那个文件，就在这个文件夹里</b> —— '
    + '里面能看到 <code>config.yaml</code> 和 <code>plugins</code>。</li>'
    + '<li>从它开始一路点进去，找到这个文件：'
    + '<div class="hlg-help-path">public &rarr; scripts &rarr; extensions &rarr; third-party &rarr; '
    + '<b>hitOpt</b> &rarr; scripts &rarr; <b>install-server.bat</b>'
    + '<button class="hlg-btn hlg-copy" type="button" data-hlg-copy="public\\scripts\\extensions\\third-party\\hitOpt\\scripts" '
    + 'title="复制这段路径，粘到文件资源管理器的地址栏里回车">📋 复制路径</button></div></li>'
    + '<li>把第 1 步那个<b>酒馆文件夹本身</b>，用鼠标<b>拖到 install-server.bat 上</b>松手 —— '
    + '会弹出一个黑窗口，它自己会把服务端放进 <code>plugins/</code>'
    + '（<b>只拷两个文件，不会动你的任何记录</b>）。</li>'
    + '<li>确认 <code>config.yaml</code> 里有 <code>enableServerPlugins: true</code>'
    + '（默认是 <code>false</code>，要改成 <code>true</code>），然后<b>重启酒馆</b>。</li>'
    + '</ol>'
    + '装好之后这一行会变成绿色的「● 已连接」，这段说明自动消失。'
    + '<div class="hlg-help-note">'
    + '⚠ 为什么不给一个"点一下就自动打开文件夹"的链接：<b>浏览器不许网页打开你电脑上的本地文件夹</b>'
    + '（安全限制，所有浏览器都一样），这一步只能你手动点。'
    + '<br>不是 Windows？把仓库 <code>server/</code> 里的 <code>index.mjs</code> '
    + '和 <code>wiretap.mjs</code> 手动拷进 <code>&lt;酒馆&gt;/plugins/hitopt-git/</code> 就行 —— '
    + '仓库首页的「安装」一节有完整说明。</div>'
    + '</div>';

function statusHtml() {
    const bits = [];

    if (lastStatus?.ok) {
        const sid = String(lastStatus.id || '?');
        bits.push(`记录服务 <span class="hlg-ok">● 已连接</span>`
            + ` <span class="hlg-dim">id=${esc(sid)}`
            + `${lastStatus.v != null ? ` v${esc(lastStatus.v)}` : ''}</span>`
            /* ★ 2026-09-24：探到的还是旧挂载名 ⇒ **如实说一句**（服务端模块只在酒馆启动时加载，
             *   改了名要重启才生效）。⛔ 不许把旧名显示成新名（撒谎），也不许不提（那会让人以为改名没做）。 */
            + `${sid === 'horae-git' ? ' <span class="hlg-dim">（旧挂载名 · 重启酒馆后变 hitopt-git）</span>' : ''}`);
    } else {
        bits.push(`记录服务 <span class="hlg-bad">○ 未接通</span>`
            + ` <span class="hlg-dim">${esc(lastErr || '还没探过')}</span>`);
    }

    const t = lastLog?._target;
    const n = Array.isArray(lastLog?.commits) ? lastLog.commits.length : 0;
    if (t) {
        if (n) {
            bits.push(`本场 <b>${n}</b> 轮`
                + ` <span class="hlg-dim">${esc(t.key)} · ${esc(t.how)}</span>`);
        } else {
            bits.push(`<span class="hlg-bad">没查到轮次</span>`
                + ` <span class="hlg-dim">${esc(t.how)}</span>`);
            if (lastLog?._err) bits.push(`<span class="hlg-bad">${esc(lastLog._err)}</span>`);
        }
    }

    const chats = Array.isArray(lastStatus?.chats) ? lastStatus.chats : [];
    if (chats.length) {
        const opts = ['<option value="">（自动：按当前聊天）</option>']
            .concat(chats.map((c) => `<option value="${esc(c)}"${settings.pick === c ? ' selected' : ''}>${esc(c)}</option>`));
        bits.push(`<select id="hlg-pick" class="hlg-btn" style="max-width:260px">${opts.join('')}</select>`);
    }
    /* ★ 2026-09-25【未接通 ⇒ 整行后面再挂一块"怎么装服务端"的新手教程】见 HLG_INSTALL_HELP 那段。
     *   ⚠ 它**不进 bits** —— 上面那一行是用 ` ｜ ` 连接的，教程块被那样连起来就没法读了。
     *   ⚠ 接通了就是空串（用户点名的"仅在未连接时出现"）。
     *   ⚠ 这条是**验收钉子**（`check/srv_gate_test.mjs` ⑱）钉住的：常量写了不接线 ⇒ 当场红。 */
    return bits.join(' ｜ ') + (lastStatus?.ok ? '' : HLG_INSTALL_HELP);
}

/* ★ 2026-09-24【第二行：费用条】—— 用户原话："**换个费用行位置 你直接跟第一轮的div美化一样，放第二行**"，
 *   并当场点名七项内容：总费用 / hit 费用 / miss 费用 / out 费用 ＋ hit 汇总 / miss 汇总 / out 汇总。
 *   ⚠ 钱**只有一套算式**：`ledger._diffCostOf`（命中×命中价 ＋ 未命中×全价 ＋ 输出×输出价；
 *     单价走 `_getPrice()` 的时段档）—— 顶部**不另算一套**（两套尺子必然对不上，这个项目吃过亏）。
 *     hit／miss／out 各自的钱也**不另立公式**：把另外两项传 0 再调同一个函数（算式是线性的）。
 *   ⚠ 口径：「费用」＝**最近一轮**，「汇总」＝**本场累计**；数据只取 `/log` 已经回来的 commits
 *     （自带官方 usage）—— 不额外请求、不额外记账。
 *   ⚠ 拿不到就如实写"还没有官方 usage"：⛔ 不拿 0 顶上、不猜。 */
function costHtml(commits) {
    try {
        const list = (Array.isArray(commits) ? commits : []).filter((c) => c && c.usage);
        if (!list.length) return '<span class="hlg-dim">费用：还没有官方 usage（这一场还没发出过请求）</span>';
        const price = _getPrice();
        /* ★ 2026-09-24【口径 · 用户当场选定（选项 A）】—— 上一版我把"本轮的钱"和"整场的钱"
         *   并排放在一行里（总费用 ¥0.07 旁边挂着汇总 ¥0.40 / ¥0.85），用户当场质疑"离谱"。
         *   ⇒ 现在：四个「费用」＝**全场累计的钱**（总／hit／miss／out，单价走 `_getPrice()` 时段档）；
         *           三个「汇总」＝**全场累计的 token 数**（不是钱 —— 悬停里写明单位）。
         *   ⛔ 以后别再往这一行里混第二种口径。 */
        let sh = 0, sm = 0, so = 0;
        for (const c of list) {
            sh += Number(c.usage.hit) || 0;
            sm += Number(c.usage.miss) || 0;
            so += Number(c.usage.out) || 0;
        }
        const y = (n) => '¥' + Number(n || 0).toFixed(4);
        const n0 = (n) => Number(n || 0).toLocaleString('en-US');       // token 千分位
        const one = (h, m, o) => _diffCostOf(h, m, o, price).total;     // ← 唯一那套算式
        const seg = (t, v, tip) => `<span class="hlg-dim"${tip ? ` title="${tip}"` : ''}>${t}</span> <b>${v}</b>`;
        return [
            seg('总费用', y(one(sh, sm, so)), `本场 ${list.length} 轮累计：命中＋未命中＋输出`),
            seg('hit 费用', y(one(sh, 0, 0)), '本场累计命中 token 的钱（缓存价）'),
            seg('miss 费用', y(one(0, sm, 0)), '本场累计未命中 token 的钱（全价）'),
            seg('out 费用', y(one(0, 0, so)), '本场累计输出 token 的钱（不打折）'),
            seg('hit 汇总', n0(sh), '本场累计**命中 token 数**（不是钱）'),
            seg('miss 汇总', n0(sm), '本场累计**未命中 token 数**（不是钱）'),
            seg('out 汇总', n0(so), '本场累计**输出 token 数**（不是钱）'),
        ].join(' ｜ ');
    } catch (e) { try { log('费用条渲染失败', e); } catch (_) { } return ''; }
}

function tableHtml(commits) {
    if (!Array.isArray(commits) || !commits.length) return '';
    const head = COLS.map((c) => `<th>${esc(c.t)}</th>`).join('');
    const rows = commits.map((c) => {
        const tds = COLS.map((col) => {
            const txt = cell(c, col.k);
            const cls = col.n ? 'hlg-mono' : 'hlg-txt hlg-mono';
            return `<td class="${cls}">${esc(txt)}</td>`;
        }).join('');
        const title = esc(JSON.stringify({ no: c?.no, subject: c?.subject, srcWire: c?.srcWire, tokSrc: c?.tokSrc }));
        return `<tr title="${title}">${tds}</tr>`;
    }).join('');
    return `<div class="hlg-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** 原始视图：把这一场的 commits 原样铺开（排错用；表里放不下的字段全在这儿）。 */
function rawHtml(commits) {
    if (!Array.isArray(commits) || !commits.length) return '';
    return `<details style="margin-top:6px"><summary class="hlg-dim">原始 JSON（${commits.length} 轮）</summary>`
        + `<pre class="hlg-mono" style="max-height:40vh;overflow:auto;font-size:11px">${esc(JSON.stringify(commits, null, 1))}</pre></details>`;
}

/* ★ 2026-09-25【工具行左侧那条**设计说明**】用户原话（**逐字**，一个字没改）：
 *   "有意的Δmiss设计：在对话预设中，最后的连续system身份消息块，使用其块的开头直至
 *    对话预设消息尾部相关内容视为保真并始终发送"
 *   位置由用户在截图上**圈定**：工具行（「原始 / 刷新」那一行）里按钮**左边**那片空白。
 *   ⚠ 这是**说明**不是数据 ⇒ 常驻显示（不藏在悬停里），悬停里再放一份同样的全文（双保险）；
 *     冒号前那半句加粗当标题，**冒号与正文逐字未动**。 */
const HINT_MISS_DESIGN = '有意的Δmiss设计：在对话预设中，最后的连续system身份消息块，使用其块的开头直至对话预设消息尾部相关内容视为保真并始终发送';

/** 上面那条说明的 HTML（冒号前那半句加粗当标题，其余逐字）。
 *  ⚠ 一律过 `esc()`：这段话眼下没有 HTML 特殊字符，但它是**给人看的正文**，
 *    以后谁改字都不该因为多打一个 `<` 就把整块面板画坏。 */
function hintHtml() {
    const s = String(HINT_MISS_DESIGN);
    const i = s.indexOf('：');
    const head = i > 0 ? s.slice(0, i) : s;
    const tail = i > 0 ? '：' + s.slice(i + 1) : '';
    return `<span class="hlg-hint" id="hlg-hint" title="${esc(s)}">`
        + `<i class="fa-solid fa-circle-info"></i><b>${esc(head)}</b>${esc(tail)}</span>`;
}

let rawOpen = false;

function paint() {
    const box = el('hlg-body');
    if (!box) return;
    /* ★ 右上角报**双端版本**（客户端 ＋ 服务端）—— 用户 2026-09-24 定版原话：
     *   "右上角就一个7.0.4的版本号，而没有说明BS双端版本，这对于我们的后续维护是不利的"
     *   服务端版本取自 /status 的 v（探不到就写 — 这个我们全项目通用的"没有这个数"记号，
     *   ⛔ 不写死、不猜、也不拿客户端号顶）。刷一次就更新一次，所以重启酒馆后按刷新即可看到新号。 */
    const verEl = el('hlg-ver');
    if (verEl) verEl.textContent = APP_VERSION + ' · srv' + (lastStatus?.v != null ? lastStatus.v : '—');
    const commits = Array.isArray(lastLog?.commits) ? lastLog.commits : [];
    // ★ 状态条要**包一层** —— statusHtml() 返回的是裸 inline 片段，
    //   不包的话 .hlg-status 那套（圆角底/内边距/行高）一条都用不上，文字会在窄容器里乱折。
    // ★ 逐轮明细那张大表（tableHtml）**默认不画** —— 用户口径：一直用的那个面板（ledger.js）才是主界面，
    //   这张表挤在它上面等于同一场账画了两遍、还各说各话（实测 49 行 vs 49 行）。
    //   要看得点「原始」，把它和原始文本一起叫出来 —— 信息不丢，只是不占主视野。
    box.innerHTML = `<div class="hlg-status">${statusHtml()}</div>`
        /* ★ 第二行＝**费用条**（用户："放第二行"）—— 用与第一行**同一个** `.hlg-status` 类，
         *   所以圆角底/内边距/行高那套美化一个字都不用重写。 */
        + `<div class="hlg-status">${costHtml(commits)}</div>`
        + (rawOpen ? tableHtml(commits) + rawHtml(commits) : '');
    // ★ 接线（只此两行）：把这一场的 commits 交给账表模块去画（它自己建/用自己的容器，不碰上面这些行）。
    const lbox = el('hlg-ledger') || (() => { const d = document.createElement('div'); d.id = 'hlg-ledger'; box.appendChild(d); return d; })();
    /* ★ 2026-09-24：把**探到的真实挂载名**一并交进去 —— 账表楼层格底下那两行入口
     *   （文档↗ / 对比↗）要靠它拼查看页网址。账表模块自己那份 _gitLogBase 在本扩展这条路上
     *   恒为空（它走的是 _gitLogQueryLog，而这里是把 commits 直接交给它画）⇒ 不注入就拼不出网址。 */
    const apiBase = apiId ? `/api/plugins/${apiId}` : '';
    try { renderLedgerInto(lbox, commits, { chatKey: resolveTarget().key, apiBase }); } catch (e) { log('账表渲染失败', e); }
    const pick = el('hlg-pick');
    if (pick) {
        pick.addEventListener('change', () => {
            settings.pick = String(pick.value || '');
            try { extension_settings[MODULE_NAME].pick = settings.pick; saveSettingsDebounced(); } catch (_) { /* 存不下不影响看 */ }
            void refresh('pick');
        });
    }
}

/* ── 动作 ─────────────────────────────────────────────────────────────────── */

async function refresh(why = '') {
    if (busy) return;
    busy = true;
    try {
        await probe();
        if (lastStatus?.ok) {
            /* ★ 2026-09-25【服务端旧了要自己说】—— 判据与来由见 `REQUIRED_SRV_ROUTE` 那一段。
             *   只在**探到了服务端**时判：探不到（压根没装）是 `_tipIfServerMissing` 那条路的活，
             *   两条不重叠，免得"没装"被说成"旧了"、或者一次弹两条。
             *   ⚠ 它自己只弹一次（`_srvStaleTipShown`），所以放在这个每次刷新都跑的地方是安全的。 */
            try { _tipIfServerStale(lastStatus); } catch (_) { /* 提示失败绝不影响刷新 */ }
            await fetchLog();
        } else lastLog = null;
    } catch (e) {
        lastErr = e?.message || String(e);
        log('刷新失败', why, lastErr);
    } finally {
        busy = false;
        try { paint(); } catch (e) { log('渲染失败', e); }
    }
}

/* ★ 2026-09-24：把刷新口子挂到全局 —— `opt.js` 的官方 usage 采集（`POST /usage`）一落盘就刷面板。
 *   ⛔ 为什么只暴露这一个函数：opt.js 与 index.js 是同一次页面加载里的两个模块，
 *     它们**不许**互相 import（opt.js 是从魔改版整份搬来的，导入方向一旦成环就再也拆不干净）
 *     也不该共享可变状态 —— 只留一个"请刷新一下"的口子，方向单一、看不见对方内部。
 *   ⚠ opt.js 那边是 `globalThis.hitOpt?.refresh?.()`：拿不到就静默跳过
 *     （面板本来还有「刷新」按钮与自动刷新兜底，绝不因为这一跳让功能挂掉）。 */
try { globalThis.hitOpt = Object.assign(globalThis.hitOpt || {}, { refresh, version: APP_VERSION, module: MODULE_NAME }); } catch (_) { /* 挂不上也不影响主流程 */ }

/* ★ 2026-09-24【楼层格那颗「重算」按钮的委托点】（用户："加个重算按钮在红圈处 / 单元格第一行 楼层右边"）
 *   面板那张表是**HTML 字符串**画的（ledger.js 不绑事件），而本项目禁 inline onclick
 *   （不赌宿主 CSP 放不放 inline）⇒ 在这里**一次**绑在 document 上，按 `data-hlg-recalc` 找目标。
 *   点它 ＝ 调**插件自己的自愈**（与自动补结构同一条路），⛔ 不动发出去的那串字。 */
try {
    document.addEventListener('click', (ev) => {
        const t = ev.target;
        const b = (t && typeof t.closest === 'function') ? t.closest('[data-hlg-recalc]') : null;
        if (!b) return;
        ev.preventDefault();
        const no = Number(b.getAttribute('data-hlg-recalc'));
        const fn = globalThis.hitOpt && globalThis.hitOpt.recalcTurn;
        if (typeof fn !== 'function') { log('重算：hitOpt.recalcTurn 还没接上（页面没 F5？）'); return; }
        b.textContent = '重算中…';
        Promise.resolve(fn(no))
            .then(() => {
                b.textContent = '已重算';
                setTimeout(() => { void refresh('recalc'); }, 400);
            })
            .catch((e) => { b.textContent = '重算失败'; log('重算失败', e); });
    });
} catch (_) { /* 绑不上也不影响别的 */ }

/* ★ 2026-09-25【「复制路径」那个按钮的委托点】—— 同样不用 inline onclick（本项目禁它），走 document 委托：
 *   `data-hlg-copy` —— 把一段路径复制到剪贴板（"未接通"那条教程里的「📋 复制路径」）。
 *   ⚠ `navigator.clipboard` 只在安全上下文可用；酒馆在 127.0.0.1 上跑，浏览器算它是安全的 ⇒ 可用。
 *     **失败就如实说"请手动选中复制"**，不假装成功。
 *   ⚠ 用户当天对"点一下就自动打开文件夹"（服务端执行 explorer 那条路）说了 **"那算了"** ⇒ **不做**，
 *     所以这里**只有复制这一个分支**（⛔ 不留"永远跑不到"的死代码）。 */
try {
    document.addEventListener('click', (ev) => {
        const t = ev.target;
        if (!t || typeof t.closest !== 'function') return;
        const cp = t.closest('[data-hlg-copy]');
        if (cp) {
            ev.preventDefault();
            const txt = String(cp.getAttribute('data-hlg-copy') || '');
            const back = () => { cp.textContent = '📋 复制路径'; };
            const done = (okk) => { cp.textContent = okk ? '✓ 已复制' : '⚠ 请手动选中复制'; setTimeout(back, 1800); };
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(txt).then(() => done(true), () => done(false));
                } else { done(false); }
            } catch (_) { done(false); }
            return;
        }
    });
} catch (_) { /* 绑不上也不影响别的 */ }

/* ── 界面 ─────────────────────────────────────────────────────────────────── */

function mountUi() {
    if (el('hlg_drawer')) return;
    const holder = el('top-settings-holder');
    if (!holder) { log('找不到酒馆的顶栏容器 #top-settings-holder，界面没挂上'); return; }

    // 结构与酒馆自己的顶栏抽屉逐字同构：drawer > drawer-toggle > drawer-icon ＋ drawer-content。
    // 开合**不自己实现** —— 直接复用酒馆导出的 doNavbarIconClick（script.js）：
    //   · 这样"点开一个自动收起别的抽屉""再点一次关掉"与 Horae 等抽屉行为一致；
    //   · 酒馆的绑定是初始化时对**当时存在**的 .drawer-toggle 做的一次性绑定（script.js 里
    //     $('.drawer-toggle').on('click', doNavbarIconClick)），我们后插入的不会被它绑到，
    //     所以这里自己绑是补上那一刀，不是重复绑定（点一次只会开合一次）。
    // 图标选实心靶心：与 Horae 那个空心时钟一眼能分开，也直接对应"命中"。
    const div = document.createElement('div');
    div.id = 'hlg_drawer';
    div.className = 'drawer';
    div.innerHTML = `
        <div class="drawer-toggle">
            <div id="hlg_drawer_icon" class="drawer-icon fa-solid fa-bullseye fa-fw closedIcon interactable"
                 title="打开 hitOpt 面板（命中优化）" tabindex="0" role="button"></div>
        </div>
        <div id="hlg_drawer_content" class="drawer-content closedDrawer">
            <div class="drawer-header">
                <div class="hlg-title"><i class="fa-solid fa-bullseye"></i> hitOpt · 命中优化</div>
                <span class="hlg-ver" id="hlg-ver" title="左＝hitOpt 客户端版本；右＝记录服务（服务端）版本">${esc(APP_VERSION)}</span>
            </div>
            <div class="hlg-tools">
                ${hintHtml()}
                <button id="hlg-raw" class="hlg-btn" type="button">原始</button>
                <button id="hlg-refresh" class="hlg-btn" type="button">刷新</button>
            </div>
            <div id="hlg-body"></div>
        </div>
    `;
    holder.appendChild(div);

    try { $('#hlg_drawer .drawer-toggle').on('click', doNavbarIconClick); }
    catch (e) { log('顶栏抽屉开合没绑上（jQuery 不可用？）', e); }
    el('hlg-refresh')?.addEventListener('click', () => { void refresh('click'); });
    el('hlg-raw')?.addEventListener('click', () => { rawOpen = !rawOpen; paint(); });
}

/* ── 启动 ─────────────────────────────────────────────────────────────────── */

jQuery(async () => {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = { ...DEFAULTS };
    Object.assign(settings, DEFAULTS, extension_settings[MODULE_NAME]);
    /* ★ 2026-09-24：老设置里存的是旧挂载名（`horae-git`）⇒ 迁到新名，免得每次刷新都先试一次旧路由。
     *   探到真名之后 `apiId` 仍然优先，这里只是把"默认值"这一路摆正。 */
    if (settings.ledgerId === 'horae-git') settings.ledgerId = DEFAULT_LEDGER_ID;

    mountUi();
    log('已加载', APP_VERSION);

    // ★ 缓存优化算法上电（只此一行接线：装两个事件监听 + 出网取证）。
    //   ⚠ 绝不能让"魔改版 horae.client.js"和它同时生效 —— 见 opt.js 文件头那段警告。
    try { installOpt(); } catch (e) { log('缓存优化没接上', e); }

    try {
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
    } catch (_) { /* 存不下也不影响读 */ }

    void refresh('boot');

    // 换聊天：手动选定的场要作废（否则会串场），然后重拉
    try {
        eventSource?.on?.(event_types.CHAT_CHANGED, () => {
            settings.pick = '';
            try { extension_settings[MODULE_NAME].pick = ''; } catch (_) { /* 忽略 */ }
            lastLog = null;
            if (settings.autoRefresh) setTimeout(() => { void refresh('chat-changed'); }, 400);
        });
    } catch (_) { /* 事件系统不可用也不影响手动刷新 */ }

    // 生成结束：记录是那一侧异步落的盘，等一会儿再拉
    try {
        eventSource?.on?.(event_types.GENERATION_AFTER_COMMANDS, () => {
            if (settings.autoRefresh) setTimeout(() => { void refresh('after-generate'); }, 1500);
        });
    } catch (_) { /* 同上 */ }
});

/* ══════════════════════════════════════════════════════════════════════════════════════
 * ★ 2026-09-24【酒馆的扩展生命周期钩子 —— manifest.json 的 hooks 指向下面那两个名字】
 *
 * 为什么加（用户："那就加提示把"）：这个插件由**两半**组成 —— 浏览器端扩展 ＋ 服务端插件。
 *   酒馆那个「输入 Git URL 安装」的入口**只装得到浏览器端那一半**
 *   （`src/endpoints/extensions.js` 里是 `git.clone` 到 third-party/），而服务端插件的加载器
 *   只读 `<酒馆>/plugins/`（`src/plugin-loader.js` 只有一句 `fs.readdirSync(pluginsPath)`，
 *   **没有任何下载或市场机制**）。
 *   ⇒ 用户装完扩展、刷新页面，看到的是一张空面板，**没有任何一处告诉他"还差一步"**。
 *
 * 机制（核过源码 `public/scripts/extensions.js` L385-422）：hooks 的值是**入口 JS 导出的函数名**，
 *   酒馆在对应时机调它、并 await 它返回的 Promise。支持的钩子七个：
 *     install / update / delete / clean / enable / disable / activate
 *
 * 这里只用两个（其余不挂 —— 挂了就是永远跑不到的死代码）：
 *   · install  —— 装完那一刻（最该提示的时候）
 *   · activate —— 每次扩展被激活（重开酒馆 / F5 之后如果还没装服务端，再说一次）
 *
 * ⚠ 三条纪律：
 *   ① **只在"服务端确实不在"时才出声** —— 装好了就永远闭嘴（探测走那条只读 /status）；
 *   ② **一个页面会话最多说一次**（activate 会被反复触发，不然每次操作都弹一遍就成了骚扰）；
 *   ③ **探测失败一律当"不在"，但绝不因此抛异常** —— 钩子里抛错会影响酒馆的扩展加载流程。
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/** 这一页已经提示过了吗（activate 可能被反复调）。 */
let _serverTipShown = false;
/** 上面那条的姊妹：服务端**旧了**只说一次（见 `_tipIfServerStale`）。 */
let _srvStaleTipShown = false;

/** 服务端在不在 —— 走那条只读 /status（不要 CSRF、不写任何东西）。
 *  ⚠ 候选名与 LEDGER_IDS 同一套（服务端是酒馆启动时加载的，没重启时旧名字还在）。
 *  ⚠⚠ **必须自带超时**：酒馆给钩子的预算是 **5 秒**（`public/scripts/extensions.js` L447
 *     `HOOK_TIMEOUT = 5000`，超了它记一条 timeout 警告）。"服务端没装"那种情况 fetch 会立刻
 *     404、很快；真正要防的是**中途卡住**（酒馆正忙 / 连接挂着）—— 卡满 5 秒就轮到酒馆判超时、
 *     我们的提示根本来不及弹。2.5 秒足够一个本地 GET 往返，留一半余量。 */
async function _serverAlive() {
    for (const id of LEDGER_IDS) {
        try {
            const ac = new AbortController();
            const timer = setTimeout(() => { try { ac.abort(); } catch (_) { /* 忽略 */ } }, 2500);
            let j = null;
            try {
                const r = await fetch('/api/plugins/' + id + '/status', {
                    headers: { Accept: 'application/json' }, signal: ac.signal,
                });
                if (r.ok) j = await r.json();
            } finally { clearTimeout(timer); }
            if (j && j.ok === true && j.native === true) return true;
        } catch (_) { /* 这一个候选不通（404 / 超时 / 网络）就试下一个 */ }
    }
    return false;
}

/** 缺服务端就说一次 —— 说清"缺什么、去哪找、做完再干什么"。 */
async function _tipIfServerMissing() {
    if (_serverTipShown) return;
    try {
        if (await _serverAlive()) return;          // 装好了 ⇒ 永远闭嘴
        _serverTipShown = true;
        const msg = 'hitOpt 还差一步：服务端插件没装。\n'
            + '① 找到本扩展目录里的 scripts/install-server.bat；\n'
            + '② 把「酒馆根目录」（有 config.yaml 那一层）拖到那个 bat 上；\n'
            + '③ 重启酒馆。装好后这个提示不再出现。';
        /* 有 toastr 就用它（酒馆自带，右上角），没有就只写控制台 ——
         * 绝不因为"提示不出来"而抛错（钩子里抛错会牵连酒馆的扩展加载）。 */
        try {
            if (typeof toastr !== 'undefined' && toastr && toastr.warning) {
                toastr.warning(msg, 'hitOpt', { timeOut: 15000, extendedTimeOut: 8000 });
            } else {
                log('[hitOpt] ' + msg);
            }
        } catch (_) { log('[hitOpt] ' + msg); }
    } catch (e) {
        try { log('[hitOpt] 服务端探测失败（不影响使用）:', e); } catch (_) { /* 连日志都写不出来就算了 */ }
    }
}

/** 服务端那一半够不够新。**纯函数**（验收直接跑它，不在测试里另抄一套判据）。
 *  返回：`'ok'` 够新 ｜ `'old'` 旧了 ｜ `'unknown'` 它压根没报版本（＝比旧还旧）。
 *  ⚠ 这里**不许**写 `Number(status?.v)`：`Number(null) === 0`，那个 0 会被判成"旧得离谱"，
 *    而真相是"拿不到这个数" —— 两种情况的提示词不一样。本项目在 `Number(null)` 上栽过四次。 */
function _srvStaleKind(status, need = REQUIRED_SRV_ROUTE) {
    const raw = status?.v;
    const v = (typeof raw === 'number') ? raw
        : (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    if (!Number.isFinite(v)) return 'unknown';
    return v < need ? 'old' : 'ok';
}

/** 服务端旧了就说一次（一个页面会话最多一次）—— 与上面 `_tipIfServerMissing` 同一套节制。
 *  ⚠ 与 `_tipIfServerMissing` 分工不重叠：那条管"压根没装"（探不到就是它的活），
 *    这条只管"装着、但是旧的"（`/status` 回得来、版本号不够）。 */
function _tipIfServerStale(status) {
    if (_srvStaleTipShown) return;
    const kind = _srvStaleKind(status);
    if (kind === 'ok') return;
    _srvStaleTipShown = true;
    const got = (kind === 'unknown') ? '（旧到连版本号都不报）' : `（srv${status.v}）`;
    /* ⚠ 这里**不许**用 Markdown 的 `**加粗**` —— toastr 不认识它，会把两个星号**原样显示**出来
     *   （真机截图实测过：屏幕上就是「**服务端那一半是旧版**」）。强调改用中文书名号。 */
    const msg = `hitOpt 的服务端那一半是旧版${got} —— 本版扩展要 srv${REQUIRED_SRV_ROUTE} 以上，`
        + '新功能不会生效。\n'
        + '请把「酒馆根目录」再拖一次下面这个脚本，然后重启酒馆：\n'
        + '扩展目录里 scripts/install-server.bat';
    /* 有 toastr 就用它（酒馆自带，右上角），没有就只写控制台 ——
     * 绝不因为"提示不出来"而抛错（它跑在刷新链里，抛错会连累整张面板）。 */
    try {
        if (typeof toastr !== 'undefined' && toastr && toastr.warning) {
            toastr.warning(msg, 'hitOpt', { timeOut: 20000, extendedTimeOut: 10000 });
        } else {
            log('[hitOpt] ' + msg);
        }
    } catch (_) { try { log('[hitOpt] ' + msg); } catch (__) { /* 连日志都写不出来就算了 */ } }
}

/** 酒馆的 install 钩子：装完那一刻。 */
export async function onInstall() {
    try { log('[hitOpt] 扩展已安装（hook: install）'); } catch (_) { /* 日志失败不影响任何事 */ }
    await _tipIfServerMissing();
}
/** 酒馆的 activate 钩子：每次被激活（重开酒馆 / F5）。 */
export async function onActivate() {
    await _tipIfServerMissing();
}
