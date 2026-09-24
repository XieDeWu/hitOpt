/* ══════════════════════════════════════════════════════════════════════════════════════
 * 实验算法 ②：**整条去重（说人话版）**（`core/expAlgo/ptrExactV2.js`）
 *
 *   算法名：整条去重（可还原）      版本：v2.1
 *   ⚠ 它由 `ptrExact.js`（v1）复制而来；**v1 一个字没动**（留着当对照）。
 *
 * ── 为什么 v2 的 v2.0 版被推翻（用户 2026-09-19 贴出真产物）────────────────────────
 *   用户原话："**继续修改V2 实测无区别**" ＋ 贴出产物 ＋ "**都是模型不可读信息**"
 *   他贴的是 v2.0 的真产物，长这样：
 *     4331<HASH-17CE0/02C><HASH-13E27/119><HASH-0BB4E/025>环境/经过天数","value":0},
 *         <HASH-0BB69/01C>user/体力","value":85},<HASH-0BB69/01C>user/状态","value":"正常"},
 *     4335<HASH-A27409 name="杰哥推开询问室的门。沈青坐在金属"/><HASH-61BDF…
 *   ── 三条硬伤（都是真的，不是口味问题）──────────────────────────────────────────
 *     ① **结构被切碎**：`"value":85}` 的引号、冒号、花括号都被挖掉换成壳 ⇒ 产物**不是 JSON 了**，
 *        任何解析器、任何模型都读不出"体力 = 85"；
 *     ② **壳比内容还多**：一整行 90% 是 `<HASH-xxxxx/xxx>` ⇒ 人看是噪音，模型看是未知符号；
 *     ③ **可还原救不了可读性**：壳里带 offset/len ⇒ **人和工具**能摊平，但**模型不能去查** ——
 *        用户的判断"都是模型不可读信息"完全正确。
 *   ── 犯错的根：在**字符流**里乱挖洞 ───────────────────────────────────────────────
 *     v2.0 沿用了 v1 的"从左到右贪心取最长匹配"⇒ 它眼里没有"消息""JSON 字段"这些**结构**，
 *     只有一串字节 ⇒ 必然把语法骨架一起切掉。
 *
 * ── v2.1 的规矩（三条，缺一不可）────────────────────────────────────────────────
 *     ① **只在消息边界上做**：一条消息要么整条处理、要么**一个字不动**
 *        ⇒ 绝不切碎 JSON/正文的语法骨架（这一条直接把上面三条硬伤全部消灭）；
 *     ② **省略要说人话**：省掉的整条换成一句**人能读懂、模型也能读懂**的说明：
 *          【与上文重复，略 N 字：上文第 <offset> 字起】
 *        —— 模型读到它知道"这里有一段与前文逐字相同的内容被略去了"（v1 的 `<HASH-E0001/>`
 *           它无从理解）；offset 是给工具/人**还原**用的（`expand()` 一行摊平）；
 *     ③ **只省真正重复的整条**：判据是"这条消息的正文在参考串里**逐字节出现过**"
 *        ⇒ 省掉它**不丢信息**（同一份提示词里前面就有，官方缓存也正是按前缀算钱的）。
 *
 * ── 代价（如实写在最前面，不粉饰）──────────────────────────────────────────────
 *   整条级的可省量**远小于**字符级挖洞：v1 每轮省 ~3 万字，v2.1 只能省"整条重复"的那部分，
 *   实测见 `tools/algo_iter.mjs` 的两条链对照。**这是"可读性"与"省 token"的零和**：
 *   要在字符流里多省，就必然切碎结构 ⇒ 那就退回"模型不可读"。用户要的是可读，所以按可读的做。
 *
 * ── 它只动 B（结构保证，与 v1 同）────────────────────────────────────────────────
 *   签名 `apply(B_msgs, ref)` —— A 与 C **根本没传进来**（用户指令 A 的落地方式：
 *   不是"算法自觉不动"，而是**够不到**）。
 * ══════════════════════════════════════════════════════════════════════════════════════ */
import { register } from './registry.js';

const MIN = 24;        // 短于它的整条不值得省（说明句本身也要几十字）
const TAIL = 24;       // 说明句里回显原条开头多少字（给人和模型一个抓手）

/** 省略句：**人能读懂、模型也能读懂、工具能还原** */
function noteOf(off, len) {
    return `【与上文重复，略 ${len} 字：上文第 ${off} 字起】`;
}

/** 找 `s` 在 `ref` 里第一次出现的位置（整条判据就用它；找不到 ⇒ -1） */
function findIn(s, ref) {
    if (!s || !ref) return -1;
    return ref.indexOf(s);
}

/** ★ 可还原：把省略句换回原文（拿这一轮的参考串就能摊回原样）
 *  @returns {{text:string, n:number, miss:number}} 摊平后的文本 / 还原了几句 / 几句对不上 */
export function expand(text, ref) {
    const R = String(ref ?? '');
    let n = 0, miss = 0;
    const out = String(text ?? '').replace(/【与上文重复，略 (\d+) 字：上文第 (\d+) 字起】/g, (m, l, o) => {
        const len = Number(l), off = Number(o);
        if (!Number.isFinite(len) || !Number.isFinite(off) || off + len > R.length) { miss++; return m; }
        n++;
        return R.substr(off, len);
    });
    return { text: out, n, miss };
}

register({
    id: 'ptr-exact-v2',
    name: '整条去重（可还原）',
    version: 'v2.1',
    desc: `只在**消息边界**上省：整条正文在参考串里逐字节出现过 ⇒ 换成一句「与上文重复，略 N 字…」`
        + `（说人话、不切碎结构、带 offset 可还原）；不重复的整条一个字不动`,
    /** @param {Array<{role:string,content:string}>} B_msgs  B 片（**只读，不改原对象**） */
    /** @param {string} ref  参考串：第 1 轮＝真 A1；之后＝上一轮本链自己算出来的 T */
    apply(B_msgs, ref) {
        const R = String(ref ?? '');
        const msgs = [];
        let cover = 0, n = 0, ptrChars = 0;
        for (const m of (B_msgs || [])) {
            const src = String(m?.content ?? '');
            const at = (src.length >= MIN) ? findIn(src, R) : -1;
            if (at >= 0) {
                const note = noteOf(at, src.length);
                /* ⚠ 说明句比原文还长就不换（省不了反而多花）—— 短整条走这一支 */
                if (note.length < src.length) {
                    n++; cover += src.length; ptrChars += note.length;
                    msgs.push({ role: String(m?.role || ''), content: note });
                    continue;
                }
            }
            msgs.push({ role: String(m?.role || ''), content: src });   // ★ 不重复 ⇒ **一个字不动**
        }
        return { msgs, cover, n, ptr: ptrChars };
    },
});
