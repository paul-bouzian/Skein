# Skein Release Runbook

This runbook is the canonical path for cutting Skein releases while GitHub-hosted macOS runners remain unreliable or blocked by billing. The current release plumbing publishes from `paul-bouzian/Skein`.

## Release Target

- product name: `Skein`
- bundle id: `com.paulbouzian.skein`
- release version: `RELEASE_VERSION` from `package.json` / `src-tauri/tauri.conf.json`
- primary distribution: macOS Apple Silicon
- release flow: local signed + notarized build, then GitHub upload
- compatibility note: release assets, the bundle name, and the bundle identifier should use `Skein`; installed data migrates forward from the previous Loom and ThreadEx identifiers

## Local Inputs

- Developer ID certificate export:
  - `${SKEIN_APPLE_CERTIFICATE_P12}`
- App Store Connect API key:
  - `${SKEIN_APPLE_API_KEY_PATH}`
- App Store Connect API key metadata:
  - `${SKEIN_APPLE_API_KEY_ID}`
  - `${SKEIN_APPLE_API_ISSUER}`
- updater private key:
  - `~/.skein/release/skein-updater.key`
- updater private key password:
  - `~/.skein/release/tauri-updater-password.txt`

Suggested local exports:

```bash
export SKEIN_APPLE_CERTIFICATE_P12="$HOME/Documents/skein-developer-id.p12"
export SKEIN_APPLE_API_KEY_PATH="$HOME/Downloads/AuthKey_XXXXXXXXXX.p8"
export SKEIN_APPLE_API_KEY_ID="YOUR_KEY_ID"
export SKEIN_APPLE_API_ISSUER="YOUR_ISSUER_ID"
```

Before publishing, set `RELEASE_VERSION` to the exact version being shipped. Keep every tag, filename, and updater example below aligned with that value.

## One-Time Reset Before The First Official Skein Release

Older unpublished attempts used `v0.1.0` and `v0.1.1` tags. Clean them before reusing those early placeholder tags.

```bash
git tag -d v0.1.0 v0.1.1 2>/dev/null || true
git push origin :refs/tags/v0.1.0 :refs/tags/v0.1.1
```

## Prepare The Release Source

Run from the repository root on `main`:

```bash
git pull --ff-only
node scripts/update-version.mjs "$RELEASE_VERSION"
bun install --frozen-lockfile
bun run verify
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

If the repo is ready, commit the release source and tag it:

```bash
git add .
git commit -m "chore(release): cut v${RELEASE_VERSION}" -m "Co-authored-by: Codex <noreply@openai.com>"
git tag "v${RELEASE_VERSION}"
```

## Build, Sign, Notarize

Use the local signing flow. If you use a temporary keychain, also import the Developer ID G2 intermediate certificate first.

```bash
curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -o "$TMPDIR/DeveloperIDG2CA.cer"
```

Build the signed app bundle:

```bash
bun run tauri build --target aarch64-apple-darwin --bundles app
```

The signed app bundle should exist at:

- `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Skein.app`

Installed Loom copies still update in place because the Tauri updater resolves the target from the currently running executable path. That does not require Skein releases to keep Loom-named artifacts.

Create the notarization archive and submit it:

```bash
ditto -c -k --keepParent \
  src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Skein.app \
  release-artifacts/Skein-notary.zip

xcrun notarytool submit release-artifacts/Skein-notary.zip \
  --key "$SKEIN_APPLE_API_KEY_PATH" \
  --key-id "$SKEIN_APPLE_API_KEY_ID" \
  --issuer "$SKEIN_APPLE_API_ISSUER" \
  --wait \
  --output-format json
```

If Apple is slow, check status manually:

```bash
xcrun notarytool history \
  --key "$SKEIN_APPLE_API_KEY_PATH" \
  --key-id "$SKEIN_APPLE_API_KEY_ID" \
  --issuer "$SKEIN_APPLE_API_ISSUER" \
  --output-format json
```

Once accepted:

```bash
xcrun stapler staple src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Skein.app
```

## Package Release Artifacts

```bash
mkdir -p release-artifacts release-artifacts/dmg-root
ditto src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Skein.app \
  release-artifacts/dmg-root/Skein.app
ditto -c -k --keepParent \
  release-artifacts/dmg-root/Skein.app \
  release-artifacts/Skein.zip
hdiutil create \
  -volname "Skein" \
  -srcfolder release-artifacts/dmg-root \
  -ov \
  -format UDZO \
  release-artifacts/Skein_${RELEASE_VERSION}_aarch64.dmg
COPYFILE_DISABLE=1 tar -czf \
  release-artifacts/Skein.app.tar.gz \
  -C src-tauri/target/aarch64-apple-darwin/release/bundle/macos \
  Skein.app
```

Sign the updater archive:

```bash
bun run tauri signer sign -- \
  -f "$HOME/.skein/release/skein-updater.key" \
  -p "$(cat "$HOME/.skein/release/tauri-updater-password.txt")" \
  release-artifacts/Skein.app.tar.gz
```

Generate release notes and `latest.json`:

```bash
gh api "repos/paul-bouzian/Skein/releases/generate-notes" \
  -X POST \
  -F "tag_name=v${RELEASE_VERSION}" \
  -F "target_commitish=$(git rev-parse HEAD)" \
  --jq .body > release-artifacts/release-notes.md
```

```bash
python3 <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

repo = "paul-bouzian/Skein"
version = os.environ["RELEASE_VERSION"]
tag = f"v{version}"
notes = Path("release-artifacts/release-notes.md").read_text().strip()
signature = Path("release-artifacts/Skein.app.tar.gz.sig").read_text().strip()
payload = {
  "version": version,
  "notes": notes,
  "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "platforms": {
    "darwin-aarch64": {
      "signature": signature,
      "url": f"https://github.com/{repo}/releases/download/{tag}/Skein.app.tar.gz",
    }
  },
}
Path("release-artifacts/latest.json").write_text(json.dumps(payload, indent=2) + "\n")
PY
```

## Publish The GitHub Release

```bash
gh release create "v${RELEASE_VERSION}" \
  --title "Skein v${RELEASE_VERSION}" \
  --notes-file release-artifacts/release-notes.md \
  --target "$(git rev-parse HEAD)" \
  release-artifacts/Skein.zip \
  release-artifacts/Skein_${RELEASE_VERSION}_aarch64.dmg \
  release-artifacts/Skein.app.tar.gz \
  release-artifacts/Skein.app.tar.gz.sig \
  release-artifacts/latest.json
```

If the release already exists:

```bash
gh release edit "v${RELEASE_VERSION}" \
  --title "Skein v${RELEASE_VERSION}" \
  --notes-file release-artifacts/release-notes.md

gh release upload "v${RELEASE_VERSION}" \
  release-artifacts/Skein.zip \
  release-artifacts/Skein_${RELEASE_VERSION}_aarch64.dmg \
  release-artifacts/Skein.app.tar.gz \
  release-artifacts/Skein.app.tar.gz.sig \
  release-artifacts/latest.json \
  --clobber
```

## Validation Checklist

- `bun run verify`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- bundled app launches from `/Applications`
- manual downloads are published as `Skein.zip`, `Skein_<version>_aarch64.dmg`, and `Skein.app.tar.gz`
- Codex runtime works from Finder launch
- updater notice links target `paul-bouzian/Skein`

## Known External Risk

Apple notarization can remain slow or flaky for long stretches. If `notarytool submit --wait` stalls for too long, prefer checking `history` / `info` manually instead of resubmitting repeatedly.
