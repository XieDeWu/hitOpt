/* ══════════════════════════════════════════════════════════════════════════════════════
 * 实验算法 ⑤：**最长公共子串（兼容变量区）**（`core/expAlgo/ptrExactV2_4.js`）
 *
 *   算法名：最长公共子串      版本：v2.4
 *   ⚠ 它由 `ptrExactV2_3.js`（v2.3）**复制而来**；v1 / v2.1 / v2.2 / v2.3 **一个字没动**，
 *     五份并排当对照。用户 2026-09-19："**复制 新增v2.4算法**"。
 *
 * ── v2.4 相对 v2.3 只加了一件事：**变量区兼容**（用户 2026-09-19："**希望能兼容变量区把**"）
 *   v2.3 是"裸字符级"——段想切哪就切哪，于是 `<UpdateVariable>` 里的 `[{…},{…}]`
 *   会被壳掏成 `[壳]`：那一段字**没丢**（壳指的上文里有全文），但**结构坏了**，
 *   模型照着这个格式往下写就会写空一个 JSON 数组。用户要的就是把这个口子堵上。
 *   两道护栏（都在**被处理的那一侧 B** 上算）：
 *     ① **标签不许被切两半**：段的两端不许落在任何一个 `<…>` 标签**内部**。
 *        这一条**与标签成不成对无关** ⇒ 没配对的标签也照样兜得住。
 *     ② **容器块整块进出**：`<UpdateVariable>…</UpdateVariable>` / `<JSONPatch>…</JSONPatch>`
 *        是**语法容器** ⇒ 段的头只能是容器的头、段的尾只能是容器的尾；
 *        整块重复时**整块换成壳**（所以"兼容"不是"放过它"，是"能整块地省它"）。
 *   ⚠ 真切片实测（`turns/00001.abc.txt` 的 B 区）：**6 个 `<UpdateVariable>` 只有 4 个闭合标签**
 *     —— B 区是从上一轮里切出来的一段，边界本来就会切断块 ⇒ **不配对的一律不当容器**
 *     （不猜），这时候只有护栏①在护着它。这就是两道护栏必须分开写的理由。
 *
 * ── 用户给的定位（2026-09-19，写在这儿免得以后又起新名字）──────────────────────
 *   "**统一最长公共子串算法　也就部分展开形式与完全展开形式的区别**"
 *   ⇒ 这个家族只有一个算法：**最长公共子串**。前面那几版不过是它的**受限展开形式**：
 *     v2.1 = 只在整条消息边界上展开；v2.2 = 只在行边界上展开；v2.3 = 裸字符级完全展开；
 *     **v2.4 = 完全展开 ＋ 结构化标签/变量区整块进出**。
 *     ⚠ 旧的那几份是**用户点名要留的对照**（"你别乱动其他算法"）⇒ 一个都没删。
 *
 * ── 用户 2026-09-19 的原话（这是他看完 v2.2 产物之后给的硬指令）────────────────────
 *      "**不行**
 *       你必须按A B 两者的最大公共子串算法（至少300字公共长），找出B在A中所有的最大公共子串
 *       然后为每个公共子串加壳**"
 *
 * ── 为什么 v2.2 被否（他圈出来的就是病）──────────────────────────────────────────
 *   v2.2 的粒度是"**连续整行**"：一段必须整行整行地重复才认得出来。
 *   可真实世界书／地图条目里，一行常常是"前半句新写、后半句照抄"——
 *   行级判据对这种**行内重复**完全瞎。他把产物里那几处圈出来贴过来，正是这个形状。
 *   ⇒ 粒度必须回到**字符级**：不管行边界在哪，只要有 300 字连着一样就得认出来。
 *
 * ── 这一版的算法（就是他说的那件事，一步一步对应）────────────────────────────────
 *   ① **建索引**：把参考串 A 每一个位置的 **300 字窗口**滚出一个 32 位哈希（O(|A|)），
 *      存进 `哈希 → 位置列表`；
 *   ② **扫 B**：对 B 每一个位置同样取 300 字窗口哈希，命中就去**逐字真比较**
 *      （哈希只当索引，认不认由真比较说了算 ⇒ 碰撞零风险），再一路向右扩到不再相同
 *      ⇒ 得到"从这一位起的最长公共子串"；
 *   ③ **取极大**：从左到右贪心取最长的那一段，取完跳到段尾继续
 *      ⇒ 得到的每一段都是**极大**的（再往右一个字就不一样了），段与段互不重叠；
 *   ④ **加壳**：每段换成 `<HASH-XXXXXX>原段开头 50 字…略 N 字…原段结尾 30 字</HASH-XXXXXX>`
 *      （形状与主算法的指针同族，见下面「壳」那一节），其余字原样拼回。
 *   ⚠ `MIN = 300` 是**用户定的**（"至少300字公共长"）：短于 300 的公共子串一概不认
 *     —— 壳本身要三十来字，短段换壳还倒亏，300 这个数同时把"碎壳"问题挡在门外。
 *
 * ── 与前三版的账（`tools/algo_iter.mjs`，B 区 269,122 字 / 6 轮 / K=0.599）──────
 *     v1   精确匹配指针化  省 199,303 字（74.1%）—— 但壳是 `<HASH-…>`，模型不可读
 *     v2.1 整条去重        省  25,129 字（ 9.3%）
 *     v2.2 连续行去重      省 196,473 字（73.0%）
 *     v2.3 最大公共子串    **本版实测见 `_research/algo_iter/_summary.md`**
 *
 * ── ⚠ 如实写在最前面的一笔代价：字符级会切进结构里 ──────────────────────────────
 *   v2.2 那三条安全规矩（不切行、`<JSONPatch>` 整块进出、裸 JSON 行不碰）在这一版
 *   **按用户指令取消**了 —— 用户要的就是"字符级、找出所有公共子串"。
 *   后果说清楚：若某段公共子串横跨一个 JSON 数组，数组会被壳掏空（`[{…},{…}]` → `[壳]`）。
 *   **但信息没丢**：壳指的那一段在 A 里**逐字节完整存在**（这正是"公共子串"的定义），
 *   而且壳里**回显了原段的开头**（模型一眼知道省掉的是哪一块），模型读得懂该去哪找。
 *   这不是"退回 v2.0"：v2.0 的病是壳体本身不可读（`<HASH-xxxx/xx>`），不是"切在字符流里"。
 *
 * ── 它只动 B（结构保证，与前三版同）────────────────────────────────────────────
 *   签名 `apply(B_msgs, ref)` —— A 与 C **根本没传进来**（用户指令 A 的落地方式：
 *   不是"算法自觉不动"，而是**够不到**）。
 * ══════════════════════════════════════════════════════════════════════════════════════ */
import { register } from './registry.js';

const MIN = 300;          // ★ 用户定版："至少300字公共长" ⚠ v6.41.16 实测：降到 50 只多省 0.3%（真切片 10 轮 147,400 字里多省 464 字，且 10 轮里有 1 轮反而更长）⇒ 用户 2026-09-20 拍板"那算了"，**别再提议降它**
const BASE = 1000003;     // 滚动哈希基数
const CAP = 32;           // 同一哈希下最多验几个落脚点（哈希碰撞的兜底，不影响正确性）

/* ══════════════════════════════════════════════════════════════════════════════════════
 * ★ v6.41.13【**增量编码**】—— 这一级只吃"上一级没碰过的增量"
 *
 * 【它解决的是什么】
 *   多级管线里，第 k 级的**输入**就是第 k−1 级的**产物**，而产物里已经躺着壳。
 *   壳本身约百来字（不足 `MIN`）⇒ 单个壳不会被匹配；但 **"壳 ＋ 紧邻的裸文本"连起来
 *   轻松超过 300 字**，而且那一段与参考串里同一位置逐字节相同 ⇒ 会被当成重复段
 *   **再套一层壳**。展开器的正则写的是 `<HASH-…>[^<]*…</HASH-…>` ——
 *   被套的壳里回显含 `<`（`<HASH-…>` 自己），`[^<]*` 到那儿就断了
 *   ⇒ **那一层壳永远展不开 ⇒ 那段内容读不回来**（不是"效果差一点"，是内容丢失）。
 *
 * 【增量编码就是那道保护】
 *   把"已经是壳的区间"当**原子**：段的头不许落在壳里、段的尾不许伸进壳。
 *   ⇒ 每一级只在"上一级留下的裸文本"上找公共子串 = **只在增量上做功**。
 *   ⇒ 副产品：`apply` 在 `opt.inc` 下报出**这一级新壳化了哪些区间**（增量的账）。
 *
 * 【⚠ 默认路径逐字节不变】单级管线（当前默认）的输入是**原始 B**，里面一个壳都没有
 *   ⇒ `prot` 为空 ⇒ 这一段代码一步都不跑，产物与改动前逐位相同。
 * ══════════════════════════════════════════════════════════════════════════════════════ */
/** 已闭合的壳：`<HASH-XXXXXX>回显</HASH-XXXXXX>`（回显里不可能有 `<` —— 建壳时已换成 `‹`） */
const SHELL_RE = /<HASH-([0-9A-F]{6})>[^<]*<\/HASH-\1>/g;
/** 扫出串里所有壳的区间（**只认闭合的**；半个壳不算 —— 不猜）
 *  ⚠ **导出只为验收能直接钉它**（`check/algo_pipe_test.mjs` ㉒ 段）：生产路径上它是 `segsOf` 的内部轮子。 */
export function shellRanges(t) {
    const out = [];
    SHELL_RE.lastIndex = 0;
    for (let m = SHELL_RE.exec(t); m; m = SHELL_RE.exec(t)) out.push([m.index, m.index + m[0].length]);
    return out;
}

/** 壳：**给人看、给模型看、给工具认** —— 形状与主算法的指针同族（用户 2026-09-19 定版）
 *
 *  ⚠ 这一版被用户否过两次，两次都记在这儿，别再退回去：
 *    ① v2.1/v2.2 的老壳 `【与上文重复，略 229 字：上文第 63374 字起】` ——
 *       用户："**你的缩写 毫无意义 模型完全视为噪音 也无任何信息熵**"。
 *       模型**数不到第 63374 个字**，那个坐标只有工具能用 ⇒ 对模型是纯噪音。
 *    ② 改成 `【与上文重复，略 229 字：<原文开头>…】` 之后，用户给了最终形状：
 *       "**建议放进去壳子里面　类似 <HASH- .... name = "...">世界观总纲: 舞台: 长夜都，
 *        中国滨海巨城。2067年近未来…</HASH- .... name = "...">**"
 *       ⇒ 用**主算法那一族的标签形状**（真 body 里就是 `<HASH-3AF0F1 name="北门询问室的门…">`），
 *         回显放进**标签里面**，哈希放进标签名 ⇒ 同一个形状在全项目只有一套。
 *
 *  现在的壳：`<HASH-88ABEC>世界观总纲: 舞台: 长夜都，中国滨海巨城。2067年近未来…略 4937 字…位面战争爆发前夜。</HASH-88ABEC>`
 *    · `HASH-XXXXXX` = **省略段自身内容的哈希**（同一段内容在任何地方都是同一个哈希
 *      ⇒ "哈希相同就是同一段字"这句话是**可验证**的，模型也能拿它去上文对照）；
 *    · 标签之间 = **一句人话**：`原文开头（HEAD 字）…略 N 字…原文结尾（TAIL 字）`
 *      —— 回显 + 省略字数**连起来读就是一句话**，不拆进任何属性里
 *      （用户 2026-09-19："**别这样写 你还不如...后面写略 2330 字**"）。
 *  ⚠ 开闭标签都**不带属性**：属性形状既啰嗦、又让模型可能学着照写；
 *    哈希已经把首尾钉在一起了。 */
const HEAD = 50;          // ★ v6.41.12【用户 2026-09-20 定版】壳里回显的**开头**字数：32 → 50
const TAIL = 30;          // ★ v6.41.12【同一句】壳里**也要回显结尾**：`头50 …略 N 字… 尾30`
const isWs = (c) => (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c || c === 0x3000 || c === 0xa0);

/** 回显用的抓手：段的前 HEAD 字，换行/连续空白压成一个空格（**壳必须是一行**）。
 *  ⚠ 壳里的 `<` 要换掉 —— 壳里冒出半个 `<` 会把后面的字当成标签吃掉（这个坑在超链接那回踩过）。
 *    但**不能删**：删了回显就与原文差一个字，还原时定位会整体偏一格（实测 `<JSONPatch>` 开头那段
 *    还原出来少一个 `<`、尾巴多一个字）。⇒ 换成等长的 `‹`，还原时再换回来。 */
function headOf(s) {
    return String(s).slice(0, HEAD).replace(/[\s\u3000]+/g, ' ').replace(/</g, '‹').trim();
}

/** ★ v6.41.12【回显的**尾巴**】用户 2026-09-20 原话：
 *    "这里的匹配 可显示为 长度改为 `<HASH-XXXX>前面50字符...略xxxx字...然后后面30字符</HASH-XXXX>`"
 *  ── 为什么要尾巴：只给开头，模型读到的是"这段是以『角色档案: 基本信息』开头的 2867 字" ——
 *     **它不知道这段到哪儿结束**；补上结尾，模型能自己判断"这一段是完整的角色档案"，
 *     对"被省略的内容是什么"有实质帮助（而代价只有 30 字）。
 *  ⚠ 与 `headOf` 同一条纪律：换行/连续空白压成一个空格（**壳必须是一行**）、`<` 换成等长的 `‹`。
 *  ⚠ **还原不靠尾巴**（`expand` 只拿回显里第一个 ≥4 字的片段去参考串定位）⇒ 加尾巴**不影响还原**。 */
function tailOf(s) {
    return String(s).slice(-TAIL).replace(/[\s\u3000]+/g, ' ').replace(/</g, '‹').trim();
}

/** 省略段内容的哈希（FNV-1a 32 位取低 24 位）⇒ 6 位大写十六进制，与主算法同宽 */
function hash6(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ((h >>> 8) & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
}

function noteOf(seg, len) {
    const h = hash6(seg);
    /* ★ v6.41.12：`头50 …略 N 字… 尾30`（老形态是 `头32…略 N 字`，还原器两种都认）。 */
    return `<HASH-${h}>${headOf(seg)}…略 ${len} 字…${tailOf(seg)}</HASH-${h}>`;
}

/** ★ 可还原：把壳换回原文（拿这一轮的参考串就能摊回原样）
 *  ⚠ 定位靠的是**标签之间那段回显**（不是坐标）：拿回显里第一个非空片段去参考串里找。
 *    段的头在建段时已经剥掉前导空白 ⇒ 回显的第一个字就是段的第一个字 ⇒ 定位点是准的。
 *  ⚠ 壳为了让"独占一行"补上去的换行，在这里要**按原文的实际情况**处理：
 *    产物里壳两侧的换行被 `\n?` 一起吃掉，然后照 `ref` 里那一段前后**本来有没有换行**补回来
 *    ⇒ 补过的删掉、原文有的留着。这样"摊平后逐字节等于输入"照样成立。 */
export function expand(text, ref) {
    const R = String(ref ?? '');
    let n = 0, miss = 0;
    /* ★ v6.41.12：正则**同时认两种形态** —— 新的 `头…略 N 字…尾` 与老的 `头…略 N 字`。
       `(?:…([^<]*))?` 那一段把尾巴捕获进来（**只用于兼容匹配，不参与定位**：
       定位照旧靠回显里第一个 ≥4 字的片段 ⇒ 加尾巴不会把"摊平后逐字节等于输入"这条性质弄坏）。 */
    const out = String(text ?? '').replace(/\n?<HASH-([0-9A-F]{6})>([^<]*)…略 (\d+) 字(?:…([^<]*))?<\/HASH-\1>\n?/g, (m, h, head, l) => {
        const len = Number(l);
        const key = String(head).replace(/‹/g, '<').split(' ').filter((x) => x.length >= 4)[0] || '';
        const at = key ? R.indexOf(key) : -1;
        if (!Number.isFinite(len) || len <= 0 || at < 0 || at + len > R.length) { miss++; return m; }
        n++;
        const lead = (at > 0 && R[at - 1] === '\n') ? '\n' : '';
        const tail = (at + len < R.length && R[at + len] === '\n') ? '\n' : '';
        return lead + R.substr(at, len) + tail;
    });
    return { text: out, n, miss };
}

/** 32 位滚动哈希的权：BASE 的 W−1 次方（模 2^32） */
function powOf(W) { let p = 1; for (let k = 0; k < W - 1; k++) p = Math.imul(p, BASE); return p; }

/** ★ v2.4 新增：**变量区 / 结构化标签的两道护栏**（见文件头那一节）
 *  都在**被处理的那一侧**（B）上算；A 是不动的原文，用不着护。
 *  @returns {{goodEnd:Int32Array, canStart:(i:number)=>boolean}}
 *    · `canStart(i)`：位置 i 能不能当**段的头**（不许落在标签或容器的内部）；
 *    · `goodEnd[p]`：**≤ p 的最近一个合法"段的尾"**（一次 O(n) 扫出来的前驱表）
 *      —— 段尾回退时 O(1) 取。不建这张表的话每扫一个位置都要往回退一大截，
 *      最坏会退成 O(n²)（用户口径：工具调用不许超 5 秒）。 */
const BLOCK_TAGS = ['UpdateVariable', 'JSONPatch'];
function guards(t) {
    const n = t.length;
    const tag = new Uint8Array(n);          // 1 = 这个位置在某个 <…> 标签里（护栏①）
    const tS = new Uint8Array(n + 1);       // 1 = 这个位置是某个标签的**起点**（那个 '<'）
    const tE = new Uint8Array(n + 1);       // 1 = 这个位置是某个标签的**终点**（'>' 的下一个位置）
    /* ⚠ 未闭合的 `<` 也要算进来：B 区是从上一轮里切出来的一段，边界本来就会把一个标签切断
     *   ⇒ "`<` 后面跟字母或斜杠、一直到 `>` 或串尾"整段都算标签里。写成 `<[^>]*>` 会把这种漏掉。 */
    for (const m of t.matchAll(/<[A-Za-z/][^>]{0,300}(?:>|$)/g)) {
        const a = m.index, b = a + m[0].length;
        for (let p = a; p < b; p++) tag[p] = 1;
        tS[a] = 1; tE[b] = 1;
    }
    const blk = new Int32Array(n);          // >0 = 这个位置在第 k 个容器里（护栏②）
    const list = [];
    const re = new RegExp('<(?:' + BLOCK_TAGS.join('|') + ')>', 'g');
    for (let m = re.exec(t); m; m = re.exec(t)) {
        const open = m[0];                                   // 例：'<JSONPatch>'
        const close = t.indexOf('</' + open.slice(1), m.index + open.length);
        if (close < 0) continue;                             // 没闭合 ⇒ 不认这个容器（不猜）
        const ce = close + open.length + 1;                  // 闭合标签比开标签多一个 '/'
        list.push([m.index, ce]);
        for (let p = m.index; p < ce; p++) blk[p] = list.length;
        re.lastIndex = ce;
    }
    const goodEnd = new Int32Array(n + 1);
    goodEnd[0] = -1;
    for (let p = 1; p <= n; p++) {
        const k = blk[p - 1];
        /* ⚠ "位置 p−1 在标签里"**不等于**"标签被切碎了"：如果 p 正好是那个标签的**终点**
         *   （最后一个字符就是 '>'），段其实把整个标签囫囵含住了 ⇒ 合法。
         *   我第一版漏了这一句，结果连"整块 <JSONPatch> 一起省"都被自己拦掉。 */
        const okTag = (tag[p - 1] === 0) || (tE[p] === 1);
        const okBlk = (k === 0) || (list[k - 1][1] === p);
        goodEnd[p] = (okTag && okBlk) ? p : goodEnd[p - 1];
    }
    const canStart = (i) => {
        const k = blk[i];
        /* ⚠ 容器的**头**本身就在标签里（`<JSONPatch>` 的那个 `<`）—— 不特判它，
         *   整块的变量区就永远开不了头，省量会白掉一大截（实测差 10,644 字）。 */
        if (k > 0 && list[k - 1][0] === i) return true;
        return (tag[i] === 0) || (tS[i] === 1);
    };
    return { goodEnd, canStart };
}

/** ① 建索引：A 每个位置的 W 字窗口哈希 → 位置列表 */
function buildIndex(A, W, pow) {
    const idx = new Map();
    const n = A.length;
    if (n < W) return idx;
    let h = 0;
    for (let k = 0; k < W; k++) h = (Math.imul(h, BASE) + A.charCodeAt(k)) | 0;
    const push = (key, p) => { const a = idx.get(key); if (a) a.push(p); else idx.set(key, [p]); };
    push(h, 0);
    for (let p = 1; p + W <= n; p++) {
        h = (Math.imul((h - Math.imul(A.charCodeAt(p - 1), pow)) | 0, BASE) + A.charCodeAt(p + W - 1)) | 0;
        push(h, p);
    }
    return idx;
}

/** ②③ 扫 B、取所有**极大**公共子串（≥ W 字，段与段不重叠）
 *  @param prot ★ v6.41.13：**已经是壳的区间**（增量编码的保护带，见文件头那一节）。
 *              段的头不许落在里面、段的尾不许伸进去 ⇒ 这一级只在"上一级留下的裸文本"上做功。
 *              不传 / 空数组 ⇒ 与改动前逐字节相同（默认单级管线走的就是这一支）。
 *  @returns {Array<{s:number,e:number,p:number}>} B 的 [s,e) ↔ A 的 p 起（逐字节相同） */
function segsOf(A, B, W, prot) {
    const out = [];
    const na = A.length, nb = B.length;
    if (nb < W || na < W) return out;
    const pow = powOf(W);
    const idx = buildIndex(A, W, pow);
    if (!idx.size) return out;
    const hashAt = (i) => { let x = 0; for (let k = 0; k < W; k++) x = (Math.imul(x, BASE) + B.charCodeAt(i + k)) | 0; return x; };
    const g = guards(B);                    // ★ v2.4：变量区 / 标签的两道护栏（在 B 上算）
    /* ★ v6.41.13【增量编码的两张表】—— 都在 B 上算，O(n) 一次扫完：
     *   · `inSh[p]`   = 位置 p 在某个壳**内部**（`shEnd[p]` = 那个壳的终点）；
     *   · `nxSh[p]`   = **≥ p 的最近一个"壳的起点"**（没有就是 nb）—— 段尾靠它收边。
     *   ⚠ 两张表都不含未闭合的壳（`shellRanges` 只认闭合的）⇒ 半个壳由 `guards` 的标签护栏管。 */
    const inSh = new Uint8Array(nb);
    const shEnd = new Int32Array(nb);
    for (const rg of (prot || [])) {
        const a = rg[0], b = Math.min(rg[1], nb);
        for (let p = a; p < b; p++) { inSh[p] = 1; shEnd[p] = b; }
    }
    const nxSh = new Int32Array(nb + 1);
    nxSh[nb] = nb;
    {
        let nx = nb;
        for (let p = nb - 1; p >= 0; p--) {
            if (inSh[p] && (p === 0 || !inSh[p - 1])) nx = p;   // 只在"壳的起点"上更新
            nxSh[p] = nx;
        }
    }
    let i = 0;
    while (i + W <= nb) {
        /* ★ 增量编码：起点落在壳里 ⇒ 一步跳到壳尾（壳整块是原子，不从它中间起段） */
        if (inSh[i]) { i = shEnd[i]; continue; }
        if (!g.canStart(i)) { i++; continue; }               // ★ 护栏：段的头不许落在标签/容器内部
        const ps = idx.get(hashAt(i));
        let bestLen = 0, bestP = -1;
        if (ps) {
            const seed = B.substr(i, W);
            for (let t = 0; t < ps.length && t < CAP; t++) {
                const p = ps[t];
                if (!A.startsWith(seed, p)) continue;          // ★ 哈希只当索引，认不认由真比较说了算
                let L = W;
                const lim = Math.min(na - p, nb - i);
                while (L < lim && A.charCodeAt(p + L) === B.charCodeAt(i + L)) L++;
                if (L > bestLen) { bestLen = L; bestP = p; }
            }
        }
        if (bestLen >= W) {
            let s = i;
            /* ★ 护栏：段的尾只能落在"标签之外"或"某个容器的尾"上
             *   —— goodEnd 是预先扫好的前驱表，O(1) 查到；整块重复的变量区就是靠这一句才敢省。 */
            let e = g.goodEnd[i + bestLen];
            /* ★ v6.41.13【增量编码】段尾再收一道：**不许伸进任何一个已有的壳**。
             *   不收这一刀，段就会横跨一个壳 ⇒ 新壳把旧壳包进去 ⇒ 旧壳展不开（见文件头那节）。 */
            if (e > nxSh[s]) e = nxSh[s];
            /* ★★★★★★ v6.53.3【段尾吸附：不许把"字段名"和它的值切开】用户 2026-09-23 点名：
             *   "Δmiss里面不是 <HASH-00C70C> 指针包裹的概略内容吗？我想的是 指针可以替换掉吗？
             *    也就是头尾无缝衔接"。
             *  ── 现场（差异页第 14261~14262 行，.world 那个壳）：
             *     壳尾停在 年: 2024 月: 9 日: 1 小时:  而**下一行**是缩进的 10（再下一行才是"分钟: 10"）
             *     ⇒ 读起来是断的：字段名收在壳里、它的值孤零零掉在壳外面。
             *  ── 为什么原来没管住：段尾本来就有护栏（`goodEnd` 保证不落在**标签内部**），
             *     但 YAML 那种"字段名一行、值在下一行缩进"的结构里**一个标签都没有** ⇒ 护栏看不见它。
             *  ── 判据（只看 B 自己的字，不看下标 ⇒ 幂等）：段尾先收到行末；若**下一行是缩进行**，
             *     说明当前行是"字段名"、值还在下面 ⇒ 再退一行，直到下一行不再是缩进行为止。
             *     ⚠ 退到不足 W 就不再换壳（下面那道 `e - s < W` 兜住）—— 宁可这一段不省，也不切碎结构。 */
            while (e > s + W && e < nb && B.charCodeAt(e - 1) !== 0x0a) e--;      // ① 先收到行末
            /* ★ v6.53.3【甲（用户 2026-09-23 拍板）：最多退 TAIL_BACK_MAX 行】
             *   不加这道闸门的时候实测退过头了 —— 变量块是多层缩进（玩家: → 姓名: → 值），
             *   "退到下一行不再缩进"会一路退到整个块之前，每轮白丢约 5,500 字（≈ +3,300 tok）。
             *   加了闸门只退有限几行 ⇒ 治得住"字段名＋值"这类浅断口，又不动大结构。 */
            const TAIL_BACK_MAX = 3;
            let _back = 0;
            for (;;) {
                if (e <= s + W || e >= nb || _back >= TAIL_BACK_MAX) break;
                let p = e;
                while (p < nb && B.charCodeAt(p) === 0x0a) p++;                    // ② 取下一行行首
                const c = (p < nb) ? B.charCodeAt(p) : 0;
                if (!(c === 0x20 || c === 0x09 || c === 0x3000)) break;            // ③ 下一行不缩进 ⇒ 收边完成
                e--; _back++;                                                      // 下一行缩进 ⇒ 当前行是字段名 ⇒ 再退一行
                while (e > s + W && B.charCodeAt(e - 1) !== 0x0a) e--;
            }
            if (e - s < W) { i++; continue; }
            /* ⚠ 段的头从**第一个非空白字符**开始：省掉开头的空白没有任何意义，
             *   而且会让壳里的回显以空格开头（壳失真、还原也定位不准）。 */
            while (s < e && isWs(B.charCodeAt(s))) s++;
            /* ⚠ 段的头尾不许落在**代理对**中间（切出半个字符 ⇒ 产物里留下孤立的代理项、渲染成乱码）。
             *   尾巴：B[e−1] 是高位代理 ⇒ 回退一个 unit，让它与段外的 B[e] 配成一对（**安全**）。
             *   头：B[s] 是低位代理 ⇒ 它的高位在 B[s−1]、被留在段外 ⇒ **不安全**；
             *       只有 A[p−1] 与 B[s−1] 逐字相同时才能把 s/p 一起往回挪一个 unit（仍然逐字节相同）；
             *       挪不了就**整段放弃** —— 宁可少省一段，也不许在产物里制造乱码。 */
            let p = bestP + (s - i);
            if (e < nb && B.charCodeAt(e - 1) >= 0xD800 && B.charCodeAt(e - 1) <= 0xDBFF) e--;
            if (B.charCodeAt(s) >= 0xDC00 && B.charCodeAt(s) <= 0xDFFF) {
                if (s > 0 && p > 0 && B.charCodeAt(s - 1) === A.charCodeAt(p - 1)) { s--; p--; }
                else { i++; continue; }
            }
            if (e - s >= W) { out.push({ s, e, p }); i = e; continue; }
        }
        i++;
    }
    return out;
}

register({
    id: 'ptr-exact-v2.4',
    name: '最长公共子串',
    version: 'v2.4',
    desc: `字符级**完全展开**（≥300 字）：把 A 每处 300 字窗口建成哈希索引，扫 B 时逐字真比较、`
        + `向右扩到最长 ⇒ 取出 B 在 A 中**所有极大公共子串**，每段换成 `
        + `<HASH-XXXXXX>原段开头…略 N 字</HASH-XXXXXX>；`
        + `★ **兼容变量区**：段的两端不许落在标签内部、<UpdateVariable>/<JSONPatch> 整块进出；`
        + `★ **增量编码**：已经是壳的区间整块护住（段头不进壳、段尾不伸进壳）`
        + ` ⇒ 多级管线里每一级只在上一级留下的裸文本上做功，并报出自己那一份增量`,
    /** @param {Array<{role:string,content:string}>} B_msgs  B 片（**只读，不改原对象**） */
    /** @param {string} ref  参考串：第 1 轮＝真 A1；之后＝上一轮本链自己算出来的 T */
    /** @param opt ★ v6.41.13【增量编码】第三个参数本来就在传（主链传 `{legacy, step}`）⇒ 加字段不破兼容。
     *             `opt.inc` 为真时额外带出 `inc`（这一级新壳化了哪些区间）；它是**账**，不影响 `msgs`。 */
    apply(B_msgs, ref, opt) {
        const R = String(ref ?? '');
        const list = (B_msgs || []).map((m) => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
        let cover = 0, n = 0, ptrChars = 0;
        /* ★ v6.41.13：**这一级的增量** —— 把哪一条消息的哪一段换成了壳（消息内坐标 `[s,e)`）。
         *   它是"分级"能不能算清账的前提：第 k 级的增量 ∩ 前几级的增量 = ∅（保护带保证不重叠）。 */
        const inc = [];
        /* ★ v6.41.13：增量账只在调用方**要**的时候记（老调用方不传 opt.inc ⇒ `inc` 恒为空数组）。
         *   保护带（`prot`）**不分开关、一律生效** —— 它是正确性护栏，不是可选项。 */
        const _incOn = !!(opt && opt.inc);
        if (!list.length || !R) return { msgs: list, cover, n, ptr: ptrChars, inc };
        /* B 拼成整串再找 —— 用户要的是"B 在 A 中所有的最大公共子串"，B 是**整片**，不是一个一个条 */
        const spans = [];
        let off = 0;
        for (const m of list) { spans.push([off, off + m.content.length]); off += m.content.length + 1; }   // +1 = join 的换行
        const Btext = list.map((m) => m.content).join('\n');
        /* ★ v6.41.13【增量编码】先把"已经是壳的区间"扫出来当原子护住（单级管线里它是空的）。 */
        const prot = shellRanges(Btext);
        const segs = segsOf(R, Btext, MIN, prot);
        if (!segs.length) return { msgs: list, cover, n, ptr: ptrChars, inc };
        /* 段映射回各条消息：跨消息边界的段按边界切开，切完不足 300 字的碎片就不换（不倒亏） */
        const msgs = list.map((m, k) => {
            const [s0, e0] = spans[k];
            const cuts = [];
            for (const g of segs) {
                const s = Math.max(g.s, s0), e = Math.min(g.e, e0);
                if (e <= s || e - s < MIN) continue;
                cuts.push({ s, e });
            }
            if (!cuts.length) return m;                          // ★ 这一段没有可省的 ⇒ **一个字不动**
            /* ★ 壳**独占一行**（用户 2026-09-19："修改 v2.4 加个换行"）：
             *   先把这一条消息拆成"原文片段 / 壳"交替的序列，再统一在**壳的两侧**补换行。
             *   ⚠ 别只补"壳前"和"最后一个壳之后"—— 我第一版就是这么写的，结果中间那些
             *     "壳尾紧跟下一段原文"的地方全漏了（实测 `</HASH-7BFACE>地图/区/白鹤医区:` 照样挨着）。
             *   ⚠ 挨着的两个壳之间**只补一个**（靠"已输出内容末尾是不是换行"判），否则平白多出空行。 */
            const pieces = [];
            let cur = s0;
            for (const c of cuts) {
                /* ★★★★★★ v6.41.16【用户 2026-09-20："我后面会将阈值下降到 50 字符" ⇒ 必须堵上"换壳倒亏"】
                 *  壳的开销是**固定**的一大截：`<HASH-XXXXXX>`(13) ＋ `</HASH-XXXXXX>`(15)
                 *  ＋ `…略 N 字…`(6 ＋ N 的位数) ＋ 头 HEAD ＋ 尾 TAIL ⇒ 当前 HEAD/TAIL = 50/30 时
                 *  约 **114 ~ 119 字**。而 `MIN = 300` 把段的下限卡在 300 ⇒ 这条判断**永远不触发**
                 *  （300 > 119），它是**为将来调小 MIN 准备的**。
                 *  ⚠ 一旦 MIN 降到 50：一个 50 字的段换个 119 字的壳 ⇒ **倒亏 69 字/段**。
                 *  所以判据不该是"段够不够 MIN"，而该是"**这一段换壳到底赚不赚**"——
                 *  不赚就**原样留着**（`continue` 不推进 `cur` ⇒ 这段自然并进下一块的 raw）。 */
                const _sh = noteOf(Btext.slice(c.s, c.e), c.e - c.s);
                if (_sh.length >= c.e - c.s) continue;      // ★ 壳比原文还长 ⇒ 这一段不换（净亏）
                pieces.push({ raw: m.content.slice(cur - s0, c.s - s0) });
                pieces.push({ shell: _sh });
                cover += c.e - c.s; n++; ptrChars += 2;
                /* ★ v6.41.13：记下这一处**增量**（第 k 条消息内 `[s,e)`）—— 只在调用方要时记 */
                if (_incOn) inc.push({ k, s: c.s - s0, e: c.e - s0 });
                cur = c.e;
            }
            pieces.push({ raw: m.content.slice(cur - s0) });
            let out = '';
            for (let idx = 0; idx < pieces.length; idx++) {
                const pc = pieces[idx];
                if (pc.raw !== undefined) { out += pc.raw; continue; }
                if (out.length && !out.endsWith('\n')) out += '\n';       // 壳前
                out += pc.shell;
                ptrChars += pc.shell.length;
                const nx = pieces[idx + 1];
                if (nx && nx.raw && nx.raw.length && !nx.raw.startsWith('\n')) out += '\n';   // 壳后
            }
            return { role: m.role, content: out };
        });
        return { msgs, cover, n, ptr: ptrChars, inc };
    },
});
