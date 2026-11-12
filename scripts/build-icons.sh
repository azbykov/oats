#!/bin/sh
# Renders an app's icons from its logo SVGs (macOS only: sips + iconutil):
#   scripts/build-icons.sh [oats|rye]      (oats when not given)
#   apps/<app>/resources/icon.svg  (logo on the macOS icon grid) -> icon.icns, icon.png
#   apps/<app>/resources/icon-dev.svg (violet dev variant)       -> icon-dev.png
#   apps/<app>/resources/logo.svg (full bleed)                   -> icon.ico
#     Oats has no logo.svg of its own: its mark is the one the window shows,
#     shared/src/renderer/src/assets/logo.svg.
# The results are committed; rerun after changing either SVG.
set -e
cd "$(dirname "$0")/.."
res="apps/${1:-oats}/resources"
[ -f "$res/icon.svg" ] || { echo "no $res/icon.svg" >&2; exit 1; }
logo="$res/logo.svg"
[ -f "$logo" ] || logo=shared/src/renderer/src/assets/logo.svg
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

render() { sips -s format png -z "$2" "$2" "$1" --out "$3" >/dev/null; }

mkdir "$tmp/icon.iconset"
for size in 16 32 128 256 512; do
  render "$res/icon.svg" "$size" "$tmp/icon.iconset/icon_${size}x${size}.png"
  render "$res/icon.svg" $((size * 2)) "$tmp/icon.iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$tmp/icon.iconset" -o "$res/icon.icns"
cp "$tmp/icon.iconset/icon_512x512@2x.png" "$res/icon.png"
# Dev builds (npm run dev) set this one on the window and Dock instead.
render "$res/icon-dev.svg" 1024 "$res/icon-dev.png"

# .ico with PNG-compressed entries (Windows Vista+).
for size in 16 24 32 48 64 128 256; do
  render "$logo" "$size" "$tmp/ico-$size.png"
done
node -e '
const fs = require("node:fs")
const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = sizes.map((s) => fs.readFileSync(`${process.argv[1]}/ico-${s}.png`))
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((s, i) => {
  const e = 6 + 16 * i
  header.writeUInt8(s % 256, e)
  header.writeUInt8(s % 256, e + 1)
  header.writeUInt16LE(1, e + 4)
  header.writeUInt16LE(32, e + 6)
  header.writeUInt32LE(pngs[i].length, e + 8)
  header.writeUInt32LE(offset, e + 12)
  offset += pngs[i].length
})
fs.writeFileSync(process.argv[2], Buffer.concat([header, ...pngs]))
' "$tmp" "$res/icon.ico"
ls -l "$res/icon.icns" "$res/icon.ico" "$res/icon.png"
