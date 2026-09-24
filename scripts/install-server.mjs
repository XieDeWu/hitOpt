#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════════════
 * hitOpt 服务端安装器 —— **真正干活的是这个文件**（旁边的 `.bat` 只是一层纯 ASCII 的引导）
 *
 * 【为什么不全写在 .bat 里】2026-09-25 用户当场报的，原话：
 *     **"英文鸟语看不懂 还乱码"**
 *   他双击后看到的窗口里，正常输出中间夹着一堆
 *       'gins' is not recognized as an internal or external command,
 *       '**件目录里的数据（`_gitlog`' is not recognized as an internal or external command,
 *       '1.' is not recognized as an internal or external command,
 *   ⇒ 真因是 cmd 的经典坑：**批处理文件里有 `chcp 65001`、而文件本身是非 ASCII 编码**时，
 *     cmd 换代码页会**按"字符数"重新定位文件指针**，与真实"字节数"对不上
 *     ⇒ 从错误的位置继续读文件 ⇒ 行被切碎、碎片被当成命令执行
 *     （铁证：`plugins` 被切成 `plu` + `gins`，那个 `gins` 就是它拿去执行的"命令"）。
 *   ⚠ 功能上它其实**成功了**（两个文件都装上了、目录也找对了），但那个窗口看起来像彻底失败 ——
 *     这正是最坏的一种：**用户以为坏了，其实是好的**。
 *   ⇒ 现在的分工：`.bat` 只做三件纯 ASCII 的事（切代码页 → 找 node → 调本文件），
 *     其余**全部**交给本文件。Node 输出天然是 UTF-8，配 `chcp 65001` 正好；
 *     而 ASCII 的 bat 无论控制台是什么代码页都不会被读错。
 *
 * 【它还顺手做了 .bat 做不到的事】
 *   · 读 `config.yaml` 告诉用户 `enableServerPlugins` **到底开了没有**（只读，⛔ 绝不代改配置）；
 *   · 装完用 sha256 **校验**装进去的就是源文件那一份（不是"复制命令没报错"就算完）；
 *   · 失败时给出**能照着做**的下一步，而不是一句"失败"。
 *
 * 用法（正常不需要手动跑，双击旁边的 .bat 即可）：
 *   node install-server.mjs ["<酒馆根目录>"]
 * ══════════════════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'server');
const ARG = (process.argv[2] || '').trim();
const LOG = process.env.HITOPT_LOG || path.join(os.tmpdir(), 'hitopt-install.log');
const MAX_UP = 8;          // 往上最多找几层（酒馆里那 6 层够用，留点余量）

let failed = 0;
const lines = [];
/** 边说边记（日志里那份是给"窗口关了还想查"用的）。 */
function say(s = '') { lines.push(s); console.log(s); }
function flush() { try { fs.appendFileSync(LOG, lines.join('\n') + '\n', 'utf8'); } catch (_) { /* 写不了日志不影响安装 */ } }
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

say('');
say('  hitOpt 服务端安装');
say('  ────────────────────────────────────────────────');

/* ── ① 定酒馆根目录：优先用拖进来的参数；没给就从本文件所在目录往上找 ──────────────────── */
const looksLikeTavern = (d) => { try { return fs.statSync(path.join(d, 'config.yaml')).isFile(); } catch (_) { return false; } };
function findTavern(start) {
    let p = path.resolve(start);
    for (let i = 0; i <= MAX_UP; i++) {
        if (looksLikeTavern(p)) return { dir: p, hops: i };
        const up = path.dirname(p);
        if (up === p) break;
        p = up;
    }
    return null;
}

if (ARG && !fs.existsSync(ARG)) {
    say(`  ⛔ 你给的这个路径不存在：${ARG}`);
    flush(); process.exit(1);
}
const hit = findTavern(ARG || HERE);
if (!hit) {
    say('');
    if (ARG) {
        say(`  ⛔ 在你给的这个路径里、以及它往上 ${MAX_UP} 层，都没有找到 config.yaml：`);
        say(`       ${ARG}`);
        say('     说明它不在酒馆里面。');
    } else {
        say('  ⛔ 没能自动认出酒馆目录。');
    }
    say('');
    say('  怎么办（二选一）：');
    say('    · 双击本脚本所在目录里的 install-server.bat（扩展装在酒馆里时它会自己找到）；');
    say('    · 或者把「酒馆根目录」拖到 install-server.bat 上 ——');
    say('      酒馆根目录 = 里面有 config.yaml 和 plugins 文件夹的那一层。');
    say('');
    failed = 1;
    flush(); process.exit(1);
}
const ST = hit.dir;
if (ARG) {
    const give = path.resolve(ARG);
    if (give !== ST) {
        say(`  ⚠ 你拖进来的是：${give}`);
        say('    那里面没有 config.yaml，不是酒馆根目录 —— 我从它往上找到了真正的那一层。');
    }
} else {
    say('  （没拖东西 —— 本脚本就在酒馆里，自动往上找到了酒馆根目录）');
}
say('');
say(`  酒馆目录：${ST}`);
say(`  源      ：${SRC}`);
say(`  目标    ：${path.join(ST, 'plugins', 'hitopt-git')}`);
say('');

/* ── ② 源文件在不在 ──────────────────────────────────────────────────────────────── */
const files = ['index.mjs', 'wiretap.mjs'];
for (const f of files) {
    if (!fs.existsSync(path.join(SRC, f))) {
        say(`  ⛔ 找不到 ${path.join(SRC, f)}`);
        say('     这个安装器必须和 server 文件夹待在一起（别把它单独拷出来用）。');
        say('');
        flush(); process.exit(1);
    }
}

/* ── ③ 复制 ──────────────────────────────────────────────────────────────────────── */
const DST = path.join(ST, 'plugins', 'hitopt-git');
try {
    if (!fs.existsSync(DST)) { fs.mkdirSync(DST, { recursive: true }); say('  新建了插件目录。'); }
    else { say('  插件目录已存在 —— 只覆盖两个 .mjs，_gitlog / captures 等数据一个都不动。'); }
} catch (e) {
    say(`  ⛔ 建不了插件目录：${e.message}`);
    flush(); process.exit(1);
}

for (const f of files) {
    const a = path.join(SRC, f), b = path.join(DST, f);
    try {
        fs.copyFileSync(a, b);
        const same = sha(a) === sha(b);
        say(`  ${same ? '✓' : '✗'} ${f.padEnd(12)} 已部署${same ? '（sha256 校验一致）' : '（⚠ 校验不一致！）'}`);
        if (!same) failed = 1;
    } catch (e) {
        say(`  ⛔ ${f} 复制失败：${e.message}`);
        say('     多半是酒馆正在运行占用了文件 —— 先关掉酒馆，再双击一次。');
        failed = 1;
    }
}
say('');

/* ── ④ 只读检查 config.yaml 的开关（⛔ 只报告，绝不代改用户配置）───────────────────── */
let sw = 'unknown';
try {
    const y = fs.readFileSync(path.join(ST, 'config.yaml'), 'utf8');
    const m = y.split(/\r?\n/).find((l) => /^\s*enableServerPlugins\s*:/.test(l));
    if (!m) sw = 'missing';
    else sw = /:\s*true\s*(#.*)?$/i.test(m) ? 'true' : 'false';
} catch (_) { sw = 'unknown'; }

say('  ────────────────────────────────────────────────');
if (sw === 'true') {
    say('   还有一步：重启酒馆（服务端插件只在启动时加载）。');
} else if (sw === 'false') {
    say('   ⚠ 还差两步：');
    say('     1. 把 config.yaml 里的这一行改成 true（现在是 false）：');
    say('          enableServerPlugins: true');
    say('     2. 重启酒馆（服务端插件只在启动时加载）。');
    failed = 1;
} else if (sw === 'missing') {
    say('   ⚠ 还差两步：');
    say('     1. config.yaml 里没有 enableServerPlugins 这一项 —— 加上一行：');
    say('          enableServerPlugins: true');
    say('     2. 重启酒馆（服务端插件只在启动时加载）。');
    failed = 1;
} else {
    say('   还差两步：');
    say('     1. 确认 config.yaml 里有  enableServerPlugins: true');
    say('     2. 重启酒馆（服务端插件只在启动时加载）。');
}
say('  ────────────────────────────────────────────────');
say('');
say(`  （日志：${LOG}）`);
say('');
flush();
process.exit(failed ? 1 : 0);
