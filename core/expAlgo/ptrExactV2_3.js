/* ══════════════════════════════════════════════════════════════════════════════════════
 * 实验算法 ④：**最大公共子串**（`core/expAlgo/ptrExactV2_3.js`）
 *
 *   算法名：最大公共子串      版本：v2.3
 *   ⚠ 它是**新写的**（不是复制 v2.2 改的）；v1 / v2.1 / v2.2 **一个字没动**，四份并排当对照。
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
 *   ④ **加壳**：每段换成 `<HASH-XXXXXX>原段开头 32 字…略 N 字</HASH-XXXXXX>`
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

const MIN = 300;          // ★ 用户定版："至少300字公共长"
const BASE = 1000003;     // 滚动哈希基数
const CAP = 32;           // 同一哈希下最多验几个落脚点（哈希碰撞的兜底，不影响正确性）

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
 *  现在的壳：`<HASH-88ABEC>世界观总纲: 舞台: 长夜都，中国滨海巨城。2067年近未来…略 4937 字</HASH-88ABEC>`
 *    · `HASH-XXXXXX` = **省略段自身内容的哈希**（同一段内容在任何地方都是同一个哈希
 *      ⇒ "哈希相同就是同一段字"这句话是**可验证**的，模型也能拿它去上文对照）；
 *    · 标签之间 = **一句人话**：`原文开头（HEAD 字）…略 N 字`
 *      —— 回显 + 省略字数**连起来读就是一句话**，不拆进任何属性里
 *      （用户 2026-09-19："**别这样写 你还不如...后面写略 2330 字**"）。
 *  ⚠ 开闭标签都**不带属性**：属性形状既啰嗦、又让模型可能学着照写；
 *    哈希已经把首尾钉在一起了。 */
const HEAD = 32;
const isWs = (c) => (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c || c === 0x3000 || c === 0xa0);

/** 回显用的抓手：段的前 HEAD 字，换行/连续空白压成一个空格（**壳必须是一行**）；
 *  ⚠ 尖括号一律剥掉 —— 壳里冒出半个 `<` 会把后面的字当成标签吃掉（这个坑在超链接那回踩过）。 */
function headOf(s) {
    return String(s).slice(0, HEAD).replace(/[\s\u3000]+/g, ' ').replace(/[<>]/g, '').trim();
}

/** 省略段内容的哈希（FNV-1a 32 位取低 24 位）⇒ 6 位大写十六进制，与主算法同宽 */
function hash6(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ((h >>> 8) & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
}

function noteOf(seg, len) {
    const h = hash6(seg);
    return `<HASH-${h}>${headOf(seg)}…略 ${len} 字</HASH-${h}>`;
}

/** ★ 可还原：把壳换回原文（拿这一轮的参考串就能摊回原样）
 *  ⚠ 定位靠的是**标签之间那段回显**（不是坐标）：拿回显里第一个非空片段去参考串里找。
 *    段的头在建段时已经剥掉前导空白 ⇒ 回显的第一个字就是段的第一个字 ⇒ 定位点是准的。 */
export function expand(text, ref) {
    const R = String(ref ?? '');
    let n = 0, miss = 0;
    const out = String(text ?? '').replace(/<HASH-([0-9A-F]{6})>([^<]*)…略 (\d+) 字<\/HASH-\1>/g, (m, h, head, l) => {
        const len = Number(l);
        const key = String(head).split(' ').filter((x) => x.length >= 4)[0] || '';
        const at = key ? R.indexOf(key) : -1;
        if (!Number.isFinite(len) || len <= 0 || at < 0 || at + len > R.length) { miss++; return m; }
        n++;
        return R.substr(at, len);
    });
    return { text: out, n, miss };
}

/** 32 位滚动哈希的权：BASE 的 W−1 次方（模 2^32） */
function powOf(W) { let p = 1; for (let k = 0; k < W - 1; k++) p = Math.imul(p, BASE); return p; }

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
 *  @returns {Array<{s:number,e:number,p:number}>} B 的 [s,e) ↔ A 的 p 起（逐字节相同） */
function segsOf(A, B, W) {
    const out = [];
    const na = A.length, nb = B.length;
    if (nb < W || na < W) return out;
    const pow = powOf(W);
    const idx = buildIndex(A, W, pow);
    if (!idx.size) return out;
    const hashAt = (i) => { let x = 0; for (let k = 0; k < W; k++) x = (Math.imul(x, BASE) + B.charCodeAt(i + k)) | 0; return x; };
    let i = 0;
    while (i + W <= nb) {
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
            /* ⚠ 段的头从**第一个非空白字符**开始：省掉开头的空白没有任何意义，
             *   而且会让壳里的回显以空格开头（壳失真、还原也定位不准）。 */
            let s = i, e = i + bestLen;
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
    id: 'ptr-exact-v2.3',
    name: '最大公共子串',
    version: 'v2.3',
    desc: `字符级：把 A 每处 300 字窗口建成哈希索引，扫 B 时逐字真比较、向右扩到最长`
        + ` ⇒ 取出 B 在 A 中**所有极大公共子串**（≥300 字），每段换成 `
        + `<HASH-XXXXXX>原段开头…略 N 字</HASH-XXXXXX>（壳里是一句人话，坐标不进壳）`,
    /** @param {Array<{role:string,content:string}>} B_msgs  B 片（**只读，不改原对象**） */
    /** @param {string} ref  参考串：第 1 轮＝真 A1；之后＝上一轮本链自己算出来的 T */
    apply(B_msgs, ref) {
        const R = String(ref ?? '');
        const list = (B_msgs || []).map((m) => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
        let cover = 0, n = 0, ptrChars = 0;
        if (!list.length || !R) return { msgs: list, cover, n, ptr: ptrChars };
        /* B 拼成整串再找 —— 用户要的是"B 在 A 中所有的最大公共子串"，B 是**整片**，不是一个一个条 */
        const spans = [];
        let off = 0;
        for (const m of list) { spans.push([off, off + m.content.length]); off += m.content.length + 1; }   // +1 = join 的换行
        const Btext = list.map((m) => m.content).join('\n');
        const segs = segsOf(R, Btext, MIN);
        if (!segs.length) return { msgs: list, cover, n, ptr: ptrChars };
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
            let out = '', cur = s0;
            for (const c of cuts) {
                out += m.content.slice(cur - s0, c.s - s0);
                const note = noteOf(Btext.slice(c.s, c.e), c.e - c.s);
                out += note;
                cover += c.e - c.s; n++; ptrChars += note.length;
                cur = c.e;
            }
            out += m.content.slice(cur - s0);
            return { role: m.role, content: out };
        });
        return { msgs, cover, n, ptr: ptrChars };
    },
});
