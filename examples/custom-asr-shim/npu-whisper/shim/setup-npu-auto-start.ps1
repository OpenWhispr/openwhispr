# OpenWhispr NPU Whisper Shim - Auto-start Setup
# Run this script AS ADMINISTRATOR to register the scheduled task
#   Right-click PowerShell -> Run as Administrator
#   Then: .\setup-npu-auto-start.ps1

$ErrorActionPreference = "Stop"

$taskName = "OpenWhispr-NPU-Shim"
$batchPath = "$env:APPDATA\open-whispr\models\npu-whisper\launch-npu-shim.bat"

Write-Host "============================================"
Write-Host " OpenWhispr NPU Whisper - Auto-Start Setup"
Write-Host "============================================"
Write-Host ""

# Prerequisite check
if (-not (Test-Path $batchPath)) {
    Write-Error "Launcher not found: $batchPath"
    Write-Error "Ensure Phase 1 & 2 are complete first."
    exit 1
}

# Remove old task if exists
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing old scheduled task..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}

# Create new task
Write-Host "Creating scheduled task: $taskName"
$action = New-ScheduledTaskAction -Execute $batchPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 2) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -DisallowDemandStart:$false

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

$task = Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "OpenWhispr NPU Whisper shim - starts whisper-large-v3-turbo on Intel AI Boost NPU at login" `
    -Force

Write-Host "Task registered: $taskName"
Write-Host ""

# Run it now to test
Write-Host "Starting the server now..."
Start-ScheduledTask -TaskName $taskName
Write-Host "Waiting for pipeline to load (will take ~5s from cache, or 4min first time)..."
Start-Sleep -Seconds 20

# Verify
try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -Method Get -TimeoutSec 10
    Write-Host "SUCCESS: NPU server is running!"
    Write-Host "  Status: $($response | ConvertTo-Json -Compress)"
} catch {
    Write-Host "WARNING: Server not reachable yet. It might still be loading."
    Write-Host "Run this later to check: Invoke-RestMethod http://127.0.0.1:8765/health"
}

Write-Host ""
Write-Host "============================================"
Write-Host " Setup Complete!"
Write-Host "============================================"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open OpenWhispr"
Write-Host "  2. Settings -> Speech to Text"
Write-Host "  3. Select 'Self-hosted server'"
Write-Host "  4. Server URL: http://localhost:8765"
Write-Host "  5. Save and test dictation"
Write-Host ""
Write-Host "The NPU server will now start automatically"
Write-Host "when you log into Windows."
