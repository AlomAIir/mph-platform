@echo off
rem Connects this folder to your Supabase project. You sign in and type your own password; nothing is shared.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"

echo.
echo === Step 1 of 2: sign in to Supabase ===
echo A browser window will open. Approve the sign-in, then come back here.
echo.
call npx supabase login
if errorlevel 1 goto fail

echo.
echo === Step 2 of 2: link your project ===
echo In the Supabase dashboard: your project ^> Project Settings ^> General ^> Reference ID
set /p REF=Paste the Reference ID here and press Enter:
echo.
echo When asked, type the DATABASE PASSWORD you chose when creating the project.
echo (Nothing shows on screen while you type. That's normal.)
call npx supabase link --project-ref %REF%
if errorlevel 1 goto fail

echo.
echo ============================================
echo  Done. Go back to Claude and say "done".
echo ============================================
pause
exit /b 0

:fail
echo.
echo Something went wrong above. Copy the message and send it to Claude.
pause
exit /b 1
