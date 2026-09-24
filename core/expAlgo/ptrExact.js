/* ══════════════════════════════════════════════════════════════════════════════════════
 * 实验算法 ①：**精确匹配 ＋ 字节区间指针化**（`core/expAlgo/ptrExact.js`）
 *
 *   算法名：精确匹配指针化        版本：v1
 *
 * ── 干什么 ──────────────────────────────────────────────────────────────────────
 *   在**参考串** `ref` 上建 `W` 字窗口索引；在 `B` 上从左到右贪心找**最长匹配**，
 *   匹配长度 ≥ `MIN` 就把这一段换成 `<HASH-XXXXXX/>` 指针；否则原样出一个字节。
 *   产物只有 B 变短。
 *
 * ── 它只动 B（结构保证）──────────────────────────────────────────────────────────
 *   签名 `apply(B_msgs, ref)` —— **A 和 C 根本没传进来**。这是用户指令 A
 *   （"装配行为只涉及B区，A区别动，C区一直保真"）的落地方式：
 *   不是"算法自觉不动"，而是**够不到**。
 *
 * ── 为什么指针用 `<HASH-XXXXXX/>` 这个形态 ────────────────────────────────────────
 *   与 Horae 现机制（`_amPtr` / `_amAddrRecall`）**同一个壳**，模型已经认识它、
 *   面板与差异页也认它 ⇒ 换成别的壳会变成"第二套指针语法"。
 *
 * ── 参数（改这里就是换档）────────────────────────────────────────────────────────
 *   `W = 12`  索引窗口（字）—— 越小越能抓短重复，但索引越大越慢
 *   `MIN = 24` 最短引用（字）—— 短于它的不换（指针本身 15 字，划不来）
 *
 * ── 复杂度 ──────────────────────────────────────────────────────────────────────
 *   建索引 O(|ref|)；扫描 O(|B| × 每窗口候选数≤4 × 平均匹配长)。索引**每轮只建一次**
 *   —— ⚠ 这一条是踩过坑写下来的：第一版把建索引写进了扫描循环里 ⇒ 每走一个字节重建
 *     一次 28 万字索引（O(n²)）⇒ 探针跑 10 秒超时。用户原话：
 *     "工具调用时间超10s 说明你没做优化也没做并行化"。
 * ══════════════════════════════════════════════════════════════════════════════════════ */
import { register } from './registry.js';

const W = 12;      // 索引窗口（字）
const MIN = 24;    // 最短引用（字）
const CAND = 4;    // 每个窗口最多记几个候选位置（控时间）

/** 建窗口索引（**一次建、反复用**） */
function buildIdx(s) {
    const idx = new Map();
    for (let i = 0; i + W <= s.length; i++) {
        const k = s.substr(i, W);
        let a = idx.get(k);
        if (!a) { a = []; idx.set(k, a); }
        if (a.length < CAND) a.push(i);
    }
    return idx;
}

/** 把 `B` 里"在 `ref` 中逐字节出现过（≥MIN 字）"的段换成指针 */
function point(B, ref) {
    if (!B || !ref || B.length < MIN) return { out: B, cover: 0, n: 0 };
    const idx = buildIdx(ref);
    let out = '', i = 0, cover = 0, n = 0;
    while (i < B.length) {
        let best = 0;
        if (i + W <= B.length) {
            const a = idx.get(B.substr(i, W));
            if (a) for (const p of a) {
                let l = W;
                while (i + l < B.length && p + l < ref.length && B[i + l] === ref[p + l]) l++;
                if (l > best) best = l;
            }
        }
        if (best >= MIN) {
            n++;
            out += `<HASH-${(0xE0000 + n).toString(16).toUpperCase().slice(-6)}/>`;
            cover += best; i += best;
        } else { out += B[i]; i++; }
    }
    return { out, cover, n };
}

register({
    id: 'ptr-exact',
    name: '精确匹配指针化',
    version: 'v1',
    desc: `在参考串上建 ${W} 字窗口索引，B 上贪心取最长匹配，≥${MIN} 字换成 <HASH-XXXXXX/>`,
    /** @param {Array<{role:string,content:string}>} B_msgs  B 片（**只读，不改原对象**） */
    /** @param {string} ref  参考串：第 1 轮＝真 A1；之后＝上一轮本链自己算出来的 T */
    apply(B_msgs, ref) {
        const msgs = [];
        let cover = 0, n = 0, ptrChars = 0;
        for (const m of (B_msgs || [])) {
            const src = String(m?.content ?? '');
            const z = point(src, ref);
            cover += z.cover; n += z.n;
            ptrChars += z.out.length - (src.length - z.cover);   // 指针壳占的字数
            msgs.push({ role: String(m?.role || ''), content: z.out });
        }
        return { msgs, cover, n, ptr: ptrChars };
    },
});
