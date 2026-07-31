[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [switch]$NoBrowser,
  [switch]$OpenViewer,
  [switch]$SkipDoctor
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDirectory = Join-Path $ProjectRoot '.runtime'
$PidFile = Join-Path $RuntimeDirectory 'vite.pid'
$PortFile = Join-Path $RuntimeDirectory 'vite.port'
$StationFile = Join-Path $RuntimeDirectory 'station-id.txt'
$OutLog = Join-Path $RuntimeDirectory 'server.out.log'
$ErrorLog = Join-Path $RuntimeDirectory 'server.error.log'

function Write-Stage([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Test-PortAvailable([int]$Candidate) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Candidate)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $listener) { $listener.Stop() }
  }
}

function Test-StationServer([int]$Candidate) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Candidate/broadcast/" -TimeoutSec 3
    return $response.StatusCode -eq 200 -and $response.Content -match 'aynBroadcastViewer'
  } catch {
    return $false
  }
}

function Wait-StationServer([int]$Candidate, [int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-StationServer $Candidate) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-StableStationId {
  if (Test-Path $StationFile) {
    $stored = (Get-Content -Raw $StationFile).Trim().ToLowerInvariant()
    if ($stored -match '^ayn-[a-z0-9-]{8,44}$') { return $stored }
  }
  $token = ([Guid]::NewGuid().ToString('N')).Substring(0, 16)
  $station = "ayn-$token"
  Set-Content -Path $StationFile -Value $station -Encoding UTF8
  return $station
}

Refresh-Path
Set-Location $ProjectRoot
New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw 'Node.js غير مثبت. شغّل INSTALL-AIN-SAQR.cmd أولاً.'
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw 'npm غير متوفر مع Node.js. أعد تثبيت Node.js LTS.'
}

if (-not (Test-Path (Join-Path $ProjectRoot 'node_modules\vite\bin\vite.js'))) {
  Write-Stage 'تثبيت مكتبات المشروع لأول تشغيل'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw "فشل npm ci برمز $LASTEXITCODE" }
}

$existingPort = $null
if (Test-Path $PortFile) {
  $candidateText = (Get-Content -Raw $PortFile).Trim()
  if ($candidateText -match '^\d+$') {
    $candidatePort = [int]$candidateText
    if (Test-StationServer $candidatePort) { $existingPort = $candidatePort }
  }
}

if ($null -ne $existingPort) {
  $Port = $existingPort
  Write-Host "المحطة تعمل مسبقاً على المنفذ $Port." -ForegroundColor Green
} else {
  if (Test-Path $PidFile) {
    $oldPidText = (Get-Content -Raw $PidFile).Trim()
    if ($oldPidText -match '^\d+$') {
      $oldProcess = Get-Process -Id ([int]$oldPidText) -ErrorAction SilentlyContinue
      if ($null -ne $oldProcess) {
        Stop-Process -Id $oldProcess.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
      }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }

  while (-not (Test-PortAvailable $Port)) {
    $Port += 1
    if ($Port -gt 3020) { throw 'لم أجد منفذاً متاحاً بين 3000 و3020.' }
  }

  Write-Stage "تشغيل محطة عين الصقر على المنفذ $Port"
  Remove-Item $OutLog, $ErrorLog -Force -ErrorAction SilentlyContinue
  $nodePath = (Get-Command node.exe).Source
  $vitePath = Join-Path $ProjectRoot 'node_modules\vite\bin\vite.js'
  $process = Start-Process \
    -FilePath $nodePath \
    -ArgumentList @($vitePath, '--host', '0.0.0.0', '--port', [string]$Port, '--strictPort') \
    -WorkingDirectory $ProjectRoot \
    -RedirectStandardOutput $OutLog \
    -RedirectStandardError $ErrorLog \
    -WindowStyle Hidden \
    -PassThru

  Set-Content -Path $PidFile -Value $process.Id -Encoding ASCII
  Set-Content -Path $PortFile -Value $Port -Encoding ASCII

  if (-not (Wait-StationServer $Port)) {
    $details = if (Test-Path $ErrorLog) { Get-Content -Raw $ErrorLog } else { 'لا يوجد سجل خطأ.' }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "لم تبدأ المحطة خلال المهلة.`n$details"
  }
}

$station = Get-StableStationId
$baseUrl = "http://127.0.0.1:$Port"
$controlUrl = "$baseUrl/control/?station=$station&lang=ar"
$viewerUrl = "$baseUrl/broadcast/?station=$station&lang=ar"

if (-not $SkipDoctor) {
  Write-Stage 'فحص المسارات والمزامنة والشريط'
  & node.exe (Join-Path $ProjectRoot 'scripts\broadcast-doctor.mjs') --base $baseUrl
  if ($LASTEXITCODE -ne 0) {
    throw 'فشل فحص المحطة. راجع السجل داخل مجلد .runtime.'
  }
}

Write-Host "`nالمحطة جاهزة!" -ForegroundColor Green
Write-Host "غرفة التحكم: $controlUrl" -ForegroundColor Yellow
Write-Host "شاشة المشاهد: $viewerUrl" -ForegroundColor Yellow
Write-Host "سجل التشغيل: $OutLog"
Write-Host "سجل الأخطاء: $ErrorLog"

try {
  $lanAddress = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object {
      $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and
      $_.PrefixOrigin -ne 'WellKnown' -and
      $_.AddressState -eq 'Preferred'
    } |
    Select-Object -First 1 -ExpandProperty IPAddress
  if ($lanAddress) {
    Write-Host "رابط المشاهد داخل الشبكة: http://${lanAddress}:$Port/broadcast/?station=$station&lang=ar" -ForegroundColor Magenta
  }
} catch {
  # عرض رابط localhost يكفي عند تعذر تحديد عنوان الشبكة.
}

if (-not $NoBrowser) {
  Start-Process $controlUrl
  if ($OpenViewer) { Start-Process $viewerUrl }
}
