#!/bin/sh
set -e

REPO="youngwoocho02/plastic-scm-diff-viewer"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux)  ;;
  darwin) ;;
  *)      echo "Unsupported OS: $OS (use Windows instructions in README)"; exit 1 ;;
esac

URL="https://github.com/${REPO}/releases/latest/download/plastic-scm-diff-viewer.vsix"
VSIX="/tmp/plastic-scm-diff-viewer.vsix"

echo "Downloading plastic-scm-diff-viewer.vsix..."
curl -fsSL "$URL" -o "$VSIX"

echo "Installing VS Code extension..."
code --install-extension "$VSIX"
