param(
    [string]$Sdk = "$env:LOCALAPPDATA\Android\Sdk",
    [string]$JavaHome = 'C:\Program Files\Android\Android Studio\jbr',
    [string]$UnsignedApk = "$PSScriptRoot\..\app\build\outputs\apk\release\app-release-unsigned.apk",
    [string]$Output = "$PSScriptRoot\..\app\build\outputs\apk\release\agentopsdeck-android-0.2.3.apk"
)
$ErrorActionPreference = 'Stop'
$versionPolicy = Get-Content -LiteralPath "$PSScriptRoot\..\VERSION-POLICY.json" -Raw | ConvertFrom-Json
if (-not $versionPolicy.releaseApproved -or -not $versionPolicy.sealedCore) {
    throw 'Android release signing blocked: VERSION-POLICY.json has releaseApproved=false or missing sealedCore.'
}
if (!(Test-Path -LiteralPath $UnsignedApk)) { throw 'Build assembleRelease before signing.' }
$tools = Get-ChildItem "$Sdk\build-tools" -Directory | Where-Object { Test-Path "$($_.FullName)\apksigner.bat" } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$tools) { throw 'Android build tools are required.' }
$keyDirectory = Join-Path $env:USERPROFILE '.android\agentopsdeck-signing'
New-Item -ItemType Directory -Force -Path $keyDirectory | Out-Null
$keystore = Join-Path $keyDirectory 'client.p12'
$passwordFile = Join-Path $keyDirectory 'password.xml'
if (!(Test-Path -LiteralPath $passwordFile)) {
    if (Test-Path -LiteralPath $keystore) { throw 'Existing signing key has no password file; restore it rather than replacing the key.' }
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $generator.GetBytes($bytes)
    $generator.Dispose()
    ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force | Export-Clixml -LiteralPath $passwordFile
}
$secret = Import-Clixml -LiteralPath $passwordFile
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $env:AOD_ANDROID_SIGNING_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if (!(Test-Path -LiteralPath $keystore)) {
        & "$JavaHome\bin\keytool.exe" -genkeypair -keystore $keystore -storetype PKCS12 -alias agentopsdeck-client -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=AgentOpsDeck Android Personal Client' -storepass:env AOD_ANDROID_SIGNING_PASSWORD -keypass:env AOD_ANDROID_SIGNING_PASSWORD
        if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed.' }
    }
    $aligned = "$Output.aligned.apk"
    & "$($tools.FullName)\zipalign.exe" -f -p 4 $UnsignedApk $aligned
    if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
    $env:JAVA_HOME = $JavaHome
    & "$($tools.FullName)\apksigner.bat" sign --ks $keystore --ks-key-alias agentopsdeck-client --ks-pass env:AOD_ANDROID_SIGNING_PASSWORD --key-pass env:AOD_ANDROID_SIGNING_PASSWORD --out $Output $aligned
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
    & "$($tools.FullName)\apksigner.bat" verify --verbose $Output
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    Remove-Item -LiteralPath $aligned
    Write-Output "Signed APK: $Output"
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    Remove-Item Env:\AOD_ANDROID_SIGNING_PASSWORD -ErrorAction SilentlyContinue
}
