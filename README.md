# hitOpt · 命中优化（SillyTavern 插件）

给 SillyTavern 用的**缓存命中分析面板**：把每一轮**真发出去的那个请求**记下来，算出命中/未命中，
点开就能看逐行差异 —— 数据全部来自落盘的真出网原文，不是估算。

> ⚠ **这个插件由两半组成**：浏览器端扩展 ＋ 服务端插件。
> 酒馆那个「输入 Git URL 安装」的入口**只能装到浏览器端那一半** ——
> 服务端那一半必须有人放进 `<酒馆>/plugins/` 一次（原因见下面「为什么要手动装服务端」）。

---

## 安装（三步）

### 1. 装浏览器端

酒馆 → **扩展程序** → **安装扩展程序** → 粘贴这个仓库的地址：

```
https://github.com/XieDeWu/hitOpt
```

（或者把本仓库整个拷进 `public/scripts/extensions/third-party/hitOpt/`。）

### 2. 装服务端

**Windows（推荐，双击就行）**：把**酒馆根目录**拖到 `scripts/install-server.bat` 上。

**手动**：把本仓库 `server/` 里的两个文件拷到 `<酒馆>/plugins/hitopt-git/`：

```
<酒馆>/plugins/hitopt-git/
├─ index.mjs      记录服务
└─ wiretap.mjs    抓包
```

⚠ 只要这两个文件。**不要**把整个 `server/` 连带别的东西盖过去，更不要删这个目录里已有的
`_gitlog/`、`captures/` —— 那是你的记录，不是安装残渣。

### 3. 重启酒馆 ＋ F5

- 确认 `config.yaml` 里 `enableServerPlugins: true`
- **重启酒馆**（服务端插件只在启动时加载）
- 浏览器 **F5**（扩展是浏览器端代码）

以后想更新：酒馆会**自己 `git pull`**（`enableServerPluginsAutoUpdate` 默认 `true`），
不用再手动做第 2 步。

---

## 为什么要手动装服务端（不是这个插件特殊）

酒馆里是**两套互不相干的加载系统**：

| | 从哪加载 | 怎么装 |
|---|---|---|
| 浏览器端扩展 | `<酒馆>/public/scripts/extensions/third-party/` | Git URL 一键装（`src/endpoints/extensions.js` 里是 `git.clone`） |
| 服务端插件 | `<酒馆>/plugins/` | **只能手动放**（`src/plugin-loader.js` 只有一句 `fs.readdirSync(pluginsPath)`，没有任何下载或市场机制） |

而这个插件的核心功能——把真正发出去的 POST body 截下来、落盘、跑 git diff——
**全都必须在服务端做**（要 Node 的文件系统与传输层），浏览器端做不到。

所以「只输一个 Git 地址就全装好」在酒馆里做不到，**对任何服务端插件都一样**。
能省的部分这个仓库已经省了：服务端**只有一个目录**（抓包并进了记录服务），
所以第 2 步只需要 `clone`/拷**一次**。

---

## 装完之后

打开酒馆的扩展抽屉（或面板），你会看到一张逐轮的表：每轮的命中/未命中/费用/断点位置，
以及每行下面两排入口：

```
原文↗  同上轮↗  池化↗  输出↗        ← 原始信息
同轮↗  跟上轮↗                       ← 对比差异
```

数据落在服务端插件目录里（**不进 git**）：

```
<酒馆>/plugins/hitopt-git/
├─ _gitlog/     每一轮的记录（你自己的聊天仓库）
├─ captures/    抓包落下的真出网原文与官方返回
├─ _tokcache/   分词结果缓存
└─ _errlog/     插件自己的异常日志
```

---

## 目录说明

```
hitOpt/
├─ manifest.json     扩展清单（酒馆读它；**必须在仓库根**，否则 Git URL 装不上）
├─ index.js          浏览器端入口
├─ opt.js            算法本体
├─ ledger.js         账本与面板
├─ view.html/view.js 差异页
├─ style.css
├─ core/             算法注册表（11 个文件，缺一个就跑不起来）
├─ server/           服务端插件（部署到 <酒馆>/plugins/hitopt-git/）
└─ scripts/          安装脚本
```

⚠ `server/` 放在仓库根下**不影响扩展运行** —— 酒馆只读 `manifest.json` 和它声明的 `js`/`css`，
多出来的目录只是跟着 clone 下来，方便你部署。

---

## 版本与生效方式

- 只改了 `hitOpt/*.js`（浏览器端）⇒ **F5**
- 改了 `server/*.mjs` ⇒ **重启酒馆**
- `server/index.mjs` 里的 `ROUTE_V` 是服务端路由协议版本；它变了就必须重启

---

## 许可

见 `LICENSE`。
