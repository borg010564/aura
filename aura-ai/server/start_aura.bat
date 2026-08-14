@echo off
REM Starts the Aura server. Run this by hand, or let the scheduled task
REM "AuraServer" launch it automatically at logon (see README).
REM
REM The working directory matters: .env points AURA_SSL_CERT/KEY at cert.pem and
REM key.pem relative to this folder, so we cd here first.
cd /d "%~dp0"
title Aura server
python app.py
REM Keep the window open if it exits unexpectedly, so the error is readable.
if errorlevel 1 pause
