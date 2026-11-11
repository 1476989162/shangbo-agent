@echo off
chcp 65001 >nul
title 启动尚搏 Agent GUI 桌面端
cd /d "%~dp0release\win-unpacked"

if not exist "尚搏 Agent.exe" (
    echo [提示] 未找到打包产物，正在启动开发态 GUI...
    cd /d "%~dp0"
    npm run dev
    exit /b
)

start "" "%~dp0release\win-unpacked\尚搏 Agent.exe"
