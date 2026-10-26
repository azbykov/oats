#!/bin/sh
# Renders the app icons from the logo SVGs (macOS only: sips + iconutil):
#   resources/icon.svg  (logo on the macOS icon grid) -> icon.icns, icon.png
#   src/renderer/src/assets/logo.svg (full bleed)     -> icon.ico
# The results are committed; rerun after changing either SVG.
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

render() { sips -s format png -z "$2" "$2" "$1" --out "$3" >/dev/null; }

mkdir "$tmp/icon.iconset"
for size in 16 32 128 256 512; do
  render resources/icon.svg "$size" "$tmp/icon.iconset/icon_${size}x${size}.png"
  render resources/icon.svg $((size * 2)) "$tmp/icon.iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$tmp/icon.iconset" -o resources/icon.icns
cp "$tmp/icon.iconset/icon_512x512@2x.png" resources/icon.png

# .ico with PNG-compressed entries (Windows Vista+).
for size in 16 24 32 48 64 128 256; do
  render src/renderer/src/assets/logo.svg "$size" "$tmp/ico-$size.png"
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
fs.writeFileSync("resources/icon.ico", Buffer.concat([header, ...pngs]))
' "$tmp"
ls -l resources/icon.icns resources/icon.ico resources/icon.png
