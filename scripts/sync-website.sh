#!/bin/sh
# Copies the viewer into a BVKsound-style website folder (one that has site-nav.js and images/logo.png):
#   Fluke287.html   the page, with the site favicon and module path adjusted
#   fluke287/src/   the app modules
#   images/fluke-seeklogo.svg
# Usage: scripts/sync-website.sh /path/to/website
set -eu

dest="${1:?usage: sync-website.sh /path/to/website}"
root="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$dest/site-nav.js" ] || { echo "$dest has no site-nav.js" >&2; exit 1; }

mkdir -p "$dest/fluke287/src" "$dest/images"
cp "$root"/images/fluke-seeklogo.svg "$dest/images/"
cp "$root"/src/*.js "$dest/fluke287/src/"
sed -e 's#src="src/app.js"#src="fluke287/src/app.js"#' \
    -e 's#</title>#</title>\n<link rel="icon" href="images/logo.png">#' \
    "$root/index.html" > "$dest/Fluke287.html"

echo "Synced to $dest (Fluke287.html, fluke287/src/)"
