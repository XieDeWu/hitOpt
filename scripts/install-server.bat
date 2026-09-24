@echo off
chcp 65001 >nul
setlocal
title hitOpt 服务端安装

rem ══════════════════════════════════════════════════════════════════════════
rem  hitOpt 服务端插件 —— 一键部署
rem
rem  为什么需要这个脚本（酒馆的机制，不是这个插件特殊）：
rem    酒馆那个「扩展程序 → 安装扩展程序 → 输入 Git URL」入口，只会把仓库 clone 到
rem      public/scripts/extensions/third-party/<仓库名>/
rem    而服务端插件的加载器（src/plugin-loader.js）只读 <酒馆>/plugins/ 这一层，
rem      **没有任何下载或市场机制**。
rem    ⇒ 所以服务端必须有人把它放进 plugins/ 一次。这个脚本就是那"一次"。
rem
rem  它做什么：只把两个 .mjs 复制过去。
rem  ⛔ 它**绝不删除、绝不覆盖**插件目录里的数据（_gitlog / captures / _tokcache / _errlog）。
rem ══════════════════════════════════════════════════════════════════════════

set "SRC=%~dp0..\server"
set "ST=%~1"

if "%ST%"=="" (
    echo.
    echo   用法：把**酒馆的根目录**拖到这个 bat 文件上，
    echo         或者在命令行里写：install-server.bat "D:\AI\SillyTavern"
    echo.
    echo   酒馆根目录 = 里面有 config.yaml 和 plugins 文件夹的那一层。
    echo.
    pause
    exit /b 1
)

if not exist "%ST%\config.yaml" (
    echo.
    echo   ⚠ "%ST%" 看起来不是酒馆根目录（没找到 config.yaml）。
    echo     请确认你拖的是**酒馆根目录**，不是 plugins 或 data。
    echo.
    pause
    exit /b 1
)

set "DST=%ST%\plugins\hitopt-git"

echo.
echo   源  ：%SRC%
echo   目标：%DST%
echo.

if not exist "%SRC%\index.mjs" (
    echo   ⛔ 找不到 %SRC%\index.mjs —— 这个 bat 必须和 server 文件夹在一起。
    pause
    exit /b 1
)

if not exist "%DST%" (
    mkdir "%DST%"
    echo   新建了插件目录。
) else (
    echo   插件目录已存在（会覆盖里面的两个 .mjs，**不动任何数据**）。
)

rem ⚠ 只覆盖这两个文件 —— 插件目录里的 _gitlog / captures 等数据一个都不碰。
copy /Y "%SRC%\index.mjs"   "%DST%\index.mjs"   >nul
copy /Y "%SRC%\wiretap.mjs" "%DST%\wiretap.mjs" >nul

if errorlevel 1 (
    echo.
    echo   ⛔ 复制失败。可能是酒馆正在运行占用了文件 —— 先关掉酒馆再试一次。
    echo.
    pause
    exit /b 1
)

echo   ✓ index.mjs   已部署
echo   ✓ wiretap.mjs 已部署
echo.
echo   ────────────────────────────────────────────────
echo    还差两步：
echo      1. 确认 config.yaml 里有  enableServerPlugins: true
echo      2. **重启酒馆**（服务端插件只在启动时加载）
echo   ────────────────────────────────────────────────
echo.
pause
