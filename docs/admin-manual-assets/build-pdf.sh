#!/usr/bin/env bash
# Regenerate all Operion documentation PDFs from their Markdown sources.
# Pipeline: Markdown --(md2html.py)--> print-ready HTML --(LibreOffice headless)--> PDF.
# No network required. Run from the repo root:  bash docs/admin-manual-assets/build-pdf.sh
#
# Requirements: python3 + one HTML->PDF engine. Preferred: LibreOffice (`soffice`,
# e.g. `brew install --cask libreoffice`). This is how the shipped PDFs were built.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
A="docs/admin-manual-assets"
LO_PROFILE="file:///tmp/operion_lo_profile"

html2pdf() { # <in.html> <outdir>
  if command -v soffice >/dev/null 2>&1; then
    soffice --headless -env:UserInstallation="$LO_PROFILE" --convert-to pdf --outdir "$2" "$1" >/dev/null 2>&1
  elif command -v cupsfilter >/dev/null 2>&1; then       # macOS built-in fallback (basic styling)
    cupsfilter "$1" > "$2/$(basename "${1%.html}").pdf" 2>/dev/null
  else
    echo "No HTML->PDF engine (install LibreOffice: brew install --cask libreoffice)"; exit 1
  fi
}

build() { # <src.md> <keep_jkiss 0|1> <brand> <accent> <domain> <subtitle> <outbase>
  local tmp; tmp="$(mktemp -t opdoc-XXXX.md)"
  python3 "$A/prep.py" "$1" "$2" "$tmp"
  python3 "$A/md2html.py" "$tmp" "docs/$7.html" "$3" "$4" "$5" "$6"
  html2pdf "docs/$7.html" docs
  rm -f "$tmp" "docs/$7.html"
  echo "  ✓ docs/$7.pdf"
}

echo "Building Operion documentation PDFs…"
# 1) Full technical reference manual (J KISS red)
build docs/Admin-User-Manual.md 1 "Operion" "#dc2626" "J KISS LLC · jkissllc.com" \
  "Administrator User Manual" "Admin-User-Manual"
# 2) User-friendly quick-start — J KISS (red, includes owner Releases section)
build docs/Operion-User-Guide.md 1 "Operion" "#dc2626" "J KISS LLC · jkissllc.com" \
  "Administrator Quick-Start Guide" "Operion-Admin-Guide-JKISS"
# 3) User-friendly quick-start — Supercharged (blue, managed target: owner Releases removed)
build docs/Operion-User-Guide.md 0 "Supercharged Enterprise" "#2563EB" \
  "Supercharged Enterprise LLC · superchargedenterprise.com" \
  "Administrator Quick-Start Guide" "Operion-Admin-Guide-Supercharged"
echo "Done."
