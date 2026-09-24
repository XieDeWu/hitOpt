@echo off
chcp 65001 >nul
setlocal
title hitOpt 服务端安装

rem ══════════════════════════════════════════════════════════════════════════
rem  hitOpt 服务端插件 —— 一键部署（v2：把"拖错了"当正常情况处理）
rem
rem  为什么需要这个脚本（酒馆的机制，不是这个插件特殊）：
rem    酒馆那个「扩展程序 → 安装扩展程序 → 输入 Git URL」入口，只会把仓库 clone 到
rem     public/scripts/extensions/third-party/<仓库名>/
rem    而服务端插件的加载器（src/plugin-loader.js）只读 <酒馆>/plugins/ 这一层，
rem    **没有任何下载或市场机制**。
rem    ⇒ 所以服务端必须有人把它放进 plugins/ 一次。这个脚本就是那"一次"。
rem
rem  它做什么：只把两个 .mjs 复制过去。
rem  ⛔ 它**绝不删除、绝不覆盖**插件目录里的数据（_gitlog / captures / _tokcache / _errlog）。
rem
rem  ★ v2 补的容错（用户 2026-09-25 当场报的："黑窗口怎么闪了一下就结束了？我啥都没看见"）：
rem    ① 双击（没拖东西）**也能装** —— 只要这个扩展是装在酒馆里的，脚本会从自己的位置往上找酒馆根；
rem    ② 拖错了**不会一闪而过** —— 从你拖进来的那个路径往上找 config.yaml（最多 8 层）自动纠正，
rem       并把你拖的是什么、我最后用的是什么，都打在屏幕上；
rem    ③ 怎么走都停在 `pause`（每一条出口都汇到 :end）—— 窗口再也不闪退；
rem    ④ 全程写一份日志到 %TEMP%\hitopt-install.log（窗口真被关了也还能查）；
rem    ⑤ 退出码仍然如实（0 = 装上 / 1 = 没装），脚本能被自动化调用。
rem ══════════════════════════════════════════════════════════════════════════

set "HERE=%~dp0"
set "SRC=%HERE%..\server"
set "ARG=%~1"
set "ST=%ARG%"
set "DEPTH=0"
set "RC=0"
set "LOG=%TEMP%\hitopt-install.log"

echo [%date% %time%] 启动；参数="%ARG%"；脚本位置="%HERE%" >> "%LOG%" 2>nul

echo.
echo   hitOpt 服务端安装
echo   ────────────────────────────────────────────────

rem ── ① 定酒馆根目录 ─────────────────────────────────────────────────────────
rem  优先用你拖进来的；没拖就从本脚本所在目录往上找（扩展装在酒馆里时那个就是酒馆根）。
if "%ST%"=="" set "ST=%HERE%"

:probe
if exist "%ST%\config.yaml" goto :found
for %%I in ("%ST%\..") do set "UP=%%~fI"
if /i "%UP%"=="%ST%" goto :notfound
set "ST=%UP%"
set /a DEPTH+=1
if %DEPTH% leq 8 goto :probe
goto :notfound

:found
rem  把你拖进来的路径规范化一下，好跟最终用的那个比（尾随反斜杠会让它们看着不一样）
if not "%ARG%"=="" for %%I in ("%ARG%") do set "ARGN=%%~fI"
if not "%ARG%"=="" if /i not "%ARGN%"=="%ST%" (
    echo   ⚠ 你拖进来的是：%ARGN%
    echo     那里面没有 config.yaml，不是酒馆根目录。
    echo     我从它往上找到了真正的那一层：
)
if "%ARG%"=="" echo   （没拖东西 —— 本脚本就在酒馆里，自动往上找到了酒馆根目录）
echo.
echo   酒馆目录：%ST%
echo   源      ：%SRC%
echo   目标    ：%ST%\plugins\hitopt-git
echo.

if not exist "%ST%\plugins" (
    echo   ⚠ 这一层没有 plugins 文件夹 —— 如果它不是酒馆根目录，请关掉窗口重来，把酒馆根目录拖上来。
    echo.
)

rem ── ② 派发 ─────────────────────────────────────────────────────────────────
if not exist "%SRC%\index.mjs" (
    echo   ⛔ 找不到 %SRC%\index.mjs
    echo      这个 bat 必须和 server 文件夹待在一起（不能把它单独拷出来用）。
    echo.
    set "RC=1"
    goto :end
)

set "DST=%ST%\plugins\hitopt-git"

if not exist "%DST%" (
    mkdir "%DST%"
    echo   新建了插件目录。
) else (
    echo   插件目录已存在 —— 只覆盖两个 .mjs，_gitlog / captures 等数据一个都不动。
)

copy /Y "%SRC%\index.mjs"   "%DST%\index.mjs"   >nul
copy /Y "%SRC%\wiretap.mjs" "%DST%\wiretap.mjs" >nul

if errorlevel 1 (
    echo.
    echo   ⛔ 复制失败。多半是酒馆正在运行占用了文件 —— 先关掉酒馆，再双击一次本脚本。
    echo.
    set "RC=1"
    goto :end
)

echo   ✓ index.mjs   已部署
echo   ✓ wiretap.mjs 已部署
echo.
echo   ────────────────────────────────────────────────
echo    还差两步：
echo      1. 确认 config.yaml 里有  enableServerPlugins: true
echo      2. 重启酒馆（服务端插件只在启动时加载）
echo   ────────────────────────────────────────────────
goto :end

rem ── ③ 没找到（两种说法，因为"没拖"和"拖错了"要给的指引不一样）──────────────
:notfound
set "RC=1"
if "%ARG%"=="" goto :no_arg
echo.
echo   ⛔ 在下面这个路径里找不到 config.yaml：
echo        %ST%
echo       （你拖进来的是：%ARG%）
echo      从它往上找了 8 层都没有 —— 说明它不在酒馆里面。
echo.
echo   请把**酒馆的根目录**（里面有 config.yaml 和 plugins 的那一层）拖到本文件上。
echo.
goto :end

:no_arg
echo.
echo   ⛔ 没能自动认出酒馆目录。
echo.
echo   用法（二选一）：
echo     · 双击本文件 —— 只要这个扩展是装在酒馆里的，脚本会自己往上找；
echo     · 或者把**酒馆的根目录**拖到本文件上。
echo.
echo   酒馆根目录 = 里面有 config.yaml 和 plugins 文件夹的那一层。
echo.

rem ── ④ 唯一的出口：一定停住，窗口不闪退 ──────────────────────────────────────
:end
echo   （日志：%LOG%）
echo.
echo [%date% %time%] 结束；最终酒馆目录="%ST%"；退出码=%RC% >> "%LOG%" 2>nul
pause
endlocal & exit /b %RC%
