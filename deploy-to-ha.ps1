# EDIT THIS VALUE before first use if your Home Assistant mapped drive differs.
# The Samba share exposes Home Assistant's /config directory directly.
$HaConfigShare = "Z:"

$SourceFile = Join-Path $PSScriptRoot "nvr-card.js"
$LoaderSourceFile = Join-Path $PSScriptRoot "loader.js"
$LiveSourceDirectory = Join-Path $PSScriptRoot "src\live"
$HaWwwDirectory = Join-Path $HaConfigShare "www\nvr-card"
$DestinationFile = Join-Path $HaWwwDirectory "nvr-card.js"
$LoaderDestinationFile = Join-Path $HaWwwDirectory "loader.js"
$LiveDestinationDirectory = Join-Path $HaWwwDirectory "src\live"

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
    $ProductionFiles = @($SourceFile, $LoaderSourceFile) + @(
        Get-ChildItem -LiteralPath $LiveSourceDirectory -Filter "*.js" -File -ErrorAction Stop |
            Sort-Object Name |
            Select-Object -ExpandProperty FullName
    )
    $HashStream = New-Object System.IO.MemoryStream
    $HashEncoding = New-Object System.Text.UTF8Encoding($false)

    foreach ($ProductionFile in $ProductionFiles) {
        $RelativePath = $ProductionFile.Substring($PSScriptRoot.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
        $PathBytes = $HashEncoding.GetBytes($RelativePath + [char]0)
        $FileBytes = [System.IO.File]::ReadAllBytes($ProductionFile)
        $HashStream.Write($PathBytes, 0, $PathBytes.Length)
        $HashStream.Write($FileBytes, 0, $FileBytes.Length)
        $HashStream.WriteByte(0)
    }

    $ProductionHash = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
        $HashStream.ToArray()
    )
    $ProductionHashHex = [System.BitConverter]::ToString($ProductionHash).Replace('-', '').ToLowerInvariant()
    $BuildIdentifier = "NVR $ShortHash-$ProductionHashHex"

    Write-Host "Deploying build: $BuildIdentifier"

    if (-not $SourceContent.Contains($Placeholder)) {
        Write-Error "Build placeholder was not found in the source file: $Placeholder"
        exit 1
    }

    $DeployedContent = $SourceContent.Replace($Placeholder, $BuildIdentifier)
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $DeployedBytes = $Utf8NoBom.GetBytes($DeployedContent)
    [System.IO.File]::WriteAllBytes($DestinationFile, $DeployedBytes)
    Copy-Item -LiteralPath $LoaderSourceFile -Destination $LoaderDestinationFile -Force -ErrorAction Stop
    New-Item -ItemType Directory -Path $LiveDestinationDirectory -Force -ErrorAction Stop | Out-Null
    Copy-Item -Path (Join-Path $LiveSourceDirectory "*.js") -Destination $LiveDestinationDirectory -Force -ErrorAction Stop
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
