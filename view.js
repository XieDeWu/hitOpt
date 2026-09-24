/**
 * ==============================================================================
 * hitOpt · 记录查看页（view.html 的脚本）
 *
 * 【它是什么】
 *   面板第 1 列（楼层格）里那**两排**入口的落点（名字与源实现一致，见 ledger.js 那段注释）：
 *     · 池化↗   ->  mode=doc           —— 主算法池化后、这一轮**真发出去**那份（服务端铺平）
 *     · 跟上轮↗ ->  mode=diff          —— 这一轮与**上一轮**的逐行差异（两侧都是池化后产物）
 *     · 原文↗   ->  mode=doc&src=raw   —— 酒馆组装好、Horae 还没动过的原文（**未经池化**）
 *     · 同上轮↗ ->  mode=diff          —— 跨轮，两侧都是**原文**（与「跟上轮↗」成对）
 *     · 输出↗   ->  mode=res           —— **官方返回**内容，逐字节
 *     · 同轮↗   ->  mode=diff          —— 同一轮内部：池化前 ↔ 池化后
 *
 * 【三条只读路由（都是 GET ⇒ 不要 CSRF、不写任何盘）】
 *     · mode=doc  ->  GET <base>/flat?chat=<场>&no=<轮>[&src=raw]
 *         /flat 是全项目唯一铺平入口（服务端 flattenWire），返回 { ok, text, shape }；
 *         src=raw 时读 turns/NNNNN.raw.json（酒馆原文），不带则读真发出去那一份。
 *     · mode=diff ->  GET <base>/diff?chat=<场>&blob=1&from=<sha>:<rel>&to=<sha>:<rel>
 *         服务端读两份正文、落临时区、git diff --no-index，返回 { ok, patch, sides, ... }；
 *         本页一行 diff 算法都不写 —— diff 是 git 算的（与原来那条纪律一致）。
 *     · mode=res  ->  GET <base>/res?chat=<场>&no=<轮>&from=<第几个字>&len=<这一段多少字>
 *         服务端只读 turns/NNNNN.res.txt（官方返回原文），**按窗口**返回（理由见 runRes 那段）。
 *
 * 【为什么要有这一页（而不是直接把 API 地址挂到按钮上）】
 *   记录根在 plugins/hitopt-git/_gitlog 下 —— **不在 public/ 里**，浏览器静态取不到
 *   （实测 404）。所以「池化↗」不能像源文件那样指一个静态文件网址；而直接打开 API 地址
 *   看到的是**一整坨转义过的 JSON**，那不叫"看正文"。这一页只做一件事：
 *   把那条只读路由的返回**如实摊开给人看**。
 *
 * 【如实说话的几条】
 *   · 服务端回 ok:false ⇒ 把它那句 error 原样显示（不吞、不换一句好听的顶上去）；
 *   · 服务端回 404（这一轮没有那份存档 / 那份还是占位文件）⇒ 把 404 响应体里那句
 *     error ＋ why 一起显示出来 —— **不拿一句"HTTP 404"顶掉真正的原因**；
 *   · 拿不到 / 解析不了 ⇒ 明写"读不到"，**不画一张空白页**；
 *   · 差异两侧的来路（提交里读到的 blob / 盘上工作区顶上）由服务端 sides[].aVia / bVia 给，
 *     照它显示，不猜。
 *
 * ！本文件的注释里一律不写反引号（项目硬约束：注释里提代码名不带反引号）。
 * ==============================================================================
 */

const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

const MODE = String(Q.get('mode') || 'doc');
const CHAT = String(Q.get('chat') || '');
const LABEL = String(Q.get('label') || '');

/** 记录服务的挂载地址。面板把它探到的**真实**挂载名传进来（/api/plugins/<id>）。
 *  ⚠ 只认这一种形状 —— 不接受的输入一律退回默认，避免把本页当成跳板。 */
const BASE = (() => {
    const b = String(Q.get('base') || '');
    return /^\/api\/plugins\/[A-Za-z0-9_.-]+$/.test(b) ? b : '/api/plugins/hitopt-git';
})();

const PAD5 = (n) => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(5, '0');

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function say(kind, text) {
    const m = $('msg');
    m.className = kind;
    m.textContent = String(text ?? '');
    m.hidden = false;
}

/** 取一份 JSON。⚠ 非 2xx **也要把响应体读出来**：
 *  /res 那条路由"没有这一轮的存档"时回的是 **404 ＋ 一句说清原因的 error**
 *  （占位文件还会带 why）—— 只抛一句 HTTP 404 就把真正的原因吞掉了，
 *  用户看到的会是"页面坏了"，而不是"这一轮没抓到官方返回"。 */
async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) { j = null; }
    if (!res.ok) {
        if (j && typeof j === 'object') return j;         // 404 的响应体就是那份如实说明，照它显示
        throw new Error(`HTTP ${res.status} ${res.statusText}｜返回的不是 JSON：` + txt.slice(0, 160));
    }
    if (!j) throw new Error('返回的不是 JSON：' + txt.slice(0, 160));
    return j;
}

/* ── 头栏 ───────────────────────────────────────────────────────────────── */

function head(title, sub, rawUrl) {
    $('title').textContent = title;
    $('sub').textContent = sub || '';
    const a = $('raw');
    if (rawUrl) { a.href = rawUrl; a.hidden = false; } else { a.hidden = true; }
    document.title = 'hitOpt · ' + title + (LABEL ? ' · ' + LABEL : '');
}

/* ── 池化 / 原文模式：把这一轮的正文摊开 ───────────────────────────────────── */

/** 这一页是「原文↗」（酒馆原文、未经池化）还是「池化↗」（池化后真发出去那份）——
 *  差别**只在多一个 src=raw**，其余（铺平、显示、诚实口径）逐字相同。
 *  ⚠ 名字跟着面板那颗链接走（用户定版：一律用源实现的原名，不许改叫"文档"）。 */
const DOC_RAW = String(Q.get('src') || '') === 'raw';

async function runDoc() {
    const no = Number(Q.get('no'));
    const what = DOC_RAW ? '原文' : '池化';
    head(what, LABEL, null);
    if (!CHAT) return say('bad', '缺少场名（chat）—— 这一页不知道要读哪一场的记录。');
    if (!Number.isFinite(no) || no < 0) return say('bad', '缺少轮次编号（no）。');

    const url = BASE + '/flat?chat=' + encodeURIComponent(CHAT) + '&no=' + Math.floor(no)
        + (DOC_RAW ? '&src=raw' : '');
    head(what, LABEL, url);
    say('dim', '正在读第 ' + (Math.floor(no) + 1) + ' 轮（' + PAD5(no) + '）的' + what + '…');

    let j;
    try { j = await getJson(url); } catch (e) {
        return say('bad', '读不到这一轮的' + what + '：' + (e?.message || e) + '\n' + url);
    }
    if (!j || j.ok !== true || typeof j.text !== 'string') {
        return say('bad', '这一轮的' + what + '读不出来：'
            + String(j?.error || '服务端没给 error，也没给正文')
            + '\n' + url);
    }
    const shape = String(j.shape || '?');
    say('dim', CHAT + ' · 第 ' + (Math.floor(no) + 1) + ' 轮（' + PAD5(no) + '）'
        + ' · ' + j.text.length.toLocaleString('en-US') + ' 字'
        + ' · 形状 ' + shape
        + (DOC_RAW
            ? '（酒馆组装好的原文 —— 算法的输入）'
            : '（池化后真发出去的那份）'));
    const pre = $('body');
    pre.textContent = j.text;
    pre.hidden = false;
}

/* ── 输出模式：官方返回原文（按窗口读，不一次全塞进 DOM） ───────────────────── */

/** 一段多少字。服务端默认同值（RES_LEN_DEF）。
 *  ⚠ 为什么不是"整份拉回来"：实测这份文件**最大 5,419,480 字节 / 5,370,849 字**
 *  （抓包插件 5.29 MiB 那一档日志上限），而 5.4 MB 的 SSE 是 **1.8 万条 data 行** ——
 *  人读不了，真正要看的是**开头**与**结尾的 usage**。
 *  （无头 Chrome 实测：541 万字一次性塞进 pre 排版 362ms、主线程仍响应 ⇒
 *   "卡死"没有复现，所以这不是"怕卡死"，是"按有界窗口读、要看全文再点下一段"。） */
const RES_LEN = 200000;
let resHeadText = '';        // 已经读到的头（逐段往后接）
let resNextFrom = 0;         // 下一段从第几个字开始
let resChars = 0;            // 全文共多少字

async function resFetch(from) {
    const no = Math.floor(Number(Q.get('no')));
    const url = BASE + '/res?chat=' + encodeURIComponent(CHAT) + '&no=' + no
        + '&from=' + from + '&len=' + RES_LEN;
    const j = await getJson(url);
    return { j, url };
}

function resPaint(j, url, no) {
    const shownTo = j.head.to;
    const bits = [
        CHAT + ' · 第 ' + (no + 1) + ' 轮（' + PAD5(no) + '）',
        '全文 ' + Number(j.chars).toLocaleString('en-US') + ' 字 / ' + Number(j.bytes).toLocaleString('en-US') + ' 字节',
        '已显示第 1~' + shownTo.toLocaleString('en-US') + ' 字'
        + (j.tail ? ' ＋ 末尾 ' + (j.chars - j.tail.from).toLocaleString('en-US') + ' 字' : ''),
    ];
    if (j.meta) {
        const m = j.meta;
        const mm = [];
        if (m.model) mm.push('模型 ' + m.model);
        if (m.sse === true) mm.push('流式 SSE');
        if (m.sse === false) mm.push('非流式（一条完整 JSON）');
        if (Number.isFinite(m.dataLines)) mm.push(m.dataLines.toLocaleString('en-US') + ' 条 data 行');
        if (m.done === true) mm.push('结尾有 [DONE]');
        if (m.done === false) mm.push('⚠ 抓包记的 done=false（流没收到尾）');
        if (m.truncated === true) mm.push('⚠ 抓包那一刻撞到日志上限');
        if (m.finish) mm.push('finish=' + m.finish);
        if (mm.length) bits.push(mm.join(' · '));
    }
    say('dim', bits.join('\n') + '\n' + url);

    const pre = $('body');
    pre.textContent = resHeadText;
    pre.hidden = false;

    const omit = $('omit');
    if (j.omitted > 0) {
        /* 两种情况措辞不同（都在说老实话）：
           · 有尾巴 ⇒ 头与尾之间那一段这一页没显示（"中间省略"）；
           · 没尾巴 ⇒ 头之后还没读（"继续读下一段"接着拿）。 */
        omit.textContent = (j.tail ? '⋯ 中间省略 ' : '⋯ 后面还有 ')
            + Number(j.omitted).toLocaleString('en-US') + ' 字'
            + (j.tail
                ? '（第 ' + (j.head.to + 1).toLocaleString('en-US') + ' ~ ' + j.tail.from.toLocaleString('en-US') + ' 字）'
                : '（第 ' + (j.head.to + 1).toLocaleString('en-US') + ' 字起）')
            + ' —— 服务端按窗口读的，不是文件只有这么多 ⋯';
        omit.hidden = false;
    } else { omit.hidden = true; omit.textContent = ''; }

    const tp = $('tail');
    if (j.tail) {
        $('taillabel').textContent = '【末尾 ' + (j.chars - j.tail.from).toLocaleString('en-US')
            + ' 字】第 ' + (j.tail.from + 1).toLocaleString('en-US') + ' ~ ' + j.tail.to.toLocaleString('en-US') + ' 字';
        $('taillabel').hidden = false;
        tp.textContent = j.tail.text;
        tp.hidden = false;
    } else { $('taillabel').hidden = true; tp.hidden = true; tp.textContent = ''; }

    const more = $('more');
    if (j.more) {
        resNextFrom = j.head.to;
        more.textContent = '继续读下一段（+' + Math.min(RES_LEN, j.chars - j.head.to).toLocaleString('en-US') + ' 字）';
        more.hidden = false;
        more.disabled = false;
    } else {
        more.textContent = '已经读到结尾了（全文都在上面）';
        more.hidden = false;
        more.disabled = true;
    }
}

async function runRes() {
    const no = Math.floor(Number(Q.get('no')));
    head('输出', LABEL, null);
    if (!CHAT) return say('bad', '缺少场名（chat）—— 这一页不知道要读哪一场的记录。');
    if (!Number.isFinite(no) || no < 0) return say('bad', '缺少轮次编号（no）。');

    say('dim', '正在读第 ' + (no + 1) + ' 轮（' + PAD5(no) + '）的官方返回…');
    let r;
    try { r = await resFetch(0); } catch (e) {
        return say('bad', '读不到这一轮的官方返回：' + (e?.message || e) + '\n' + BASE + '/res');
    }
    const j = r.j;
    head('输出', LABEL, r.url);
    if (!j || j.ok !== true) {
        /* 服务端如实说了"没有 / 是占位文件" ⇒ 原样转述（含它给的原因），不自己编一句。 */
        return say('bad', '这一轮没有官方返回可看：\n'
            + String(j?.error || '服务端没给 error')
            + (j?.why ? '\n原因：' + String(j.why) : '')
            + (j?.state ? '\n（盘上状态：' + String(j.state) + '）' : '')
            + '\n' + (r.url || ''));
    }
    resChars = Number(j.chars) || 0;
    resHeadText = String(j.head?.text || '');
    resPaint(j, r.url, no);
}

/** 「继续读下一段」：把后面的段落接在已有的头后面（DOM 始终是"已读到的全文"）。 */
async function resMore() {
    const no = Math.floor(Number(Q.get('no')));
    const btn = $('more');
    btn.disabled = true;
    try {
        const r = await resFetch(resNextFrom);
        const j = r.j;
        if (!j || j.ok !== true) {
            return say('bad', '继续读失败：' + String(j?.error || '服务端没给 error') + '\n' + r.url);
        }
        resHeadText += String(j.head?.text || '');
        resPaint(j, r.url, no);
    } catch (e) {
        say('bad', '继续读失败：' + (e?.message || e));
    } finally {
        if ($('more').textContent.indexOf('已经读到结尾') !== 0) $('more').disabled = false;
    }
}

/* ── 差异模式：逐行差异（行号两列 + 正文一列，绿增红删） ───────────────────── */
/* ★★★★★★ 2026-09-24【收纳 / 展开 —— 用户："2.差异里面的收纳与展开按钮去哪了"】
 *
 * ── 搬的是什么（只搬逻辑）──────────────────────────────────────────────────
 *   搬自 `horae.client.js` 的 `_dvPageScript`（定义 @27918）。归属逐个核过：整族都落在
 *   `_notes/函数归属-原版vs魔改.md` 的**「一、我们的魔改（347）」**那一节里
 *   （可复算：`node _tmp/dv_family_scan.mjs` ⇒ 43/43 可搬、**0 个落在原版 474**）⇒ 可以搬。
 *   搬过来的四件事：
 *     ① 按 hunk 头的行号算出"**哪些行被 git 折掉了**"（git 只吐 -U3 那三行上下文）；
 *     ② 每一处画一条**可点的收纳条**，文字「首收纳 N 行 · ≈X tok · Y 字」（尾条写"尾收纳"）；
 *     ③ 点开时拿**两份原文**按行号现切那几行 —— 两份原文由服务端 /diff 顺手就给
 *        （`fromContent` / `toContent`），⛔ **不另开接口、不本地 diff**（一行 diff 算法都没写）；
 *     ④ **段头段尾成对的按钮糖**：两条收纳条共用同一个 body、同一个开关（展开后不用往回滚就能收）。
 *
 * ── 没搬的是什么（用户 2026-09-24 定版："差异页现在的样式我还挺喜欢的，就是功能少了展开与收纳"）
 *   ⛔ 源页那一整套 CSS（`.patch` / `.colhead` / `.band` / `.bar` / `.mk` / `.gapbody`）**一个字都没搬**：
 *      新元素（`.d-band` / `.d-bar` / `.d-gapbody`）**复用本页现有的 `.d-row` / `.ln` / `.tx` 那套列**
 *      ⇒ 收纳条的文字正好落在正文列上，展开出来的行与普通行的行号**同列**
 *      （同一套 CSS 算出来的，不是另立一套）。
 *   ⛔ 也没搬：`cband`（每条消息 content 正文**默认收起** —— 那会明显改变这一页现在看到的东西）、
 *      列头那一行、抬头改写、标记独立成列（**现状本来就不是独立列**：实测 `#diff` 里格数分布
 *      是 {"ln|ln|tx"}、`.mk` 计数 0 ⇒ 这三条都按"不动，等裁决"处理，见搬迁报告）。
 *
 * ── ⚠ 两条**必须照做**的口径（真 bug 级，不是偏好）────────────────────────────
 *   · **展开行的行号落在它自己那一侧那一列**（a 侧 ⇒ 第 1 列，b 侧 ⇒ 第 2 列，另一列留空）——
 *     与普通行（an 进第 1 列 / bn 进第 2 列）**同一套落列规则**。源文件那一版**永远往第一列填**，
 *     用户为"展开后上下行号不对齐"报过 5 次（真因是 CSS 多一层 7px 缩进；这里既不补缩进、
 *     又按侧落列 ⇒ 两条都堵住）。
 *   · **首 / 中 / 尾三处都要有收纳条**（第一个 hunk 之前、两个 hunk 之间、最后一个 hunk 之后）——
 *     v6.24.68 修的就是"第一个 hunk 之前那 1,355 行在页面上一个字都看不见、连'收纳 N 行'都不给"。
 *   · 左边那条竖线**做满整行**（`top:0;bottom:0`）：源实现里它是"这一行能点"的信号
 *     （用户问过"我按钮去哪了？"）。只作用于**新元素**，不碰任何现有元素。
 * ！本文件的注释里一律不写反引号。 */

/** 一行一个 div（行号两列 + 正文一列）——**普通行与展开行共用这一个轮子**
 *  ⇒ 列宽、内边距、字号天然同源，不存在"两种表格形状"（源文件 v6.24.88 那条教训）。
 *  @param {string} cls  行类（d-ctx / d-hunk / d-add / d-del 那些）
 *  @param {string} an   第 1 列（上一轮行号；空串 = 这一列不占）
 *  @param {string} bn   第 2 列（这一轮行号）
 *  @param {string} tx   正文（原样，textContent 进去 ⇒ 提示词里带 img onerror 也执行不了） */
function dvRow(cls, an, bn, tx) {
    const div = document.createElement('div');
    div.className = 'd-row ' + cls;
    const la = document.createElement('span'); la.className = 'ln'; la.textContent = an;
    const lb = document.createElement('span'); lb.className = 'ln'; lb.textContent = bn;
    const t = document.createElement('span'); t.className = 'tx'; t.textContent = tx;
    div.appendChild(la); div.appendChild(lb); div.appendChild(t);
    return div;
}

/** 把一份 unified diff 的每一行切成 {cls, an, bn, text}。
 *  行号规则就是 git 自己那套：@@ -a,b +c,d @@ 定起点，随后
 *    · 减号行只占 a 侧，加号行只占 b 侧，上下文行两侧都占；
 *    · 没有换行结尾那一行（反斜杠开头）不占行号、也不推进。
 *  ★ 2026-09-24：hunk 那一行**另外挂**四个只读字段（hA/hAlen/hB/hBLen = 这一段的起点与长度）——
 *    收纳条要按它算"哪些行被折掉了"。⚠ 既有字段（cls / an / bn / text）与既有分类结果**一个字没改**。 */
function splitPatch(patch) {
    const out = [];
    let a = 0, b = 0, inHunk = false;
    for (const line of String(patch ?? '').split('\n')) {
        let cls = 'd-ctx', an = '', bn = '';
        if (/^diff --git /.test(line) || /^index /.test(line)
            || /^(new file|deleted file|old mode|new mode|similarity index|rename )/.test(line)) {
            cls = 'd-meta'; inHunk = false;
        } else if (/^@@/.test(line)) {
            cls = 'd-hunk';
            const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            /* ★★★★★★ 2026-09-24【抓到并修掉一个一直存在的真 bug：**b 侧行号全错**】
             *  原来这一行是 `b = Number(m[2])` —— 而 m[2] 是**减号那一侧的行数**（`-2112,6` 里那个 6），
             *  不是加号那一侧的起点。加号那一侧的起点是 **m[3]**。
             *  后果（实测，`林夏_mufaamjlis2x` 00018↔00019，hunk 头 `@@ -2112,6 +2112,128 @@`）：
             *    · `b` 被赋成 **6** ⇒ 那一块 122 个新增行的 bn 一路是 9,10,…,130，
             *      而它们在 b 侧文件里的真行号是 **2115,…,2236** ⇒ 右列行号整列是错的（差 2106 行）。
             *    · a 侧那一列**一直是对的**（`a = Number(m[1])`），所以只有**右边那一列**错 ——
             *      页面看上去"有个行号"，很难一眼发现。
             *  ⚠ 为什么非修不可（用户当场报过、当时没定位到）：他 2026-09-24 说
             *    "之前与上轮池化差异显示的是**第 100 多行**有变更" —— 那就是这一列错号的特征
             *    （真实断点在 2115 行，页面写成 100 出头）。
             *  ⚠ 同族的另外两处**本来就是对的**，别一起改错：`hB: m[3]` 与 `hBLen: m[4]`
             *    （收纳条的区间判据用的是它们）。 */
            if (m) { a = Number(m[1]); b = Number(m[3]); inHunk = true; } else { inHunk = false; }
            /* ★ 新增（只读）：把这一段声明的起点与长度留下来 —— 收纳条的判据全靠它。
               （`(?:,(\d+))?` 缺省 = 1 行，与 git 的写法一致。） */
            out.push({
                cls, an, bn, text: line,
                hA: m ? Number(m[1]) : 0, hAlen: m ? Number(m[2] == null ? 1 : m[2]) : 0,
                hB: m ? Number(m[3]) : 0, hBLen: m ? Number(m[4] == null ? 1 : m[4]) : 0,
            });
            continue;
        } else if (/^--- /.test(line) || /^\+\+\+ /.test(line)) {
            cls = 'd-meta';
        } else if (inHunk && /^\\/.test(line)) {
            cls = 'd-ctx';                                   // 没有换行结尾那一行：不占行号
        } else if (inHunk && /^-/.test(line)) {
            cls = 'd-del'; an = String(a); a++;
        } else if (inHunk && /^\+/.test(line)) {
            cls = 'd-add'; bn = String(b); b++;
        } else if (inHunk && /^ /.test(line)) {
            cls = 'd-ctx'; an = String(a); bn = String(b); a++; b++;
        } else if (inHunk) {
            cls = 'd-ctx'; an = String(a); bn = String(b); a++; b++;   // 兜底：按上下文行算
        } else {
            cls = 'd-ctx';
        }
        out.push({ cls, an, bn, text: line });
    }
    return out;
}

/** 那一份原文切成的行（**不 pop 末尾那个空串**：切开来的下标要与 git 的行号一一对应）。 */
function dvLines(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** 一处收纳：按 hunk 头的行号算出"这一段被折掉的是哪几行"，并画成一条可点的横条。
 *  纯 DOM 构造 —— 与源文件同一套判据、同一套文字，只是不写内联 script（本页不赌宿主 CSP）。 */
function dvMakeBand(g, CT, ra, rb) {
    const cntA = g.toA - g.fromA + 1, cntB = g.toB - g.fromB + 1;
    /* ⚠ 行号与文字必须取**同一侧**：两侧都是同一段正文，但行号可能整体平移（这一轮前面多插了
     *   几百行时），混着取会出现"行号是 a 侧、文字是 b 侧"的错位 —— 所以优先整段取 b 侧
     *   （页面上那份正文就是 b 侧），超出文件长度才整段退回 a 侧，**绝不各取一半**。 */
    const useB = (rb.length >= g.toB && cntB === cntA);
    const side0 = useB ? 'b' : (ra.length >= g.toA ? 'a' : (rb.length >= g.toB ? 'b' : ''));
    const from = side0 === 'b' ? g.fromB : g.fromA;
    const to = side0 === 'b' ? g.toB : g.toA;
    const src = side0 === 'b' ? rb : ra;
    /* ★ 行数跟着 side0 走（源 v6.41.14 修的那个渲染 bug：行数硬取 a 侧、字数按 b 侧取
     *   ⇒ 收纳条写着「收纳 7 行 · 25,753 tok · 43,510 字」，7 行最多 2,303 字，那一行自相矛盾）。 */
    const cnt = (side0 === 'b') ? cntB : cntA;

    const band = document.createElement('div');
    band.className = 'd-band';
    const bar = dvRow('d-bar', '', '', '');                       // 段头那条
    const bar2 = dvRow('d-bar', '', '', '');                      // 段尾那条（展开后才挂上去）
    const st = bar.lastChild, st2 = bar2.lastChild;
    for (const el of [bar, bar2]) {
        el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-expanded', 'false');
    }
    bar2.hidden = true;

    /* ⚠ 那个 token 是**折算**：那几行的字符数 × 本地自己的「字/token」比（CT.k，与面板「本地」
     *   那几格同一套比）—— 不是官方数、悬停里写明"≈ 折算"。
     *   拿不到比（老记录 / 这一页没带）就**只写行数与字数**，绝不编一个 token 出来。 */
    let gChars = 0, gWords = 0;
    for (let k = from; k <= to; k++) {
        const L0 = String(src[k - 1] == null ? '' : src[k - 1]);
        gChars += L0.length + 1;      // 含每行那个换行 —— 折算比是拿"含换行"的字节算出来的
        gWords += L0.length;          // 不含换行 —— 页面上报的「Y 字」是这一个
    }
    /* ★ 2026-09-24：`gTok` 从 const 改成 let —— 它现在有**两个来源**：
     *   ① 首屏那份**折算**值（行字数 × 本地字/token 比，就是原来那一个）；
     *   ② 服务端 `/tokseg` 用**真分词器**（与面板「本地」那几格同一份酒馆词表）在这一侧、
     *      这一段行区间上**真数出来**的值 —— 到了就把它换上去（见文件末 fillRealToks）。
     *  ⚠ 文字格式**一个字不动**（仍是 `首收纳 N 行 · ≈X tok · Y 字`）：那个 `≈` 照旧要留着，
     *    因为这里数的仍是**页面上这份铺平文本**，与"真出网字节"不是同一串（两边差 JSON 语法那些字符）。 */
    let gTok = (CT.k > 0 && gChars > 0) ? Math.round(gChars * CT.k) : null;
    /** 这一段的"身份"：拿它去问服务端要真 token（`side0` 是空串 ⇒ 两侧原文都没拿到，问不了）。
     *  ⚠ 形状与变动块那一份**统一成同一种**（数组，每项一个 `{side, from, to}`）—— 填充那一处就只写一遍。 */
    const segs = side0 ? [{ side: side0, from, to }] : [];
    /* 段头叫「首收纳／首收起」、段尾叫「尾收纳／尾收起」（源 v6.41.18：用户"前面最好规范的命名
       首收纳、尾收纳，不然难以分辨头尾"）。行数 / ≈tok / 字数三个数两条一样（同一批行）。 */
    const gLabel = (verb, pos) => {
        if (!side0) return '原文没拿到（' + Number(cnt).toLocaleString('en-US') + ' 行）';
        return (pos || '') + verb + ' ' + Number(cnt).toLocaleString('en-US') + ' 行'
            + (gTok != null ? (' · ≈' + gTok.toLocaleString('en-US') + ' tok') : '')
            + ' · ' + gWords.toLocaleString('en-US') + ' 字';
    };
    /* ⚠ 悬停文字**提成一个函数**（2026-09-24）：`setTok` 把折算值换成真值之后必须重画它 ——
     *   两处各写一份的话，条上写着真 token、悬停里还写着"折算的"，同一件事两个说法。 */
    let tokReal = false;                 // 这个 gTok 是不是 /tokseg 真数出来的
    const mkTip = () => {
        let t = '点一下展开这里收纳掉的 ' + Number(cnt).toLocaleString('en-US') + ' 行（两边逐字一致、git 没吐出来）；再点一下收回去';
        if (gTok != null) {
            t += tokReal
                ? '。' + gTok.toLocaleString('en-US') + ' tok 是服务端用**真分词器**（与面板「本地」那几格同一份酒馆词表）'
                  + '在**这一侧这几行**上现数出来的。⚠ 页面上这份是铺平文本，与真出网字节不是同一串 ⇒ 仍带 ≈'
                : '。≈' + gTok.toLocaleString('en-US') + ' tok 是按本地「字/token」比折算的（不是官方数）';
        } else {
            t += '。拿不到「字/token」比 ⇒ 只报行数与字数，不编 token';
        }
        t += '。' + gWords.toLocaleString('en-US') + ' 字（这几行的字符数，不含换行）';
        if (!side0) t += '。原文没拿到（服务端没给这一侧的内容）⇒ 展不开';
        return t;
    };
    let tip = mkTip();
    bar.title = tip; bar2.title = tip;
    st.textContent = gLabel('收纳', '首');
    st2.textContent = gLabel('收纳', '尾');
    band.appendChild(bar);

    let body = null, open = false;
    const built = () => {
        if (body) return body;
        body = document.createElement('div');
        body.className = 'd-gapbody'; body.hidden = true;
        for (let k = from; k <= to; k++) {
            /* ⚠ **行号落它自己那一侧那一列**（见文件头那两条口径）—— 另一列留空。 */
            const line = String(src[k - 1] == null ? '' : src[k - 1]);
            body.appendChild(dvRow('d-ctx', side0 === 'a' ? String(k) : '', side0 === 'b' ? String(k) : '', line || ' '));
        }
        band.appendChild(body); band.appendChild(bar2);
        return body;
    };
    /* 两条 bar 的状态**只有这一处实现**（class / aria / 文字一次改两条）—— 分开改必然漂移，
       表现成"上头写着收起、下头还写着收纳"。 */
    const setOpen = (on) => {
        for (const el of [bar, bar2]) {
            if (on) el.classList.add('open'); else el.classList.remove('open');
            el.setAttribute('aria-expanded', on ? 'true' : 'false');
        }
    };
    const setSt = (t1, t2) => { st.textContent = t1; st2.textContent = t2; };
    const G = {
        minA: g.fromA, maxA: g.toA, minB: g.fromB, maxB: g.toB,
        side: side0, count: cnt, state: 'collapsed', bar, bar2, band,
        segs,                                 // 拿去问服务端要真 token 的那几段（每段一个 side + 行区间）
        /* ★ 2026-09-24：真分词器那条路的回填口 —— 到了就把 tok 换成真值。
         *  ⚠ 必须**按当前状态重画**（展开态写"首收起/尾收起"、收起态写"首收纳/尾收纳"）：
         *    只改数字会把状态词弄丢，表现成"展开着却写着收纳"（源实现踩过同一个坑）。 */
        setTok: (n) => {
            const v = Math.round(Number(n));
            if (!Number.isFinite(v) || v <= 0) return false;
            gTok = v; tokReal = true;
            tip = mkTip(); bar.title = tip; bar2.title = tip;
            if (G.state === 'expanded') setSt(gLabel('收起', '首'), gLabel('收起', '尾'));
            else setSt(gLabel('收纳', '首'), gLabel('收纳', '尾'));
            return true;
        },
        get body() { return body; },
        expand: () => {
            open = true; setOpen(true);
            if (side0) {
                setSt(gLabel('收起', '首'), gLabel('收起', '尾'));
                built().hidden = false; bar2.hidden = false; G.state = 'expanded';
            } else { setSt('拿不到原文', '拿不到原文'); }
            return G;
        },
        collapse: () => {
            open = false; setOpen(false); setSt(gLabel('收纳', '首'), gLabel('收纳', '尾'));
            if (body) body.hidden = true;
            bar2.hidden = true; G.state = 'collapsed';
            return G;
        },
        toggle: () => (open ? G.collapse() : G.expand()),
    };
    /* 两条 bar **功能完全一样**（源 v6.41.15：用户"功能都是一样的 单纯的按钮糖"）—— 绑同一个 toggle。 */
    for (const el of [bar, bar2]) {
        el.addEventListener('click', (ev) => { ev.preventDefault(); G.toggle(); });
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); G.toggle(); } });
    }
    g.G = G;
    return G;
}

/** ★ 2026-09-24【用户点名】变动块（hunk 里连续的 +/- 行）也要一条**与收纳条一模一样**的条：
 *  原话："现在无变动文本是可以进行收纳按钮 但是我想的是变动文本块也有差异按钮，一摸一样的按钮，
 *        这样我能很方便地收纳变动区"。
 *
 *  【与收纳条的异同（一处一处说清）】
 *    · 同：外观（同一个 .d-band / .d-bar 结构、同一套红绿与 hover）、首尾各一条、点一下切换、
 *          ≈tok 折算用**同一个比**（CT.k，与面板「本地」那几格同源）、拿不到比就只报行数/字数不编。
 *    · 异：**默认展开**（他要的是"能把变动收起来"，不是一打开就看不见变动）；
 *          行**不套容器** —— 那些行本来就是 #diff 的直接子元素，收起时只是把它们 hidden
 *          （⛔ 不改 DOM 结构、不动行号落列规则：那两条都有验收钉子钉着）。
 *    · 条上写明这一块的增删分解（+N / −M），一眼看出这块变动有多大。 */
function dvMakeChangeBand(list, CT) {
    let cnt = list.length, add = 0, del = 0, chars = 0, words = 0;
    /* ★ 2026-09-24：顺手把这一块的**两侧行区间**量出来 —— 那正是 /tokseg 要的（1 起算、闭区间）。
     *  ⚠ 块内全是 +/- 行、中间不夹上下文行（切块的判据见 renderPatch 那一段）⇒ 取 min~max 就是**连续**区间。
     *  ⚠ `it.an` / `it.bn` 在 splitPatch 里是**字符串**（空串 = 这一侧不占），所以要过一遍 Number 再判。 */
    let aFrom = 0, aTo = 0, bFrom = 0, bTo = 0;
    for (const it of list) {
        if (it.cls === 'd-add') add++; else if (it.cls === 'd-del') del++;
        const t = String(it.text == null ? '' : it.text);
        chars += t.length + 1;      // 含换行 —— 与收纳条同一个折算口径
        words += t.length;          // 不含换行 —— 页面上报的「Y 字」是这一个
        const an = Number(it.an), bn = Number(it.bn);
        if (Number.isFinite(an) && an > 0) { if (!aFrom || an < aFrom) aFrom = an; if (an > aTo) aTo = an; }
        if (Number.isFinite(bn) && bn > 0) { if (!bFrom || bn < bFrom) bFrom = bn; if (bn > bTo) bTo = bn; }
    }
    const segs = [];
    if (aFrom) segs.push({ side: 'a', from: aFrom, to: aTo });
    if (bFrom) segs.push({ side: 'b', from: bFrom, to: bTo });
    /* ★ 2026-09-24：`tok` 从 const 改成 let，与收纳条同一个道理 —— 先给折算值，/tokseg 的真值到了就换上去。 */
    let tok = (CT.k > 0 && chars > 0) ? Math.round(chars * CT.k) : null;
    const N = (n) => Number(n).toLocaleString('en-US');
    const split = '+' + N(add) + ' / −' + N(del);

    const band = document.createElement('div');
    band.className = 'd-band';
    const bar = dvRow('d-bar', '', '', '');      // 块首那条
    const bar2 = dvRow('d-bar', '', '', '');     // 块尾那条（展开时才挂上去）
    const st = bar.lastChild, st2 = bar2.lastChild;
    for (const el of [bar, bar2]) {
        el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-expanded', 'true');
    }
    bar2.hidden = true;
    const label = (verb, pos) => (pos || '') + verb + ' ' + N(cnt) + ' 行（' + split + '）'
        + (tok != null ? (' · ≈' + N(tok) + ' tok') : '')
        + ' · ' + N(words) + ' 字';
    /* ⚠ 与收纳条同一条规矩：悬停提成函数，换掉 tok 之后必须重画（否则条上是真值、悬停里还写着"折算的"）。 */
    let tokReal = false;
    const mkTip = () => {
        let t = '点一下把这一块变动收起来（+' + N(add) + ' 新增 / −' + N(del) + ' 删除，共 ' + N(cnt) + ' 行）；再点一下展开';
        if (tok != null) {
            t += tokReal
                ? '。' + N(tok) + ' tok 是服务端用**真分词器**（与面板「本地」那几格同一份酒馆词表）在**这一块那几行**上现数出来的。'
                  + '⚠ 页面上这份是铺平文本，与真出网字节不是同一串 ⇒ 仍带 ≈'
                : '。≈' + N(tok) + ' tok 是按本地「字/token」比折算的（不是官方数）';
        } else {
            t += '。拿不到「字/token」比 ⇒ 只报行数与字数，不编 token';
        }
        t += '。' + N(words) + ' 字（这几行的字符数，不含换行）';
        return t;
    };
    let tip = mkTip();
    bar.title = tip; bar2.title = tip;
    st.textContent = label('变动', '首');
    st2.textContent = label('变动', '尾');
    band.appendChild(bar);

    const setOpen = (on) => {
        for (const el of [bar, bar2]) {
            if (on) el.classList.add('open'); else el.classList.remove('open');
            el.setAttribute('aria-expanded', on ? 'true' : 'false');
        }
    };
    let open = true;
    const B = {
        count: cnt, add, del, state: 'expanded', bar, bar2, band,
        segs,                                 // 拿去问服务端要真 token 的那几段（a 侧 / b 侧各一段）
        /* ★ 2026-09-24：真分词器那条路的回填口（与收纳条同一套）。
         *  ⚠ 按**当前状态**重画：收起态要保留那个「 · 已收起」后缀（用户点名"tok 与字别忘记"）。 */
        setTok: (n) => {
            const v = Math.round(Number(n));
            if (!Number.isFinite(v) || v <= 0) return false;
            tok = v; tokReal = true;
            tip = mkTip(); bar.title = tip; bar2.title = tip;
            const tail = (B.state === 'collapsed') ? ' · 已收起' : '';
            st.textContent = label('变动', '首') + tail;
            st2.textContent = label('变动', '尾') + tail;
            return true;
        },
        expand: () => {
            open = true; setOpen(true);
            for (const it of list) it.el.hidden = false;
            bar2.hidden = false;
            st.textContent = label('变动', '首'); st2.textContent = label('变动', '尾');
            B.state = 'expanded';
            return B;
        },
        collapse: () => {
            open = false; setOpen(false);
            for (const it of list) it.el.hidden = true;
            bar2.hidden = true;
            /* ⚠ 收起**不减少任何数** —— 行数 / 增删分解 / ≈tok / 字数四个**全在**，只追加一个状态词。
             *   用户 2026-09-24 当场点名："你的+-增删条数也可以，但是别忘记这是附加信息，
             *   tok与字别忘记了" ⇒ 增删是附加信息，**tok 与字任何状态下都不许丢**。
             *   （第一版这里只写"已收起 · ≈X tok"，把字数吃掉了；check ② 那条钉子现在钉着它。） */
            st.textContent = label('变动', '首') + ' · 已收起';
            st2.textContent = label('变动', '尾') + ' · 已收起';
            B.state = 'collapsed';
            return B;
        },
        toggle: () => (open ? B.collapse() : B.expand()),
    };
    /* 两条 bar 功能完全一样（与收纳条同一条规矩）。 */
    for (const el of [bar, bar2]) {
        el.addEventListener('click', (ev) => { ev.preventDefault(); B.toggle(); });
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); B.toggle(); } });
    }
    /* ⚠ 默认展开 ⇒ 构造完就**走一次 expand()**（不是只 setOpen(true)）：
     *   expand() 才是"展开态"的完整定义（尾条可见 ＋ 文字 ＋ 行可见），只改颜色会留下半截状态。
     *   ⚠ 尾条**不在这里挂** —— 变动行不在 band 里，尾条必须由 renderPatch 插到**块尾那一行之后**
     *   （挂进 band 的话它会紧跟首条出现在块**首**，那是错的：check ⑦ 段端到端钉着这条）。
     *   ⚠ 这两条都是**真被抓到的**：`check/dv_change_fold_test.mjs` ①③ 两条钉子第一遍就是红的。 */
    B.expand();
    return B;
}

/** 画出正文 ＋ 收纳条。
 *  @param {string} patch git 给的 unified diff
 *  @param {object} opt   { contentA, contentB, kTokPerChar }（后两个只为收纳条那行文字服务） */
function renderPatch(patch, opt = {}) {
    const box = $('diff');
    box.textContent = '';
    const CT = { k: (Number(opt.kTokPerChar) > 0) ? Number(opt.kTokPerChar) : 0 };
    const ra = dvLines(opt.contentA), rb = dvLines(opt.contentB);
    const rows = splitPatch(patch);
    /* ══ ① 先按 hunk 头的行号把"被折掉的那些行"算出来（**不数补丁行** —— git 根本没吐出来）══
     *  ★ v6.24.68 那条口径：判据只留"这一段确实被跳过了"（行号有跳跃）⇒
     *    **第一个 hunk 之前**那一段照样算（原来带着 hunks.length>0 ⇒ 那 1,355 行连收纳条都不给）。 */
    const items = [];
    const gaps = [];
    let prevEndA = 0, prevEndB = 0;
    for (const r of rows) {
        if (r.cls === 'd-hunk') {
            const a0 = Number(r.hA || 0), b0 = Number(r.hB || 0);
            const alen = Number(r.hAlen || 1), blen = Number(r.hBLen || 1);
            const gap = (a0 > prevEndA + 1 || b0 > prevEndB + 1)
                ? { fromA: prevEndA + 1, toA: a0 - 1, fromB: prevEndB + 1, toB: b0 - 1, at: items.length } : null;
            if (gap) gaps.push(gap);
            items.push({ el: dvRow(r.cls, '', '', r.text || ' '), hunk: true, gap, cls: r.cls, text: r.text });
            prevEndA = a0 + Math.max(1, alen) - 1;
            prevEndB = b0 + Math.max(1, blen) - 1;
            continue;
        }
        /* ★ 2026-09-24：`an` / `bn` 也带上 —— 变动块要拿它算**这一块的两侧行区间**（问 /tokseg 要真 token）。 */
        items.push({ el: dvRow(r.cls, r.an, r.bn, r.text || ' '), cls: r.cls, text: r.text, an: r.an, bn: r.bn });
    }
    /* ══ ①′ ★ 2026-09-24【用户点名】变动块：hunk 里**连续的 +/- 行**算一块
     *     （中间夹了 d-ctx（上下文）/ d-hunk（下一个 hunk 头）/ d-meta 就断开）。
     *     ⚠ 下标与 items **一一对应**（上面每个 rows 元素都 push 了一个 item）⇒
     *       块的锚点直接用 items[from].el，收起时也直接 hidden 那些行本身。 */
    const chg = [];
    for (let i = 0; i < rows.length; i++) {
        const c = rows[i].cls;
        if (c !== 'd-add' && c !== 'd-del') continue;
        let j = i;
        while (j + 1 < rows.length && (rows[j + 1].cls === 'd-add' || rows[j + 1].cls === 'd-del')) j++;
        chg.push({ from: i, to: j, list: items.slice(i, j + 1) });
        i = j;
    }
    /* ══ ② 尾部那一段也要有收纳条 —— 同一个窟窿的另一半（循环结束时没人补尾部）。
     *    末尾那个换行不算一行（与 git 的行号口径一致）⇒ 先 pop 掉 split 出来的空尾巴。 */
    const la = ra.slice(), lb = rb.slice();
    if (la.length && la[la.length - 1] === '') la.pop();
    if (lb.length && lb[lb.length - 1] === '') lb.pop();
    if (la.length > prevEndA || lb.length > prevEndB) {
        gaps.push({ fromA: prevEndA + 1, toA: la.length, fromB: prevEndB + 1, toB: lb.length, at: items.length });
    }
    /* ══ ③ 正文行**先全部挂上**，收纳条再按锚点插到它前面。
     *    ⚠ 顺序不能反（源 v6.24.61 的真 bug）：先 insertBefore(收纳条, items[at].el) 再 appendChild 正文，
     *    那一刻锚点还不是 box 的孩子 ⇒ 真 DOM 抛 NotFoundError、整段当场死 ⇒ 正文一行都画不出来。 */
    const frag = document.createDocumentFragment();
    for (const it of items) frag.appendChild(it.el);
    /* ⚠ **变动条先插、收纳条后插**：两者都用 insertBefore(…, items[at].el) 这个写法，
     *   而"插在同一个锚点前"时**后插的排在前面** ⇒ 这个顺序出来的页面是「收纳条在上、变动条在下」。 */
    const chgObjs = [];
    for (const b of chg) {
        const B = dvMakeChangeBand(b.list, CT);
        chgObjs.push(B);
        if (b.from >= items.length) frag.appendChild(B.band);
        else frag.insertBefore(B.band, items[b.from].el);
        /* ⚠ 尾条要挂在**块尾那一行之后** —— 变动行是 #diff 的直接子元素、不在 band 里，
         *   所以不能靠 band.appendChild 定位（那会让它紧跟首条、挤到块首去）。 */
        if (b.to + 1 >= items.length) frag.appendChild(B.bar2);
        else frag.insertBefore(B.bar2, items[b.to + 1].el);
    }
    const gapObjs = [];
    for (const g of gaps) {
        const G = dvMakeBand(g, CT, ra, rb);
        gapObjs.push(G);
        /* at 等于 items.length 时 items[at] 是 undefined ⇒ 尾部那条走 appendChild（同一个坑，别再踩）。 */
        if (g.at >= items.length) frag.appendChild(G.band);
        else frag.insertBefore(G.band, items[g.at].el);
    }
    box.appendChild(frag);
    box.hidden = false;
    /* 给验收脚本一个可读的口：几处收纳、各自的行区间、按哪一侧切 */
    window.__gaps = gapObjs;
    window.__chg = chgObjs;
    window.__diff = { rows: rows.length, gaps: gapObjs.length, chg: chgObjs.length, kTokPerChar: CT.k, contentA: ra.length, contentB: rb.length };
    /* ══ ★ 2026-09-24：把每条 band 上的「≈X tok」从**折算**换成**真分词器**数出来的值 ════════════
     *  为什么必须换（用户实测第 20 轮，原话："三个差异页的分词器有点问题 不过小bug，需要统一分词算法。
     *  第20轮官方与本地计算都是7k左右，但是差异页是8k的内容"）—— 折算那条路有两处系统性偏高：
     *    ① 行字数里**多算了每行那个换行**（同一批内容 407 行 ⇒ 虚高 ≈278 tok），
     *       而面板的口径里只有"条数 − 1"个换行；
     *    ② 被乘的是**铺平展示文本**的行字数，乘数却是**真出网字节**口径的字/token 比（再虚高 ≈190 tok）。
     *  ⇒ 改成问服务端（GET /tokseg，它用与面板「本地」那几格**同一份酒馆词表、同一个分词器**真数）。
     *  ⚠ 拿不到就**什么都不做** —— 条上照旧留着那个折算值（带 ≈），绝不把数抹成 0、也不编一个。
     *  ⚠ 这一跳是**纯显示**：不改正文里任何一个字、不改行号落列、不改 /diff 那份 patch。 */
    const fillRealToks = async () => {
        const bands = gapObjs.concat(chgObjs).filter(B => Array.isArray(B.segs) && B.segs.length);
        if (!bands.length || !opt.from || !opt.to) return 0;
        const sides = { a: { ref: String(opt.from), segs: [] }, b: { ref: String(opt.to), segs: [] } };
        for (const B of bands) for (const s of B.segs) { if (sides[s.side]) sides[s.side].segs.push(s); }
        const got = { a: null, b: null };
        await Promise.all(['a', 'b'].map(async (sd) => {
            const list = sides[sd].segs;
            if (!list.length) return;
            const url = BASE + '/tokseg?chat=' + encodeURIComponent(CHAT)
                + '&from=' + encodeURIComponent(sides[sd].ref)
                + '&segs=' + encodeURIComponent(list.map(s => s.from + '-' + s.to).join(','));
            try {
                const j = await getJson(url);
                /* 长度对不上就整批不用 —— 宁可留着折算值，也不许把 A 段的 token 按到 B 段头上。 */
                if (j && j.ok === true && Array.isArray(j.segs) && j.segs.length === list.length) got[sd] = j.segs;
            } catch (_) { /* 拿不到就是拿不到（老服务端 / 这台机器没词表）⇒ 折算值照旧挂着 */ }
        }));
        if (!got.a && !got.b) return 0;
        /* 按段对回去：`/tokseg` 的返回与请求**同序**（服务端就是照着 segs 的顺序 map 出来的）。 */
        const filled = { a: new Map(), b: new Map() };
        for (const sd of ['a', 'b']) {
            if (!got[sd]) continue;
            sides[sd].segs.forEach((s, i) => filled[sd].set(s.from + '-' + s.to, got[sd][i].tok));
        }
        let n = 0;
        for (const B of bands) {
            let sum = 0, all = true;
            for (const s of B.segs) {
                const v = filled[s.side] ? filled[s.side].get(s.from + '-' + s.to) : undefined;
                if (Number.isFinite(v)) sum += v; else all = false;
            }
            if (all && sum > 0 && B.setTok(sum)) n++;
        }
        window.__tokReal = n;          // 给验收一个可读的口：几条 band 真的换成了真值
        return n;
    };
    /* ⚠ 挂成 Promise 是**为验收**：真浏览器那一趟要 await 它，否则量到的是"还没换上去"的那一刻。
     *  ⚠ 不 await（页面照常先用折算值渲染完，真值到了自己换上去）—— 首屏一秒都不许多等。 */
    window.__tokRealDone = fillRealToks();
    return { rows, gaps: gapObjs, chg: chgObjs };
}

async function runDiff() {
    head('对比', LABEL, null);
    if (!CHAT) return say('bad', '缺少场名（chat）—— 这一页不知道要比哪一场的记录。');
    const from = String(Q.get('from') || '');
    const to = String(Q.get('to') || '');
    const prevNo = String(Q.get('prevno') || '');
    const curNo = String(Q.get('no') || '');
    if (!from || !to) return say('bad', '缺少要比的两侧（from / to）。');

    const url = BASE + '/diff?chat=' + encodeURIComponent(CHAT) + '&blob=1'
        + '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    /* ★ 2026-09-24：收纳条上那个 ≈X tok 要一个折算比（字/token）—— 与面板「本地」那几格
     * **同一个口径**：本地逐条求和 tok ÷ 这一轮总字数。这两个数在**既有只读路由** /log 里
     * （`tok` / `totalChars`），所以这里多打一条 /log，⛔ 不新造接口、不改服务端。
     * 拿不到（老服务端 / 这一轮还没记录）⇒ k = 0 ⇒ 收纳条**只写行数与字数**，绝不编 token。 */
    const logUrl = BASE + '/log?chat=' + encodeURIComponent(CHAT);
    head('对比', LABEL, url);
    say('dim', '正在比这两侧…');

    const [dr, lr] = await Promise.allSettled([getJson(url), getJson(logUrl)]);
    /* ⚠ 两种失败分开说（与原来逐字一样，别合并成一句）：
     *   · 请求本身没成功（网络/解析）⇒ "差异取不到：<原因>"；
     *   · 服务端回了 ok:false ⇒ "这两轮没法比：<它给的那句 error>"（照原样转述，不换一句好听的）。 */
    if (dr.status === 'rejected') {
        return say('bad', '差异取不到：' + (dr.reason?.message || dr.reason) + '\n' + url);
    }
    const j = dr.value;
    if (!j || j.ok !== true) {
        return say('bad', '这两轮没法比：' + String(j?.error || '服务端没给 error') + '\n' + url);
    }
    /* 兜底：/diff 取到了就用它；/diff 挂了才把原因说出来（上面那一条已经覆盖）。 */
    if (lr.status === 'rejected') { /* /log 拿不到不影响看差异，只影响那个 ≈tok */ }
    const log = (lr.status === 'fulfilled' && lr.value && lr.value.ok === true) ? lr.value : null;

    const s = Array.isArray(j.sides) ? j.sides[0] : null;
    const via = (v) => (v === 'blob' ? '提交里读到的' : (v === 'worktree' ? '盘上文件里' : String(v || '?')));
    const bits = [];
    if (prevNo !== '' && curNo !== '') bits.push('第 ' + prevNo + ' 轮 ↔ 第 ' + curNo + ' 轮');
    if (s) bits.push(s.file + '：前 ' + via(s.aVia) + ' / 后 ' + via(s.bVia));
    say(j.missingBlob ? 'note' : 'dim',
        bits.join(' · ')
        + (j.sameContent ? ' · 两侧内容逐字节相同（这一页不会有任何差异行）' : '')
        + (j.blobNote ? '\n' + String(j.blobNote) : ''));

    if (!String(j.patch || '').trim()) {
        return say(j.sameContent ? 'note' : 'bad',
            j.sameContent
                ? '这两轮的记录逐字节相同 —— 所以没有差异行可画。这不是页面坏了。'
                : '服务端回了 ok，但 patch 是空的 —— 这一页不比，也不拿"没差异"顶上去。\n' + url);
    }
    /* ── 收纳条那个 ≈tok 的折算比（与源文件 `_dvPage` 同一算式，只换来源）──────────────
     *  源：k = 面板那一行的 row.tok ÷ row.myCharTotal。
     *  这里：同一场的 /log 里那一轮 —— `tok` 是本地数出来的那一格（读不到则退回抬头里那个数，
     *  与 ledger.js 的搬运同一条规矩），`totalChars` 就是面板行 myCharTotal 的**同一个字段**。
     *  ⚠ URL 里的 no 是 **1 起算**的轮号（面板传的就是它）⇒ /log 的键是它 −1。 */
    const no1 = Number(curNo) || Number(prevNo) || 0;
    const cur = (log && Array.isArray(log.commits))
        ? (log.commits.find(c => Number(c?.no) === no1 - 1) || null) : null;
    const tokLocal = (() => {
        const m = /(\d+)\s*tok\s*\/\s*(\d+)\s*msgs/.exec(String(cur?.subject || ''));
        const tv = Number(cur?.tok) || 0;
        return tv ? tv : (m ? Number(m[1]) : 0);
    })();
    const kTokPerChar = (tokLocal > 0 && Number(cur?.totalChars) > 0)
        ? (tokLocal / Number(cur.totalChars)) : 0;
    /* ★ 2026-09-24：`from` / `to` 一起带进去 —— 收纳条与变动块上那个 tok 要拿去问服务端
     * （GET /tokseg，与面板同一份酒馆词表真数）。⚠ 必须是**这两个原样的 `<sha>:<路径>`**：
     * 只有与 /diff 同一个 ref，铺出来的那串才与页面上这份逐字节一致，行号才对得上。 */
    renderPatch(j.patch, { contentA: j.fromContent, contentB: j.toContent, kTokPerChar, from, to });
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */

(async () => {
    try {
        if (MODE === 'diff') await runDiff();
        else if (MODE === 'doc') await runDoc();
        else if (MODE === 'res') await runRes();
        else say('bad', '认不出的 mode：' + MODE + '（只认 doc / diff / res）');
    } catch (e) {
        say('bad', '这一页自己出错了：' + (e?.stack || e?.message || e));
    }
})();

/* 「继续读下一段」那颗按钮 —— 只在本页存在时才接线（diff / doc 两模式没有它）。 */
try {
    const mb = $('more');
    if (mb) mb.addEventListener('click', () => { void resMore(); });
} catch (_) { /* 接不上不影响看正文 */ }
