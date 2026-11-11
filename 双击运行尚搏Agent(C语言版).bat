@echo off
chcp 65001 >nul
title 尚搏 Agent (C语言核心引擎)
cd /d "%~dp0c-core\bin"

if not exist "shangbo_agent.exe" (
    echo [提示] 未找到 shangbo_agent.exe，正在自动编译...
    cd /d "%~dp0c-core"
    call build.bat
    cd /d "%~dp0c-core\bin"
)

cls
shangbo_agent.exe repl
