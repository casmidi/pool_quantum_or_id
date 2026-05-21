@echo off
title Meridian Stack

echo.
echo  ============================================
echo   Meridian Bot Stack - Starting All Services
echo  ============================================
echo.

echo  [1/2] Starting Dry-Scan (1000 SOL preview)...
start "Dry Scan" cmd /k "cd /d D:\meridian-bot && node scripts\dry-scan.js --sol 1000 --top 15"
timeout /t 1 /nobreak ^>nul

echo  [2/2] Starting Meridian Bot...
start "Meridian Bot" cmd /k "cd /d D:\meridian-bot && node index.js"

echo.
echo  All services launched in separate windows.
echo  Dashboard : built-in (lihat Telegram atau Meridian Bot window)
echo  Bot logs  : see Meridian Bot window
echo.
pause
