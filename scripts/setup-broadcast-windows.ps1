[CmdletBinding()]
param(
  [switch]$InstallOllama,
  [switch]$SkipStart,
  [switch]$SkipUpdate,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Branch = 'broadcast-station-mvp'

function Write-Stage([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Ensure-WingetPackage([string]$Command, [string]$PackageId, [string]$DisplayName) {
  if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "$DisplayName غير مثبت، وwinget غير متوفر للتثبيت التلقائي. ثبّت $DisplayName ثم أعد التشغيل."
  }
  Write-Stage "تثبيت $DisplayName"
  & winget.exe install --id $PackageId --exact --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "فشل تثبيت $DisplayName برمز $LASTEXITCODE" }
  Refresh-Path
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "تم تثبيت $DisplayName لكن الأمر لم يظهر في PATH. أغلق النافذة وافتحها ثم شغّل الملف مجدداً."
  }
}

Write-Host 'عين الصقر — إعداد الحاسوب الجديد' -ForegroundColor Yellow
Refresh-Path

Ensure-WingetPackage 'git.exe' 'Git.Git' 'Git'
Ensure-WingetPackage 'node.exe' 'OpenJS.NodeJS.LTS' 'Node.js LTS'

$nodeVersionText = (& node.exe --version).Trim().TrimStart('v')
$nodeMajor = [int]($nodeVersionText.Split('.')[0])
if ($nodeMajor -lt 22) {
  throw "إصدار Node.js الحالي $nodeVersionText قديم. ثبّت Node.js LTS 22 أو 24."
}
Write-Host "Node.js: $nodeVersionText" -ForegroundColor Green
Write-Host "Git: $((& git.exe --version).Trim())" -ForegroundColor Green

Set-Location $ProjectRoot
if (-not (Test-Path (Join-Path $ProjectRoot '.git'))) {
  throw 'هذا الملف يجب تشغيله من داخل نسخة Git لمشروع worldmonitor.'
}

if (-not $SkipUpdate) {
  Write-Stage 'تحديث الفرع الصحيح من GitHub'
  $dirty = (& git.exe status --porcelain)
  if ($dirty) {
    Write-Warning 'توجد تعديلات محلية؛ لن أنفذ pull حتى لا تضيع. سيتم متابعة التثبيت بالنسخة الحالية.'
  } else {
    & git.exe fetch origin
    if ($LASTEXITCODE -ne 0) { throw 'فشل git fetch.' }
    & git.exe checkout $Branch
    if ($LASTEXITCODE -ne 0) { throw "فشل الانتقال إلى $Branch." }
    & git.exe pull --ff-only origin $Branch
    if ($LASTEXITCODE -ne 0) { throw 'فشل تحديث الفرع بطريقة آمنة.' }
  }
}

if ($ValidateOnly) {
  Write-Host 'نجح فحص أدوات وملفات الإعداد.' -ForegroundColor Green
  exit 0
}

Write-Stage 'تثبيت مكتبات المشروع المطابقة لـ package-lock.json'
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw "فشل npm ci برمز $LASTEXITCODE" }

$envFile = Join-Path $ProjectRoot '.env.local'
if (-not (Test-Path $envFile)) {
  @"
# عين الصقر — إعدادات التطوير المحلي
DEV_PORT=3000

# مزود ترجمة مركزي اختياري متوافق مع OpenAI Chat Completions
# BROADCAST_TRANSLATION_BASE_URL=https://provider.example/v1
# BROADCAST_TRANSLATION_API_KEY=
# BROADCAST_TRANSLATION_MODEL=

# تخزين دائم اختياري للنشر متعدد الخوادم
# UPSTASH_REDIS_REST_URL=
# UPSTASH_REDIS_REST_TOKEN=
"@ | Set-Content -Path $envFile -Encoding UTF8
  Write-Host 'تم إنشاء .env.local.' -ForegroundColor Green
}

if ($InstallOllama) {
  if (-not (Get-Command ollama.exe -ErrorAction SilentlyContinue)) {
    Write-Stage 'تثبيت Ollama من المصدر الرسمي'
    Invoke-Expression (Invoke-RestMethod 'https://ollama.com/install.ps1')
    Refresh-Path
  }
  if (-not (Get-Command ollama.exe -ErrorAction SilentlyContinue)) {
    throw 'تعذر العثور على Ollama بعد التثبيت. أعد فتح PowerShell ثم نفذ ollama pull qwen2.5:7b.'
  }
  [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', 'http://localhost:3000,http://127.0.0.1:3000', 'User')
  $env:OLLAMA_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000'
  Write-Stage 'تنزيل نموذج الترجمة العربية المحلي'
  & ollama.exe pull qwen2.5:7b
  if ($LASTEXITCODE -ne 0) { throw 'فشل تنزيل نموذج qwen2.5:7b.' }
}

Write-Stage 'إنشاء اختصارات التشغيل على سطح المكتب'
$desktop = [Environment]::GetFolderPath('Desktop')
$wsh = New-Object -ComObject WScript.Shell
foreach ($shortcutDefinition in @(
  @{ Name = 'تشغيل عين الصقر.lnk'; Target = (Join-Path $ProjectRoot 'START-AIN-SAQR.cmd') },
  @{ Name = 'إيقاف عين الصقر.lnk'; Target = (Join-Path $ProjectRoot 'STOP-AIN-SAQR.cmd') }
)) {
  $shortcut = $wsh.CreateShortcut((Join-Path $desktop $shortcutDefinition.Name))
  $shortcut.TargetPath = $shortcutDefinition.Target
  $shortcut.WorkingDirectory = $ProjectRoot
  $shortcut.Save()
}

Write-Host "`nاكتمل الإعداد بنجاح." -ForegroundColor Green
if (-not $SkipStart) {
  & (Join-Path $PSScriptRoot 'start-broadcast-windows.ps1')
}
