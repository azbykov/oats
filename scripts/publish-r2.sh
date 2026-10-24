#!/usr/bin/env bash
# Uploads a release's builds to Cloudflare R2 for the landing page's download links.
#
#   scripts/publish-r2.sh <tag> <dir with Oats-Setup-<version>.exe, Oats-mac-arm64.zip and Oats-mac-x64.zip>
#
# Layout in the bucket:
#   releases/<tag>/<file>       one immutable copy per release
#   latest/Oats-Setup.exe       what the "Download" buttons point at
#   latest/Oats-mac-arm64.zip
#   latest/Oats-mac-x64.zip
#   latest/version.json         version, date, sizes and SHA-256 for the page to show
#
# Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET, and the
# aws CLI (R2 speaks the S3 API; wrangler's single upload is too small for these files).
set -euo pipefail

tag=${1:?usage: publish-r2.sh <tag> <dir>}
dir=${2:?usage: publish-r2.sh <tag> <dir>}
missing=()
for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  [[ -n ${!name:-} ]] || missing+=("$name")
done
if ((${#missing[@]})); then
  echo "Not set: ${missing[*]}" >&2
  echo "Add them as repository secrets (Settings → Secrets and variables → Actions → Secrets), not environment secrets." >&2
  exit 1
fi

version=${tag#v}
exe="$dir/Oats-Setup-$version.exe"
zip="$dir/Oats-mac-arm64.zip"
zip_x64="$dir/Oats-mac-x64.zip"
for f in "$exe" "$zip" "$zip_x64"; do
  [[ -f $f ]] || { echo "missing $f (does the tag match package.json's version?)" >&2; exit 1; }
done

export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
# Recent aws CLI versions add checksum headers R2 doesn't accept on every request.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
endpoint="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"

# put <file> <key> <content type> <cache control>
put() {
  aws s3 cp "$1" "s3://$R2_BUCKET/$2" --endpoint-url "$endpoint" --only-show-errors \
    --content-type "$3" --cache-control "$4" --content-disposition "attachment; filename=\"$(basename "$2")\""
}

immutable='public, max-age=31536000, immutable'
# Short, so a new release reaches the edge cache within minutes.
fresh='public, max-age=300'

put "$exe" "releases/$tag/$(basename "$exe")" application/vnd.microsoft.portable-executable "$immutable"
put "$zip" "releases/$tag/Oats-mac-arm64-$version.zip" application/zip "$immutable"
put "$zip_x64" "releases/$tag/Oats-mac-x64-$version.zip" application/zip "$immutable"
put "$exe" latest/Oats-Setup.exe application/vnd.microsoft.portable-executable "$fresh"
put "$zip" latest/Oats-mac-arm64.zip application/zip "$fresh"
put "$zip_x64" latest/Oats-mac-x64.zip application/zip "$fresh"

entry() { # entry <file> <release key>
  printf '{"url": "%s", "bytes": %s, "sha256": "%s"}' "$2" "$(wc -c < "$1" | tr -d ' ')" "$(shasum -a 256 "$1" | cut -d' ' -f1)"
}
manifest=$(mktemp)
cat > "$manifest" <<EOF
{
  "version": "$version",
  "tag": "$tag",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "windows": $(entry "$exe" "releases/$tag/$(basename "$exe")"),
  "macArm64": $(entry "$zip" "releases/$tag/Oats-mac-arm64-$version.zip"),
  "macX64": $(entry "$zip_x64" "releases/$tag/Oats-mac-x64-$version.zip")
}
EOF
aws s3 cp "$manifest" "s3://$R2_BUCKET/latest/version.json" --endpoint-url "$endpoint" --only-show-errors \
  --content-type application/json --cache-control "$fresh"
rm -f "$manifest"

echo "Published $tag to $R2_BUCKET:"
cat <<EOF
  releases/$tag/$(basename "$exe")
  releases/$tag/Oats-mac-arm64-$version.zip
  releases/$tag/Oats-mac-x64-$version.zip
  latest/Oats-Setup.exe, latest/Oats-mac-arm64.zip, latest/Oats-mac-x64.zip, latest/version.json
EOF
