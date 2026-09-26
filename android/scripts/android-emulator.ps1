# 启动安卓模拟器（已配置好加速驱动 AEHD）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\android-emulator.ps1

$ErrorActionPreference = "Stop"
$sdk = "D:\Android\Sdk"
$avd = if ($args.Count -gt 0) { $args[0] } else { "gmtest" }

if (-not (Test-Path "$sdk\emulator\emulator.exe")) {
    Write-Error "找不到模拟器，请先安装 SDK 的 emulator 包"
    exit 1
}

$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_AVD_HOME = "D:\Android\avd"
$env:HOME = $env:USERPROFILE

Write-Host "启动模拟器 AVD=$avd （首次启动约 1-2 分钟）..."
& "$sdk\emulator\emulator.exe" -avd $avd -no-snapshot -no-audio -no-boot-anim -gpu auto
