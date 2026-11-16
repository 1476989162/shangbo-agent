@echo off
setlocal enabledelayedexpansion

echo [Shangbo Agent C-Core] Building project...

where cl >nul 2>nul
if %errorlevel% neq 0 (
    echo [Shangbo Agent C-Core] Initializing MSVC x64 build environment...
    call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
)

if not exist bin mkdir bin
if not exist obj mkdir obj

set CFLAGS=/nologo /O2 /W3 /D_CRT_SECURE_NO_WARNINGS /Iinclude /utf-8
set SRCS=src\safety.c src\command_guard.c src\injection_detector.c src\loop_guard.c src\stream_processor.c src\tools.c src\agent_runtime.c src\json_rpc.c src\native_process.c

echo [Shangbo Agent C-Core] Compiling shangbo_agent CLI...
cl %CFLAGS% /Fe:bin\shangbo_agent.exe src\main.c %SRCS% /Fo:obj\
if %errorlevel% neq 0 (
    echo [ERROR] Compilation of shangbo_agent CLI failed.
    exit /b %errorlevel%
)

echo [Shangbo Agent C-Core] Compiling test_runner...
cl %CFLAGS% /Fe:bin\test_runner.exe tests\test_runner.c tests\test_safety.c tests\test_command_guard.c tests\test_injection.c tests\test_stream_processor.c tests\test_loop_guard.c tests\test_tools.c tests\test_agent_runtime.c tests\test_json_rpc.c %SRCS% /Fo:obj\
if %errorlevel% neq 0 (
    echo [ERROR] Compilation of test_runner failed.
    exit /b %errorlevel%
)

echo [Shangbo Agent C-Core] Running C test suite...
bin\test_runner.exe
if %errorlevel% neq 0 (
    echo [ERROR] One or more C tests failed.
    exit /b %errorlevel%
)

echo [Shangbo Agent C-Core] Build and verification SUCCESS!
