$ErrorActionPreference = "Stop"

$repo = "youngwoocho02/plastic-scm-diff-viewer"
$url = "https://github.com/$repo/releases/latest/download/plastic-scm-diff-viewer.vsix"
$vsix = "$env:TEMP\plastic-scm-diff-viewer.vsix"

Write-Host "Downloading plastic-scm-diff-viewer.vsix..."
Invoke-WebRequest -Uri $url -OutFile $vsix -UseBasicParsing

Write-Host "Installing VS Code extension..."
code --install-extension $vsix
