# 构建 → 安装 → 自动跑一次备份或恢复（模拟器）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\android-test.ps1
# 可选参数：-Hub http://10.0.2.2:8787   -NoRun（只构建安装）
#           -Restore（跑一次"从电脑恢复"）  -Mode merge|new   -Folder 新文件夹名字

param(
    [string]$Hub = "http://10.0.2.2:8787",
    [switch]$NoRun,
    [switch]$Restore,
    [string]$Mode = "merge",
    [string]$Folder = ""
)

$ErrorActionPreference = "Stop"
$sdk = "D:\Android\Sdk"
$gradle = "D:\Android\gradle-8.9\bin\gradle.bat"
# 本脚本现在位于 <仓库>/android/scripts/，".." 就是安卓工程根
$project = Join-Path $PSScriptRoot ".."
$apk = Join-Path $project "app\build\outputs\apk\debug\app-debug.apk"
$adb = "$sdk\platform-tools\adb.exe"

$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot"

Write-Host "[1/3] 构建 APK..."
& $gradle -p $project assembleDebug | Select-Object -Last 2

Write-Host "[2/3] 安装到设备..."
& $adb install -r $apk | Select-Object -Last 1

if ($NoRun) {
    Write-Host "完成（未运行）"
    exit 0
}

if ($Restore) {
    Write-Host "[3/3] 自动执行一次恢复（Hub=$Hub，方式=$Mode，文件夹=$Folder）..."
    & $adb shell am force-stop com.gallerymirror.app
    $restoreArgs = @(
        "shell", "am", "start", "-n", "com.gallerymirror.app/.MainActivity",
        "--ez", "restore", "true", "--es", "restoremode", $Mode, "--es", "hub", $Hub
    )
    if ($Folder) { $restoreArgs += @("--es", "restorefolder", $Folder) }
    & $adb @restoreArgs | Out-Null
    Write-Host "已触发，可在模拟器里查看进度"
} else {
    Write-Host "[3/3] 自动执行一次备份（Hub=$Hub）..."
    & $adb shell am force-stop com.gallerymirror.app
    & $adb shell am start -n com.gallerymirror.app/.MainActivity --ez autorun true --es hub $Hub | Out-Null
    Write-Host "已触发，可在模拟器里查看进度"
}
