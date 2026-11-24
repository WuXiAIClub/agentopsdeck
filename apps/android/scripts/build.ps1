param(
    [string]$SourceRoot = (Resolve-Path "$PSScriptRoot\..\..\..").Path,
    [string]$AndroidSdk = "$env:LOCALAPPDATA\Android\Sdk",
    [string]$JavaHome = 'C:\Program Files\Android\Android Studio\jbr',
    [switch]$SkipWeb,
    [switch]$Release
)
$ErrorActionPreference = 'Stop'
$AndroidRoot = (Resolve-Path "$PSScriptRoot\..").Path
$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidSdk
$env:PATH = "$JavaHome\bin;$env:PATH"
if (!$SkipWeb) {
    node "$PSScriptRoot\prepare-web.mjs" $SourceRoot
    if ($LASTEXITCODE -ne 0) { throw 'Frontend preparation failed' }
} elseif (!(Test-Path "$AndroidRoot\app\src\main\assets\web\android-build.json")) {
    throw 'Prepare the frontend before using -SkipWeb.'
}
Push-Location $AndroidRoot
try {
    $tasks = @('testDebugUnitTest', 'assembleDebug', 'assembleDebugAndroidTest')
    if ($Release) { $tasks += 'assembleRelease' }
    & .\gradlew.bat --no-daemon --max-workers=1 @tasks
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed' }
    if ($Release) { & "$PSScriptRoot\sign-release.ps1" -Sdk $AndroidSdk -JavaHome $JavaHome }
} finally { Pop-Location }
