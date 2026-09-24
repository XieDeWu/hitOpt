/* ══════════════════════════════════════════════════════════════════════════════════════
 * Horae v6.39.1 —— **实验算法注册表**（`core/expAlgo/registry.js`）
 *
 * 用户 2026-09-19 定版原话：
 *   "注意 切换按钮是下拉框 里面是（算法名+算法版本） 每个算法必须独立代码块，建议单独的js文件"
 *
 * ── 这一层是什么 ────────────────────────────────────────────────────────────────
 *   纯登记簿 ＋ 唯一调用口。**它自己不含任何算法**，也不碰 DOM / localStorage / 网络。
 *   每个算法一个独立 js 文件（本目录下），文件末尾调一次 `register({...})` 把自己的
 *   **名字、版本、说明、本体函数**登记进来 ⇒ 下拉框自动就有它了。
 *
 * ── 加一个新算法要做的事（只有两步）────────────────────────────────────────────
 *   ① 在本目录新建 `myAlgo.js`，照 `ptrExact.js` 的样板写，末尾 `register({...})`；
 *   ② 在 `index.js` 里加一行 `import './myAlgo.js';`
 *   ⇒ 下拉框、面板、存档**全都不用改**（注册表驱动）。
 *
 * ── 保护条款（别绕过）──────────────────────────────────────────────────────────
 *   ⚠ 注册进来的函数**只允许动 B**：签名固定 `apply(B_msgs, ref) → { msgs, cover, n, ptr }`，
 *     拿不到 A、也拿不到 C（调用方那两个字都不传）⇒ "A 不动、C 保真"是**结构保证**，
 *     不靠算法自觉。这是用户指令 A（"装配行为只涉及B区，A区别动，C区一直保真"）的落地。
 *   ⚠ 算法**不许读盘、不许发网络、不许写 localStorage**：判据在 `check/exp_algo_test.mjs`
 *     （沙箱把 fs / fetch 全桩成记账器，跑完必须 0 次写）。
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/** 已登记的算法：id → { id, name, version, kind, desc, apply } */
export const ALGOS = Object.create(null);

/** 登记一个算法。**同名重复登记 = 直接报错**（宁可启动就炸，也不许两份实现互相顶替）。
 *  ★ v6.39.10【主算法也是算法】用户 2026-09-19 定版："你不能给主算法搞特殊 因为主算法也是算法，
 *    实验算法也是算法，本质都是切换" ⇒ 注册表收两种条目，**接口一样、只有 `kind` 不同**：
 *      · `kind: 'local'`（默认）—— 要在本地跑一遍计算 ⇒ **必须有 `apply`**；
 *      · `kind: 'disk'`        —— 产物是**盘上的文件**（主算法：`turns/NNNNN.txt`）
 *        ⇒ 没有 `apply` 是正常的（它的"算法"在客户端主链路里，注册表只是让它被切换机制认识）。
 *  ⚠ 判据落在"有没有 `apply`"上，而不是"id 是不是 main" —— 后者就是给主算法开小灶。 */
export function register(spec) {
    const s = spec || {};
    if (!s.id || !s.name || !s.version) throw new Error('[expAlgo] register 缺 id/name/version');
    const kind = (s.kind === 'disk') ? 'disk' : 'local';
    if (kind === 'local' && typeof s.apply !== 'function') throw new Error(`[expAlgo] ${s.id} 没有 apply 函数`);
    if (ALGOS[s.id]) throw new Error(`[expAlgo] 算法 id 重复：${s.id}（每个算法一个独立文件，id 必须唯一）`);
    ALGOS[s.id] = {
        id: String(s.id),
        name: String(s.name),
        version: String(s.version),
        kind,
        desc: String(s.desc || ''),
        apply: (typeof s.apply === 'function') ? s.apply : null,
        /* ★ v6.41.4【`needs`：这一级跑起来**依赖什么** —— 元数据，不是给谁开小灶】
           目前只有一种取值：`'legacy'` = 它的本体住在主链路（`_abSplit` 内部、依赖**那一轮**的
           跨轮台账 `_amPoolSend` / `_amAddrPool`）⇒ **只有主链跑得动它**。
           面板那条"只读切片复算"的链没有那套台账 ⇒ 面板据此**如实标注**"主链专属"，
           而不是让用户点下去、再看到一片空白（v6.41.4 之前就是这个体验）。
           ⚠ 判据落在**这个字段**上，不是"id 是不是 am- 开头" —— 后者又是开小灶。 */
        needs: String(s.needs || ''),
    };
    return ALGOS[s.id];
}

/** 下拉框要的那串：**算法名 + 算法版本**（用户点名的格式） */
export function label(a) {
    const x = (typeof a === 'string') ? ALGOS[a] : a;
    return x ? `${x.name} ${x.version}` : '(未知算法)';
}

/** 已登记的算法列表（**按注册顺序**，顺序稳定 ⇒ 下拉框不会每次刷新都换位置）
 *  ★★★★★★ v6.41.0【排序从"id 字母序"改成"注册顺序" —— 这是一条真被踩到的因果，不是偏好】
 *   管线那两级适配器（`am-block-ptr` / `am-addr-recall`）的 id 以 `a` 开头 ⇒ 按字母序会
 *   **排到** `ptr-exact` 前面 ⇒ `_expAlgoPick` / `_expAlgoSlotId` 里那句
 *   "没选过 ⇒ 清单里第一个 local 算法"就**静默换人**了（从 `ptr-exact` 变成 `am-addr-recall`）
 *   —— 面板槽键、实验链默认算法全跟着漂（`exp_algo_test` 当场报"串行跑到第 0 轮"，
 *   因为假注册表里没有那个新 id）。
 *   ⇒ 按**注册顺序**（＝ `index.js` 里 import 的顺序）返回：顺序照样稳定（不随刷新变），
 *     而且"新加的算法排在最后" —— 这正是加算法时想要的性质。 */
export function list() {
    return Object.keys(ALGOS).map((k) => ALGOS[k]);
}

/** 取一个算法；给不存在的 id 就抛（**不静默退回默认** —— 那样面板会拿别的算法冒充你选的那个） */
export function get(id) {
    const a = ALGOS[id];
    if (!a) throw new Error(`[expAlgo] 没有这个算法：${id}`);
    return a;
}
