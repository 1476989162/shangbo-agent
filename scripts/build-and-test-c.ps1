# Shangbo Agent C-Core Build & Test Script
$ErrorActionPreference = "Stop"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Building and Testing Shangbo Agent C-Core Engine   " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$cCoreDir = Join-Path $PSScriptRoot "..\c-core"
Set-Location $cCoreDir

& cmd.exe /c "build.bat"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Shangbo Agent C-Core build or test failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "Shangbo Agent C-Core build and test passed successfully!" -ForegroundColor Green
