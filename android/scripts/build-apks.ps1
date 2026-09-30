param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\.." )).Path
$androidRoot = Join-Path $repoRoot "android"
$privateRoot = Join-Path $repoRoot ".codex"
$artifactRoot = Join-Path $privateRoot "artifacts"
$keystorePath = Join-Path $privateRoot "Neko-Spark-release.jks"
$signingEnvPath = Join-Path $privateRoot "Neko-Spark-release.env"

New-Item -ItemType Directory -Force -Path $privateRoot, $artifactRoot | Out-Null

function Get-JavaMajor([string]$javaHome) {
    $javaExe = Join-Path $javaHome "bin\java.exe"
    if (-not (Test-Path $javaExe)) { return 0 }
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $versionOutput = (& $javaExe -version 2>&1 | Out-String)
    $ErrorActionPreference = $previousErrorAction
    if ($versionOutput -match 'version "([0-9]+)') { return [int]$Matches[1] }
    return 0
}

$javaHome = $env:JAVA_HOME
if ((Get-JavaMajor $javaHome) -lt 17) {
    $androidStudioJava = 'C:\Program Files\Android\Android Studio\jbr'
    if ((Get-JavaMajor $androidStudioJava) -ge 17) {
        $javaHome = $androidStudioJava
    }
}
if ((Get-JavaMajor $javaHome) -lt 17) {
    throw "需要 JDK 17 或更高版本。请设置 JAVA_HOME，或安装 Android Studio 的 JBR。"
}
$env:JAVA_HOME = $javaHome

$sdkRoot = $env:ANDROID_SDK_ROOT
if ([string]::IsNullOrWhiteSpace($sdkRoot)) { $sdkRoot = $env:ANDROID_HOME }
if ([string]::IsNullOrWhiteSpace($sdkRoot)) { $sdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path (Join-Path $sdkRoot 'platforms\android-34'))) {
    throw "找不到 Android SDK 34：$sdkRoot"
}
$env:ANDROID_SDK_ROOT = $sdkRoot
$sdkProperty = $sdkRoot.Replace('\', '/')
Set-Content -Path (Join-Path $androidRoot 'local.properties') -Value "sdk.dir=$sdkProperty" -Encoding ascii

$gradle = (Get-Command gradle -ErrorAction SilentlyContinue).Source
$gradleHome = Join-Path $privateRoot 'gradle-8.9'
$gradleExe = Join-Path $gradleHome 'bin\gradle.bat'
if ([string]::IsNullOrWhiteSpace($gradle)) {
    if (-not (Test-Path $gradleExe)) {
        $gradleZip = Join-Path $privateRoot 'gradle-8.9-bin.zip'
        Write-Host "下载 Gradle 8.9 到 .codex..."
        Invoke-WebRequest -Uri "https://services.gradle.org/distributions/gradle-8.9-bin.zip" -OutFile $gradleZip
        Expand-Archive -LiteralPath $gradleZip -DestinationPath $privateRoot -Force
        Remove-Item -LiteralPath $gradleZip -Force
    }
    $gradle = $gradleExe
}

function Read-LocalSigningEnv {
    if (-not (Test-Path $signingEnvPath)) { return }
    foreach ($line in Get-Content $signingEnvPath) {
        if ($line -match '^([A-Z0-9_]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
        }
    }
}

Read-LocalSigningEnv
$env:ANDROID_KEYSTORE_PATH = if ($env:ANDROID_KEYSTORE_PATH) { $env:ANDROID_KEYSTORE_PATH } else { $keystorePath }
$env:ANDROID_KEY_ALIAS = if ($env:ANDROID_KEY_ALIAS) { $env:ANDROID_KEY_ALIAS } else { "neko-spark-release" }

if (-not (Test-Path $env:ANDROID_KEYSTORE_PATH)) {
    $keytool = Join-Path $javaHome 'bin\keytool.exe'
    if (-not (Test-Path $keytool)) { throw "JDK 17 中找不到 keytool.exe。" }
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    Write-Host "生成本机 release keystore（只保存到 .codex，不会进入 Git）..."
    & $keytool -genkeypair -v -keystore $env:ANDROID_KEYSTORE_PATH `
        -storetype PKCS12 -storepass $password -keypass $password `
        -alias $env:ANDROID_KEY_ALIAS -keyalg EC -groupname secp256r1 `
        -validity 10000 -dname "CN=Neko_Spark Release, OU=Local, O=Neko_Spark, C=CN" -noprompt
    if ($LASTEXITCODE -ne 0) { throw "生成 release keystore 失败。" }
    $env:ANDROID_KEYSTORE_PASSWORD = $password
    $env:ANDROID_KEY_PASSWORD = $password
    @(
        "ANDROID_KEYSTORE_PATH=$env:ANDROID_KEYSTORE_PATH"
        "ANDROID_KEYSTORE_PASSWORD=$password"
        "ANDROID_KEY_ALIAS=$env:ANDROID_KEY_ALIAS"
        "ANDROID_KEY_PASSWORD=$password"
    ) | Set-Content -Path $signingEnvPath -Encoding utf8
}

if ([string]::IsNullOrWhiteSpace($env:ANDROID_KEYSTORE_PASSWORD) -or [string]::IsNullOrWhiteSpace($env:ANDROID_KEY_PASSWORD)) {
    throw "正式签名缺少密码。请设置 ANDROID_KEYSTORE_PASSWORD 和 ANDROID_KEY_PASSWORD。"
}

if ($Clean) {
    & $gradle -p $androidRoot clean --no-daemon --console=plain
    if ($LASTEXITCODE -ne 0) { throw "清理 Android 构建失败。" }
}

& $gradle -p $androidRoot assembleDebugAppDebug assembleFormalAppRelease --no-daemon --stacktrace --console=plain
if ($LASTEXITCODE -ne 0) { throw "debug/release APK 构建失败。" }

$debugApk = Join-Path $androidRoot "app\build\outputs\apk\debugApp\debug\app-debugApp-debug.apk"
$releaseApk = Join-Path $androidRoot "app\build\outputs\apk\formalApp\release\app-formalApp-release.apk"
if (-not (Test-Path $debugApk) -or -not (Test-Path $releaseApk)) {
    throw "构建完成但没有找到两个 APK。"
}

$buildTools = Get-ChildItem (Join-Path $sdkRoot "build-tools") -Directory |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"
if (-not (Test-Path $apksigner)) { $apksigner = Join-Path $buildTools.FullName "apksigner" }
foreach ($apk in @($debugApk, $releaseApk)) {
    & $apksigner verify --print-certs $apk
    if ($LASTEXITCODE -ne 0) { throw "APK 签名验证失败：$apk" }
}

$debugOutput = Join-Path $artifactRoot "Neko_Spark-android-debug.apk"
$releaseOutput = Join-Path $artifactRoot "Neko_Spark-android-release.apk"
Copy-Item $debugApk $debugOutput -Force
Copy-Item $releaseApk $releaseOutput -Force

Write-Host "已生成：$debugOutput"
Write-Host "已生成：$releaseOutput"
Write-Host "正式包名：com.gallerymirror.jiuerya"
Write-Host "Debug 包名：com.gallerymirror.jiuerya_debug"
Write-Host "SHA-256："
Get-FileHash $debugOutput, $releaseOutput -Algorithm SHA256 | Format-Table -AutoSize
