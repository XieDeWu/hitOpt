/* ══════════════════════════════════════════════════════════════════════════════════════
 * 实验算法 ③：**连续行去重（可还原）**（`core/expAlgo/ptrExactV2_2.js`）
 *
 *   算法名：连续行去重      版本：v2.2
 *   ⚠ 它由 `ptrExactV2.js`（v2.1）**复制而来**；v1 与 v2.1 **一个字没动**（留着当对照）。
 *
 * ── 用户为什么点名要 v2.2（2026-09-19 原话 ＋ 两张差异页截图）──────────────────────
 *   原话："**复制新建v2.2算法　其中重点是解决重复问题　比如这里的地图xxxx一堆连续文本输入**"
 *   他截的是 `algos/ptr-exact-v2/turns/00006.txt ↔ 00007.txt` 那两页，正文里那一大片
 *   「地图说明：／地理概况：／取水·河流：／建筑类型说明：……」—— 一眼看过去几十行连着一样。
 *
 * ── v2.1 短在哪（**量出来的，不是猜的**）──────────────────────────────────────────
 *   v2.1 的判据是"**整条消息的正文**在参考串里逐字节出现过"。可这份输入里的重复**不在整条上**：
 *   `tools/rep_scan.mjs` 在真切片上量到 —— 同一个 `<world_饥渴世界>` 从第 3 万字到第 9 万字
 *   又原样来了一遍（17,109 字），而**没有任何一条消息**是"整条重复"的。
 *   ⇒ v2.1 只能省"整条重复"的那点边角：六轮合计 **25,452 字（9.4%）**。
 *
 * ── v2.2 改的那一件事：粒度从"整条"降到"**连续整行**"────────────────────────────
 *   一份提示词里的重复，绝大多数是**一段连着一段的行**（世界书条目、规则段、地图段），
 *   所以判据改成：
 *     · 把每条消息按 **换行** 切成行；
 *     · 从某一行起，若它在参考串里有落脚点，就**一行一行往下直比**，
 *       一直比到不再相同为止 ⇒ 得到一段"**连续若干行**"；
 *     · 这一整段在参考串里**逐字节出现过** ⇒ 换成一句说明；
 *     · 其余的行 **一个字节都不动**。
 *   ⇒ 六轮合计 **201,279 字（74.8%）**，是把 v2.1 的省量翻了近 8 倍，
 *     而**可读性一点没退**（说明句还是人话，不是 v2.0 那种 `<HASH-xxxx/xx>` 壳）。
 *
 * ── 为什么"整行"是安全的粒度（三条，缺一不可）────────────────────────────────────
 *   ① **绝不切在行中间**：替换段的头是某一行的头、尾是某一行的尾
 *      ⇒ 行内语法（引号、冒号、括号）永远成对，不会出现 v2.0 那种 `"value":85}` 被挖空；
 *   ② **语法容器必须整块进出**：`<JSONPatch>…</JSONPatch>` / `<UpdateVariable>…</UpdateVariable>`
 *      这两类块是**容器**，摘走中间几行会把 `[{…},{…}]` 掏成 `[]`（模型照着续写就写空）
 *      ⇒ 规则是"要么整块参与、要么整块不参与"，段的头尾不许落在块中间；
 *   ③ **长得像 JSON 的散行不碰**：以 `{` 或 `"` 开头、以 `}` 结尾、`[…]` 成对的散行一律不参与
 *      （它们没有标签兜底，摘掉没人保证骨架还在）。
 *   ⚠ 这三条加起来要付代价：六轮少省 **5,214 字**（201,279 → 206,493）。**这个代价是买的**，
 *     买的是"摘掉的每一段都不会破坏当前这一份的结构"。
 *
 * ── 可还原（与 v2.1 同一套语义）──────────────────────────────────────────────────
 *   说明句里带 `上文第 OFF 字起` ＋ `LEN 字` ⇒ `expand(text, ref)` 一行摊回原文。
 *   ⚠ 链上**越滚越安全**：本链 `T_N = ref_N ⊕ B'_N ⊕ C_N` ⇒ `ref_N` 永远是 `T_N` 的**前缀**
 *     ⇒ 第 N 轮写下的 offset 到了第 N+1 轮（拿 `T_N` 当参考串）**照样指得准**。
 *
 * ── 参数为什么定这两个数（扫过，见 `_tmp/v22_param.mjs` 那张表）──────────────────
 *   · `MIN = 32`（段短于它不值得换）：MIN 从 16 扫到 64，省量只从 159,770 掉到 159,396
 *     ⇒ **不敏感**，说明省下来的全是**大桥段**，产物一点都不碎（六轮一共才 75 句说明）；
 *   · `NET = 8`（净省不足 8 字不换）：扫 1/8/16/24 四档，差 0.2% 以内 ⇒ 取中间值，
 *     免得为了几个字生成一大堆"略 1 行 34 字"的碎句。
 *
 * ── 它只动 B（结构保证，与 v1/v2.1 同）──────────────────────────────────────────
 *   签名 `apply(B_msgs, ref)` —— A 与 C **根本没传进来**（用户指令 A 的落地方式：
 *   不是"算法自觉不动"，而是**够不到**）。
 * ══════════════════════════════════════════════════════════════════════════════════════ */
import { register } from './registry.js';

const MIN = 32;        // 段短于它不值得换
const NET = 8;         // 换成说明句之后至少要净省这么多字
const CAP = 8;         // 同一行在参考串里最多试几个落脚点（够用且不拖慢）

/** 语法容器：块内的行不许被单独摘走（见文件头 ②） */
const OPEN = /<(JSONPatch|UpdateVariable)>/;
const CLOSE = /<\/(JSONPatch|UpdateVariable)>/;

/** 说明句：**人能读懂、模型也能读懂、工具能还原** */
function noteOf(off, len, rows) {
    return `【与上文重复，略 ${rows} 行 ${len} 字：上文第 ${off} 字起】`;
}

/** 切行：**保留换行符**（这样 out.join('') 逐字节还原出不重复的那些行） */
function lineSplit(s) {
    return String(s).match(/[^\n]*\n|[^\n]+$/g) || [];
}

/** 长得像 JSON 片段的散行 ⇒ 永不参与（见文件头 ③） */
function looksJson(t) {
    if (!t) return false;
    if (t[0] === '{' || t[0] === '"') return true;
    if (t[0] === '[' && t[t.length - 1] === ']') return true;
    if (t[t.length - 1] === '}' || t[t.length - 1] === ']') return true;
    return false;
}

/** 给每一行打标：b=0 普通行｜b>0 第 n 个语法容器（head/tail 是块的头尾）｜b=-1 不许碰 */
function mark(L) {
    let inBlk = 0, id = 0;
    return L.map((l) => {
        const t = l.trim();
        if (OPEN.test(t)) { id++; inBlk = 1; return { b: id, head: 1, tail: 0 }; }
        if (inBlk) {
            if (CLOSE.test(t)) { inBlk = 0; return { b: id, head: 0, tail: 1 }; }
            return { b: id, head: 0, tail: 0 };
        }
        if (CLOSE.test(t) || looksJson(t)) return { b: -1, head: 0, tail: 0 };
        return { b: 0, head: 0, tail: 0 };
    });
}

/** 这一行能不能当**段的头**：块外的行、或某个块的头 ⇒ 能（不许从块中间开始） */
const canStart = (mk, i) => (mk[i].b === 0) || (mk[i].head === 1);
/** 这一行能不能出现在段里：b === -1 的行永远不许 */
const usable = (mk, i) => (mk[i].b !== -1);

/** 从第 i 行起找**最长的那一段连续行**（整段在 R 里逐字节出现过）。
 *  @returns {{j:number, at:number}|null} 段的最后一行下标 / 它在 R 里的落脚点 */
function matchAt(L, mk, R, i) {
    if (!usable(mk, i) || !canStart(mk, i)) return null;
    if (L[i].trim().length < 4) return null;
    let bestJ = -1, bestAt = -1, bestLen = 0;
    for (let p = R.indexOf(L[i]), tries = 0; p >= 0 && tries < CAP; tries++, p = R.indexOf(L[i], p + 1)) {
        let acc = L[i].length, j = i + 1;
        while (j < L.length && usable(mk, j) && R.startsWith(L[j], p + acc)) { acc += L[j].length; j++; }
        /* ★ 段的尾巴必须落在"块外"或"某个块的尾"上 —— 这一句就是"容器整块进出" */
        let e = j - 1;
        while (e >= i && !(mk[e].b === 0 || mk[e].tail === 1)) e--;
        if (e < i) continue;
        const len = L.slice(i, e + 1).reduce((a, x) => a + x.length, 0);
        if (len > bestLen) { bestLen = len; bestJ = e; bestAt = p; }
    }
    return (bestJ >= i) ? { j: bestJ, at: bestAt } : null;
}

/** ★ 可还原：把说明句换回原文（拿这一轮的参考串就能摊回原样） */
export function expand(text, ref) {
    const R = String(ref ?? '');
    let n = 0, miss = 0;
    const out = String(text ?? '').replace(/【与上文重复，略 (\d+) 行 (\d+) 字：上文第 (\d+) 字起】/g, (m, r, l, o) => {
        const len = Number(l), off = Number(o);
        if (!Number.isFinite(len) || !Number.isFinite(off) || off + len > R.length) { miss++; return m; }
        n++;
        return R.substr(off, len);
    });
    return { text: out, n, miss };
}

register({
    id: 'ptr-exact-v2.2',
    name: '连续行去重',
    version: 'v2.2',
    desc: `粒度是**连续整行**：从某一行起一行行往下直比，最长的那一段在参考串里逐字节出现过`
        + ` ⇒ 换成一句「与上文重复，略 N 行 M 字…」（不切行、语法容器整块进出、带 offset 可还原）`,
    /** @param {Array<{role:string,content:string}>} B_msgs  B 片（**只读，不改原对象**） */
    /** @param {string} ref  参考串：第 1 轮＝真 A1；之后＝上一轮本链自己算出来的 T */
    apply(B_msgs, ref) {
        const R = String(ref ?? '');
        const msgs = [];
        let cover = 0, n = 0, ptrChars = 0;
        for (const m of (B_msgs || [])) {
            const src = String(m?.content ?? '');
            const role = String(m?.role || '');
            if (!src || src.length < MIN) { msgs.push({ role, content: src }); continue; }
            const L = lineSplit(src);
            if (!L.length) { msgs.push({ role, content: src }); continue; }
            const mk = mark(L);
            const out = [];
            let i = 0, hit = 0;
            while (i < L.length) {
                const e = matchAt(L, mk, R, i);
                if (e) {
                    const len = L.slice(i, e.j + 1).reduce((a, x) => a + x.length, 0);
                    const note = noteOf(e.at, len, e.j - i + 1);
                    if (len >= MIN && len - note.length >= NET) {
                        out.push(note);
                        cover += len; n++; ptrChars += note.length; hit++;
                        i = e.j + 1;
                        continue;
                    }
                }
                out.push(L[i]); i++;      // ★ 不重复的行 ⇒ **一个字不动**
            }
            msgs.push({ role, content: hit ? out.join('') : src });
        }
        return { msgs, cover, n, ptr: ptrChars };
    },
});
