[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDirectory = Join-Path $ProjectRoot '.runtime'
$PidFile = Join-Path $RuntimeDirectory 'vite.pid'
$PortFile = Join-Path $RuntimeDirectory 'vite.port'

if (-not (Test-Path $PidFile)) {
  Write-Host 'لا توجد عملية مسجلة لمحطة عين الصقر.' -ForegroundColor Yellow
  exit 0
}

$pidText = (Get-Content -Raw $PidFile).Trim()
if ($pidText -notmatch '^\d+$') {
  Remove-Item $PidFile, $PortFile -Force -ErrorAction SilentlyContinue
  Write-Host 'تم حذف بيانات تشغيل تالفة.' -ForegroundColor Yellow
  exit 0
}

$process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
if ($null -ne $process) {
  Stop-Process -Id $process.Id -Force
  try { Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue } catch {}
  Write-Host 'تم إيقاف محطة عين الصقر.' -ForegroundColor Green
} else {
  Write-Host 'العملية كانت متوقفة مسبقاً.' -ForegroundColor Yellow
}

Remove-Item $PidFile, $PortFile -Force -ErrorAction SilentlyContinue
