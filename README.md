# Photo Viewer

Web-based viewer for Apple Photos libraries. Reads the SQLite database and serves originals/derivatives directly — no photo copying, no macOS dependencies.

## What it does

- Browses photos and videos with infinite-scroll grid, grouped by date
- Lightbox with progressive loading (preview → full-res), zoom, pan, swipe navigation
- HEIC support: native decode on Safari, automatic JPEG conversion for other browsers
- Search by filename, date range, file type
- Map view with clustered markers and photo thumbnails (Leaflet + CartoDB dark tiles)
- Video playback with native controls

## What it needs from the library

Only three things out of the `.photoslibrary` bundle:

```
database/Photos.sqlite       SQLite database (~166MB)
originals/                   Original photos and videos
resources/derivatives/       Pre-rendered JPEG thumbnails/previews
```

Everything else (Spotlight index, WAL/SHM, ML models, CloudKit metadata) is ignored.

## Setup

After cloning, run the icon extraction script on macOS to generate the favicon and iOS home screen icon (extracted from Photos.app, gitignored):

```bash
./scripts/dump-icon.sh
```

## Quick start

### Local (macOS/Linux)

```bash
npm install

# Point to your Photos library
export PHOTOS_LIB_PATH="$HOME/Pictures/Photos Library.photoslibrary"
npm start
# → http://localhost:3000
```

Or use a `.env` file:

```bash
cp .env.example .env
# Edit .env with your library path
npm start
```

### Docker

Build for ARM64 (OpenWrt target):

```bash
./scripts/build.sh arm64
# Produces photo_viewer_latest_arm64.tar.gz (~314MB)
```

Build both ARM64 and AMD64:

```bash
./scripts/build.sh
# Produces photo_viewer_latest_arm64.tar.gz + photo_viewer_latest_amd64.tar.gz
```

Run with the library mounted at `/media`:

```bash
docker run -d \
  -p 3000:3000 \
  -v "/path/to/Photos Library.photoslibrary:/media:ro" \
  photo_viewer:latest-arm64
```

On the target device, load the image:

```bash
gzip -dc photo_viewer_latest_arm64.tar.gz | docker load
```

## Copying your Photos library

The included `copy.sh` script rsyncs only the files the app needs, skipping Spotlight indexes and other macOS-only data.

```bash
# Preview what would be copied
DRY_RUN=1 ./scripts/copy.sh ~/Pictures/Photos\ Library.photoslibrary /Volumes/USB/Photos

# Copy for real
./scripts/copy.sh ~/Pictures/Photos\ Library.photoslibrary /Volumes/USB/Photos

# Remote destination (compression auto-enabled)
./scripts/copy.sh ~/Pictures/Photos\ Library.photoslibrary user@router:/media/photos

# Stop Photos daemons for a clean snapshot
KILL_DAEMONS=1 ./scripts/copy.sh ~/Pictures/Photos\ Library.photoslibrary /Volumes/USB/Photos
```

The script auto-detects Homebrew rsync for progress display. macOS ships rsync 2.6.9 which lacks `--info=progress2` — install a modern version with `brew install rsync` if you want the nicer output.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PHOTOS_LIB_PATH` | `/media` | Path to `.photoslibrary` directory |
| `PORT` | `3000` | Server port |

## Project structure

```
server.js              Express server — API, DB queries, image serving, HEIC conversion
public/index.html      Single-file frontend (HTML + CSS + JS)
Dockerfile             Multi-stage build (node:22-alpine, ~314MB)
scripts/
  build.sh             Build Docker images and export as .tar.gz
  copy.sh              Rsync Photos library with proper excludes
  dump-icon.sh         Extract Photos.app icon as favicon (macOS only)
```

## Dependencies

- **express** v5 — HTTP server
- **better-sqlite3** — Read-only access to Photos.sqlite
- **sharp** — Thumbnail generation (serves small derivatives directly when possible)
- **heic-convert** — Pure JS HEIC→JPEG conversion for non-Safari browsers
