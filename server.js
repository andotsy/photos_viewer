const express = require('express');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const path = require('path');
const fs = require('fs');

// Load .env file if present (no dependency needed)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

// Suppress noisy libvips/libheif warnings on stderr
process.env.VIPS_WARNING = '0';

// --- Configuration ---
// PHOTOS_LIB_PATH env var points to the .photoslibrary directory.
// In Docker, mount it to /media and leave the default.
const PHOTOS_LIB = process.env.PHOTOS_LIB_PATH || '/media';
const DB_PATH = path.join(PHOTOS_LIB, 'database', 'Photos.sqlite');
const ORIGINALS_DIR = path.join(PHOTOS_LIB, 'originals');
const DERIVATIVES_DIR = path.join(PHOTOS_LIB, 'resources', 'derivatives');
const PORT = process.env.PORT || 3000;

// Validate library path on startup
if (!fs.existsSync(DB_PATH)) {
  console.error(`\n  Error: Photos database not found at ${DB_PATH}`);
  console.error(`  Set PHOTOS_LIB_PATH to your .photoslibrary directory, e.g.:`);
  console.error(`    PHOTOS_LIB_PATH="/path/to/Photos Library.photoslibrary" npm start\n`);
  process.exit(1);
}

// Apple's Core Data epoch: 2001-01-01 00:00:00 UTC
const CORE_DATA_EPOCH = 978307200;

const app = express();

// The Photos.sqlite database uses WAL mode, which requires write access to the -shm
// file even for reads. If the library lives on a read-only filesystem (common for
// external drives and older macOS data volumes), we must copy the DB to a writable
// location. We try direct readonly open first; if that fails, we fall back to a copy.
const os = require('os');
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.prepare('SELECT 1 FROM ZASSET LIMIT 1').get(); // verify WAL access works
  console.log('Opened database directly (readonly).');
} catch {
  // Read-only filesystem or WAL lock — copy DB to temp
  const TEMP_DB = path.join(os.tmpdir(), 'photos_viewer_db.sqlite');
  console.log('Database is on a read-only filesystem, copying to temp location...');
  fs.copyFileSync(DB_PATH, TEMP_DB);
  const walPath = DB_PATH + '-wal';
  const shmPath = DB_PATH + '-shm';
  if (fs.existsSync(walPath)) fs.copyFileSync(walPath, TEMP_DB + '-wal');
  if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, TEMP_DB + '-shm');
  db = new Database(TEMP_DB, { readonly: true, fileMustExist: true });
  console.log('Database copied and opened.');

  // Cleanup temp files on exit
  const _tempDb = TEMP_DB;
  process.on('exit', () => {
    try { fs.unlinkSync(_tempDb); } catch {}
    try { fs.unlinkSync(_tempDb + '-wal'); } catch {}
    try { fs.unlinkSync(_tempDb + '-shm'); } catch {}
  });
}

// --- Prepared statements ---
const stmtPhotos = db.prepare(`
  SELECT
    a.Z_PK as id,
    a.ZUUID as uuid,
    a.ZDIRECTORY as directory,
    a.ZFILENAME as filename,
    a.ZUNIFORMTYPEIDENTIFIER as uti,
    a.ZWIDTH as width,
    a.ZHEIGHT as height,
    a.ZDATECREATED as dateCreated,
    a.ZFAVORITE as favorite,
    a.ZHIDDEN as hidden,
    a.ZTRASHEDSTATE as trashed,
    a.ZKIND as kind,
    a.ZLATITUDE as latitude,
    a.ZLONGITUDE as longitude,
    a.ZDURATION as duration,
    aa.ZORIGINALFILENAME as originalFilename
  FROM ZASSET a
  LEFT JOIN ZADDITIONALASSETATTRIBUTES aa ON aa.Z_PK = a.ZADDITIONALATTRIBUTES
  WHERE a.ZTRASHEDSTATE = 0
    AND a.ZHIDDEN = 0
    AND a.ZKIND = 0
  ORDER BY a.ZDATECREATED DESC
  LIMIT ? OFFSET ?
`);

const stmtPhotoById = db.prepare(`
  SELECT
    a.Z_PK as id,
    a.ZUUID as uuid,
    a.ZDIRECTORY as directory,
    a.ZFILENAME as filename,
    a.ZUNIFORMTYPEIDENTIFIER as uti,
    a.ZWIDTH as width,
    a.ZHEIGHT as height,
    a.ZDATECREATED as dateCreated,
    a.ZFAVORITE as favorite,
    a.ZLATITUDE as latitude,
    a.ZLONGITUDE as longitude,
    a.ZDURATION as duration,
    aa.ZORIGINALFILENAME as originalFilename
  FROM ZASSET a
  LEFT JOIN ZADDITIONALASSETATTRIBUTES aa ON aa.Z_PK = a.ZADDITIONALATTRIBUTES
  WHERE a.Z_PK = ?
`);

const stmtCount = db.prepare(`
  SELECT count(*) as total FROM ZASSET
  WHERE ZTRASHEDSTATE = 0 AND ZHIDDEN = 0 AND ZKIND = 0
`);

const stmtVideos = db.prepare(`
  SELECT
    a.Z_PK as id,
    a.ZUUID as uuid,
    a.ZDIRECTORY as directory,
    a.ZFILENAME as filename,
    a.ZUNIFORMTYPEIDENTIFIER as uti,
    a.ZWIDTH as width,
    a.ZHEIGHT as height,
    a.ZDATECREATED as dateCreated,
    a.ZFAVORITE as favorite,
    a.ZDURATION as duration,
    aa.ZORIGINALFILENAME as originalFilename
  FROM ZASSET a
  LEFT JOIN ZADDITIONALASSETATTRIBUTES aa ON aa.Z_PK = a.ZADDITIONALATTRIBUTES
  WHERE a.ZTRASHEDSTATE = 0
    AND a.ZHIDDEN = 0
    AND a.ZKIND = 1
  ORDER BY a.ZDATECREATED DESC
  LIMIT ? OFFSET ?
`);

const stmtVideoCount = db.prepare(`
  SELECT count(*) as total FROM ZASSET
  WHERE ZTRASHEDSTATE = 0 AND ZHIDDEN = 0 AND ZKIND = 1
`);

const stmtStats = db.prepare(`
  SELECT
    (SELECT count(*) FROM ZASSET WHERE ZTRASHEDSTATE = 0 AND ZHIDDEN = 0 AND ZKIND = 0) as photos,
    (SELECT count(*) FROM ZASSET WHERE ZTRASHEDSTATE = 0 AND ZHIDDEN = 0 AND ZKIND = 1) as videos,
    (SELECT count(*) FROM ZASSET WHERE ZTRASHEDSTATE = 0 AND ZHIDDEN = 0) as total
`);

// --- Helpers ---
function coreDataToUnix(timestamp) {
  if (!timestamp) return null;
  return Math.floor(timestamp + CORE_DATA_EPOCH) * 1000;
}

function formatAsset(row) {
  return {
    ...row,
    dateCreated: coreDataToUnix(row.dateCreated),
    latitude: (row.latitude && row.latitude > -180) ? row.latitude : null,
    longitude: (row.longitude && row.longitude > -180) ? row.longitude : null,
    isVideo: row.kind === 1 || (row.uti && (row.uti.includes('movie') || row.uti.includes('mpeg') || row.uti.includes('m4v'))),
  };
}

function getOriginalPath(directory, filename) {
  return path.join(ORIGINALS_DIR, directory, filename);
}

// Build an in-memory index of all derivative files at startup.
// This avoids repeated readdirSync calls per request and covers both
// derivatives/{dir}/ and derivatives/masters/{dir}/ locations.
// Each entry stores { path, size } so we can pick smallest/largest without statSync per request.
const derivativeIndex = new Map(); // uuid -> [{ path, size }]
console.log('Indexing derivative thumbnails...');
const DERIV_SUBDIRS = ['0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'];
for (const sub of DERIV_SUBDIRS) {
  // Primary derivatives: derivatives/{dir}/
  const primaryDir = path.join(DERIVATIVES_DIR, sub);
  if (fs.existsSync(primaryDir)) {
    for (const f of fs.readdirSync(primaryDir)) {
      const uuid = f.split('_')[0].split('.')[0];
      if (!derivativeIndex.has(uuid)) derivativeIndex.set(uuid, []);
      const filePath = path.join(primaryDir, f);
      try {
        const size = fs.statSync(filePath).size;
        derivativeIndex.get(uuid).push({ path: filePath, size });
      } catch { /* skip unreadable */ }
    }
  }
  // Masters derivatives: derivatives/masters/{dir}/
  const mastersDir = path.join(DERIVATIVES_DIR, 'masters', sub);
  if (fs.existsSync(mastersDir)) {
    for (const f of fs.readdirSync(mastersDir)) {
      const uuid = f.split('_')[0].split('.')[0];
      if (!derivativeIndex.has(uuid)) derivativeIndex.set(uuid, []);
      const filePath = path.join(mastersDir, f);
      try {
        const size = fs.statSync(filePath).size;
        derivativeIndex.get(uuid).push({ path: filePath, size });
      } catch { /* skip unreadable */ }
    }
  }
}
console.log(`Indexed ${derivativeIndex.size} assets with derivatives.`);

// Find smallest available derivative (for grid thumbnails) — returns path only
function findDerivative(uuid) {
  const entries = derivativeIndex.get(uuid);
  if (!entries || entries.length === 0) return null;
  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].size < best.size) best = entries[i];
  }
  return best.path;
}

// Find smallest available derivative with size info (for fast-path serving)
function findDerivativeWithSize(uuid) {
  const entries = derivativeIndex.get(uuid);
  if (!entries || entries.length === 0) return null;
  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].size < best.size) best = entries[i];
  }
  return best; // { path, size }
}

// Find largest available derivative (for preview / full-res fallback)
function findPreviewDerivative(uuid) {
  const entries = derivativeIndex.get(uuid);
  if (!entries || entries.length === 0) return null;
  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].size > best.size) best = entries[i];
  }
  return best.path;
}

// In-memory LRU cache for generated thumbnails
const thumbCache = new Map();
const CACHE_MAX = 500;

function cacheSet(key, buffer) {
  if (thumbCache.size >= CACHE_MAX) {
    const firstKey = thumbCache.keys().next().value;
    thumbCache.delete(firstKey);
  }
  thumbCache.set(key, buffer);
}

// --- HEIC to JPEG conversion (portable, pure JS) ---
// Disk cache for converted HEICs (avoids re-converting on every request)
const HEIC_CACHE_DIR = path.join(require('os').tmpdir(), 'photo_viewer_heic_cache');
if (!fs.existsSync(HEIC_CACHE_DIR)) fs.mkdirSync(HEIC_CACHE_DIR, { recursive: true });
console.log(`HEIC conversion cache: ${HEIC_CACHE_DIR}`);

async function convertHeicToJpeg(origPath, uuid) {
  const cachePath = path.join(HEIC_CACHE_DIR, uuid + '.jpg');
  if (fs.existsSync(cachePath)) return cachePath;

  const inputBuffer = fs.readFileSync(origPath);
  const outputBuffer = await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.92
  });
  fs.writeFileSync(cachePath, outputBuffer);
  return cachePath;
}

// --- API Routes ---
app.get('/api/stats', (req, res) => {
  res.json(stmtStats.get());
});

app.get('/api/photos', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 80, 200);
  const offset = parseInt(req.query.offset) || 0;
  const { total } = stmtCount.get();
  const rows = stmtPhotos.all(limit, offset).map(formatAsset);
  res.json({ items: rows, total, limit, offset });
});

app.get('/api/videos', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 80, 200);
  const offset = parseInt(req.query.offset) || 0;
  const { total } = stmtVideoCount.get();
  const rows = stmtVideos.all(limit, offset).map(formatAsset);
  res.json({ items: rows, total, limit, offset });
});

// Serve thumbnail - uses derivative if available, generates with sharp otherwise
app.get('/api/thumb/:id', async (req, res) => {
  try {
    const row = stmtPhotoById.get(parseInt(req.params.id));
    if (!row) return res.status(404).send('Not found');

    const size = parseInt(req.query.size) || 300;
    const cacheKey = `${row.id}_${size}`;

    // Check memory cache
    if (thumbCache.has(cacheKey)) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(thumbCache.get(cacheKey));
    }

    // Always try pre-rendered derivative first (covers HEIC without needing libheif)
    const deriv = findDerivativeWithSize(row.uuid);
    if (deriv) {
      // Fast path: serve derivative directly without sharp resize.
      // Even a 1024x768 JPEG (~190KB) is faster to send than to run through sharp.
      // Browser GPU will downsample to grid cell size in hardware.
      // Only use sharp for very large derivatives (>500KB, typically 1920px+)
      if (deriv.size < 500000) {
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.sendFile(deriv.path);
      }
      try {
        // Resize derivative to requested size via sharp (derivatives are JPEG, sharp handles those fine)
        const buffer = await sharp(deriv.path)
          .resize(size, size, { fit: 'cover' })
          .jpeg({ quality: 75 })
          .toBuffer();
        cacheSet(cacheKey, buffer);
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      } catch {
        // Derivative exists but sharp failed on it - serve it raw
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.sendFile(deriv.path);
      }
    }

    // No derivative - try generating from original (works for JPEG/PNG/TIFF, may fail for HEIC)
    const origPath = getOriginalPath(row.directory, row.filename);
    if (!fs.existsSync(origPath)) {
      return res.status(404).send('Original file not found');
    }

    const buffer = await sharp(origPath, { failOn: 'none' })
      .rotate()
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 75 })
      .toBuffer();

    cacheSet(cacheKey, buffer);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    // Return a 1x1 transparent pixel so the UI doesn't break
    const pixel = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//',
      'base64'
    );
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(pixel);
  }
});

// Serve preview-quality photo (largest available derivative, fast)
app.get('/api/preview/:id', async (req, res) => {
  try {
    const row = stmtPhotoById.get(parseInt(req.params.id));
    if (!row) return res.status(404).send('Not found');

    // Try largest derivative first
    const derivPath = findPreviewDerivative(row.uuid);
    if (derivPath) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(derivPath);
    }

    // No derivative — try to generate a mid-res version from original
    const origPath = getOriginalPath(row.directory, row.filename);
    if (!fs.existsSync(origPath)) {
      return res.status(404).send('Not found');
    }

    // For JPEG/PNG serve directly (they're already fast to decode)
    if (row.uti === 'public.jpeg' || row.uti === 'public.png') {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(origPath);
    }

    // For other formats, try sharp at reduced resolution
    try {
      const buffer = await sharp(origPath, { failOn: 'none' })
        .rotate()
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    } catch {
      return res.status(404).send('No preview available');
    }
  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).send('Error loading preview');
  }
});

// Serve full-size photo (converted to JPEG for HEIC, passthrough for JPEG/PNG)
app.get('/api/photo/:id', async (req, res) => {
  try {
    const row = stmtPhotoById.get(parseInt(req.params.id));
    if (!row) return res.status(404).send('Not found');

    const origPath = getOriginalPath(row.directory, row.filename);
    if (!fs.existsSync(origPath)) {
      return res.status(404).send('Original file not found');
    }

    // For JPEG and PNG, serve directly
    if (row.uti === 'public.jpeg') {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(origPath);
    }
    if (row.uti === 'public.png') {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(origPath);
    }

    // For HEIC — check if client wants JPEG conversion (browsers that can't decode HEIC)
    if (row.uti === 'public.heic') {
      if (req.query.format === 'jpeg') {
        // Convert HEIC → full-quality JPEG (cached on disk)
        try {
          const jpegPath = await convertHeicToJpeg(origPath, row.uuid);
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'public, max-age=86400');
          return res.sendFile(jpegPath);
        } catch (err) {
          console.error('HEIC conversion failed for', row.uuid, err.message);
          // Fall back to best derivative
          const derivPath = findPreviewDerivative(row.uuid);
          if (derivPath) {
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=86400');
            res.set('X-Quality', 'derivative');
            return res.sendFile(derivPath);
          }
          return res.status(500).send('HEIC conversion failed');
        }
      }
      // Default: serve original HEIC (Safari/iOS can decode natively)
      res.set('Content-Type', 'image/heic');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(origPath);
    }

    // For TIFF/etc - try sharp first, fall back to largest derivative
    const maxDim = parseInt(req.query.maxDim) || 4000;
    try {
      const buffer = await sharp(origPath, { failOn: 'none' })
        .rotate()
        .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();

      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    } catch {
      // sharp can't decode this format - serve best available derivative
      const derivPath = findPreviewDerivative(row.uuid);
      if (derivPath) {
        // Signal to the client that this is only derivative quality
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('X-Quality', 'derivative');
        return res.sendFile(derivPath);
      }
      return res.status(500).send('Cannot decode this image format');
    }
  } catch (err) {
    console.error('Photo error:', err.message);
    res.status(500).send('Error processing photo');
  }
});

// Serve video file with range request support
app.get('/api/video/:id', (req, res) => {
  try {
    const row = stmtPhotoById.get(parseInt(req.params.id));
    if (!row) return res.status(404).send('Not found');

    const origPath = getOriginalPath(row.directory, row.filename);
    if (!fs.existsSync(origPath)) {
      return res.status(404).send('File not found');
    }

    const stat = fs.statSync(origPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const mimeTypes = {
      'com.apple.quicktime-movie': 'video/quicktime',
      'public.mpeg-4': 'video/mp4',
      'com.apple.m4v-video': 'video/x-m4v',
    };
    const contentType = mimeTypes[row.uti] || 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(origPath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(origPath).pipe(res);
    }
  } catch (err) {
    console.error('Video error:', err.message);
    res.status(500).send('Error streaming video');
  }
});

// --- Search API ---
app.get('/api/search', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 80, 200);
  const offset = parseInt(req.query.offset) || 0;
  const q = (req.query.q || '').trim();
  const from = req.query.from || '';  // ISO date string e.g. "2020-01-01"
  const to = req.query.to || '';      // ISO date string e.g. "2025-12-31"
  const type = (req.query.type || '').toLowerCase(); // photo, video, heic, jpeg, png, gif

  let where = ['a.ZTRASHEDSTATE = 0', 'a.ZHIDDEN = 0'];
  let params = [];

  // Filename search (case-insensitive LIKE on both filename and original filename)
  if (q) {
    where.push('(a.ZFILENAME LIKE ? OR aa.ZORIGINALFILENAME LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  // Date range filter (convert ISO date to Core Data timestamp)
  if (from) {
    const fromTs = (new Date(from).getTime() / 1000) - CORE_DATA_EPOCH;
    where.push('a.ZDATECREATED >= ?');
    params.push(fromTs);
  }
  if (to) {
    // End of day: add 86400 seconds (one day)
    const toTs = (new Date(to).getTime() / 1000) - CORE_DATA_EPOCH + 86400;
    where.push('a.ZDATECREATED < ?');
    params.push(toTs);
  }

  // File type filter
  const typeFilters = {
    photo: 'a.ZKIND = 0',
    video: 'a.ZKIND = 1',
    heic: "a.ZUNIFORMTYPEIDENTIFIER = 'public.heic'",
    jpeg: "a.ZUNIFORMTYPEIDENTIFIER = 'public.jpeg'",
    png: "a.ZUNIFORMTYPEIDENTIFIER = 'public.png'",
    gif: "a.ZUNIFORMTYPEIDENTIFIER = 'com.compuserve.gif'",
    tiff: "a.ZUNIFORMTYPEIDENTIFIER = 'public.tiff'",
  };
  if (type && typeFilters[type]) {
    where.push(typeFilters[type]);
  }

  const whereClause = where.join(' AND ');

  const countSql = `
    SELECT count(*) as total FROM ZASSET a
    LEFT JOIN ZADDITIONALASSETATTRIBUTES aa ON aa.Z_PK = a.ZADDITIONALATTRIBUTES
    WHERE ${whereClause}
  `;

  const querySql = `
    SELECT
      a.Z_PK as id,
      a.ZUUID as uuid,
      a.ZDIRECTORY as directory,
      a.ZFILENAME as filename,
      a.ZUNIFORMTYPEIDENTIFIER as uti,
      a.ZWIDTH as width,
      a.ZHEIGHT as height,
      a.ZDATECREATED as dateCreated,
      a.ZFAVORITE as favorite,
      a.ZHIDDEN as hidden,
      a.ZTRASHEDSTATE as trashed,
      a.ZKIND as kind,
      a.ZLATITUDE as latitude,
      a.ZLONGITUDE as longitude,
      a.ZDURATION as duration,
      aa.ZORIGINALFILENAME as originalFilename
    FROM ZASSET a
    LEFT JOIN ZADDITIONALASSETATTRIBUTES aa ON aa.Z_PK = a.ZADDITIONALATTRIBUTES
    WHERE ${whereClause}
    ORDER BY a.ZDATECREATED ${(from || to) ? 'ASC' : 'DESC'}
    LIMIT ? OFFSET ?
  `;

  try {
    const { total } = db.prepare(countSql).get(...params);
    const rows = db.prepare(querySql).all(...params, limit, offset).map(formatAsset);
    res.json({ items: rows, total, limit, offset });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// --- Geo/Map API ---
// Returns all geotagged photos with minimal data for map markers
// Uses a single query (no pagination) — ~11k rows, ~1MB JSON, fast enough
const stmtGeoPhotos = db.prepare(`
  SELECT
    a.Z_PK as id,
    a.ZUUID as uuid,
    a.ZLATITUDE as latitude,
    a.ZLONGITUDE as longitude,
    a.ZDATECREATED as dateCreated,
    a.ZKIND as kind
  FROM ZASSET a
  WHERE a.ZTRASHEDSTATE = 0
    AND a.ZHIDDEN = 0
    AND a.ZLATITUDE IS NOT NULL
    AND a.ZLONGITUDE IS NOT NULL
    AND a.ZLATITUDE > -180
    AND a.ZLONGITUDE > -180
  ORDER BY a.ZDATECREATED DESC
`);

let geoPhotosCache = null;
let geoCacheTime = 0;

app.get('/api/geo-photos', (req, res) => {
  // Cache for 60s to avoid re-querying
  const now = Date.now();
  if (!geoPhotosCache || now - geoCacheTime > 60000) {
    const rows = stmtGeoPhotos.all().map(r => ({
      id: r.id,
      lat: r.latitude,
      lng: r.longitude,
      date: coreDataToUnix(r.dateCreated),
      isVideo: r.kind === 1,
    }));
    geoPhotosCache = { markers: rows, total: rows.length };
    geoCacheTime = now;
  }
  res.json(geoPhotosCache);
});

// Serve original file as download
app.get('/api/download/:id', (req, res) => {
  try {
    const row = stmtPhotoById.get(parseInt(req.params.id));
    if (!row) return res.status(404).send('Not found');

    const origPath = getOriginalPath(row.directory, row.filename);
    if (!fs.existsSync(origPath)) {
      return res.status(404).send('Original file not found');
    }

    const downloadName = row.originalFilename || row.filename || 'photo';
    res.set('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(origPath);
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).send('Error downloading file');
  }
});

// --- Serve frontend ---
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ---
app.listen(PORT, () => {
  const stats = stmtStats.get();
  console.log(`\n  Photos Viewer running at http://localhost:${PORT}`);
  console.log(`  Library: ${PHOTOS_LIB}`);
  console.log(`  ${stats.photos} photos, ${stats.videos} videos, ${stats.favorites} favorites\n`);
});

// Cleanup
function cleanup() {
  db.close();
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
