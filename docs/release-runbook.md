# Loom Release Runbook

This runbook is the canonical path for cutting Loom releases while GitHub-hosted macOS runners remain unreliable or blocked by billing. It assumes the repository name is `paul-bouzian/Loom` and the first official release is `v0.1.0`.

## Release Target

- product name: `Loom`
- bundle id: `com.paulbouzian.loom`
- current official target: `v0.1.0`
- primary distribution: macOS Apple Silicon
- release flow: local signed + notarized build, then GitHub upload

## Local Inputs

- Developer ID certificate export:
  - `${LOOM_APPLE_CERTIFICATE_P12}`
- App Store Connect API key:
  - `${LOOM_APPLE_API_KEY_PATH}`
- App Store Connect API key metadata:
  - `${LOOM_APPLE_API_KEY_ID}`
  - `${LOOM_APPLE_API_ISSUER}`
- updater private key:
  - `~/.loom/release/loom-updater.key`
- updater private key password:
  - `~/.loom/release/tauri-updater-password.txt`

Suggested local exports:

```bash
export LOOM_APPLE_CERTIFICATE_P12="$HOME/Documents/loom-developer-id.p12"
export LOOM_APPLE_API_KEY_PATH="$HOME/Downloads/AuthKey_XXXXXXXXXX.p8"
export LOOM_APPLE_API_KEY_ID="YOUR_KEY_ID"
export LOOM_APPLE_API_ISSUER="YOUR_ISSUER_ID"
```

## One-Time Reset Before The Official `v0.1.0`

Older unpublished attempts used `v0.1.0` and `v0.1.1` tags. Clean them before reusing `v0.1.0` as the first real Loom release.

```bash
git tag -d v0.1.0 v0.1.1 2>/dev/null || true
git push origin :refs/tags/v0.1.0 :refs/tags/v0.1.1
```

## Prepare The Release Source

Run from the repository root on `main`:

```bash
git pull --ff-only
node scripts/update-version.mjs 0.1.0
bun install --frozen-lockfile
bun run verify
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

If the repo is ready, commit the release source and tag it:

```bash
git add .
git commit -m "chore(release): cut v0.1.0" -m "Co-authored-by: Codex <noreply@openai.com>"
git tag v0.1.0
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

- `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Loom.app`

Create the notarization archive and submit it:

```bash
ditto -c -k --keepParent \
  src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Loom.app \
  release-artifacts/Loom-notary.zip

xcrun notarytool submit release-artifacts/Loom-notary.zip \
  --key "$LOOM_APPLE_API_KEY_PATH" \
  --key-id "$LOOM_APPLE_API_KEY_ID" \
  --issuer "$LOOM_APPLE_API_ISSUER" \
  --wait \
  --output-format json
```

If Apple is slow, check status manually:

```bash
xcrun notarytool history \
  --key "$LOOM_APPLE_API_KEY_PATH" \
  --key-id "$LOOM_APPLE_API_KEY_ID" \
  --issuer "$LOOM_APPLE_API_ISSUER" \
  --output-format json
```

Once accepted:

```bash
xcrun stapler staple src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Loom.app
```

## Package Release Artifacts

```bash
mkdir -p release-artifacts release-artifacts/dmg-root
ditto src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Loom.app \
  release-artifacts/dmg-root/Loom.app
ditto -c -k --keepParent \
  src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Loom.app \
  release-artifacts/Loom.zip
hdiutil create \
  -volname "Loom" \
  -srcfolder release-artifacts/dmg-root \
  -ov \
  -format UDZO \
  release-artifacts/Loom_0.1.0_aarch64.dmg
COPYFILE_DISABLE=1 tar -czf \
  release-artifacts/Loom.app.tar.gz \
  -C src-tauri/target/aarch64-apple-darwin/release/bundle/macos \
  Loom.app
```

Sign the updater archive:

```bash
bun run tauri signer sign -- \
  -f "$HOME/.loom/release/loom-updater.key" \
  -p "$(cat "$HOME/.loom/release/tauri-updater-password.txt")" \
  release-artifacts/Loom.app.tar.gz
```

Generate release notes and `latest.json`:

```bash
gh api "repos/paul-bouzian/Loom/releases/generate-notes" \
  -X POST \
  -F "tag_name=v0.1.0" \
  -F "target_commitish=$(git rev-parse HEAD)" \
  --jq .body > release-artifacts/release-notes.md
```

```bash
python3 <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path

repo = "paul-bouzian/Loom"
version = "0.1.0"
tag = "v0.1.0"
notes = Path("release-artifacts/release-notes.md").read_text().strip()
signature = Path("release-artifacts/Loom.app.tar.gz.sig").read_text().strip()
payload = {
  "version": version,
  "notes": notes,
  "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "platforms": {
    "darwin-aarch64": {
      "signature": signature,
      "url": f"https://github.com/{repo}/releases/download/{tag}/Loom.app.tar.gz",
    }
  },
}
Path("release-artifacts/latest.json").write_text(json.dumps(payload, indent=2) + "\n")
PY
```

## Publish The GitHub Release

```bash
gh release create v0.1.0 \
  --title "Loom v0.1.0" \
  --notes-file release-artifacts/release-notes.md \
  --target "$(git rev-parse HEAD)" \
  release-artifacts/Loom.zip \
  release-artifacts/Loom_0.1.0_aarch64.dmg \
  release-artifacts/Loom.app.tar.gz \
  release-artifacts/Loom.app.tar.gz.sig \
  release-artifacts/latest.json
```

If the release already exists:

```bash
gh release edit v0.1.0 \
  --title "Loom v0.1.0" \
  --notes-file release-artifacts/release-notes.md

gh release upload v0.1.0 \
  release-artifacts/Loom.zip \
  release-artifacts/Loom_0.1.0_aarch64.dmg \
  release-artifacts/Loom.app.tar.gz \
  release-artifacts/Loom.app.tar.gz.sig \
  release-artifacts/latest.json \
  --clobber
```

## Validation Checklist

- `bun run verify`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- bundled app launches from `/Applications`
- Codex runtime works from Finder launch
- updater notice links target `paul-bouzian/Loom`

## Known External Risk

Apple notarization can remain slow or flaky for long stretches. If `notarytool submit --wait` stalls for too long, prefer checking `history` / `info` manually instead of resubmitting repeatedly.
