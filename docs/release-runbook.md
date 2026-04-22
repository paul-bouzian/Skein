# Skein Release Runbook

This runbook is the canonical Electron release path for Skein. GitHub Releases is the source of truth for macOS distribution and `electron-updater` metadata.

## Release Target

- product name: `Skein`
- bundle id: `com.paulbouzian.skein`
- release version: `RELEASE_VERSION` from `package.json` and `desktop-backend/Cargo.toml`
- primary distribution: macOS Apple Silicon
- release flow: signed Electron build, notarized `.app`, packaged `.dmg` / `.zip`, uploaded GitHub release
- transition support: publish legacy bridge assets for pre-Electron installs

## Local Inputs

- Developer ID certificate export:
  - `${SKEIN_APPLE_CERTIFICATE_P12}`
- App Store Connect API key:
  - `${SKEIN_APPLE_API_KEY_PATH}`
- App Store Connect API key metadata:
  - `${SKEIN_APPLE_API_KEY_ID}`
  - `${SKEIN_APPLE_API_ISSUER}`

Suggested local exports:

```bash
export SKEIN_APPLE_CERTIFICATE_P12="$HOME/Documents/skein-developer-id.p12"
export SKEIN_APPLE_API_KEY_PATH="$HOME/Downloads/AuthKey_XXXXXXXXXX.p8"
export SKEIN_APPLE_API_KEY_ID="YOUR_KEY_ID"
export SKEIN_APPLE_API_ISSUER="YOUR_ISSUER_ID"
```

Before publishing, set `RELEASE_VERSION` to the exact version being shipped.

## Prepare The Release Source

Run from the repository root on `main`:

```bash
git pull --ff-only
node scripts/update-version.mjs "$RELEASE_VERSION"
bun install --frozen-lockfile
bun run verify
bun run verify:electron
cargo test --manifest-path desktop-backend/Cargo.toml
cargo clippy --manifest-path desktop-backend/Cargo.toml --all-targets -- -D warnings
```

If the repo is ready, commit the release source and tag it:

```bash
git add .
git commit -m "chore(release): cut v${RELEASE_VERSION}" -m "Co-authored-by: Codex <noreply@openai.com>"
git tag "v${RELEASE_VERSION}"
```

## Import Signing Material

If you use a temporary keychain, also import the Developer ID G2 intermediate certificate first:

```bash
curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -o "$TMPDIR/DeveloperIDG2CA.cer"
```

Then import the Developer ID certificate into the active keychain before packaging.

## Build The Signed Electron App

`electron-builder` reads signing config from `package.json`. Build the unpacked signed app first:

```bash
bun run electron:prepare
bunx electron-builder --dir --publish never
```

The unpacked app bundle should exist at:

- `release-artifacts/electron/mac-arm64/Skein.app`

## Notarize And Staple

Create the notarization archive and submit it:

```bash
ditto -c -k --keepParent \
  release-artifacts/electron/mac-arm64/Skein.app \
  release-artifacts/Skein-notary.zip

xcrun notarytool submit release-artifacts/Skein-notary.zip \
  --key "$SKEIN_APPLE_API_KEY_PATH" \
  --key-id "$SKEIN_APPLE_API_KEY_ID" \
  --issuer "$SKEIN_APPLE_API_ISSUER" \
  --wait \
  --output-format json
```

Once accepted:

```bash
xcrun stapler staple release-artifacts/electron/mac-arm64/Skein.app
```

## Package Release Artifacts

Package the notarized app into the distributable artifacts and updater metadata:

```bash
rm -rf release-artifacts/release
bunx electron-builder \
  --prepackaged "release-artifacts/electron/mac-arm64/Skein.app" \
  --mac dmg zip \
  --publish never \
  -c.directories.output=release-artifacts/release
```

Expected outputs:

- `release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.dmg`
- `release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.dmg.blockmap`
- `release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.zip`
- `release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.zip.blockmap`
- `release-artifacts/release/latest-mac.yml`

## Generate Transition Assets For Pre-Electron Installs

This step publishes the static update manifest and signed macOS app archive consumed by the legacy updater endpoint at `releases/latest/download/latest.json`.

Required inputs:

- `${LEGACY_UPDATER_PRIVATE_KEY}`
- `${LEGACY_UPDATER_PRIVATE_KEY_PASSWORD}` if the key is encrypted

`LEGACY_UPDATER_PRIVATE_KEY` must be the same updater signing key already embedded in pre-Electron installs. Rotating that key would break the automatic transition path for those users.

Generate the bridge assets:

```bash
LEGACY_UPDATER_PRIVATE_KEY="$(cat /path/to/private.key)" \
LEGACY_UPDATER_PRIVATE_KEY_PASSWORD="${LEGACY_UPDATER_PRIVATE_KEY_PASSWORD:-}" \
GITHUB_REPOSITORY="paul-bouzian/Skein" \
RELEASE_TAG="v${RELEASE_VERSION}" \
node scripts/generate-legacy-transition-artifacts.mjs "${RELEASE_VERSION}"
```

Expected outputs:

- `release-artifacts/release/Skein.app.tar.gz`
- `release-artifacts/release/Skein.app.tar.gz.sig`
- `release-artifacts/release/latest.json`

## Generate Release Notes

```bash
gh api "repos/paul-bouzian/Skein/releases/generate-notes" \
  -X POST \
  -F "tag_name=v${RELEASE_VERSION}" \
  -F "target_commitish=$(git rev-parse HEAD)" \
  --jq '.body' > release-artifacts/release-notes.md
```

## Publish The GitHub Release

```bash
gh release create "v${RELEASE_VERSION}" \
  --title "Skein v${RELEASE_VERSION}" \
  --notes-file release-artifacts/release-notes.md \
  --target "$(git rev-parse HEAD)" \
  release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.zip \
  release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.zip.blockmap \
  release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.dmg \
  release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.dmg.blockmap \
  release-artifacts/release/Skein.app.tar.gz \
  release-artifacts/release/Skein.app.tar.gz.sig \
  release-artifacts/release/latest.json \
  release-artifacts/release/latest-mac.yml
```

If the release already exists:

```bash
gh release edit "v${RELEASE_VERSION}" \
  --title "Skein v${RELEASE_VERSION}" \
  --notes-file release-artifacts/release-notes.md

gh release upload "v${RELEASE_VERSION}" \
  release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.zip \
  release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.zip.blockmap \
  release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.dmg \
  release-artifacts/release/Skein-${RELEASE_VERSION}-arm64.dmg.blockmap \
  release-artifacts/release/Skein.app.tar.gz \
  release-artifacts/release/Skein.app.tar.gz.sig \
  release-artifacts/release/latest.json \
  release-artifacts/release/latest-mac.yml \
  --clobber
```

## Validation Checklist

- `bun run verify`
- `bun run verify:electron`
- `cargo test --manifest-path desktop-backend/Cargo.toml`
- `cargo clippy --manifest-path desktop-backend/Cargo.toml --all-targets -- -D warnings`
- packaged app launches from Finder and `/Applications`
- Codex runtime works from Finder launch
- GitHub release contains `latest.json`, `Skein.app.tar.gz`, and `Skein.app.tar.gz.sig`
- GitHub release contains `latest-mac.yml`
- updater notice resolves the new GitHub release

## Known External Risk

Apple notarization can remain slow or flaky for long stretches. If `notarytool submit --wait` stalls for too long, prefer checking `history` or `info` manually instead of resubmitting repeatedly.
