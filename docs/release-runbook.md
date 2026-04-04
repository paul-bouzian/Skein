# ThreadEx Release Runbook

This file captures the current release state, the active Apple notarization submissions, and the exact commands to continue the release without rediscovering context.

## Current State

- Repository version on `main`: `0.1.1`
- Release commit on `main`: `8770b31`
- Git tag already pushed: `v0.1.1`
- GitHub release for `v0.1.1`: not created yet
- GitHub Actions release path: currently blocked by GitHub account billing / spending-limit state, so the release is being finished locally on macOS

## Active Apple Notarization Submissions

Two Developer ID submissions currently exist for the same app family:

1. Current submission to follow:
   - `941e7c7f-c23b-4f4e-afed-56247a2de964`
   - created at `2026-04-04T13:55:04.841Z`
   - archive name: `ThreadEx-notary.zip`

2. Older submission from the overnight GitHub Actions attempt:
   - `29f36548-c46e-4549-93d4-40e62919a6a0`
   - created at `2026-04-04T00:37:00.637Z`
   - archive name: `ThreadEx.zip`

Important:

- The current installed `xcrun notarytool` does not expose a `cancel` subcommand.
- The old submission does not have to be cancelled to continue the new one.
- For practical purposes, only track `941e7c7f-c23b-4f4e-afed-56247a2de964`.

## Local Files Used For Release

These are the local inputs currently used on Paul's Mac:

- Developer ID certificate export:
  - `~/Documents/threadex-developer-id.p12`
- App Store Connect API key:
  - `~/Downloads/AuthKey_UFWK7GV2CY.p8`
- Tauri updater private key:
  - `~/.threadex/release/threadex-updater.key`
- Tauri updater private key password:
  - `~/.threadex/release/tauri-updater-password.txt`

Local output paths after a successful release build:

- signed release app bundle:
  - `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ThreadEx.app`
- updater tarball:
  - `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ThreadEx.app.tar.gz`
- updater signature:
  - `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ThreadEx.app.tar.gz.sig`

## How To Check Notarization Status

### Show all recent submissions

```bash
xcrun notarytool history \
  --key "$HOME/Downloads/AuthKey_UFWK7GV2CY.p8" \
  --key-id UFWK7GV2CY \
  --issuer 4a94b332-af47-4acc-a708-5b19fae42334 \
  --output-format json
```

### Check the current submission only

```bash
xcrun notarytool info 941e7c7f-c23b-4f4e-afed-56247a2de964 \
  --key "$HOME/Downloads/AuthKey_UFWK7GV2CY.p8" \
  --key-id UFWK7GV2CY \
  --issuer 4a94b332-af47-4acc-a708-5b19fae42334 \
  --output-format json
```

### Poll in a loop every 20 seconds

```bash
while true; do
  clear
  date
  xcrun notarytool info 941e7c7f-c23b-4f4e-afed-56247a2de964 \
    --key "$HOME/Downloads/AuthKey_UFWK7GV2CY.p8" \
    --key-id UFWK7GV2CY \
    --issuer 4a94b332-af47-4acc-a708-5b19fae42334 \
    --output-format json
  sleep 20
done
```

### Retrieve the notarization log after completion

Use this only once the submission is no longer `In Progress`:

```bash
xcrun notarytool log 941e7c7f-c23b-4f4e-afed-56247a2de964 \
  --key "$HOME/Downloads/AuthKey_UFWK7GV2CY.p8" \
  --key-id UFWK7GV2CY \
  --issuer 4a94b332-af47-4acc-a708-5b19fae42334
```

## What Was Already Verified

Before the local notarization submission was started, the following already passed locally:

```bash
bun run verify
cargo test --manifest-path src-tauri/Cargo.toml
```

The release bundle is also already signed correctly. This was verified with:

```bash
codesign -dv --verbose=4 src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ThreadEx.app
```

Expected authority chain includes:

- `Developer ID Application: Paul Bouzian (9ZYQ4G954D)`
- `Developer ID Certification Authority`
- `Apple Root CA`

## Important Implementation Detail

When using a temporary keychain for local signing, the `Developer ID G2` intermediate certificate must also be present. Otherwise `security find-identity -v -p codesigning` may report `0 valid identities found` even though the `.p12` import succeeded.

Working fix:

```bash
curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -o "$TMPDIR/DeveloperIDG2CA.cer"
security import "$TMPDIR/DeveloperIDG2CA.cer" -k "$KEYCHAIN_PATH"
```

## How To Finish The Release Once Apple Accepts The Submission

1. Staple the accepted notarization ticket to the app bundle:

```bash
xcrun stapler staple src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ThreadEx.app
```

2. Build local release artifacts:

```bash
mkdir -p release-artifacts release-artifacts/dmg-root
ditto src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ThreadEx.app \
  release-artifacts/dmg-root/ThreadEx.app
ditto -c -k --keepParent \
  src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ThreadEx.app \
  release-artifacts/ThreadEx.zip
hdiutil create \
  -volname "ThreadEx" \
  -srcfolder release-artifacts/dmg-root \
  -ov \
  -format UDZO \
  release-artifacts/ThreadEx_0.1.1_aarch64.dmg
COPYFILE_DISABLE=1 tar -czf \
  release-artifacts/ThreadEx.app.tar.gz \
  -C src-tauri/target/aarch64-apple-darwin/release/bundle/macos \
  ThreadEx.app
```

3. Sign the updater tarball:

```bash
bun run tauri signer sign -- \
  -f "$HOME/.threadex/release/threadex-updater.key" \
  -p "$(cat "$HOME/.threadex/release/tauri-updater-password.txt")" \
  release-artifacts/ThreadEx.app.tar.gz
```

4. Generate release notes:

```bash
gh api "repos/paul-bouzian/ThreadEx/releases/generate-notes" \
  -X POST \
  -F "tag_name=v0.1.1" \
  -F "target_commitish=$(git rev-parse HEAD)" \
  --jq .body > release-artifacts/release-notes.md
```

5. Generate `latest.json` for the Tauri updater:

```bash
python3 <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path

repo = "paul-bouzian/ThreadEx"
version = "0.1.1"
tag = "v0.1.1"
notes = Path("release-artifacts/release-notes.md").read_text().strip()
signature = Path("release-artifacts/ThreadEx.app.tar.gz.sig").read_text().strip()
payload = {
  "version": version,
  "notes": notes,
  "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "platforms": {
    "darwin-aarch64": {
      "signature": signature,
      "url": f"https://github.com/{repo}/releases/download/{tag}/ThreadEx.app.tar.gz",
    }
  },
}
Path("release-artifacts/latest.json").write_text(json.dumps(payload, indent=2) + "\n")
PY
```

6. Publish the GitHub release:

```bash
gh release create v0.1.1 \
  --title "ThreadEx v0.1.1" \
  --notes-file release-artifacts/release-notes.md \
  --target "$(git rev-parse HEAD)" \
  release-artifacts/ThreadEx.zip \
  release-artifacts/ThreadEx_0.1.1_aarch64.dmg \
  release-artifacts/ThreadEx.app.tar.gz \
  release-artifacts/ThreadEx.app.tar.gz.sig \
  release-artifacts/latest.json
```

If the release already exists:

```bash
gh release edit v0.1.1 \
  --title "ThreadEx v0.1.1" \
  --notes-file release-artifacts/release-notes.md

gh release upload v0.1.1 \
  release-artifacts/ThreadEx.zip \
  release-artifacts/ThreadEx_0.1.1_aarch64.dmg \
  release-artifacts/ThreadEx.app.tar.gz \
  release-artifacts/ThreadEx.app.tar.gz.sig \
  release-artifacts/latest.json \
  --clobber
```

## Known External Blockers

### GitHub Actions billing hold

At the time of writing, GitHub-hosted Actions jobs are refusing to start with this annotation:

`The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings`

That is why the release is being finished locally for now.

### Apple notarization delays

The current behavior is not healthy:

- the old submission has been stuck for many hours
- the current submission has also remained `In Progress` far longer than expected

This appears to be at least partially consistent with broader Apple notary service instability reports in late 2025 / early 2026.
