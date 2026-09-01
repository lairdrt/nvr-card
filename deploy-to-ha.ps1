# EDIT THIS VALUE before first use if your Home Assistant mapped drive differs.
# The Samba share exposes Home Assistant's /config directory directly.
$HaConfigShare = "Z:"

$SourceFile = Join-Path $PSScriptRoot "nvr-card.js"
$LoaderSourceFile = Join-Path $PSScriptRoot "loader.js"
$LiveSourceDirectory = Join-Path $PSScriptRoot "src\live"
$ProviderSourceDirectory = Join-Path $PSScriptRoot "src\providers"
$Go2RtcVendorSourceDirectory = Join-Path $PSScriptRoot "src\vendor\go2rtc"
$HaWwwDirectory = Join-Path $HaConfigShare "www\nvr-card"
$DestinationFile = Join-Path $HaWwwDirectory "nvr-card.js"
$LoaderDestinationFile = Join-Path $HaWwwDirectory "loader.js"
$LiveDestinationDirectory = Join-Path $HaWwwDirectory "src\live"
$ProviderDestinationDirectory = Join-Path $HaWwwDirectory "src\providers"
$Go2RtcVendorDestinationDirectory = Join-Path $HaWwwDirectory "src\vendor\go2rtc"

Write-Host "Local source: $SourceFile"
Write-Host "HA destination: $DestinationFile"
Write-Host "Loader source: $LoaderSourceFile"
Write-Host "Loader destination: $LoaderDestinationFile"

if (-not (Test-Path -LiteralPath $SourceFile -PathType Leaf)) {
    Write-Error "Local source file does not exist: $SourceFile"
    exit 1
}

if (-not (Test-Path -LiteralPath $LoaderSourceFile -PathType Leaf)) {
    Write-Error "Local loader file does not exist: $LoaderSourceFile"
    exit 1
}

if (-not (Test-Path -LiteralPath $LiveSourceDirectory -PathType Container)) {
    Write-Error "Live source directory does not exist: $LiveSourceDirectory"
    exit 1
}

if (-not (Test-Path -LiteralPath $ProviderSourceDirectory -PathType Container)) {
    Write-Error "Provider source directory does not exist: $ProviderSourceDirectory"
    exit 1
}

if (-not (Test-Path -LiteralPath $Go2RtcVendorSourceDirectory -PathType Container)) {
    Write-Error "go2rtc vendor source directory does not exist: $Go2RtcVendorSourceDirectory"
    exit 1
}

if (-not (Test-Path -LiteralPath $HaConfigShare -PathType Container)) {
    Write-Error "Home Assistant Samba share is not accessible: $HaConfigShare"
    exit 1
}

if (-not (Test-Path -LiteralPath $HaWwwDirectory -PathType Container)) {
    Write-Error "Home Assistant www directory does not exist: $HaWwwDirectory"
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is not available. Install Git or add it to PATH before deploying."
    exit 1
}

$ShortHash = & git -C $PSScriptRoot rev-parse --short HEAD 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to obtain the Git commit hash: $ShortHash"
    exit 1
}
$ShortHash = ($ShortHash | Out-String).Trim()

$Placeholder = "__NVR_BUILD__"

try {
    $SourceContent = Get-Content -LiteralPath $SourceFile -Raw -ErrorAction Stop

    $DeployedSourceFiles = @(
        Get-Item -LiteralPath $SourceFile -ErrorAction Stop
        Get-Item -LiteralPath $LoaderSourceFile -ErrorAction Stop
        Get-ChildItem -LiteralPath $LiveSourceDirectory -File -Filter "*.js" -ErrorAction Stop
        Get-ChildItem -LiteralPath $ProviderSourceDirectory -File -Filter "*.js" -ErrorAction Stop
        Get-ChildItem -LiteralPath $Go2RtcVendorSourceDirectory -File -ErrorAction Stop
    ) | Sort-Object FullName

    $SourceRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path.TrimEnd("\") + "\"
    $ManifestLines = $DeployedSourceFiles | ForEach-Object {
        $RelativePath = $_.FullName.Substring($SourceRoot.Length).Replace("\", "/")
        $FileHash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        "$RelativePath|$FileHash"
    }
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $ManifestBytes = $Utf8NoBom.GetBytes(($ManifestLines -join "`n"))
    $Sha256 = [System.Security.Cryptography.SHA256]::Create()

    try {
        $ManifestHash = ([BitConverter]::ToString($Sha256.ComputeHash($ManifestBytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $Sha256.Dispose()
    }

    $WorkingTreeHash = $ManifestHash.Substring(0, 6)
    $BuildIdentifier = "NVR $ShortHash-$WorkingTreeHash"

    Write-Host "Deploying build: $BuildIdentifier"

    if (-not $SourceContent.Contains($Placeholder)) {
        Write-Error "Build placeholder was not found in the source file: $Placeholder"
        exit 1
    }

    $DeployedContent = $SourceContent.Replace($Placeholder, $BuildIdentifier)
    $DeployedBytes = $Utf8NoBom.GetBytes($DeployedContent)
    [System.IO.File]::WriteAllBytes($DestinationFile, $DeployedBytes)
    Copy-Item -LiteralPath $LoaderSourceFile -Destination $LoaderDestinationFile -Force -ErrorAction Stop
    New-Item -ItemType Directory -Path $LiveDestinationDirectory -Force -ErrorAction Stop | Out-Null
    Copy-Item -Path (Join-Path $LiveSourceDirectory "*.js") -Destination $LiveDestinationDirectory -Force -ErrorAction Stop
    New-Item -ItemType Directory -Path $ProviderDestinationDirectory -Force -ErrorAction Stop | Out-Null
    Copy-Item -Path (Join-Path $ProviderSourceDirectory "*.js") -Destination $ProviderDestinationDirectory -Force -ErrorAction Stop
    New-Item -ItemType Directory -Path $Go2RtcVendorDestinationDirectory -Force -ErrorAction Stop | Out-Null
    Copy-Item -Path (Join-Path $Go2RtcVendorSourceDirectory "*") -Destination $Go2RtcVendorDestinationDirectory -Force -ErrorAction Stop
}
catch {
    Write-Error "Failed to deploy NVR card files: $($_.Exception.Message)"
    exit 1
}

if (-not (Test-Path -LiteralPath $DestinationFile -PathType Leaf)) {
    Write-Error "Destination file does not exist after deployment: $DestinationFile"
    exit 1
}

if (-not (Test-Path -LiteralPath $LoaderDestinationFile -PathType Leaf)) {
    Write-Error "Loader destination file does not exist after deployment: $LoaderDestinationFile"
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $LiveDestinationDirectory "nvr-live-presentation.js") -PathType Leaf)) {
    Write-Error "Live presentation module was not deployed."
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $ProviderDestinationDirectory "frigate-provider.js") -PathType Leaf)) {
    Write-Error "Frigate provider module was not deployed."
    exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $Go2RtcVendorDestinationDirectory "video-rtc.js") -PathType Leaf)) {
    Write-Error "Vendored go2rtc VideoRTC module was not deployed."
    exit 1
}

$DestinationSize = (Get-Item -LiteralPath $DestinationFile).Length

if ($DeployedBytes.Length -ne $DestinationSize) {
    Write-Error "File size verification failed. Expected: $($DeployedBytes.Length) bytes; destination: $DestinationSize bytes."
    exit 1
}

if ($DestinationSize -eq 0) {
    Write-Error "Deployed nvr-card.js is empty: $DestinationFile"
    exit 1
}

$LoaderSourceSize = (Get-Item -LiteralPath $LoaderSourceFile).Length
$LoaderDestinationSize = (Get-Item -LiteralPath $LoaderDestinationFile).Length

if ($LoaderSourceSize -eq 0 -or $LoaderDestinationSize -eq 0) {
    Write-Error "Loader file size verification failed because the source or destination is empty."
    exit 1
}

if ($LoaderSourceSize -ne $LoaderDestinationSize) {
    Write-Error "Loader file size verification failed. Source: $LoaderSourceSize bytes; destination: $LoaderDestinationSize bytes."
    exit 1
}

$DestinationContent = Get-Content -LiteralPath $DestinationFile -Raw
$ExpectedBuildLine = 'const NVR_BUILD = "' + $BuildIdentifier + '";'

if (-not $DestinationContent.Contains($ExpectedBuildLine)) {
    Write-Error "Build identifier verification failed. Expected to find: $ExpectedBuildLine"
    exit 1
}

Write-Host "Deployment succeeded with build identifier: $BuildIdentifier"
