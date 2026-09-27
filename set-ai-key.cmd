@echo off
rem Stores your Anthropic API key as a secret on the Supabase AI service. The key goes straight to Supabase;
rem it is not saved in this folder, not put in the website, and not shared with anyone.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"

echo.
echo === Store your Anthropic API key on the AI service ===
echo Create one at https://console.anthropic.com  (API Keys ^> Create Key). It starts with sk-ant-
echo.
set /p KEY=Paste your Anthropic API key and press Enter:
if "%KEY%"=="" goto fail
call npx supabase secrets set ANTHROPIC_API_KEY=%KEY%
set KEY=
if errorlevel 1 goto fail
cls
echo.
echo ============================================
echo  Saved. Go back to Claude and say "key done".
echo ============================================
pause
exit /b 0

:fail
set KEY=
echo.
echo The key was not saved. Copy any message above and send it to Claude (never the key itself).
pause
exit /b 1
