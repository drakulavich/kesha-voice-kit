# Git for Windows ships a GNU link.exe that shadows MSVC's under `shell: bash`, so pin it through cargo's env knob.
$linkPath = (Get-Command link.exe |
  Where-Object { $_.Source -notlike "*Git*usr*" } |
  Select-Object -First 1).Source
if (-not $linkPath) { Write-Error "MSVC link.exe not found"; exit 1 }
Write-Host "MSVC linker: $linkPath"
Add-Content -Path $env:GITHUB_ENV -Value "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=$linkPath"
