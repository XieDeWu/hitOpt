/**
 * Horae 出网抓包（wiretap）v5 —— **只读**，不改任何请求。
 *
 * v1 为什么没抓到：酒馆后端不是用全局 fetch，而是 `import fetch from 'node-fetch'`
 * （`src/endpoints/backends/chat-completions.js:5`）—— 包一层 `globalThis.fetch` 对它无效。
 *
 * v2 改在**传输层**抓：包 `https.request` / `http.request`（node-fetch、axios、undici…
 * 最后都得走这两个）。**不认模型、不认网址、不认厂商**，只看请求长什么样：
 * 是 POST 且 body 里带 `"messages"` / `"contents"` / `"prompt"` / `"input"` 的就落盘。
 *
 * 落盘（原文，不做任何重新序列化）：
 *   <本插件目录>/captures/<yyyy-mm-dd>/<seq>-<时间>-<聊天>.txt
 *   同名 .meta.json：{ at, host, path, model, n, bytes, sha256, chatKey }
 *
 * ★ v3 起认清一件事：`X-Horae-Chat` 那个标注头**到不了传输层**（酒馆后端给上游拼的 header
 *   是写死的 `{Content-Type, Authorization}`，实测 `sendDeepSeekRequest`），所以 `chatKey`
 *   恒为 `unknown` —— 谁要用谁**按时间窗**取，别按聊天认。
 * ★ v4：`/latest?since=<ms>` 时间窗 + 形状校验（条数 / 正文总长），宁可不给也不给错一份。
 * ★ v5：形状校验从"**必须相等**"放宽成"**只挡明显不是这一轮的**"。
 *   为什么必须放宽（v6.24.38 实测的真凶之一）：酒馆后端出网前会把条目**并起来**
 *   （实测客户端 31~35 条 → 出网 4~6 条；正文 34,057 字那份快照 → 出网是并过的形状），
 *   所以"出网份比本地快照**少**条、正文**更短**"是**正常形状**。原来那两条
 *   （`n !== expectMsgs` / `chars < minChars`）会把真实场景里**每一轮**都判成"不是同一轮"
 *   ⇒ 出网原文永远取不回来，记录里永远只有本地快照
 *   （实测：三份抓包都好好躺在盘上，三份记录却都写着「本地快照（没抓到出网原文）」）。
 *   现在只挡两条：① 出网份比本地快照**还多**条；② 出网正文不到本地快照的**三成**。
 * ★ v6（v6.24.39）：**聊天钥匙从"门"降成"偏好"**。
 *   前端每一轮都带 `?chat=<真钥匙>` 来问，而文件名恒为 `unknown`（见上面 v3 那条），
 *   老代码 `if (key && !files[i].includes(key)) continue;` ⇒ **每一份都被跳过**、每一轮都 `ok:false`。
 *   实测：不带 `chat` 问同一条路由当场 `ok:true`（同一时刻、同一份文件），带上就 `ok:false`
 *   —— 这就是"抓包抓到了、面板上却永远写着没抓到"的最后一环。
 *   现在先按钥匙找、找不到就退回只按时间窗，并把这件事写进 `note`；
 *   失败时还附 `newest`（盘上最新那份的时刻与文件名）+ `hint`，不让人对着"没抓到"猜。
 * 抓不到、写不了 —— 全部吞掉，绝不影响请求本身。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import url from 'node:url';

export const info = {
    /* ★ 2026-09-24【合并】本模块**不再是独立服务端插件** —— 它由 `hitopt-git/index.mjs`
     *   在 `init()` 里 import 进来、挂到 `/api/plugins/hitopt-git/tap/…` 上。
     *   为什么要合并（用户："**没有horae-wiretap，只有hitopt**" ＋ "安装这么麻烦 谁家还要手动的"）：
     *   服务端从**两个插件目录**收成**一个** ⇒ 别人 clone 一次就装完，不用第二次手动拷。
     *   ⚠ 这个 info 现在没有 loader 读它了，留着只为日志与自检能认人。 */
    id: 'hitopt-git',
    name: 'hitOpt 出网抓包（只读）',
    description: '把模型真正收到的那份 request body 原样落盘，供 hitOpt 核对"我们记的 == 发出去的"。',
};

/** ★ 2026-09-24【合并】：抓包自己的版本号**导出**出来 —— 记录服务（`index.mjs` 的 `attachRes`）
 *  原来是**走 HTTP** 问 `/api/plugins/horae-wiretap/status` 拿这个数的，而那个地址里
 *  **写死了 `127.0.0.1:8000`**（换端口 / 远程访问就废）。现在同进程同模块 ⇒ 直接 import 读。
 *  ⚠ 改了抓包行为就把它 +1（它出现在面板与自检的"抓包 vN"里）。 */
export const WIRE_V = 8;

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
/** 落盘根目录。★ v3：可用 `HORAE_WIRETAP_ROOT` 覆盖 —— **自测必须指到临时目录**。
 *  为什么加这一条：抓包自测原来直接写（并且会先清空）生产用的 captures/，一次自测就把抓到的
 *  真出网原文连锅端了（实测踩到：5 份真 request 被自测删掉，无法找回）。 */
const OUT_ROOT = process.env.HORAE_WIRETAP_ROOT
    ? path.resolve(String(process.env.HORAE_WIRETAP_ROOT))
    : path.join(HERE, 'captures');
const MAX_PER_DAY = 300;
let seq = 0;

/** ★ v4：按**时间窗**取回出网原文（给 Horae 用）。
 *
 *  为什么不是按聊天 key 认：抓包在**传输层**，它看见的那一跳是酒馆后端 → 上游厂商。
 *  酒馆后端给上游拼的 header 是写死的 `{Content-Type, Authorization}`（`sendDeepSeekRequest`
 *  实测），**浏览器那一跳的 `X-Horae-Chat` 标注头根本传不到这里** —— 所以 meta 里永远只有
 *  `chatKey: "unknown"`，Horae 拿聊天 key 来问必然问不到（实测：19:32/19:33 两轮真抓到了，
 *  Horae 却仍写"没抓到出网原文"）。
 *
 *  改成时间窗认：Horae 在**同一轮**的记录提交里带上"这一轮是什么时候开始量的"，
 *  抓包按 mtime ≥ since（减一点余量）取最新那一份 —— 同一时刻只可能有一轮在发请求。
 *  再拿 `expectMsgs` / `minChars` 做形状校验（条数、正文总长至少要够），宁可不给也不给错一份。
 *
 *  仍然只在 `captures/<今天>/` 里找 `.txt`，仍然读盘（不引内存）。
 */
function latestCapture(opts = {}) {
    try {
        const day = new Date().toISOString().slice(0, 10);
        const dir = path.join(OUT_ROOT, day);
        if (!fs.existsSync(dir)) return null;
        // 跨零点兜底：今天这一份没有就再看昨天（北京时间与 UTC 差 8 小时，抓包目录按 UTC 分）
        const dirs = [dir];
        const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const ydir = path.join(OUT_ROOT, y);
        if (ydir !== dir && fs.existsSync(ydir)) dirs.push(ydir);

        const since = Number(opts.since) || 0;
        const key = String(opts.chatKey || '');
        const expectMsgs = Number(opts.expectMsgs) || 0;
        const minChars = Number(opts.minChars) || 0;

        // 扫一遍：`useKey` 为真 → 只认文件名里带聊天钥匙的；为假 → 只按时间窗（最新的那份）。
        const scan = (useKey) => {
            for (const d of dirs) {
                const files = fs.readdirSync(d).filter(f => f.endsWith('.txt')).sort();
                for (let i = files.length - 1; i >= 0; i--) {
                    const p = path.join(d, files[i]);
                    let st;
                    try { st = fs.statSync(p); } catch (_) { continue; }
                    if (since && st.mtimeMs < since) continue;
                    if (useKey && key && !files[i].includes(key)) continue;
                    return { p, st, name: files[i] };
                }
            }
            return null;
        };
        // ★ v6.24.39：**聊天钥匙只当偏好，不当门**（这是"抓包抓到了、前端却永远取不回来"的最后一环）。
        //   实测真凶：抓包在传输层，酒馆后端给上游拼的 header 是写死的 `{Content-Type, Authorization}`
        //   ⇒ `chatKey` 恒为 `unknown`、**文件名里根本没有聊天钥匙**；而这里原来是
        //   `if (key && !files[i].includes(key)) continue;` —— 前端每一轮都带着真钥匙来问，
        //   于是**每一份都被跳过**、每一轮都回 `ok:false`。
        //   实测证据：三份真出网原文好好躺在盘上（20:33:23 / 20:34:31 / 20:38:33，`meta.n=4`），
        //   三轮记录却全写着「本地快照（没抓到出网原文）」；而**不带 `chat` 问同一条路由 → 当场 `ok:true`**。
        //   现在：先按钥匙找（哪天抓包侧真能带上钥匙就自动生效），找不到就**退回只按时间窗**，
        //   并把"钥匙没认出来"写进 `note` —— 不静默、不假装。
        let hit = key ? scan(true) : null;
        let keyMissed = false;
        if (!hit) { hit = scan(false); keyMissed = !!(key && hit); }
        if (!hit) {
            // 失败也要说清"盘上到底有什么"：把最新那份的时刻/文件名如实带回去，
            // 省得对着"没抓到"猜（实测就是这么浪费掉两轮的）。
            const newest = (() => {
                try {
                    let best = null;
                    for (const d of dirs) {
                        for (const f of fs.readdirSync(d).filter(x => x.endsWith('.txt'))) {
                            const st = fs.statSync(path.join(d, f));
                            if (!best || st.mtimeMs > best.at) best = { file: `${path.basename(d)}/${f}`, at: st.mtimeMs };
                        }
                    }
                    return best;
                } catch (_) { return null; }
            })();
            return {
                ok: false,
                error: since
                    ? `这一轮（${new Date(since).toISOString()} 之后）还没有抓到出网原文`
                    : '今天还没有抓到任何出网原文',
                newest,
                hint: newest
                    ? `盘上最新那份是 ${new Date(newest.at).toISOString()}（${newest.file}）—— 早于这一轮的时间窗，不拿它冒充这一轮`
                    : '盘上一份都没有（抓包插件是不是没加载？看酒馆控制台有没有 [hitOpt-wiretap] 那两行）',
            };
        }
        const pick = hit.p, pickStat = hit.st;
        let note = '';

        const body = fs.readFileSync(pick, 'utf8');
        let model = '', n = 0, chars = 0;
        try {
            const j = JSON.parse(body);
            model = String(j?.model || '');
            const arr = Array.isArray(j?.messages) ? j.messages
                : (Array.isArray(j?.contents) ? j.contents : null);
            if (arr) {
                n = arr.length;
                for (const m of arr) {
                    const c = m?.content;
                    if (typeof c === 'string') chars += c.length;
                    else if (Array.isArray(c)) for (const part of c) if (typeof part?.text === 'string') chars += part.text.length;
                }
            }
        } catch (_) { }

        // ── 形状校验（★ v6.24.55：**条数不再是门，只当备注**）────────────────────────────────
        //  为什么又改（这次是埋点实测钉死的，不是推理）：
        //   v6.24.54 拿 `expectMsgs`（客户端"出发那一刻的 messages 条数"）当**下限** ——
        //   立论是"出网只会被并起来、不会变多"，所以 `出网 ≥ 客户端` 才可能是这一轮。
        //   实测（用户新开的场次 `圣樱学院_mu50w125x4j9`，12:37:21 那一轮，客户端埋点原文）：
        //     `assembledLen=37  expectMsgs=37  出网 n=8`
        //   ⇒ 判据当场判假：「最近这份出网原文只有 8 条，比这一轮出发那一刻的 37 条还少 —— 不是这一轮，不给」，
        //     而**那份抓包就落在时间窗里**（抓包 12:37:21.578 / 窗口起点 12:37:20.057）——
        //     真出网原文被自己的判据挡在门外，这一轮于是不写、不提交（用户看到的面板 0 轮）。
        //   教训：`assembled` 是**预演那一刻**酒馆手里的消息数组（37 条，含大量注入/占位条目），
        //     出网那一跳是**酒馆后端并过之后**的形状（8 条）。两边条数根本不同源，
        //     拿它当门就是把正确答案挡掉。**时间窗（mtime ≥ 出发那一刻）才是唯一可靠的判据** ——
        //     同一时刻只可能有一轮在发请求。
        //   ⇒ 现在：不因条数拒绝；把"出网 N 条 / 客户端那一刻 M 条"如实写进 `note`（供人核对，不参与裁定）。
        const shapeNotes = [];
        // ★ v6.24.39：钥匙没认出来（其实是**认不出来**：文件名恒为 unknown）→ 如实写进 note
        if (keyMissed) shapeNotes.push(`抓包侧认不出聊天钥匙「${key}」（传输层拿不到标注头，文件名恒为 unknown）→ 已退回只按时间窗取回`);
        if (expectMsgs && n) shapeNotes.push(`出网 ${n} 条（出发那一刻手上 ${expectMsgs} 条 —— 两者不同源，出网是酒馆后端并过之后的形状，仅供参考）`);
        if (since) shapeNotes.unshift('按时间窗取回');
        note = shapeNotes.join('；');

        return {
            ok: true,
            file: `${path.basename(path.dirname(pick))}/${path.basename(pick)}`,
            at: pickStat.mtimeMs, bytes: Buffer.byteLength(body, 'utf8'),
            sha256: crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'),
            chatKey: key || 'unknown', model, n, chars, note, body,
        };
    } catch (err) { return { ok: false, error: String(err?.message || err) }; }
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) { } }

function prune(dir) {
    try {
        // ★ v7：**请求与响应分开算**。原来这里是 `endsWith('.txt')` ⇒ `.res.txt` 也被算进配额，
        //   两个后果：① 300 份额度被两份文件吃掉（一天实际只留 150 轮）；
        //   ② 排序后先删的可能正是 `.res.txt` —— 那恰好是用户点名"不许动"的**官方返回原文**。
        const reqs = fs.readdirSync(dir).filter(f => f.endsWith('.txt') && !f.endsWith('.res.txt')).sort();
        if (reqs.length <= MAX_PER_DAY) return;
        for (const f of reqs.slice(0, reqs.length - MAX_PER_DAY)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch (_) { }
            try { fs.unlinkSync(path.join(dir, f.replace(/\.txt$/, '.meta.json'))); } catch (_) { }
            // 请求与它的响应**成对删**（只删请求会让 res 变孤儿：再没人按 reqSha 找得到它）
            const resName = f.replace(/\.txt$/, '.res.txt');
            try { fs.unlinkSync(path.join(dir, resName)); } catch (_) { }
            try { fs.unlinkSync(path.join(dir, resName.replace(/\.res\.txt$/, '.res.meta.json'))); } catch (_) { }
        }
    } catch (_) { }
}

function headerOf(headers, name) {
    try {
        if (!headers) return '';
        if (typeof headers.get === 'function') return String(headers.get(name) || '');
        for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) return String(headers[k] || '');
    } catch (_) { }
    return '';
}

function save(host, p, bodyStr, headers) {
    try {
        const day = new Date().toISOString().slice(0, 10);
        const dir = path.join(OUT_ROOT, day);
        ensureDir(dir);
        // ★ v6.24.55：`x-horae-chat` 那个标注头**到不了传输层**（酒馆后端给上游拼的 header 是写死的
        //   `{Content-Type, Authorization}`），所以这里**永远**只能拿到 'unknown' —— 用户直接点名过：
        //   "后台的这里 unknown 小 bug 修一下"。
        //   修法（不猜、不编聊天名）：拿**请求体自己的内容指纹**当标识 —— 同一场聊天、同一份提示词
        //   → 同一个指纹，于是"哪些抓包属于同一场"一眼可辨；不同聊天/不同轮次天然区分。
        //   ⚠ 它**不参与任何判定**（取回仍然只按时间窗），只是一个可读、可追溯的标签：
        //     文件名与 meta 里从 `unknown` 变成一个稳定的 `req-<8位>`。
        const headerKey = headerOf(headers, 'x-horae-chat');
        const bodyHash = crypto.createHash('sha256').update(Buffer.from(String(bodyStr || ''), 'utf8')).digest('hex');
        const chatKey = headerKey || `req-${bodyHash.slice(0, 8)}`;
        const safeKey = String(chatKey).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80) || 'unknown';
        seq += 1;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = `${String(seq).padStart(4, '0')}-${stamp}-${safeKey}`;
        const file = path.join(dir, base + '.txt');
        fs.writeFileSync(file, bodyStr, 'utf8');          // ★ 原文，不重新序列化
        let model = '', n = 0;
        try {
            const j = JSON.parse(bodyStr);
            model = String(j?.model || j?.model_name || '');
            n = Array.isArray(j?.messages) ? j.messages.length : (Array.isArray(j?.contents) ? j.contents.length : 0);
        } catch (_) { }
        fs.writeFileSync(file.replace(/\.txt$/, '.meta.json'), JSON.stringify({
            at: Date.now(), when: new Date().toISOString(), host, path: p, model, n,
            bytes: bodyStr.length, sha256: bodyHash,
            chatKey, file: base + '.txt',
        }, null, 2), 'utf8');
        console.log(`[hitOpt-wiretap] 抓到出网请求 ${host}${p} → ${base}.txt（${bodyStr.length} 字节 / ${n} 条 / model=${model || '?'} / 请求标识=${safeKey}）`);
        prune(dir);
        return { base, chatKey, file: base + '.txt', bodyHash };
    } catch (err) {
        console.warn('[hitOpt-wiretap] 落盘失败（不影响请求）:', err?.message || err);
    }
}

/** 这个 body 像不像"发给模型的提示词" —— 不认模型/网址，只看形状 */
function looksLikePrompt(body) {
    if (typeof body !== 'string' || body.length < 40) return false;
    const t = body.trimStart();
    if (!t.startsWith('{')) return false;
    return /"(messages|contents|prompt|input)"\s*:/.test(body);
}

/** ══════════════════════════════════════════════════════════════════════════════
 * ★★★★★★ v6（2026-09-19）【服务器**返回**也存档】—— 用户原话："服务器的返回也是要存档记录的，你现在没存！"
 *
 *  实测根因（盘上数出来的）：`captures/` 里 `-req-` 文件 **658 个**、`-res-` **0 个** ——
 *  `wrap()` 只包了 `req.write` / `req.end`（发出去的方向），**响应流一个字节都没接**。
 *  ⇒ 官方那三个数（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `completion_tokens`）
 *    只在内存里被解析一次、用完就没了；盘上只剩 Horae 自己抄进 `usage.json` 的那三个数，
 *    **官方原始响应体没有任何存档** ⇒ 对不上账时无从复核（也不能事后重算费用）。
 *
 *  现在：与请求**同序同名**落盘 —— `<四位数>-<时间>-<键>.res.txt`（响应原文，逐字节）
 *  ＋ `.res.meta.json`（**从原文里抽出来的 usage 等字段**，一眼可读）。
 *  · 流式（SSE / `data: {...}` 分片）与一次性 JSON 都认；
 *  · `usage` 可能出现在 SSE 最后一个 chunk，也可能在非流式响应的顶层 ⇒ 两处都找；
 * ══════════════════════════════════════════════════════════════════════════════
 * ★★★★★★ v7（2026-09-19）【删掉"超长截尾" —— 原文一个字节都不许改】
 *  用户原话（对着 `turns/00002.res.txt` 第 15 行那行红圈截的图）：
 *      "我曹尼玛 你是这样给我记录官方的返回的？ ！原！始！文！件！！ 你踏马给我改原始文件 找死啊"
 *  盘上的罪证（这一场 `圣樱学院_mu8byex8oudg`）：`00002.res.meta.json` 写着 bytes 1168544
 *  与 truncated true，而 `.res.txt` 真身只有 22000 字 加 一行 `…【中间省略 1146544 字】…`
 *  ⇒ 1,146,544 个字节的官方返回**永久没了**；更糟的是 `status.json` 还写着 state present，
 *  注 "抓包插件落的那份响应（1168544 字节）" —— **状态在替我撒谎**。
 *  ⚠ 当初那条取舍（"几百 KB 太长，留头尾就够看 usage 了"）**是错的**：usage 早在
 *  `extractUsage()` 里单独抽进 `.res.meta.json` 了，**没有任何理由动原文**。
 *  体积大是另一件事（要解决就另存派生文件），**绝不许拿原文开刀**。
 *  ⇒ v7 起：`saveRes` 逐字节写 String(text)，**没有任何 slice 与省略与美化**；
 *    bytes 改成**真落盘**的字节数（老记录那个数是被截之前的，所以对不上）；
 *    另加如实字段 recvBytes（收到多少）与 sha256（原文指纹，与 ver.json 的 res返回 可交叉验）。
 * ══════════════════════════════════════════════════════════════════════════════ */
/* ★★★★★★ v8【真凶在这里 —— 只扫首尾，不再整串 split ＋ 逐行 JSON.parse】
   用户 2026-09-19："官方的流返回api 我们的存盘太吃IO了 电脑很卡
   需要先内存暂存，若持续3s没有增长则才存盘并标记成败"
   ── 盘上量出来的真凶（`captures/2026-09-19/0001-…-req-b3f9b640.res.txt`）：
      **一轮的模型返回 = 7,744,534 字节**，而同一轮的请求只有 169,135 字节 ⇒ **响应是请求的 45 倍**
      （reasoning 量）。旧实现把这 7.7 MB 整串 `split('\n')` 成 **约 28 万行**，
      再对**每一行** `JSON.parse`，并把解析出来的**14 万个对象全留在数组里** —— 只为了最后那一个
      带 usage 的 chunk。这是在酒馆主线程上、落盘那一刻的同步 CPU ＋ 几十 MB 临时对象。
      ⚠ 我一开始以为是"每个 chunk 都做 Buffer→String"那条路，**基准实测把它排除了**
        （1.1 MB / 2 万段：逐块解码 4 ms、`split('\n')` 1 ms，逐字节相同）—— 真凶不在那儿。
   ── 新实现：**全文只走一遍 `Buffer.indexOf` 数行（不解码、不 split、不 parse）**，
      再把**头部 64 KB** 与**尾部 256 KB** 解码出来 parse —— 目标那四个字段的位置是**结构决定**的：
        · `model` / `id` 取**第一个**非空的 ⇒ 一定在**第一个 chunk**里 ⇒ 头部窗口够；
        · `finish` / `usage` **后到覆盖先到** ⇒ 一定在**最后一个 chunk**里 ⇒ 尾部窗口够；
        · `dataLines` / `done` 靠全文扫（`Buffer.indexOf`，原生、不解码）。
      ⇒ 与旧实现**逐字段等价**（由 `check/wiretap_stream_test.mjs` 在 7.7 MB 真构造上对拍证明），
        而要 parse 的从 14 万个 chunk 降到**几百个**。
   ⚠ `text` 收 **Buffer 也收字符串**：落盘那一刻手里就是 Buffer（零解码），这里只解码首尾两小段。 */
const SCAN_HEAD = 65536;      // 头部窗口：model / id 在这里
const SCAN_TAIL = 262144;     // 尾部窗口：finish / usage / [DONE] 在这里

/** 把一段 chunk 里的四个字段并进结果（**后到的覆盖先到的**，与旧实现一字不差） */
function applyChunk(out, g) {
    if (!g || typeof g !== 'object') return;
    if (!out.model && g.model) out.model = String(g.model);
    if (!out.id && g.id) out.id = String(g.id);
    const ch = g.choices && g.choices[0];
    if (ch && ch.finish_reason) out.finish = String(ch.finish_reason);
    const u = g.usage || (g.choices && g.choices[0] && g.choices[0].usage);
    if (u && typeof u === 'object') out.usage = u;      // ★ 后到的覆盖先到的（流式里最后一个才带全）
}

function extractUsage(text) {
    const out = { usage: null, model: '', id: '', finish: '', dataLines: 0, sse: false, done: false };
    try {
        const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text || ''), 'utf8');
        const n = buf.length;
        if (!n) return out;
        const head = buf.subarray(0, Math.min(n, SCAN_HEAD)).toString('utf8');
        const tail = buf.subarray(Math.max(0, n - SCAN_TAIL)).toString('utf8');
        out.sse = /(^|\n)data:\s*\{/.test(head) || /(^|\n)data:\s*\{/.test(tail);
        if (!out.sse) {
            /* 非流式：整串就是一个 JSON。⚠ 这一条**无法只扫首尾**（顶层字段可能在任何位置），
               但非流式响应没有 SSE 那种 7.7 MB 的量级 ⇒ 照旧整串 parse，一个字没改。 */
            try { applyChunk(out, JSON.parse(buf.toString('utf8'))); } catch (_) { }
            return out;
        }
        /* ① 全文数 `data:` 行 —— 只用 Buffer.indexOf 前进，**不建行数组、不 parse** */
        let pos = 0;
        while (pos < n) {
            let e = buf.indexOf(10, pos);                       // '\n'
            if (e < 0) e = n;
            let p = pos;
            while (p < e && (buf[p] === 32 || buf[p] === 9)) p++;   // 行首空白（与旧的 ln.trim() 同口径）
            if (e - p >= 5 && buf[p] === 100 && buf[p + 1] === 97 && buf[p + 2] === 116 && buf[p + 3] === 97 && buf[p + 4] === 58) {
                let b = p + 5;
                while (b < e && (buf[b] === 32 || buf[b] === 9)) b++;   // `data:` 后面的空白
                if (b >= e) { /* 空 body：旧实现 continue，不计数 */ }
                else if (e - b === 6 && buf.toString('utf8', b, e) === '[DONE]') out.done = true;
                else out.dataLines++;
            }
            pos = e + 1;
        }
        /* ② 只 parse 首尾两个窗口里的 chunk（顺序：头 → 尾 ⇒ "后到覆盖先到"与旧实现同向） */
        for (const win of [head, tail]) {
            for (const ln of win.split('\n')) {
                const s = ln.trim();
                if (!s.startsWith('data:')) continue;
                const body = s.slice(5).trim();
                if (!body || body === '[DONE]') continue;
                try { applyChunk(out, JSON.parse(body)); } catch (_) { }
            }
        }
    } catch (_) { }
    return out;
}

function saveRes(reqInfo, text, opt) {
    try {
        if (!reqInfo || !reqInfo.base) return;
        const day = new Date().toISOString().slice(0, 10);
        const dir = path.join(OUT_ROOT, day);
        ensureDir(dir);
        // ★★★★★★ v7【原文一个字节都不许改】—— 用户 2026-09-19 点名的那条红线。
        //   这里**没有** slice、**没有**省略标记、**没有**任何美化/重排。
        //   收到什么就写什么（SSE 的 `data: …` 行原样、换行原样、结尾原样）。
        const body = Buffer.isBuffer(text) ? text : Buffer.from(String(text || ''), 'utf8');
        // ⚠ `!!` 不能省：`opt` 缺省时 `opt && …` 得到的是 `undefined`，
        //   而 `JSON.stringify` 会把值为 undefined 的键**整条丢掉** ⇒ meta 里根本没有 overCap。
        //   （本测试第一版就是这么抓到自己的：断言 `overCap === false` 红了。）
        const o = opt || {};
        const overCap = (o.overCap === true);             // 收的时候就超了内存上限 ⇒ 尾部没接住（如实标出）
        const file = path.join(dir, reqInfo.base + '.res.txt');
        const info = extractUsage(body);                  // ★ v8：喂 Buffer（只解码首尾两小段）
        const meta = {
            at: Date.now(), when: new Date().toISOString(), host: reqInfo.host, path: reqInfo.path,
            chatKey: reqInfo.chatKey, reqFile: reqInfo.file, resFile: reqInfo.base + '.res.txt',
            // ★★★★★★ v6.27.0【三件套之 ③ 的匹配键】= **那一轮 POST body 的 sha256**（与 Horae
            //   记录里 `turns/NNNNN.txt` 的 sha256 是同一个值）⇒ 服务端 `attachRes()` 靠它把
            //   "模型返回"补进**同一轮**的记录里。**不靠时间窗、不靠轮号**（那两种都会认错轮）。
            reqSha: String(reqInfo.reqSha || ''),
            /* ★ v8【bytes 口径更正】用户点名要"真正的字节数"这件事一直没做到：
               v7 及以前这里写的是 `body.length`，而 `body` 是 **JS 字符串** ⇒ 那是 **UTF-16 码元数**，
               中文正文下与真字节数差 3 倍（一个汉字 1 个码元 / 3 个字节）。
               现在手里本来就是 Buffer ⇒ `bytes` = **真落盘的 UTF-8 字节数**，`chars` = 解码后的码元数。
               ⚠ 判据仍是 `sha256`（下面那一行），`bytes` 只用于显示与粗估 —— 换了口径不影响对账。 */
            bytes: body.length,
            /* ⚠ `recvBytes` 一度被我删掉（理由：它与 `bytes` 是同一个数 —— 老代码两个字段写的都是
               `String(text).length`）⇒ `res_verbatim_test` 当场红了一条「recvBytes = 收到的字节数」。
               **加回来**：盘上老记录里一直有它，删字段等于改了一个没人授权改的对外形状。
               现在它与 `bytes` 同值（都是收到的 UTF-8 字节数）—— 冗余，但**兼容**。 */
            recvBytes: body.length,
            chars: body.toString('utf8').length,
            sha256: crypto.createHash('sha256').update(body).digest('hex'),
            // ★ v7：truncated 从此**恒 false** —— 这一版不再截断任何原文。
            //   老记录里的 `truncated: true` 是"旧版把中间省略了"的**罪证**，服务端据此标 partial。
            truncated: false,
            overCap, sse: info.sse, done: info.done, dataLines: info.dataLines,
            model: info.model, id: info.id, finish: info.finish,
            /* ★★★★★★ v8【落盘时机与成败 —— 用户点名"若持续3s没有增长则才存盘并标记成败"】
               `why`  = 按哪条路结算的（`idle` 每段续期后静默 / `idle-end` 收到 HTTP 收尾 /
                        `idle-close` 连接关了 / `idle-err` 出错 / `idle-reqerr` 请求侧出错 / `exit` 进程退出兜底）
               `sawEnd` = HTTP 响应**正常收尾**（end 事件）—— 与 `done`（见到 `[DONE]`）**是两件事**：
                        流被掐断时 `[DONE]` 没到，但连接可能"正常"收尾 ⇒ 两个都要看。
               `idleMs` / `waitedMs` = 最后一段数据到落盘静默了多久 / 从响应开始到落盘一共多久。
               服务端 `attachRes()` 用 `done` ＋ `sawEnd` 判 partial（见那边的 `unfin`）。 */
            res: {
                why: String(o.why || ''),
                sawEnd: (o.sawEnd === true),
                closed: (o.closed === true),
                err: String(o.err || ''),
                idleMs: Number(o.idleMs) || 0,
                waitedMs: Number(o.waitedMs) || 0,
                idleLimitMs: RES_IDLE_MS,
            },
            // ★ 官方三个数：与 Horae `usage.json` 对账的唯一原始凭据
            usage: info.usage,
        };
        /* ★ v8【异步落盘 —— 不再拿 7.7 MB 的**同步**写卡住酒馆主线程】
           `writeFileSync` 一个 7.7 MB 的文件（实测那一轮就是这个量级）在 Windows 上还要叠加实时扫描，
           会实打实卡住主线程几十到几百毫秒 —— 这正是用户说的"电脑很卡"里我们能治的那一半。
           · **顺序有保证**：先 `res.txt`、写完了**才**写 `meta`。服务端 `attachRes()` 是"先按 meta 找、
             再读 res.txt" ⇒ meta 一出现，res.txt 必然已经在盘上（不会读到半截）。
           · 失败照旧如实报（回调里 console.warn），**绝不影响返回**。 */
        const metaFile = file.replace(/\.res\.txt$/, '.res.meta.json');
        fs.writeFile(file, body, (e1) => {
            if (e1) { console.warn('[hitOpt-wiretap] 响应落盘失败（不影响返回）:', e1?.message || e1); return; }
            fs.writeFile(metaFile, JSON.stringify(meta, null, 2), (e2) => {
                if (e2) { console.warn('[hitOpt-wiretap] 响应 meta 落盘失败:', e2?.message || e2); return; }
                try {
                    const u = info.usage || {};
                    console.log(`[hitOpt-wiretap] 抓到模型返回 ${reqInfo.host}${reqInfo.path} → ${reqInfo.base}.res.txt`
                        + `（${meta.bytes} 字节｜hit=${u.prompt_cache_hit_tokens ?? '—'} miss=${u.prompt_cache_miss_tokens ?? '—'}`
                        + ` out=${u.completion_tokens ?? '—'} prompt=${u.prompt_tokens ?? '—'}）`
                        + ` ｜落盘时机=${meta.res.why} 静默 ${meta.res.idleMs}ms`
                        + (overCap ? ' ⚠ 超过内存上限、尾部没接住' : ''));
                } catch (_) { }
            });
        });
    } catch (err) {
        console.warn('[hitOpt-wiretap] 响应落盘失败（不影响返回）:', err?.message || err);
    }
}

/** ★ v7：响应**内存**兜底（字节数）。它是防"把酒馆进程吃爆"的闸，**不是**存档策略 ——
 *  从前那个 `RES_KEEP = 40000` 是拿**原文开刀**（留头 2000 + 尾 20000），已按用户红线删除。
 *  真撞上这个闸就如实标 overCap ⇒ 服务端把这一轮标成 partial。
 *  ⚠ v8 更正一句话：v7 这里写的是"实测一轮 SSE 约 1.1 MB" —— **盘上量出来是 7.7 MB**
 *    （`captures/2026-09-19/0001-…-req-b3f9b640.res.txt` = 7,744,534 字节；同一轮请求只有 169 KB）。
 *    1600 万这个上限仍然够用，但那个"1.1 MB"是错的，留着会误导以后的人（我自己就被它误导过一轮）。 */
const RES_MAX_CHARS = 16_000_000;

/* ★★★★★★ v8【落盘时机 —— 用户 2026-09-19 定版："需要先内存暂存，若持续3s没有增长则才存盘并标记成败"】
   ── 规则：每收到一段就**续期**；只有**连续 `RES_IDLE_MS` 毫秒没有新数据**才结算落盘。
      流还在长的时候**一个字节都不落盘、也不做任何解析** ⇒ 不跟酒馆的生成抢主线程、也不抢 IO。
   ── 为什么"静默 3 秒"是可靠判据：SSE 每来一段就重置计时器 ⇒ 正常生成期间永远到不了静默；
      真正静默满 3 秒 = 这一发已经停了（正常收尾 / 连接被掐 / 出错），此时结算正是时候。
      ⚠ `res.on('end')` **也不立刻写** —— 它只记下 `sawEnd`，同样交给静默计时器（见 `wrap()` 里那段）。
   ── 可配置：`HORAE_WIRETAP_IDLE_MS`（**只为验收**：测试里设成 300ms 才不用真等 3 秒）。 */
const RES_IDLE_MS = Number(process.env.HORAE_WIRETAP_IDLE_MS) || 3000;

function isInteresting(host, p) {
    try {
        if (!host) return false;
        const h = String(host).toLowerCase();
        // 自测用：HORAE_WIRETAP_ALLOW_LOCAL=1 时连本机也抓（生产环境不设它）
        if (process.env.HORAE_WIRETAP_ALLOW_LOCAL !== '1') {
            if (h === 'localhost' || h.startsWith('127.') || h === '::1' || h.endsWith('.local')) return false;
        }
        if (/\.(js|css|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|ico|map)(\?|$)/i.test(String(p))) return false;
        return true;
    } catch (_) { return false; }
}

function wrap(mod, name) {
    const orig = mod[name];
    if (typeof orig !== 'function' || orig.__horaeWiretap) return false;
    const wrapped = function (...args) {
        try {
            let host = '', p = '';
            const first = args[0];
            const opt = (first && typeof first === 'object' && !(first instanceof URL)) ? first : (args[1] || {});
            try {
                const u = (first instanceof URL) ? first
                    : (typeof first === 'string' ? new URL(first) : null);
                host = u ? u.host : String(opt.hostname || opt.host || '');
                p = u ? u.pathname : String(opt.path || opt.pathname || '');
            } catch (_) {
                host = String(opt.hostname || opt.host || '');
                p = String(opt.path || '');
            }
            const method = String(opt.method || 'GET').toUpperCase();
            const headers = opt.headers || {};
            if (method === 'POST' && isInteresting(host, p)) {
                const chunks = [];
                let size = 0;
                let done = false;
                const req = orig.apply(this, args);
                // ★★★★★★ v6：**响应方向也要接住**（用户："服务器的返回也是要存档记录的，你现在没存！"）
                //   请求体存完拿到 `base`（文件名），响应回来时按**同一个 base** 落 `.res.txt`
                //   ⇒ 一轮请求/返回在盘上永远成对（`0035-….txt` ↔ `0035-….res.txt`）。
                //   挂监听必须在 `apply()` 之后**立刻**挂（响应是异步的，晚挂会漏）。
                const reqInfo = { host, path: p, base: '', chatKey: '', file: '', reqSha: '' };
                try {
                    /* ★★★★★★ v8【内存暂存 ＋ 静默 3 秒才落盘 —— 用户 2026-09-19 点名的那条】
                       ── 手里存的是 **Buffer**（不是字符串）：SSE 一 token 一段 ⇒ 一轮 7.7 MB 就是
                          十几万段，逐段 `Buffer.from(c).toString('utf8')` 会造出十几万个字符串对象
                          （基准实测这一步本身只有 4 ms，**它不是真凶**，但既然手里是 Buffer，
                          就没有理由再解码一遍 —— `Buffer.concat` 是原生实现、最后一次性处理）。
                       ── **流还在长的时候一个字节都不写盘、也不做任何解析**；只有**连续静默满
                          `RES_IDLE_MS`** 才结算。这就是"不跟酒馆的生成抢主线程、也不抢 IO"。
                       ── `end` / `close` / `error` **都不再立刻写**。老写法是 `end` 一到就落盘：
                          而 `close` 完全可能**先于** `end` 触发（连接被掐）⇒ 会把**半截**响应
                          当成完整的一份写下去，且之后 `end` 再来时被 `resDone` 挡住、永远补不上。
                          现在三者都只**记下事实**（`sawEnd` / `closed` / `err`）＋ 续期，交给计时器结算。
                       ⚠ 如实说一条：**进程退出时还没结算的那一发会丢**（`fs.writeFile` 是异步的，
                          在 `exit` 钩子里写不出去）。现实中只有"生成到一半直接关酒馆"才碰得上
                          —— 生成结束 3 秒内必然已结算。这里不放假兜底。 */
                    const resChunks = [];
                    let resBytes = 0, resSaved = false, resCap = false;
                    let resSawEnd = false, resClosed = false, resErr = '';
                    let resTimer = null, resAt = Date.now(), resLastAt = Date.now();
                    const flushRes = (why) => {
                        if (resSaved) return;
                        resSaved = true;
                        if (resTimer) { try { clearTimeout(resTimer); } catch (_) { } resTimer = null; }
                        try {
                            saveRes(reqInfo, Buffer.concat(resChunks), {
                                overCap: resCap, why, sawEnd: resSawEnd, closed: resClosed, err: resErr,
                                idleMs: Date.now() - resLastAt, waitedMs: Date.now() - resAt,
                            });
                        } catch (_) { }
                    };
                    const bump = (why) => {
                        resLastAt = Date.now();
                        if (resTimer) { try { clearTimeout(resTimer); } catch (_) { } }
                        resTimer = setTimeout(() => flushRes(why), RES_IDLE_MS);
                        if (resTimer && typeof resTimer.unref === 'function') resTimer.unref();
                    };
                    req.on('response', (res) => {
                        try {
                            res.on('data', (c) => {
                                try {
                                    // ★ v7 的**内存**兜底：真撞上就如实标 overCap（绝不假装完整）——不是存档策略
                                    if (resBytes > RES_MAX_CHARS) { resCap = true; }
                                    else {
                                        const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8');
                                        resBytes += b.length;
                                        resChunks.push(b);
                                    }
                                    bump('idle');                                   // ★ 每来一段就续期
                                } catch (_) { }
                            });
                            res.on('end', () => { resSawEnd = true; bump('idle-end'); });
                            res.on('close', () => { resClosed = true; bump(resSawEnd ? 'idle-end' : 'idle-close'); });
                            res.on('error', (e) => { resErr = String(e?.message || e); bump('idle-err'); });
                        } catch (_) { }
                    });
                    req.on('error', (e) => { resErr = resErr || String(e?.message || e); bump('idle-reqerr'); });
                } catch (_) { }
                try {
                    const ow = req.write;
                    req.write = function (chunk, enc, cb) {
                        try {
                            if (chunk != null) {
                                const s = (typeof chunk === 'string') ? chunk : Buffer.from(chunk).toString('utf8');
                                size += s.length;
                                if (size <= 4_000_000) chunks.push(s);      // 上限兜底，别把内存吃满
                            }
                        } catch (_) { }
                        return ow.call(this, chunk, enc, cb);
                    };
                    const oe = req.end;
                    req.end = function (chunk, enc, cb) {
                        try {
                            if (!done) {
                                done = true;
                                if (chunk != null) {
                                    const s = (typeof chunk === 'string') ? chunk : Buffer.from(chunk).toString('utf8');
                                    size += s.length;
                                    if (size <= 4_000_000) chunks.push(s);
                                }
                                const body = chunks.join('');
                                if (looksLikePrompt(body)) {
                                    const sv = save(host, p, body, headers);
                                    if (sv) { reqInfo.base = sv.base; reqInfo.chatKey = sv.chatKey; reqInfo.file = sv.file; reqInfo.reqSha = sv.bodyHash || ''; }
                                }
                            }
                        } catch (_) { }
                        return oe.call(this, chunk, enc, cb);
                    };
                } catch (_) { }
                return req;
            }
        } catch (_) { /* 抓包失败不影响请求 */ }
        return orig.apply(this, args);
    };
    wrapped.__horaeWiretap = true;
    mod[name] = wrapped;
    return true;
}

export async function init(router) {
    ensureDir(OUT_ROOT);
    // ★ v3：给 Horae 一个**只读**接口 —— 把最近一次落盘的出网原文（真 request）读回去。
    //   不引内存、不建第二份存储：存储就是硬盘上的 git 记录（_gitlog），这里读的就是抓包落的那份文件。
    try {
        router.get('/status', async (_req, res) => {
            /* ★ v6.24.55【可移植性】报出自己的真实挂载名（同记录服务那份的理由）：
             *   客户端原来靠"把 horae-git 换成 horae-wiretap"这种字符串替换推地址 —— 改个名就废。
             * ★ 2026-09-24【合并】：不再是独立插件 ⇒ 挂载名就是记录服务那个 id，
             *   多一个 `part: 'tap'` 与 `mount` 说清"我在它下面这一层"。 */
            res.json({
                ok: true, native: true, v: WIRE_V, id: 'hitopt-git', part: 'tap', peer: 'hitopt-git',
                mount: '/api/plugins/hitopt-git/tap', root: OUT_ROOT,
                res: '返回原文逐字节存档（v8：不截断、不省略、不改一个字节；内存暂存 ＋ 连续静默 3 秒才落盘 ＋ 只扫首尾取 usage）',
            });
        });
        // ★ v4：`?since=<ms>` 按**时间窗**取回（聊天 key 在传输层拿不到，见 latestCapture 那段）。
        //   兼容旧问法：只给 `?chat=` 时仍按文件名认聊天。`expectMsgs` / `minChars` 是形状校验。
        router.get('/latest', async (req, res) => {
            try {
                const hit = latestCapture({
                    since: req.query?.since, chatKey: req.query?.chat,
                    expectMsgs: req.query?.expectMsgs, minChars: req.query?.minChars,
                });
                // ⚠【临时诊断埋点·查完必删】每一次取抓包都留痕（参数 + 结果）。
                //   为什么非留不可：客户端那条 `_gitLogFetchWire` 失败时只报**最后一个候选地址**的错误
                //   （实测就因此把原生地址的真实拒因盖成了"8799 连不上"），只看那行根本查不出来。
                try {
                    fs.appendFileSync(path.join(OUT_ROOT, '_diag.log'), JSON.stringify({
                        at: Date.now(), tag: 'wiretap:latest',
                        since: Number(req.query?.since) || 0, expectMsgs: Number(req.query?.expectMsgs) || 0,
                        ok: !!hit?.ok, file: String(hit?.file || ''), n: Number(hit?.n) || 0,
                        chars: Number(hit?.chars) || 0, at2: Number(hit?.at) || 0,
                        err: String(hit?.error || ''), note: String(hit?.note || ''),
                    }) + '\n', 'utf8');
                } catch (_) { /* 留痕失败不影响取用 */ }
                res.json(hit);
            } catch (err) { res.json({ ok: false, error: String(err?.message || err) }); }
        });
        // ⚠⚠【临时诊断埋点·查完必删】⚠⚠
        //   目的：面板"0 轮"这一轮没写进 git —— 服务端 `/turn`、`/latest`、客户端脚本缓存我都单独验过，
        //   剩下只有"客户端到底看到了什么"看不到（浏览器 console 读不到、酒馆没开调试端口）。
        //   这里开一条**只写**的窄口子，把客户端每一步原样记到 captures/_diag.log。
        //   为什么是 **GET**（而不是 POST）：POST 会先撞上酒馆的 csrf-sync（403 Invalid CSRF token）——
        //   而"是不是被 CSRF 挡了"恰恰是这次要查的东西，拿它当通道等于自欺欺人；
        //   GET 不过那道门，只写一行、不读任何东西、不改任何东西。
        //   定位完连同客户端的 `_diagReport` 一起删干净（AGENTS.md §2.5 死代码纪律）。
        router.get('/diag', async (req, res) => {
            try {
                const line = JSON.stringify({ at: Date.now(), when: new Date().toISOString(), ...(req.query || {}) });
                fs.appendFileSync(path.join(OUT_ROOT, '_diag.log'), line + '\n', 'utf8');
            } catch (_) { /* 留痕失败不影响任何东西 */ }
            res.json({ ok: true });
        });
        console.log('[hitOpt-wiretap] 只读接口已挂：/status /latest /diag（把最近落盘的出网原文读回来）');
    } catch (err) {
        console.warn('[hitOpt-wiretap] 只读接口挂载失败（抓包本身不受影响）:', err?.message || err);
    }
    const a = wrap(https, 'request');
    const b = wrap(http, 'request');
    console.log(`[hitOpt-wiretap] 已挂在传输层（https=${a} http=${b}）：所有 POST 提示词请求原样落盘到 ${OUT_ROOT}`);
    // 同时留着全局 fetch 那一层（有的插件/库确实用全局 fetch）
    try {
        const origFetch = globalThis.fetch;
        if (typeof origFetch === 'function' && !origFetch.__horaeWiretap) {
            const patched = function (input, init2) {
                try {
                    const u = typeof input === 'string' ? input : String(input?.url ?? '');
                    const body = init2?.body;
                    if (String(init2?.method ?? input?.method ?? 'GET').toUpperCase() === 'POST' && looksLikePrompt(body)) {
                        try { save(new URL(u).host, new URL(u).pathname, body, init2?.headers ?? input?.headers); } catch (_) { }
                    }
                } catch (_) { }
                return origFetch.apply(this, arguments);
            };
            patched.__horaeWiretap = true;
            globalThis.fetch = patched;
        }
    } catch (_) { }
}

export function exit() {
    console.log('[hitOpt-wiretap] 退出');
}
