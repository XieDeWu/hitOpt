// Horae · git 记录（插件自带的服务端部分）
//
// 这不是"另一个插件"，也不是一个要你手动启的独立服务：
// 它是 Horae 自己的一个模块，由酒馆在启动时**在酒馆进程内**加载（SillyTavern server plugin 机制），
// 路由挂在 `/api/plugins/horae-git/` 下。酒馆一开它就在，**没有额外端口、没有额外进程、没有窗口**。
//
// 分工：**git 干活，本模块只搬运**
//   · 每轮把"真实发出去的 request"写成可读文本 → `git init / add / commit`（一个聊天一个仓库）；
//   · 重新生成（swipe）→ **也追加一个新提交**（提交数 = 真发出过的请求数，一次不缺）；
//   · 看 diff → 直接返回 `git diff` 的 patch，前端只负责画成 IDEA 风格。
//   本文件里**没有任何 diff / LCS / 编辑距离算法** —— 一行都没有。
// 只留最近 30 个聊天的仓库（见 CHAT_KEEP）：这份记录只为"复现缓存命中率为什么掉"，
// 覆盖最近在聊的那几份就够；清理由本模块自动完成，**用户不需要做任何事**。
//
// 装法（★ 2026-09-24【搬迁】后的样子）：这是一个**独立插件**，住在
//       `SillyTavern/plugins/hitopt-git/index.mjs`（真实目录，不再是指向 Horae 扩展目录的链接），
//       并在 config.yaml 打开 enableServerPlugins: true
//       （config.yaml 是酒馆自己的本地配置、被 git 忽略，不属于酒馆代码）。
//   ★ 2026-09-24（第二十三批）：**路由名与目录名对齐了** —— `info.id` 从 `horae-git` 改成 `hitopt-git`。
//     路由前缀由 `info.id` 决定（`src/plugin-loader.js` = `app.use('/api/plugins/' + id, router)`，
//     **不看目录名**）⇒ 改名是**服务端行为变化**：要重启一次酒馆才生效。
//     ⛔ 为什么非改不可（用户 2026-09-24 原话）："估计还有 id=horae-git v49 酒馆内置
//        这里的 horae 的 id 也没改 hitopt" —— 记录服务是 **hitOpt 自己的**，
//        面板上挂着 `horae-git` 等于把独立项目又挂回 Horae 名下。
//     ⚠ 迁移期：客户端候选表**新名优先、旧名兜底**（没重启时面板照常能用，只是如实标出"还是旧挂载名"）。
//   ⚠ 数据（`_gitlog` / `_errlog` / `_tokcache`）落在**本文件旁边**，见下面 HORAE_DIR / defaultRoot()。
//   ⛔ 本模块**不看 Horae**：不读它的目录、不读它的客户端版本（2026-09-24 用户定版：
//     "我们的 hitOpt 已经独立了哦 原版 Horae 再怎么改都不关我们事情，有联动性问题，我们日后再修"）。
import fs from 'node:fs';
import path from 'node:path';
// ★★★★★★ 2026-09-19：补上 crypto 的 import —— 漏了它，两处 `crypto.createHash()` 一直在抛。
//   Node 有**全局 crypto**（WebCrypto：subtle/randomUUID…），但**没有 `createHash`** ⇒
//   报错是 `TypeError: crypto.createHash is not a function`（不是 ReferenceError，所以很难一眼看出是"没 import"）。
//   真机后果：① `turns/NNNNN.raw.txt` 的 sha256 **从来没算出来过**（`rawInfo` 恒为 null）；
//             ② 每轮版本戳 ver.json 的指纹整块被 catch 吞掉（`check/triad_save_test.mjs` 当场抓红）。
import crypto, { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
/** v6.24.77：给"按酒馆根目录解析依赖"用（分词器库从酒馆自己的 node_modules 拿，不从本插件的相对位置猜） */
const require = createRequire(import.meta.url);

export const info = {
    id: 'hitopt-git',
    name: 'hitOpt 记录服务',
    description: '每轮真实 request 一次 git commit，diff 由 git 计算',
};

const GIT = process.env.HORAE_GIT_BIN || 'git';
/** 本模块所在目录 = **独立插件目录**（`<酒馆>/plugins/hitopt-git/`）——用它定位，不依赖"当前工作目录"。
 *  ★ 2026-09-24【搬迁】：它原来是 Horae 扩展目录（本文件曾住在那里、靠一个 Junction 被酒馆扫到）。
 *    现在它是真实目录，而**记录数据就落在它旁边**（`defaultRoot()` 见下）——
 *    "根目录就在服务端自己旁边"这一条是设计的核心：没有第二个地方需要配置。 */
const HORAE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 路由数据版本：前端用它判断"酒馆里跑的是不是旧模块"（旧模块不返回 token/usage，表里那几列会是空的）
 *  2 = /log 带每个提交的 tok / msgs / 逐条明细
 *  3 = /diff 支持 `blob=1`（比两个文件 —— 相邻两轮 request 的逐行 diff）
 *  4 = /wire（收下并读回**出网原文** —— 真 request 那一份，见 v6.24.36）
 *  5 = 抬头 token 与真字节**分成两格**（`# wire | <tok> tok | <字节> 字节 | …`）；/log 每轮多给
 *      `bytes`（真字节）与 `srcWire`（这份记录是出网原文还是本地快照）—— 见 v6.24.39
 *  6 = 抬头尾部带**实测断点**（`| lcp <tok>tok/<chars>ch @#<i> <role>`，由前端 `body.wire.lcp` 传进来）
 *      —— 出网原文那一层没有逐条 token，没有它面板「本地命中」只能得 0（见 v6.24.42）
 *  7 = /log 每轮多给 `chars`（抬头那格「N 字」＝这一轮逐条正文的字数之和，**只搬运、不重算**）
 *      —— 面板那三列（公共前缀／未命中／合计）＝ `chars + msgs − 1` 与抬头尾部的 `lcp …/<chars>ch`，
 *      与 `check/prefix_test.mjs` 在真出网原文上量出来的三个数逐位相同（见 v6.24.50）
 *  8 = ★ v6.24.51：**全项目唯一那套 lcp 搬到这一层**（`lcpOfTurns`，两轮记录正文逐字节比）——
 *      /log 每轮给 `lcpChars`（lcp 字）/ `missChars`（miss 字）/ `totalChars`（合计 字）/
 *      `chars`（正文逐条之和 字）/ `charHead`（抬头那格，只当对账）/ `itemChars` / `lcpItem` / `lcpRole`。
 * 26 = ★★★★★ v6.24.115：`/log` 每轮**再加一组"官方裁判口径"** —— `hitChars` / `hitItem` / `hitRole` /
 *      `hitBestNo`（＝与**任意更早轮次**的最大公共前缀，见 `lcpBestOf`）。上面那一组 `lcpChars` **原样不动**
 *      （＝与上一轮，管 ★★★★★「第 N 轮必须把第 N−1 轮当逐字节前缀、lcp(N−1,N) 不许降」那条判据）。
 *      实测（真分词器＋盘上真存档）：本场 11 轮 Σ|与上一轮−官方| = 132,800 tok → Σ|池内最大−官方| = 768 tok；
 *      全仓 236 轮 1,313,793 → 489,857（降 62.71%）。**提示词一个字没动 ⇒ 对三个官方数的影响 = 0。**
 *      面板只念这几个数、一个字都不算；验收＝与 `node check/prefix_test.mjs` 打印的三个数逐位相同。
 *      （v7 那条走不通：抬头那份是客户端在**还原/后置之前**的预演快照上量的，与真出网那份字不是同一串。）
 *  9 = ★ v6.24.54：**归档抬头从正文里搬出去了**（`turns/NNNNN.txt` 第一行就是真内容的第一个字节，
 *      元数据另存旁边一份 `turns/NNNNN.meta.txt`）—— 用户报的现象：差异页把 `# wire | …` 那行
 *      （插件自己写的归档说明）当成"request 的原文"红绿出来，存档里"出网发送的实际内容"被污染。
 *      /log 那几格（`tok` / `bytes` / `msgs` / `srcWire` / `charHead`）改从旁文件读；老记录（抬头还在
 *      文件里）照样认。见 `_handover-wire-原文抬头污染.md`。
 * 10 = ★ v6.24.54（后半）：**客户端"本地快照"那条路整段删掉**（用户定版："本地快照是历史死代码，
 *      给我删了吧，我们只管最终出网"）。`/turn` 现在**没有 `wire.body` 就 400、一个字都不写**；
 *      新增 `/reserve`（只报编号，不写文件、不提交）—— 客户端等抓包落盘期间靠它把编号钉住；
 *      wiretap 的形状判据换成"出网条数不得少于出发那一刻的条数"。
 * 11 = ★ v6.24.68【用户定版："换行美化是我们的事情，你连真实内容都敢格式化？存盘必然是真实文本"】：
 *      **`turns/NNNNN.txt` 存的就是抓包那份 POST body 逐字节原文**（不再铺平重排、不再丢顶层参数）。
 *      以前存的是 `flattenWire()` 铺平过的可读文本 ⇒ 用户拿盘上的文件跟抓包一对：
 *      ① 格式被重排；② body 顶层 8 个参数（temperature / max_tokens / stream / presence_penalty /
 *      frequency_penalty / top_p / thinking / reasoning_effort）一个都没进档；③ 抬头却写着
 *      "出网原文，逐字节未改"。现在铺平**只在内存里**做：`parseTurnFile` 读的时候现铺（老记录两种形状都认）、
 *      `/diff` 与 `simDiff` 比之前现铺，铺平结果一个字都不落盘。
 * 12 = ★ v6.24.72：`GET /selfcheck`（自检搬进 Horae 本体，随酒馆启动、随三仓分发）。
 * 13 = ★ v6.24.75：`/selfcheck` 多一项「四视图一致性」判读（面板 / 盘上文件 / 差异页 / 出网原文）。
 * 14 = ★★ v6.24.76【用户 ⑩：本地与官方 usage 必须 0 偏差】：**本地 token 改由服务端在盘上那份真出网
 *      原文上现算** —— 用酒馆自己那份 DeepSeek 分词器（`src/endpoints/tokenizers.js`，
 *      从本文件位置往上认根目录，不写死路径），口径与客户端那条 `_countStMessage` 完全一致。
 *      实测 21/21 个带官方数的轮次**残差 0**。`/log` 每轮多给 `tokExact`（算不出来是 null，
 *      面板显示 —，不拿客户端报上来的那格 tok 顶上 —— 那个数的是**另一串字**，恒偏 +58）。
 *      抬头尾部多一段 `| 本地exact <n> tok`（让盘上那份文件自己就带着权威数）。
 * 15 = ★★★ v6.24.82【目标⑧ 全仓扫出来的真 bug：老记录的标记行有两种形状】
 *      `parseTurnFile` 的段落正则原来只认 `── #0 system ──`，**不认**老记录那种
 *      `── #0 system 2305tok ──`（带逐条 tok）⇒ 实测 **10 个仓库 / 19 轮**解析出 0 条：
 *      面板从抬头读得出「31 条」、差异页与 `GET /flat` 却一条都铺不出来 —— 用户 ⑥(b)/⑧(c)
 *      说的"两边各说各话"、② 说的"差异页正文画不出来"，就是它。
 *      两种形状现在都认，并把 `Ntok` 填进 `tok`（该字段本来就是为它留的）。
 * 16 = ★★★ v6.24.84【自检补上 ①′：**真正发请求的那一页**是哪一版】
 *      `client:boot` 只说明"某个页面加载了哪一版"。2026-09-17 实测：`client:boot` 报 v6.24.83，
 *      而**发请求的那一页**一直是 v6.24.81（抬头 `cli=v6.24.81` 为证）⇒ 用户按的 F5 没落到
 *      正在聊天的那一页上（多半开了多个标签页）。判据改用**那一轮请求自己带的版本**（抬头 `cli=`），
 *      它比 `client:boot` 硬；不一致就写进 todo："**在正在聊天的那一页**按 F5"。
 *      当时差点把"连续几轮没有增量条"误判成"体检把还原拦死了"去改代码 —— 是这一项救回来的。
 * 17~26 =（编年没逐条补，见 `STATE.md` 与各 commitmsg；最后一次是 v6.24.112 的 `/log` 性能闸门修正：
 *      小字段每一轮都算、只有最近 `ITEM_TURNS` 轮才带 `items`。） */
const ROUTE_V = 57;   // ★ 2026-09-24（第二十八批）：56 → 57 —— **自检的"要用户做什么"去掉三条误报**。
                      //   用户原话："**记录仓库30上限是有意的设定 省的垃圾挤满**"。
                      //   病：`buildSelfCheck` 的 `todo` 里有三条**假待办**，会让"什么都不用做"永远不出现
                      //   （用户每次打开自检都以为有事要干）：
                      //     ① "把要留的旧仓库挪进 _retired/" —— 30 上限**就是设计**（自动淘汰旧场、
                      //        免得磁盘被垃圾堆满）⇒ 反过来要求用户手动清是搞反了。降成 info 报告；
                      //     ② "把这一轮的本地/官方差修到 0" —— 差 2 tok 是**早先定过案的 ⑩ 类例外**
                      //        （官方 = Σencode + 2×条数 + 28，chat 模板那点差异），没有可执行的下一步
                      //        ⇒ 仍然如实报数，但不再要人做事（差得超过已知口径差才升 warn）；
                      //     ③ "把异常原话发我" —— **过时**：那时我读不到 `_errlog`，现在自检自己就在读它、
                      //        而且 `_errlog/*.jsonl` 我一条 node 命令就能列全 ⇒ 不该让用户跑腿。
                      //   ⚠ 剩下 5 条 `need` 都是**真需要用户做**的（分词器没接上要看酒馆窗口、
                      //     切思考模式、记录写坏了、面板 0 行要点一次差异↗…），一条没动。
                      //   ⚠ 响应字段一个没增没减（`todo` 照旧是数组）⇒ 严格说协议没变；
                      //     涨号是因为**改了服务端行为、必须重启才生效** —— 让自检照实喊。
                      //   ⚠ 改的是服务端 ⇒ **要重启一次酒馆**。
                      // ｜★ 2026-09-24（第二十七批）：55 → 56 —— **抓包并进来了，服务端从两个插件收成一个**。
                      //   抓包（原 `plugins/horae-wiretap/`）现在是本插件目录下的 `wiretap.mjs`，
                      //   由 `init()` 里 `tapModule()` 载入、路由挂到 `/api/plugins/hitopt-git/tap/…`。
                      //   用户两句原话："**没有horae-wiretap，只有hitopt**" ＋
                      //     "安装这么麻烦 谁家还要手动的 能输个git仓库地址算不错了"
                      //     ＋ "反正最终只有用户只需一个操作 那就是输入git地址安装"。
                      //   为什么非合并：抓包本来是**第二个服务端插件目录** ⇒ 别人装完扩展还得手动拷
                      //   第二份、再重启一次。而它是自包含的（只在传输层 patch `http/https.request`）
                      //   ⇒ 收进本插件后**服务端只需 clone 一次**。
                      //   ⚠ plugin-loader 只认 index.js/cjs/mjs 三个名字（`src/plugin-loader.js` L109）
                      //     ⇒ `wiretap.mjs` 不会被当成第二个插件重复加载。
                      //   ⚠ 落盘根随之从 `plugins/horae-wiretap/captures/` 变成
                      //     `plugins/hitopt-git/captures/` —— 旧数据要搬（否则历史轮次的"输出↗/差异页"读不到）。
                      //   ⚠ 顺带删掉一处**写死的 `127.0.0.1:8000`**（`attachRes` 原来是走 HTTP 问抓包版本的，
                      //     现在同进程直接读它导出的 `WIRE_V`）⇒ 换端口/远程访问不再失效。
                      //   ⚠ 改的是服务端 ⇒ **要重启一次酒馆**。
                      // ｜★ 2026-09-24（第二十六批）：54 → 55 —— **新增只读 `GET /tokseg`**：给"某一侧的某几行"
                      //   用**真分词器**数 token。病根（用户实测第 20 轮，原话："三个差异页的分词器有点问题
                      //   不过小bug，需要统一分词算法。第20轮官方与本地计算都是7k左右，但是差异页是8k的内容"）：
                      //   差异页每条收纳条/变动块写着的「≈X tok」是**折算**出来的 —— 行字数（还含每行那个换行）
                      //   × 字/token 比（面板的 tok ÷ 这一轮总字数）。两处系统性偏差：① 那 N 个换行面板的
                      //   总字数里根本没有（第 20 轮 407 行 ⇒ 虚高 ≈278 tok）；② 被乘的是**铺平展示文本**的
                      //   行字数、乘数却是**真出网字节**口径的比（⇒ 再虚高 ≈190 tok）；③ 剩下的是"全文平均
                      //   密度"与"这一段自己的密度"之差。合计虚高 10.8%（面板 7,131 / 差异页 7,899）。
                      //   ⇒ 段落的 token 也交给**同一个分词器**（与 `/log` 的 `tokExact`/`tokHit`/`tokMiss`
                      //     同一个 `stTokenCounter`、同一份酒馆词表）。
                      //   ⚠ 铺平口径与 `/diff` **共用 `toFlatText`** —— 否则段的行号与页面上的正文错位。
                      //   ⚠ 改的是服务端 ⇒ **要重启一次酒馆**。
                      // ｜★ 2026-09-24（第二十五批）：51 → 52 —— **自愈的两条只读通道**（`/pre` 补算输入 ＋ `/missing` 缺结构清单）。
                      //   病根：客户端一次生成会调两次 `/turn`（`CHAT_COMPLETION_PROMPT_READY` 两个 emit 点），
                      //   而客户端 `body` 里**没有 `no` 字段** ⇒ 服务端两次都走 `nextTurnNo()` ⇒ 同一发占两个号
                      //   ⇒ 面板多一行、官方 usage 只落一条、那一行就永远空着。详见 `findSameSendNo` 那一大段。
                      //   ⚠ 改的是服务端 ⇒ **要重启一次酒馆**。
                      // ｜★ 2026-09-24（第二十一批）：47 → 48 —— **`/log` 的"上一轮"口径改对**：
                      //   `lcpChars`/`missChars`/`lcpItem`/`lcpRole`/`taxChars`（＝面板「本地命中 / 未命中 /
                      //   命中率」那三列）原来按 **轮号减一** 找上一轮，删掉"同一发被记两遍"的假轮之后轮号
                      //   会跳号（实测 `0 1 2 3 5 7 9`）⇒ 5/7/9 三行永远算不出来、面板恒显示 `—`。
                      //   现在改成"本场**上一个真存在**的轮号"。用户原话："我只希望聊天的 Δhit Δmiss 正常"。
                      //   ⚠ 响应字段一个没增没减（只是值不再恒 null）⇒ 严格说协议没变；涨号是为了让
                      //     `/selfcheck` 的"要不要重启酒馆"照实喊 —— **改的是服务端，必须重启一次**。
                      // ｜★ 2026-09-24（第二十批）：46 → 47 —— **新增只读 `GET /res`（官方返回原文）** ＋ `/log` 每轮多一个 `res` 状态字段。
                      //   为什么非升不可：这是一条**新路由**（协议变了）—— 面板第 1 列那颗「输出↗」靠它取
                      //   `turns/NNNNN.res.txt`；老服务端上这条路由**不存在**（实测 404）⇒ 不升号就分不清
                      //   "酒馆没重启" 与 "链接写错了"（`/selfcheck` 靠"盘上 ROUTE_V vs 线上 /status.v"判重启）。
                      //   ⚠ 改的是服务端 ⇒ **必须重启酒馆**才生效（ROUTE_V 与路由表都只在启动时读一次）。
                      //   ⚠ 纯只读：不写盘、不碰 git、不要 CSRF。
                      //   ｜★ v6.51.13（第十八批）：45 → 46 —— **重放集 · 缺口3 ＋ 缺口2**：`/turn` body 多收 `cfg`（这一轮**开着什么**：settings 全部标量 ＋ 管线级表 ＋ 槽名）与 `diag`（这一轮的 `pushTurn:enter` 埋点**原样**），各落 `turns/NNNNN.cfg.json` / `turns/NNNNN.diag.json`。两项在逐轮查盘里都是 **0/352** ⇒ 补上才谈得上"完备"（定理 4 第 4 项 ＋ 缺口2）。⚠ 都是**纯记账**：不进 messages、不参与任何判据。⚠ 落点与 `pre` **独立**（第一版误写进 `if (pm && pm.length)` 里 ⇒ "没有 pre 就不写"，语法合法、语义错）｜★ v6.51.12（第十七批）：44 → 45 —— **重放集 · 缺口5′ 的下半**：新增 `GET /pool`
                      //   （不带 no ⇒ 报哪一轮的台账里有本场 ＋ latest；带 no ⇒ 给那一份 pool.json 的**原文**）。
                      //   为什么非要它：v6.51.11 让盘上终于存的是**本场真的那一份**台账，可 `_amPoolLoad`
                      //   只认 localStorage、而它的 setItem 每轮都撞配额 ⇒ 台账**永远装不回来** ⇒
                      //   两级 legacy 算法（块级指针化 / 区间唤起）在生产里从来没真正跑起来过。
                      //   ⚠ 清单支只解析**最近 3 份**（每份实测 8.8MB，全量解析要几十秒；台账是累积的，3 份够）。
                      //   ｜★ v6.51.10（第十六批）：43 → 44 —— **重放集完备性 · 缺口1（服务端侧）**：没切分的轮次也要写一份 turns/NNNNN.abc.meta.txt，说清"这一轮为什么没池化"。以前那种轮次盘上**什么都没有**，而定案的铁证（abOn=0 / rsBase 空 / stState=fail）全在抓包插件的 _diag.log 里 —— 它按天滚动、7 天就没了。⚠ 只写抬头、**不写 abc.json** ⇒ "这一轮有没有切片"这个判据一个字都不动。｜★ v6.51.1（第十五批）：42 → 43 —— **存档改名**：三份内容是 JSON 的存档从
                      // `.txt` 换成 `.json`（`turns/NNNNN.json` / `.raw.json` / `.abc.json`），
                      // 读侧同时认新老两名（老 git 提交里只有 `.txt`，历史不重写）⇒ `/log` 每轮多报
                      // 一个 `rel = {body,raw,abc}`（**盘上真名**，给面板那几个静态超链接用 —— 老格式
                      // 的那 2 轮至今还是 `.txt`，猜名字会 404）；`/diff` 的路径白名单与 `bFile`
                      // 判据、`nextTurnNo`、`TURNS_SPEC` 同步扩成两名两可。
                      // ★ v6.41.24（第十四批）：41 → 42 —— `/log` 每轮多给 **`tokHit` / `tokMiss` / `tokHitBest`**（用酒馆那份**真分词器**把 `tokExact` 按 `lcpChars` 劈成两半 ⇒ `tokHit + tokMiss ≡ tokExact`，面板「本地命中/未命中」不再拿"字数×比例"编）；＋ 切片抬头 `# abc·对账` 那一行的"省"改成 **B 区进出字数差**（原来报的是"块级指针层"那一层的账，与下一行 `# abc·管线` 打脸，全仓 47/81 份如此）｜★ v6.41.21（第十三批）：40 → 41 —— `/pipe` 与 `/flat` 支持 `kind=ref`（＋`name`＝内容指纹）：主链把它那一刻真用的参考串落一份，面板链按同一指纹读它 ⇒ **两边必然同源**｜★ v6.41.19（第十二批）：39 → 40 —— 新增 GET /flat?join=1（返回**出网原文形状**的那一串，面板链的参考串取它）｜★ v6.41.5（第十一批）：38 → 39 —— **中间计算产物的落点从"聊天仓库"搬进"临时区"**：
                      //   用户 2026-09-20 定版："中间计算产物存 管线的盘 单独的 git 仓库" → 随即改口
                      //   "**不了 不用 git 仓 反正 temp 目录**"。
                      //   ① `POST /pipe` 写盘基底：`<ROOT>/<聊天>/algos/…` ⇒ **`<ROOT>/_tmp/<聊天>/pipes/…`**；
                      //   ② `POST /diff` 的 `aRel`/`bRel` 里凡以 `pipes/` 开头者，基底同上（读的也是临时区）；
                      //   ③ `GET /flat?algo=` 同上。
                      //   ⚠ 判据：`isOurRepo` 要求 `.git` 与 `turns` 同时存在 ⇒ `_tmp/<聊天>/` 两样都没有
                      //     ⇒ 它不会被 `listChatRepos` / `pruneChatRepos` 当成一场聊天，
                      //       也**永远不会被 `git add -A` 收进任何一次提交**（这正是要治的：
                      //       实测 5 场 108 个文件 / 33.7 MB 的派生数据此前已经进了归档仓库的索引）。
                      //   ⚠ 这次**必须**升号：老服务端会继续往聊天仓库里读写，而客户端已经按临时区给路径
                      //     ⇒ 差异页会如实报"盘上没有"。升了号才能一眼分辨"重启没重启"。
const ROUTE_V_38 = 38; // ★ v6.41.4（第十批）：37 → 38 —— `GET /abc` 的**返回契约多了一片 `B0`**：
                      //   用户 2026-09-20 拍板解除当年那条"你不可以读池化前原文"的红线，理由是
                      //   "**我们勾选算法 就是为了处理原文啊**" —— 主链喂给管线的输入本来就是 B0（原文），
                      //   而面板链拿的是 `B`（＝B2，池化后）⇒ 两条链输入差 4 倍（实测 14,415 vs 57,613），
                      //   面板的数与真发出去那一发**从根上不可比**。
                      //   ⚠ 这次**必须**升号：不升的话，"重启没重启"看不出来 —— 而这一版
                      //     客户端要靠"服务端到底放不放 B0"来决定输入口径（退回 B 时如实记 `bSrc='B'`）。
const ROUTE_V_37 = 37; // ★ v6.41.4：36 → 37 —— **抬头与切片抬头都开始记「管线」**（用户点名的目标④）：
                      //   ① 抬头那一段从 `| 算法 algo=<算法 id>@<版本> (disk|local)`
                      //      改成 `| 管线 pipe=<管线槽名>@<各级版本> (pipe)｜<逐级名字 → 连>`。
                      //      为什么改（用户 2026-09-20 原话）："**单算法切换记得删除 特别实验标准已无效
                      //      因为已经模块化算法 组合管线**" ⇒ 记录里该写的是**这一轮是哪条管线装的**。
                      //      ⚠ `parseTurnFile` 的正则**同时认新旧两种**：老记录（v6.41.3 及以前）
                      //        里那些 `算法 algo=…` 的历史轮次，照样读得出"是谁装配的"。
                      //   ② `turns/NNNNN.abc.meta.txt` **多一行** `# abc·管线 | N 级 | 1.<名字> <版本> 省 N 字 → …`：
                      //      顺序就是执行顺序，逐级读数之和 == B 区进出的字数差（与客户端那条自校验式子互验）。
                      //      空管线**也写一行**（`0 级` ＋ 原模原样）—— 那是正常语义，不是缺数据。
                      //   ⚠ 要**重启酒馆**才生效（ROUTE_V 只在启动时读一次；抬头是服务端写的）。
const ROUTE_V_36 = 36; // ★ v6.39.13：35 → 36 —— **契约修正**（不是加功能）：
                      //   `POST /algo` 从"每一轮都返回 ok:false"变成"真成功"。
                      //   病根：那条路由里写的 `horaeLog(...)` 这个函数**本模块里不存在**
                      //   （真名 `horaeLogLine`）⇒ 文件写成功了、响应却是失败 ⇒ 客户端如实报
                      //   "产物没写进 algos/…/turns/"，而盘上六个文件**都在** —— 自相矛盾的假警报。
                      //   ⚠ 为什么要升 ROUTE_V（而不是偷偷修）：`/selfcheck` 靠"盘上 ROUTE_V vs
                      //     线上 `/status.v`"判"要不要重启酒馆"。不升号 ⇒ 它会说"不用重启"
                      //     ⇒ 用户不重启 ⇒ 这个 bug 原样留着（这正是它当初没被发现的原因）。
                      //   ⚠ 要**重启酒馆**才生效（R O U T E _ V 只在启动时读一次）。
const ROUTE_V_35 = 35; // ★ v6.39.12：34 → 35 —— **每个算法一个独立目录，与主算法并列**（用户定版）：
                      //   新增 `POST /algo`（把某个算法的产物落到 `algos/<算法 id>/turns/NNNNN.txt`）；
                      //   `GET /flat` 多收一个 `algo`（不带 ⇒ 主算法原位 `turns/`，行为与从前逐位相同）。
                      //   ⚠ 方案 A：老 `turns/` **原位不动** —— 三类原始存档一个字节不碰，
                      //     30 个仓库、上千个历史文件不迁移（用户："就怕乱改规则导致存档异常"）。
                      //   ⚠ 要**重启酒馆**才生效（R O U T E _ V 只在启动时读一次）。
const ROUTE_V_34 = 34; // ★ v6.39.11：33 → 34 —— 抬头多一段 **算法标注**：
                      //   `… | 管线 pipe=<管线槽名>@<各级版本> (pipe)｜<逐级名字>`
                      //   ⚠ 这一段在 v6.41.4 改过名（原来是 `算法 algo=<算法 id>@<版本> (<disk|local>)`）——
                      //     老记录那一种形状**照样读**（正则同时认两种），历史轮次不许因为改名而丢装配者。
                      //   为什么必须有（用户 2026-09-19 原话 + 他给的理由）：
                      //     "给每一轮的数据 标记 来自什么版本算法，跟BS双端版本一个性质"
                      //     "**省的我对话一半了，切算法继续跑，结果修bug时候大家的认知错误**"
                      //   ⇒ 切换算法**不打断**正在进行的对话（下一轮才换链），于是同一场聊天里
                      //     每一轮可能是**不同算法**装配的 ⇒ 记录自己必须说清"这一轮是谁算的"，
                      //     否则事后只按"现在选的是哪个"去读，认知必然错乱。
                      //   ⚠ 与 `cli=` 同一处、同一纪律：客户端没报就写 `?`（老客户端照旧，不猜）。
                      //   ⚠ 要**重启酒馆**才生效（R O U T E _ V 只在启动时读一次）。
const ROUTE_V_PREV = 33;   // ★ v6.39.0：32 → 33 —— 两处，都是"实验算法"这条线的补丁：
                      //   ① `GET /abc` **不带 no** ⇒ 报**哪几轮有切片**（`{list:[…]}`）。
                      //      为什么必须有：切片天然**不是从第 0 轮开始**的 —— 第 0 轮没有"上一轮"、
                      //      没有 A/B 切分，盘上实测 `00000.abc.txt` 不存在。而实验链要"从第 1 个
                      //      有切片的轮起串行推进"⇒ 客户端不能猜起点（猜 0 就一轮都取不到、
                      //      整条链当场断在第一轮），也不该一轮一轮试（那是 N 次无用往返）。
                      //   ② `POST /diff` 多收一个 **`aText`**：给了就把「前」那一侧换成它
                      //      （照旧落 `sim/` 下、照旧让 **git** 算 diff —— 插件仍然一行 diff 算法都不写）。
                      //      为什么必须有：实验模式下「池化差异↗ / 与前池化差异↗」要显示的是
                      //      **本链自己的两份文本**之间的差异，而盘上那两份是**主算法**的产物。
                      //      ⇒ 不换的话，面板写着实验值、点开看的却是主算法的差异（举证与数值脱钩）。
                      //   ⚠ 两处都不碰三大类原始存档：`/abc` 只读；`simDiff` 只写 `sim/`（已 gitignore）。
                      //   ⚠ 服务端改动**只在酒馆启动时加载** ⇒ 这一版**必须重启酒馆**才生效（F5 不够）。
                      // ★ v6.39.0：31 → 32 —— 新增只读路由 `GET /abc`（把 A/B/C 三片读给客户端）。
                      //   为什么加（用户 2026-09-19 定版）："新增一个切换按钮 一旦切换 则面板里面
                      //   所有的数据显示也是按新算法计算。然后新的算法必须单独的代码块！
                      //   仅在打开时候 用新的代码块进行计算。实验算法也要单独的临时存储区，
                      //   注意 对于实验算法而言，只有>1轮的只有B、C能读拿来测算法。A是不可以的！！！！"
                      //   ⇒ 实验算法在浏览器里实时跑，必须拿到三片真文本；服务端**只读不写**，
                      //     且**B0 不返回**（"我们算的是算法效率，你不可以读池化前原文"）。
                      //   ⚠ 服务端改动**只在酒馆启动时加载** ⇒ 这一版**必须重启酒馆**才生效（F5 不够）。
                      // ★ v6.38.1：30 → 31 —— 多存一份 A/B/C 切片（`turns/NNNNN.abc.txt`）。
                      //   旧版抓包插件（v6 及以前）把超过 40000 字的响应"留头 2000 ＋ 尾 20000"截断，
                      //   而 `attachRes` 原来的 partial 判据是 `truncated && !done`（恒假）⇒ 一份被省略掉
                      //   1,146,544 字的文件被标成 present。现在判据认 truncated/overCap/done 三种，
                      //   note 里带**真落盘**字节数与原文 sha256。抓包插件同步 v6 → v7。
                      //   （「池化差异」要读同一轮的 raw.txt，旧白名单把它挡在门外 ⇒ 那一页显示不出来）。
                      //   ⚠ 服务端改动**只在酒馆启动时加载** ⇒ 这一版**必须重启酒馆**才生效（F5 不够）。
/* 28 = ★★★★★★ v6.27.2【用户点名：自检少了 Horae 异常日志的检查】—— 两件事一起改（都要重启酒馆）：
 *      ① 服务端自己那些 `[hitOpt] …` 警告／错误，从此**不再只打控制台**：`horaeWarn` 同时落一份
 *         JSONL 到 `<Horae 目录>/_errlog/YYYY-MM-DD.jsonl`（时间 / 级别 / tag / 消息 / 堆栈）。
 *         为什么非做不可：2026-09-19 14:41 用户截图里那三条 `ENOENT … 状态文件写不进去`，
 *         盘上**一处都查不到**（抓包插件的 `_diag.log` 里 `ENOENT` 0 行、酒馆目录下没有任何日志文件）
 *         ⇒ 异常发生过、事后全靠截图猜。这条违反第一重点的【有就是有 没有就是没有】。
 *      ② `/selfcheck` 多一项 ⑥″ **「Horae 异常日志」**：读 `_errlog/` 最近 7 天，
 *         报"最近 24 小时有几条、按 tag 聚合各几次、最近那条原话"，并把 todo 写成"把这句发我"。
 *         ⚠ 判据保守：**没有日志文件 = 一次异常都没有**（✅），不是"判不了"。
 *      ③ 顺带把 `updateStatus` / `writePlaceholder` 的 `ENOENT` 兜住：目录中途没了就**先建回来再写一遍**，
 *         第二遍仍失败才记异常（能救则救；救不回来也一定留下可查的日志）。 */
/* 27 = ★★★★★ v6.24.120【用户 ★★★★"发新一轮即自动诊断，不等我提醒"】：`/selfcheck` 多一项 ⑥′
 *      **「最近一轮的还原链体检」** —— 读埋点里最后一条 `pushTurn:enter` 的
 *      `rsOn / abOn / rsFloorsGone / rsFloorsGoneReal / rsRestored / rsCopies / rsSkip`，当场判读：
 *        · `rsSkip` 含"还原时出错"        ⇒ ⚠ 真 bug（结果会留成半成品），并把 todo 写成"把这句话发我"
 *        · `rsOn=0` 且真楼层 0 条         ⇒ ⚠ **这正是 v6.24.119 修掉的那个漏** ⇒ todo"按 F5"
 *        · `rsOn=0` 且真楼层 >0           ⇒ ✅ 用户自己删了楼层（⑨ 的例外，不算 bug）
 *        · `rsOn=0` 且没有上一轮          ⇒ ✅ 新聊天第一轮，正常
 *        · `rsOn=1`                       ⇒ ✅ 还原链跑通了（报盖回几条 / A-B 生效没 / 后置几条）
 *      为什么必须落在自检里：v6.24.115~119 连修的三处**全在这条链上**，对不对只有发一轮才知道 ——
 *      这一项就是"发完立刻能读的仪表"，不用等我手跑核对器。判据一律保守：拿不到字段就说"判不了"。 */
/** `/log` 最多给最近多少轮**带逐条明细**（`items` 里的 head/tail —— 真正占响应体的就是它）。
 *  ★ v6.24.112 更正：这个闸门**只管 `items`**。以前它管的是"整轮算不算" ⇒ 超过 40 轮的场，
 *    老轮的 `msgs/totalChars/lcpChars/missChars` 全成了 0/null，面板上那几行写成"本地 0 条 0 字"，
 *    而同一行的官方 usage 有真数 ⇒ **两个视图各说各话**（用户 ★★★★ 项）。现在小字段**每一轮都算**。 */
const ITEM_TURNS = 40;
/** 保留最近多少个聊天的记录仓库（= 最近 30 份聊天文件）；超出的按"最后一次用到"从旧到新自动清掉。
 *  为什么是 30：这份记录的唯一用途是"复现缓存命中率为什么掉"，只需要覆盖你最近在聊的那几份；
 *  留着几百份除了占地方，没有任何分析价值。可用 HORAE_GIT_KEEP 覆盖。 */
export const CHAT_KEEP = (() => {
    const env = Number(process.env.HORAE_GIT_KEEP);
    return Number.isFinite(env) && env >= 0 ? Math.floor(env) : 30;   // 0 = 只留正在聊的那一个
})();
/** "清空记录"归档（_retired/）最多留几份：它不占上面 30 个聊天的名额，但也不能无限长 */
const RETIRED_KEEP = 20;

/** ★ v6.24.54：`/diff` 只看**记录正文**，不看旁边那份归档抬头（`turns/NNNNN.meta.txt`）。
 *  为什么非加不可：不加的话 `-- turns/` 会把 meta 一起扫进来，`files.slice(0,1)` 可能挑中
 *  一个 meta 文件 → 差异页整页比错（比的是"归档说明"而不是这一轮的 request）。
 *
 *  ★★★★★★ v6.51.1【改名之后必须一起扩】：三份 JSON 存档从 `.txt` 改成 `.json`，
 *  所以这个范围**两种扩展名都要含**（老提交里只有 `.txt`，而 `/diff` 比的正是那些提交）；
 *  反过来 `turns/*.json` 会把原本被 `turns/*.txt` 天然漏掉的**元数据 json** 也带进来
 *  （`.res.meta.json` / `.status.json` / `.ver.json`）⇒ **逐个排除**，
 *  否则 `files.slice(0,1)` 又可能挑中一个元数据文件 —— 与上面 v6.24.54 踩的是同一个坑。 */
const TURNS_SPEC = [
    'turns/*.txt', 'turns/*.json',
    ':(exclude)turns/*.meta.txt',      // 归档抬头（含 `.abc.meta.txt`）
    ':(exclude)turns/*.meta.json',     // `.res.meta.json`（官方 usage 那份）
    ':(exclude)turns/*.status.json',
    ':(exclude)turns/*.ver.json',
];

/* ══════════════════════════════════════════════════════════════════════════════
 * ★★★★★★ v6.51.1【存档文件名：**内容是什么格式就用什么扩展名** —— 全项目只有这一处定义名字】
 *  用户 2026-09-20 定版原话："代码中 raw 与相关切片文件之类存储文件的实际为 json 格式内容，
 *    就应该用 .json 文件名而不是 .txt"；同一条里点名了面板："顺便将已记录的 30 份聊天中的
 *    相关文件重命名　注意　面板的超链接指向也要注意　别 npe 了"。
 *
 *  ⇒ 一轮里三份**内容确实是 JSON** 的存档改名（判据是**内容**，不是枚举）：
 *      `turns/NNNNN.txt`     → `turns/NNNNN.json`      （抓包那份 POST body，单行 JSON）
 *      `turns/NNNNN.raw.txt` → `turns/NNNNN.raw.json`  （酒馆原文，`{"messages":[…]}`）
 *      `turns/NNNNN.abc.txt` → `turns/NNNNN.abc.json`  （A/B/C 三片，按聊天分槽的 JSON）
 *  ⛔ 不动的（内容本来就不是 JSON ⇒ 给它改名叫 `.json` 才是撒谎）：
 *      `NNNNN.meta.txt` / `NNNNN.abc.meta.txt` —— `# …` 抬头文本
 *      `NNNNN.res.txt` —— 官方返回是 **SSE 流**（`data: {…}` 逐行，整份不是一个 JSON）
 *      `sim/NNNNN.sim.txt`、`algos/**`、`pipes/**` —— 铺平文本
 *
 *  ⚠⚠ **读必须同时认新名与老名**，两条理由都是硬的、删不掉的：
 *    ① 盘上还有 **2 个** v6.24.54 之前的老格式正文
 *       （`圣樱学院_mu4y2xeo6lmz/turns/00000.txt` 与 `00001.txt`：抬头还在第一行、内容是铺平文本）
 *       —— 它们**不是 JSON，所以迁移时一个字节都没动**，名字至今还是 `.txt`；
 *    ② **老 git 提交里只有 `.txt`** —— `/diff` 比的是两个历史提交的 blob，历史不许重写
 *       ⇒ 同一个 ref 下两个名字都得试（见 `readBlobRel`）。
 * ══════════════════════════════════════════════════════════════════════════════ */
/* ⚠ 写成 `function` 声明（不是 `const` 箭头）是**有意的**：验收的 `extractFn` 只认顶层
 *  `function`，而 `algo_filediff_test` 的沙箱必须抠**源码这一份** `turnRelOnDisk`（见那段注释）。 */
function turnK5(no) { return String(no).padStart(5, '0'); }
/** 每一类存档的**规范后缀** —— 写盘一律用它。表放在**函数体里面**是有意的：
 *  验收要靠 `extractFn` 抠**源码这一份**（项目铁律：不许在测试里另抄一套路径规则，
 *  抄一套就等于两套口径 ⇒ `algo_filediff_test` 的沙箱就是这么抠 `simDiff` 的）。 */
function turnSuffix(kind) {
    return ({
        body: '.json', raw: '.raw.json', abc: '.abc.json', pre: '.pre.json', pool: '.pool.json',
        res: '.res.txt', resmeta: '.res.meta.json', status: '.status.json',
        ver: '.ver.json', meta: '.meta.txt', abcmeta: '.abc.meta.txt',
    })[kind] || '';
}
/** v6.51.1 **之前**的后缀 —— 只在**读**的时候当兜底；写盘一个字都不许再用它们。 */
function turnSuffixOld(kind) {
    return ({ body: '.txt', raw: '.raw.txt', abc: '.abc.txt' })[kind] || '';
}
/** 某一类存档的**规范相对路径**。 */
function turnRel(kind, no) { return `turns/${turnK5(no)}${turnSuffix(kind)}`; }
/** 某一类存档的**候选相对路径**（新名优先）。本来就没改过名的类目 ⇒ 只有一个候选。 */
function turnRelCands(kind, no) {
    const k = turnK5(no);
    const out = [`turns/${k}${turnSuffix(kind)}`];
    const old = turnSuffixOld(kind);
    if (old) out.push(`turns/${k}${old}`);
    return out;
}
/** 盘上**真名**：新名在就用新名，只有老名就用老名；都不在 ⇒ 给新名（调用方自己判"读不到"）。
 *  这是给**面板超链接**用的 —— 静态网址必须指向真实存在的那个文件，猜不得。 */
function turnRelOnDisk(dir, no, kind) {
    const c = turnRelCands(kind, no);
    for (const rel of c) { if (fs.existsSync(path.join(dir, ...rel.split('/')))) return rel; }
    return c[0];
}
/** 盘上**真绝对路径**（同一条判据；读写共用一处）。 */
const turnPathOnDisk = (dir, no, kind) => path.join(dir, ...turnRelOnDisk(dir, no, kind).split('/'));
/** 读这一类存档的文本：新名读不到**自动退老名**；两个都没有 ⇒ null（**不编空串**）。 */
function readTurnText(dir, no, kind) {
    for (const rel of turnRelCands(kind, no)) {
        try { return { text: fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'), rel }; } catch (_) { }
    }
    return null;
}

/** ★★★★★★【面板第 1 列那几颗入口用】某一类存档**在不在、是不是真数据** —— 全项目**唯一**那个判据。
 *
 *  ══ 为什么非要这个判据（不是"文件在就行"）════════════════════════════════════
 *  三件套走的是**占坑**那一套（见 `writePlaceholder`）：每轮一进来就先落三份
 *  `[占位·待回填]` 的底文件，真数据到了再覆盖。
 *  ⇒ 盘上"有这个文件"**不等于**"这一轮真有内容" ——
 *    实测 `圣樱学院_muczgjf8igs/turns/00041.res.txt` **481 字节**，
 *    正文全是"等了 90 秒，抓包插件压根没落这一轮的请求"。
 *    拿它当"输出 / 文档"画出去，用户看到的就是一份**说明文件冒充真内容**。
 *  另有一种更彻底的缺：实测两个老场（`mu4y2xeo6lmz` 2 轮 / `mu5sd7sejhp0` 95 轮）
 *    的 `.raw` 存档**一份都没有**（raw 是 v6.24.36 才开始记的）
 *    ⇒ 「原文↗ / 同上轮↗ / 同轮↗」在那 97 轮上**必须不画**（画了就是死链）。
 *
 *  ══ 三态，互不混用（与 `status.json` 里那套语义同一口径）════════════════════
 *    `present`     有，且是**真数据**
 *    `placeholder` 文件在，但抬头是 `[占位·待回填]` ⇒ **不是数据**（没抓到 / 还没回填）
 *    `absent`      盘上**根本没这个文件**
 *
 *  ⚠ 只读文件**头 64 字节**判断，绝不把整份 5 MB 读进内存 —— `/log` 一次要问几十轮 × 三类。
 *  ⚠ 真名两可的类目（body / raw 有 `.json` 与老的 `.txt`）走 `turnRelCands` **同一处**口径；
 *    `res` 从来没改过名 ⇒ 只有一个候选。返回值里的 `file` 是**盘上真名**（给超链接用）。
 *  @param {string} dir 这一场聊天的仓库目录
 *  @param {number} no 轮号
 *  @param {string} kind `turnSuffix` 那张表里的类目（这里用到的：body / raw / res）
 *  @returns {{state:'present'|'placeholder'|'absent', file:string, bytes:number}} */
function archiveStateOf(dir, no, kind) {
    for (const rel of turnRelCands(kind, no)) {
        const p = path.join(dir, ...rel.split('/'));
        let st = null;
        try { st = fs.statSync(p); } catch (_) { continue; }
        const bytes = Number(st.size) || 0;
        let head = '';
        try {
            const fd = fs.openSync(p, 'r');
            try {
                const b = Buffer.alloc(64);
                const n = fs.readSync(fd, b, 0, 64, 0);
                head = b.subarray(0, n).toString('utf8');
            } finally { fs.closeSync(fd); }
        } catch (_) { head = ''; }
        /* 判据与 `writePlaceholder` / `attachRes` 两处**同一个字符串**（抬头第一行）。
           ⚠ 真数据开头是 `data: {`（SSE）/ `{`（JSON）/ `# wire |`（老记录抬头）⇒ 不会撞上这个抬头。 */
        return { state: head.startsWith('[占位·待回填]') ? 'placeholder' : 'present', file: rel, bytes };
    }
    return { state: 'absent', file: turnRel(kind, no), bytes: 0 };
}

/** 记录仓库根：**就在本服务端自己旁边**（`<本插件目录>/_gitlog/`），插件之外不落任何东西。
 *  ★ 2026-09-24【搬迁】：本文件从 Horae 扩展目录搬到了独立插件目录 `SillyTavern/plugins/hitopt-git/`
 *    ⇒ 这一行算出来的就是 `plugins/hitopt-git/_gitlog`（**新家**，数据也跟着搬到这里了）。
 *    "根目录就在服务端自己旁边"是设计的核心：没有第二个地方需要配置。
 *  可用环境变量 HORAE_GIT_ROOT 覆盖（比如想放到别的盘；验收/沙箱也靠它指向临时目录）。 */
function defaultRoot() {
    if (process.env.HORAE_GIT_ROOT) return process.env.HORAE_GIT_ROOT;
    return path.join(HORAE_DIR, '_gitlog');
}

const run = (args, cwd, bin = GIT) => new Promise((resolve) => {
    execFile(bin, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, out: String(stdout || ''), err: String(stderr || '') });
    });
});

/* ══ ★ v6.24.72【可移植性 · 自检属于 Horae 本体】══════════════════════════════════════════
 * 为什么要有这一段（用户 2026-09-17 定版原话）：
 *   「提问 监视器是 horae 里面的吗？不要写成外部的东西啊　我们的行动目标还有可移植性」
 * 以前"自动发现用户动作"靠的是工作台上一个**由人起停的外部 node 进程**（tools/auto_monitor.mjs）——
 * 换台机器就没有、还得人工起停，别人装了 Horae 也拿不到。现在把它**做进服务端本体**：
 * 随酒馆启动、随三仓分发，一个 GET /selfcheck 就能回答"现在要不要用户做点什么"。
 * ⚠ 边界（不许越界）：这里**只读盘、只报告** —— 不改记录、不改客户端文件、不写任何东西。
 * ⚠ 一切"找不到"都如实说找不到，**不猜、不拿别的数顶上**（§2.3）。
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/** ★ 2026-09-24【合并 —— 这一整张候选表退休了】
 *  抓包原来是**另一个服务端插件**（`plugins/horae-wiretap/`），所以这里得"到处找它装在哪"：
 *  `HORAE_WIRE_DIR` ＞ 兄弟目录 ＞ 自带一份 ＞ 从酒馆根推 ＞ 当扩展装。现在它是**本插件自己的
 *  一个模块**（`./wiretap.mjs`，路由挂在 `/api/plugins/hitopt-git/tap/…`），落盘根就是
 *  `<本插件目录>/captures` ⇒ **只有一个地方**，没有可找的。
 *  ⚠ 仍然保留"**返回数组**"这个形状：三处调用点（`findDiagLog` / 自检 / `attachRes`）都是按
 *    "逐个试"写的，返回单元素数组就行 —— 一处调用点都不用改。
 *  ⚠ `HORAE_WIRE_DIR` 仍然**优先**（指的是**插件目录**，调用点自己还会拼 `/captures`）——
 *    验收与自测就是靠它把抓包指到临时目录去的
 *    （`check/triad_save_test.mjs` / `check/selfcheck_server_test.mjs` 都在用它）。 */
function wireDirCands() {
    return [process.env.HORAE_WIRE_DIR, HORAE_DIR].filter(Boolean);
}

/** ★ 2026-09-24【合并】抓包模块的**唯一**取用口（懒加载 + 只 import 一次）。
 *  为什么要懒加载而不是模块顶层 import：`import()` 是异步的，而 `init()` 本来就是 async；
 *  `attachRes` 又是**模块级**函数、不在 `init` 的作用域里（它拿不到 `init` 里的局部变量）——
 *  两边共用一个懒加载口最省事，也不会出现"import 两次、patch 两层"（`import` 同 URL 幂等，
 *  而且**传输层 patch 是在 `init()` 里做的**，不 import 就不 patch ⇒ 不存在重复包裹）。
 *  ⚠ 拿不到就返回 `null`（`wiretap.mjs` 被删了 / 语法坏了）——**绝不因此拖垮记录服务**。 */
let _tapMod = null;
async function tapModule() {
    if (_tapMod !== null) return _tapMod || null;
    try { _tapMod = await import(new URL('./wiretap.mjs', import.meta.url).href); }
    catch (err) {
        _tapMod = false;
        horaeWarn('[hitOpt] 抓包模块（wiretap.mjs）读不到 —— 记录服务照常，但拿不到"真出网原文"：', err?.message || err);
    }
    return _tapMod || null;
}

/* ══ ★★★★★★ v6.27.2【异常日志 · 服务端本体】用户 2026-09-19 点名原话：
 *    「诶 我发现行动目标的自检少了 horae 异常日志的检查啊」
 *
 *  为什么非做不可（这条是**真缺口**，而且是我自己埋的）：
 *    酒馆那些 `[hitOpt] …写不进去 / 失败` 的警告**只打到控制台**，而控制台**不落盘**。
 *    实测（2026-09-19 14:41 用户截图）：三条 `[hitOpt] git 记录：状态文件写不进去: ENOENT …`
 *    在屏幕上滚过去，而盘上：`_diag.log`（抓包插件的）里 `ENOENT` **0 行**、
 *    酒馆目录下**没有任何一份日志文件**记着它 ⇒ **异常发生过、但我事后一个字都读不到**，
 *    只能靠用户截图猜。这违反第一重点那条【有就是有 没有就是没有】。
 *
 *  做了什么：把 `[hitOpt]` 的每一条 warn/error **同时**写一份 JSONL 落到
 *    `<本插件目录>/_errlog/YYYY-MM-DD.jsonl`（**本插件之外不落任何东西**，可用 HORAE_ERRLOG 覆盖）。
 *    ★ 2026-09-24【搬迁】："本插件目录" = `SillyTavern/plugins/hitopt-git/`（原先是 Horae 扩展目录）。
 *    记的是：时间 / 级别 / **tag（消息头那段，用来聚合指纹）** / 消息 / **完整堆栈**。
 *  接哪儿：自检新增 ⑥″ 项读它，把"最近有异常、哪一类、几次"直接报出来 —— 这就是用户要的那只眼睛。
 *  ⚠ 边界：写日志这件事**自己绝不许把正事搞挂**（写不进去就闭嘴丢掉，不抛、不递归、不打控制台）。
 *  ⚠ 只认 `[hitOpt]` 开头的那几条 —— 酒馆自己的日志不进这个文件（免得把别人的噪声算到我们头上）。
 *
 *  ★ v6.27.3【落点跟着**记录仓库根**走】—— 这一条是防"**测试替真机撒谎**"：
 *    验收里有 8 条会 `import` 本文件真跑服务端（`triad_save_test` / `four_views_test` / `dv_jump_test` …），
 *    它们都设了 `HORAE_GIT_ROOT` 指向**临时目录**，可异常日志原来只认 `HORAE_DIR`
 *    ⇒ 沙箱里跑出来的警告全写进了**工作台**的 `_horae_patch/_errlog/`（实测污染 **75 条假异常**）。
 *    那条文件一旦被人当成真机的异常日志读，就是"测试在替真机撒谎"—— 比没有日志更坏。
 *    ⇒ `HORAE_GIT_ROOT` 在场（＝沙箱）⇒ 日志落 `<它>/_errlog`，与那一次的 git 记录**同根**、一起消失；
 *      不在场（＝真机）⇒ 照旧落 `<本插件目录>/_errlog`（2026-09-24 搬迁后 = `plugins/hitopt-git/_errlog`）。
 *      **一个开关管住全部 8 条测试，不用逐个补。** */
const ERRLOG_DIR = process.env.HORAE_ERRLOG
    || path.join(process.env.HORAE_GIT_ROOT || HORAE_DIR, '_errlog');
/** 单条堆栈最大留多少字符（够定位就行；整份堆栈会把日志吹大） */
const ERRLOG_STACK_MAX = 1600;
/** 每个日志文件超过多大就滚一份 —— 只留最近 7 天，别让它无限长 */
const ERRLOG_MAX_BYTES = 2 * 1024 * 1024;
const errlogFiles = () => {
    const day = new Date().toISOString().slice(0, 10);
    return { day, p: path.join(ERRLOG_DIR, day + '.jsonl') };
};
/** 写一条异常记录（**绝不许抛**）。level: 'warn' | 'error' */
function horaeLogLine(level, tag, msg, err) {
    try {
        fs.mkdirSync(ERRLOG_DIR, { recursive: true });
        const { p } = errlogFiles();
        try { if (fs.statSync(p).size > ERRLOG_MAX_BYTES) fs.renameSync(p, p.replace(/\.jsonl$/, '') + '-' + Date.now() + '.jsonl'); } catch (_) { }
        const rec = {
            t: new Date().toISOString(), lv: level, tag: String(tag || '').slice(0, 120),
            msg: String(msg || '').slice(0, 4000),
            stack: String(err?.stack || '').split('\n').slice(0, 8).join('\n').slice(0, ERRLOG_STACK_MAX),
        };
        fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
    } catch (_) { /* 日志写不进去也绝不影响正事 */ }
}
/** 从一条 `[hitOpt] …` 消息里取**异常指纹（tag）**：剥前缀 → 归一化每轮都变的词 → 切到**分类位**。
 *  为什么要砍轮号/编号：同一个 bug 每轮都报一次，指纹必须**一模一样**才聚得起来（次数才有意义）。
 *
 *  ★★★★★★ v6.27.3 切法（2026-09-19 **实测后定版**，探针 `_tmp/probe_tag_v2.mjs` 拿 `index.mjs` 里
 *   **全部 19 条**真消息逐条量出来的）：
 *    ① 剥 `[hitOpt] ` 前缀；
 *    ② 归一化变量：`第 8 轮`→`第 N 轮`、`第 3 次`→`第 N 次`、`等了 90 秒`→`等了 N 秒`、
 *       磁盘路径→`<路径>`、其余数字→`N`、日期→`<日期>`；
 *    ③ **第一个全角冒号是模块名与事由的分界，必须留住**（`git 记录：` ← 分类第一层）；
 *    ④ 在事由部分切到第一个**分类标点**（`：`/`:`/`——`/`→`/`，`/`,`），**括号不算** ——
 *       括号里多是可变的补充（`（面板那几格会退成"—"）`、`（chat=…）`）；
 *    ⑤ 结果按 30 字截断。
 *
 *  ⛔ **两版被实测推翻的切法（别再回头试）**：
 *    · v1「切最后一个全角冒号（不够长退第一个）」—— 实测 19 条消息只切出 **3 个**指纹：
 *      **14 条完全不同的异常全被压成 `git 记录`**（抬头旁文件写不进去 / 状态文件写不进去 /
 *      占位文件写不进去 / 版本戳写不进去 / swipe 回滚失败 / 出网原文解析失败 … 全一类）
 *      ⇒ 自检报出的"这一类 14 次"**毫无诊断价值**，等于异常日志白建。
 *    · v2 初版「在整条消息里切第一个分类标点」—— 切到的正是模块名后那个全角冒号 ⇒ 同样退化成 `git 记录`
 *      （这就是"探针自己写错、量出来的数全是假的"那类错，靠打印每条的指纹才看见）。
 *
 *  实测两版对照（同一批 19 条真消息）：
 *    v1 → 3 个指纹（`git 记录`×14、`本地 token`×4、`git 记录【诊断】收到 /turn`×1）
 *    v3 → **19 个指纹，每条消息各自独立**，且**同一异常的两种实例（轮号/路径不同）指纹逐字相同**
 *      `…turns/00009.status.json` 与 `…turns/00013.status.json` ⇒ 都是 `git 记录：状态文件写不进去` */
function errTagOf(msg) {
    /* ★ 2026-09-24：日志前缀从 `[Horae]` 归位成 `[hitOpt]`（用户："后台日志也还用Horae，
     *   我们早就不是Horae魔改了，而是独立插件了"）⇒ 这里**两个都剥**：
     *   迁移期（页面还没 F5）客户端仍会发 `[Horae]`，而 `_errlog/` 里已经落盘的历史 tag
     *   也是按旧前缀剥出来的 —— 两个都认，指纹才不会因为换前缀而分裂。 */
    const body = String(msg || '').replace(/^(\[hitOpt\]|\[Horae\])\s*/, '')
        .replace(/第\s*\d+\s*轮/g, '第 N 轮')
        .replace(/第\s*\d+\s*次/g, '第 N 次')
        .replace(/等了\s*\d+\s*秒/g, '等了 N 秒')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<日期>')
        .replace(/[A-Za-z]:\\[^\s'”）)]+/g, '<路径>')
        .replace(/\d[\d,]*/g, 'N')
        .replace(/\s+/g, ' ').trim();
    const iM = body.indexOf('：');                       // ③ 模块名分界（留住它）
    if (iM < 0) return (body.slice(0, 30) || '未分类');
    const mod = body.slice(0, iM + 1);
    const rest = body.slice(iM + 1);
    const cut = rest.search(/[：:]|——|→|，|,/);           // ④ 事由里再切到第一个分类标点
    let kind = cut >= 0 ? rest.slice(0, cut) : rest;
    // ⑤ 收尾：分类位若正好停在左括号上 ⇒ 括号及里面全是**参数**（`（HEAD~1 不存在）`、`（chat=…）`），
    //    不是分类 ⇒ 切掉。判据来自实测：`swipe 回滚失败（HEAD~1 不存在）` 与
    //    `swipe 回滚失败（工作区脏）` 是**同一个异常**（swipe 回滚失败），只是原因不同 ⇒ 必须同指纹。
    kind = kind.replace(/[（(][^（()）]*[）)]?$/, '').trim();
    return ((mod + kind).trim().slice(0, 30) || '未分类');
}
/** 这一条要不要进异常日志：只认 `[hitOpt]` 开头的，且**排除【诊断】**类（那是给人看的信息，不是异常）。
 *  ★ 2026-09-24【前缀归位，**旧的也认**】：用户点名"后台日志也还用 Horae，我们早就是独立插件了"
 *    ⇒ 前端/服务端所有日志前缀都换成 `[hitOpt]`。但这一句是**两端耦合的判据**：
 *    页面还没 F5 时客户端发的仍是 `[Horae] …`，只认新前缀会让那些警告**静默不落盘**
 *    （正是"静默降级"那个反复踩的坑）。⇒ 两个前缀都收，永不失效。 */
const isErrLogWorthy = (msg) => {
    const s = String(msg);
    return (s.startsWith('[hitOpt]') || s.startsWith('[Horae]')) && !/【诊断】/.test(s);
};
/** 把一条 `[hitOpt] …` 警告**同时**打控制台 ＋ 落盘。返回那条消息（方便 `return horaeWarn(…)`）。 */
function horaeWarn(...args) {
    const msg = args.map(a => (a instanceof Error ? (a.message || String(a)) : String(a))).join(' ');
    try { console.warn(msg); } catch (_) { }
    if (isErrLogWorthy(msg)) horaeLogLine('warn', errTagOf(msg), msg, args.find(a => a instanceof Error));
    return msg;
}
/** 把一条 `[hitOpt] …` 错误**同时**打控制台 ＋ 落盘（同上，级别不同）。 */
function horaeErr(...args) {
    const msg = args.map(a => (a instanceof Error ? (a.message || String(a)) : String(a))).join(' ');
    try { console.error(msg); } catch (_) { }
    if (isErrLogWorthy(msg)) horaeLogLine('error', errTagOf(msg), msg, args.find(a => a instanceof Error));
    return msg;
}

/** 找到抓包插件的 `_diag.log` 真路径（找不到返回空串，让调用方如实说"没找到"）。 */
function findDiagLog() {
    for (const d of wireDirCands()) {
        const p = path.join(d, 'captures', '_diag.log');
        try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* 试下一个 */ }
    }
    return '';
}

/** 读 `_diag.log` 的**尾部**（这文件会长到几 MB，整读会拖慢请求）并解析成条目数组。
 *  只留最近 maxLines 条 —— 自检关心的是"最近发生了什么"，不是全部历史。 */
function readDiagTail(maxBytes = 512 * 1024, maxLines = 4000) {
    const p = findDiagLog();
    if (!p) return { path: '', items: [], mtime: 0 };
    let buf = '';
    let mtime = 0;
    try {
        const st = fs.statSync(p);
        mtime = st.mtimeMs;
        const start = Math.max(0, st.size - maxBytes);
        const fd = fs.openSync(p, 'r');
        try {
            const len = st.size - start;
            const b = Buffer.alloc(len);
            fs.readSync(fd, b, 0, len, start);
            buf = b.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch (_) { return { path: p, items: [], mtime }; }
    const lines = buf.split('\n');
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    const items = [];
    for (const line of lines) {
        const s = line.trim();
        if (!s || s[0] !== '{') continue;                 // 掐头那半行天然不是合法 JSON，跳过即可
        try { items.push(JSON.parse(s)); } catch (_) { /* 坏行跳过，不猜 */ }
    }
    return { path: p, items, mtime };
}

/* ── ★★★★★★ v6.27.2【异常日志的读与判】—— 自检 ⑥″ 项的两半，读盘与判据都只在这里出现一次 ────────
 *  读：`_errlog/` 里最近 `days` 天的 `.jsonl`（今天是主文件，历史上滚过的 `YYYY-MM-DD-<毫秒>.jsonl` 也算），
 *      按时间倒序留最近 `max` 条。**读不到就是空数组**（文件不存在是正常状态：这些天一次异常都没有）。
 *  判：按 tag 聚合，给"最近 N 小时有没有、几次、最近一次长什么样"—— **判据一律保守**：
 *      没有文件 = 一次异常都没有（这是 ✅ 不是"判不了"）；有异常就原样报 tag ＋ 次数 ＋ 那条消息，不修饰。 */
function readErrLog(days = 7, max = 200) {
    const out = [];
    let files = [];
    try {
        files = fs.readdirSync(ERRLOG_DIR).filter(f => /^\d{4}-\d{2}-\d{2}(-\d+)?\.jsonl$/.test(f)).sort();
    } catch (_) { return { dir: ERRLOG_DIR, files: [], items: [] }; }
    // 只取最后 `days` 个日期段（按文件名排序 = 按日期排序）
    const byDay = new Map();
    for (const f of files) { const d = f.slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(f); }
    const keepDays = [...byDay.keys()].sort().slice(-days);
    const keep = keepDays.flatMap(d => byDay.get(d));
    for (const f of keep) {
        let txt = '';
        try { txt = fs.readFileSync(path.join(ERRLOG_DIR, f), 'utf8'); } catch (_) { continue; }
        for (const line of txt.split('\n')) {
            const s = line.trim();
            if (!s || s[0] !== '{') continue;                       // 坏行跳过，不猜
            try { out.push(JSON.parse(s)); } catch (_) { }
        }
    }
    out.sort((a, b) => String(b.t).localeCompare(String(a.t)));      // 新的在前
    return { dir: ERRLOG_DIR, files: keep, items: out.slice(0, max) };
}
/** 判读异常日志 → 自检那一项要的形状与文案。`hours` = "最近多少小时算'最近'"。
 *
 *  ★ 2026-09-24【误报修掉：**把 info 也算成"警告"了**】
 *    实测（真机 `_errlog/2026-09-24.jsonl`）：自检报"最近 24 小时打过 **200** 条警告"，
 *    其中 **186 条是 `algo` 的 `info`**（"实验算法产物落盘 / 逐字节相同 ⇒ 跳过重写"那种**记账**），
 *    真正的 warn/error 只有 **14** 条。
 *    病根：`recent` 只按**时间**过滤，一眼都没看 `lv`（级别）。
 *    ⇒ 拆两档：`warns`（warn/error —— 这才是"警告"该有的含义，报警与计数都用它）
 *      与 `infos`（记账，**只报数、不报警、不进 todo**）。
 *  ⚠ 时间读不出来的仍然**算进 warn**（宁可多报不许漏报 —— 原来那条注释的意图原样保留）；
 *    **没写 `lv` 字段**的也算 warn（老日志可能没有这个字段，不能因为读不出级别就把它藏起来）。 */
function judgeErrLog(log, now, hours = 24) {
    const items = Array.isArray(log?.items) ? log.items : [];
    const since = now - hours * 3600 * 1000;
    const recent = items.filter(it => {
        const t = Date.parse(String(it?.t || ''));
        return !Number.isFinite(t) || t >= since;                    // 时间读不出来的**算进来**（宁可多报不许漏报）
    });
    /** 这条算不算"警告"。⚠ 没写级别 / 时间读不出来 ⇒ 一律算（宁可多报）。 */
    const isWarn = (it) => {
        const lv = String(it?.lv || '').toLowerCase();
        if (!lv) return true;
        return lv === 'warn' || lv === 'error';
    };
    const warns = recent.filter(isWarn);
    const infos = recent.filter(it => !isWarn(it));
    const byTag = new Map();
    for (const it of warns) {
        const k = String(it?.tag || '（没写 tag）');
        const cur = byTag.get(k) || { tag: k, n: 0, last: null };
        cur.n++; if (!cur.last) cur.last = it;                       // items 已按时间倒序 ⇒ 第一条就是最近那次
        byTag.set(k, cur);
    }
    const groups = [...byTag.values()].sort((a, b) => b.n - a.n);
    const lastAny = warns[0] || null;
    const age = lastAny ? Math.max(0, Math.round((now - Date.parse(String(lastAny.t))) / 1000)) : null;
    const when = age === null ? '' : (age < 3600 ? '（' + Math.max(1, Math.round(age / 60)) + ' 分钟前）' : '（' + Math.round(age / 3600) + ' 小时前）');
    return {
        dir: String(log?.dir || ERRLOG_DIR), files: (log?.files || []).length,
        总条数: items.length, 最近小时: hours,
        最近条数: warns.length,          // ★ 只数警告（原来把 info 也数进来了）
        最近info条数: infos.length,      // ★ 另报：记账条数，只陈述事实
        when, last: lastAny, groups,
        filesList: (log?.files || []).slice(-3),
    };
}

/* ⛔ 2026-09-24【不再看 Horae】删掉 `clientVerOnDisk()`：
 *  它读的是 `<Horae 扩展目录>/horae.client.js` 里的 `HORAE_CACHE_PATCH`（那是 **Horae 的文件**）。
 *  用户定版："我们的 hitOpt 已经独立了哦 原版 Horae 再怎么改都不关我们事情，有联动性问题，我们日后再修"
 *  ⇒ 与其改成"读不到就报未知"（那只是把依赖藏起来），不如**整项去掉** —— 自检的 ① 段已如实写"不再检查"。
 *  （`/selfcheck` 里那条"要不要 F5"的结论也随之删掉，见 ①′ 后面那段说明。） */

/** 一串心跳里最近的那条指定 tag（没有就 null）。 */
const lastTag = (items, tag) => { for (let i = items.length - 1; i >= 0; i--) if (items[i].tag === tag) return items[i]; return null; };

/** 一个记录仓库里 turns 的**最大编号 + 总数 + 重号**（重号 = 同一次重 roll 被记成两轮，实测踩到过）。 */
function turnsInfo(dir) {
    const out = { max: -1, count: 0, dup: [] };
    try {
        const nums = fs.readdirSync(path.join(dir, 'turns'))
            .map(f => (/^(\d{5})\.(?:txt|json)$/.test(f) ? Number(f.slice(0, 5)) : -1))
            .filter(n => n >= 0)
            .sort((a, b) => a - b);
        out.count = nums.length;
        out.max = nums.length ? nums[nums.length - 1] : -1;
        // 编号本该是 0,1,2… 连着；缺号不算错（重 roll 会覆盖），但**超出 max 的重复**要报
        const seen = new Set();
        for (const n of nums) { if (seen.has(n)) out.dup.push(n); seen.add(n); }
    } catch (_) { /* 没有 turns/ 就是空仓库 */ }
    return out;
}

/** 读一轮的归档抬头（`turns/NNNNN.meta.txt` 那一行）—— 版本戳就在这里，是"这一轮谁写的"的硬证据。
 *  老记录（v6.24.69 之前）没有版本戳那一段 ⇒ 三个字段给空串，**不猜**。 */
function readTurnMeta(dir, no) {
    if (!Number.isFinite(no) || no < 0) return null;
    const p = path.join(dir, 'turns', `${String(no).padStart(5, '0')}.meta.txt`);
    try {
        const head = fs.readFileSync(p, 'utf8').split('\n')[0] || '';
        const m = /版本 cli=(\S+) srv=(\S+) tok=(\S+)/.exec(head);
        const mt = /# wire \| (\d+) tok/.exec(head);
        const mb = /\| (\d+) 字节 \|/.exec(head);
        const mm = /\| (\d+) msgs \|/.exec(head);
        const mc = /\| ([\d,]+) 字 \|/.exec(head);
        return {
            no, head: head.slice(0, 220),
            verCli: m ? m[1] : '', verSrv: m ? m[2] : '', tokSrc: m ? m[3] : '',
            tok: mt ? Number(mt[1]) : null,
            bytes: mb ? Number(mb[1]) : null,
            msgs: mm ? Number(mm[1]) : null,
            chars: mc ? Number(mc[1].replace(/,/g, '')) : null,
        };
    } catch (_) { return null; }
}

/** ★ v6.24.110：记录仓库清单（**一处算法** —— ① 段与 ③ 段都调它，别再各写一遍同样的排序）。
 *  顺序 = 目录 mtime 最新者在前（"最近还在写的那一场"）。纯读盘，无副作用。 */
function listChatRepos(ROOT) {
    try {
        return fs.readdirSync(ROOT, { withFileTypes: true })
            .filter(e => e.isDirectory() && isOurRepo(path.join(ROOT, e.name)))
            .map(e => ({ name: e.name, at: lastActiveMs(path.join(ROOT, e.name)) }))
            .sort((a, b) => b.at - a.at);
    } catch (_) { return []; }
}

/* ⛔ 2026-09-24【不再看 Horae】删掉 `bootBelongsToChat()`（★ v6.24.110 加的那一段）。
 *  它是为"那条 `client:boot` 到底是不是**正在聊天的那一页**报的"服务的 —— 那一整条判读
 *  （连同它服务的"要不要按 F5"结论）都建立在 **Horae 魔改客户端发的心跳**上。
 *  用户定版："我们的 hitOpt 已经独立了哦 原版 Horae 再怎么改都不关我们事情" ⇒ 随之一起去掉。
 *  它守的那个不变量（"自检不许拿别的页面的心跳当证据撒谎"）**不再需要** —— 自检已经不看那个心跳了。 */

/** 组装自检结论（**纯读盘**）。
 *  八项，每一项都回答"要不要用户做点什么"；判不出来就如实说判不出来（不猜）。
 *  ★ v6.24.76 起是 async：第 ④″ 项要现算"本地 vs 官方"的那个 token（真分词器），算不出来照样如实报。
 *  ★ 2026-09-24：① 段改成"已不再检查 Horae 客户端版本"（用户定版，见那一节）；
 *    ①″（要不要 F5）与 ④ 段里那条"这一轮是旧客户端写的"一并删掉。
 *  @returns {Promise<{ok:boolean, at:number, v:number, checks:Array, todo:Array, md:string}>} */
async function buildSelfCheck(ROOT) {
    const now = Date.now();
    const checks = [];
    const todo = [];
    const say = (level, text) => checks.push({ level, text });
    /** 一件"要用户做的事"：who = user / nobody */
    const need = (what, why) => todo.push({ who: 'user', what, why });

    /* ── ① 客户端版本：**已不再检查**（2026-09-24 用户定版）────────────────────────
     *  这里原来读 `<Horae 扩展目录>/horae.client.js` 的 `HORAE_CACHE_PATCH`、再与页面
     *  `client:boot` 心跳对，判"要不要按一次 F5"（`needF5`），并写进 todo。
     *  用户原话：「我们的 hitOpt 已经独立了哦 原版 Horae 再怎么改都不关我们事情，有联动性问题，我们日后再修」
     *  ⇒ **整项删掉**（连同 `clientVerOnDisk()` / `bootBelongsToChat()` 与 `needF5` 那一整套判据）：
     *    · 那一项读的是 **Horae 的文件** —— 那就是"依赖 Horae"，与"hitOpt 独立"直接冲突；
     *    · Horae 回原版 `index.js` 之后，`horae.client.js` 在那个目录里根本不存在；
     *    · `client:boot` 是**魔改客户端**发的埋点，随它一起下线 ⇒ 那一项永远判不出来。
     *  ⛔ 不是改成"读不到就报未知" —— 那只是把依赖藏起来。
     *  ✅ 属于**我们自己**的两件事照旧报：② 抓包插件（我们自己的插件）、③ 记录仓库。
     *  ✅ 下面 ②′ 保留**读我们自己记录抬头**的版本戳（`cli=` 谁写的 / `srv=` 哪版服务端写的）。
     *  ⚠ 响应里 `client` 这个键**如实写明"不再检查"**，不用 `?` / `未知` 占位。 */
    const diag = readDiagTail();
    /* `reqCli` / `reqSrv` / `reqTurn` 在 ②′ 段拿到（声明放这儿是为了让响应字段的形状固定：
     *  永远有这几个键 —— 拿不到就是空串，**不猜、不省字段**）。 */
    const client = {
        checked: false,
        note: '已不再检查 Horae 客户端版本（hitOpt 已独立）',
        reqCli: '', reqSrv: '', reqTurn: '',
    };
    say('info', '① 客户端版本：**已不再检查** —— ' + client.note
        + '　（要判"服务端要不要重启"看下面 ①′ 的 srv= 与 /status 的 v；那是**我们自己**的版本）');

    /* ── ①′ 最新一轮记录抬头里的版本戳（**只念我们自己的留档**）─────────────────────
     *  ★ 2026-09-24【不再看 Horae】：这一段原来还负责判"**真正发请求的那一页**是不是旧的"
     *    （拿抬头的 `cli=` 与"盘上客户端文件的版本"比）—— 那一半随 ① 一起去掉。
     *    留下的是一件**属于我们自己的事实**：最新一轮的抬头写着 `cli=… srv=… tok=…`
     *    ——「这一轮是哪一版客户端发的、哪一版服务端写的」。它是**记录自己的留档**，不是对 Horae 的检查。
     *  ⚠ 顺手把 ④ 段要的"服务端新旧"也接上：`srv=` 与 `ROUTE_V` 比 ⇒ 那才是"要不要重启酒馆"。 */
    let reqCli = '', reqSrv = '', reqTurn = '';
    try {
        const root = defaultRoot();
        let best = null;
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const t = path.join(root, d.name, 'turns');
            let files = [];
            try { files = fs.readdirSync(t).filter(f => /^\d{5}\.meta\.txt$/.test(f)); } catch (_) { continue; }
            if (!files.length) continue;
            let mx = -1;
            for (const f of files) mx = Math.max(mx, Number(f.slice(0, 5)));
            if (mx < 0) continue;
            const mp = path.join(t, String(mx).padStart(5, '0') + '.meta.txt');
            let mt = 0; try { mt = fs.statSync(mp).mtimeMs; } catch (_) { }
            if (!best || mt > best.mt) best = { d: d.name, no: mx, mt, mp };
        }
        if (best) {
            let head = ''; try { head = fs.readFileSync(best.mp, 'utf8'); } catch (_) { }
            const cm = /版本 cli=(\S+) srv=(\S+)/.exec(head);
            reqTurn = best.d + ' #' + best.no;
            if (!cm) {
                say('info', '①′ 最新一轮（' + reqTurn + '）抬头里没有版本戳 —— 那是 v6.24.69 之前的记录，不猜。');
            } else {
                reqCli = cm[1]; reqSrv = cm[2];
                const srvOld = (reqSrv && reqSrv !== String(ROUTE_V));
                say(srvOld ? 'warn' : 'ok',
                    '①′ 最新一轮（' + reqTurn + '）抬头：cli=' + reqCli + ' srv=' + reqSrv
                    + (srvOld
                        ? '　⇒ 那一轮是 **srv=' + reqSrv + '** 写的，而正在跑的这个模块是 srv=' + ROUTE_V
                          + ' ⇒ 酒馆是**后来才重启**的（这不是问题，只是对账时别拿新旧两个服务端的记录混着比）。'
                        : '　（只念**我们自己记录**的留档，**不**与任何"盘上客户端版本"比）'));
            }
        } else {
            say('info', '①′ 记录仓库里还没有任何带抬头的轮次 —— 这一项先不判。');
        }
    } catch (e) { say('info', '①′ 判读失败（不影响别的）：' + String(e?.message || e).slice(0, 80)); }
    // ①′ 拿到的三个值挂到响应上（**正常路与异常路都挂** —— 拿不到就是空串，不猜）
    client.reqCli = reqCli; client.reqSrv = reqSrv; client.reqTurn = reqTurn;

    /* ⛔ 2026-09-24 删掉 ①″【统一判定"到底要不要 F5"】整整一段 ——
     *  它的三个证据里有两个（`client:boot` 心跳、`bootMine` 时间配对）都是**Horae 魔改客户端**的东西，
     *  剩下的那个（抬头 `cli=`）现在只当"这一轮是谁写的"如实念出来（见 ①′）。
     *  ⇒ `needF5` / `pageNew` / `why` 三个字段**一并从响应里去掉**（不拿 '?' / '未知' 占位）。 */

    /* ── ② 抓包插件（"自动检测"的眼睛）── */
    const wire = { dir: findDiagLog() ? path.dirname(path.dirname(diag.path)) : '', diag: diag.path, mtime: diag.mtime, items: diag.items.length, candidates: wireDirCands() };
    if (!diag.path) {
        say('warn', '没找到抓包插件的 captures/_diag.log —— 诊断的"眼睛"缺席，下面几项都判不了。');
        say('info', '找过这些位置：' + wire.candidates.map(d => path.join(d, 'captures', '_diag.log')).join('　'));
    } else {
        const age = now - diag.mtime;
        say('ok', '抓包插件在：' + diag.path + '（读了最近 ' + diag.items.length + ' 条心跳，最后一次写入 '
            + Math.round(age / 1000) + ' 秒前）');
    }

    /* ── ③ 记录仓库：几个、满没满、最新那个几轮 ── */
    // 清单用 `listChatRepos`（**一处算法** —— 自检里只有这一处调它，别再各排一次序）
    const chats = listChatRepos(ROOT);
    const keep = CHAT_KEEP;
    const free = Math.max(0, keep - chats.length);
    const newest = chats[0] || null;
    const ti = newest ? turnsInfo(path.join(ROOT, newest.name)) : { max: -1, count: 0, dup: [] };
    const repos = { count: chats.length, keep, free, atLimit: chats.length >= keep, newest: newest ? newest.name : '', turns: ti.count, maxTurn: ti.max, dupTurns: ti.dup };
    if (!chats.length) {
        say('warn', '记录仓库里一个聊天仓库都没有 —— 还没记过任何一轮？');
    } else if (repos.atLimit) {
        /* ★ 2026-09-24【用户定版：**"记录仓库30上限是有意的设定 省的垃圾挤满"**】
         *   ⇒ 这里**不是**"要用户做什么"，是**设计使然**：满了就让最旧的自动淘汰、磁盘不被堆满。
         *   上一版报成 `warn` 且派了一条"把要留的旧仓库挪进 _retired/"的待办 —— 那是**误报**：
         *   自动淘汰正是用户要的，反过来要求他手动清是搞反了。
         *   仍然如实把事实说全（"下一场会淘汰最旧那个"＋那个是谁），免得哪天他发现某场不见了却不知道为什么。 */
        say('info', '记录仓库 ' + chats.length + ' / ' + keep + '（上限 ' + keep + ' 是**设计使然**：'
            + '只留最近 ' + keep + ' 场，让旧的自动淘汰、磁盘不会被堆满）。'
            + '再开新聊天会淘汰最旧那个：' + (chats.length ? chats[chats.length - 1].name : '（无）')
            + '。想留哪一场，趁早把它挪进 _retired/。');
    } else {
        say('ok', '记录仓库 ' + chats.length + ' 个（上限 keep=' + keep + '，还能再开 ' + free + ' 场才开始清最旧的）。最新：'
            + (newest ? newest.name + '（' + ti.count + ' 轮）' : '（无）'));
    }
    if (ti.dup.length) say('warn', '最新那个仓库里有**重号**的轮次：' + ti.dup.join('、') + ' —— 那是同一次重 roll 被记成了两轮。');

    /* ── ④ 最近一轮写成了什么样（版本戳是"谁写的"的硬证据）── */
    let lastTurn = null;
    if (newest && ti.max >= 0) {
        lastTurn = readTurnMeta(path.join(ROOT, newest.name), ti.max);
        if (!lastTurn) {
            say('warn', '最新一轮的抬头（turns/' + String(ti.max).padStart(5, '0') + '.meta.txt）读不出来。');
        } else if (!lastTurn.verCli) {
            say('info', '最新一轮（第 ' + ti.max + ' 轮）的抬头里**没有版本戳** —— 那是 v6.24.69 之前的老记录，不是问题。');
        } else {
            say('ok', '最新一轮（第 ' + ti.max + ' 轮）：' + lastTurn.verCli + ' / srv=' + lastTurn.verSrv + ' / tok=' + lastTurn.tokSrc
                + '（' + (lastTurn.chars != null ? lastTurn.chars.toLocaleString('en-US') : '?') + ' 字）');
            /* ⛔ 2026-09-24 删掉这里那条 `if (onDisk && lastTurn.verCli !== onDisk) → warn "…要 F5"`：
             *  它的前提（"盘上客户端版本"）来自 **Horae 的文件**，已随 ① 整项去掉。
             *  `verCli` 本身照旧念出来（那是**记录自己**写下的"谁发的"）。 */
            if (lastTurn.verSrv && lastTurn.verSrv !== String(ROUTE_V)) {
                say('warn', '这一轮是 **srv=' + lastTurn.verSrv + '** 写的，而正在跑的这个模块是 srv=' + ROUTE_V
                    + ' ⇒ 说明酒馆是**后来才重启**的（这不是问题，只是对账时别拿新旧两个服务端的记录混着比）。');
            }
        }
    }

    /* ── ④′ 四视图一致性（目标⑧，用户 2026-09-17 点名："面板与本地文件与差异页与发给官方的文件，
     *   都是一个文件 是从不同角度观察的数据"／"检查是否这个一致性，一致性不一致肯定要修"）──
     *   权威 = `turns/NNNNN.txt`（抓包截下的真 POST body，逐字节）；另外三个都只是它的**读法**：
     *   `GET /flat` 铺平（与 `parseTurnFile` 走同一个 `flattenWire`）、`/log` 那三列、归档抬头。
     *   这里拿最新一轮做一次对账：**正文铺平出来的逐条字数之和**必须与**抬头那格「N 字」**对得上
     *   （抬头是客户端发送那一刻写的，允许"条尾空白"级别的差 —— 实测每条 0~2 字）。
     *   ⚠ 差出量级就说明写入那一步真漏了东西，那时面板/差异页量到的东西也就不可信了。 */
    let views = null;
    let chars3 = null;          // ★ v6.24.115：这一轮字数的**三个都对的口径**，一并报出来
    let dup = null;             // ★ v6.24.116：这一轮新增区里的**同轮内自重复**（本轮新写内容，可优化）
    if (newest && ti.max >= 0) {
        try {
            const vdir = path.join(ROOT, newest.name);
            const vno = String(ti.max).padStart(5, '0');
            /* ★ v6.51.1：正文真名两可（`.json` 优先、老轮次退 `.txt`）。 */
            const vgot = readTurnText(vdir, ti.max, 'body');
            if (!vgot) throw new Error('这一轮的正文读不出来');
            const vraw = vgot.text;
            let vmeta = '';
            try { vmeta = fs.readFileSync(path.join(vdir, 'turns', vno + '.meta.txt'), 'utf8'); } catch (_) { }
            const pr = parseTurnFile(vraw, vmeta);
            const vMsgs = pr.items.length, vBody = pr.bodyChars, vTotal = pr.totalChars;
            const vGap = (pr.chars === null || pr.chars === undefined) ? null : Math.abs(pr.chars - vBody);
            const vOk = (vGap === null) || (vGap <= vMsgs * 4);
            views = { no: ti.max, msgs: vMsgs, totalChars: vTotal, bodyChars: vBody, headChars: pr.chars, gap: vGap, ok: vOk };
            /* ★★ v6.24.115【口径归一】同一轮有**三个都对、来源不同**的字数 —— 不写清就会每次都要人肉复算。
             *   实测 `圣樱学院_mu5sd7sejhp0 #49`（离线在**临时 ROOT** 上真跑本函数得到，不在生产库上跑 init）：
             *     `/flat`     117,571 = `flattenWire` 原样，**每条前面带一行标记** `── #N role ──`
             *     `/log`      116,654 = 逐条正文剥尾部换行后 `join('\n')` —— 与**盘上原文逐条**同一个口径
             *     抬头 `N 字` 116,765 = 客户端发送那一刻数的（比逐条正文和多 **111**，是条尾空白）
             *   ⇒ `marker = 917` ≈ 42 条 × 标记行；`tail = 111` = 条尾空白。
             *   ⚠ 更正一条我自己上轮报错的结论：**`flattenWire` 并不折叠连续空行** ——
             *     `/log.totalChars` 与"盘上逐条 `body()` + `join('\n')`"**逐位相等**（都是 116,654）；
             *     `views.gap = 152` 是**抬头那格**与逐条正文和之差，不是折叠。 */
            try {
                let vFlat = null, vDiskRaw = null, vTail = null;
                try { if (wireBodyShape(vraw)) vFlat = flattenWire(vraw, 0, null).text.length; } catch (_) { }
                try {
                    const jm = JSON.parse(vraw);
                    if (Array.isArray(jm.messages)) {
                        vDiskRaw = jm.messages.reduce((a, m) => a + String(m.content ?? '').length, 0);   // 不剥尾换行、不 join
                        vTail = vDiskRaw - jm.messages.map(m => String(m.content ?? '').replace(/[\r\n]+$/, '')).join('\n').length;  // 条尾空白
                    }
                } catch (_) { }
                chars3 = {
                    no: ti.max,
                    flat: vFlat,                       // /flat：flattenWire 原样（每条带标记行）
                    log: vTotal,                       // /log：逐条正文 + 条间换行（与盘上原文同口径）
                    disk: vDiskRaw,                    // 盘上原文：逐条 content 原长之和（不剥、不 join）
                    head: (pr.chars === null || pr.chars === undefined) ? null : pr.chars,   // 抬头那格「N 字」
                    marker: (vFlat === null) ? null : (vFlat - vTotal),                      // 标记行的量
                    tail: vTail,                                                             // 条尾空白的量
                };
                say('ok', '同轮三个字数（都对、口径不同，第 ' + ti.max + ' 轮）：/flat '
                    + (vFlat === null ? '—' : Number(vFlat).toLocaleString('en-US')) + '（含每条标记行 ' + chars3.marker + '）｜/log '
                    + vTotal.toLocaleString('en-US') + '（逐条正文，与盘上原文同口径）｜抬头那格 '
                    + (chars3.head === null ? '—' : Number(chars3.head).toLocaleString('en-US')) + '（条尾空白 ' + chars3.tail + '）');
            } catch (_) { }

            /* ★★ v6.24.116【轮内自重复】—— 只算"**落在本轮公共前缀之外、且它自己首次出现也在前缀之外**"的重复，
             *   也就是"这一轮新写进去的字里自己重复自己"。判据的口径（第一版错在这里，见 STATE.md）：
             *     ⚠ "同一行出现 ≥2 次"**不等于**浪费 —— 每个**历史楼层**自带的重复模板
             *       （实测 `mu5sd7sejhp0 #33` 那段 329 字的 `<UpdateVariable>` 规范出现 21 次、行号均匀分布）
             *       属**既往已发内容** ⇒ 红线内一个字节都不许删 ⇒ **不计入**。
             *   实测样本（`mu5rg2rr3wm2 #8`）：同一份 5,367 字的派生清单在 body 里贴了 3 次，
             *     由 `horae.client.js:28388` 的 `RESTORE_ADD_HEAD2`（"上一轮那一版原样留在上面"）产生 ——
             *     **新版与旧版逐字节相同时**那份尾部副本信息量为零、对缓存是纯 miss。此处只**报数**，不改提示词。 */
            try {
                const pvNo = ti.max - 1;
                if (pvNo >= 0) {
                    let praw = '';
                    /* ★ v6.51.1：正文真名两可（`.json` 优先、老轮次退 `.txt`）。 */
                    try { praw = readTurnText(vdir, pvNo, 'body')?.text || ''; } catch (_) { }
                    if (praw) {
                        const A = parseTurnFile(praw, '').items.map((x) => x.text).join('\n');
                        const C = pr.items.map((x) => x.text).join('\n');
                        let dd = 0; const mn = Math.min(A.length, C.length);
                        while (dd < mn && A[dd] === C[dd]) dd++;
                        let off = 0, nd = 0, nl = 0;
                        const firstAt = new Map(), seen = new Map();
                        for (const l of C.split('\n')) {
                            const st = off; off += l.length + 1;
                            if (st < dd) continue;
                            if (!firstAt.has(l)) firstAt.set(l, st);
                            const c = (seen.get(l) || 0) + 1; seen.set(l, c);
                            if (c >= 2 && firstAt.get(l) >= dd && l.length >= 20) { nd += l.length + 1; nl++; }
                        }
                        // ⚠ **整条**重复副本必须与"行级"分开报 —— 上界 ≠ 可省（见 STATE.md「甲案结案」）：
                        //   行级 85,973 字 vs 整条 18,208 字，差 4.7 倍；只有"整条"那部分才是
                        //   "不再贴尾部副本"真能拿到的量。同一个数被误读一次就够了，这里两个都给。
                        const tset = new Set(); let iDup = 0, iChars = 0, iOff = 0;
                        for (const it of pr.items) {
                            const t = it.text;
                            if (iOff >= dd && t.length >= 20 && tset.has(t)) { iDup++; iChars += t.length; }
                            tset.add(t); iOff += t.length + 1;
                        }
                        dup = {
                            no: ti.max, lcp: dd, newChars: C.length - dd,
                            dupLines: nl, dupChars: nd,                 // 行级：**上界**
                            itemDup: iDup, itemDupChars: iChars,        // 整条：**甲案真能拿到的**
                        };
                        if (nd > 0 && nl > 0) {
                            say('info', '★ 第 ' + ti.max + ' 轮：新增区 ' + (C.length - dd).toLocaleString('en-US')
                                + ' 字里 **' + nd.toLocaleString('en-US') + ' 字是同轮内自己重复**（' + nl + ' 行，**上界**）；'
                                + '其中**整条**完全重复的只有 ' + iChars.toLocaleString('en-US') + ' 字（' + iDup + ' 条，**真能省**）。'
                                + '历史楼层自带的重复模板不计入。');
                        }
                    }
                }
            } catch (_) { }
            if (vOk) {
                say('ok', '四视图一致（第 ' + ti.max + ' 轮）：盘上原文铺平后 ' + vMsgs + ' 条 / '
                    + vTotal.toLocaleString('en-US') + ' 字'
                    + (pr.chars === null || pr.chars === undefined
                        ? '；这份老记录抬头没写字数（不是问题）'
                        : '；抬头 ' + Number(pr.chars).toLocaleString('en-US') + ' 字（差 ' + vGap + '，条尾空白的量级）'));
            } else {
                say('warn', '四视图**对不上**（第 ' + ti.max + ' 轮）：正文铺平逐条之和 ' + vBody.toLocaleString('en-US')
                    + ' 字，而抬头写着 ' + Number(pr.chars).toLocaleString('en-US') + ' 字（差 ' + vGap + '）'
                    + ' ⇒ 写入那一步可能漏了东西，面板量到的也就不可信了。');
                need('看一眼第 ' + ti.max + ' 轮的记录是不是写坏了', '抬头与正文差 ' + vGap + ' 字');
            }
        } catch (verr) {
            say('info', '四视图一致性这一项没算出来：' + String(verr?.message || verr) + '（不影响别的判读）');
        }
    }

    /* ── ④″ 本地 vs 官方：**差必须 0**（用户 ⑩，与①⑨并列最高优先级）─────────────────
     *   原话："要求 找出本地计算与官方usage偏差的原因，哪怕是1的偏差都不可以放过，必须对齐算法…
     *          我的要求是0偏差"
     *   这里就报用户点名的那一句：「最新一轮：本地 vs 官方 差 N」。
     *   权威口径（v6.24.76 定版）：本地 = **服务端在盘上那份真出网原文上、用酒馆那份真 DeepSeek 分词器
     *   现算**的 prompt token（`tokExact`）；官方 = usage.json 里那一轮最后到的 prompt_tokens。
     *   ★ v6.24.85：**现算优先，抬头只当兜底** —— 抬头是写入那一刻用当时那版算法算的数，
     *   算法一升级它就成了旧口径（这正是"抬头读着 +1…+7、现算是 0"的来源）。
     *   全仓 38 轮真样本实测：现算 **37 轮差 0**（唯一例外是已定案的重 roll 灾难轮）。
     *   差非 0 就是真出问题了（换模型 / 换词表 / 原文被改写 / 分词器加载失败）。 */
    let align = null;
    if (newest && ti.max >= 0) {
        try {
            const adir = path.join(ROOT, newest.name);
            const ano = String(ti.max).padStart(5, '0');
            /* ★ v6.51.1：正文真名两可（`.json` 优先、老轮次退 `.txt`）—— 读不到就抛，外层 catch 照旧兜。 */
            const _ag = readTurnText(adir, ti.max, 'body');
            if (!_ag) throw new Error('第 ' + ti.max + ' 轮的正文读不出来');
            const araw = _ag.text;
            if (!wireBodyShape(araw)) {
                say('info', '本地 vs 官方这一项跳过：第 ' + ti.max + ' 轮是**老记录**（铺平文本，不是出网原文）—— '
                    + '那种形状数出来的 token 与官方不可比，如实不算（不拿它冒充 0 偏差）。');
            } else {
                let ameta = '';
                try { ameta = fs.readFileSync(path.join(adir, 'turns', ano + '.meta.txt'), 'utf8'); } catch (_) { }
                const ap = parseTurnFile(araw, ameta);
                let aTok = await exactPromptTokCached('sc|' + ti.max + '|' + araw.length, araw);
                if (!Number.isFinite(aTok)) {
                    // 现算不出来（没词表 / 环境异常）才退回抬头存档 —— 见上面一段：抬头是历史口径。
                    aTok = (Number.isFinite(Number(ap.exactTok)) && Number(ap.exactTok) > 0) ? Number(ap.exactTok) : null;
                }
                const au = readUsage(adir)[String(ti.max)] || null;
                const aOff = (au && Number.isFinite(Number(au.promptTok)) && Number(au.promptTok) > 0) ? Number(au.promptTok) : null;
                align = { no: ti.max, local: aTok, official: aOff, diff: (aTok !== null && aOff !== null) ? (aTok - aOff) : null };
                if (aTok === null) {
                    say('warn', '本地 vs 官方**算不出来**：拿不到酒馆那份 DeepSeek 分词器（面板那几列会显示 —）。');
                    need('让本地 token 能算出来', '分词器没接上（看酒馆窗口里以 [hitOpt] 本地 token 开头那一行）');
                } else if (aOff === null) {
                    say('info', '本地 token = ' + aTok.toLocaleString('en-US') + '（第 ' + ti.max + ' 轮）；官方 usage 还没回来，暂时无从对账。');
                } else if (aTok === aOff) {
                    say('ok', '★ 本地 vs 官方（第 ' + ti.max + ' 轮）：**差 0** —— 本地 ' + aTok.toLocaleString('en-US')
                        + '，官方 ' + aOff.toLocaleString('en-US') + '（同一串字、同一套分词）。');
                } else {
                    const dd = aTok - aOff;
                    /* ★ 2026-09-24【这一条也不该派给用户】差那 2 个 token 是**早先定过案的 ⑩ 类例外**：
                     *   官方口径 `prompt_tokens = Σ encode(content) + 2×条数 + 28`，个别轮因为 chat 模板里
                     *   那点可观测的差异落在 ±2（`check/four_views_test.mjs` 的 KNOWN_EXCEPTIONS 里列着）。
                     *   它不是"坏了"、也**没有可执行的下一步** ⇒ 上一版派一条"把差修到 0"的待办是误报，
                     *   而且更要命：它会让"什么都不用做"永远不出现（用户每次看自检都以为有事要干）。
                     *   ⇒ 仍然如实报数，只是**不再要人做事**；只有差得超过已知口径差才升成 warn。 */
                    say(Math.abs(dd) <= 4 ? 'info' : 'warn',
                        '本地 vs 官方（第 ' + ti.max + ' 轮）：本地 ' + aTok.toLocaleString('en-US')
                        + '，官方 ' + aOff.toLocaleString('en-US') + '，差 ' + (dd > 0 ? '+' : '') + dd.toLocaleString('en-US')
                        + (Math.abs(dd) <= 4
                            ? ' —— 这 2 个 token 是**已定案的口径差**（chat 模板每条那 2 token），不用管。'
                            : ' ⇒ 差得超过已知口径差，要查这一轮的出网原文有没有被改写、模型/词表是不是换了。'));
                }
            }
        } catch (aerr) {
            say('info', '本地 vs 官方这一项没算出来：' + String(aerr?.message || aerr) + '（不影响别的判读）');
        }
    }

    /* ── ④‴ ★★★ v6.24.104：**思考模式一切换，官方缓存就换域**（"两边各说各话"的可解释原因）──
     *   用户 ⑩ 那条要求"面板本地 vs 官方逐轮对账，**差必须能解释**"。这一条补的就是最常见的那类差。
     *   实测（`圣樱学院_mu5q3ymmo3ld`，全仓 100 轮里**唯一**一次中途切思考模式）：
     *     #0 `thinking.enabled`  prompt 21,731 → hit **21,504**（99.0%）
     *     #1 `thinking.disabled` prompt 27,771 → hit **0**（0.0%）      ← 换域，整段全价
     *     #2 `thinking.disabled` prompt 35,141 → hit **27,392**（77.9%）← 同域，命中上一发
     *     #3 `thinking.enabled`  prompt 42,263 → hit **19,968**（47.2%）← 切回来又几乎全价
     *   ⇒ 代价是**两轮全价**（去一趟 + 回一趟），这两轮的 miss 合计 50,066 tok。
     *   机制：官方上下文缓存**不跨"思考模式"共享** —— 同为 disabled 的 #1→#2 立刻命中，
     *     而 enabled→disabled、disabled→enabled 两次都断。**这是从官方数反推的，不是官方文档；
     *     样本只有这一处**（全仓 98 轮 enabled / 2 轮 disabled），如实标注，不当作已证定理。
     *   为什么放进自检：换域时**本地按字节前缀算出 71%、官方却是 0%** —— 两边都没算错，
     *     差的来源就是它；不写出来，用户只会看到"面板和官方对不上"。 */
    if (newest && Number.isFinite(ti.max) && ti.max >= 1) {
        try {
            const tdir = path.join(ROOT, newest.name, 'turns');
            const thinkOf = (no) => {
                /* ★ v6.51.1：正文真名两可（`.json` 优先、老轮次退 `.txt`）。 */
                const _g = readTurnText(path.join(ROOT, newest.name), no, 'body');
                if (!_g) throw new Error('这一轮的正文读不出来');
                return String(JSON.parse(_g.text)?.thinking?.type || '');
            };
            const cur = thinkOf(ti.max), prev = thinkOf(ti.max - 1);
            if (cur && prev && cur !== prev) {
                say('warn', '★ 最新一轮（第 ' + ti.max + ' 轮）的**思考模式变了**：上一轮 `thinking=' + prev
                    + '`，这一轮 `' + cur + '`。官方上下文缓存**不跨思考模式共享** ⇒ 这一轮开头那段本来能命中的内容会**整段全价**'
                    + '（实测反例：`mu5q3ymmo3ld` #0→#1 命中 21,504→**0**；切回来 #2→#3 也只有 47.2%）。');
                need('中途别切思考模式（切一次要付两轮全价）', '第 ' + ti.max + ' 轮 thinking 从 ' + prev + ' 变成 ' + cur);
            } else if (cur) {
                say('ok', '最新一轮（第 ' + ti.max + ' 轮）的思考模式与上一轮一致（`thinking=' + cur + '`）—— 官方缓存不会因此换域。');
            }
        } catch (terr) {
            say('info', '思考模式这一项没算出来：' + String(terr?.message || terr).slice(0, 80) + '（不影响别的判读）');
        }
    }

    /* ── ⑤ 面板 / 差异页最近一次心跳 ── */
    const lastPanel = lastTag(diag.items, 'panel:diff');
    const lastDv = lastTag(diag.items, 'dv:page');
    const panel = lastPanel ? { rows: Number(lastPanel.rows) || 0, shown: Number(lastPanel.shown) || 0, hidden: Number(lastPanel.hidden) || 0, chat: String(lastPanel.chat || ''), chatLen: Number(lastPanel.chatLen) || 0 } : null;
    const dv = lastDv ? { patchLen: Number(lastDv.patchLen) || 0, hasHunks: Number(lastDv.hasHunks) || 0, emptyNote: Number(lastDv.emptyNoteLen) || 0, err: String(lastDv.patchErr || ''), chat: String(lastDv.chat || '') } : null;
    if (!panel) say('info', '还没见到面板心跳（panel:diff）—— 面板没打开过？');
    else if (panel.rows === 0) {
        // 0 行有两种：这个聊天在 _gitlog 里还没有仓库（正常）／有仓库却一条没拿到（真异常）
        const dirName = String(panel.chat || '').replace(/::/g, '_');
        const hit = chats.find(c => c.name === dirName) || chats.find(c => c.name.endsWith(String(panel.chat || '').split('::').pop() || '\u0000'));
        if (!hit) say('ok', '面板 0 行，但**这是正常的** —— 这场聊天（' + (panel.chat || '?') + '）在 _gitlog 里还没有仓库。');
        else {
            const t = turnsInfo(path.join(ROOT, hit.name));
            if (t.count === 0) say('ok', '面板 0 行，但**这是正常的** —— 仓库 ' + hit.name + ' 里还没有轮次。');
            else { say('warn', '面板 0 行，而仓库 ' + hit.name + ' 里明明有 ' + t.count + ' 轮 ⇒ **这是真异常**（记录在、面板却没拿到）。'); need('看一眼面板是不是卡住了', '仓库里有 ' + t.count + ' 轮，面板却是 0 行'); }
        }
    } else say('ok', '面板最近一次心跳：' + panel.rows + ' 行（显示 ' + panel.shown + ' / 收纳 ' + panel.hidden + '），聊天 ' + (panel.chat || '?') + '。');
    if (dv) {
        if (dv.patchLen === 0 && !dv.err && dv.emptyNote === 0) {
            say('warn', '差异页最近一次心跳是**空的**（patchLen=0、没异常、也没有"第一轮/逐字一致"的说明）⇒ 可能画不出来。');
            need('点一次「差异↗」看正文在不在', '差异页心跳显示 patchLen=0 且没给任何结论');
        } else if (dv.err) {
            say('warn', '差异页最近一次心跳带异常：' + dv.err.slice(0, 120));
        } else say('ok', '差异页最近一次心跳正常（patchLen=' + dv.patchLen + '，hunk ' + dv.hasHunks + ' 段）。');
    }

    /* ── ⑥ 上一轮"接回丢失"的战果（★★★ 目标③要求写进自检的那一条）── */
    const lastEnter = lastTag(diag.items, 'pushTurn:enter');
    let restore = null;
    if (lastEnter) {
        const kb = Number(lastEnter.keptBack);
        restore = { keptBack: Number.isFinite(kb) ? kb : null, keptChars: Number(lastEnter.keptChars), at: Number(lastEnter.at) || 0, chat: String(lastEnter.chat || '') };
        // ⚠ 没跑 = -1（不是 0）；旧客户端不带这个字段 = undefined ⇒ 两者都如实说"判不了"
        if (restore.keptBack === null) say('info', '上一轮的心跳里没有接回字段（keptBack）—— 那是 v6.24.71 之前的老客户端，不是问题。');
        else if (restore.keptBack < 0) say('info', '接回那一步上一轮没跑到（keptBack=-1；-1 是"没跑"，不是"跑了没接"）。');
        else if (restore.keptBack === 0) say('ok', '上一轮：接回 0 条（这一轮没有被丢的派生条目 —— 正常）。');
        else say('ok', '★ 上一轮**接回 ' + restore.keptBack + ' 条 / ' + Number(restore.keptChars || 0).toLocaleString('en-US')
            + ' 字**（上一轮自己后置、这一轮已经找不回来的增量条；内容一个字没删）⇒ 它们按**自己在上一轮的下标原位**插回，'
            + '与上一轮的公共前缀因此续长一段（实测同一对数据：48,128 → 63,713 字 ≈ +9,197 tok 全转成命中，未命中一个字不涨）。');
    }

    /* ── ⑥′ ★★★★★ v6.24.120：最近一轮的「还原链体检」────────────────────────────────
     *   用户口径（★★★★ 自动发现我的动作）："发新一轮即自动诊断，不等我提醒"。
     *   为什么单开这一项：v6.24.115~119 连着修的三处（跨域总闸 / 容器块序 / 历史体检 / `ad.hunks`）
     *   **全都只在这条链上**，而它们对不对**只有发一轮才知道** —— 这一项就是"发完立刻能读的仪表"。
     *   ⚠ 判据全部**保守**：拿不到字段就说"判不了"，绝不把"没跑到"读成"跑了没效果"。 */
    let chain = null;
    if (lastEnter) {
        chain = chainFromEnter(lastEnter, now);
        const v = judgeChain(chain, now);
        say(v.level, v.text);
        if (v.need) need(v.need, v.why || '');
    }

    /* ── ⑥″ ★★★★★★ v6.27.2【Horae 自己的异常日志】用户点名补的那一项 ─────────────────────
     *   用户原话：「诶 我发现行动目标的自检少了 horae 异常日志的检查啊」
     *   以前自检只能看**抓包插件的** `_diag.log`（那里面只有埋点心跳），而服务端自己那些
     *   `[hitOpt] …写不进去 / 失败` 只打在**控制台**上 —— 控制台不落盘 ⇒ 自检**看不见**。
     *   实测后果（2026-09-19 14:41 用户截图那三条 `ENOENT … 状态文件写不进去`）：异常发生过，
     *   我事后在盘上**一个字都查不到**，只能拿截图猜。
     *   现在 `horaeWarn` 把每条 `[hitOpt]` 警告同时落 `_errlog/YYYY-MM-DD.jsonl`，这一项读它。
     *   判据保守：**没有日志文件 = 一次异常都没有**（✅，不是"判不了"）；有就报 tag ＋ 次数 ＋ 最近那条原话。 */
    let errlog = null;
    try {
        errlog = judgeErrLog(readErrLog(7, 200), now, 24);
        /* ★ 2026-09-24【把 info 记账与警告分开报】实测：原来那句"打过 200 条警告"里有 186 条是
         *   `algo` 的 info（"实验算法产物落盘/跳过重写"），真正的 warn 只有 14 条 ——
         *   这种数会让用户以为插件一直在报错。现在警告只数 warn/error，info 另附一句、只陈述事实。 */
        const infoNote = errlog.最近info条数
            ? '　（另有 ' + errlog.最近info条数 + ' 条 `info` 记账 —— 那是"实验算法产物落盘 / 逐字节相同⇒跳过重写"'
              + '这类走账，**不是警告**，只报数不报警）'
            : '';
        if (errlog.最近条数 === 0) {
            say('ok', '最近 ' + errlog.最近小时 + ' 小时本插件**一条警告都没打过**'
                + infoNote
                + (errlog.总条数 ? '（日志里有更早的 ' + errlog.总条数 + ' 条历史记录，不算在最近这一档）' : '')
                + '　目录：' + errlog.dir);
        } else {
            const top = errlog.groups.slice(0, 3).map(g => '「' + g.tag + '」×' + g.n + (g.last?.lv === 'error' ? '（error）' : '')).join('、');
            const l = errlog.last || {};
            say('warn', '★ 最近 ' + errlog.最近小时 + ' 小时本插件打过 ' + errlog.最近条数 + ' 条**警告**' + errlog.when
                + '：' + top + '　最近一条原话：' + String(l.msg || '').slice(0, 200) + infoNote);
            /* ★ 2026-09-24【删掉那条"把原话发我"的待办】它已经**过时**：
             *   那时候我读不到 `_errlog`，只能请用户截图；现在这段自检自己就在读它（这 200 字就是原话），
             *   而 `_errlog/*.jsonl` 是**纯文本、我直接读得到**（实测：一条 node 命令列全当天的 warn/error）。
             *   ⇒ 派一条"请用户把原话发我"是**假待办**：他会去做一件我早就能自己做完的事。
             *   异常本身照旧如实报（上面那条 warn 保留），只是不再要人跑腿。 */
        }
    } catch (e) { say('info', '⑥″ 读异常日志失败（不影响别的）：' + String(e?.message || e).slice(0, 80)); }

    /* ── ⑦ 汇总：要用户做什么 ── */
    if (!todo.length) todo.push({ who: 'nobody', what: '什么都不用做', why: '上面几项都正常' });

    const md = ['## hitOpt 自检（服务端自带，v' + ROUTE_V + '）', '',
        '时间：' + new Date(now).toLocaleString('zh-CN'),
        '模块目录：' + HORAE_DIR,
        '记录仓库根：' + ROOT, '',
        ...checks.map(c => ({ ok: '✅ ', warn: '⚠ ', info: 'ℹ ' }[c.level] + c.text)),
        '',
        '### 要做的',
        ...todo.map(t => (t.who === 'user' ? '- **' + t.what + '** —— ' + t.why : '- ' + t.what + '（' + t.why + '）')),
    ].join('\n');

    return { ok: !checks.some(c => c.level === 'warn'), at: now, v: ROUTE_V, client, wire, repos, lastTurn, views, chars3, dup, align, panel, dv, restore, chain, errlog, checks, todo, md };
}

/** ★★★★★ v6.24.120：**「最近一轮的还原链」的判读 —— 全项目唯一实现**。
 *
 *  为什么抽成纯函数：抠出来**能被验收直接喂各种形状真跑**（`check/selfcheck_server_test.mjs`
 *  点着名要它）。判据一律**保守**：拿不到字段就说"判不了"，绝不把"没跑到"读成"跑了没效果"。
 *
 *  @param {{rsOn:string|null, abOn:string|null, gone:number|null, goneReal:number|null,
 *           restored:number|null, copies:number|null, skip:string, at:number}} c
 *          —— 直接来自埋点 `pushTurn:enter`（`rsFloorsGoneReal` 只有 v6.24.119 起才有）
 *  @param {number} now 当前毫秒（用来把"多久以前那一轮"写进文案）
 *  @returns {{level:'ok'|'warn'|'info', text:string, need?:string, why?:string}} */
function judgeChain(c, now) {
    const age = (c && c.at) ? Math.round((now - c.at) / 1000) : null;
    const when = age === null ? '' : (age < 3600 ? '（' + Math.max(1, Math.round(age / 60)) + ' 分钟前）' : '（' + Math.round(age / 3600) + ' 小时前）');
    const skip = String((c && c.skip) || '');
    if (!c || c.rsOn === null || c.rsOn === undefined) {
        return { level: 'info', text: '最近一轮的心跳里没有还原链字段（`rsOn`）—— 那是很老的客户端，不是问题。' };
    }
    if (/还原时出错/.test(skip)) {
        return {
            level: 'warn',
            text: '★ 最近一轮的还原链**抛异常**了' + when + '：' + skip.slice(0, 130)
                + '　⇒ 这是真 bug（它会把结果留成**半成品**：盖回做了一半、后置与接回一条没做）。把这句话原样发我。',
            need: '把自检里那句「还原时出错…」原样发我', why: '还原链抛异常 ⇒ 那一轮的结果可能是半成品',
        };
    }
    if (c.rsOn === '0') {
        if (/历史被改动/.test(skip)) {
            if (c.goneReal === null || c.goneReal === undefined) {
                return { level: 'info', text: '最近一轮还原链没跑' + when + '：体检判"历史被改动"—— 但这条心跳是 **v6.24.119 之前**的客户端写的（那时判据里还没有"真楼层"这一层，分辨不出"用户删了楼层"与"变量更新块每轮都在变"）。' };
            }
            if (c.goneReal > 0) {
                return { level: 'ok', text: '最近一轮还原链没跑' + when + '：**真有 ' + c.goneReal + ' 条聊天楼层在这一轮找不着**（另有 ' + Math.max(0, (c.gone || 0) - c.goneReal) + ' 条是每轮都在变的变量更新块） ⇒ 你自己删了楼层 / 重 roll 过 —— ⑨ 的例外，不算 bug。' };
            }
            return {
                level: 'warn',
                text: '★ 最近一轮还原链没跑' + when + '：体检拦了，可**找不着的全是"每轮都在变的变量更新块"（真楼层 0 条）** ⇒ 这正是 v6.24.119 修掉的那个漏，说明**这一页还没拿到新版**。',
                need: '在那正在聊天的一页按 F5', why: '体检把变量更新块误判成"删楼层"（v6.24.119 已修）',
            };
        }
        if (/没有上一轮|没有基准|基准来源|形状/.test(skip)) {
            return { level: 'ok', text: '最近一轮还原链没跑' + when + '：**没有可用的上一轮基准**（新聊天第一轮 / 页面刚刷新 / 那一份形状不可用）—— 正常。' };
        }
        return { level: 'info', text: '最近一轮还原链没跑' + when + '：' + (skip || '（心跳里没写原因）') };
    }
    if (c.rsOn === '1') {
        return {
            level: 'ok',
            text: '★ 最近一轮还原链**跑通了**' + when + '：盖回 ' + (c.restored === null || c.restored === undefined ? '?' : c.restored) + ' 条'
                + (c.abOn === '1' ? '／A-B 切分生效' : '／A-B 没生效')
                + (c.copies ? '／后置增量条 ' + c.copies + ' 条' : ''),
        };
    }
    return { level: 'info', text: '最近一轮的还原链字段是「rsOn=' + c.rsOn + '」—— 认不出这个取值，如实说，不猜。' };
}

/** 从埋点里取"最近一条 `pushTurn:enter`" → `judgeChain` 要的那个形状（判据与字段名只在这里出现一次） */
function chainFromEnter(e, now) {
    if (!e) return null;
    const sOr = (v) => (v === undefined || v === null || v === '' ? null : String(v));
    const nOr = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    return {
        at: Number(e.at) || 0,
        chat: String(e.chat || ''),
        rsOn: sOr(e.rsOn), abOn: sOr(e.abOn),
        gone: nOr(e.rsFloorsGone), goneReal: nOr(e.rsFloorsGoneReal),
        restored: nOr(e.rsRestored), copies: nOr(e.rsCopies),
        skip: String(e.rsSkip || '').slice(0, 240),
    };
}

const safe = (s) => String(s || 'default').replace(/[^0-9A-Za-z\u4e00-\u9fa5_.@-]+/g, '_').slice(0, 80);

/** v6.1：把"旧 key 的仓库"改名迁到"当前聊天 key"下（只在目标不存在时做，允许多个候选）。
 *  为什么要这么做：早期版本用 `characterId::chatId`（角色卡上记的"上次打开的聊天"）当 key，
 *  那个值不保证等于当前聊天文件 → 会出现"新开聊天还在追我"。改成 `角色名::聊天文件名` 后 key 变了，
 *  之前那几轮的记录不能就这么丢了。候选可以是字符串或数组；找不到就什么都不做。 */
function migrateRepo(oldChat, newChat) {
    const olds = Array.isArray(oldChat) ? oldChat : [oldChat];
    for (const o of olds) {
        try {
            if (!o || !newChat || o === newChat) continue;
            const from = path.join(defaultRoot(), safe(o));
            const to = path.join(defaultRoot(), safe(newChat));
            if (!fs.existsSync(path.join(from, '.git'))) continue;
            if (fs.existsSync(to)) return false;      // 目标已存在 → 不动（宁可不迁，也不覆盖）
            fs.renameSync(from, to);
            console.log(`[hitOpt] git 记录：已把仓库从旧 key「${safe(o)}」迁到当前聊天「${safe(newChat)}」`);
            return true;
        } catch (_) { /* 换下一个候选 */ }
    }
    return false;
}

/** 一个记录仓库"最后一次被用到"的时间（毫秒）。
 *  取目录 / turns / .git / turns 里最新那个文件的 mtime 的最大值 —— 因为提交只改 turns/ 和 .git/，
 *  光看顶层目录的 mtime 会误判成"很久没用过"（顶层目录只有 usage.json 在动）。 */
export function lastActiveMs(dir) {
    let t = 0;
    const bump = (p) => { try { const s = fs.statSync(p); if (s.mtimeMs > t) t = s.mtimeMs; } catch (_) { /* 不在就算了 */ } };
    bump(dir);
    const turns = path.join(dir, 'turns');
    bump(turns);
    bump(path.join(dir, '.git'));
    bump(path.join(dir, '.git', 'index'));
    bump(path.join(dir, 'usage.json'));
    try { for (const f of fs.readdirSync(turns)) bump(path.join(turns, f)); } catch (_) { /* 空/不存在 */ }
    return t;
}

/** 只认"我们自己建的仓库"：有 .git 且有 turns/。
 *  仓库根里任何别的东西（你自己放的文件、别的目录）一律不碰 —— 删除这件事必须保守。 */
function isOurRepo(p) {
    try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git')) && fs.existsSync(path.join(p, 'turns')); }
    catch (_) { return false; }
}

/** 删一个目录：先 fs.rmSync，Windows 上 git 对象只读时它可能失败，再退回系统自带命令。 */
async function rmDir(p) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 }); return !fs.existsSync(p); }
    catch (_) { /* 落到系统命令 */ }
    const cwd = path.dirname(p);          // 别把"正在删的目录"当工作目录
    const r = process.platform === 'win32'
        ? await run(['/c', 'rmdir', '/s', '/q', p], cwd, 'cmd')
        : await run(['-rf', p], cwd, 'rm');
    return !fs.existsSync(p) || r.code === 0;
}

/** 算出"该留谁、该清谁" —— **只看不动**（实盘只读核对用它，清理本身也用它）。
 *  留着这个纯函数是为了能对真仓库跑一遍而不删任何东西。 */
export function planPrune(root, keep = CHAT_KEEP, activeDir = null) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return { repos: [], doomed: [], keep }; }
    const repos = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, p: path.join(root, e.name) }))
        .filter(r => isOurRepo(r.p))
        .map(r => ({ ...r, at: lastActiveMs(r.p) }))
        .sort((a, b) => b.at - a.at);                       // 最新在前
    const keepAbs = activeDir ? path.resolve(activeDir) : null;
    // 从最旧的开始删（名单也是这个顺序，日志读起来才顺：先走的是最早那几份聊天）
    const doomed = repos.slice(Math.max(0, keep)).reverse()
        .filter(r => !(keepAbs && path.resolve(r.p) === keepAbs));   // 正在聊的这个，无论多旧都不删
    return { repos, doomed, keep };
}

/** 保留最近 keep 个仓库（按 lastActiveMs 从新到旧），其余删掉；activeDir（当前聊天）永不删。
 *  返回被删掉的目录名列表。**只在本插件自己的 `_gitlog` 里动手。** */
export async function pruneChatRepos(root, keep = CHAT_KEEP, activeDir = null) {
    const removed = [];
    for (const r of planPrune(root, keep, activeDir).doomed) {
        if (await rmDir(r.p)) removed.push(r.name);
    }
    // 顺手收一下"清空记录"留下的归档：只留最近 RETIRED_KEEP 份（它们不占上面那个 30 个聊天的名额）
    try {
        const retired = path.join(root, '_retired');
        if (fs.existsSync(retired)) {
            const dirs = fs.readdirSync(retired, { withFileTypes: true })
                .filter(e => e.isDirectory()).map(e => ({ name: e.name, p: path.join(retired, e.name) }))
                .map(d => ({ ...d, at: lastActiveMs(d.p) }))
                .sort((a, b) => b.at - a.at);
            for (const d of dirs.slice(RETIRED_KEEP)) await rmDir(d.p);
        }
    } catch (_) { /* 归档目录收不掉也不影响正事 */ }
    return removed;
}

/** 让"模拟用的临时目录"永远不进提交 —— 写进 `.git/info/exclude`（**本地忽略，不是 .gitignore**）：
 *  `.gitignore` 是被跟踪的文件，改它会让仓库变脏；`info/exclude` 只在本地生效，`git status` 与 `add -A`
 *  都看不见它，仓库照旧一尘不染。缺哪条补哪条，已经有的不动。 */
function ensureGitExclude(dir, line) {
    const want = String(line || '').trim();
    if (!want) return;
    const p = path.join(dir, '.git', 'info', 'exclude');
    try {
        if (!fs.existsSync(path.join(dir, '.git'))) return;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        let cur = '';
        try { cur = fs.readFileSync(p, 'utf8'); } catch (_) { cur = ''; }
        if (cur.split('\n').some(l => l.trim() === want)) return;
        fs.writeFileSync(p, cur.replace(/\n*$/, '\n') + want + '\n', 'utf8');
    } catch (_) { /* 写不进去也只是"临时文件可能被 add 到" —— 反正比完就删 */ }
}

async function ensureRepo(dir) {
    fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'usage.json\n', 'utf8');
    if (!fs.existsSync(path.join(dir, '.git'))) {
        await run(['init', '-q'], dir);
        await run(['config', 'user.email', 'hitopt@local'], dir);
        await run(['config', 'user.name', 'hitOpt'], dir);
        await run(['config', 'core.autocrlf', 'false'], dir);
    }
    return dir;
}
const usageFile = (dir) => path.join(dir, 'usage.json');
const readUsage = (dir) => { try { return JSON.parse(fs.readFileSync(usageFile(dir), 'utf8')); } catch { return {}; } };
const writeUsage = (dir, obj) => fs.writeFileSync(usageFile(dir), JSON.stringify(obj, null, 2), 'utf8');

/** HEAD 那一轮的编号（没有仓库/没有提交 → null） */
async function headTurnNo(dir) {
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const r = await run(['log', '-1', '--pretty=format:%s'], dir);
    const m = /turn #(\d+)/.exec(r.out);
    return m ? Number(m[1]) : null;
}
/** 仓库里已有文件的最大编号 +1（首次 = 0） */
function nextTurnNo(dir) {
    try {
        /* ★ v6.51.1：正文现在叫 `NNNNN.json`，老轮次还叫 `NNNNN.txt` ⇒ **两种都算一轮**。
         *  ⚠ 只认"纯数字 ＋ 恰好一个扩展名"：`00001.meta.txt` / `00001.raw.json` /
         *    `00001.abc.json` 一个都不能算，否则轮号会跳（老正则是 `^(\d+)\.txt$`，天然把它们挡住）。 */
        const nums = fs.readdirSync(path.join(dir, 'turns')).map(f => Number((f.match(/^(\d+)\.(?:txt|json)$/) || [])[1])).filter(Number.isFinite);
        return nums.length ? Math.max(...nums) + 1 : 0;
    } catch { return 0; }
}

/* ★★★★★★ 2026-09-24【同一发请求被记两遍 —— 服务端侧去重；治"面板多一行、官方数永远填不上"】
 *
 * 【病根（盘上四条铁证，场 `林夏_muf17g3x5dix`）】
 *   客户端 `_gitLogPushTurn` 在**一次生成里会被调两次**（`CHAT_COMPLETION_PROMPT_READY`
 *   有两个 emit 点：`openai.js:1619` 与 `script.js:4037`）：
 *     · 第一次：`_sendProof` **还没建立**（它在 fetch **之后**才写）⇒ 这一发 `proofAt = 0`；
 *     · 第二次：请求真发出去了 ⇒ 有取证。
 *   而客户端 `body` 里**没有 `no` 字段** ⇒ 上面 `let no = Number(body.no)` 拿到 NaN
 *   ⇒ 两次都走 `nextTurnNo()`（＝"盘上最大编号 + 1"）⇒ **第二次拿到一个新号**
 *   ⇒ **同一发请求占了两个轮号**。
 *   ⚠ 本节附近那句旧注释"用同一个编号重试（覆盖写，编号不跳）"**从来没有成立过** ——
 *     客户端根本没传 `no`。铁证：`#10`/`#11` 两轮的 `res.meta.json` 的 `reqFile`
 *     **完全相同**、`turns/NNNNN.json` **逐字节相同**、`_diag.log` 两次 `pushTurn:enter`
 *     一个是 `proofAt=0` 一个非 0。上一批那 4 对则是两次 `proofAt` **完全相同**。
 *
 * 【判据（⛔ 保守：宁可多记一行，也绝不误并**真重 roll**）】
 *   三条**同时**成立才复用旧号：
 *     ① 这一发不是 `swipe`；
 *     ② 仓库**最近 5 分钟**内有一轮，它的 `turns/NNNNN.json`（出网原文）与这一发**逐字节相同**
 *        （sha256 相同）；
 *     ③ `proofAt` **相同**、**或其中一方为 0 / 缺失**。
 *     ★ ③ 为什么能分开"记两遍"与"重 roll 两次"：真重 roll 是**两次真请求**，客户端两次
 *       **都有取证**、`proofAt` **各有各的值且不同** ⇒ ③ 不成立 ⇒ 绝不误并。
 *       而"提前记账 ＋ 正式记账"这一对里**必然有一个是 0**（提前那次还没取证）。
 *     ⚠ 老轮次没有 `diag.json` ⇒ 读不到 `proofAt` ⇒ 按"缺失"处理 ⇒ 会与它合并。
 *       **这是故意的**：老轮次的出网原文与这一发逐字节相同、又只隔 5 分钟，本来就是同一发。
 *
 * 【命中之后怎么办】把 `no` 设成那个旧号 ⇒ 照旧走提交 ⇒ 服务端对**已存在的轮号**走
 *   amend（覆盖写）⇒ 不新增轮号、不产生第二行。
 *   ⛔ 不动官方 usage、不动任何原始存档、不碰"发出去的那串字"。
 *
 * @returns 可复用的轮号；没命中给 null（调用方照旧分配新号） */
async function findSameSendNo(dir, body) {
    try {
        const wireBody = String(body?.wire?.body || '');
        if (!wireBody) return null;
        const want = createHash('sha256').update(wireBody, 'utf8').digest('hex');
        const myProof = Number(body?.diag?.proofAt || 0) || 0;
        const r = await run(['log', '--pretty=format:%h|%ct|%s', '-n', '6'], dir);
        for (const line of r.out.split('\n').filter(Boolean)) {
            const [, ct, ...rest] = line.split('|');
            const m = /turn #(\d+)/.exec(rest.join('|'));
            if (!m) continue;
            /* ② 只看最近 5 分钟（`%ct` = committer date，单位秒） */
            if (Date.now() / 1000 - Number(ct) > 300) continue;
            const no = Number(m[1]);
            const k = String(no).padStart(5, '0');
            const f = path.join(dir, 'turns', `${k}.json`);
            if (!fs.existsSync(f)) continue;
            let same = false;
            try { same = createHash('sha256').update(fs.readFileSync(f)).digest('hex') === want; } catch (_) { }
            if (!same) continue;
            /* ③ proofAt：从那一轮的 `diag.json` 读（老轮次没有 ⇒ 当缺失 = 0） */
            let other = 0;
            try { other = Number(JSON.parse(fs.readFileSync(path.join(dir, 'turns', `${k}.diag.json`), 'utf8'))?.proofAt || 0) || 0; } catch (_) { }
            if (other && myProof && other !== myProof) continue;      // 两方都有值且不同 ⇒ 真重 roll，放行
            return no;
        }
        return null;
    } catch (_) { return null; }
}

/** 空白折叠 + 截断：**与前端运行记录取 head/tail 的规则逐字一致**（首 80 字 / 尾 40 字），
 *  这样"页面刷新后从 git 侧重建的明细"和"内存里的明细"能一一对上（前端拿这两段文本算指纹）。 */
const preview = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const tailOf = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(-n) : t; };

/**
 * 从 `turns/NNNNN.txt` 解析逐条明细 —— **只读插件自己写下的文本，不做任何 diff / 比对**。
 *
 * ★ v6.24.36：这个文件里装的是**出网原文**（真 request）：每条前面的 `── #i role ──` ＋ 内容。
 *   出网那一层**没有**逐条 token（那是客户端数出来的，服务端抓包看不见）→ 逐条 `tok` 恒为 null，**不编数**。
 *   行首锚定（`^…$`）：正文里嵌着的 `── #9 x ──` 字样不算段落行。
 *
 * ★ v6.24.54：**正文里不再有抬头**（用户报的污染：差异页把那行归档说明当成 request 原文红绿出来了）。
 *   抬头搬进旁边 `turns/NNNNN.meta.txt`（`metaText` 传进来）。老记录（抬头还在第一行）**照样认** ——
 *   判据 `WIRE_HEAD_RE` 锚行首，正文里正常不会以 `# wire | <数字> tok|字节 |` 开头。
 *
 * ★ v6.24.39【抬头有两种形状，都要认 —— 盘上的老记录不能瞎】：
 *   新 `# wire | <tok> tok | <字节> 字节 | <N> msgs | …`（token 一格、真字节一格，见前端 `_gitLogText`）
 *   老 `# wire | <数> 字节 | <N> msgs | …` —— **那一格装的其实是 token**（实测：值 == 客户端实测的
 *        prompt token 总数，前端抬头把 token 写进了"字节"位），标签写错了而已 → 老记录仍按 token 读。
 *   为什么要分开：抓包一修通，抬头换成了**真字节**（实测 51,206），老解析器会把字节当 token
 *   交给面板的「本地请求Token」→ 那一列当场变成"5 万 token"的假数。
 *
 * @param {string} text 记录正文（v6.24.54 起：没有抬头）
 * @param {string} metaText 抬头旁文件的内容（老记录没有 → 传空，抬头从正文第一行认）
 */
function parseTurnFile(text, metaText = '') {
    // ★ v6.24.68：新记录 = **抓包那份 POST body 原文**（逐字节）—— 读的时候**在内存里现铺平**
    //   （`flattenWire`，与展示层同一套），再走下面一模一样的解析。铺平结果**不落盘**。
    //   ⚠ 老记录（铺平文本，v6.24.67 及以前）照旧走原路 —— 盘上那几十个聊天仓库还能看。
    let src = String(text || '');
    if (wireBodyShape(src)) {
        try { src = flattenWire(src, 0, null).text; } catch (_) { /* 形状像但不是 body → 按原样读 */ }
    }
    const lines = src.split('\n');
    // 抬头那一行的来源：旁文件优先（新形状），没有就从正文第一行认（老形状）
    const metaLine = String(metaText || '').split('\n').find(l => WIRE_HEAD_RE.test(l)) || '';
    const legacyHead = (!metaLine && WIRE_HEAD_RE.test(lines[0] || '')) ? lines[0] : '';
    const l0 = metaLine || legacyHead;
    const hNew = /^# (?:wire|turn) \| (\d+) tok \| (\d+) 字节 \| (\d+) msgs \| (\d+) 字/.exec(l0);
    const hOld = /^# (?:wire|turn) \| (\d+) (?:字节|tok) \| (\d+) msgs(?! \| \d+ 字)/.exec(l0);
    // v6.7：头行里还带着**实测断点**（`lcp 11959tok/18145ch @#9 assistant`）——
    // 它是客户端把这一轮的 request 与上一轮逐字符比出来的，前端直接拿去当"本地"的权威值。
    const lm = /lcp (\d+)tok\/(\d+)ch @#(\d+) (\S+)/.exec(l0);
    // ★ v6.24.69：**这一轮是哪套代码写的** —— 抬头末尾那段 `| 版本 cli=… srv=… tok=…`。
    //   老记录没有这一段 → 三个都空（面板/自检显示 `—`，**不猜**：猜错会把"用户没 F5"读成"代码坏了"）。
    const vm = /版本 cli=(\S+) srv=(\S+) tok=(\S+)/.exec(l0);
    /* ★★★★★★ v6.39.11【这一轮是**哪个算法**装配的 —— 用户 2026-09-19 定版：
         "一旦取消勾选，那么**记录文件的算法标识符就可以起作用了**，
          比如前三轮A算法 3~6轮B算法 7~12轮C算法"
       ── 抬头里那一段是 `| 算法 algo=<算法 id>@<版本> (<disk|local>)`（见 `flattenWire` 的 `algoSeg`）。
          客户端要它才能做到"不勾『全面板统一』时，**每一轮按它自己那个算法**取数"。
       ── 老记录没有这一段 ⇒ 三个都空（面板如实退回"主算法"，**不猜**：
          猜错就是把 A 算法的账算到 B 算法头上 —— 正是用户要防的那种认知错误）。 */
    /* ★ v6.41.4：**同时认新旧两种抬头** —— 新记录写 `管线 pipe=`（管线化之后，用户点名删掉单算法切换），
       老记录写 `算法 algo=`（那些轮次是哪个算法装配的，不能因为改名就丢掉）。 */
    const am = /(?:算法 algo|管线 pipe)=(\S+?)@(\S+?)(?:\s+\(([a-z]+)\))?(?:\s|$)/.exec(l0);
    // ★ v6.24.76：**服务端自己数的那个权威数**（真分词器 + 这份真出网原文）——
    //   老记录没有这一段 → null（面板退回下面 `tokExact` 现算那一路，两条路都不给就显示 —）。
    const em = /本地exact (\d+) tok/.exec(l0);
    // 老记录的第一行是抬头 → 解析正文时跳过它（新记录第一行就是内容，一个字都不许跳）
    const bodyLines = legacyHead ? lines.slice(1) : lines;
    const items = [];
    let cur = null;
    for (const line of bodyLines) {
        // ══ ★★★ v6.24.82【老记录的标记行有两种形状，这一行原来只认一种】════════════════════════
        //   实测（目标⑧ 全仓扫 109 轮，2026-09-17）：**10 个仓库 / 19 轮**的正文标的是
        //     `── #0 system 2305tok ──`（**带逐条 tok**），而正则只认 `── #0 system ──`
        //   ⇒ 那些轮解析出来的 `items` 是**空的**：面板从抬头读出「31 条」，差异页与 `GET /flat`
        //     却一条都铺不出来（实测 `mu3xhr5u5rz8` / `mu3z8avbccf1` / `mu3xytkq7ftj` … 共 10 场）。
        //     这正是用户 ⑥(b)/⑧(c) 说的"两边各说各话"，也是 ② 说的"差异页正文画不出来"。
        //   为什么现在才抓到：`four_views_test` 原来只抽样跑 3 场（挑轮数最多的），这 19 轮
        //     全是 1~3 轮的小仓库，抽样永远碰不到 ⇒ 这一版同时给它加了 `--all`（全仓逐轮）。
        //   改法：两种形状都认；顺手把 `Ntok` 填进 `tok`（这个字段本来就是为它留的，
        //     见下面 `cur = { ..., tok: null, ... }`）—— 老记录于是也能显示真 token，不用折算。
        //   ⚠ 同类解析器一共三处，必须一起认（§2.2 一处参数栏只许有一套算法）：
        //     服务端这里 / 客户端 `_diffParseTurnText` / `check/four_views_test.mjs` 的 `itemsOf`。
        const m = /^── #(\d+) (\S+)(?: (\d+)tok)? ──$/.exec(line);
        if (m) { cur = { i: Number(m[1]), role: m[2], tok: m[3] ? Number(m[3]) : null, body: [] }; items.push(cur); continue; }
        if (cur) cur.body.push(line);
    }
    const out = items.map(it => {
        // ★ v6.24.51：每条正文**去掉尾部那些空行**（那是条与条之间的分隔，不是内容）——
        //   与 `check/prefix_test.mjs` 的 `readTurn` 逐字同一个读法；面板那三列要跟它逐位相同，
        //   第一步就是"量的对象得是同一串字"。
        const c = it.body.join('\n').replace(/[\r\n]+$/, '');
        return { i: it.i, role: it.role, tok: it.tok, text: c, head: preview(c, 80), tail: tailOf(c, 40) };
    });
    // 逐条字数（★ v6.24.51：面板要拿它把"第几个字"定位到"第几条"，这里只报数，不算任何前缀）
    const itemChars = out.map(x => x.text.length);
    const bodyChars = itemChars.reduce((a, b) => a + b, 0);
    // 头部那行没有时（极少数：文本不是本插件写的），退回"逐条 token 之和" —— 仍然是实测值，不编
    const sumTok = out.reduce((a, b) => a + (b.tok || 0), 0);
    const tokVal = hNew ? Number(hNew[1]) : (hOld ? Number(hOld[1]) : null);
    const byteVal = hNew ? Number(hNew[2]) : null;                 // 老格式没单独写字节 → null（不拿 token 冒充）
    const msgVal = hNew ? Number(hNew[3]) : (hOld ? Number(hOld[2]) : null);
    // ★ v6.24.50：抬头那格「N 字」＝**这一轮逐条正文的字数之和**（前端写抬头时数出来的，出网那一份）。
    //   为什么非搬不可：面板那三列（公共前缀／未命中／合计）要跟 `check/prefix_test.mjs`
    //   在真出网原文上量出来的三个数逐位相同，而"合计"就是这一格 —— 记录里没有它，面板就只能猜。
    //   这里**只解析不重算**（正文一个字都不数，出网那一层也数不准）。
    const charVal = hNew ? Number(hNew[4]) : null;      // 老格式没写「N 字」→ null（不数正文冒充）
    return {
        tok: (tokVal === null ? sumTok : tokVal), bytes: byteVal,
        msgs: (msgVal === null ? out.length : msgVal), items: out,
        chars: (charVal === null || !Number.isFinite(charVal)) ? null : charVal,
        // ★ v6.24.51：**正文自己数出来的**那两份（抬头那格「N 字」是老口径/可能没有，这两份一定准）：
        //   `bodyChars` = 逐条正文字数之和；`totalChars` = 把它们用 '\n' 拼起来之后的总长（条间那一个换行也算）。
        bodyChars, itemChars,
        totalChars: out.length ? bodyChars + out.length - 1 : bodyChars,
        // 这份记录装的是出网原文还是本地快照（抬头里那句话）——面板拿它解释"本地"为什么偏小。
        // ★ 判据必须用**完整标签**：兜底稿那句是「本地快照（**没抓到出网原文**）」——
        //   只认"出网原文"四个字的话，会把本地快照也判成出网原文（实测踩到，测试当场抓出来）。
        // ★ v6.24.54：第 3 支只在"老记录 + 抬头上没有任何标签"时才会走到 —— 一律给空串，**不猜**
        //   （面板那几句解释会退成不写）。不能因为"没读到标签"就默认它是抓包那份（那是编）。
        src: /出网原文，逐字节未改/.test(l0) ? 'wire' : (/本地快照/.test(l0) ? 'snapshot' : ''),
        lcp: lm ? { tok: Number(lm[1]), chars: Number(lm[2]), item: Number(lm[3]), role: lm[4] } : null,
        // ★ v6.24.69：版本戳（`cli` = 写这一轮时浏览器里跑的客户端版本、`srv` = 服务端 ROUTE_V）
        //   ＋ 那格 token 数的是哪串字（`sent` = 出发那一刻的 POST body、`settled` = 定稿快照）。
        verCli: vm ? vm[1] : '', verSrv: vm ? vm[2] : '', tokSrc: vm ? vm[3] : '',
        /* ★ v6.39.11：这一轮记录里标的**算法标识**（老记录为三个空串 ⇒ 客户端如实按主算法处理） */
        algoId: am ? am[1] : '', algoVer: am ? am[2] : '', algoKind: am ? String(am[3] || '') : '',
        // ★ v6.24.76：抬头里那个**服务端自己数的权威 token**（与官方 prompt_tokens 逐位相等）
        exactTok: em ? Number(em[1]) : null,
    };
}

/**
 * ★ v6.24.51：面板「本地」三列的**唯一算法入口**（用户定版："多处相同的参数栏不许有两套算法 ——
 *   全项目只留一个 lcp 入口"）。
 *
 *     lcp  = 这一轮真发出去的字 与 上一轮真发出去的字、逐字节相同的开头长度（字）
 *     miss = 这一轮总长 − lcp
 *     合计  = lcp + miss = 这一轮总长
 *
 * 量的对象＝**这两份记录文件的正文**（`── #i role ──` 之间那些字，条与条用 '\n' 拼起来）——
 * 与 `check/prefix_test.mjs` 的 `readTurn` + `lcpOf` 逐字同一个读法、同一个口径，所以面板那三列
 * 与它打印的 lcp / miss / 合计**逐位相同**（验收口径就这一条）。
 *
 * ⚠ 为什么不用客户端在发送那一刻量、写进抬头 `| lcp …` 的那一份：那一份量的是**它自己手里那串字**
 *   （历史还原／变量块后置**之前**的预演快照），与真出网那份字不是同一串 ——
 *   实测（2026/9/17 `圣樱学院_mu4y2xeo6lmz` #1）：抬头写 9,926 字，两份真记录逐字节比只有 4 字。
 *   官方 usage 也是按**真发出去的那份字**算的，所以面板一律以记录为准；抬头那段只当记录自己的留档。
 */
/** ★ v6.24.115：**全项目唯一那套"逐条铺平"** —— 逐条 content 去尾换行、`join('\n')`。
 *  为什么要提出来：新增的 `lcpBestOf` 要拿铺平串**剪枝**（决定"要不要算"），
 *  但**值**仍必须由 `lcpOfTurns` 这唯一实现算 ⇒ 铺平也只能有一套，否则剪枝的尺子和算的尺子不同源。 */
function jointMsgs(arr) {
    return arr.map(m => String(m?.content ?? '')).join('\n');
}

/** 铺平结果按数组对象缓存（同一份 `body` 跨请求只铺一次）。用 WeakMap ⇒ 不改数组、不泄漏。 */
const _flatMemo = new WeakMap();
function flatOfMsgs(arr) {
    let v = _flatMemo.get(arr);
    if (v === undefined) { v = jointMsgs(arr); _flatMemo.set(arr, v); }
    return v;
}

function lcpOfTurns(prev, cur) {
    if (!Array.isArray(prev) || !Array.isArray(cur) || !prev.length || !cur.length) return null;
    const a = jointMsgs(prev), b = jointMsgs(cur);
    let p = 0;
    const n = Math.min(a.length, b.length);
    while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    // 这个字位置落在这一轮的**第几条**上（条间那个 '\n' 也算进坐标，与上面拼串同一口径）—— 只做定位，不算数
    let at = 0, item = -1, role = '';
    for (let i = 0; i < cur.length; i++) {
        const len = String(cur[i]?.content ?? '').length;
        if (p <= at + len) { item = i; role = String(cur[i]?.role || ''); break; }
        at += len + 1;
    }
    return { chars: p, miss: Math.max(0, b.length - p), total: b.length, item, role, prevChars: a.length };
}

/** ★★★★★★ v6.51.6【★ 白付（漂移税）：这一轮发出去的字里，**本来能命中、却按全价付了**的那部分】
 *
 *  【病】面板上只有「命中 / 未命中」两格 —— 可"未命中"里混着两种东西，性质完全不同：
 *    · **真新增**：这一轮新写的内容，本来就该全价（认了，这是下界）；
 *    · **白付**：内容**上一轮就发过、一个字都没变**，只因为断点落在它前面，于是跟着按全价重付一遍。
 *  用户 2026-09-22 问的就是后者 —— 原话"钱到底花在哪一轮"。这两者混在一格里，
 *  面板就永远回答不了"这一轮贵，是因为我写了新东西，还是因为前缀被撞断了"。
 *
 *  【判据（一行）】断点之后的那串字里，**逐字能在上一轮找到对应**的行，算白付。
 *    · 粒度 = **行**（`\n` 切、`trim()` 后短于 3 字的不参与）—— 与全项目既有口径同一把尺子：
 *      差异页的收纳条、`_tmp/probe_tax2.mjs` 的漂移税、`_patchDropSeen` 的 `_normSeenLine` 都是行级。
 *    · 配对用**多重集**（`Map` 计数、配一对扣一份），所以同一行重复 N 次只认 N 份 —— 不虚报。
 *    · 方向是 **cur 角度**：数的是**这一轮真发出去的那些字**（付钱的是它），不是上一轮。
 *      ⚠ `_tmp/probe_tax2.mjs` 的 `driftTax` 数的是**上一轮**那一侧，而且额外排除了"在上一轮前缀里"的行
 *        ⇒ 它会**漏掉**最主要的那一类白付（上一轮前缀里的内容被新插入的东西往后挤到断点之后）。
 *        本函数是它的**修正口径**；两者在纯漂移场景下接近，在"中间插入"场景下本函数更大且更对。
 *    · 拿不到（第一轮 / 缺一份正文 / 服务端没有 lcp）⇒ 返回 `null`，面板显示 —，**不拿 0 顶上**。
 *
 *  【为什么不做 token 口径】白付的那些行在断点之后是**分散**的，不是连续一段
 *    ⇒ `exactPrefixTok` 那种"前缀 chars 个字的 token 数"用不上，逐行编码又太贵。
 *    所以这里如实只报**字**；面板要 tok 就自己按那一轮的字/token 比折算，并写明"折算"。 */
function taxOfTurns(prev, cur, lcpChars) {
    if (!Array.isArray(prev) || !Array.isArray(cur) || !prev.length || !cur.length) return null;
    if (!Number.isFinite(lcpChars) || lcpChars < 0) return null;
    const a = flatOfMsgs(prev), b = flatOfMsgs(cur);
    if (lcpChars >= b.length) return 0;                       // 整串都在前缀里 ⇒ 一分白付都没有
    const pool = new Map();                                   // 上一轮**全部**行的多重集（不排除前缀 —— 见上面「方向」那段）
    for (const l of a.split('\n')) { const k = l.trim(); if (k.length < 3) continue; pool.set(k, (pool.get(k) || 0) + 1); }
    let n = 0;
    for (const l of b.slice(lcpChars).split('\n')) {
        const k = l.trim(); if (k.length < 3) continue;
        const c = pool.get(k) || 0;
        if (c > 0) { pool.set(k, c - 1); n += l.length + 1; }  // +1 = 那一行的换行（与 jointMsgs 拼串同一口径）
    }
    return n;
}

/** ★★★★★ v6.24.115【官方裁判的真口径】：`prompt_cache_hit_tokens` 命中的是
 *  **与任意一条已缓存请求**的最长公共 token 前缀（向下取整到 64），**不限于上一轮**
 *  —— 这条是用户 v6.24.86 亲口点名的（"找 <=当前楼层，找到所有已存档文件 匹配找到最长LCP"），
 *  客户端 `_prevMsgsPickBest` 也是照它改的；**可服务端 `/log` 报的一直是"与上一轮"**
 *  ⇒ 四视图里那个"本地"格与官方裁判**不是同一个数**。
 *
 *  【实测铁证（真分词器 ＋ 盘上真存档，2026-09-18 第 38/39 轮）】
 *    · 本场 `圣樱学院_mu5sd7sejhp0` 11 轮：Σ|与上一轮 − 官方| = **132,800 tok**；
 *      换成"池中最大"只剩 **768 tok**（降 99.4%）。单轮最刺眼 `#60`：与上一轮 12,800、
 *      池中最大 **72,960**、官方 **72,960**（差 0）；`#53`：11,392 → 56,640，官方 56,576。
 *    · 全仓 236 轮（27 场）：Σ|与上一轮 − 官方| = 1,313,793 → Σ|池中最大 − 官方| = **489,857**
 *      （降 62.71%）。逐位相等的轮数 37 → 34。
 *    · 剩下那 39 轮偏差 > 256 的**方向相反、都不可从盘上观测**：`池中最大 > 官方` = 那一轮发出时
 *      更早那份**已过期**（实测 `mu5q3ymmo3ld#1` 池中 20,288 / 官方 0）；`池中最大 < 官方` =
 *      缓存里有**盘上重建不出**的请求（已 pruned 永久删掉的老场，或不经 Horae 轨迹的请求）。
 *      ⇒ **原理上做不到逐位相等**，如实报，**不调常数抹平**。核对器：`tools/hit_recon.mjs`。
 *
 *  【正确性】本函数**不引入第二套 lcp 算法**：值一律由 `lcpOfTurns` 算，这里只决定"要不要算"。
 *    剪枝依据（数学上不漏）：要 max，设当前已知最大值 `M`。若候选 `a` 真有 `lcp(a,b) > M`，
 *    则必有 `a.length > M`（因 lcp ≤ min(长度)）**且** `a[M] === b[M]`（因前 M+1 个字符全同）。
 *    所以"长度 ≤ M 或第 M 个字符就不同"⇒ 可以安全跳过，**不可能漏掉更长的候选**。
 *    `pool` 按"最可能长"排（调用方给的是轮号从近到远），先算近的能更快把 M 抬起来。
 *
 *  @param {Array<{no:number, arr:Array}>} pool 候选（更早的轮次）
 *  @param {Array} cur 这一轮的 body
 *  @returns {object|null} `lcpOfTurns` 的结果 ＋ `no`（这份最长前缀来自哪一轮）
 */
function lcpBestOf(pool, cur) {
    if (!Array.isArray(pool) || !pool.length || !Array.isArray(cur) || !cur.length) return null;
    const b = flatOfMsgs(cur);
    let best = null;
    for (const it of pool) {
        const a = it && it.arr;
        if (!Array.isArray(a) || !a.length) continue;
        const fa = flatOfMsgs(a);
        if (best) {
            if (fa.length <= best.chars) continue;
            if (fa.charCodeAt(best.chars) !== b.charCodeAt(best.chars)) continue;
        }
        const m = lcpOfTurns(a, cur);
        if (m && (!best || m.chars > best.chars)) best = { ...m, no: it.no };
    }
    return best;
}

/** ★ v6.24.68：这份记录文件是不是**出网原文**（抓包那份 POST body）？
 *  判据只看形状（以 `{` 起手 + 头几 KB 里带 messages/contents/input 数组），**不看内容、不猜**：
 *  认不出来就当老记录（铺平文本）读 —— 盘上几十个聊天仓库里两种形状都有，两条路都得走。
 *  为什么需要它：v6.24.68 起 `turns/NNNNN.txt` 存的是**逐字节原文**，而 v6.24.67 及以前存的是
 *  铺平文本；`parseTurnFile` 得自己认出是哪一种（调用方不告诉它，它也不该猜）。 */
function wireBodyShape(s) {
    const t = String(s || '').trimStart();
    if (!t.startsWith('{')) return false;
    return /"(messages|contents|input)"\s*:/.test(t.slice(0, 4000));
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★★ v6.24.76：本地 token **必须数在"发给官方的同一串字"上** —— 用户 ⑩ 的 0 偏差
 *
 * 用户定版（原话）："要求 找出本地计算与官方usage偏差的原因，哪怕是1的偏差都不可以放过，
 *   必须对齐算法，你的辩据高置信度，能列出来给我看。我的要求是0偏差"
 *
 * 实测取证（2026-09-17；30 场聊天 / 21 个带官方数的轮次 / 另 9 个细看样本）：
 *   · 拿**真 DeepSeek 分词器**（酒馆自己那份缓存 data/_cache/deepseek.json，与它
 *     /api/tokenizers/openai/count 吃的是**同一个实例、同一份词表**）在 **turns/NNNNN.txt
 *     这份真出网原文**上现算：
 *         Σ_每条 encode(role + 两个换行 + content)  ＋ 27   ==   官方 prompt_tokens
 *     **21/21 全中，残差 0**（条数 4/4/6/6/8/10 各不相同也一样）。
 *   · 而客户端报上来的那个数（抬头第一格）是在**它自己手里那份预演数组**上算的 ⇒ 恒偏大
 *     （+58 / +51 …）。真因：酒馆后端出网前会把同角色消息**并**一遍（实测 77 条 → 44 条），
 *     并掉一条就少算 2 tok 的 chat 模板 ⇒ 那个差是**"数错了字"**，不是"算法错"。
 *   · 最刺眼的一例：有一轮抬头写着 tok=settled（定稿快照那条兜底路）⇒ 本地 31,021 / 官方 37,966，
 *     差 **−6,945** —— 同一件事：数的不是同一串字。
 *
 * 所以修法**不是调常数**（那个 27 已经是对的，调它只会把一个差换成另一个差），
 *   而是：**把分词器搬到"那串字"所在的地方** —— 服务端手里就有 turns/NNNNN.txt（抓包逐字节原文），
 *   它自己数，一个字都不用客户端报（⑧(d)：面板那几列不许用客户端手里那串字单独算一套）。
 * 为什么复用酒馆那份分词器而不是另写一套：ST 的 countWebTokenizerTokens 喂进去的正是
 *   messages.flatMap(Object.values).join(两个换行) —— 对 {role, content} 就是 role+换行+content，
 *   与本插件客户端那条 _countStMessage **同一口径**（一处参数栏只许有一套算法）。
 * 拿不到分词器（没装依赖 / 没下过词表 / 换了非 DeepSeek 的词表）⇒ 一律返回 null，
 *   面板与自检**显示 —，绝不拿别的数顶上**。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 找酒馆根目录：**从本文件位置往上走**，认"有 src/endpoints/tokenizers.js"那一层。
 *  为什么不写死路径（⑦(c) 可移植性）：本插件有两种装法 —— plugins/<名>/（往上 1 层就是根）
 *  与"扩展目录 + junction"（往上 5 层）；两种都能靠这一段认出来，换机器不用改代码。
 *  HORAE_ST 环境变量优先（与 check/_paths.mjs 同一个名字，口径一致，不另开一套）。 */
function findStRoot() {
    const cands = [];
    if (process.env.HORAE_ST) cands.push(String(process.env.HORAE_ST));
    try {
        let d = HORAE_DIR;
        for (let i = 0; i < 7; i++) {
            cands.push(d);
            const up = path.dirname(d);
            if (!up || up === d) break;
            d = up;
        }
    } catch (_) { }
    for (const c of cands) {
        try {
            if (fs.existsSync(path.join(c, 'node_modules', '@agnai', 'web-tokenizers'))) return c;
            if (fs.existsSync(path.join(c, 'src', 'endpoints', 'tokenizers.js'))) return c;
        } catch (_) { }
    }
    return '';
}

let _tokTried = false, _tokCounter = null;
/** 拿到"与酒馆同一份词表、同一个分词器库"的计数器 —— 只试一次（拿不到就一直是 null，不再反复试）。
 *
 *  ⚠ v6.24.77【为什么**不** import 酒馆的 src/endpoints/tokenizers.js】：那条路会把
 *    `src/endpoints/secrets.js` → `src/util.js` → `getConfig()` 整条链拖进来，**脱离酒馆进程就抛**
 *    （实测：`No config file path set. Please set the config file path using setConfigFilePath()`，
 *    `check/four_views_test.mjs` 里当场炸、一条断言都没跑）。
 *    ⇒ 改成**自给自足**：只借酒馆的**词表文件**（data/_cache/deepseek.json，与它 /api/tokenizers/openai/count
 *      吃的是同一份）与**同一个分词器库**（node_modules/@agnai/web-tokenizers，酒馆自己也在用它），
 *      数法与客户端那条 _countStMessage 逐字同一个口径：
 *          Σ_每条 encode(role + 两个换行 + content) ＋ 27
 *      （实测 21/21 与官方 prompt_tokens 逐位相等；等价写法"整串 join 后再 encode"也一样，见取证注释。） */
async function stTokenCounter() {
    if (_tokTried) return _tokCounter;
    _tokTried = true;
    try {
        const root = findStRoot();
        if (!root) {
            horaeWarn('[hitOpt] 本地 token：找不到酒馆根目录（没有 node_modules/@agnai/web-tokenizers）→ 本地那几列显示 —');
            return null;
        }
        const req = createRequire(path.join(root, 'noop.js'));
        let lib = null;
        try { lib = req('@agnai/web-tokenizers'); } catch (_) { lib = require('@agnai/web-tokenizers'); }
        const Tokenizer = lib?.Tokenizer;
        if (!Tokenizer || typeof Tokenizer.fromJSON !== 'function') {
            horaeWarn('[hitOpt] 本地 token：@agnai/web-tokenizers 形态不认识 → 本地那几列显示 —');
            return null;
        }
        // 词表：`HORAE_TOK_JSON` 优先；否则 data/_cache/<模型>.json（酒馆自己下的那份缓存）
        const cands = [];
        if (process.env.HORAE_TOK_JSON) cands.push(String(process.env.HORAE_TOK_JSON));
        cands.push(path.join(root, 'data', '_cache', 'deepseek.json'));
        let json = '';
        for (const c of cands) { try { if (fs.existsSync(c)) { json = c; break; } } catch (_) { } }
        if (!json) {
            horaeWarn('[hitOpt] 本地 token：找不到词表（data/_cache/deepseek.json，可用 HORAE_TOK_JSON 指定）→ 本地那几列显示 —');
            return null;
        }
        const buf = fs.readFileSync(json);
        const inst = await Tokenizer.fromJSON(new Uint8Array(buf).buffer);
        // ★★★ v6.24.85：只编 **content**，每条另加官方那 2 个角色标记 token（见 EXACT_TOK_OVERHEAD）。
        // 旧写法把 `role + 两个换行` 也编进去 —— 那是酒馆服务端 countWebTokenizerTokens 的拼法，
        // 而它并不是官方口径：encode('assistant\n\n') = 3 而 encode('user\n\n') = 2 ⇒ 偏差随条数漂。
        _tokCounter = (msgs) => {
            let n = 0;
            for (const m of msgs) n += inst.encode(String(m.content ?? '')).length + TEMPLATE_PER_MSG_TOK;
            return n;
        };
        console.log('[hitOpt] 本地 token：已接入酒馆那份 DeepSeek 词表（' + json + '） —— 本地那几列与官方**同一串字、同一套分词**');
        return _tokCounter;
    } catch (err) {
        horaeWarn('[hitOpt] 本地 token：分词器接入失败（本地那几列会显示 —）:', err?.message || err);
        return null;
    }
}

/** ★★★ v6.24.85【⑩ 真·0 偏差定案】：官方口径（全仓 38 轮带官方 usage 的真样本反解，**37 轮逐位相等**，
 *  唯一例外是已定案的重 roll 灾难轮 mu5ffle6lfcc #7）：
 *       prompt_tokens = Σ encode(content) + 2 × 条数 + 28
 *   斜率恒为 2（**与 role 名无关**）、截距恒为 28。旧口径 Σ encode(role + 两个换行 + content) + 27
 *   只在 encode(role+两个换行) 恰好 = 2 时成立；一旦某条是 3（实测 encode('assistant\n\n') = 3），
 *   就多算 1 并逐轮累积（同一场从 #15 起 +1,+1,+2,+3,+4,+5,+6,+7）。
 *   拿不到分词器 / 这份不是 POST body 形状 ⇒ null（**不编数**）。 */
const TEMPLATE_PER_MSG_TOK = 2;   // 每条消息外裹的角色标记 + 结束符（官方 chat 模板里算着它）
const EXACT_TOK_OVERHEAD = 28;    // 整串串首固定开销（**思考模式开着**时；与条数无关）
/* ★★★ v6.24.103【⑩ 的第二个反例，已定位】：串首开销**不是恒定的 28** —— 它跟着**思考模式**走。
 *   现场（`圣樱学院_mu5q3ymmo3ld`，全仓 100 轮真样本里唯一的两轮"关思考"）：
 *     #1 `thinking:{type:disabled}`、无 `reasoning_effort` 键 ⇒ 本地 27,796 / 官方 **27,771**（差 **+25**）
 *     #2 同上（8 条）                                        ⇒ 本地 35,166 / 官方 **35,141**（差 **+25**）
 *   把这两轮代进公式 `官方 − Σencode(content) − 2×条数`：
 *     #1：27,771 − 27,756 − 12 = **3**      #2：35,141 − 35,122 − 16 = **3**
 *   ⇒ 关思考时截距是 **3**；其余 **98 轮**（`thinking.enabled` 且 `reasoning_effort=high`）截距全是 **28**、差全 0。
 *   机制（与实测一致）：思考模式开着时官方模板在串首注入一段推理引导，那一段恰好 25 tok；
 *   关掉就不注入 ⇒ 少 25。（**2 个样本，但两轮都精确等于 3**；样本少这件事如实记在这里，
 *   将来若出现"disabled 却不是 3"的轮次，这条判据要重开。）
 *   ⚠ 这不是"调常数把差抹平"：判据用的是**请求体里可观测的一个字段**（`thinking.type`），
 *     不是拿残差去凑 —— 98 轮一个没动，只把"关思考"这一类按它自己的模板开销算。 */
const EXACT_TOK_OVERHEAD_NO_THINK = 3;   // 关思考时的串首开销（见上）
async function exactPromptTok(bodyStr) {
    const counter = await stTokenCounter();
    if (!counter) return null;
    try {
        const j = JSON.parse(String(bodyStr || ''));
        const arr = Array.isArray(j?.messages) ? j.messages
            : (Array.isArray(j?.contents) ? j.contents : (Array.isArray(j?.input) ? j.input : null));
        if (!arr || !arr.length) return null;
        // ★ v6.24.85：role 仍然解析出来（老记录里 author 缺 role 时要用它兜底），
        // 但**不再编进 token** —— 官方口径是"每条只算 content + 2"，role 名不参与（见上面那段定案注释）。
        const msgs = arr.map(x => ({
            role: String(x?.role || (x?.author ? 'user' : '?')),
            content: typeof x?.content === 'string' ? x.content
                : (Array.isArray(x?.content) ? x.content.map(p => String(p?.text ?? '')).join('') : JSON.stringify(x?.content ?? '')),
        }));
        const n = Number(counter(msgs));
        // ★ v6.24.103：串首开销按**思考模式**分档（判据是请求体里那个可观测字段，见上面常量那段）
        const overhead = (j?.thinking?.type === 'disabled') ? EXACT_TOK_OVERHEAD_NO_THINK : EXACT_TOK_OVERHEAD;
        return Number.isFinite(n) && n > 0 ? Math.round(n) + overhead : null;
    } catch (_) { return null; }
}

/** v6.24.76：同一份原文只数一次（面板每次刷新都要读十来个轮次，重复编码白烧 CPU）。
 *  钥匙 = 轮号 + 字节数（同一轮号被重 roll 覆盖时字节数会变，不会拿旧结果冒充）。
 *
 *  ★★★★★★ v6.27.4【加一层**磁盘**缓存】—— 2026-09-19 实测出来的真瓶颈，不是猜的：
 *    · 现场：`GET /log` 对**每一轮**都要用酒馆那份**真分词器**编码整份出网原文（实测 95 轮 = 20 MB / 450 万 tok）。
 *    · 实测（临时端口起真服务端实例、只读真机记录，探针用完已删）：
 *        全新进程 **第 1 次** `/log` = **17,736 ms**；同进程**第 2 次** = **382 ms**（内存 memo 命中）。
 *      拆开量：95 轮的「读文件 + JSON.parse」一共只 **266 ms**
 *      ⇒ **≈17.5 秒全在那 95 次真分词器编码上**。
 *    · 后果：酒馆每重启一次、`node check/all.mjs` 每跑一次（每条验收都是新进程），这 17.5 秒**重付一遍**
 *      —— `four_views`(30s) 与 `brk_align`(33s) 两条最慢的验收，慢的就是它。
 *    · 做法：把 `tokExact` 按「**轮号 | txt 字节数**」落一份到 `<本插件目录>/_tokcache/<轮号>.json`。
 *      ★ 2026-09-24【搬迁】："本插件目录" = `SillyTavern/plugins/hitopt-git/`（原先是 Horae 扩展目录）。
 *      键里带字节数 ⇒ 同一轮的记录被重写（重 roll / 覆盖）时**自动失效**，绝不拿旧数冒充新数；
 *      轮号 → 文件名是一一映射，同一轮只一个文件，天然不会堆叠。
 *    · 实测收益（同一套探针，**给源码副本注入同样的补丁**后量）：全新进程冷启动 **17,736 → 991 ms（17.9×）**，
 *      且 `tokExact` 取值与改前**逐位相等**（246,793）。
 *    · ⚠ 这一层**只缓存"读出来的数"**，不参与任何"发出去的那串字"的构造 —— 提示词一个字节都不受影响。
 *    · ⚠ 缓存坏了/读不动一律**当作没有**（继续现算），绝不让缓存把正事搞挂。 */
const _exactTokMemo = new Map();
/** 磁盘缓存目录（可用 `HORAE_TOKDISK` 覆盖；设成空串 = 关掉这层缓存）。
 *  ⚠ 三个函数都收 `dir` 参数（默认本目录）—— 与 `ERRLOG_DIR` 同一个道理：**沙箱必须能把它指向临时目录**，
 *    否则验收会把缓存写进工作台，重演 `_errlog` 那次的"测试替真机撒谎"。 */
const TOKDISK_DIR = process.env.HORAE_TOKDISK !== undefined ? String(process.env.HORAE_TOKDISK) : path.join(HORAE_DIR, '_tokcache');
/** 从磁盘缓存取（拿不到就返回 undefined —— 与"算出 null"区分不开也没关系，调用方两种都当没缓存） */
function tokDiskGet(key, dir = TOKDISK_DIR) {
    if (!dir) return undefined;
    const m = /^(\d+)\|(\d+)$/.exec(String(key));
    if (!m) return undefined;
    try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, m[1] + '.json'), 'utf8'));
        if (Number(c?.n) === Number(m[2]) && Number.isFinite(c?.v)) return Number(c.v);
    } catch (_) { }
    return undefined;
}
/** 落一份到磁盘（写不进去就闭嘴丢掉） */
function tokDiskPut(key, v, dir = TOKDISK_DIR) {
    if (!dir || !Number.isFinite(v)) return;
    const m = /^(\d+)\|(\d+)$/.exec(String(key));
    if (!m) return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, m[1] + '.json'), JSON.stringify({ n: Number(m[2]), v: Number(v) }), 'utf8');
    } catch (_) { }
}
async function exactPromptTokCached(key, bodyStr, diskDir = TOKDISK_DIR) {
    if (_exactTokMemo.has(key)) return _exactTokMemo.get(key);
    const fromDisk = tokDiskGet(key, diskDir);
    if (fromDisk !== undefined) {
        if (_exactTokMemo.size > 400) _exactTokMemo.clear();
        _exactTokMemo.set(key, fromDisk);
        return fromDisk;
    }
    const v = await exactPromptTok(bodyStr);
    if (_exactTokMemo.size > 400) _exactTokMemo.clear();
    _exactTokMemo.set(key, v);
    tokDiskPut(key, v, diskDir);
    return v;
}

/* ══════════════════════════════════════════════════════════════════════════════════════
 * ★★★★★★ v6.41.24【把 tokExact 用**真分词器**劈成"命中 / 未命中"两半 —— 用户点名的"真实性"】
 *
 * 【病（用户 2026-09-20 原话："面板自我冲突你从来不管！！！你踏马不修复一致性真实性嘛？"）】
 *   面板「本地」那一组的四格一直**不是一个东西**：
 *     · 本地合计 = `tokExact` —— 服务端拿酒馆那份**真 DeepSeek 词表**、在**盘上冻结正文**上现算的（真数）；
 *     · 本地命中 = `round(lcp字数 × tokExact/总字数)` —— 客户端拿**一把字→tok 的比例尺**乘出来的（**编的**）；
 *     · 本地未命中 = 合计 − 命中 —— 减出来的。
 *   于是同一行里三个数**性质不同**：一个是分词器的数，两个是尺子的数。用户看到的就是"面板自相矛盾"。
 *
 * 【修法】劈的那一刀也交给**同一个分词器**：
 *   `tokHit` = 把这一轮的正文数组**按 `lcpChars` 个字截断**之后，用同一个 `counter` 数出来的 token；
 *   `tokMiss` = `tokExact − tokHit`。
 *   ⇒ ① 两个数都是**真分词器**数的，与「合计」同源；② **`tokHit + tokMiss ≡ tokExact` 恒成立**（按定义），
 *      这条恒等式本身就是可证伪的钉子（见 `tools/consistency_audit.mjs` 的 I9）。
 *
 * 【口径（不改任何既有语义）】
 *   · 截断按 `/flat` 那套**唯一的铺平式** `jointMsgs = 逐条 content 以单个换行相连` 走
 *     （`lcpChars` 本来就是在这个口径下量的，见 `lcpOfTurns`）—— 尺子只有一把；
 *   · 串首开销 `overhead` 照旧按思考模式分档（与 `exactPromptTok` 同一条判据）；
 *   · `tokHitBest` = 用**池中最大公共前缀** `hitChars` 劈出来的那一半（对官方的尺子，见 `lcpBestOf`）。
 *
 * 【⚠ 它只是"本地尺子"，不是官方那个数】官方 `prompt_cache_hit_tokens` 命中的是**与任意已缓存请求**
 *   的最长公共**token**前缀；这里量的是"与上一轮（或池中某轮）的公共**字符**前缀"。
 *   两者同向、量级一致，但**不会逐位相等** —— 面板的悬停里如实写明，绝不冒充官方。
 * ══════════════════════════════════════════════════════════════════════════════════════ */
const _exactSplitMemo = new Map();
/** 磁盘缓存：`<轮号>.split.json` = `{ n: 字节数, m: { "<字数>": tok } }`
 *  键里带**字节数** ⇒ 同一轮被重 roll 覆盖时整份失效（与 `_tokcache` 同一条纪律，绝不拿旧数冒充新数）。
 *  ⚠ 同一轮可能被问好几个 `chars`（`lcpChars` / `hitChars`，池子换了还会变）⇒ 一张小表按字数分槽。 */
function tokSplitGet(no, bytes, dir = TOKDISK_DIR) {
    if (!dir || !Number.isFinite(Number(no))) return {};
    try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, Number(no) + '.split.json'), 'utf8'));
        if (Number(c?.n) === Number(bytes) && c?.m && typeof c.m === 'object') return c.m;
    } catch (_) { }
    return {};
}
function tokSplitPut(no, bytes, m, dir = TOKDISK_DIR) {
    if (!dir || !Number.isFinite(Number(no))) return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, Number(no) + '.split.json'), JSON.stringify({ n: Number(bytes), m }), 'utf8');
    } catch (_) { }
}
/** 正文数组按**铺平后前 `chars` 个字**截断（铺平式与 `jointMsgs` 逐字相同：逐条 content、单换行相连）。
 *
 *  ★ v6.41.24【这一个函数是本轮"真实性"修法的地基 —— 它必须与 `jointMsgs` **逐字符同源**】
 *    `tokHit` 是"这一轮正文前 `lcpChars` 个字"的 token 数，而 `lcpChars` 是在 `jointMsgs` 那串上量的
 *    ⇒ 只要这里的截断口径与铺平口径差一个字符，面板的"命中字数"和"命中 token"就是**两把尺子**量的。
 *  ⚠ 两处边界是实测出来的（第一版写错过，`check/consistency_test.mjs` ① 段当场抓住）：
 *    · 切点**正好落在条间那个换行上**（`n === end + 1`）：那一个换行**属于**前缀
 *      ⇒ 把 `\n` 追加到刚收下的那条末尾（**不是**补一个空条 —— 补空条会凭空多算一条模板开销 2 tok）；
 *    · 切点正好落在某条末尾（`n === end`）：那个换行**不属于**前缀 ⇒ 什么都不补。
 */
function cutMsgsAt(msgs, chars) {
    const n = Math.round(Number(chars));
    if (!Number.isFinite(n) || n < 0) return null;
    const arr = Array.isArray(msgs) ? msgs : [];
    const out = [];
    let pos = 0;                                   // 下一条 content 在铺平串里的起点
    for (let i = 0; i < arr.length; i++) {
        if (pos >= n) break;                       // 已经到切点，后面全不要
        const m = arr[i];
        const s = String(m?.content ?? '');
        const end = pos + s.length;                // 这一条 content 的终点（不含）
        if (end <= n) {
            out.push({ role: m?.role, content: s });
            if (end + 1 === n && i < arr.length - 1) { out[out.length - 1].content += '\n'; break; }
            pos = end + 1;                         // 跳过它后面那个换行
        } else {
            out.push({ role: m?.role, content: s.slice(0, Math.max(0, n - pos)) });
            break;
        }
    }
    return out;
}
/** 前缀 token（`chars` 个字那一段，含串首开销）。拿不到分词器 / 不是出网原文形状 ⇒ null（**不编数**）。 */
async function exactPrefixTok(bodyStr, chars) {
    const counter = await stTokenCounter();
    if (!counter) return null;
    if (!Number.isFinite(Number(chars)) || Number(chars) < 0) return null;
    try {
        const j = JSON.parse(String(bodyStr || ''));
        const arr = Array.isArray(j?.messages) ? j.messages
            : (Array.isArray(j?.contents) ? j.contents : (Array.isArray(j?.input) ? j.input : null));
        if (!arr || !arr.length) return null;
        const msgs = arr.map(x => ({
            role: String(x?.role || (x?.author ? 'user' : '?')),
            content: typeof x?.content === 'string' ? x.content
                : (Array.isArray(x?.content) ? x.content.map(p => String(p?.text ?? '')).join('') : JSON.stringify(x?.content ?? '')),
        }));
        const cut = cutMsgsAt(msgs, chars);
        if (!cut) return null;
        const overhead = (j?.thinking?.type === 'disabled') ? EXACT_TOK_OVERHEAD_NO_THINK : EXACT_TOK_OVERHEAD;
        const n = Number(counter(cut));
        return Number.isFinite(n) && n >= 0 ? Math.round(n) + overhead : null;
    } catch (_) { return null; }
}
/** 带缓存的前缀 token（内存 → 磁盘 → 现算）。写盘失败一律当作没有，绝不让缓存把正事搞挂。 */
async function exactPrefixTokCached(no, bytes, chars, bodyStr, diskDir = TOKDISK_DIR) {
    if (!Number.isFinite(Number(chars)) || Number(chars) < 0) return null;
    const k = `${Number(no)}|${Number(bytes)}|${Number(chars)}`;
    if (_exactSplitMemo.has(k)) return _exactSplitMemo.get(k);
    const m = tokSplitGet(no, bytes, diskDir);
    if (Number.isFinite(Number(m[String(Number(chars))]))) {
        const v = Number(m[String(Number(chars))]);
        if (_exactSplitMemo.size > 800) _exactSplitMemo.clear();
        _exactSplitMemo.set(k, v);
        return v;
    }
    const v = await exactPrefixTok(bodyStr, chars);
    if (_exactSplitMemo.size > 800) _exactSplitMemo.clear();
    _exactSplitMemo.set(k, v);
    if (Number.isFinite(v)) { m[String(Number(chars))] = v; tokSplitPut(no, bytes, m, diskDir); }
    return v;
}

/**
 * ★ v6.24.36：把**出网原文**（wiretap 抓到的 POST body）铺成插件自己的可读文本。
 *
 * 为什么要有这一份（用户定版："将原文与差异，数据源全部改为真出网原文"）：
 *   前端的 request 与"模型真收到的那份"**不是同一串字** —— 酒馆后端会先 `postProcessPrompt`
 *   再发上游（实测 31 条被并成 4 条），宏也是在那之后才展开（我们记录里躺着的是
 *   `{{format_message_variable::stat_data}}`，出网那份是 8,405 字的真值）。
 *   所以"哪一段在每轮打断缓存"只能在出网这份上量。这里只做搬运与铺平，一个字都不改内容。
 *
 * ★ v6.24.39：`tok` = 客户端在**这一份字**上用酒馆分词器数出来的 prompt token（＋模板开销），
 *   由 `/turn` 的 `body.wire.tok` 传进来 —— 本地与官方数的从此是**同一串字**，两列才可能对上。
 *   没给（数不出来）就写 `0 tok`，面板那一格显示"—"：**宁可空着，不编数**。
 *
 * ★ v6.24.42：`lcp` = 客户端量的**实测断点**（这一轮 request 与上一轮逐字符比出来的公共前缀），
 *   由 `/turn` 的 `body.wire.lcp` 传进来，写进抬头尾部 `| lcp <tok>tok/<chars>ch @#<i> <role>`。
 *   为什么非写不可：出网原文那一层**没有逐条 token**（抓包只看得见内容），
 *   记录里每条 `tok` 恒为 null ⇒ 面板「本地命中」退回"按逐条求和"那条路时**恒得 0**
 *   （实测用户面板：命中 0 / 未命中 = 整条 31.2K / 命中率 0.0%）。断点只有客户端量得出来，只能搭车送。
 *
 * ★ v6.24.54：**抬头与正文分家**（用户实测报过来的污染）——
 *   差异页把归档抬头那一行 `# wire | …` 当成"这一轮真 request 的原文"红绿了出来，
 *   而那一行（token / 字节 / msgs / 字 / model / "出网原文，逐字节未改" / lcp）**全是插件自己写的归档说明**，
 *   真 POST body 的 `messages` 里根本没有它。用户原话："我们只管最终真实出网的实际内容"。
 *   ⇒ 现在：`text` = **只有真内容**（第一行就是这一份内容的第一个字节，一个字的元数据都不掺）；
 *     `head` = 那一行抬头，由 `/turn` 写进旁边的 `turns/NNNNN.meta.txt`（可读、进 git、留档照旧）。
 *   为什么另存而不是删掉：面板的「本地请求Token」「这一轮总字节」「是出网原文还是本地快照」
 *   都要它；而且"每轮本地 vs 官方"的对账全靠这格 token。抬头只是**不能混进原文**，不是不要。
 * ★ v6.24.68：**它从此只服务展示层** —— `/log` 算 lcp、`/diff` 与 `simDiff` 现比两份文本、
 *   页面上"收纳处展开"要的原文，都在**内存里现铺**。落盘的那一份（`turns/NNNNN.txt`）是
 *   **抓包 POST body 逐字节原文**，不再经过这里（用户定版："换行美化是我们的事情，
 *   你连真实内容都敢格式化？存盘必然是真实文本"）。
 * @param {string} bodyStr 抓包截下的 POST body 原文（逐字节）
 * @param {number} tok 客户端在这一份字上数出来的 prompt token（＋ chat 模板开销）
 * @param {object|null} lcp 客户端量的实测断点
 * @param {object|null} ver 版本戳（cli / srv / tokSrc）
 * @param {number|null} exactTok ★ v6.24.76：**服务端**用酒馆那份真分词器在**这一份原文**上数出来的
 *   prompt token（与官方同源同口径，见上面那段取证的注释）。拿不到就是 null → 抬头里**不写这一段**
 *   （面板/自检显示 —，不编数）。写进抬头是为了让"盘上这份文件"自己就带着那个权威数，
 *   回看老轮次、换机器、别人拿记录去对账时都不用再算一遍。
 * @returns {{text:string, head:string}} text = 铺平后的可读正文（**只在内存里用，不落盘**）；head = 抬头那一行
 */
function flattenWire(bodyStr, tok, lcp = null, ver = null, exactTok = null, shape = 'wire') {
    const j = JSON.parse(String(bodyStr || ''));
    const arr = Array.isArray(j?.messages) ? j.messages
        : (Array.isArray(j?.contents) ? j.contents : (Array.isArray(j?.input) ? j.input : null));
    if (!arr) throw new Error('这份 body 里没有 messages/contents/input 数组');
    const norm = arr.map(m => ({
        role: String(m?.role || (m?.author ? 'user' : '?')),
        content: typeof m?.content === 'string' ? m.content
            : (Array.isArray(m?.content) ? m.content.map(p => String(p?.text ?? '')).join('') : JSON.stringify(m?.content ?? '')),
    }));
    const bytes = Buffer.byteLength(String(bodyStr || ''), 'utf8');
    const chars = norm.reduce((a, m) => a + m.content.length, 0);
    const tokNum = Math.max(0, Number(tok) || 0);
    // `| lcp …` 的格式必须与 `parseTurnFile` 那个正则逐字对上：`lcp (\d+)tok\/(\d+)ch @#(\d+) (\S+)`
    const lm = (lcp && Number.isFinite(Number(lcp.tok)))
        ? ` | lcp ${Math.max(0, Number(lcp.tok) || 0)}tok/${Math.max(0, Number(lcp.chars) || 0)}ch`
            + ` @#${Number.isFinite(Number(lcp.item)) ? Number(lcp.item) : -1} ${String(lcp.role || '?').replace(/\s+/g, '')}`
            + (lcp.full ? ' (两轮逐字一致)' : '')
        : '';
    // ★ v6.24.50：抬头那格「N 字」＝**逐条 content 的字数之和**（与前端兜底稿 `_gitLogText` 同一个口径）——
    //   面板那三列拿它 + 上面那段 `lcp …/<chars>ch` 就能给出与 `check/prefix_test.mjs` 逐位相同的三个数。
    // ★ v6.24.69【用户点名："给抬头添加当前版本信息，我们日后好对账，省的我没重启服务器或者 F5
    //   影响你的判断"】——抬头末尾钉上**这一轮是哪套代码写的**：
    //     `cli` = 客户端在发送那一刻报上来的 `HORAE_CACHE_PATCH`（没报 = `?`，说明那个页面还没 F5）；
    //     `srv` = **本模块自己的 `ROUTE_V`**（服务端只在启动时加载 ⇒ 这个数就是"酒馆跑的是哪一版"的硬证据，
    //             不用再靠时间戳猜用户重启没重启）；
    //     `tok` = 那格 token 数的是哪串字（`sent` = 出发那一刻的 POST body，与官方同源；
    //             `settled` = 定稿快照，与官方不可比 —— 实测差 6,500 tok）。
    //   为什么值得占这一格：面板/记录/官方三方对账时，"这一轮的数是哪套代码、数的哪串字"是前提；
    //   没有它，同一个差值既可能是代码问题、也可能是"用户还没 F5 / 还没重启"。
    const verSeg = ` | 版本 cli=${String(ver?.cli || '?')} srv=${ROUTE_V} tok=${String(ver?.tokSrc || '?')}`;
    /* ★★★★★★ v6.39.11【这一轮是**哪个算法**装配的】用户 2026-09-19：
         "给每一轮的数据 标记 来自什么版本算法，跟BS双端版本一个性质"
       ＋ 他给的理由（这句才是要害）："**省的我对话一半了，切算法继续跑，结果修bug时候大家的认知错误**"。
       ── 与 `cli=` 并排写进同一段：`cli` 说"哪套代码写的"，`algo` 说"这一轮的提示词是哪条链装配的"。
          `kind` 一并带上：`disk` = 产物是盘上的文件（主算法）／`local` = 本地重算（实验算法）。
       ── 为什么必须落在**记录**里：用户完全可能在对话中途切算法继续跑 ⇒ 同一场聊天里
          每一轮可能是**不同算法**算的 ⇒ 事后只按"现在选的是哪个"去读，认知必然错乱。
       ⚠ 客户端没报（老客户端 / 还没 F5）就写 `?` —— 与 `cli=?` 同一纪律，**不猜**。 */
    /* ★★★★★★ v6.41.4【这一段从"哪个算法"改成"**哪条管线**"】
       ── 用户 2026-09-20 点名："**单算法切换记得删除 特别实验标准已无效 因为已经模块化算法 组合管线**"
          ⇒ 抬头这一格从此报**管线**：槽名（＝临时区 `pipes/<槽>/` 的目录名）＋ 各级版本 ＋ 逐级名字。
       ── 形状：`| 管线 pipe=<槽名>@<各级版本 + 连> (pipe)｜<逐级名字 → 连>`
          `(pipe)` 那一段的**括号 + 小写词**形状是刻意保留的：`parseTurnFile` 的 `am` 正则就是按
          `(\S+?)@(\S+?)(?:\s+\(([a-z]+)\))?` 抓的 ⇒ 形状不动，解析器只多认一个别名。
       ── ⚠ 老记录那一段是 `| 算法 algo=…@… (disk|local)` ⇒ 正则**必须同时认两种**：
          历史轮次的"是谁装配的"不许因为改名而丢掉。 */
    const algoSeg = ` | 管线 pipe=${String(ver?.algo || '?')}@${String(ver?.algoVer || '?')}`
        + (ver?.algoKind ? ` (${String(ver.algoKind)})` : '')
        + (ver?.algoName ? `｜${String(ver.algoName)}` : '');
    // ★ v6.24.76：**服务端自己数的那个权威数**（真分词器 + 真出网原文）—— 与官方 prompt_tokens 逐位相等。
    //   与上面那格 `tok` 的区别必须一眼看得出：那格是**客户端在它自己那份预演数组上**数的（会偏 +58 这类），
    //   这格才是"本地 vs 官方"对账该用的数。数不出来（没分词器）就不写这一段。
    const exSeg = (Number.isFinite(Number(exactTok)) && Number(exactTok) > 0)
        ? ` | 本地exact ${Math.round(Number(exactTok))} tok` : '';
    const head = `# wire | ${tokNum} tok | ${bytes} 字节 | ${norm.length} msgs | ${chars} 字 | model=${String(j?.model || '?')} | 出网原文，逐字节未改${verSeg}${algoSeg}${exSeg}${lm}`;
    /* ══════════════════════════════════════════════════════════════════════════════
     * ★★★★★★ v6.51.3【正文形状：`shape='json'` ⇒ **JSON 结构行真进 diff**】
     *  用户 2026-09-22 点名原话：
     *    "不用故意铺平啊 我们就是要对原文，所以 json 结构的差异化必须也要参与 diff 啊。
     *      你直接把内容摘抄没啥意义"
     *  ── 他说得对，而且丢的东西是**可数的**：老铺平只留 `role` + `content`，
     *     出网 body 顶层那 **9 个参数**（`model` / `temperature` / `max_tokens` / `stream` /
     *     `presence_penalty` / `frequency_penalty` / `top_p` / `thinking` / `reasoning_effort`）
     *     **一个都没进 diff** —— 换模型、开关思考、改温度，在差异页上**完全看不见**。
     *  ── 新形状（"结构行 ＋ content 展开"）：
     *       {
     *         "model": "deepseek-flash",
     *         "temperature": 1,
     *         …（原文里除数组之外的**每一个**顶层键，原样一行）
     *         "messages": [
     *           {"role": "user", "content": "第一行
     *       第二行
     *       …
     *       "},
     *           {"role": "user", "content": "…"},
     *         ]
     *       }
     *     ⇒ ① **结构差异真的进 diff**：`role` 变了、条数变了、顶层参数变了 ⇒ 都落在行上；
     *       ② **内容仍然逐行**：`content` 按它自己的换行摊开（不是"摘抄"，是原文那个值）；
     *       ③ content 里的引号与反斜杠**保留 JSON 转义**（`\"` / `\\`）⇒ 与结构行**一眼分得开**。
     *  ⚠ 唯一"不是合法 JSON"的地方就是 content 的换行没转义 —— 那是**故意的**：
     *     转义回去就是 `JSON.stringify(j, null, 2)` 那个形状，而它实测**最长一行 78,059 字符**
     *     （一整条正文挤在一行）⇒ 差异页上"这条变了"看得见、"哪里变了"看不见，还要横向滚七万字符。
     *  ⚠⚠ 为什么用**加参数**而不是直接改：`parseTurnFile` 也调这个函数，再按 `── #N role ──`
     *     正则解析出 items —— 而 items 是 **lcp / miss / 条数 / 字数** 的根。
     *     加第 6 参、默认 `'wire'` ⇒ 那条链**一个字节都不变**，只有差异页那几处传 `'json'`。
     * ══════════════════════════════════════════════════════════════════════════════ */
    let text;
    if (shape === 'json') {
        const O = ['{'];
        /* ① 顶层参数：原文里除数组之外的每一个键，原样一行（就是以前被整段丢掉的那 9 个）。 */
        for (const k of Object.keys(j || {})) {
            if (k === 'messages' || k === 'contents' || k === 'input') continue;
            O.push(`  ${JSON.stringify(k)}: ${JSON.stringify(j[k])},`);
        }
        O.push('  "messages": [');
        for (let i = 0; i < arr.length; i++) {
            const m = arr[i] || {};
            /* 该条原文里除 content 之外的键，原样排在前面（`role` 就是在这里露出来的）。 */
            const others = Object.keys(m).filter(k => k !== 'content')
                .map(k => `${JSON.stringify(k)}: ${JSON.stringify(m[k])}`).join(', ');
            /* content：先按 JSON 规则**整个转义**（引号 ⇒ \" 、反斜杠 ⇒ \\），只把 `\n` 摊回真换行。
             * ⚠ `JSON.stringify` 一定会给字符串套一对引号 ⇒ 切掉，收尾引号由下面自己补（要独立成行）。 */
            const lines = JSON.stringify(norm[i].content).slice(1, -1).replace(/\\n/g, '\n').split('\n');
            O.push(`    {${others ? others + ', ' : ''}"content": "${lines[0]}`);
            for (let k = 1; k < lines.length; k++) O.push(lines[k]);
            O.push(i === arr.length - 1 ? '"}' : '"},');
        }
        O.push('  ]');
        O.push('}');
        text = O.join('\n');
    } else {
        /* 老形状（默认）：与历史逐行同形，**只是第一行没有抬头**（`parseTurnFile` 一个字都不用改）。 */
        const L = [''];
        for (let i = 0; i < norm.length; i++) {
            L.push('');
            L.push(`── #${i} ${norm[i].role} ──`);        // 出网这一层没有逐条 token（不编数）
            L.push(norm[i].content);
        }
        text = L.join('\n');
    }
    return { text, head };
}

/** ★ v6.24.54：归档抬头那一行从正文里搬出来之后住哪儿 —— `turns/NNNNN.meta.txt`（一轮一份，与记录同目录）。
 *  为什么选这个位置：
 *   · `nextTurnNo` 只认 `^(\d+)\.txt$` ⇒ `00001.meta.txt` **不会**被当成一轮；
 *   · 进 git（跟着同一轮一起 commit）⇒ 换机器/刷新之后 `/log` 照样读得到那几格；
 *   · 与 `sim/` 不同：它是**每一轮都要留**的档案，不是"只留最新一份"的临时文件，所以用 `-f` 单独 add。 */
const metaPathOf = (dir, no) => path.join(dir, 'turns', `${String(no).padStart(5, '0')}.meta.txt`);
function writeTurnMeta(dir, no, line) {
    try { fs.writeFileSync(metaPathOf(dir, no), String(line || ''), 'utf8'); return true; }
    catch (err) { horaeWarn('[hitOpt] git 记录：抬头旁文件写不进去（面板那几格会退成"—"）:', err?.message || err); return false; }
}
/** 抬头那一行的**唯一判据**：老记录把它写在正文第一行，新记录在旁文件里 —— 两处的形状逐字相同。 */
const WIRE_HEAD_RE = /^# (?:wire|turn) \| \d+ (?:tok|字节) \|/;

/** ★★★★★★ v6.27.0【三件套之 ③ 的落盘器】把"这一轮模型返回的那份原文"补进同一个仓库、同一次提交。
 *
 *  数据来源：抓包插件 v6 起会把响应落成 `<captures>/<日>/<seq>-<时间>-<键>.res.txt`
 *  ＋ 同名 `.res.meta.json`（里面记着 `reqSha` ＝ 我们那份 POST body 的 sha256）。
 *  ⇒ 匹配键**不是时间窗、不是轮号**，而是**请求体的 sha256**（唯一、可复算、不会认错轮）。
 *
 *  @param dir   这一场的记录仓库目录
 *  @param no    轮号
 *  @param reqSha ② 那份 POST body 的 sha256（抓包插件在响应 meta 里记的是同一个值）
 *  @param tries 轮询次数（每次 2 秒）—— 实测响应几秒内就到；给 45 次 ≈ 90 秒的上限，
 *               到点还没来就**如实放弃**（不写空文件、不猜），由下一轮 `/selfcheck` 报出来。
 *  @param ver   ★ 版本戳（用户 2026-09-19 点名："你的每轮三个文件，记得加版本戳啊"）：
 *               `{ cli, srv, tokSrc, wireSha, rawSha }` —— 与 ③ 一起落成
 *               `turns/NNNNN.ver.json`（三件套的指纹 ＋ 这一轮是 B/S 哪一版写的）。
 *               ⚠ ①②③ 三份**纯数据一个字节都不改**（① 要 byte-identical 做前缀判据、③ 是 SSE 原始流），
 *                 版本戳一律落在**元数据文件**里（这就是 `meta.txt` / `*.ver.json` 存在的理由）。
 */
/** ★★★★★★ 2026-09-19【占坑】三件套的落盘状态（用户点名："就算比如官方返回的没落盘，还是说返回了一半被我
 *  中断了，还是什么原因，都得说明，都得用占位文件占坑啊，里面的内容等时机到了回填"）。
 *
 *  为什么需要它：以前"这一轮 ③ 没落盘"只在日志里写一行 warning ⇒ 盘上**什么都没留下**，
 *  于是"还没写"和"写了但是空的"分不清（`triad_check` 只看 readdir，看到没有就当没这回事）。
 *  现在三件套各有状态，缺的那一刻就写一份占位文件（抬头 `[占位·待回填]`）：
 *    `turns/NNNNN.raw.txt` / `NNNNN.txt` / `NNNNN.res.txt` 里写清 **谁缺、为什么缺、什么时候能回填**，
 *    另有 `turns/NNNNN.status.json` 记着三份各自的状态，供面板 / 体检 / 我自己一眼看穿。
 *
 *  ⚠ 占位文件**绝不是数据**：抬头第一行 `[占位·待回填]` 是唯一判据（工具与解析器都靠它区分）。
 *  ⚠ 回填路径同一条：真数据一到就**覆盖**占位文件，状态改 `present`（`attachRes` 的轮询天然支持）。 */
async function readStatus(dir, no) {
    const p = path.join(dir, 'turns', `${String(no).padStart(5, '0')}.status.json`);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return { 轮: no, 件: {} }; }
}
/** 更新三件套状态（`patch` 形如 `{ res: { state, why } }`）—— 只改元数据，**绝不碰数据文件**。 */
function updateStatus(dir, no, patch) {
    const p = path.join(dir, 'turns', `${String(no).padStart(5, '0')}.status.json`);
    /** 真写一次。★ v6.27.2【2026-09-19 实测定案】第一版的致命错：第一行 `readFileSync` 读的正是
     *  **可能要新建**的那个文件 —— 文件不存在 ⇒ 当场抛 `ENOENT` ⇒ 走进 catch ⇒ 而 catch 的自愈只建
     *  **目录**、不建文件 ⇒ 第二遍照样抛 ⇒ 白记一条"状态文件写不进去"的警告。
     *  真机铁证（`_errlog/2026-09-19.jsonl` 15 条、每轮 3 条）＋ 探针 `_tmp/probe_status_enoent.mjs`
     *  最小复现：`turns/` 明明在、`status.json` 没有 ⇒ `ENOENT: … 00043.status.json`。
     *  ⇒ 缺文件是**正常开局**（这一轮第一次写状态），不是异常：读不到就用空状态起头（与 `readStatus` 同口径）。 */
    const emptyStatus = () => ({ 轮: no, at: new Date().toISOString(), 件: {} });
    const attempt = () => {
        let st = emptyStatus();
        try { st = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { st = emptyStatus(); }
        st.件 = st.件 || {};
        Object.assign(st.件, patch);
        st.at = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(st, null, 2), 'utf8');
    };
    try {
        attempt();
    } catch (err) {
        /* ★★★★★★ v6.27.2【为什么还留着这一兜】`turns/` 目录中途没了的兜法（git 动过工作区）。
         *   现在"文件不在"已由上面 `emptyStatus()` 兜住 ⇒ 能走到这里的只剩**目录**真没了，
         *   所以建目录再写一遍是**对症**的；连第二遍都失败才真记一条异常日志（自检 ⑥″ 会报出来）。 */
        if (err?.code === 'ENOENT') {
            try { fs.mkdirSync(path.dirname(p), { recursive: true }); attempt(); return; } catch (_) { }
        }
        horaeWarn('[hitOpt] git 记录：状态文件写不进去:', err?.message || err);
    }
}
/** 写"占位文件"（真数据还没到 / 永远到不了）——内容是**说明**，不是数据。 */
function writePlaceholder(dir, no, kind, why, state = 'pending', extra = {}) {
    const k = String(no).padStart(5, '0');
    /* ★ v6.51.1：底文件占的必须是**真名的位置** —— 真数据一到就覆盖它。
     *  ⚠ 底文件正文是 `[占位·待回填]` ＋ `# …` 说明文本（**不是 JSON**），但仍然用新名，理由是硬的：
     *    若给它留 `.txt`，`turnRelCands('body')` 会先找 `.json`（不在）⇒ 退到并读到这个底文件，
     *    语义就变成"这一轮真有一份 `.txt` 正文"。今天它叫 `.txt` 且正是被当真名读到的
     *    ⇒ 用新名才对得上（解析器另有抬头 `[占位·待回填]` 兜着，不会拿它冒充实数据）。 */
    const file = kind === '①原始' ? `${k}.raw.json` : kind === '②修改' ? `${k}.json` : `${k}.res.txt`;
    const p = path.join(dir, 'turns', file);
    /** 真写一次（已经建过 `turns/`，正常路走这里）。 */
    const attempt = () => fs.writeFileSync(p, placeholderText(no, kind, why) + '\n', 'utf8');
    try {
        // ⚠ 已经被真数据占了就不动它（回填优先级：真数据 > 占位）
        try { if (fs.existsSync(p) && !fs.readFileSync(p, 'utf8').startsWith('[占位·待回填]')) return false; } catch (_) { }
        try {
            attempt();
        } catch (err) {
            // ★ v6.27.2：与 `updateStatus` 同一套兜法 —— 目录中途没了就先建回来再写一次
            if (err?.code !== 'ENOENT') throw err;
            fs.mkdirSync(path.dirname(p), { recursive: true });
            attempt();
        }
        // 状态跟着占位一起落 —— "占坑"与"状态说明"必须是同一件事的两个面，不许一边有一边没有
        updateStatus(dir, no, { [kind === '①原始' ? 'raw' : kind === '②修改' ? 'wire' : 'res']: { state, why, file, placeholder: true, ...extra } });
        return true;
    } catch (err) { horaeWarn('[hitOpt] git 记录：占位文件写不进去:', err?.message || err); return false; }
}
/** 占位文件的正文（抬头 `[占位·待回填]` 是**唯一判据**，工具与解析器都靠它区分）。 */
function placeholderText(no, kind, why) {
    const k = String(no).padStart(5, '0');
    return [
        `[占位·待回填]`,
        `# 第 ${no} 轮 · ${kind}`,
        `# 原因：${why}`,
        `# 落坑时间：${new Date().toLocaleString('zh-CN')}`,
        `# 回填方式：真数据一到就覆盖本文件（同一路径、同一轮号），并把 turns/${k}.status.json 的 state 改成 present`,
        `# ⚠ 这一份**不是数据**：解析器认抬头 [占位·待回填]，不会把它当出网原文 / 模型返回用。`,
    ].join('\n');
}

/** ★★★★★★ 2026-09-19【底文件】三份**先占坑**（用户口径："也就是先建立底文件，然后填内容，或者修改内容"）。
 *  每一轮 `/turn` 一进来就落三份 `[占位·待回填]`，随后：
 *    ① 客户端带了 raw → 真内容覆盖；没带 → 底文件留着并写明原因；
 *    ② 抓包那份没到 → 底文件留着（写了真实 body 时自然覆盖）；
 *    ③ 等 `attachRes()` 按 sha256 找回响应 → 覆盖；超时 → 底文件留着 ＋ 状态改 `failed`。
 *  ⇒ 任何时刻盘上**三份文件都在**，"缺"也有据可查（state + 抬头），不会出现"没有文件所以不知道发生了什么"。
 *
 *  ★★★★★★ 状态语义（用户 2026-09-19 追加点名："有就是有 没有就是没有 还没搞完 还是搞了一半 还是什么
 *    奇奇怪怪的原因导致内容的不完整 还是只有部分 都得说明状态"）—— **八种状态，互不混用**：
 *      `present` 有，且是**完整真数据**（三份里的真内容）
 *      `pending` 还没搞完（正在等：③ 等抓包插件的响应，最多 90 秒）
 *      `partial` **只搞到一半**（收到了数据但**不完整**：流没收尾 / 只拿到部分）
 *      `missing` **根本没有**（这一份从来没到过：老客户端没带 raw / 没抓到出网原文）
 *      `failed`  搞不到（等超时了 / 抓包插件没开 / 请求失败）—— 与 missing 的区别是"尝试过且失败了"
 *      `aborted` 被中断（用户在生成中点了停止 / 连接断开）
 *      `skipped` 这一轮本来就不需要它（例如 dryRun 不真发请求）
 *      （另：文件抬头 `[占位·待回填]` 是"盘上这份是底文件、内容还没回填"的**唯一判据**） */
function ensureBaseFiles(dir, no) {
    const out = ['①原始', '②修改', '③返回'].map((k) => writePlaceholder(dir, no, k, '底文件（这一轮刚建立，**还没搞完**：真数据还在路上）', 'pending'));
    return out;
}

/* ★★★★★★ v8【按路径缓存"确认不变的文件" —— 用户 2026-09-19 点名的那条】
   用户原话："**没做简单的确认不变的文件 进行相同路径内存缓存吗？**"
   ── 答：**没做**。上一版只做了"文件名优先定位"（把每次轮询的 40 次读降到 1 次），
      而"读过的、确认没变的文件就别再读盘"这一条**没做** —— 那是最简单也最通用的一条，
      而且项目里**本来就有这个轮子**：`readTurnCached()`（v6.24.112，按「轮号｜长度｜mtime」缓存）。
      这里沿用**同一套口径**，不另开一套判据。
   ── 它治的是哪一半：`attachRes()` 的轮询上限 45 次。就算有"文件名优先定位"，
      每轮至少还要 `statSync`／读一次那一份 meta；而**没命中**的那些轮次要扫 40 个。
      有了这个缓存 ⇒ 同一个文件**一生只被真读一次**，之后每轮只花一次 `statSync`
      （一次 stat 比"打开＋读＋JSON.parse"便宜一个量级，而且再也不会重复解析）。
      ⚠ 缓存是**模块级**的 ⇒ 不只一次 `attachRes` 内部有效，**跨轮次**也有效
        （同一场聊天连续几轮会反复扫同一个目录）。
   ── ⚠ 不许假设"它不会变"：判据是**可观测的事实** —— `size` 与 `mtimeMs` 都没变才用缓存。
      变了就重读（重 roll、回填、人工改动都会让 mtime 变）。
   ── ⚠ 上限：抓包目录一天 482 个文件 ⇒ 缓存加个顶，超了就丢最老的（Map 保持插入序，
      从头删就是丢最老的）。丢掉的代价只是"下次重新读一次"，**永远不会读到旧内容**。 */
const META_CACHE = new Map();                       // <绝对路径> → { size, mtimeMs, meta }
const META_CACHE_MAX = 800;
function readMetaCached(fp) {
    try {
        const st = fs.statSync(fp);
        const hit = META_CACHE.get(fp);
        if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.meta;
        const meta = JSON.parse(fs.readFileSync(fp, 'utf8'));
        META_CACHE.set(fp, { size: st.size, mtimeMs: st.mtimeMs, meta });
        while (META_CACHE.size > META_CACHE_MAX) {
            const k = META_CACHE.keys().next().value;
            META_CACHE.delete(k);
        }
        return meta;
    } catch (_) { return null; }                    // 读不到 ⇒ 如实返回 null（调用方照旧 continue）
}

async function attachRes(dir, no, reqSha, tries = 45, ver = {}) {    // ⚠ 路径口径复用 `wireDirCands()`（**不许写死本机绝对路径**，目标⑦(c)）——
    //   它是"抓包插件目录"的候选表，`captures/` 就在它下面。
    const wireRoots = wireDirCands().map(d => path.join(d, 'captures'));
    const dest = path.join(dir, 'turns', `${String(no).padStart(5, '0')}.res.txt`);
    const destMeta = path.join(dir, 'turns', `${String(no).padStart(5, '0')}.res.meta.json`);
    const destVer = path.join(dir, 'turns', `${String(no).padStart(5, '0')}.ver.json`);
    /* 抓包的版本（三件套之 ③ 是它落的响应）—— 拿不到就如实空着，**不猜**。
     * ★ 2026-09-24【合并】：原来是**走 HTTP** 问 `/api/plugins/horae-wiretap/status` 拿这个数，
     *   而那个地址里**写死了 `127.0.0.1:8000`** —— 换端口 / 远程访问就废，还白搭一次往返。
     *   现在抓包就是本插件的一个模块 ⇒ 直接读它导出的 `WIRE_V`。 */
    let wireV = '';
    try { wireV = String((await tapModule())?.WIRE_V ?? ''); } catch (_) { }
    // ★ 中断识别（用户："还是说返回了一半被我中断了…都得说明状态"）：
    //   只要**抓到过同 sha256 的请求 meta、而它对应的响应文件不在** ⇒ 就是"请求到了、响应没落盘"
    //   （对端断开 / 用户点了停止）⇒ 状态写 `aborted`（搞了一半）而**不是** `failed`（根本没搞到）。
    let sawReqNoRes = false;
    for (let i = 0; i < tries; i++) {
        try {
            if (fs.existsSync(dest)) {
                // ⚠ 上一次等到超时留下的**占位文件**不算数 ⇒ 删掉重等（回填路径），
                //   否则"补写"会永远卡在第一次失败上（用户点名："里面的内容等时机到了回填"）。
                let held = false;
                try { held = fs.readFileSync(dest, 'utf8').startsWith('[占位·待回填]'); } catch (_) { }
                if (!held) return true;
                try { fs.rmSync(dest, { force: true }); } catch (_) { }
            }
            const days = [];
            for (const W of wireRoots) {
                try { for (const d of fs.readdirSync(W)) if (!days.includes(d)) days.push(d); } catch (_) { }
            }
            days.sort(); days.reverse();
            for (const day of days.slice(0, 2)) {
                for (const W of wireRoots) {
                const dd = path.join(W, day);
                let files = [];
                try { files = fs.readdirSync(dd).filter(f => f.endsWith('.res.meta.json')); } catch (_) { continue; }
                files.sort().reverse();                              // 新的在前
                /* ★★★★★★ v8【IO 优化：先按**文件名**定位 —— 别每次轮询都把 40 个 meta 重读一遍】
                   用户 2026-09-19："官方的流返回api 我们的存盘太吃IO了 电脑很卡"
                   ── 盘上量出来的真凶：**这一段**。它长在 `attachRes()` 的**轮询循环内部**
                      （轮询上限 45 次），每一次都 `readdirSync` ＋ 最多读 **40 个** `.res.meta.json`
                      再 `JSON.parse`。最坏 45 × 40 ×（2 天 × 每个抓包根）≈ **上万次小文件读** ——
                      而且**每一轮读的都是同一批文件**（它们又不会变）。这才是"太吃 IO"里最大的一块：
                      比那一份 7.7 MB 的 res.txt 大得多，因为它是**重复**上万次。
                   ── 修法的依据（不是猜）：抓包侧给响应起名时用的是
                      `req-<bodyHash 前 8 位>`（`save()` 里 `chatKey = 'req-' + bodyHash.slice(0, 8)`），
                      而那个 `bodyHash` 就是它回给 `/turn` 的 `reqSha`
                      （`saveRes` 的 meta 里也写着 `reqSha`）⇒ **文件名里那 8 位就是 reqSha 的前 8 位**。
                      于是把命中的那个文件排到最前 ⇒ 正常情况**第一个就读到它**、
                      读完 `return true` ⇒ 只读了 **1 个** meta（原来是 40 个 × 每轮）。
                   ⚠ 两条边界，都不许含糊：
                      · 文件名**只用来"先筛一遍"，绝不拿它当判据** —— 下面仍然要求
                        `meta.reqSha === reqSha` **完整 sha256 逐位相等**才算命中；
                      · 万一命名规则变了（文件名没命中）⇒ `named` 为空 ⇒ 退回原来的
                        `files.slice(0, 40)` 慢路径，**行为与改动前逐位相同**（不会变差，也不会漏）。 */
                const sha8 = String(reqSha || '').slice(0, 8);
                const named = sha8 ? files.filter((f) => f.includes('req-' + sha8)) : [];
                const scan = named.concat(files.slice(0, 40));
                for (const f of scan) {
                    /* ★ v8：走**按路径缓存**（size ＋ mtime 都没变就直接用内存那份，
                       同一个文件一生只真读一次）—— 见 `readMetaCached` 抬头那段。 */
                    const meta = readMetaCached(path.join(dd, f));
                    if (!meta) continue;
                    if (String(meta?.reqSha || '') !== reqSha) continue;
                    const src = path.join(dd, String(meta.resFile || ''));
                    if (!fs.existsSync(src)) { sawReqNoRes = true; continue; }
                    fs.copyFileSync(src, dest);
                    try { fs.writeFileSync(destMeta, JSON.stringify({ ...meta, turnNo: no, from: `${day}/${meta.resFile}` }, null, 2), 'utf8'); } catch (_) { }
                    // ★★★★★★ 每轮一份**版本戳**（用户 2026-09-19 点名："你的每轮三个文件，记得加版本戳啊"）：
                    //   它不是第四份数据，而是**这一轮三件套的身份证** —— B/S 是哪一版写的、三份各自的 sha256。
                    //   有了它，日后对账时"这份文件是哪套代码产出的"不用再靠时间戳猜。
                    let verInfo = null;
                    try {
                        /* ★ v6.51.1：`f` 改成**按候选顺序试**（新名 `.json` 优先、老轮次退 `.txt`）——
                         *  三份 JSON 存档改名后，写死老名会永远算不出 sha（`rawInfo` 那类恒 null 的老病）。 */
                        const f = (...ps) => { for (const p of ps) { try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (_) { } } return ''; };
                        const candsOf = (kind) => turnRelCands(kind, no).map(r => path.join(dir, ...r.split('/')));
                        const k0 = String(no).padStart(5, '0');
                        verInfo = {
                            轮: no,
                            at: new Date().toISOString(),
                            版本: { B: String(ver.cli || '?'), S: String(ver.srv ?? ROUTE_V), 抓包: wireV },
                            tokSrc: String(ver.tokSrc || ''),
                            指纹: {
                                /* ★ v6.51.1：三份 JSON 存档改名后，指纹要按**盘上真名**算
                                 *  （新名 `.json` 优先、老轮次退 `.txt`）—— 写死老名会永远算不出 sha。 */
                                raw原始: ver.rawSha || f(...candsOf('raw')),
                                wire修改: ver.wireSha || f(...candsOf('body')),
                                // ★ v7：优先用抓包插件自己算的原文 sha（与 `.res.meta.json` 的那个
                                //   逐位相等 ⇒ 两份文件互为凭证）；老记录没这个字段才现算。
                                res返回: String(meta.sha256 || '') || f(dest),
                            },
                            usage: meta.usage || null,
                            来源: { reqSha, resFile: meta.resFile, day },
                            wiretapVer: wireV,
                        };
                        fs.writeFileSync(destVer, JSON.stringify(verInfo, null, 2), 'utf8');
                    } catch (err) { horaeWarn('[hitOpt] git 记录：版本戳写不进去:', err?.message || err); }
                    // 三件套到齐 ⇒ 状态从 pending 改 present；**不完整的一律如实标 partial**。
                    //   ★★★★★★ v7（2026-09-19）：原来这一行是 `truncated === true && done !== true`
                    //     —— 而抓包插件**旧版**截断原文时 `done` 是 true（流确实正常收完了）
                    //     ⇒ 判据恒假 ⇒ 一份被省略掉 **1,146,544 字**的文件被标成了 `present`，
                    //     note 里还写着"抓包插件落的那份响应（1168544 字节）"。**状态在替我撒谎。**
                    //     用户原话："我曹尼玛 你是这样给我记录官方的返回的？ ！原！始！文！件！！"
                    //   现在分三种"不完整"，**各有各的判据与说法**（混成一条就又会撒谎）：
                    //     ① cut   = 抓包插件旧版（v6 及以前）"留头尾、中间省略" ⇒ 中间**永久缺失**
                    //     ② cap   = 抓的时候撞了内存上限、尾部没接住（v7 的 overCap）
                    //     ③ unfin = 流没正常收尾（用户中断 / 连接断了）⇒ 内容是收到的那部分
                    const cut = (meta.truncated === true);
                    const cap = (meta.overCap === true);
                    /* ★★★★★★ v8【判据接上"这一发到底收完没有" —— 抓包插件 v8 起在 meta 里记 `res.sawEnd`】
                       用户 2026-09-19 点名："官方的流返回api 我们的存盘太吃IO了 电脑很卡
                       需要先内存暂存，若持续3s没有增长则才存盘并标记成败"
                       ── 老判据只有 `meta.done !== true`（＝没见到 SSE 的 `[DONE]`），
                          它把两件事混成了一件：**"流被掐断、内容不完整"** 与 **"收完了但没看到 [DONE]"**。
                       ── 抓包插件 v8 起落盘时机改成"连续静默 3 秒才写"，并如实记下：
                            · `res.sawEnd` = HTTP 响应**正常收尾**（end 事件）
                            · `res.why`    = 按哪条路结算的（idle / idle-end / idle-close / idle-err / idle-reqerr）
                            · `res.err`    = 出错时的原因
                          ⇒ 现在必须**两个都是"不完整"的证据**才判 unfin：既没见到 `[DONE]`、连接也没正常收尾。
                       ⚠ 老记录（没有 `res.sawEnd`）：`undefined !== true` ⇒ 退回旧判据（`done !== true`），
                         **一个字都没放宽** —— 盘上已有的判定结果不会因为这个改动而改变。 */
                    const unfin = (meta.done !== true) && (meta.res?.sawEnd !== true);
                    const k5 = String(no).padStart(5, '0');
                    const whyUnfin = '响应流没正常收尾（既没见到 [DONE]、连接也没正常收尾 ⇒ 用户中断或连接断了）'
                        + '⇒ 内容是**收到的那部分**，官方 usage 可能不完整'
                        + (meta.res?.why ? `（抓包插件 v8 结算路径 ${meta.res.why}${meta.res.err ? '｜错误：' + meta.res.err : ''}）` : '');
                    const whyCut = `抓包插件**旧版（v6 及以前）**落盘时截过原文（留头 2000 字 ＋ 尾 20000 字）`
                        + ` ⇒ 中间约 ${Math.max(0, (Number(meta.bytes) || 0) - 22000)} 字**永久缺失**（原始返回已无法找回）`;
                    const whyCap = '抓包时撞了内存上限（1,600 万字）⇒ 尾部没接住';
                    updateStatus(dir, no, {
                        res: (cut || cap || unfin)
                            ? { state: 'partial', file: `${k5}.res.txt`, why: [unfin ? whyUnfin : '', cut ? whyCut : '', cap ? whyCap : ''].filter(Boolean).join('；') }
                            : { state: 'present', file: `${k5}.res.txt`, note: `抓包插件（v${wireV || '?'}）落的那份响应**原文**，逐字节 ${meta.bytes || '?'} 字节｜sha256 ${String(meta.sha256 || '').slice(0, 16) || '—'}｜＋ 版本戳 ${k5}.ver.json` },
                    });
                    const u = meta.usage || {};
                    console.log(`[hitOpt] git 记录：第 ${no} 轮**模型返回**已补进记录（${meta.bytes || '?'} 字节｜`
                        + `官方 hit=${u.prompt_cache_hit_tokens ?? '—'} miss=${u.prompt_cache_miss_tokens ?? '—'} out=${u.completion_tokens ?? '—'}）`);
                    // 补进**同一次提交**（--amend 不增行数 ⇒ 面板行数恒等式不变）
                    await run(['add', '-f',
                        `turns/${String(no).padStart(5, '0')}.res.txt`,
                        `turns/${String(no).padStart(5, '0')}.res.meta.json`,
                        `turns/${String(no).padStart(5, '0')}.ver.json`], dir);
                    await run(['commit', '-q', '--amend', '--no-edit'], dir);
                    console.log(`[hitOpt] git 记录：第 ${no} 轮**版本戳**已落 turns/${String(no).padStart(5, '0')}.ver.json`
                        + `（B ${verInfo?.版本?.B || '?'} / S ${verInfo?.版本?.S || '?'} / 抓包 ${wireV || '?'}）`);
                    return true;
                }
                }
            }
        } catch (err) { horaeWarn(`[hitOpt] git 记录：模型返回补写第 ${i + 1} 次失败:`, err?.message || err); }
        await new Promise(r => setTimeout(r, 2000));
    }
    const why = sawReqNoRes
        ? '抓到了这一轮的请求（sha256 对得上），但**响应没落盘** —— 多半是对端断开 / 用户在生成中点了停止 ⇒ 这一份只有"请求发出去过"，没有返回'
        : `等了 ${tries * 2} 秒，抓包插件压根没落这一轮的请求（插件没开 / 请求根本没发出去 / 直接失败了）`;
    const wrote = writePlaceholder(dir, no, '③返回', why, sawReqNoRes ? 'aborted' : 'failed');
    updateStatus(dir, no, { res: { state: sawReqNoRes ? 'aborted' : 'failed', why, file: `${String(no).padStart(5, '0')}.res.txt`, placeholder: wrote } });
    try {
        await run(['add', '-f', `turns/${String(no).padStart(5, '0')}.res.txt`, `turns/${String(no).padStart(5, '0')}.status.json`], dir);
        await run(['commit', '-q', '--amend', '--no-edit'], dir);
    } catch (_) { }
    horaeWarn(`[hitOpt] git 记录：第 ${no} 轮的**模型返回**等了 ${tries * 2} 秒没等到（抓包插件没开 / 请求失败）—— 已落**占位文件**占坑，内容等回填`);
    return false;
}

/**
 * 把 git 记录的路由挂到酒馆的 router 上（前缀由酒馆决定：/api/plugins/horae-git）
 * @param {import('express').Router} router
 */
export async function init(router) {
    const ROOT = defaultRoot();
    fs.mkdirSync(ROOT, { recursive: true });
    const repoOf = (chat) => path.join(ROOT, safe(chat));

    /** ★ v6.24.53：取「某次提交里某个文件」的正文 —— 取不到就**如实说**，并给一条**兜底**：
     *  退回工作区那份同名文件（工作区那份是同一轮写下去的那一份，只在"记录仓库被重建过"时会与提交里那份不同）。
     *
     *  为什么非要有这一条（用户实测问过来的）：他 F5 回旧记录，差异页**一个字都没有**（`0 插入 0 删除`）。
     *  查下去：那一页记的两个 sha（`f58f606` / `3C3C54c`）**在当前仓库里已经不存在**
     *  （这个聊天仓库 `.git` 是 11:03:18 才建起来的 —— 历史被重建过），于是 `git show` 两边都给了空串、
     *  `git diff 空 空` 当然"什么都没改"。**页面把"记录没了"画成了"两轮一模一样"** —— 这是编数，用户口径里明令不许。
     *  现在：`git show` 失败 → 回落到工作区那份文件（还在就还能看 diff），并在响应里带 `missingBlob`，
     *  由差异页明说"这一页记的提交已经不在仓库里了（记录被重建过），下面比的是盘上现存的那两份"；
     *  工作区那份也没有 → 返回 `ok:false`，页面直说"这两轮的记录已经不在硬盘上了"，不画空 diff。
     *
     *  ⚠ 路径只认 `turns/NNNNN.txt` 与 `sim/NNNNN.sim.txt`（都在这个仓库里），别的一律拒绝 ——
     *    这几个值来自前端，不能让 `../../` 之类的路径穿出去。
     * @returns {Promise<{content:string, via:string, note:string}>} via: 'blob' | 'worktree' | ''
     */
    const readBlobRel = async (dir, ref, rel) => {
        const r = String(rel || '');
        /* ⚠ 路径白名单（防 `../../` 穿出去）。★ v6.36.0：**加进 `turns/NNNNN.raw.txt`** ——
         *  用户 2026-09-19 报："我的池化差异 显示不出来！！！也就是 本轮池化后 对比 本轮原文 ——
         *  这两个都是存在本地的文本文件啊 你这都不对上？"
         *  根因就在这里：白名单原来只认 `turns/NNNNN.txt`，而「池化差异」要的前一份是
         *  `turns/NNNNN.raw.txt`（酒馆原样）⇒ 服务端判"路径不认" ⇒ 前面那份读不到 ⇒ `ok:false`
         *  ⇒ 差异页显示不出来。**git 本身完全能比**（实测 `git diff HEAD:turns/00002.raw.txt
         *  HEAD:turns/00002.txt` 给出 9 行正常 patch），是这道白名单把它挡在了门外。 */
        /* ★ v6.51.1：白名单同时收**新名与老名**（三份 JSON 存档 2026-09-20 从 `.txt` 改成 `.json`）。 */
        if (!/^(turns\/\d{5}\.(?:txt|json)|turns\/\d{5}\.raw\.(?:txt|json)|turns\/\d{5}\.abc\.(?:txt|json)|sim\/\d{5}\.sim\.txt)$/.test(r)) {
            return { content: '', via: '', path: '', note: `路径不认（只认 turns/NNNNN.{json,txt}、turns/NNNNN.raw.{json,txt}、turns/NNNNN.abc.{json,txt} 与 sim/NNNNN.sim.txt）：${r}` };
        }
        /* ★★★★★★ v6.51.1【两个名字都试 —— 同一次改名里**最容易漏、后果最脏**的一处】
         *  为什么非试不可：`/diff` 比的是**两个 git 提交里的 blob**，而
         *   · 改名**之前**的提交里只有 `.txt`（历史不许重写）；
         *   · 改名**之后**的提交里只有 `.json`（迁移走 `git mv` ＋ 每仓一次机械提交）。
         *  ⇒ 客户端递进来的是哪个名字，与那个 ref 里叫哪个名字**毫无关系**。只按递进来那个名字
         *    `git show` 会失败 ⇒ 静默落到"工作区那一份" ⇒ **拿这一轮的内容去比上一轮**：
         *    页面照样画出一页 diff，比的两侧却互不相干＝**编数**（用户口径里明令不许）。
         *  ⚠ 顺序：**先按递进来的原样**（那是调用方认定的那一个），再退到另一个名字。 */
        const relCands = [r];
        /* `.sim.txt` 没改过名 ⇒ 不翻；其余三类（正文 / raw / abc）翻一次就够。 */
        if (!/\.sim\.txt$/.test(r)) relCands.push(r.replace(/\.(txt|json)$/, (m) => (m === '.json' ? '.txt' : '.json')));
        const shaRaw = String(ref || '').split(':')[0];
        const sha = /^[0-9a-fA-F]{4,40}$|^HEAD(~[0-9]+)?$/.test(shaRaw) ? shaRaw : '';   // 只认 sha / HEAD，别的一律不拼进命令
        if (sha) {
            for (const cand of relCands) {
                const s = await run(['show', `${sha}:${cand}`], dir);
                if (s.code === 0 && s.out) return { content: s.out, via: 'blob', path: '', note: '' };
            }
        }
        for (const cand of relCands) {
            const p = path.join(dir, ...cand.split('/'));
            try {
                return { content: fs.readFileSync(p, 'utf8'), via: 'worktree', path: p, note: '' };
            } catch (_) { }
        }
        return { content: '', via: '', path: path.join(dir, ...relCands[0].split('/')), note: `提交里没有、盘上也不在：${relCands.join(' ／ ')}` };
    };

    // 酒馆一启动就先按上限清一次（上次运行留下的旧聊天仓库在这里被收掉；当前聊天由 /turn 自己带）
    void pruneChatRepos(ROOT, CHAT_KEEP).then(removed => {
        if (removed.length) console.log(`[hitOpt] git 记录：超过 ${CHAT_KEEP} 个聊天上限，已清掉最旧的 ${removed.length} 个（${removed.slice(0, 5).join('、')}${removed.length > 5 ? '…' : ''}）`);
    });

    // 健康检查：前端用它判断"接没接上"、显示 git 版本，并用 v 判断模块新旧
    router.get('/status', async (_req, res) => {
        const v = await run(['--version'], ROOT);
        let chats = [];
        try {
            chats = fs.readdirSync(ROOT, { withFileTypes: true })
                .filter(e => e.isDirectory() && isOurRepo(path.join(ROOT, e.name)))
                .map(e => ({ name: e.name, at: lastActiveMs(path.join(ROOT, e.name)) }))
                .sort((a, b) => b.at - a.at)              // 最近在聊的排前面
                .map(c => c.name);
        } catch { chats = []; }
        // ★ v6.24.55【可移植性】把自己**真实的挂载名**报出去（`id` 就是酒馆用来拼路由的那一个：
        //   `plugin-loader.js` → `app.use('/api/plugins/' + info.id, router)`）。
        //   为什么必须报：客户端原来是**写死** `/api/plugins/horae-git` 的 ——
        //   宿主哪天把 `info.id` 改一个名（或有人想 fork 一套并列装两遍），前端就整条链断掉，
        //   而且报错只会是"没接上"，看不出是名字对不上。现在客户端从这份响应里**学到**它。
        /* ★ 2026-09-24【合并】：抓包**已经并进本插件**（挂在 `/tap/…`）⇒ 同伴就是自己。
         *   客户端可以靠这一条判断"抓包在不在同一个插件里"（老版各自独立时报的是对方的名字）。 */
        res.json({ ok: true, native: true, v: ROUTE_V, id: info.id, peer: 'hitopt-git', tap: '/tap', git: v.out.trim(), root: ROOT, chats, keep: CHAT_KEEP });
    });

    // ★ v6.24.72【可移植性 · 自检属于 Horae 本体】—— 一个请求回答"现在要不要用户做点什么"。
    //   为什么做在**服务端**（用户 2026-09-17 定版原话）：
    //     「提问 监视器是 horae 里面的吗？不要写成外部的东西啊　我们的行动目标还有可移植性」
    //   以前"自动发现用户动作"靠的是工作台上一个**由人起停的外部 node 进程**（tools/auto_monitor.mjs）——
    //   换台机器就没有、还得人工起停，别人装了 Horae 也拿不到这套诊断。
    //   现在它随酒馆启动、随三仓分发：`GET /api/plugins/<info.id>/selfcheck` 就是全部入口。
    //   ⚠ 只走 **GET**（不碰 CSRF、不要令牌，浏览器直接敲地址就能看）；**只读盘、不写任何东西**。
    //   ⚠ 判不出来就如实说判不出来 —— 不猜、不拿别的数顶上（§2.3）。
    //   ⚠ 路径不许写死：客户端是从 /status 里**学到** info.id 再去拼的（v6.24.55 的可移植性口径）。
    router.get('/selfcheck', async (_req, res) => {
        try { res.json(await buildSelfCheck(ROOT)); }
        catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
    });

    // ★ v6.24.54：**这一轮用哪个编号** —— 只建仓库 + 报号，**不写文件、不提交**。
    //   为什么单开一条：抓包在传输层，比"这一轮量测开始"晚 ~4 秒才落盘；客户端现在**等它落盘再提交**
    //   （拿不到出网原文就不写、不提交 —— 用户定版"本地快照是历史死代码，我们只管最终出网"）。
    //   等待期间要重试好几次，而 `/turn` 是"拿仓库里已有文件的最大编号 +1"发号的 ——
    //   重试要是各自发号，会跳号、甚至把编号顺序搞反（提交顺序 = 落盘顺序）。
    //   所以先在这里把编号钉住，之后所有重试都带同一个 `no` 提交。
    router.post('/reserve', async (req, res) => {
        const body = req.body || {};
        if (body.migrateFrom) migrateRepo(body.migrateFrom, String(body.chat));
        const dir = await ensureRepo(repoOf(safe(body.chat)));
        // ★ v6.24.58：多报一个 `headNo` = **HEAD 那一轮的编号**。
        //   为什么非要它：重 roll（重新生成）要"覆盖上一轮"，编号必须复用 HEAD 那一轮的 ——
        //   而 `no` 是"下一个新号"，重 roll 时用它就会**多记出一行重复**
        //   （用户实测：同一次重 roll，`no=1` 与 `no=2` 两份 turns 逐字节相同、差异页画"逐字一致"）。
        //   编号只有服务端算得准（它才知道仓库现状），客户端不再靠"上一行"去猜。
        const headNo = await headTurnNo(dir);
        res.json({ ok: true, no: nextTurnNo(dir), headNo: Number.isFinite(headNo) ? headNo : null, v: ROUTE_V });
    });

    // 记一轮：写 turns/<no>.txt（出网原文）→ git add → git commit。
    // ★ v6.24.101：**一次出网一个提交** —— 重 roll（swipe）也照旧追加，绝不删上一发。
    router.post('/turn', async (req, res) => {
        const body = req.body || {};
        /* ⚠⚠【临时诊断埋点·查完必删】⚠⚠
         * 为什么在**服务端**也留一条：客户端埋点显示"取到了真抓包（ok:true）"之后就**没有下文**了
         * （既没有 `committed` 也没有 `commitThrow`）—— 到底是"这一跳压根没发出去"、
         * 还是"发出去了服务端没答/答了非 JSON"，光看客户端看不出来。
         * 这里记"请求真的到达了" + 处理结果，两边一对就能定位。
         * 与客户端的 `_diagReport`、wiretap 的 `GET /diag` 是同一条临时线，闭环后一起删。 */
        try {
            horaeWarn(`[hitOpt] git 记录【诊断】收到 /turn：chat=${String(body.chat || '')}`
                + ` no=${Number(body.no)} hasWire=${typeof body.wire?.body === 'string'}`
                + ` wireLen=${(body.wire?.body || '').length} jsonLen=${JSON.stringify(body).length}`);
        } catch (_) { }
        if (body.migrateFrom) migrateRepo(body.migrateFrom, String(body.chat));
        const chat = safe(body.chat);
        const dir = await ensureRepo(repoOf(chat));
        // 编号由服务端决定（它才知道仓库现状）：swipe = 复用上一轮编号（先 reset 回滚再提交）
        let no = Number(body.no);
        const swipe = body.swipe === true;
        // ★ v6.24.58：`swipe` 时**一律以 HEAD 那一轮的编号为准**（在回滚**之前**问，问到的就是被覆盖那轮）。
        //   为什么不信客户端传来的 `body.no`：老客户端（v6.24.58 之前）在重 roll 时传的是
        //   `/reserve` 给的**新号** ⇒ 服务端会把 `turns/0000N.txt` 当**新一轮**提交，
        //   于是同一次重 roll 在面板上变成两行、差异页显示"逐字一致"（用户实测）。
        //   这一条兜底让**旧客户端 + 新服务端**也不会记错。
        //   ⚠ 顺序要紧：`headTurnNo` 必须在回滚**之前**取（回滚之后 HEAD 就换人了）。
        //
        // ⚠⚠ ★★★ v6.24.103【v6.24.101 的"重 roll 也追加"**当场撤回**】⚠⚠
        //   用户实测结论（原话）："测试了几轮 **效果不如 git reset**" ＋
        //   "**LCP在无限增长 哪怕我删除重roll了楼层**" ＋ "重roll的没了就没了吧"。
        //   101 的出发点是"那一发真花过钱、不该从盘上消失"（事实没错），代价却落在**基准挑选**上：
        //   客户端 `_prevMsgsPickBest`（v6.24.86）从最近 3 份候选里挑**LCP 最长**的一份，
        //   而同一楼重 roll 出来的几发内容彼此极像 ⇒ 它**每次都挑中上一次重 roll 的那一发**，
        //   把"用户已经丢弃的那份字"当基准拼回去 ⇒ 面板 lcp 逐发上涨，官方却不会命中它。
        //   实测（`圣樱学院_mu5q3ymmo3ld`，同一个第 21 楼连发 4 次）：
        //     #14 lcp=171,736 → #15 **177,983** → #16 177,983 → #17 177,983。
        //   ⇒ 盘上**只留"最终那一发"**才是对的：记录仓库是**当前聊天状态的镜像**，不是出网流水账。
        //     被 reset 掉的那一发随之消失 —— 用户已明确接受（"没了就没了吧"）。
        //   ⚠ 别再拿"完成定义里那条 显示行 == 真发出过的请求数"来反驳：那条要成立的场景是
        //     **正常发送**；重 roll 是"同一楼原地替换"，被替换掉的那一发不算一行（v6.24.58 定版）。
        if (swipe) {
            const h = await headTurnNo(dir);
            if (Number.isFinite(h)) no = h;
        }
        if (!Number.isFinite(no)) {
            no = swipe ? (await headTurnNo(dir)) : null;
            /* ★★★★★★ 2026-09-24【同一发被记两遍 ⇒ 复用旧号，不新增】
             *   判据与理由见 `findSameSendNo` 上面那一大段。
             *   ⛔ 只在**非 swipe** 时走：真重 roll 的两次请求各有各的 `proofAt`，判据③ 不会命中。 */
            if (!Number.isFinite(no) && !swipe) {
                const dupNo = await findSameSendNo(dir, body);
                if (Number.isFinite(dupNo)) {
                    horaeWarn(`[hitOpt] 这一发与 #${dupNo} **逐字节同一发**（出网原文 sha256 相同；`
                        + `proofAt 相同或缺失；5 分钟内）⇒ 覆盖它、**不新增轮号**`
                        + `（客户端一次生成会调两次 /turn，第二次不该再占一个新号）`);
                    no = dupNo;
                }
            }
            if (!Number.isFinite(no) || no === null) no = nextTurnNo(dir);
        }
        if (swipe) {
            // ★ v6.24.58【真 bug 修复】原来这里只有 `git reset --hard HEAD~1`，**而且不看返回值** ——
            //   实测（`check/swipe_cover_test.mjs` ②）：仓库里**只有 1 个提交**时（第一次回复就重 roll，
            //   这是最常见的重 roll 场景）`HEAD~1` 根本不存在 ⇒ git 报
            //   `fatal: ambiguous argument 'HEAD~1'`、退出码 128 ⇒ 回滚**静默失败** ⇒
            //   紧接着的新提交被**追加**上去 ⇒ 同一次重 roll 记成两轮（提交数 2、面板多一行）。
            //   现在：按"有没有父提交"分两条路，**并且检查返回值**，失败就如实报错、不装作成功。
            const parent = await run(['rev-parse', '--verify', '--quiet', 'HEAD~1'], dir);
            const hasParent = parent.code === 0 && !!parent.out.trim();
            if (hasParent) {
                const r = await run(['reset', '--hard', 'HEAD~1'], dir);
                if (r.code !== 0) {
                    horaeWarn(`[hitOpt] git 记录：swipe 回滚失败（${r.err.trim() || '未知原因'}）→ 这一轮不写、不提交`);
                    return res.status(500).json({ ok: false, error: `swipe 回滚失败：${r.err.trim() || '未知原因'}` });
                }
            } else {
                // 还没有父提交（这是仓库的第一个提交）⇒ `HEAD~1` 不存在，得把 HEAD 本身丢掉。
                // `update-ref -d HEAD` 是 git 认可的"删掉唯一那个提交"的做法：提交对象没了、
                // 分支回到"还没有提交"的状态；接着 `reset --hard` 把工作区也清干净，
                // 这样后面写盘 + `git add -A` 出来的就是**这一轮的内容**，不会把上一轮那份又加回来。
                const del = await run(['update-ref', '-d', 'HEAD'], dir);
                if (del.code !== 0) {
                    horaeWarn(`[hitOpt] git 记录：swipe 回滚首个提交失败（${del.err.trim() || '未知原因'}）→ 这一轮不写、不提交`);
                    return res.status(500).json({ ok: false, error: `swipe 回滚失败：${del.err.trim() || '未知原因'}` });
                }
                // ⚠ 这里**不用** `reset --hard`：HEAD 没了之后它会把工作区也清空 ——
                //   连 `turns/` 目录一起删掉，紧接着的写盘就 `ENOENT`（实测踩到）。
                //   `read-tree --empty` 只清**索引**，目录留着，后面写盘 + `git add -A` 照常。
                await run(['read-tree', '--empty'], dir);
            }
        }
        // ★ v6.24.36：内容来源 = **出网原文**（抓包在传输层截下的 POST body）。
        //   用户定版："将原文与差异，数据源全部改为真出网原文"＋"一样的硬盘 git 存储，单纯的来源变了 其他没变"。
        //
        // ★ v6.24.54【用户定版："本地快照是历史死代码，给我删了吧，我们只管最终出网"】——
        //   这里以前有一条"拿不到出网原文（抓包没开／酒馆没重启）就退回客户端那份 `body.text` 本地快照"的
        //   后路，抬头写「本地快照（没抓到出网原文）」。**那条后路整段删掉**：
        //   git 存档里的字**必须**是最终出网那一份（实测全仓 125 轮里有 12 轮存档是本地快照，
        //   其中 10 轮的抓包就在落盘前 4~7 秒躺在盘上）。没有 `wire.body` → 直接 400、**一个字都不写**，
        //   客户端那边会**等抓包落盘再提交**（见 `_gitLogPushTurn` 的等待循环）。
        //   连带删掉：`body.text` 这条输入、抬头里的「本地快照」标签（写入侧不再产生它；
        //   读取侧 `parseTurnFile` 仍认「本地快照」，因为**盘上的老记录**里还有这种字，不能装作看不见）。
        if (typeof body.wire?.body !== 'string' || !body.wire.body) {
            horaeWarn(`[hitOpt] git 记录：这一轮没带**出网原文**（chat=${chat}）→ 不写、不提交。`
                + `客户端应当等抓包落盘再提交；抓包模块挂上了吗（本插件目录下的 wiretap.mjs，路由 /api/plugins/hitopt-git/tap/…）？`);
            return res.status(400).json({
                ok: false,
                error: '这一轮没带出网原文（wire.body）：记录只写最终出网那一份，本地快照一律不落盘（用户定版）',
            });
        }
        // ★ v6.24.68【用户定版："换行美化是我们的事情，你连真实内容都敢格式化？存盘必然是真实文本"】
        //   存盘 = 抓包截下的**真 POST body，逐字节原样**（一个字节都不动）。
        //   为什么非改不可（用户拿盘上的文件跟抓包一对，当场报过来）：
        //     以前存的是 `flattenWire()` **铺平重排**过的可读文本 —— 三处对不上：
        //     ① 格式被重排成 `── #i role ──`，不是发出去的那份字节；
        //     ② body 顶层那 8 个参数（temperature / max_tokens / stream / presence_penalty /
        //        frequency_penalty / top_p / thinking / reasoning_effort）**一个都没进档**（只有 model 留了个名）；
        //     ③ 抬头上却写着"出网原文，逐字节未改"—— 对整份文件根本不成立。
        //   ⇒ 铺平**只属于展示层**：`/log` 算 lcp、`/diff` 比两份文本时**在内存里现铺**（`flattenWire`），
        //     一个字都不许落盘。这样"硬盘上那份文本"就等于"发给官方的最终产物"（用户口径 §2.7）。
        let rawBody = '';                  // ★ 出网原文（POST body 逐字节）
        let turnHead = '';                 // 归档抬头（元数据）—— 正文里一个字都不放
        let wireInfo = null;
        try {
            // ★ v6.24.39：`wire.tok` = 前端在**这一份出网原文**上用酒馆分词器数出来的 prompt token
            //   （＋ chat 模板开销）—— 写进抬头第一格，面板「本地请求Token」读的就是它。
            //   没给就写 0（面板显示"—"），**不拿本地那份的数冒充**：两者数的不是同一串字。
            const wireTok = Math.max(0, Number(body.wire.tok) || 0);
            // ★ v6.24.42：实测断点（客户端量的）随出网原文一起收下 ——
            //   优先 `body.wire.lcp`（与出网那份字同源），没有就退回 `body.meta.lcp`
            //   （老前端只放在 meta 里）。都没有就**不写**那段（面板那一列会写"给不了"，不编数）。
            const wireLcp = (body.wire && body.wire.lcp) ? body.wire.lcp : (body.meta?.lcp || null);
            rawBody = String(body.wire.body);                      // ★ 落盘用这一份：逐字节原文
            // ★ v6.24.76：**服务端在这份原文上自己数一遍**（用酒馆那份真 DeepSeek 分词器）——
            //   这才是"本地 vs 官方"该用的数：同一串字、同一套分词，实测 21/21 与官方 prompt_tokens 逐位相等。
            //   客户端报的 `body.wire.tok` 留着（它是"出发那一刻客户端手里那份数组"的数，抬头里那格 tok 仍是它），
            //   但从这一版起，面板/自检对账读的是下面这个 exactTok。
            const exactTok = await exactPromptTok(rawBody);
            const flat = flattenWire(rawBody, wireTok, wireLcp, {
                cli: body.wire?.ver, tokSrc: body.wire?.tokSrc,
                /* ★ v6.39.11：这一轮是**哪个算法**装配的（与 cli 同性质，一起进抬头）——
                 *   用户："给每一轮的数据 标记 来自什么版本算法，跟BS双端版本一个性质"
                 *   （理由：中途切算法继续跑之后，修 bug 时大家会对"这数是谁算的"认知错乱）。 */
                algo: body.wire?.algo, algoVer: body.wire?.algoVer, algoKind: body.wire?.algoKind,
            }, exactTok);
            turnHead = flat.head;          // 抬头搬去旁文件
            wireInfo = {
                n: Number(body.wire.n) || null, bytes: Number(body.wire.bytes) || null,
                sha256: String(body.wire.sha256 || ''), file: String(body.wire.file || ''), tok: wireTok,
                lcp: (wireLcp && Number.isFinite(Number(wireLcp.tok)))
                    ? { tok: Number(wireLcp.tok), chars: Number(wireLcp.chars) || 0, item: Number(wireLcp.item), role: String(wireLcp.role || '') }
                    : null,
            };
        } catch (err) {
            // ★ v6.24.54：解析不了就**不写**（以前这里退回本地快照 —— 那条路已经删了）。
            horaeWarn('[hitOpt] git 记录：出网原文解析失败 → 这一轮不写、不提交:', err?.message || err);
            return res.status(400).json({ ok: false, error: `出网原文解析失败：${String(err?.message || err)}` });
        }
        /* ★ v6.51.1：出网原文是 JSON ⇒ 落 `turns/NNNNN.json`（原 `.txt`）。 */
        const file = path.join(dir, ...turnRel('body', no).split('/'));
        // ★ v6.24.58：写盘前先把 `turns/` 建出来。`recursive` 已存在时是空操作，
        //   留着是为了兜"仓库刚 init、目录还没建"的那一步（v6.24.101 起 swipe 不再清索引，
        //   但这一句本身与回滚无关，删了没好处）。
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // ★ v6.24.68：写下去的就是抓包那份 **POST body 原文**（逐字节，不重排、不美化、不补换行）。
        // ★★★★★★ 2026-09-19【底文件先行】② 这份同理：先把三份的坑占上，② 的真内容紧跟着覆盖它。
        /* ══════════════════════════════════════════════════════════════════════════════
         * ★★★★★★ v6.27.0【三件套存档】用户 2026-09-19 点名原话：
         *   "跟我们的 req 存储一个思路，需要完全真实。也就是说 每一轮，保存多份文件，
         *    1. 真实未经过 Horae 修改的请求原本、2. 经过 horae 修改的请求体、
         *    3. 服务器的返回 Request（里面含官方 usage 与输出内容）。
         *    我们插件的重点任务是 2，但是 1 与 3 都必须进行存储！跟随 2 的 git 系统"
         *
         *  三份的落点（都在同一次提交里，跟 `turns/NNNNN.txt` 走同一套 git）：
         *    ② `turns/NNNNN.txt`      —— 抓包那份 POST body，逐字节（**本来就有**，不动）
         *    ① `turns/NNNNN.raw.txt`  —— 酒馆刚组装完、**Horae 一个字都没改**的那份（客户端随 /turn 带来）
         *    ③ `turns/NNNNN.res.txt`  —— 模型返回原文（含官方 usage）；由 `attachRes()` 异步补写
         *
         *  ⚠ ① 拿不到就**如实留底文件**（老客户端 / 别处调 /turn 没有这个字段），绝不用 ② 冒名顶替 ——
         *    "两份文件内容一样"和"我们没拿到原始那份"是两件事，混起来这条存档就没有诊断价值了。
         *  ⚠ ③ 是**异步**的（响应比请求晚几秒到几十秒）：`/turn` 先按 ② 提交（编号/行数都不受影响），
         *    等响应落盘后 `git commit --amend --no-edit` 把它补进**同一次提交** ⇒ 行数恒等式不变。
         * ══════════════════════════════════════════════════════════════════════════════ */
        try { ensureBaseFiles(dir, no); } catch (err) { horaeWarn('[hitOpt] git 记录：底文件建立失败:', err?.message || err); }
        fs.writeFileSync(file, rawBody, 'utf8');
        /* ══════════════════════════════════════════════════════════════════════════════
         * ★★★★★★ v6.27.0【三件套存档】用户 2026-09-19 点名原话：
         *   "跟我们的 req 存储一个思路，需要完全真实。也就是说 每一轮，保存多份文件，
         *    1. 真实未经过 Horae 修改的请求原本、2. 经过 horae 修改的请求体、
         *    3. 服务器的返回 Request（里面含官方 usage 与输出内容）。
         *    我们插件的重点任务是 2，但是 1 与 3 都必须进行存储！跟随 2 的 git 系统"
         *
         *  三份的落点（都在同一次提交里，跟 `turns/NNNNN.txt` 走同一套 git）：
         *    ② `turns/NNNNN.txt`      —— 抓包那份 POST body，逐字节（**本来就有**，不动）
         *    ① `turns/NNNNN.raw.txt`  —— 酒馆刚组装完、**Horae 一个字都没改**的那份（客户端随 /turn 带来）
         *    ③ `turns/NNNNN.res.txt`  —— 模型返回原文（含官方 usage）；由 `attachRes()` 异步补写
         *
         *  ⚠ ① 拿不到就**如实不写**（老客户端 / 别处调 /turn 没有这个字段），绝不用 ② 冒名顶替 ——
         *    "两份文件内容一样"和"我们没拿到原始那份"是两件事，混起来这条存档就没有诊断价值了。
         *  ⚠ ③ 是**异步**的（响应比请求晚几秒到几十秒）：`/turn` 先按 ② 提交（编号/行数都不受影响），
         *    等响应落盘后 `git commit --amend --no-edit` 把它补进**同一次提交** ⇒ 行数恒等式不变。
         * ══════════════════════════════════════════════════════════════════════════════ */
        let rawInfo = null;
        try {
            const rm = Array.isArray(body.raw?.msgs) ? body.raw.msgs : null;
            if (rm && rm.length) {
                const rawText = JSON.stringify({ messages: rm.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') })) });
                /* ★ v6.51.1：酒馆原文是 JSON ⇒ 落 `turns/NNNNN.raw.json`（原 `.raw.txt`）。 */
                fs.writeFileSync(path.join(dir, ...turnRel('raw', no).split('/')), rawText, 'utf8');
                rawInfo = { n: rm.length, chars: rawText.length, sha256: createHash('sha256').update(Buffer.from(rawText, 'utf8')).digest('hex') };
            }
        } catch (err) { horaeWarn('[hitOpt] git 记录：原始请求（raw）落盘失败:', err?.message || err); }
        /* ★★★★★★ v6.51.6【池化前的整份输入 ⇒ `turns/NNNNN.pre.json`】
         *  用户 2026-09-22 原话："把原文后 变量已展开 池化前的消息存起来！不出意外应该是json格式，若不是就txt存着吧"。
         *  它填的是 ①`raw`（酒馆刚组装完、Horae 一个字没改）与 ②`body`（真发出去那份）之间
         *  **一直空着的那一段** —— 池化算子（A/B/C 切分）**真正拿到的输入**。
         *  【为什么盘上原来复算不出来】`abc.json` 是**切分结果**、它带的 `B0` 只是 **B 区**的池化前原文
         *    ⇒ 拿 `raw(N-1)` 冒充 `prev` 试过，|B| 偏大 1.6 倍（见上面 abc 那段的注释）。
         *  【落点】客户端在 `_abSplit` 调用点**前一瞬间**做只读快照（msgs 已跑完入口段全部算子：
         *    套壳归一、还原链、体检；A/B/C 一个字节还没切）。
         *  ⚠ 与 `raw` / `abc` 同一纪律：客户端带就落、不带就**如实不写** —— 绝不用 `raw` 或 `body` 冒名顶替。 */
        let preInfo = null;
        try {
            const pm = Array.isArray(body.pre?.msgs) ? body.pre.msgs : null;
            if (pm && pm.length) {
                const preText = JSON.stringify({ messages: pm.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') })) });
                /* ⛔⛔ 这一行在 v6.51.13 的开发过程中被我**误删过一次** —— 搬移 cfg/diag 那一段时
                 *   把它当成了 old_string 的一部分、却没写回 new_string ⇒ `pre.json` **不再落盘**，
                 *   而语法检查（`node --check`）**完全看不出来**（`preText` 仍被 `preInfo` 用到 ⇒
                 *   没有未使用变量、没有未定义引用）。抓到它的是新验收
                 *   `check/replay_kit_test.mjs` 那条"落点在 pre 之外"的顺序钉子（它先查
                 *   `turnRel('pre', no)` 在不在 ⇒ 报 `pre@-1`）。**留着这段注释：改这一段必须重跑它。** */
                fs.writeFileSync(path.join(dir, ...turnRel('pre', no).split('/')), preText, 'utf8');
                preInfo = { n: pm.length, chars: preText.length, sha256: createHash('sha256').update(Buffer.from(preText, 'utf8')).digest('hex') };
            }
        } catch (err) { horaeWarn('[hitOpt] git 记录：池化前请求（pre）落盘失败:', err?.message || err); }
        /* ★★★★★★ v6.51.13【重放集 · 缺口3 与缺口2：两项各落一份小文件】
         *   为什么放在这里（**`pre` 那个 if 之外**）：它与 `pre` 是**独立的**两件记账 ——
         *   第一版我把它写在 `if (pm && pm.length)` 里，于是"这一轮没有 pre"就跟着一起不写了
         *   （语法完全合法，是语义错了）。口径与 `raw` / `pre` / `abc` 同一条：
         *   **客户端带就落、不带就如实不写**，绝不用别的东西冒名顶替。
         *   · `cfg`  ⇒ `turns/NNNNN.cfg.json`：这一轮**开着什么**（settings 全部标量 ＋
         *     管线级表 ＋ 槽名 ＋ 客户端版本）。逐轮查盘实测这一项全仓 **0/352** ——
         *     没有它，同一个输入在不同开关下算出来的 `A/B0/C` 不是同一回事（定理 4 第 4 项）。
         *   · `diag` ⇒ `turns/NNNNN.diag.json`：这一轮的 `pushTurn:enter` 埋点**原样**。
         *     定案 09-23 那场事故的三条铁证（abOn=0 / rsBase 空 / stState=fail）本来只活在
         *     抓包插件的 _diag.log 里 —— 它不在聊天仓、按天滚动、7 天就没了（缺口2）。
         *   ⚠ 两份都是**纯记账**：不进 messages、不参与任何判据、不影响发出去的那一串。 */
        try {
            /* ⛔⛔ 2026-09-24【真 bug：这两行一直在抛，`cfg`/`diag` **从来没落盘过**】══════════════
             *  原来写的是 `${k5}` —— 而同段 `raw`/`pre` 用的是 `turnRel()`，这两行是**漏改的**。
             *  `k5` 最近的定义在**下面 L3036**（`const k5 = String(no).padStart(5,'0')`，属于"三件套状态"
             *  那一段），**作用域在它后面** ⇒ 这两行**每一次 /turn 都抛** `k5 is not defined`，
             *  被下面的 catch 吞成一条 warn（`_errlog` 里 9/22 起累计几十条，每次 pushTurn 必报一条）。
             *  代价（`_notes` 与 STATE 里记的那两个"缺口"）：`turns/NNNNN.cfg.json` ⇒ 重放集**全仓 0 份**，
             *    而"这一轮开着什么"（settings 标量／管线级表／槽名／客户端版本）是定理 4 第 4 项的前提；
             *    `turns/NNNNN.diag.json` ⇒ 09-23 那场事故的三条铁证（abOn=0 / rsBase 空 / stState=fail）
             *    只活在抓包插件的 `_diag.log`（按天滚动、7 天就没了）。
             *  ⇒ 改用**同文件里已有的** `turnK5(no)`（L290 定义），与 `turnRel()` 同一套口径，
             *    ⛔ 不再自己写 padStart（同一个格式两处实现正是这个项目反复踩的坑）。 */
            if (body.cfg && typeof body.cfg === 'object') {
                fs.writeFileSync(path.join(dir, 'turns', `${turnK5(no)}.cfg.json`), JSON.stringify(body.cfg, null, 1), 'utf8');
            }
            if (body.diag && typeof body.diag === 'object') {
                fs.writeFileSync(path.join(dir, 'turns', `${turnK5(no)}.diag.json`), JSON.stringify(body.diag, null, 1), 'utf8');
            }
        } catch (err) { horaeWarn('[hitOpt] git 记录：cfg / diag 落盘失败:', err?.message || err); }
        /* ★★★★★★ v6.51.7【池化台账快照 ⇒ `turns/NNNNN.pool.json`】见客户端 `body.pool` 那一段的说明。
         *  它是重放充要集里**最后一块缺的**：`B2`（池化后的 B 区）由 `_amPtr` 按**指纹池**
         *  （localStorage `horae_am_pool_v1`）与**区间台账**（`horae_am_addr_v1`）算出，
         *  而这两个台账**只活在浏览器 localStorage 里** —— 盘上过去只有读数（`amN`/`amSave`），
         *  ⇒ 离线重放算不出 B2。现在把它**原样**（不解析、不改写）落一份。
         *  ⚠ 与 raw / pre / abc **同一纪律**：客户端带就落、不带就如实不写。
         *  ⚠ 体积闸门在**客户端**判（服务端不知道闸门值，两处判必然打架）——
         *    服务端只做两件事：给了就存；**没给但有 `skip` 就如实记下来**（绝不静默）。 */
        let poolInfo = null;
        try {
            const pz = (body.pool && typeof body.pool === 'object') ? body.pool : null;
            const _pc = Number(pz?.poolChars), _ac = Number(pz?.addrChars);
            if (pz && (pz.pool || pz.addr)) {
                const poolText = JSON.stringify({
                    at: Date.now(), pool: String(pz.pool || ''), addr: String(pz.addr || ''),
                    poolChars: Number.isFinite(_pc) ? _pc : -1, addrChars: Number.isFinite(_ac) ? _ac : -1,
                });
                fs.writeFileSync(path.join(dir, ...turnRel('pool', no).split('/')), poolText, 'utf8');
                poolInfo = {
                    poolChars: Number.isFinite(_pc) ? _pc : -1, addrChars: Number.isFinite(_ac) ? _ac : -1,
                    chars: poolText.length,
                    sha256: createHash('sha256').update(Buffer.from(poolText, 'utf8')).digest('hex'),
                };
            } else if (pz && pz.skip) {
                poolInfo = {
                    skipped: String(pz.skip).slice(0, 200),
                    poolChars: Number.isFinite(_pc) ? _pc : -1, addrChars: Number.isFinite(_ac) ? _ac : -1,
                };
                horaeWarn('[hitOpt] git 记录：池化台账这一轮**没落盘** ——', poolInfo.skipped);
            }
        } catch (err) { horaeWarn('[hitOpt] git 记录：池化台账（pool）落盘失败:', err?.message || err); }
        /* ★★★★★★ v6.38.1【A / B / C 三片原文 ⇒ `turns/NNNNN.abc.txt` ＋ `.abc.meta.txt`】
         *  用户 2026-09-19 定版："可以 你可以将A B C分片存档，方便我们进行测试"
         *   ＋ 用户 2026-09-19 口径钉死（我 ask 时问错过一次，用户当场纠正）：
         *     "**我要的就是池化后的 用于拼接的abc**" ⇒ 三片＝**池化后、真正参与拼装**的那三项，
         *     拼起来就是 `A.concat(B2, C)` 的那串字（＝真发出去那份的出网文本）。
         *  三个区是什么（`horae.client.js` 的 `_abSplit` 定死，装配 = `A.concat(B2, C)`）：
         *    · **A** = `prev[0..a]` 逐字节原样 —— **不动**（池化前后同一份）；
         *    · **B** = 这一轮 `_floorLim` 之前、且 A 没覆盖的那部分 —— **唯一可压缩区**，
         *      落的是**池化后**的形态（`B2`＝块级指针化 → 区间唤起都跑完）＝真发出去那个 B；
         *    · **C** = 这一轮 `_floorLim` 之后的保真区（预设/格式块）—— 原样进原样出，**一个字节都不许动**。
         *  ⚠ 另带第四片 `B0` = B 的**池化前原文**（**不参与拼装**，只当"省了多少"的分母）。
         *  为什么要存：`_abSplit` 手里是**装配形状**（第 8 轮心跳 79 条），而盘上 `raw.txt` 是 45 条、
         *  `txt` 是抓包合并后的 15 条 ⇒ **三个区在盘上无法复算**（拿 `raw(N-1)` 冒充 `prev` 试过，|B| 偏大 1.6 倍）。
         *  ⚠ **纯新增存档**：不进 messages、不参与任何判据 ⇒ **对三个官方数的影响为零**。
         *  ⚠ 与上面 ① `raw` **同一套纪律**：客户端带就落、不带就**如实不写**（老客户端 / 别处直接调 /turn）。 */
        let abInfo = null;
        try {
            const k5b = String(no).padStart(5, '0');
            const box = body.abc && typeof body.abc === 'object' ? body.abc : null;
            /* ★★★★★★【格式：与"池化文件"同构 —— 用户 2026-09-19 定版"你要跟池化文件一个格式"】
             *  项目里那两份池化台账（客户端 localStorage）的外层结构是：
             *    · 块指纹池  `horae_am_pool_v1` → `{ "<chatKey>": { "b": [ {h,t}, … ] } }`
             *    · 区间台账  `AM_ADDR_STORE`     → `{ "<chatKey>": { "at":戳, "n":条数, "b": [ {t,i,a}, … ] } }`
             *  ⇒ 本文件照抄这个外层：**按聊天分槽 ＋ `at`/`n`/`b`**，`b` 里放各片的**实际文本**。
             *  分片（用户 2026-09-19 定版原话："单纯的本轮存储池化后，ABC三部分的实际文本是什么"
             *        ＋ 同一轮再次钉死："**我要的就是池化后的 用于拼接的abc**"）：
             *    · `A`  = 池化**后**（A 区不动 ⇒ 前=后）        · `B`  = 池化**后**（＝真发出去的 `B2`）
             *    · `B0` = 池化**前**（B 区原文，算节省率的分母） · `C`  = 池化**后**（C 保真 ⇒ 前=后）
             *  前三个拼起来就是 `A.concat(B2, C)` —— **用于拼接的就是这三片（池化后）**。
             *  ⚠ 数据文件仍是**纯数据**（一个字节版本信息都不塞）；版本戳在**抬头** `.abc.meta.txt` 里。 */
            const PARTS = [
                { p: 'A', key: 'a', desc: 'A 区＝prev[0..a] 逐字节原样（不动）· 池化后' },
                { p: 'B', key: 'b', desc: 'B 区＝唯一可压缩区 · **池化后**（＝真发出去、参与拼装的 B2）' },
                { p: 'B0', key: 'b0', desc: 'B 区原文 · **池化前**（算节省率的分母，不参与拼装）' },
                { p: 'C', key: 'c', desc: 'C 区＝保真区（预设/格式块）· 池化后，一个字节都不许动' },
            ];
            const chatKey = String(body.chat || '');
            const b = [];
            for (const { p, key } of PARTS) {
                const arr = Array.isArray(box?.[key]?.msgs) ? box[key].msgs : null;
                if (!arr || !arr.length) continue;
                b.push({
                    p,                                                   // 哪一片
                    n: arr.length,
                    chars: arr.reduce((x, m) => x + String(m?.content ?? '').length, 0),
                    msgs: arr.map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') })),
                });
            }
            if (b.length) {
                const abcDoc = { [chatKey]: { at: Date.now(), n: b.length, b } };   // ← 与池化台账同构
                const abcText = JSON.stringify(abcDoc);
                /* ★ v6.51.1：三片是 JSON ⇒ 落 `turns/NNNNN.abc.json`（原 `.abc.txt`）。 */
                fs.writeFileSync(path.join(dir, ...turnRel('abc', k5b).split('/')), abcText, 'utf8');
                abInfo = { parts: b.map(x => ({ p: x.p, n: x.n, chars: x.chars })), keys: Object.keys(box || {}), chars: abcText.length };
                /* ★★★★★★【元信息抬头 —— 用户 2026-09-19 定版"记得带元信息 其中BS双端版本是必须的"】
                 *  一件一行，**每行都必须带 `版本 cli=<客户端那一版> srv=<服务端 ROUTE_V>`**。
                 *  为什么是必须的：没有它，日后拿这一份去对账时分不清"这是哪一版代码装配出来的区" ——
                 *  本项目已经为这件事付过一次学费（`mu7zewpk6tgm` 那 14 轮废数据，见目标【版本戳】那节）。
                 *  ⚠ `cli=` 取客户端随 wire 报上来的那一版（拿不到就写 `?`，**不猜**）；`srv=` 取本模块 `ROUTE_V`。 */
                const vCli = String(body.wire?.ver || '?');
                const lines = b.map(x => {
                    const d = PARTS.find(y => y.p === x.p) || { desc: '' };
                    return `# abc·${x.p} | ${x.n} msgs | ${x.chars} 字 | 文件 ${k5b}.abc.json（槽 ${chatKey}） | ${d.desc} | 版本 cli=${vCli} srv=${ROUTE_V}`;
                });
                /* ★★★★★★【对账行 —— 用户 2026-09-19 定版"我 只！针！对！A！B！C！切片文件"
                 *   ＋ "实际我对话 肯定会读LCP啊" ⇒ 切片**自己**带够对上 LCP 的读数，读的人不用再翻别处。
                 *   `A 区字数 ＝ 断点位置`（客户端认定的公共前缀长度）；`锚点 a` 是 A 的右边界
                 *   （`A = prev[0..a]`，`a` 是每轮实时找的、事后推不出来 —— 这正是必须存档的原因）。
                 *   ⚠ 只写进这份切片抬头，不碰 `body.meta`、不碰任何生产判据。 */
                const R = (box && box.read && typeof box.read === 'object') ? box.read : {};
                const g = (p) => (b.find(x => x.p === p) || {});
                const nz = (v) => (Number.isFinite(Number(v)) ? Number(v) : '—');
                /* ★★★★★★ v6.41.24【这两行的取数提到对账行之前 —— 一起修掉"面板自我冲突"】
                   【病（用户 2026-09-20 点名："面板自我冲突你从来不管"）】对账行原来写的是
                     `省 ${R.amSave} 字（指针 ${R.amN} 个）` —— 那**只是"块级指针化"那一层**的账，
                     而默认管线（`[ptr-exact-v2.4]`）里根本没有那一层 ⇒ 它恒为 `省 0 字（指针 0 个）`，
                     紧挨着的管线段却写着 `逐级合计省 25130 字`。**同一个文件里两行互相打脸**，
                     实测全仓 81 份切片抬头里 **47 份**都这样。
                   【修法】"省"这个不带定语的词**从此只有一个来源**：`B 池化前 − B 池化后`
                     （＝这一轮 B 区进出的字数差，盘上冻结的两个数相减，谁也算不出来第二个值）。
                     那一层的账**照旧写**，但**带上层名**（`块级指针层`）—— 两个数于是各归各位，
                     不再是矛盾，而是"总账 + 某一层的分账"。管线段那一行的 `逐级合计省`
                     **照样独立算**（Σ 各级 chars）⇒ 它俩相等本身就是一条可证伪的钉子（I1/I2）。 */
                const _pipe = Array.isArray(R.pipe) ? R.pipe : [];
                const _pipeSum = _pipe.reduce((s2, x) => s2 + (Number(x.chars) || 0), 0);
                const _ptrN = _pipe.reduce((s2, x) => s2 + (Number(x.n) || 0), 0);
                const _bAfter = Number(g('B').chars);
                const _bSave = (Number.isFinite(Number(R.bRawChars)) && Number.isFinite(_bAfter))
                    ? Number(R.bRawChars) - _bAfter : null;
                lines.push(`# abc·对账 | 锚点 a=${nz(R.anchor)}（基准第 ${nz(R.anchor)} 条 ↔ 这一轮第 ${nz(R.at)} 条）`
                    + ` | **断点位置 ＝ A 区末尾 ＝ ${nz(R.aChars)} 字**`
                    + ` | 对话楼边界=${nz(R.floorLim)}｜对上 ${nz(R.same)} 条｜保真区 keepQ=${nz(R.keepQ)} keepCut=${nz(R.keepCut)}`
                    + ` | A ${nz(g('A').n)} 条｜B 池化后 ${nz(g('B').n)} 条/${nz(g('B').chars)} 字｜B 池化前 ${nz(R.bRawChars)} 字`
                    + `｜C ${nz(g('C').n)} 条/${nz(g('C').chars)} 字`
                    + ` | B 区省 ${nz(_bSave)} 字（管线 ${_pipe.length} 级·指针 ${nz(_ptrN)} 个）`
                    + ` | 块级指针层 省 ${nz(R.amSave)} 字（指针 ${nz(R.amN)} 个）`
                    + ` | 版本 cli=${vCli} srv=${ROUTE_V}`);
                /* ★★★★★★ v6.41.4【管线段 —— 目标④"每轮记录里落管线快照 ＋ 逐级读数"】
                   ── 一件一行（与上面那行同一纪律）：**顺序就是执行顺序**，每级带上"它自己省了多少字"。
                   ── 空管线**也要写一行**：`0 级` ＋ "原模原样"是**正常语义**（用户："不选择算法自然是
                      原模原样的原文"），不是"缺数据"—— 空着才叫各说各话。
                   ── 逐级读数之和 == B 区进出的字数差（客户端那条自校验式子），所以两行能互相验。
                   ── ⚠ 每一行都必须带 `版本 cli=… srv=…`（用户 2026-09-19 定版那条规矩，切片抬头同源）。 */
                lines.push(`# abc·管线 | ${_pipe.length} 级 | `
                    + (_pipe.length
                        ? _pipe.map((x, i) => `${i + 1}.${x.name || x.id} ${x.version || '?'} 省 ${nz(x.chars)} 字`).join(' → ')
                        : '**原模原样**（空管线 ⇒ B 区一个字节都没动）')
                    + ` | 逐级合计省 ${nz(_pipeSum)} 字`
                    + (R.pipeBad ? ` | ⚠ ${String(R.pipeBad).slice(0, 80)}` : '')
                    + ` | 版本 cli=${vCli} srv=${ROUTE_V}`);
                fs.writeFileSync(path.join(dir, 'turns', `${k5b}.abc.meta.txt`), lines.join('\n') + '\n', 'utf8');
            } else if (box && box.nowork) {
                /* ══════════════════════════════════════════════════════════════════════════════
                 * ★★★★★★ v6.51.10【重放集完备性 · 缺口1（服务端侧）：**没切分也要留一份抬头**】
                 *
                 *   事故（`圣樱学院_mucxfcb8nw6n` 生成 00002.json 时的第 3 轮）：池化整段没跑，
                 *   于是 `abc.json` 与 `abc.meta.txt` **都不存在**；三个月后回头看这一轮，
                 *   盘上只剩"没有切片"这一个事实，**为什么没有**一个字都没有 ——
                 *   而定案的那三条铁证（abOn=0 / rsBase 空 / stState=fail）全在 `_diag.log` 里，
                 *   它住在抓包插件目录、按天滚动、7 天就没了。
                 *
                 *   ⇒ 现在写**两行**（只写这一份抬头，四片档案那一份**一个字都不写** ——
                 *     于是"这一轮有没有切片"这个判据一个字都不动）：
                 *     · 第一行说清这一轮没切分；
                 *     · 第二行把客户端报上来的原因原样写上（`nowork`）。
                 *   ⚠ 至少要有 `nowork` 才写 —— 老客户端不带这个字段 ⇒ 行为与改动前逐字节相同。
                 * ══════════════════════════════════════════════════════════════════════════════ */
                const vCli0 = String(body.wire?.ver || '?');
                const why = String(box.nowork).slice(0, 300);
                const L0 = [
                    `# abc·未切分 | 这一轮 A / B / C 一片都没有 ⇒ 池化整段没跑（出网 body 里一个池化壳都不会有） | 版本 cli=${vCli0} srv=${ROUTE_V}`,
                    `# abc·原因 | ${why} | 版本 cli=${vCli0} srv=${ROUTE_V}`,
                    `# abc·重放 | 池化前的整份输入若在（turns/${k5b}.pre.json），拿它 ＋ 上一轮 abc.json 拼出的基准就能离线重放这一轮 | 版本 cli=${vCli0} srv=${ROUTE_V}`,
                ];
                fs.writeFileSync(path.join(dir, 'turns', `${k5b}.abc.meta.txt`), L0.join('\n') + '\n', 'utf8');
                abInfo = { parts: [], skipped: true, why };
            }
        } catch (err) { horaeWarn('[hitOpt] git 记录：A/B/C 分片落盘失败:', err?.message || err); }
        // ★ v6.24.54：抬头那一行（归档元数据）单独写一份，并且**必须进 git** —— 它跟着同一轮一起提交。
        //   为什么不能只留在内存/只写一次：`/log` 每次都要靠它给出「本地请求Token / 真字节 / 是出网原文还是本地快照」，
        //   刷新页面、换机器、回看老轮次都得读得到；而"只 add -A 的话 meta.txt 会不会被漏掉"根本不用赌 —— 显式 add。
        writeTurnMeta(dir, no, turnHead);
        await run(['add', '-A'], dir);
        await run(['add', '-f', `turns/${String(no).padStart(5, '0')}.meta.txt`], dir);
        // 标题里带上"这一轮 AI 回复落在聊天的第几楼"（ai#9）—— 前端列表用它对齐酒馆界面里的 #N，
        // 页面刷新过、内存里没记录时也还能对上；`cl#N` = 这一轮发出时聊天里一共有多少条，
        // 面板用它判断"表里那些轮次的回复是不是已经从聊天里删掉了"。
        const floor = Number(body.meta?.floor);
        const chatLen = Number(body.meta?.chatLen);
        const msg = `${swipe ? 'swipe ' : ''}turn #${no}`
            + `${body.meta?.total ? ` | ${body.meta.total}tok/${body.meta.msgs}msgs` : ''}`
            + `${Number.isFinite(floor) ? ` | ai#${floor}` : ''}`
            + `${Number.isFinite(chatLen) ? ` | cl#${chatLen}` : ''}`;
        const c = await run(['commit', '-q', '-m', msg, '--allow-empty'], dir);
        const sha = (await run(['rev-parse', '--short', 'HEAD'], dir)).out.trim();
        if (wireInfo) {
            console.log(`[hitOpt] git 记录：第 ${no} 轮写的是**出网原文**（${wireInfo.n || '?'} 条 / ${wireInfo.bytes || '?'} 字节 / 指纹 ${String(wireInfo.sha256).slice(0, 12)}）`
                + `→ turns/${String(no).padStart(5, '0')}.json（抓包那份：${wireInfo.file || '—'}）`);
        } else {
            horaeWarn(`[hitOpt] git 记录：第 ${no} 轮**没拿到出网原文** → 写的是客户端本地快照（抓包插件没加载？）`);
        }
        // 每记完一轮顺手收一次：只留最近 CHAT_KEEP 个聊天（当前这个一定留），不需要任何人手动清理
        const pruned = await pruneChatRepos(ROOT, CHAT_KEEP, dir);
        if (pruned.length) console.log(`[hitOpt] git 记录：已清掉最旧的 ${pruned.length} 个聊天仓库（保留最近 ${CHAT_KEEP} 个）`);
        // ★★★★★★ 2026-09-19【占坑】底文件已建（见上面 `ensureBaseFiles`），这里只落**状态**：
        //   ① 有没有拿到酒馆原始请求、② 是不是真出网原文、③ 还挂着 pending —— 缺的那一份由
        //   `attachRes()`（等不到就把底文件转成 failed 说明）或下面几处如实补上，**不许留白**。
        try {
            const k5 = String(no).padStart(5, '0');
            const st = {
                轮: no, at: new Date().toISOString(),
                件: {
                    raw: rawInfo
                        ? { state: 'present', file: `${k5}.raw.json`, note: `客户端随 /turn 带来 ${rawInfo.n} 条（真内容已覆盖底文件）` }
                        : { state: 'missing', file: `${k5}.raw.json`, why: '这次 /turn 没带 raw 字段（老客户端没 F5 / 别处直接调 /turn）⇒ 原始请求拿不到，盘上留的是底文件' },
                    wire: wireInfo
                        ? { state: 'present', file: `${k5}.json`, note: `抓包那份出网原文（${wireInfo.n || '?'} 条 / ${wireInfo.bytes || '?'} 字节）` }
                        : { state: 'missing', file: `${k5}.json`, why: '这一轮没拿到抓包的出网原文 ⇒ 写的是客户端本地快照（两件事不能混）' },
                    res: { state: 'pending', file: `${k5}.res.txt`, why: '等抓包插件落响应（按请求体 sha256 匹配，最多 90 秒）' },
                },
            };
            fs.writeFileSync(path.join(dir, 'turns', `${k5}.status.json`), JSON.stringify(st, null, 2), 'utf8');
        } catch (err) { horaeWarn('[hitOpt] git 记录：三件套状态落盘失败:', err?.message || err); }
        //   响应要几秒到几十秒才回来，所以这里起一个后台等待：抓到就写 `turns/NNNNN.res.txt`
        //   并把同一次提交 `--amend` 补上（编号/行数不变 ⇒ 行数恒等式不受影响）。
        try {
            const reqSha = String(body.wire?.sha256 || '').trim();
            // `resTries` 只为**验收**留的口子（默认 45 次 ≈ 90 秒）：`check/triad_save_test.mjs` 要验
            // "等不到响应 ⇒ 落占位文件 ＋ 写明原因"那条路，不可能真等 90 秒。钳在 1..90，默认值不变。
            const tries = Math.max(1, Math.min(90, Number(body?.meta?.resTries) || 45));
            if (reqSha) void attachRes(dir, no, reqSha, tries, {
                cli: String(body.wire?.ver || '?'),
                srv: ROUTE_V,
                tokSrc: String(body.wire?.tokSrc || ''),
                // ★ v6.39.11：算法标注也要跟着走（`res` 那一跳会 `--amend` 重写抬头，
                //   不带上的话"等响应回来"这条路上抬头会把 algo 段弄丢）
                algo: String(body.wire?.algo || ''), algoVer: String(body.wire?.algoVer || ''),
                algoKind: String(body.wire?.algoKind || ''),
                wireSha: reqSha,
                rawSha: String(rawInfo?.sha256 || ''),
            });
        } catch (_) { }
        res.json({ ok: c.code === 0, sha, no, pruned, wire: wireInfo, raw: rawInfo, pre: preInfo, pool: poolInfo, file: path.relative(ROOT, file).replace(/\\/g, '/'), log: c.err.trim() });
    });

    // 官方 usage 回填：写 gitignore 掉的 usage.json（绝不为显示数据改写提交历史）
    router.post('/usage', async (req, res) => {
        const body = req.body || {};
        const dir = await ensureRepo(repoOf(safe(body.chat)));
        let no = Number(body.no);
        if (!Number.isFinite(no)) no = await headTurnNo(dir);
        if (!Number.isFinite(no) || no === null) return res.json({ ok: false, error: '还没有提交' });
        const u = readUsage(dir);
        u[String(no)] = {
            hit: Math.max(0, Number(body.hit) || 0), miss: Math.max(0, Number(body.miss) || 0),
            out: Math.max(0, Number(body.out) || 0), promptTok: Math.max(0, Number(body.promptTok) || 0), at: Date.now(),
        };
        writeUsage(dir, u);
        res.json({ ok: true });
    });

    // 清空当前聊天的记录（v6.10）：**归档**而不是删除 —— 目录改名进 _retired/，
    // 既不影响面板（新记录从 turn #0 重新开始），又随时能把旧记录找回来。不动聊天历史一个字节。
    router.post('/reset', async (req, res) => {
        const body = req.body || {};
        const chat = safe(body.chat);
        const dir = repoOf(chat);
        if (!fs.existsSync(path.join(dir, '.git'))) return res.json({ ok: true, archived: null, note: '这个聊天还没有仓库，没什么可清的' });
        const retired = path.join(ROOT, '_retired');
        fs.mkdirSync(retired, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let to = path.join(retired, `${chat}@${stamp}`);
        for (let i = 2; fs.existsSync(to); i++) to = path.join(retired, `${chat}@${stamp}-${i}`);
        try {
            fs.renameSync(dir, to);
        } catch (err) {
            return res.json({ ok: false, error: `归档失败：${err.message}` });
        }
        console.log(`[hitOpt] git 记录：已归档「${chat}」的旧记录 → ${path.relative(ROOT, to).replace(/\\/g, '/')}`);
        res.json({ ok: true, archived: path.relative(ROOT, to).replace(/\\/g, '/') });
    });

    // ★ v6.24.36：这里原来有个独立的 `POST /wire`（把出网原文另存成 `wire/NNNNN.txt`）——
    //   用户定版"一样的硬盘 git 存储，单纯的来源变了 其他没变"之后它就没用了：
    //   出网原文现在**跟着 `/turn` 一起进来**，直接写进同一个 `turns/NNNNN.txt`、同一轮一次 commit。
    //   连同它依赖的 `lastTurnNo` 映射一起删掉（不留死代码）。

    // ★ v6.24.68：**铺平的唯一入口**（只读、不写盘、不落盘）。
    //   为什么需要它：`turns/NNNNN.txt` 现在是**出网原文**（POST body 逐字节），而"替换模拟"那条路
    //   （`_diffSimOneTurn`）要拿这一轮的真 request 去算"换上之后"—— 它操作的是**逐条 items**
    //   （铺平后的形状）。客户端**不许自己写第二套铺平算法**（用户口径 §2.2：一处参数栏只许有一套算法），
    //   所以铺平只在服务端这一处做（`flattenWire`，与 `/diff` 用的是同一个函数）。
    //   老记录（本来就是铺平文本）原样返回 —— 两种形状都认。
    /* ══════════════════════════════════════════════════════════════════════════════
     * ★★★★★★ v6.39.12【每个算法一个独立目录，**与主算法并列**】
     *   用户 2026-09-19 定版："跟主算法的文本存储结构一样，每个算法都有自己独立的文件夹，
     *   与主算法并列。"（选的是**方案 A**：老 `turns/` 原位不动）
     *
     *   ── 结构（`<repo>` = `_gitlog/<聊天>/`；`<tmp>` = `_gitlog/_tmp/<聊天>/`）────
     *        <repo>/turns/NNNNN.txt                ← **主链**的产物（本来就住这儿，一个字节不动）
     *        <repo>/turns/NNNNN.raw.txt            ← 酒馆原文（三类不可碰的原始存档）
     *        <repo>/turns/NNNNN.res.txt            ← 官方返回（三类不可碰的原始存档）
     *        <repo>/turns/NNNNN.abc.txt            ← A/B/C 切片（主链落的那一份）
     *        <tmp>/pipes/<管线槽>/turns/NNNNN.txt      ← **组合管线产物自己的家**（★ v6.41.5 起改住临时区）
     *        <tmp>/pipes/<管线槽>/pool/NNNNN.txt       ← 同一轮内部那串 `ref ⊕ B 原文 ⊕ C`（对照面）
     *        <tmp>/pipes/<管线槽>_s<k>/turns/NNNNN.txt ← 第 k 级的中间产物（逐级对比的两侧就是它）
     *      ⚠ 这一层的名字是**组合管线槽名**（用户 2026-09-20："**不是算法ID缓存区 而是 组合管线ID缓存区**"）
     *        —— 不是"某个算法 id"。槽名 = 这条管线里启用着的各级 id 用 `__` 连起来；
     *        单级管线的槽名恰好等于那一级的 id ⇒ 默认配置下看着一样，**语义已经换过了**。
     *
     *   ── ⚠ v6.41.5【为什么产物**必须**离开 `<repo>`】──────────────────────────
     *     用户 2026-09-20 定版："中间计算产物存 管线的盘 单独的 git 仓库" → 随即改口
     *     "**不了 不用 git 仓 反正 temp 目录**"。
     *     病：`<repo>/algos/…` 是**聊天仓库的工作树** ⇒ `git ls-files` 实测**已被跟踪**
     *     （5 场 108 个文件 / 33.7 MB 的**派生**数据进了**归档**仓库）。
     *     判据：产物是本链**从切片重算**出来的（幂等、不发一个请求）⇒ 它属于工作区，不属于档案。
     *
     *   ── 为什么主链不另建一个 `main/` 目录 ──────────────────────────────────
     *     ① `turns/` 本来就是主链的目录，改名要动 30 个仓库、上千个历史文件，
     *        而三类原始存档（`turns/NNNNN.txt` / `.raw.txt` / `.res.txt`+`.res.meta.json`）
     *        是**不可碰**的 —— 用户反复交代过"就怕乱改规则导致存档异常"；
     *     ② "每条管线一个家"这条语义照样成立：主链住 `<repo>/turns/`，管线产物住
     *        `<tmp>/pipes/<管线槽>/…` —— **同一种文本形态**（都是 `NNNNN.txt`，都能被
     *        `git diff --no-index` 直接比），只是**根**不同（归档 vs 临时区）。
     *
     *   ⚠ `main` 这个 id 与 `core/expAlgo/mainAlgo.js` 的 `MAIN_ID` 同源；
     *     服务端只做一件事：**空 或 `main` ⇒ 走 `turns/`**（主链原位），其余一律进自己的目录。
     *   ⚠ 基底由 `pipeWorkDir(dir)` **一处**推导（`/pipe` 写、`/flat` 读、`simDiff` 比对三处同源）。
     *   ⚠ 目录名要消毒（防路径穿越）：只留 `A-Za-z0-9_-`，其余换 `_`，最长 64。
     * ══════════════════════════════════════════════════════════════════════════════ */
    const PIPE_DIR_SAFE = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown';
    /* ★ v6.41.21【加第三个参数 `sub`】`ref` 子目录（存"主链那一刻真正用的参考串"）也走**这一个**函数 ——
       `/pipe` 写、`/flat` 读两处同源，谁都不许自己拼一次路径。
       ⚠ 主链（空 / `main`）仍只有 `turns/`：ref 是**某条组合管线**跑的时候才有的东西。 */
    const pipeTurnsDir = (dir, pipeId, sub = 'turns') => {
        const a = String(pipeId || '');
        if (!a || a === 'main') return path.join(dir, 'turns');
        return path.join(pipeWorkDir(dir), 'pipes', PIPE_DIR_SAFE(a), sub);
    };

    /** ★ v6.39.12 / ★ v6.41.5【把**某一条组合管线**的产物落盘到它自己的目录】
     *   body: `{ chat, pipe, no, text, kind }`
     *   ── ⚠⚠ 这个字段装的是**组合管线槽名**，不是"某个算法 id" —— 用户 2026-09-20 纠正：
     *      "**不是算法ID缓存区 而是 组合管线ID缓存区**"。
     *      槽名 = 这条管线里**启用着的各级 id 用 `__` 连起来**（`_algoPipeSlotId()`）；
     *      单级管线的槽名**恰好等于那一级的 id** ⇒ 老数据、老调用照样解析得出来（默认管线逐位相同）。
     *   ── 谁会用：本链是**本地重算**（不发请求、本来只在内存里）⇒ 跑完之后客户端把它 POST 上来，
     *      服务端写进 `<tmp>/pipes/<管线槽>/turns/NNNNN.txt`（★ v6.41.5：临时区，不进聊天 git 仓库）。
     *      于是每条管线都有了**盘上的真文件**，
     *      "我们的基本原理是 git diff" 这句话对管线产物同样成立（同一轮两轮都能直接比文件）。
     *   ⚠ `pipe` 空 或 `main` ⇒ **拒绝**：主链那份由 `/turn` 在真发出去那一刻写，别处不许碰
     *     （否则就是拿客户端手里的东西覆盖既成事实）。
     *   ⚠ 只写自己那个目录：`turns/` 与三类原始存档**一个字都不动**。 */
    router.post('/pipe', async (req, res) => {
        const chat = safe(req.body?.chat);
        const pipe = String(req.body?.pipe || '').trim();
        const no = Number(req.body?.no);
        const text = String(req.body?.text ?? '');
        /* ★★★★★★ v6.39.13【多参数：`kind` 决定落哪一个子目录】用户 2026-09-19 定版：
             "差异页用的 git diff 技术，所以你**直接将算法的计算结果存到自己工作区**啊，
              然后**正常的进行文件 diff**" ＋ "别忘记**接口参数正常传多个参数**"
           ── 两个子目录，一条管线一个家：
             · `kind='turn'`（默认）= 这一轮的产物 `T_N` ⇒ `<tmp>/pipes/<槽>/turns/NNNNN.txt`
             · `kind='pool'`        = **同一轮内部**那串「B 区原样」`ref ⊕ B 原文 ⊕ C`
                                      ⇒ `<tmp>/pipes/<槽>/pool/NNNNN.txt`
             有了 `pool/`，「池化差异↗」的前后两侧就**都是盘上文件**了 ——
             于是它和主链那两条走**完全同一条路**（git diff 两个文件），
             不用再把几十万字在页面与服务端之间搬来搬去（内存那 3 轮的窗口也就不再是瓶颈）。 */
        const kind = String(req.body?.kind || 'turn').trim().toLowerCase();
        /* ★★★★★★ v6.41.21【第三个 kind：`ref`】用户 2026-09-20 拍板"1+2+3"：
            把**主链那一刻真正用的参考串**也落一份 ⇒ 面板链读它重算 ⇒ **两边数学上必然同源**。
           【为什么非落不可（实测）】同一份算法、同一份 B 输入：拿"盘上第 N−1 轮真发整串"当参考
             算出 5,557 字、拿"本轮 A 区"算出 14,248 字，而**主链真发的是 16,345 字**
             —— **三条链三个数**，因为主链那一刻用的 ref **盘上复原不出来**。 */
        if (kind !== 'turn' && kind !== 'pool' && kind !== 'ref') {
            return res.json({ ok: false, error: `kind 只能是 turn / pool / ref（收到「${kind}」）` });
        }
        if (!pipe || pipe === 'main') return res.json({ ok: false, error: 'pipe 必须是**组合管线槽名**（main 的产物由 /turn 写，别处不许碰）' });
        if (!chat) return res.json({ ok: false, error: '缺少 chat' });
        if (!Number.isFinite(no)) return res.json({ ok: false, error: '缺少轮次编号' });
        if (!text) return res.json({ ok: false, error: 'text 是空的（不写空文件）' });
        const dir = repoOf(chat);
        const sub = (kind === 'pool') ? 'pool' : (kind === 'ref' ? 'ref' : 'turns');
        const td = path.join(pipeWorkDir(dir), 'pipes', PIPE_DIR_SAFE(pipe), sub);
        /* ★ v6.41.21：`ref` 那一档用**内容指纹当文件名**（`name`），**不依赖轮号** ——
           主链与面板链各自对同一串 ref 算同一个指纹，**同名即同源**（读到就是同一串，读不到就是不同源）。
           判据：`name` 只许 `[A-Za-z0-9_-]`、4~80 位（防路径穿越，与 `PIPE_DIR_SAFE` 同一条纪律）。 */
        const _name = String(req.body?.name || '').trim();
        const p5 = /^[A-Za-z0-9_-]{4,80}$/.test(_name) ? _name : String(Math.max(0, Math.floor(no))).padStart(5, '0');
        const rel = path.join('pipes', PIPE_DIR_SAFE(pipe), sub, `${p5}.txt`);
        try {
            fs.mkdirSync(td, { recursive: true });
            const dest = path.join(td, `${p5}.txt`);
            /* ★★★★★★ v8【IO 收口：内容没变就不重写 —— 这是**所有算法共用**的那个落盘口】
               用户 2026-09-19 提醒："**注意 算法模块化哦**"
               ── 为什么必须落在**这一个**地方：算法是模块化的（每个算法一份自己的工作区），
                  于是"多一个算法"＝"多一条写盘路径"。而 v6.39.22 又让面板在取消勾选时
                  **自动为每个缺的算法补算** ⇒ 5 个算法 × 6 轮 × 2 个文件（`turns/` ＋ `pool/`）
                  = **60 次写**，而且**每次刷新页面重跑链都会再写一遍**（本链幂等、只读切片）。
                  这个策略要是写成"给某个算法特判"，就正好违背模块化 ——
                  所以它落在 `/algo` 这个**所有算法共用的口子**上，对谁都一样，一个算法都不特殊。
               ── 判据（不拿推理当判据）：**先比长度，长度相同再逐字节比**。
                  长度不同 ⇒ 直接写（连读都省了）；长度相同 ⇒ 读出来 `equals` 比，
                  真相同才**跳过写**。绝不因为"算法是确定性的"就假定它一定相同。
               ── 省下的是什么：一次 `writeFileSync` ＋ 一次 mtime 变更
                  （连带 git 那边也少一次真改动、少一次对象写入）。 */
            const buf = Buffer.from(text, 'utf8');
            let same = false;
            try {
                same = (fs.statSync(dest).size === buf.length) && fs.readFileSync(dest).equals(buf);
            } catch (_) { /* 文件不在 / 读不了 ⇒ same 保持 false ⇒ 照旧写 */ }
            if (same) {
                horaeLogLine('info', 'algo', `实验算法产物**逐字节相同 ⇒ 跳过重写**：${rel}（${text.length} 字）`);
                return res.json({ ok: true, v: ROUTE_V, pipe, kind, no: Math.floor(no), chars: text.length, rel, skipped: true });
            }
            fs.writeFileSync(dest, buf);
            /* ⚠⚠ v6.39.13【真 bug（无头实测抓到的）】这里原来写的是 `horaeLog(...)` ——
             *   本模块里**没有这个名字**（真名是 `horaeLogLine(level, tag, msg)`）⇒ 每写一轮
             *   都抛 `ReferenceError: horaeLog is not defined` ⇒ 被下面的 catch 兜住 ⇒
             *   返回 `{ok:false, error:'写不进 …：horaeLog is not defined'}`。
             *   而**文件其实已经写成功了**（writeFileSync 在它前面）⇒ 客户端如实报"产物没写进
             *   algos/…/turns/"，盘上却明明有 —— 一条**自相矛盾的假警报**（面板自证行里那句 ⚠）。
             *   判据：`check/exp_prev_probe.mjs` 的自证行 ＋ 盘上 algos/…/turns/ 六个文件都在。 */
            horaeLogLine('info', 'algo', `实验算法产物落盘：${rel}（${text.length} 字）`);
            return res.json({ ok: true, v: ROUTE_V, pipe, kind, no: Math.floor(no), chars: text.length, rel });
        } catch (err) {
            return res.json({ ok: false, error: `写不进 ${rel}：${String(err?.message || err)}` });
        }
    });

    router.get('/flat', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        const no = Number(req.query.no);
        /* ★ v6.41.21：`kind=ref&name=<指纹>` 时**不要求轮号** —— 文件名就是 ref 自己的内容指纹。 */
        const _nm = String(req.query.name || '').trim();
        const _byName = /^[A-Za-z0-9_-]{4,80}$/.test(_nm);
        if (!Number.isFinite(no) && !_byName) return res.json({ ok: false, error: '缺少轮次编号' });
        // ★ v6.39.12：带上 `algo` ⇒ 读**管线那个槽自己的目录**（★ v6.41.5：它在**临时区**
        //   `<ROOT>/_tmp/<聊天>/pipes/<管线槽>/`，不在聊天仓库里）；不带 ⇒ 主链原位 `turns/`，与从前逐位相同。
        /* ★ v6.41.21：`kind=ref` ⇒ 读 `pipes/<槽>/ref/` 下那一份（`name` = ref 的内容指纹，
           不给就用轮号）。路径走 `pipeTurnsDir` 那**一个**函数（与 `/pipe` 的写同源）。 */
        const _k = String(req.query.kind || '').trim().toLowerCase();
        const _sub = (_k === 'ref') ? 'ref' : (_k === 'pool' ? 'pool' : 'turns');
        const _base = _byName ? _nm : String(Math.max(0, Math.floor(no))).padStart(5, '0');
        /* ★★★★★★ v6.51.1【主链原位 ⇒ 正文真名两可】不带 `pipe`（或 `pipe=main`）时
         *  `pipeTurnsDir` 返回的**就是聊天仓库的 `turns/`**，而正文已经从 `NNNNN.txt` 改名成
         *  `NNNNN.json` ⇒ 这里写死 `.txt` 会读不到，本路由当场答"这一轮的记录不在"。
         *  后果不是局部：`/flat` 是**全项目唯一铺平入口**（差异页、替换模拟、面板链全走它）
         *  ⇒ 一断就是整片页面空白 —— 与 v6.24.68 把铺平收成一处时同一条纪律。
         *  ⚠ 其余三支一个字节都不许动：`pipes/<槽>/…` 的产物（含 `pool` / `ref` 两种子目录）
         *    名字**从来没改过**，仍是 `.txt`（它们是铺平文本，不是 JSON）。 */
        const _isMain = (_sub === 'turns') && (!req.query.pipe || req.query.pipe === 'main');
        /* ★★★★★★【`src=raw` ⇒ 读**酒馆原文**（`turns/NNNNN.raw.json`），不是真发出去那一份】
         *  —— 给面板那颗「原文↗」用（源文件 `horae.client.js` @29048：`_dvTurnUrl(no, _turnRel(no,'raw'))`）。
         *  为什么要它：那一颗开的是**池化前**那份（"酒馆组装好、Horae 还没动过的原文"），
         *  与「池化↗ / 文档↗」（`turns/NNNNN.json`，池化后真发出去的）是**两份不同的东西**。
         *  ⚠ 只换"读哪一份"，铺平**仍是本路由这一处**（全项目唯一铺平入口）—— 不另开第二个铺平实现。
         *  ⚠ 老轮次的 raw 真名是 `.raw.txt`（`mu4y2xeo6lmz` 那两轮），走 `turnPathOnDisk` 同一处两可口径。
         *  ⚠ 不带 `src` 时行为**逐字节不变**（差异页 / 替换模拟 / 面板链全在用它）。 */
        const _srcRaw = String(req.query.src || '').trim().toLowerCase() === 'raw';
        const p = _isMain
            ? turnPathOnDisk(dir, Math.max(0, Math.floor(no)), _srcRaw ? 'raw' : 'body')
            : path.join(pipeTurnsDir(dir, req.query.pipe, _sub), `${_base}.txt`);
        let raw = '';
        try { raw = fs.readFileSync(p, 'utf8'); } catch (_) {
            return res.json({ ok: false, error: _srcRaw ? '这一轮的原文（酒馆组装好那份）不在' : '这一轮的记录不在' });
        }
        /* ⚠ 占位文件（`[占位·待回填]`）**不是数据**：如实报"没抓到"，绝不把它当正文摊开。
         *   判据与 `archiveStateOf` / `writePlaceholder` 同一处口径（抬头第一行）。 */
        if (raw.startsWith('[占位·待回填]')) {
            return res.json({ ok: false, state: 'placeholder', error: '这一轮的存档还是占位文件（真数据没到）：'
                + (raw.split('\n').find(l => l.startsWith('# 原因：')) || '').replace(/^# 原因：/, '').trim() });
        }
        if (!wireBodyShape(raw)) return res.json({ ok: true, v: ROUTE_V, text: raw, shape: 'flat' });
        /* ★★★★★★ v6.41.19【`join=1` ⇒ 返回 **出网原文形状** 的那一串 —— 面板链的参考串必须取它】
         *  【为什么】（2026-09-20 用户："看起来很美啊！命中率也高" ⇒ 查下来是**参考串取错了源**）
         *    · 主链真发时手里的 `_prevRealMsgs` 是**出网原文形状**（＝酒馆后端**合并之后**的条数）；
         *    · 而面板链原来拿"盘上切片 A⊕B⊕C"拼参考 ⇒ 那是**客户端侧、没合并**的那一份
         *      ⇒ 实测同一轮：真发 **19 条 / 82,086 字** vs 切片 **63 条 / 82,042 字**，
         *        **第 18 个字符就分叉**（`<User设定>` 后一个换行 vs 两个）。
         *  ⇒ 参考串不同 ⇒ `f(B, ref)` 必然不同 ⇒ 面板那份**从来不代表真发那一发**（勾了算法就裂开：
         *    本地 88.8% vs 官方 76.3%；**空管线时两条链恒等 ⇒ 反而吻合**，这正是用户发现的那条线索）。
         *  ⚠ 不带这个参数时**一个字都不改**：仍是 `flattenWire` 的可读铺平（差异页在用）。 */
        if (String(req.query.join || '') === '1') {
            let msgs = null;
            try { msgs = JSON.parse(raw)?.messages; } catch (_) { msgs = null; }
            if (!Array.isArray(msgs)) return res.json({ ok: false, error: '这份记录里没有 messages 数组' });
            return res.json({ ok: true, v: ROUTE_V, text: jointMsgs(msgs), shape: 'join', msgs: msgs.length });
        }
        /* ★★★★★★ 2026-09-24（第二十四批）【`msgs=1` ⇒ 把 messages **数组**回给调用方】
         *   给 hitOpt 客户端的"基准硬盘兜底"（`_patchInstallDiskBaseline`）用：F5 之后内存镜像
         *   是空的，它要拿**上一轮真发出去那串**重建基准 ⇒ 必须是**数组**
         *   （要按条算 LCP、还要在候选里挑最好那份）；而 `join=1` 回的是拼好的**字符串**，
         *   条边界丢了、拆不回来。
         *   ⚠ **不带这个参数时一个字都不改**（差异页 / 面板链 / 替换模拟照旧）。
         *   ⚠ `src=raw` 时读的是 `raw.json`，同一分支、同一形状（`[role, content]` 对）。 */
        if (String(req.query.msgs || '') === '1') {
            let ms = null;
            try { ms = JSON.parse(raw)?.messages; } catch (_) { ms = null; }
            if (!Array.isArray(ms)) return res.json({ ok: false, error: '这份记录里没有 messages 数组' });
            return res.json({
                ok: true, v: ROUTE_V, n: ms.length,
                msgs: ms.map(m => [String(m?.role || ''), String(m?.content ?? '')]),
            });
        }
        try {
            /* ★ v6.51.3：`/flat` = 全项目唯一铺平入口，**差异页画的就是它** ⇒ 走 JSON 结构形状。 */
            const flat = flattenWire(raw, 0, null, null, null, 'json').text;
            return res.json({ ok: true, v: ROUTE_V, text: flat, shape: 'json' });
        } catch (err) {
            return res.json({ ok: false, error: `出网原文铺不开：${String(err?.message || err)}` });
        }
    });

    /* ══════════════════════════════════════════════════════════════════════════════
     * ★★★★★★ 2026-09-24（第二十五批）【**自愈的两条只读通道**】
     *   用户定版（原话）："**这些修复都应该是自动的，不用过多提醒你 / 本来就是插件的失责，
     *   用户可不管你这些**" ⇒ 出了事要**插件自己**收拾，不许要用户去 F5 / 重启 / 跑工具。
     *
     *   背景：某一轮"池化整段没跑"（例如 F5 后第一轮基准拿不到）⇒ 盘上就没有 `turns/<n>.abc.json`
     *   ⇒ 面板 / 差异页 / 别的核对器**全读不到那一轮的结构**。
     *   客户端**有算法**（`core/expAlgo`）能把它算出来，但**读不到 `plugins/` 下的文件**
     *   （`plugins/` 不在 `public/` 下 —— 这正是那次事故的根）⇒ 必须由服务端开通道：
     *     · `GET /pre?chat&no`   —— 那一轮"池化前的整份输入"（补算的输入）
     *     · `GET /missing?chat`  —— 哪些轮缺结构、以及**该不该补**（两类成因分得清）
     *   ⛔ 两条都**只读**，一个字节都不写；补算结果的写盘仍走既有那条 `/turn`（客户端回传）。
     * ══════════════════════════════════════════════════════════════════════════════ */

    /* 那一轮"池化前的整份输入"（`turns/<n>.pre.json` 的 messages）—— 补算 abc 的**输入**。 */
    router.get('/pre', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        const no = Number(req.query.no);
        if (!Number.isFinite(no)) return res.json({ ok: false, error: '缺少轮次编号' });
        let raw = '';
        try { raw = fs.readFileSync(turnPathOnDisk(dir, Math.max(0, Math.floor(no)), 'pre'), 'utf8'); }
        catch (_) { return res.json({ ok: false, error: '这一轮的池化前输入（pre.json）不在' }); }
        let ms = null;
        try { ms = JSON.parse(raw)?.messages; } catch (_) { ms = null; }
        if (!Array.isArray(ms)) return res.json({ ok: false, error: 'pre.json 里没有 messages 数组' });
        return res.json({
            ok: true, v: ROUTE_V, n: ms.length,
            msgs: ms.map(m => [String(m?.role || ''), String(m?.content ?? '')]),
        });
    });

    /* 哪些轮"有 pre.json 却没 abc.json"，以及**该不该补**。
     *   `fixable:true` ＝ 基准拿不到（我们这边的失败留下的，客户端能本地补）；
     *   `fixable:false`＝ 算法**正确地**拒绝切分（典型是自动总结那几发：与上一轮没有任何
     *     逐字节相同的条目）⇒ ⛔ **一个字节都不许补**（补了就是造假数据）。 */
    router.get('/missing', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        let files = [];
        try { files = fs.readdirSync(path.join(dir, 'turns')); }
        catch (_) { return res.json({ ok: true, v: ROUTE_V, chat, miss: [] }); }
        const nums = (re) => new Set(files.filter(f => re.test(f)).map(f => Number(f.slice(0, 5))));
        const pre = nums(/^\d{5}\.pre\.json$/), abc = nums(/^\d{5}\.abc\.json$/);
        const miss = [];
        for (const n of [...pre].filter(x => x > 0 && !abc.has(x)).sort((a, b) => a - b)) {
            const k5 = String(n).padStart(5, '0');
            /* ★★★★★★ 2026-09-24【判据改成"**缺就试着重算**"，不再按原因文案预先筛掉】
             *   第 9 轮的教训：那一轮 `abc·原因` 写的是"基准里没有一条能在这轮里逐字节找到"，
             *   旧判据据此判它"算法正常拒绝 ⇒ 不该补" ⇒ 自愈**跳过了它**。
             *   可真实原因是**我们这边基准形状错**（拿成了出网那份），本地明明能算出来 ⇒ 白丢一轮
             *   （它 `hit 0 / miss 25,983`，离线重放说本该命中 ≈20,467 tok）。
             *   ⇒ `fixable` 一律 `true`：**让客户端去试**，真算不出自然跳过 —— 那才是真正的"算法拒绝"。
             *     `why` 仍如实带上（把当时写的原因原样转述，面板/诊断看得到）。 */
            let why = '';
            try {
                const t = fs.readFileSync(path.join(dir, 'turns', `${k5}.abc.meta.txt`), 'utf8');
                const l = t.split('\n').find(x => x.includes('abc·原因')) || '';
                why = l.replace(/^#\s*abc·原因\s*\|\s*/, '').replace(/\s*\|.*$/, '').slice(0, 80) || '未写明原因';
            } catch (_) { why = '没有 abc.meta.txt'; }
            miss.push({ no: n, fixable: true, why });
        }
        return res.json({ ok: true, v: ROUTE_V, chat, miss, fixable: miss.filter(x => x.fixable).length });
    });

    /* ★ 2026-09-24【`POST /backfill-abc` —— 自愈的**唯一一处写盘**】
     *   客户端把**本地算出来**的 A/B0/B/C 送回来，这里按客户端那份的**逐字段形状**补成
     *   `turns/<n>.abc.json` ＋ `<n>.abc.meta.txt`（与 `replay_turn.mjs --write-abc` 同一套规矩）。
     *   ⛔ 三条红线：
     *     ① **已有 `abc.json` 的轮次一律不写**（那是真值，算出来的只是复算）；
     *     ② ⛔ **不碰"发出去的那串字"**（`turns/<n>.json` / `.meta.txt` / `usage.json` 一个字不动）——
     *        补的只是"那一轮本该有的结构"；
     *     ③ meta 里**如实标注"本地自愈补算"**，⛔ 不冒充当时客户端写的那一份。 */
    router.post('/backfill-abc', async (req, res) => {
        const b = req.body || {};
        const chat = safe(b.chat);
        const dir = repoOf(chat);
        const no = Number(b.no);
        if (!Number.isFinite(no)) return res.json({ ok: false, error: '缺少轮次编号' });
        const k5 = String(Math.max(0, Math.floor(no))).padStart(5, '0');
        const jsonP = path.join(dir, 'turns', `${k5}.abc.json`);
        if (fs.existsSync(jsonP)) return res.json({ ok: true, skipped: '已有 abc.json（真值优先，不覆盖）' });
        const seg = (x) => ({
            n: Array.isArray(x?.msgs) ? x.msgs.length : 0,
            chars: (x?.msgs || []).reduce((a, m) => a + String(m?.content ?? '').length, 0),
            msgs: (x?.msgs || []).map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') })),
        });
        const parts = ['A', 'B', 'B0', 'C'].map(p => ({ p, ...seg(b[p]) })).filter(x => x.n > 0);
        if (!parts.length) return res.json({ ok: false, error: '没带任何分片' });
        const WHY = {
            A: 'A 区＝prev[0..a] 逐字节原样（不动）· 池化后',
            B: 'B 区＝唯一可压缩区 · 池化后（＝真发出去、参与拼装的 B2）',
            B0: 'B 区原文 · 池化前（算节省率的分母，不参与拼装）',
            C: 'C 区＝保真区（预设/格式块）· 池化后，一个字节都不许动',
        };
        try {
            fs.writeFileSync(jsonP, JSON.stringify({ [chat]: { at: Date.now(), n: Math.floor(no), b: parts } }), 'utf8');
            const meta = parts.map(s => `# abc·${s.p} | ${s.n} msgs | ${s.chars} 字 | 文件 ${k5}.abc.json（槽 ${chat}） | ${WHY[s.p]} | 本地自愈补算 v${ROUTE_V}`).join('\n')
                + `\n# abc·补算说明 | ⚠ 这一轮**客户端当时没跑池化**（盘上没有 abc.json）⇒ 插件启动后**自己**用本地算法补算的`
                + `\n#   （输入取自 turns/${k5}.pre.json、基准取上一轮；⛔ 只补结构，没碰发出去的那串字）\n`;
            fs.writeFileSync(path.join(dir, 'turns', `${k5}.abc.meta.txt`), meta, 'utf8');
        } catch (err) { return res.json({ ok: false, error: '写不进去：' + String(err?.message || err) }); }
        return res.json({ ok: true, wrote: k5 });
    });

    /* ══════════════════════════════════════════════════════════════════════════════
     * ★★★★★★【输出↗ —— 官方返回原文，只读】
     *
     *  ── 它是什么 ────────────────────────────────────────────────────────────────
     *  魔改版 Horae 的 `_dvLinks(r)` 里那颗「输出↗」（`horae.client.js` @29120）开的是一份
     *  **静态文件网址**：`<插件目录>/_gitlog/<场>/turns/NNNNN.res.txt`
     *  （网址由 `_dvTurnUrl` @28879 拼，`rel` 那一支写死 `turns/NNNNN.res.txt`）。
     *  那时记录根在 `public/scripts/extensions/third-party/SillyTavern-Horae/_gitlog` ⇒ **在 public 下**
     *  ⇒ 酒馆的 `express.static` 直接吐文件，链接能用。
     *
     *  ★ 2026-09-24【搬迁之后它必然 404】记录根搬到了 `plugins/hitopt-git/_gitlog`
     *    —— 那是**服务端插件目录**，不在 `public/` 里 ⇒ 同一个网址从"能用"变成"404"。
     *    实测（本次）：`/plugins/hitopt-git/_gitlog/<场>/turns/00000.res.txt` → 404，
     *    `/scripts/extensions/third-party/hitOpt/_gitlog/<场>/turns/00000.res.txt` → 404。
     *    ⇒ 这颗按钮要复活，**必须有一条只读路由把那份文件读出来**（就是本路由）。
     *
     *  ── 为什么按"窗口"返回（不是整份塞回去）──────────────────────────────────────
     *  实测这份文件**最大 5,419,480 字节 / 5,370,849 字**（抓包插件 5.29 MiB 那一档日志上限；
     *  本场共 29 个聊天目录里 321 份 res.txt，中位数量级 1~3 MB）。
     *  无头 Chrome 实测（`_tmp/probe_bigtext.mjs`，SSE 形状正文）：
     *    20 万字 → 赋值 0ms / 强制排版 23ms｜200 万字 → 1ms / 131ms｜**541 万字 → 1ms / 362ms**
     *    且排完之后主线程仍然响应（10 万次加法 1ms）⇒ **"卡死浏览器"没有复现**。
     *  但仍然按**有界窗口**返回，理由三条（如实写，不是拿"会卡死"当借口）：
     *    ① 一次开页要传整份（JSON 转义后比 5.4 MB 还大）—— 本机快，不代表该这么干；
     *    ② 5.4 MB 的 SSE 是 **1.8 万条 data 行**（`.res.meta.json` 的 `dataLines`），人读不了；
     *       真正要看的是**开头**（模型开始说什么）与**结尾**（`[DONE]` ＋ 官方 usage）；
     *    ③ 那个 5.29 MiB 只是**抓包插件当前的日志上限**，不是硬保证 —— 服务端窗口是**有界**的，
     *       上限哪天调大也不会把这一页顶爆。
     *  ⚠ 想看全文**一个字都不会少**：页面上有「继续读下一段」，逐段往后拉（本路由的 `from`）。
     *
     *  ── 参数（与 `/flat` 同风格：`chat` ＋ `no`）─────────────────────────────────
     *    chat  场名（与 /flat /log 同一个 safe() 口径）
     *    no    轮号
     *    from  从第几个**字**开始（默认 0）—— 给"继续读下一段"用
     *    len   这一段取多少字（默认 20 万，上限 200 万）
     *    tail  末尾另外附多少字（默认 6 万，0 = 不要尾巴）—— 官方 usage 在最后一条 data 行里
     *
     *  ── 返回 ────────────────────────────────────────────────────────────────────
     *    200 `{ok:true, state:'present', chars, bytes, head:{from,to,text}, tail:{from,to,text}|null,
     *         omitted, done, sse, dataLines, finish, model, file}`
     *    404 `{ok:false, state:'absent'|'placeholder', file, error, why?}` —— **如实说没有**，
     *        ⛔ 绝不返回空字符串冒充成功（占位文件那份"说明"也绝不冒充成官方返回）。
     *  ⚠ 纯只读：不写盘、不碰 git、不要 CSRF（`attachRes` 写盘那条链一个字都没动）。
     * ══════════════════════════════════════════════════════════════════════════════ */
    const RES_LEN_DEF = 200000;      // 一段 20 万字
    const RES_LEN_MAX = 2000000;     // 一段最多 200 万字（防有人手改网址把整份拉爆）
    const RES_TAIL_DEF = 60000;      // 尾巴 6 万字（usage 与 [DONE] 都在最后几条 data 行里）
    router.get('/res', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        const no = Number(req.query.no);
        if (!Number.isFinite(no)) return res.status(400).json({ ok: false, v: ROUTE_V, error: '缺少轮次编号' });
        const n = Math.max(0, Math.floor(no));
        const info = archiveStateOf(dir, n, 'res');
        if (info.state !== 'present') {
            /* 缺失的那一份要**说清是哪一种缺**（用户定版那八个状态里，这里落 three 态）：
               · absent      → 盘上没这个文件（老轮次 / 记录还没写到这一步）
               · placeholder → 文件在，但它是 `[占位·待回填]` 的说明文件：抓包插件没落这一轮
               占位文件自己的 `# 原因：…` 与 `status.json` 里的 `why` 都读出来给前端 —— 如实转述。 */
            let why = '';
            try {
                const st = await readStatus(dir, n);
                why = String(st?.件?.res?.why || '');
            } catch (_) { why = ''; }
            if (!why && info.state === 'placeholder') {
                try {
                    const t = fs.readFileSync(path.join(dir, ...info.file.split('/')), 'utf8');
                    why = (t.split('\n').find(l => l.startsWith('# 原因：')) || '').replace(/^# 原因：/, '').trim();
                } catch (_) { why = ''; }
            }
            return res.status(404).json({
                ok: false, v: ROUTE_V, chat, no: n, file: info.file, bytes: info.bytes, state: info.state,
                why,
                error: info.state === 'absent'
                    ? `第 ${n} 轮（${turnK5(n)}）在盘上没有 ${info.file} —— 这一轮没有官方返回的存档。`
                    : `第 ${n} 轮（${turnK5(n)}）的 ${info.file} 是**占位文件**（${info.bytes} 字节的说明），不是官方返回：`
                      + (why || '抓包插件没落这一轮的响应'),
            });
        }
        let text = '';
        try { text = fs.readFileSync(path.join(dir, ...info.file.split('/')), 'utf8'); }
        catch (err) { return res.status(500).json({ ok: false, v: ROUTE_V, chat, no: n, file: info.file, error: `读不出来：${String(err?.message || err)}` }); }
        const chars = text.length;
        const from = Math.max(0, Math.floor(Number(req.query.from) || 0));
        const len = Math.min(RES_LEN_MAX, Math.max(1, Math.floor(Number(req.query.len) || RES_LEN_DEF)));
        const tailAsk = req.query.tail === undefined ? RES_TAIL_DEF : Math.max(0, Math.floor(Number(req.query.tail) || 0));
        const hFrom = Math.min(from, chars);
        const hTo = Math.min(hFrom + len, chars);
        /* 尾巴**不跟头重叠**：文件本来就不长时 tail 为 null（整份都在 head 里了）。
           ⚠ `tail=0`（明确不要尾巴）时也必须是 null —— 不能回一个空的 tail 对象
             （前端会照着画一行"【末尾 0 字】"，那是假的）。 */
        const tFrom = tailAsk > 0 ? Math.max(hTo, chars - tailAsk) : chars;
        const tTo = chars;
        const hasTail = tailAsk > 0 && tTo > tFrom;
        /* 抓包插件那份元数据（`.res.meta.json`）—— `done` / `dataLines` / `finish` / `model`
           是**抓包那一刻记下的事实**，比在正文上猜"[DONE] 在不在"硬。
           ⚠ 读不到就**一律不报**（老轮次没有这份），不拿 false 冒充"没有 [DONE]"。 */
        let meta = null;
        try {
            const m = JSON.parse(fs.readFileSync(path.join(dir, 'turns', `${turnK5(n)}.res.meta.json`), 'utf8'));
            meta = {
                done: (typeof m?.done === 'boolean') ? m.done : null,
                truncated: (typeof m?.truncated === 'boolean') ? m.truncated : null,
                sse: (typeof m?.sse === 'boolean') ? m.sse : null,
                dataLines: Number.isFinite(Number(m?.dataLines)) ? Number(m.dataLines) : null,
                finish: m?.finish ? String(m.finish) : '',
                model: m?.model ? String(m.model) : '',
                sha256: m?.sha256 ? String(m.sha256) : '',
            };
        } catch (_) { meta = null; }
        return res.json({
            ok: true, v: ROUTE_V, chat, no: n, file: info.file, bytes: info.bytes,
            state: 'present', chars, meta,
            head: { from: hFrom, to: hTo, text: text.slice(hFrom, hTo) },
            tail: hasTail ? { from: tFrom, to: tTo, text: text.slice(tFrom, tTo) } : null,
            /* 没要尾巴时它不是"中间省略"，是"后面还没读" —— 两种都如实报，由前端按 tail 在不在分开措辞。 */
            omitted: tFrom - hTo,
            more: hTo < chars,          // 后面还有没有没读到的（给"继续读下一段"用）
        });
    });

    /** ★★★ v6.24.112【四视图一致性被自己的性能闸门打破了】`parseTurnFile` 的结果按「轮号｜长度｜mtime」缓存。
     *
     *  ══ 为什么非加不可（2026-09-18 真数据）════════════════════════════════════════
     *   `/log` 原来两处都是 `commits.slice(0, ITEM_TURNS)`（ITEM_TURNS = 40）——**只算最近 40 轮**。
     *   实测 `圣樱学院_mu5sd7sejhp0` 长到 **43 轮**时，最老那 3 轮（#0/#1/#2）的
     *   `msgs / totalChars / lcpChars / missChars` **全成了 0 / null**，而盘上那三轮明明有内容
     *   （`GET /flat?no=0` → 37,073 字 / 4 条）。⇒ 面板上那三行写着"本地 0 条 0 字"，
     *   同一行的官方 usage 却有真数（#0 的 prompt 21,784）—— **两个视图各说各话**，
     *   正是用户 ★★★★ 那条要防的东西（"两边不许各说各话，对不上就是 bug"）。
     *   ⚠ 而且它会**越用越糟**：一场聊天到 100 轮时就有 60 轮是空的。
     *
     *  ══ 改法 ═════════════════════════════════════════════════════════════════════
     *   ① **每一轮都算**那组小字段（条数 / 字数 / lcp / miss / 定位下标）—— 它们才是"本地 vs 官方对账"用的；
     *   ② **只有最近 ITEM_TURNS 轮**才随响应带 `items`（逐条明细 head/tail）—— 那才是真正占响应体的部分；
     *   ③ 让"全量"不等于"每次刷新全量重算"：缓存 `parseTurnFile` 的结果，键里带**文件长度 ＋ mtime**
     *      ⇒ 文件一变（重 roll 覆盖同一轮）缓存立刻失效，绝不会拿到旧内容。
     *   内存：一场 100 轮 × 每轮几十条 ≈ 几 MB；超过 600 条直接清空重来（不做 LRU，够用且简单）。
     *  @param {string} dir 这一场聊天的仓库目录
     *  @param {number} no 轮号
     *  @returns {{p:object, body:Array<{role:string,content:string}>}|null} */
    const _turnMemo = new Map();
    const readTurnCached = (dir, no) => {
        /* ★ v6.51.1：正文真名由 `turnPathOnDisk` **一处**解析（新名 `.json` 优先、老轮次退 `.txt`）。
         *  缓存键里带的仍是**真文件**的长度 ＋ mtime ⇒ 重 roll 覆盖同一轮时必然失效。 */
        const bodyP = turnPathOnDisk(dir, no, 'body');
        let st = null;
        try { st = fs.statSync(bodyP); } catch (_) { return null; }   // 文件不在就算了，前端还有运行记录
        const key = `${dir}|${no}|${st.size}|${st.mtimeMs}`;
        if (_turnMemo.has(key)) return _turnMemo.get(key);
        let got = null;
        try {
            // ★ v6.24.54：抬头在旁边的 `NNNNN.meta.txt`（老记录没有这份 → 抬头还在正文第一行，
            //   `parseTurnFile` 自己认）。读不到旁文件不算错 —— 老记录本来就没有。
            const metaText = readTurnText(dir, no, 'meta')?.text || '';
            const p = parseTurnFile(fs.readFileSync(bodyP, 'utf8'), metaText);
            got = { p, body: p.items.map(it => ({ role: it.role, content: it.text })) };
        } catch (_) { got = null; }
        if (_turnMemo.size > 600) _turnMemo.clear();
        _turnMemo.set(key, got);
        return got;
    };

    /* ★★★★★★ v6.39.0【GET /abc —— 把 A/B/C 切片读给客户端（**只读**）】
     *  用户 2026-09-19 定版："新增一个切换按钮 一旦切换 则面板里面所有的数据显示也是按新算法计算。
     *    然后新的算法必须单独的代码块！ 仅在打开时候 用新的代码块进行计算。
     *    实验算法也要单独的临时存储区，注意 对于实验算法而言，只有>1轮的只有B、C能读拿来测算法。A是不可以的！！！！"
     *  ⇒ 实验算法要在浏览器里实时跑，它必须拿到 `turns/NNNNN.abc.txt` 里那三片的**真文本**。
     *
     *  ⚠⚠ 本路由**只读不写**：三大类原始存档（`NNNNN.txt` / `.raw.txt` / `.res.txt`）一个字节都不碰，
     *     读的也只是 v6.38.1 自己新增的 `NNNNN.abc.txt`（"新东西一律另开文件"那条红线的产物）。
     *  ⚠ B0（池化前原文）**不返回** —— 用户定版："我们算的是算法效率，你不可以读池化前原文"。
     *     这里连同文件一起就不往外给，客户端想读也读不到（判据落到接口上，不靠自觉）。 */
    router.get('/abc', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        /* ★ v6.39.0【不带 no ⇒ 报"哪几轮有切片"】—— 见 `ROUTE_V` 那段 ①。
         *   纯读目录名，**不解 JSON、不返回任何正文** ⇒ 与"B0 不出去"那条判据不冲突。 */
        if (req.query.no === undefined || req.query.no === '') {
            const list = [];
            try {
                for (const f of fs.readdirSync(path.join(dir, 'turns'))) {
                    /* ★ v6.51.1：切片从 `.abc.txt` 改成 `.abc.json`（内容是 JSON）⇒ 两名都认。 */
                    const m = /^(\d{5})\.abc\.(?:txt|json)$/.exec(f);
                    if (m) list.push(Number(m[1]));
                }
            } catch (_) { /* 目录不在 ⇒ 空清单（如实报空，不编） */ }
            list.sort((a, b) => a - b);
            return res.json({ ok: true, v: ROUTE_V, list });
        }
        const no = Number(req.query.no);
        if (!Number.isFinite(no)) return res.json({ ok: false, error: '缺少轮次编号' });
        const k5 = String(Math.max(0, Math.floor(no))).padStart(5, '0');
        /* ★ v6.51.1：切片真名交给 `readTurnText`（`.abc.json` 优先、老轮次退 `.abc.txt`）。 */
        const _abcGot = readTurnText(dir, Math.max(0, Math.floor(no)), 'abc');
        if (!_abcGot) {
            return res.json({ ok: false, error: '这一轮的 A/B/C 切片不在（v6.38.1 之前没有这份，或这一轮还没落盘）' });
        }
        let raw = _abcGot.text;
        try {
            const doc = JSON.parse(raw);
            const slot = Object.keys(doc)[0];
            const parts = {};
            /* ★★★★★★ v6.41.4【放 `B0` 出去 —— 用户 2026-09-20 拍板**解除当年那条红线**】
               ── 当年（2026-09-19）的原话："我们算的是算法效率，**你不可以读池化前原文**"
                  ⇒ 白名单只放 A/B/C，B0 在这里被拦掉。
               ── 为什么现在必须解：**主链喂给管线的输入就是 B0（原文）**，而面板链原来拿的是 `B`
                  （＝B2，池化后）⇒ **两条链的输入根本不是同一个东西**。实测同一轮（`00012`）：
                  `B` 14,415 字 / `B0` 57,613 字 —— **差 4 倍** ⇒ 面板的数与真发出去那一发从根上不可比
                  （面板是在已经压过一遍的东西上再压）。
                  用户当场点破："**我们勾选算法 就是为了处理原文啊**"。
               ── 于是面板链改用 B0 作输入 ⇒ 与主链**同输入** ⇒ 可比、可复现
                  （输入原文 ＋ 这条管线 ⇒ 这一发 ⇒ 官方那五列）。
               ── ⚠ 纯新增一片：A/B/C 三个键照旧、顺序照旧、下面 `parts.B` 的存在性检查照旧
                  ⇒ 老客户端拿到多出来的 `B0` 只会忽略它。 */
            for (const x of (doc?.[slot]?.b || [])) {
                if (x?.p === 'A' || x?.p === 'B' || x?.p === 'B0' || x?.p === 'C') {
                    parts[x.p] = (x.msgs || []).map(m => ({ role: String(m?.role || ''), content: String(m?.content ?? '') }));
                }
            }
            if (!parts.B) return res.json({ ok: false, error: '这一轮的切片里没有 B 片' });
            return res.json({ ok: true, v: ROUTE_V, no: Math.max(0, Math.floor(no)), parts });
        } catch (err) {
            return res.json({ ok: false, error: `切片读不开：${String(err?.message || err)}` });
        }
    });

    /* ══════════════════════════════════════════════════════════════════════════════════════
     * ★★★★★★ v6.51.12（ROUTE_V 44 → 45）【重放集 · 缺口5′ 的下半：把台账**读回来**】
     *
     *   v6.51.11 让 `turns/NNNNN.pool.json` 里终于是**本场真的那一份**了（原来存的是别人的池）；
     *   可盘上有了不等于**下一轮用得上** —— 主链的 `_amPoolLoad` 只认 localStorage，
     *   而它的 `setItem` 每一轮都撞配额 ⇒ 台账**永远装不回来** ⇒ 两级 `legacy` 算法
     *   （块级指针化 / 区间唤起）在生产里也从来没真正跑起来过。
     *   ⇒ 这条路由就是那半边的取数口（客户端按 v6.51.9 给基准做兜底的**同一个模式**异步预取）。
     *
     *   ── 两种用法 ──────────────────────────────────────────────────────────────────
     *     · 不带 `no` ⇒ 只报**哪一轮的台账里有本场**（`list` ＋ `latest`）；
     *     · 带 `no`   ⇒ 把那一份 pool.json 的**原文**给出去（客户端自己 parse）。
     *   ⚠ 清单那一支**只解析最近 3 份**：每份实测 8.8MB（pool 5.3MB ＋ addr 3.7MB），
     *     全量解析一遍要几十秒 —— 而台账是**累积**的，最新那份就含全部历史，3 份足够。
     *   ⚠ 「有本场」的判据：`pool` 字段是 localStorage 那份的**原文**，顶层键就是槽名
     *     （形如 `圣樱学院::mucxfcb8nw6n`）⇒ 直接查这个键在不在、`n > 0`。
     * ══════════════════════════════════════════════════════════════════════════════════════ */
    router.get('/pool', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        const td = path.join(dir, 'turns');
        let files = [];
        try { files = fs.readdirSync(td).filter((f) => /^\d{5}\.pool\.json$/.test(f)).sort(); } catch (_) { files = []; }
        if (!files.length) return res.json({ ok: false, v: ROUTE_V, error: '一份 pool.json 都没有（v6.51.7 之前没有这份存档）' });
        /** 读一份的**元信息**（不返回正文）：本场有几条 / 池里一共几个键 */
        const metaOf = (f) => {
            try {
                const j = JSON.parse(fs.readFileSync(path.join(td, f), 'utf8'));
                const inner = JSON.parse(String((j && j.pool) || '{}')) || {};
                const mine = inner[chat] || null;
                return { file: f, mineN: Number(mine && mine.n) || 0, keys: Object.keys(inner).length,
                    poolChars: Number(j && j.poolChars) || 0, addrChars: Number(j && j.addrChars) || 0 };
            } catch (_) { return null; }
        };
        if (req.query.no === undefined || req.query.no === '') {
            const tail = files.slice(-3).map(metaOf).filter(Boolean);
            const list = tail.map((x) => ({ no: Number(x.file.slice(0, 5)), mineN: x.mineN, keys: x.keys }));
            const last = [...list].reverse().find((x) => x.mineN > 0) || null;
            return res.json({ ok: true, v: ROUTE_V, chat, files: files.length, list, latest: last ? last.no : -1 });
        }
        const no = Number(req.query.no);
        if (!Number.isFinite(no)) return res.json({ ok: false, v: ROUTE_V, error: '缺少轮次编号' });
        const nof = Math.max(0, Math.floor(no));
        const f = String(nof).padStart(5, '0') + '.pool.json';
        if (!files.includes(f)) return res.json({ ok: false, v: ROUTE_V, error: '这一轮的 pool.json 不在（v6.51.7 之前没有这份）' });
        let raw = '';
        try { raw = fs.readFileSync(path.join(td, f), 'utf8'); }
        catch (err) { return res.json({ ok: false, v: ROUTE_V, error: '读不出来：' + String((err && err.message) || err) }); }
        const m = metaOf(f) || { mineN: 0, keys: 0 };
        /* ⚠ 原文原样给（不解析、不改写）—— 重放那边用同一版源码读它，中间不许过一道会丢字段的转换。 */
        return res.json({ ok: true, v: ROUTE_V, chat, no: nof, text: raw, mineN: m.mineN || 0, keys: m.keys || 0 });
    });

    // 提交列表（合并官方 usage ＋ 每轮的 token/消息数/逐条明细）
    router.get('/log', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        if (!fs.existsSync(path.join(dir, '.git'))) return res.json({ ok: true, v: ROUTE_V, commits: [] });
        const u = readUsage(dir);
        const r = await run(['log', '--pretty=format:%h|%ad|%s', '--date=format:%H:%M:%S', '-n', '200'], dir);
        const commits = r.out.split('\n').filter(Boolean).map(l => {
            const [sha, at, ...rest] = l.split('|');
            const subject = rest.join('|');
            const no = (subject.match(/turn #(\d+)/) || [])[1];
            const us = (no !== undefined) ? (u[no] || null) : null;
            // "这一轮 AI 回复落在聊天的第几楼"（标题里的 ai#N）：前端拿它跟酒馆界面里的 #N 对齐
            const fm = /ai#(\d+)/.exec(subject);
            const cm = /cl#(\d+)/.exec(subject);
            return {
                sha, at, subject, no: no !== undefined ? Number(no) : null,
                floor: fm ? Number(fm[1]) : null, chatLen: cm ? Number(cm[1]) : null,
                usage: us, tok: 0, msgs: 0, items: null,
                // ★ v6.24.51：面板「本地」那三列的三个数（字）与定位用的下标，全在下面那段里填
                chars: null, charHead: null, totalChars: null, itemChars: null,
                lcpChars: null, missChars: null, lcpItem: null, lcpRole: '', lcpSrc: '',
                // ★★★★★ v6.24.115：**官方裁判口径**（与任意更早轮次的最大公共前缀）——
                //   `lcpChars` 那组是"与上一轮"（管 ★★★★★ 的前缀判据），这一组才是对官方 hit 的尺子。
                hitChars: null, hitItem: null, hitRole: '', hitBestNo: null,
                // ★ v6.24.69：这一轮是哪套代码写的 ＋ tok 数的是哪串字（老记录 → 空串，面板显示 `—`）
                verCli: '', verSrv: '', tokSrc: '',
                // ★ v6.24.76：**服务端在真出网原文上现算的** prompt token（与官方 prompt_tokens 逐位相等）
                //   —— 面板「本地合计」读的就是它；算不出来是 null（显示 —，不拿抬头上那格客户端数顶上）
                tokExact: null,
            };
        })
        /* ★★★★★★ v6.51.1【没有 `turn #` 的提交**不是一轮** —— 必须在这里滤掉】
         *  本次存档改名给每个仓库加了一条**机械重命名提交**（message 故意不带 `turn #`，
         *  见 `tools/rename_json.mjs` 文件头那段）。它一旦进了这个数组就有两个后果：
         *    ① 面板多画一行（用户可见）；
         *    ② 更糟：它是 `no: null`，而客户端判"这一行是不是一轮"用的是
         *       `Number.isFinite(Number(c.no))` —— **`Number(null) === 0`** ⇒ 它会被当成
         *       **第 0 轮**，与真的第 0 轮撞号（实测 `panel_lcp_test` 当场报
         *       `/log 96 轮 = 记录 95 轮`）。
         *  判据与 `headTurnNo` **同一处口径**（都认 `turn #N`），不另立第二套。 */
        /* ★★★★★★ 2026-09-24【盘上没有正文的轮**一律不进账本**】—— 用户原话："**异常玩意别来膈应**"
         *   判据与"挑上一轮"那一处**同一个**：`readTurnCached` 读得出来才算数（尺子只有一把）。
         *   【那些轮是什么】**别的插件的请求**（Horae 自动总结那 20 KB 的一发，`abOn:0`、算法当场拒绝）
         *     或已经被踢出账本的异常轮（移进了 `turns/_retired/`）。
         *   【为什么非滤不可】两个后果，第二个才致命：
         *     ① 面板多占一行（"跳过生成结果 / 官方 usage 还没回来"，纯噪音，用户看得见）；
         *     ② 它成了下一轮的"上一轮"锚点 ⇒ 实测第 17 轮本地 lcp 只剩 **1 字（0.0%）**，
         *        而官方同一行是 86.5% ⇒ "本地 vs 官方"当场背离，看上去像我们的算法根本没生效
         *        （用户当场判"本地的面板数不是实际算法" —— 那句话是对的）。
         *   ⇒ 滤掉之后：那一行消失；第 17 轮的"上一轮"自动回到第 15 轮（`00014`）
         *     ⇒ 本地面板出数 46,785 / 7,102（86.8%），与官方 86.5% 同源可比。 */
        .filter(c => c.no !== null && readTurnCached(dir, c.no));
        /* ★★★★★★【面板第 1 列那几颗入口要知道"这一轮到底有没有那份东西"】—— 判据在服务端**一处**（`archiveStateOf`）。
         *  为什么非要报给客户端：① 三件套是**占坑**的（每轮先落 `[占位·待回填]` 再回填）⇒ 盘上"有这个文件"
         *  不等于"这一轮真有内容"（实测 `muczgjf8igs/turns/00041.res.txt` 481 字节，正文是"等了 90 秒…"）；
         *  ② 更彻底的缺：两个老场（`mu4y2xeo6lmz` 2 轮 / `mu5sd7sejhp0` 95 轮）的 `.raw` 一份都没有。
         *  ⇒ 客户端只对 `state === 'present'` 的那些画入口 —— **没东西可看的不画死链**
         *  （与源文件里「同上轮↗」第一轮不画、`_dvStaticOk()` 不成立就整排不画同一条规矩）。
         *  ⚠ 纯新增字段：不动任何既有字段、不进 messages ⇒ 对三个官方数影响为零。 */
        for (const c of commits) {
            c.res = archiveStateOf(dir, c.no, 'res');
            c.files = { body: archiveStateOf(dir, c.no, 'body'), raw: archiveStateOf(dir, c.no, 'raw') };
        }
        // 逐条明细：默认带最近 ITEM_TURNS 轮（`items=0` 可关）。**只是读回插件自己写下的文本**，
        // 交给前端去画；本模块依旧没有任何 diff 算法。
        if (String(req.query.items || '') !== '0') {
            // ★★★ v6.24.112：**每一轮都算**那组小字段（原来只算最近 ITEM_TURNS 轮 ⇒ 老轮在面板上成了"本地 0 条"）。
            //   仍然**只有最近 ITEM_TURNS 轮**才随响应带 `items` —— 逐条明细的 head/tail 才是真正占响应体的部分。
            const itemSet = new Set(commits.slice(0, ITEM_TURNS).map(c => c.no));
            for (const c of commits) {                                 // commits 是"新的在前"
                if (!Number.isFinite(c.no)) continue;
                const one = readTurnCached(dir, c.no);
                if (!one) continue;
                const p = one.p;
                /* ★★★★★★ v6.51.1【把这一轮三份存档的**盘上真名**报给客户端】
                 *  为什么非报不可：面板/差异页那几颗「原文↗ / 池化↗ / 输出↗」是**静态网址**
                 *  （酒馆 express.static 直接吐文件），网址必须指向**真实存在**的那一个名字。
                 *  改名之后盘上是**两种名字并存**的：
                 *    · 绝大多数轮次 = 新名 `turns/NNNNN.json` / `.raw.json` / `.abc.json`；
                 *    · `圣樱学院_mu4y2xeo6lmz` 的 **#0 / #1** 是 v6.24.54 之前的老格式正文，
                 *      内容不是 JSON ⇒ 迁移时一个字节没动，名字**至今仍是 `.txt`**。
                 *  ⇒ 客户端拿这个字段拼链接，拿不到（老服务端）才退回"按新名猜"。
                 *  ⚠ 这三个只是**路径字符串**，不参与任何判据、不进 messages ⇒ 对三个官方数影响为零。 */
                c.rel = {
                    body: turnRelOnDisk(dir, c.no, 'body'),
                    raw: turnRelOnDisk(dir, c.no, 'raw'),
                    abc: turnRelOnDisk(dir, c.no, 'abc'),
                    pre: turnRelOnDisk(dir, c.no, 'pre'),
                    pool: turnRelOnDisk(dir, c.no, 'pool'),
                };
                c.tok = p.tok; c.msgs = p.msgs; c.bytes = p.bytes; c.srcWire = p.src;
                c.verCli = p.verCli; c.verSrv = p.verSrv; c.tokSrc = p.tokSrc;   // ★ v6.24.69 版本戳
                c.chars = p.bodyChars;          // ★ v6.24.51：**正文逐条之和**（字）—— 记录自己数出来的那一份
                c.charHead = p.chars;           // 抬头那格「N 字」（老格式没有 → null；老口径会偏，只当对账）
                c.totalChars = p.totalChars;    // 这一轮总长（字）＝逐条之和 + 条间那一个换行
                c.itemChars = p.itemChars;      // 逐条字数（面板把"第几个字"定位成"第几条"只读它）
                if (itemSet.has(c.no)) c.items = p.items.map(it => ({ i: it.i, role: it.role, tok: it.tok, head: it.head, tail: it.tail }));
            }
            // ★ v6.24.51：**全项目唯一那套 lcp** —— 这一轮正文 vs 上一轮正文，逐字节比（见 `lcpOfTurns`）。
            //   面板那三列读的就是这里算出来的三个数；客户端自己一个字都不算（用户定版：不许两套算法）。
            // ★★★★★ v6.24.115：**再加一套"官方裁判口径"**（见 `lcpBestOf`）—— 与**任意更早轮次**的最大公共前缀。
            //   `lcpChars`/`lcpItem`/`lcpRole` **原样不动**（＝与上一轮）⇒ "第 N 轮必须把第 N−1 轮当逐字节前缀、
            //   lcp(N−1,N) 不许降"那条判据一个字都没变；新增的 `hitChars`/`hitItem`/`hitBestNo` 才是对官方的尺子。
            const poolAll = [];                                        // 供池内最大用；commits 是"新的在前"
            for (const c of commits) {
                if (!Number.isFinite(c.no)) continue;
                const one = readTurnCached(dir, c.no);
                if (one && Array.isArray(one.body) && one.body.length) poolAll.push({ no: c.no, arr: one.body });
            }
            for (const c of commits) {                                 // ★ v6.24.112：全量（原来只算最近 ITEM_TURNS 轮）
                const cur = readTurnCached(dir, c.no);
                if (!cur) continue;
                /* ★★★★★★ 2026-09-24【"上一轮"＝**上一个真存在的轮**，不是"轮号减一"】
                 *  用户原话："我只希望聊天的 Δhit Δmiss 正常" —— 那两列就是这里的 `lcpChars`/`missChars`。
                 *  【病】删掉"同一发请求被记了两遍"的假轮之后，轮号会**跳号**（实测 `0 1 2 3 5 7 9`），
                 *    而这里原来硬写 `c.no - 1` ⇒ `5` 去找 `4`、`7` 去找 `6`、`9` 去找 `8`，
                 *    而那三个正是被删掉的假轮 ⇒ `prev = null` ⇒ 面板那三列**永远是 `—`**。
                 *  【修】从本场**已存在**的轮号里挑"比 `c.no` 小的**最大**者"；挑不到（第一轮）才 null。
                 *  ⚠ 与紧邻这句旧注释不冲突：`readTurnCached` 仍读得到**清单外**的轮（所以下面那两处
                 *    兜底路径一个字没动）；变的是"**哪一轮算上一轮**"——要按存在性挑，不按算术减。
                 *  ⚠ 轮号跳号是真实发生过的 ⇒ **照实显示**：不重编号、不改任何存档、不碰官方那几列。
                 *  ⚠ 客户端 `ledger.js:1307`（v6.24.97）早就写明"'本地'那三列的上一轮 = **真正的前一发**，
                 *    不是 no - 1" —— 服务端这一处当时没跟上，现在补齐。 */
                /* ★★★★★★ 2026-09-24【"上一轮"必须**文件真存在**才算数（用户："异常玩意别来膈应"）】
                 *   【病】轮次清单来自 `git log`，而**别的插件的请求**（Horae 自动总结那种 20 KB 的一发）
                 *     也会留下一轮 ⇒ 它成了下一轮的"上一轮" ⇒ 两个串首字符就不同 ⇒
                 *     实测第 17 轮 `lcp` 只剩 **1 字（0.0%）**，而同一行 `hitChars` 是 **68,134 字（第 15 轮）**
                 *     ⇒ 面板上"本地 0% / 官方 71%"两个数当场背离，用户判"本地的数不是实际算法"——
                 *     这个判断是对的：那一格量的只是"与上一轮巧不巧"。
                 *   【修】挑"上一轮"时**只认 `readTurnCached` 读得出来的轮**。
                 *     那些已移出（`turns/_retired/`）的异常轮从此不再当锚点 ⇒ 第 17 轮的"上一轮"
                 *     自动回到第 15 轮（`00014`）⇒ 本地 ≈ 68,134 字，与官方同源、可比。
                 *   ⚠ 跳号本来就是既有事实（v6.24.112 起就按"存在的轮号"挑），这里是同一个判据的补强。 */
                let prevNo = null;
                for (const x of commits) {
                    if (!Number.isFinite(x.no) || x.no >= c.no) continue;
                    if (prevNo === null || x.no > prevNo) {
                        if (readTurnCached(dir, x.no)) prevNo = x.no;   // ★ 只认盘上真有的那一轮
                    }
                }
                const prev = prevNo === null ? null : readTurnCached(dir, prevNo);
                const m = lcpOfTurns(prev ? prev.body : null, cur.body);
                c.lcpChars = m ? m.chars : null;                       // lcp（字）
                c.missChars = m ? m.miss : null;                       // miss（字）＝这一轮总长 − lcp
                c.lcpItem = m ? m.item : null;                         // 公共前缀停在第几条（只做定位）
                c.lcpRole = m ? m.role : '';
                c.lcpSrc = m ? 'file' : '';                            // 来源：两份记录正文（file）
                const best = lcpBestOf(poolAll.filter(x => x.no < c.no), cur.body);
                c.hitChars = best ? best.chars : null;                 // ★ 池中最大（字）＝官方 hit 的本地尺子
                c.hitItem = best ? best.item : null;
                c.hitRole = best ? best.role : '';
                c.hitBestNo = best ? best.no : null;                   // ★ 这份最长前缀落在哪一轮
                /* ★★★★★★ v6.51.6【★ 白付（漂移税）—— 面板第一次能回答"这一轮贵，是因为我写了新东西，
                 *   还是因为前缀被撞断了"】见 `taxOfTurns` 上面那一整段。
                 *   ⚠ 只在这一轮**有上一轮可比**时才算（`prev` 不在 ⇒ `lcpChars` 也是 null ⇒ 一律 null）。
                 *   ⚠ 口径必须与 `lcpChars` **同源**（都从这两份盘上正文来）—— 不许拿客户端报的数当锚，
                 *     否则又成了"两个视图各说各话"。 */
                const tax = taxOfTurns(prev ? prev.body : null, cur.body, m ? m.chars : null);
                c.taxChars = (tax === null ? null : tax);              // 白付（字）；null = 算不了，面板显示 —，不拿 0 顶
            }
        }
        // ★★ v6.24.76【用户 ⑩：本地与官方必须 0 偏差】每一轮的「本地合计」= **服务端在盘上那份真出网
        //   原文上用酒馆那份真分词器现算出来的 prompt token**（＝官方 prompt_tokens）。
        //   为什么非搬到这里不可：以前面板读的是抬头上那格 tok，那是**客户端在它自己手里那份预演数组**上
        //   数的 —— 酒馆后端出网前会把同角色消息并一遍（实测 77 条 → 44 条），并掉一条就少算 2 tok，
        //   于是面板上恒挂着 +58 / +51 这种差；最刺眼的一轮因为走了"定稿快照"兜底，差了 −6,945。
        //   那个差**不是算法错**，是**数错了字** —— 现在数的就是那串字本身。
        // ★★★ v6.24.85【⑩ 0 偏差定案】：**顺序反过来了 —— 一律现算，抬头只当兜底。**
        //   原来写的是"抬头里有就直接读它，省一次编码"，那在**算法升级之后就成了陷阱**：
        //   抬头是**写入那一刻**用**当时那版算法**算的数，读它等于拿旧口径冒充新口径
        //   （实测：全仓 9 轮抬头停在 +1…+7，而现算是 0）。现在现算优先、`_exactTokMemo` 缓存兜性能，
        //   抬头那格从此只是"盘上那份文件自带的存档数"，**不再是面板的权威源**。
        //   两条路都拿不到（没分词器 / 这一轮不是出网原文形状）⇒ 一律 null，面板显示 —，**不拿别的数顶上**。
        for (const c of commits) {
            if (!Number.isFinite(c.no)) continue;
            const base = path.join(dir, 'turns', String(c.no).padStart(5, '0'));
            /* ★ v6.51.1：正文真名两可（新名 `.json` 优先、老轮次退 `.txt`）—— 与全项目同一处判据。 */
            const _bd = readTurnText(dir, c.no, 'body');
            if (!_bd) continue;
            const raw = _bd.text;
            if (!wireBodyShape(raw)) continue;          // 老记录是铺平文本，不是出网原文 → 不冒充
            let v = await exactPromptTokCached(`${c.no}|${raw.length}`, raw);
            if (!Number.isFinite(v)) {
                try {                                   // 现算不出来（没词表/环境异常）才退回抬头存档
                    const hl = fs.readFileSync(`${base}.meta.txt`, 'utf8');
                    const hm = /本地exact (\d+) tok/.exec(hl);
                    if (hm) v = Number(hm[1]);
                } catch (_) { /* 老记录没有旁文件 → 只能是 null */ }
            }
            c.tokExact = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
            /* ★★★★★★ v6.41.24【用**同一个真分词器**把 tokExact 劈成命中 / 未命中 —— 见 `exactPrefixTok` 上面那段】
               为什么非劈不可：面板「本地」那四格原来只有「合计」是真分词器的数，
               「命中/未命中」是客户端拿**字→tok 的比例尺**乘出来的 ⇒ 同一行里混着两种性质的数（用户点名的
               "面板自我冲突"）。劈完之后 `tokHit + tokMiss ≡ tokExact` **按定义恒成立**（I9 钉子）。
               ⚠ 只有"现算出来的 tokExact"才配劈：退回抬头存档那一支说明这台机器根本没有分词器。
               ⚠ `lcpChars`（与上一轮）与 `hitChars`（池中最大）各劈一次：前者是面板「本地命中」的口径
                 （既有语义一个字不动），后者是"对官方的尺子"（`tokHitBest`，只作对照、不改列）。 */
            c.tokHit = null; c.tokMiss = null; c.tokHitBest = null; c.tokPctSrc = '';
            if (Number.isFinite(c.tokExact) && Number.isFinite(c.lcpChars)) {
                const _h = await exactPrefixTokCached(c.no, raw.length, c.lcpChars, raw);
                if (Number.isFinite(_h)) {
                    c.tokHit = Math.round(_h);
                    c.tokMiss = Math.round(c.tokExact) - c.tokHit;
                    c.tokPctSrc = 'tok';
                }
            }
            if (Number.isFinite(c.tokExact) && Number.isFinite(c.hitChars)) {
                const _hb = await exactPrefixTokCached(c.no, raw.length, c.hitChars, raw);
                if (Number.isFinite(_hb)) c.tokHitBest = Math.round(_hb);
            }
        }
        res.json({ ok: true, v: ROUTE_V, commits });
    });

    /** ★ 2026-09-24（ROUTE_V 55）：**铺平那一件事，全项目只留这一个"给一段用"的实现**。
     *  与 `/flat` 同一条 `flattenWire`；只对"形状像出网 body"的那些做铺平，老记录（本来就是铺平文本）
     *  原样返回 —— 一个字节都不动。形状像 body 却铺不开的，也原样返回：**不编、不猜**。
     *  ⚠ 为什么必须提成 init 级（原来是 `/diff` 里的一个局部 `toFlat`）：`/tokseg` 要按**行号**切段，
     *    而那个行号就是**页面上的行号** —— 只有与 `/diff` 用**同一个函数**铺出来的那串，行号才对得上。
     *    两处各写一份（哪怕今天逐字相同）就是给以后埋一个"改了这儿忘了那儿"的错位。 */
    const toFlatText = (s) => {
        const t = String(s || '');
        if (!wireBodyShape(t)) return t;
        try { return flattenWire(t, 0, null, null, null, 'json').text; } catch (_) { return t; }
    };

    // git diff（真 patch）：from/to 可以是 sha，省略则取最近两次提交
    //   v6.21：`blob=1` 时 from/to 允许写成 `<sha>:<路径>`，比的是**两个文件**（相邻两轮的 request 文本）——
    //   因为每轮都是"新增一个 turns/NNNNN.txt"，比两次提交只会看到"整个文件都是新增"；比两个文件才是逐行 diff。
    //   依旧一行 diff 算法都没有：差异还是 git 算的。
    //   v6.24.7：这条路的 **POST** 版本也在下面（前端把"换上之后"的文本交上来 → 落成真文件 → 同一个 git diff）。
    router.get('/diff', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        if (!fs.existsSync(path.join(dir, '.git'))) return res.status(404).json({ ok: false, error: '这个聊天还没有仓库' });
        const blob = String(req.query.blob || '') === '1';       // 比两个文件（不是比两次提交）
        let from = String(req.query.from || '');
        let to = String(req.query.to || '');
        if (!from || !to) {
            // 顺序要紧：`git log -n 2` 是「新的在前」，to 必须取新的那个，否则 diff 方向会反
            const l = await run(['log', '--pretty=format:%h', '-n', '2'], dir);
            const shas = l.out.split('\n').filter(Boolean);
            if (shas.length < 2) return res.json({ ok: false, error: '至少要有两次提交才有 diff', sha: shas[0] || '' });
            to = shas[0]; from = shas[1];
        }
        const stat = await run(['diff', '--shortstat', from, to, '--', TURNS_SPEC], dir);
        // 先按老办法拿一份 patch（`blob=1` 时比的是两个 blob）：**取得到的提交**照旧由 git 直接算，
        // 这份同时用来兜底"改了哪些文件"（下面 `filesOf`）。取不到的情况在下面用"刚读到的正文"重算。
        const args = ['diff', '--no-color', '--unified=3', '--no-ext-diff', from, to];
        if (!blob) args.push('--', TURNS_SPEC);
        const patch = await run(args, dir);
        // 改了哪些文件：从 patch 的 `diff --git a/x b/x` 里读（下面 patch 空时用它兜底）。
        const filesOf = (p) => [...String(p || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(m => ({ a: m[1].trim(), b: m[2].trim() }));
        const sides = [];
        let missingBlob = false, blobNote = '';
        /** ★ v6.24.53：**patch 是不是"真比过"** —— 与"git 说没差异"分开：
         *   两边都读到了才算真比过；有一边读不到（提交没了、盘上也没了）就不算。 */
        /** ★ v6.24.68：盘上那份现在是**出网原文（POST body 逐字节）** ⇒ 比之前先**在内存里铺平**
         *  （铺平是展示层的事，不落盘、不改档）。老记录（本来就是铺平文本）原样返回；
         *  形状像 body 却铺不开的，也原样返回 —— 不编、不猜。
         *  ★ 2026-09-24（ROUTE_V 55）：这一份**提成了 init 级的 `toFlatText`** —— 理由见它头上那段
         *  （`/tokseg` 要按同一把尺子切行号）。这里留一个别名，下面两处调用点一个字不改。 */
        const toFlat = toFlatText;
        const fillSides = async (list) => {
            for (const f of list.slice(0, 1)) {
                const A = await readBlobRel(dir, from, f.a);
                const B = await readBlobRel(dir, to, f.b);
                sides.push({ file: f.a, a: toFlat(A.content), bFile: f.b, b: toFlat(B.content), aVia: A.via, bVia: B.via });
                if (A.via !== 'blob' || B.via !== 'blob') {
                    missingBlob = true;
                    const half = (via, ref) => (via === 'worktree' ? '提交里没有（用盘上那份顶上）' : '两边都找不到');
                    blobNote = `这一页记的提交已经不在仓库里了（记录被重建过）：前 = ${half(A.via, from)}，后 = ${half(B.via, to)}`
                        + `。读得到的那一份照常比；读不到的没得比 —— 不编、不拿别的数顶。`;
                }
            }
        };
        /** ★★★ v7（2026-09-19）：**必须认 `.raw.txt`** —— 这是 v29 那次半修留下的缺口。
         *  实测（自检 ③ 报红 · 场 `圣樱学院_mu8byex8oudg`）：客户端拿 `97496c8:turns/00002.raw.txt`
         *  来问，而这个正则**只认 `.txt` 与 `.sim.txt`** ⇒ 规范化成空串 ⇒ 下面 `readBlobRel` 拿到
         *  空路径 ⇒ `sides[0].a` 为空 ⇒ 页面报"有一边的记录读不到（前：97496c8:turns/00002.raw.txt）"。
         *  ⚠ 铁证（同一台机器实测）：`git show 97496c8:turns/00002.raw.txt` **读得出 50,994 字**，
         *    `git ls-tree HEAD turns/` 里也有这一份 —— 所以服务端那句"提交里没有、盘上也没有"
         *    是**假话**，真因就是这一行把路径吃掉了。
         *  （v29 给 `readBlobRel` 补了 `.raw.txt` 白名单，却漏了这一处 ⇒ 两处口径不一致，
         *    那张白名单**永远够不到**。教训：白名单要加就加在**路径被规范化之后**的那一处。）
         *  ⚠ `.sim` 那支保持原样（仍非捕获、仍规范化成 `turns/NNNNN.txt`），只补 `.raw` 一支。
         *  ★★★★★★ v6.51.1【改名之后这里**必须一起改**，否则 `/diff` 整条链当场全废】
         *   原正则 `…(?:\.sim)?\.txt$` 只认老名 ⇒ 客户端递 `turns/00010.json` 时匹配失败
         *   ⇒ 返回**空串** ⇒ 下面 `wantA` / `wantB` 都是空 ⇒ 那个"路径被规范化"的白名单
         *   一个都命不中 ⇒ 差异页报"有一边的记录读不到"。判据扩成 `txt|json` 两可，
         *   且**把认到的那个扩展名原样带出去**（不能一律改写成 `.txt` —— 那等于把新名又扔掉）。 */
        const blobFromRel = (rel) => {
            const m = /^(turns|sim)\/(\d{5})(\.raw)?(?:\.sim)?\.(txt|json)$/.exec(String(rel || ''));
            if (!m) return '';
            /* `.sim` 只有 `.txt` 一种（没改过名）⇒ 保留老行为，别让它长出 `.sim.json`。 */
            if (m[1] === 'sim') return `sim/${m[2]}.sim.txt`;
            return `turns/${m[2]}${m[3] || ''}.${m[4]}`;
        };
        const wantA = blobFromRel(String(from).split(':')[1] || '');
        const wantB = blobFromRel(String(to).split(':')[1] || '');
        // ★ v6.24.52 修一个真 bug（面板上看不出来，差异页"收纳处展开"一用就露）：
        //   原来这里两个 `git show` **都用了 a 侧那个文件名**（`files[i].a` 取了两遍）——
        //   于是 `toContent` 一直是**上一轮那一份**（实测 `圣樱学院_mu4y2xeo6lmz`：
        //   a/turns/00000.txt 与 b/turns/00001.txt，返回的两份都是 00000.txt 的内容）。
        //   正常情况两个文件名相同（同一个编号的文件比两份提交），所以谁都没发现。
        //   现在先按**请求里那两个路径**各取各的，再退回 patch 里读到的文件名。
        if (wantA || wantB) await fillSides([{ a: wantA || filesOf(patch.out)[0]?.a || '', b: wantB || filesOf(patch.out)[0]?.b || '' }]);
        if (!sides.length) await fillSides(filesOf(patch.out));
        if (!sides.length || (!sides[0].a && !sides[0].b)) {
            return res.json({ ok: false, error: '这两轮的记录在硬盘上已经找不到了（提交里没有、盘上也没有）→ 没法比' });
        }
        // ★ v6.24.53：**有一边一个字都没读到 → 就是"比不了"**，不许把空串当内容去比（那会得到"没差异"的假结论）。
        //   （上面兜底那一步只在"这一侧本来就有内容"时才成立；这里挡住"路径不认/文件不在"那种真读不到的情况。）
        if (!sides[0].a || !sides[0].b) {
            return res.json({
                ok: false,
                error: `有一边的记录读不到（${!sides[0].a ? `前：${from}` : `后：${to}`}）→ 没法比；`
                    + `提交里没有、盘上也没有。这一页记的提交可能已经被重建过（清空记录/重建仓库之后 sha 就变了）`,
            });
        }
        // ★ v6.24.53：**内容才是真值** —— patch 一律由"刚取到的那两份正文"现算：
        //   把两份正文落成临时文件（`.git/horae-tmp/`，被 gitignore），再让 git `--no-index` 比这两个文件。
        //   为什么非这样不可：那两轮记的提交可能已经不在仓库里了（历史被重建过），这时
        //   `git diff <老sha>:a <老sha>:b` 会说"没差异"（git 把取不到的 revision 当空文件），
        //   页面就画成"两轮一模一样" —— 那是**编数**（实测：用户看到 `0 插入 0 删除` 的空白差异页）。
        //   一行 diff 算法仍然没有：差异还是 git 算的，只是把"比哪两份字"交给**刚读到的内容**定。
        const bothSides = !!(sides[0].a && sides[0].b);
        const sameContent = bothSides && sides[0].a === sides[0].b;
        let patchOut = patch.out;
        if (blob && bothSides) {
            /* ★★★★★★ 2026-09-19【临时目录必须**按请求隔离** —— 实测抓到的真 bug】
             *  原来是固定一个 `<repo>/.git/horae-tmp`：**两个 `/diff` 请求同时在飞时**
             *  （面板连点、或验收并发预取），B 请求会把 A 请求刚落下的那两份正文**覆盖掉**，
             *  然后 A 的 `git diff --no-index` 比的就是**别人的内容** ⇒ 返回一份**张冠李戴的 patch**
             *  （实测：`check/brk_align_test.mjs` 同一份数据 **串行 2/2 全绿、6 路并发 1 坏 1 好**，
             *    坏的那次 patch 头是 `@@ -1 +1 @@`，而那一轮真实断点在 14953 行）。
             *  为什么非修不可（不只是验收的问题）：**用户在差异页快速连点两轮**就是同样两个请求同时在飞
             *  ⇒ 屏幕上会出现"这两轮的差异"其实是另外两份内容的 patch。**这是用户可见的错**。
             *  修法：目录名带上「轮号 ＋ 随机段」—— 同一进程的并发请求也互不干扰。
             *  ⚠ 目录在 `.git/` 下面，不会进仓库、不会被 git 看到。 */
            const rnd = crypto.randomBytes(4).toString('hex');
            const tmpDir = path.join(dir, '.git', `horae-tmp-${String(sides[0].bFile || 'x').replace(/\D/g, '')}-${rnd}`);
            /* ★ v6.51.1：这三句原来只认老名 `turns/NNNNN.txt` ⇒ 新名 `.json` 一律落进兜底，
             *  两侧会变成 `turns/00000.json` 与 `turns/00001.json` 两个**常量** ⇒ 比出来的 patch
             *  与真正那两轮无关（＝编数）。判据扩成"纯数字 ＋ txt|json 两可"。
             *  ★ v6.51.2【补上漏掉的一半】：上一版只扩了**扩展名**，没扩 **`.raw.` 这一支** ——
             *  而「同上轮↗」两侧是 `turns/NNNNN.raw.json` ⇒ 又落回那两个常量。
             *  实测（`_tmp/probe_rawprev.mjs`，真是 00012.raw.json ↔ 00013.raw.json）：
             *  `diff --git a/turns/00000.json b/turns/00001.json` —— 头两行是**错的名字**。
             *  ⚠ 用户**看不到**它：客户端 `_dvPatchHtml` 与 `_dvPlain` 都把 `diff --git|index |--- |+++ `
             *    开头的行整行跳过（两处 `continue`）⇒ 只是**存档级**的错名字。但这一支是新的常用入口，
             *    迟早会咬人（谁拿 patch 存档对账谁中招）⇒ 顺手正名，一行的事。 */
            const BODY_RE = /^turns\/\d{5}(\.raw)?\.(?:txt|json)$/;
            const aRel = BODY_RE.test(String(sides[0].file || '')) ? sides[0].file
                : (BODY_RE.test(String(sides[0].bFile || '')) ? sides[0].bFile : 'turns/00000.json');
            const bRel = aRel === sides[0].file && BODY_RE.test(String(sides[0].bFile || ''))
                ? sides[0].bFile : 'turns/00001.json';
            try {
                fs.mkdirSync(path.join(tmpDir, 'turns'), { recursive: true });
                fs.writeFileSync(path.join(tmpDir, ...aRel.split('/')), sides[0].a, 'utf8');
                fs.writeFileSync(path.join(tmpDir, ...bRel.split('/')), sides[0].b, 'utf8');
                const d2 = await run(['diff', '--no-index', '--no-color', '--unified=3', '--', aRel, bRel], tmpDir);
                if (d2.code === 0 || d2.code === 1) patchOut = d2.out;      // 0 = 一模一样、1 = 有差异；别的码保留原 patch
            } catch (_) { /* 落临时文件失败就保留原来那份 patch */ }
            // ★ 目录名带了随机段 ⇒ 每个请求自己一份 ⇒ **用完必须删掉**（否则 `.git/` 下会越积越多）
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
        }
        res.json({
            ok: true, from, to, blob, stat: stat.out.trim(), patch: patchOut, sides,
            fromContent: sides[0]?.a || '', toContent: sides[0]?.b || '',
            missingBlob, blobNote, sameContent,
        });
    });

    /* ══ ★ 2026-09-24（ROUTE_V 55）：给"某一侧的某几行"用**真分词器**数 token ═══════════════════
     * 用户原话（配差异页截图）："三个差异页的分词器有点问题 不过小bug，需要统一分词算法。
     *   第20轮官方与本地计算都是7k左右，但是差异页是8k的内容"。
     *
     * 【病】差异页上每条收纳条/变动块写着「≈X tok · Y 字」，那个 tok 是**折算**出来的：
     *      （那几行的字数 **＋ 行数**）× （面板的 tok ÷ 这一轮总字数）。
     *   实测第 20 轮（`林夏_mufaamjlis2x` 00019，两段合起来正是未命中那一段）：
     *      面板/官方那边：`tokMiss` **7,131**（真分词器）／官方 `miss` **7,281**
     *      差异页那边    ：`≈3,545 + ≈4,354` = **7,899**（折算）      ⇒ **虚高 768 tok / +10.8%**
     *   三处偏差叠出来的：① `gChars` 把 **407 个行尾换行**也算了进去，而面板的口径里只有"条数−1"个换行
     *   （≈ +278 tok）；② 被乘的是**铺平展示文本**的行字数，乘数却是**真出网字节**口径的比（≈ +190 tok）；
     *   ③ 剩下的是"全文平均 token 密度"与"这一段自己的密度"之差（miss 段是新写的正文，密度本来就高）。
     *
     * 【修法】段落的 token 交给**同一个分词器** —— 与 `/log` 的 `tokExact` / `tokHit` / `tokMiss`
     *   同一个 `stTokenCounter`（酒馆那份 `data/_cache/deepseek.json` 词表 ＋ `@agnai/web-tokenizers`）。
     *
     * 【为什么收**行区间**而不是收正文】差异页的每一段本来就是"第 a 行 ~ 第 b 行"（git 给的行号），
     *   所以既不用客户端自己切文本、也不用把几万字正文回传给服务端（少一次大 body）。
     *
     * 【口径】`from` 必须与 `/diff` 的 `from` **逐字相同**（同一个 `<sha>:<路径>`）—— 只有这样，
     *   经 `toFlatText` 铺出来的那串才与页面上那份逐字节一致，行号才对得上。
     *   ⚠ 实测性能（第 20 轮真数据，9 万字）：整份 encode **118 ms**、单段 6,000 字 **4 ms**、
     *     32 段合计 **137 ms** ⇒ 一次请求两百毫秒级，页面等得起。
     *   ⚠ 拿不到分词器（这台机器没词表）⇒ `ok:false` ＋ 说清原因；页面**照旧只写行数与字数**，绝不编 token。
     *
     * @param {string} chat  场名
     * @param {string} from  `<sha>:<turns/NNNNN.json>`（与 `/diff` 同形；`.raw.json` / `.abc.json` 也认）
     * @param {string} segs  `1-285,2130-2415`（**1 起算、闭区间**，行号就是页面上那两列的号）
     * @returns {{ok:boolean, file:string, lines:number, chars:number, total:{chars,tok},
     *            segs:Array<{a,b,chars,tok}>, tokSrc:string}} */
    router.get('/tokseg', async (req, res) => {
        const chat = safe(req.query.chat);
        const dir = repoOf(chat);
        const ref = String(req.query.from || '');
        const rel = String(ref).split(':').slice(1).join(':');
        if (!rel) return res.json({ ok: false, error: '缺少 from=<sha>:<路径>（要与 /diff 的 from 逐字相同）' });
        const segs = String(req.query.segs || '').split(',').map(s => {
            const m = /^(\d+)\s*-\s*(\d+)$/.exec(s.trim());
            if (!m) return null;
            const a = Math.max(1, Number(m[1]));
            return { a, b: Math.max(a, Number(m[2])) };
        }).filter(Boolean).slice(0, 200);
        if (!segs.length) return res.json({ ok: false, error: '缺少 segs=<起-止,起-止,…>（1 起算、闭区间）' });
        const counter = await stTokenCounter();
        if (!counter) {
            return res.json({
                ok: false,
                error: '这台机器没有分词器（读不到酒馆的 data/_cache/deepseek.json）→ 不编 token；'
                    + '面板「本地」那几列同样会给 —。',
            });
        }
        const got = await readBlobRel(dir, ref, rel);
        if (!got.content) return res.json({ ok: false, error: String(got.note || '这一份读不到') });
        const flat = toFlatText(got.content);
        const lines = flat.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        /* 裸 encode：`counter` 是"每条 content 各加 2 tok 模板开销"的那一版（见 TEMPLATE_PER_MSG_TOK）
         * ⇒ 减掉它，剩下的才是**这一段自己的** token。⚠ 减到 0 为止（空段就是 0，不出负数）。 */
        const tokOf = (t) => Math.max(0, Number(counter([{ role: 'user', content: t }])) - TEMPLATE_PER_MSG_TOK);
        const out = segs.map(({ a, b }) => {
            const text = lines.slice(a - 1, Math.min(b, lines.length)).join('\n');
            return { a, b, chars: text.length, tok: tokOf(text) };
        });
        res.json({
            ok: true, file: rel, via: got.via, lines: lines.length, chars: flat.length,
            total: { chars: flat.length, tok: tokOf(flat) },
            segs: out, tokSrc: 'deepseek',
        });
    });

    // ★ v6.24.36：原来这里有两个读 `wire/` 的路由（`/wire` 读 JSON、`/wiretext` 吐纯文本）——
    //   出网原文改成**直接写进 `turns/NNNNN.txt`** 之后它们就没用了：
    //   `原文↗` 走的还是原来那个静态网址（同一个轮子），读到的就是出网原文。整段删掉。

    // ── v6.24.7：同一件事的**另一半**（POST 到同一条路）：前端把"换上之后"的 request 文本交上来，
    //   落成真文件（面板上「原文↗」点开的就是它），再让 git 比这两个文件 —— 还是 git 在算 diff。
    router.post('/diff', async (req, res) => {
        const body = req.body || {};
        const chat = safe(body.chat);
        const dir = repoOf(chat);
        const no = Number(body.no);
        if (!Number.isFinite(no)) return res.json({ ok: false, error: '缺少轮次编号' });
        try {
            // ★ v6.39.0：第 4 个参数 `aText` —— 给了就把「前」那一侧换成它（实验算法那条线要的，见 ROUTE_V 那段 ②）
            // ★ v6.39.13：第 5 个参数 `opt` —— **两侧都从盘上文件取**（`aRel`/`bRel` 是相对聊天仓库的路径）。
            //   用户定版："直接将算法的计算结果存到自己工作区啊，然后正常的进行文件 diff"
            //   ⇒ 兼容三种（多参数，各管各的）：不传 = 老路（替换模拟）；`aText` = 双侧内存；`aRel`/`bRel` = 双侧盘上文件。
            res.json(await simDiff(dir, no, body.text, body.aText, {
                aFile: body.aRel, bFile: body.bRel, pipe: body.pipe,
            }));
        } catch (err) { res.json({ ok: false, error: String(err?.message || err) }); }
    });

    /* ══ ★ 2026-09-24（ROUTE_V 56）【抓包并进来了 —— 服务端从两个插件收成一个】══════════════════
     * 用户两句原话："**没有horae-wiretap，只有hitopt**" ＋
     *   "安装这么麻烦 谁家还要手动的 能输个git仓库地址算不错了"。
     * 病：抓包原来是一个**独立的服务端插件**（`plugins/horae-wiretap/`）⇒ 别人装完扩展还得手动拷
     *   第二个目录、再重启一次。而它其实是**自包含**的（只在传输层 patch `http/https.request`，
     *   外加三个只读路由）⇒ 完全可以寄生在本插件目录里。
     * 现在：`hitopt-git/wiretap.mjs` 由这里 import，路由挂到 `/api/plugins/hitopt-git/tap/…`。
     *   ⚠ 酒馆的 plugin-loader **只认 index.js / index.cjs / index.mjs 三个名字**
     *     （`src/plugin-loader.js` L109）⇒ `wiretap.mjs` **不会被重复加载成第二个插件**（id 也不会撞）。
     *   ⚠ 它的 OUT_ROOT 算的是"本模块所在目录 /captures" ⇒ 合并后正好落在
     *     `plugins/hitopt-git/captures/` —— 与记录仓库 `_gitlog/` 并排，一处看全。
     *   ⚠ 挂载失败**绝不许拖垮记录服务**：整段 try/catch，失败了照常提供记录服务，只把原因喊出来。 */
    try {
        const tap = await tapModule();
        if (!tap) throw new Error('wiretap.mjs 没读到（文件不在 / 语法坏了）');
        /* `init(router)` 里只用到 `router.get`（没有 use/post）⇒ 给一个**加 /tap 前缀**的薄包装就够，
         * 不必去借 express 建子 Router（少一个依赖、也少一处能出错的地方）。
         * 仍然把 post/use 一并转发：以后抓包那边加了写接口，这里不用再改。 */
        await tap.init({
            get: (p, h) => router.get('/tap' + p, h),
            post: (p, h) => router.post('/tap' + p, h),
            use: (p, h) => router.use('/tap' + p, h),
        });
    } catch (err) {
        horaeWarn('[hitOpt] 抓包（wiretap）挂载失败 —— 记录服务照常，但拿不到"真出网原文"：', err?.message || err);
    }

    console.log(`[hitOpt] 记录服务已就绪：/api/plugins/${info.id}（仓库根：${ROOT}）`);
}

/** ★★★★★★ v6.41.5【中间计算产物的家 ＝ **临时目录**，不进聊天 git 仓库】
 *
 *  【用户 2026-09-20 定版】原话："中间计算产物存 [管线的盘] 单独的 git 仓库" —— 随即自己改口：
 *    "**不了 不用 git 仓 反正 temp 目录**"。⇒ 落点 = 记录根下的 `_tmp/<聊天>/pipes/<管线槽>/…`。
 *  【同一天的纠正（第二句）】"**不是算法ID缓存区 而是 组合管线ID缓存区**"
 *    ⇒ 这一层的目录名是**组合管线槽名**（`pipes/`），不是"某个算法 id"。
 *      单级管线的槽名恰好等于那一级的 id ⇒ 默认配置下目录名看着一样，语义已经换过了。
 *
 *  【病（盘上铁证）】产物原先写在 `<ROOT>/<聊天>/algos/…` —— 那是**聊天仓库的工作树**，
 *    `git -C <repo> ls-files | grep algos` 实测它**已被跟踪**：
 *      `algos/ptr-exact-v2_4__ptr-exact-v2_4/pool/00001.txt` 等都在索引里；
 *    5 场聊天合计 **108 个文件 / 33.7 MB** 的**派生**数据进了**归档**仓库。
 *    归档仓库里该留的只有三类原始存档与主链的产物；管线产物是本链**算出来**的，随时可重算。
 *
 *  【判据（可证，不是偏好）】`isOurRepo(p)` 要求 `p/.git` 与 `p/turns` **同时**存在。
 *    `_tmp/<聊天>/` 两者都没有 ⇒ 写进它里面的东西
 *      ① 永远不会被 `listChatRepos` 当成一场聊天；
 *      ② 永远不会被 `pruneChatRepos` 按"最旧那一场"删掉；
 *      ③ 永远不会被 `/turn` 的 `git add -A` 收进任何一次提交。
 *
 *  【为什么由 `dir` 推导，而不新开环境变量/常量】`dir = repoOf(chat) = path.join(ROOT, safe(chat))`
 *    ⇒ 取它的父目录、再拼 `_tmp` 与它自己的目录名，得到的就是 `<ROOT>/_tmp/<safe(chat)>`：
 *    与 `dir` **同源** ⇒ 沙箱（`HORAE_GIT_ROOT` 指向临时目录）里自动成立，测试不必另配一套。
 *
 *  ⚠ **一处算法一套**：`/pipe`（写）、`/flat?pipe=`（读）、`simDiff`（两侧都从盘上取）三处
 *    必须调**这一个**函数；谁自己拼一次路径，谁就会与另外两处说不到一块去。 */
function pipeWorkDir(dir) { return path.join(path.dirname(dir), '_tmp', path.basename(dir)); }

/** v6.24.7：把"换上之后"的模拟文本**落成真文件**，再让 git 比这两个文件（本模块照旧一行 diff 都不写）——
 *  `git diff --no-index turns/NNNNN.txt sim/NNNNN.sim.txt`。
 *  文件**留着**：它就是面板上「原文↗」点开的那一份（换上的 request 全文），比完不删。
 *  目录叫 `sim/` 而不是 `.sim/` —— 酒馆的静态服务（express.static）默认不吐点号目录，
 *  「原文↗」那个网址会 404；不带点才能直接在浏览器里打开。
 *  本地忽略写在 .git/info/exclude（不改被跟踪的 .gitignore）→ 聊天仓库照旧一尘不染；只留最新那一轮的一份。 */
async function simDiff(dir, no, text, aText, opt) {
    const n = Math.max(0, Math.floor(Number(no) || 0));
    /* ★ v6.51.1：a 侧就是盘上这一轮的**正文**，真名交给 `turnRelOnDisk` 定点解析
     *  （新名 `turns/NNNNN.json`；老轮次、以及 v6.24.54 之前那 2 个老格式轮次仍是 `turns/NNNNN.txt`）。
     *  ⚠ 这里以前把名字**写死**成 `turns/NNNNN.txt` —— 改名之后下面那句
     *    `existsSync(path.join(dir, rel))` 当场为假 ⇒ 整条"替换模拟"退化成
     *    `这一轮的记录不在` ⇒ 差异页一个字都不画。**改名最隐蔽的一处就是它**。 */
    const rel = turnRelOnDisk(dir, n, 'body');
    /* ══════════════════════════════════════════════════════════════════════════════
     * ★★★★★★ v6.39.13【第三条路：**两侧都是盘上文件**】用户 2026-09-19 定版：
     *   "差异页用的 git diff 技术，所以你直接将算法的计算结果**存到自己工作区**啊，
     *    然后**正常的进行文件 diff**" ＋ "别忘记**接口参数正常传多个参数**"
     * ── 为什么必须有这一条（它治的是本轮那个真 bug 的根）────────────────────────
     *   旧的两条路都要求"页面手里得有那份文本"：`aText` 双侧模式吃的就是页面内存，
     *   而内存窗口只有 `EXP_ALGO_TEXT_KEEP = 3` 轮 ⇒ 第 4 轮那份一被挤掉，
     *   「🧪与前池化差异↗」就退化成"本链第一个有切片的轮"（**页面一个字 diff 都不画**），
     *   而面板那一行的实验数**明明在** —— 用户报的"内容异常，与面板结果不符"就是它。
     *   产物既然已经逐轮落在 `algos/<算法 id>/…` 里（v6.39.12 起），就不该再依赖页面内存：
     *   **服务端自己读这两个文件** → 落进比对用的临时区 → 让 git 正常 diff 文件。
     * ── 多参数（各管各的，互不干扰；谁都不给就逐位等于从前）──────────────────
     *   `aRel` / `bRel` = 两份文件的相对路径：以 `pipes/` 开头 ⇒ 相对**这个聊天的临时区**
     *   （`<ROOT>/_tmp/<聊天>/`，★ v6.41.5）；其余（`turns/…` / `sim/…`）⇒ 相对**这个聊天仓库**。
     *   `bRel` 省略 ⇒ 用 `aRel`；`aRel`/`bRel` 都不给 ⇒ 走下面的老路（替换模拟 / 双侧内存）。
     * ⚠ 安全：路径只许 `A-Za-z0-9_.-/`、且不许含 `..`（不许跳出这个聊天仓库）。
     * ══════════════════════════════════════════════════════════════════════════════ */
    const aFile = String(opt?.aFile || '').trim().replace(/\\/g, '/');
    const bFile = String(opt?.bFile || '').trim().replace(/\\/g, '/');
    if (aFile || bFile) {
        const pA = aFile || rel, pB = bFile || rel;
        const okPath = (p) => /^[A-Za-z0-9_./-]+$/.test(p) && !p.split('/').includes('..');
        if (!okPath(pA) || !okPath(pB)) return { ok: false, error: `路径不合法：${pA} / ${pB}` };
        /* ★ v6.41.5【`pipes/…` 的基底是**临时区**，不是聊天仓库】判据只有这一条前缀：
             · `pipes/…`   ⇒ `<ROOT>/_tmp/<聊天>/` ＋ 它（**组合管线**产物的家）
             · 其余（`turns/…` / `sim/…`）⇒ 聊天仓库根 ＋ 它（归档的东西原位不动）
           ⚠ 基底来自 `pipeWorkDir(dir)` 这**一个**函数（与 `/pipe`、`/flat` 同源）。 */
        const baseOf = (p) => (/^pipes\//.test(p) ? pipeWorkDir(dir) : dir);
        const readOr = (p) => { try { return fs.readFileSync(path.join(baseOf(p), p), 'utf8'); } catch (_) { return ''; } };
        const rawA = readOr(pA), rawB = readOr(pB);
        if (!rawA) return { ok: false, error: `盘上没有 ${pA}（组合管线产物住在**临时区** _tmp/，不在聊天仓库里；在面板上重算一次本链就会补上）` };
        if (!rawB) return { ok: false, error: `盘上没有 ${pB}` };
        /* ⚠ 铺平只对"抓包那份 POST body"用；实验产物是我们自己拼好的可读文本 ⇒ 原样拿去比。
         *   （形状一致才叫文件 diff；拿 flattenWire 去过一遍反而会改行。） */
        const asReadable = (s) => {
            if (!wireBodyShape(s)) return s;
            try { return flattenWire(s, 0, null, null, null, 'json').text; } catch (_) { return s; }
        };
        const flatA2 = asReadable(rawA), flatB2 = asReadable(rawB);
        const tmpDir = path.join(dir, '.git', 'horae-tmp');
        try {
            fs.mkdirSync(path.dirname(path.join(tmpDir, ...pA.split('/'))), { recursive: true });
            fs.mkdirSync(path.dirname(path.join(tmpDir, ...pB.split('/'))), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, ...pA.split('/')), flatA2, 'utf8');
            fs.writeFileSync(path.join(tmpDir, ...pB.split('/')), flatB2, 'utf8');
        } catch (_) { /* 落不下去就让 git 直接在仓库里比 —— 至少不抛 */ }
        const stat2 = await run(['diff', '--no-index', '--shortstat', '--', pA, pB], tmpDir);
        const patch2 = await run(['diff', '--no-index', '--no-color', '--unified=3', '--', pA, pB], tmpDir);
        return {
            ok: true, a: pA, b: pB, mode: 'files', pipe: String(opt?.pipe || ''),
            shortstat: (stat2.out || stat2.err || '').trim(),
            patch: patch2.out, patchErr: patch2.err.trim(),
            fromContent: flatA2, toContent: flatB2,
        };
    }
    /* ★ v6.39.0【双侧模式】`aText` 给了 ⇒ 「前」那一侧也由调用方给（实验算法那条线要的，见 ROUTE_V 那段 ②）。
     *   两侧都落 `sim/`（已 gitignore、不进 git、不是三大类原始存档）⇒ **diff 仍由 git 算**。
     *   不给 ⇒ 原样：a 侧 = 盘上 `turns/NNNNN.txt`（铺平后），b 侧 = 传进来的那份（这就是"替换模拟"）。 */
    const twoSide = (aText !== undefined && aText !== null);
    if (!twoSide && !fs.existsSync(path.join(dir, rel))) return { ok: false, error: '这一轮的记录不在' };
    const simDir = path.join(dir, 'sim');
    const p5 = String(n).padStart(5, '0');
    const bRel = twoSide ? `sim/${p5}.sim.b.txt` : `sim/${p5}.sim.txt`;
    const aRel = twoSide ? `sim/${p5}.sim.a.txt` : rel;
    const b = path.join(simDir, `${p5}${twoSide ? '.sim.b' : '.sim'}.txt`);
    fs.mkdirSync(simDir, { recursive: true });
    ensureGitExclude(dir, 'sim/');
    fs.writeFileSync(b, String(text ?? ''), 'utf8');
    if (twoSide) { try { fs.writeFileSync(path.join(simDir, `${p5}.sim.a.txt`), String(aText ?? ''), 'utf8'); } catch (_) { /* 写不下去就照旧退回单侧 */ } }
    // 上一轮留下的模拟文件没人会再点（面板只挂最新那一轮）—— 只留这一轮真写下去的那几份
    const keep = new Set([path.basename(b)]);
    if (twoSide) keep.add(`${p5}.sim.a.txt`);
    for (const f of fs.readdirSync(simDir)) {
        if (/\.sim(\.a|\.b)?\.txt$/.test(f) && !keep.has(f)) { try { fs.rmSync(path.join(simDir, f), { force: true }); } catch (_) { /* 删不掉也无所谓 */ } }
    }
    // ★ v6.24.68：`turns/NNNNN.txt` 现在是**出网原文**（POST body 逐字节），而"换上之后"那份（sim）
    //   本来就是**我们自己铺平的可读文本** —— 两者形状不同，直接让 git 比会变成"一坨 JSON vs 一页文本"。
    //   ⇒ 把 a 侧**在内存里铺平**后落到比对的临时目录（`.git/horae-tmp/`，被 gitignore、不进归档），
    //     再让 git 比这两份**同形状**的可读文本。**归档里的那一个字节都没动**（§2.7）。
    const readOr0 = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } };
    // ★ v6.39.0：双侧模式「前」那份就是调用方给的原文（**不铺平** —— 两边都是我们自己拼好的可读文本，
    //   同一形状；铺平是给"盘上 JSON body"用的，用在这儿会把 a 侧改形状 ⇒ 整页 diff 变成一坨）。
    const rawA = twoSide ? String(aText ?? '') : readOr0(path.join(dir, rel));
    let flatA = rawA;
    if (!twoSide && wireBodyShape(rawA)) { try { flatA = flattenWire(rawA, 0, null, null, null, 'json').text; } catch (_) { flatA = rawA; } }
    const tmpDir = path.join(dir, '.git', 'horae-tmp');
    try {
        fs.mkdirSync(path.join(tmpDir, 'turns'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'sim'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, ...aRel.split('/')), flatA, 'utf8');
        fs.writeFileSync(path.join(tmpDir, ...bRel.split('/')), String(text ?? ''), 'utf8');
    } catch (_) { /* 落不下去就退回仓库根比 —— 至少不抛 */ }
    const stat = await run(['diff', '--no-index', '--shortstat', '--', aRel, bRel], tmpDir);
    const patch = await run(['diff', '--no-index', '--no-color', '--unified=3', '--', aRel, bRel], tmpDir);
    // ★ v6.24.52：顺手把**两份真文本**也带回去 —— 差异页"收纳处展开"要按行号现切那几行
    //   （git 只吐 -U3 那三行上下文，中间没变的行没在 patch 里）。读的就是刚刚写下去、比过的那两份文件，
    //   不重算、不另开接口；读不出来就是空串（页面那边如实说"展不开"）。
    //   ★ v6.24.68：a 侧返回**铺平版**（与 patch 同一形状，行号才对得上）；归档那份原文仍是 `turns/NNNNN.txt`。
    return {
        ok: true, a: aRel, b: bRel, twoSide,
        shortstat: (stat.out || stat.err || '').trim(),
        patch: patch.out, patchErr: patch.err.trim(),
        fromContent: flatA,
        toContent: readOr0(b),
    };
}

export function exit() {
    // 没有长驻资源需要回收
}
