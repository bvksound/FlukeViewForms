#!/bin/sh
# Builds the single-file page and copies it into a BVKsound-style website folder (one that has site-nav.js):
#   Fluke287.html   everything inlined, uses the site's own site-nav.js and images/logo.png
# Usage: scripts/sync-website.sh /path/to/website
set -eu

dest="${1:?usage: sync-website.sh /path/to/website}"
root="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$dest/site-nav.js" ] || { echo "$dest has no site-nav.js" >&2; exit 1; }

node "$root/scripts/build.mjs"
cp "$root/dist/Fluke287.html" "$dest/Fluke287.html"

# Earlier versions shipped as a page plus a module folder and a logo file; the single file replaces them.
rm -rf "$dest/fluke287" "$dest/images/fluke-seeklogo.svg"

echo "Synced to $dest/Fluke287.html"
