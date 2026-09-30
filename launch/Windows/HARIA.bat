@echo off
REM HARIA - Windows launcher. Double-click to start the dashboard.
REM One-time prerequisite: Docker Desktop (this checks and guides you if missing).
setlocal enabledelayedexpansion
cd /d "%~dp0..\.."

where docker >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[void][System.Windows.Forms.MessageBox]::Show('Docker Desktop is not installed. I''ll open the download page - install it, then run HARIA again.')"
  start https://www.docker.com/products/docker-desktop/
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms;[void][System.Windows.Forms.MessageBox]::Show('Docker Desktop is installed but not running. Start it, wait until it is ready, then run HARIA again.')"
  exit /b 1
)

if not exist .env (
  REM Return the picked path with forward slashes — a Windows path like
  REM C:\Users\me would break the compose "path:/data" volume (the drive colon).
  for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description='Choose your folder of rosbags'; if($f.ShowDialog() -eq 'OK'){$f.SelectedPath -replace '\\','/'}"`) do set "BAGSDIR=%%F"
  if not defined BAGSDIR exit /b 0
  > .env echo BAGS=!BAGSDIR!
)

docker compose pull
docker compose up -d

powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{Invoke-WebRequest -UseBasicParsing http://localhost:8000 -TimeoutSec 1 | Out-Null; break}catch{Start-Sleep -Seconds 1}}"
start http://localhost:8000
endlocal
