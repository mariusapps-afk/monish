# Installs the `monish` command on Windows (no Node needed). In PowerShell:
#   irm https://monish.cc/install.ps1 | iex; monish pair 482913
# Environment:
#   MONISH_INSTALL_DIR   where monish.exe goes (default: ~\.local\bin)
#   MONISH_VERSION       a release, e.g. 1.2.0 (default: the latest)
#   MONISH_DOWNLOAD_URL  folder holding monish-windows-x64.exe.gz and SHA256SUMS (default: the GitHub release)
# Run through iex: no exit (it would close the window), errors stop the function only.

function Install-Monish {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') {
    Write-Host "monish: no build for $arch. Use Node instead: npx monish pair <code>" -ForegroundColor Red
    return
  }
  # Windows on ARM runs the x64 build through emulation.
  $asset = 'monish-windows-x64.exe.gz'

  $repo = 'mariusapps-afk/monish'
  if ($env:MONISH_DOWNLOAD_URL) { $base = $env:MONISH_DOWNLOAD_URL.TrimEnd('/') }
  elseif ($env:MONISH_VERSION) { $base = "https://github.com/$repo/releases/download/v$($env:MONISH_VERSION.TrimStart('v'))" }
  else { $base = "https://github.com/$repo/releases/latest/download" }

  $dir = if ($env:MONISH_INSTALL_DIR) { $env:MONISH_INSTALL_DIR } else { Join-Path $HOME '.local\bin' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("monish-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Write-Host 'Downloading Monish for windows-x64...'
    $gz = Join-Path $tmp $asset
    $sums = Join-Path $tmp 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $gz
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums

    $want = $null
    foreach ($line in Get-Content $sums) {
      $parts = $line -split '\s+'
      if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -eq $asset) { $want = $parts[0].ToLower() }
    }
    if (-not $want) { throw "$asset is not listed in SHA256SUMS" }
    $got = (Get-FileHash -Algorithm SHA256 -Path $gz).Hash.ToLower()
    if ($got -ne $want) { throw "checksum mismatch for ${asset}: download it again" }

    $exeTmp = Join-Path $tmp 'monish.exe'
    $in = [IO.File]::OpenRead($gz)
    try {
      $unzip = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
      $out = [IO.File]::Create($exeTmp)
      try { $unzip.CopyTo($out) } finally { $out.Dispose(); $unzip.Dispose() }
    } finally { $in.Dispose() }

    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $exe = Join-Path $dir 'monish.exe'
    # A running hook locks monish.exe: move it aside, it can still be renamed.
    if (Test-Path $exe) {
      $old = "$exe.old"
      Remove-Item -Force $old -ErrorAction SilentlyContinue
      Move-Item -Force $exe $old
    }
    Move-Item -Force $exeTmp $exe
    Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
    $version = & $exe --version
    Write-Host "Installed monish $version in $exe"

    # PATH: for new terminals (user scope) and for this one, so `; monish pair <code>` works right away.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $dir)) {
      $next = if ($userPath) { "$dir;$userPath" } else { $dir }
      [Environment]::SetEnvironmentVariable('Path', $next, 'User')
      Write-Host "Added $dir to your PATH."
    }
    if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = "$dir;$env:Path" }
    Write-Host 'Next: monish pair <code>, with the code shown in the Monish app.'
  } catch {
    Write-Host "monish: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Install-Monish
