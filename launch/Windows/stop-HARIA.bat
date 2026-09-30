@echo off
REM Stop the HARIA container (Windows).
cd /d "%~dp0..\.."
docker compose --profile record down 2>nul
docker compose down
