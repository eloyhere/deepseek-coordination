@echo off
rem dsh-os.bat - Windows entry point for the dsh-os atomic command surface.
rem
rem This file is deliberately ASCII-only: cmd.exe reads it in the OEM code page, so any non-ASCII
rem byte here would be mangled before the real implementation ever runs. All logic lives in
rem dsh-os.ps1, which is saved as UTF-8 with BOM so Windows PowerShell 5.1 parses it correctly.
rem
rem %* forwards the arguments with their quotes intact, so a value containing spaces stays one
rem argument. Callers that can pass an argv array (the harness, Node's execFile, CI) should invoke
rem dsh-os.ps1 directly and skip cmd.exe entirely.
setlocal
chcp 65001 >nul 2>nul
set "DSH_OS_PS1=%~dp0dsh-os.ps1"
if not exist "%DSH_OS_PS1%" (
  echo {"ok":false,"verb":null,"error":{"code":"E_INTERNAL","message":"dsh-os.ps1 not found next to dsh-os.bat"}}
  exit /b 7
)
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%DSH_OS_PS1%" %*
exit /b %ERRORLEVEL%
