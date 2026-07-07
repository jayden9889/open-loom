#!/usr/bin/env node
/**
 * Download static ffmpeg + ffprobe builds for the current platform into a
 * destination directory (default: the OS app-support bin dir the app checks).
 *
 * Usage: node scripts/fetch-ffmpeg.mjs [--dest <dir>]
 *
 * Integrity: macOS artifacts are pinned to a specific martin-riedl.de build and
 * verified against a hardcoded SHA256 BEFORE anything is extracted, chmod'd or
 * run; a mismatch aborts and deletes the partial download. Windows (BtbN) and
 * Linux (johnvansickle) only publish rolling "latest"/"release" builds with no
 * stable versioned URL, so their checksums cannot be durably pinned: the
 * download-then-verify structure still runs and, when no pinned hash exists for
 * an artifact, prints the observed SHA256 and continues rather than aborting a
 * legitimate rolling build (see docs/DECISIONS.md).
 *
 * These are GPL builds downloaded by the END USER at setup time; the Open Loom
 * repo itself ships no GPL binaries (see SPEC section 1).
 *
 * Sources:
 *   macOS (arm64 + x64):  https://ffmpeg.martin-riedl.de  (pinned build, 8.1.2)
 *   Windows x64:          https://github.com/BtbN/FFmpeg-Builds/releases (rolling)
 *   Linux x64/arm64:      https://johnvansickle.com/ffmpeg/  (rolling release)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const destIdx = args.indexOf('--dest');
const dest =
  destIdx >= 0 && args[destIdx + 1]
    ? args[destIdx + 1]
    : defaultDest();

function defaultDest() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'OpenLoom', 'bin');
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'OpenLoom', 'bin');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'OpenLoom', 'bin');
}

const platform = process.platform;
const arch = process.arch;

// --- pinned macOS builds ------------------------------------------------------
// martin-riedl.de exposes stable per-build download URLs; these point at a
// specific ffmpeg 8.1.2 build rather than the rolling /redirect/latest/ path.
const MAC_BUILD = { arm64: '1783011502_8.1.2', amd64: '1783018342_8.1.2' };

// --- known-good SHA256 (captured 2026-07-07) ----------------------------------
// Keyed 'platform-arch-tool'. Entries that are present are ENFORCED (abort on
// mismatch); artifacts with no entry (rolling upstream builds) are logged and
// allowed through - see the integrity note at the top of this file.
const KNOWN_SHA256 = {
  'darwin-arm64-ffmpeg': 'ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c',
  'darwin-arm64-ffprobe': 'c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf',
  'darwin-x64-ffmpeg': 'a52ef43883f44c219766d4b3bdde4e635b35465d0b704c01c3a0566b59775df9',
  'darwin-x64-ffprobe': '5408ca588c8c72b0dde3afe676d0a7acf25ef97e55ae6eba5c7bede1cda42695',
};

function log(msg) {
  console.log(msg);
}

async function download(url, outFile) {
  log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const file = fs.createWriteStream(outFile);
  let received = 0;
  let lastPct = -10;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    file.write(Buffer.from(value));
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        log(`  ${pct}% (${(received / 1048576).toFixed(1)} MB)`);
      }
    }
  }
  await new Promise((resolve, reject) => {
    file.end(() => resolve());
    file.on('error', reject);
  });
  log(`  done (${(received / 1048576).toFixed(1)} MB)`);
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Verify a freshly downloaded archive against KNOWN_SHA256 before it is trusted.
 * On mismatch: delete the file and throw (nothing is extracted or executed).
 * When there is no pinned hash (rolling build) the observed hash is printed and
 * the download is allowed through.
 */
function verifyArchive(file, key) {
  const actual = sha256File(file);
  const expected = KNOWN_SHA256[key];
  if (!expected) {
    log(`  ! no pinned checksum for ${key} (rolling upstream build) - integrity not verified`);
    log(`    observed SHA256: ${actual}`);
    return;
  }
  if (actual !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error(
      `checksum mismatch for ${key}\n` +
        `  expected ${expected}\n` +
        `  actual   ${actual}\n` +
        `Refusing to install: the upstream artifact changed or the download was corrupted.`
    );
  }
  log(`  verified SHA256 ${actual}`);
}

function extract(archive, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  if (archive.endsWith('.zip')) {
    if (platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${archive}" -DestinationPath "${toDir}"`]);
    } else {
      execFileSync('unzip', ['-o', '-q', archive, '-d', toDir]);
    }
  } else {
    execFileSync('tar', ['-xf', archive, '-C', toDir]);
  }
}

function findBinary(dir, name) {
  const target = platform === 'win32' ? `${name}.exe` : name;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name === target) return p;
    }
  }
  return null;
}

function install(fromPath, name) {
  const target = path.join(dest, platform === 'win32' ? `${name}.exe` : name);
  fs.copyFileSync(fromPath, target);
  if (platform !== 'win32') fs.chmodSync(target, 0o755);
  log(`Installed ${target}`);
}

async function main() {
  fs.mkdirSync(dest, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openloom-ffmpeg-'));
  try {
    if (platform === 'darwin') {
      // Pinned per-tool zips for macos arm64/amd64, verified before extract.
      const riedlArch = arch === 'arm64' ? 'arm64' : 'amd64';
      const build = MAC_BUILD[riedlArch];
      for (const tool of ['ffmpeg', 'ffprobe']) {
        const url = `https://ffmpeg.martin-riedl.de/download/macos/${riedlArch}/${build}/${tool}.zip`;
        const zip = path.join(tmp, `${tool}.zip`);
        await download(url, zip);
        verifyArchive(zip, `${platform}-${arch}-${tool}`);
        const exDir = path.join(tmp, `${tool}-x`);
        extract(zip, exDir);
        const bin = findBinary(exDir, tool);
        if (!bin) throw new Error(`${tool} not found inside the downloaded archive`);
        install(bin, tool);
      }
    } else if (platform === 'win32') {
      // BtbN publishes only a rolling "latest" GPL build (no stable versioned URL).
      const url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
      const zip = path.join(tmp, 'ffmpeg.zip');
      await download(url, zip);
      verifyArchive(zip, `${platform}-${arch}-bundle`);
      const exDir = path.join(tmp, 'x');
      extract(zip, exDir);
      for (const tool of ['ffmpeg', 'ffprobe']) {
        const bin = findBinary(exDir, tool);
        if (!bin) throw new Error(`${tool} not found inside the downloaded archive`);
        install(bin, tool);
      }
    } else if (platform === 'linux') {
      // johnvansickle publishes only a rolling "release" static build (no versioned URL).
      const jvArch = arch === 'arm64' ? 'arm64' : 'amd64';
      const url = `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${jvArch}-static.tar.xz`;
      const tar = path.join(tmp, 'ffmpeg.tar.xz');
      await download(url, tar);
      verifyArchive(tar, `${platform}-${arch}-bundle`);
      const exDir = path.join(tmp, 'x');
      extract(tar, exDir);
      for (const tool of ['ffmpeg', 'ffprobe']) {
        const bin = findBinary(exDir, tool);
        if (!bin) throw new Error(`${tool} not found inside the downloaded archive`);
        install(bin, tool);
      }
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // Verify the installed binary actually runs on this machine.
    const ffmpegBin = path.join(dest, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const version = execFileSync(ffmpegBin, ['-version'], { encoding: 'utf8' }).split('\n')[0];
    log(`Verified: ${version}`);
    log(`ffmpeg + ffprobe installed to ${dest}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
