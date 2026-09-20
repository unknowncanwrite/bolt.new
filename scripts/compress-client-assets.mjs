/**
 * Precompress the static client build so a small container does not pay to
 * compress on every request.
 *
 * `build/client` is ~16 MB of hashed JS/CSS for this app. On Render's free tier
 * (0.1 vCPU) gzipping that per request would be real work, and Cloudflare
 * Pages/CDNs compress at the edge for free, so the self-hosted Node runtime is
 * the only place that needs it. Emitting `.br`/`.gz` siblings at build time
 * turns a first visit into ~4 MB of transfer, and `server.mjs` picks the
 * smallest one the client accepts (falling back to the original for clients that
 * accept nothing).
 *
 * Originals are left in place: Vite's manifest, `<link rel=modulepreload>` and
 * any tool that reads the build output must keep seeing the real filenames.
 */
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientBuild = fileURLToPath(new URL('../build/client', import.meta.url));

const COMPRESSIBLE = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.svg', '.json', '.txt', '.map', '.wasm']);
const MIN_SIZE = 1024;

/*
 * A file is not worth compressing if it saves less than this; avoids paying
 * header overhead on already-dense assets and on tiny fragments.
 */
const MIN_SAVING_RATIO = 0.1;

async function collect(dir) {
  const out = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...(await collect(full)));
      continue;
    }

    const ext = extname(entry.name);

    // skip our own outputs and anything vite already compressed
    if (!entry.isFile() || ext === '.gz' || ext === '.br' || !COMPRESSIBLE.has(ext)) {
      continue;
    }

    const info = await stat(full);

    if (info.size < MIN_SIZE) {
      continue;
    }

    out.push({ file: full, size: info.size });
  }

  return out;
}

const GZIP_OPTIONS = { level: 9 };
const BROTLI_OPTIONS = {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_SIZE_HINT]: 0,
  },
};

async function compressOne({ file, size }) {
  const source = await readFile(file);
  const results = [];
  const gzip = gzipSync(source, GZIP_OPTIONS);
  const brotli = brotliCompressSync(source, BROTLI_OPTIONS);
  const threshold = size * (1 - MIN_SAVING_RATIO);

  if (gzip.length <= threshold) {
    await writeFile(`${file}.gz`, gzip);
    results.push({ suffix: '.gz', before: size, after: gzip.length });
  }

  // only worth a .br if it actually beats gzip, since both get written
  if (brotli.length <= threshold && brotli.length < gzip.length) {
    await writeFile(`${file}.br`, brotli);
    results.push({ suffix: '.br', before: size, after: brotli.length });
  }

  return results;
}

async function main() {
  const files = await collect(clientBuild);
  const CONCURRENCY = 8;
  const report = [];

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = await Promise.all(files.slice(i, i + CONCURRENCY).map(compressOne));
    report.push(...batch.flat());
  }

  const before = report.reduce((sum, r) => sum + r.before, 0);
  const after = report.reduce((sum, r) => sum + r.after, 0);
  const pct = before ? Math.round(((before - after) / before) * 100) : 0;

  console.log(
    `precompressed ${report.length} asset variant(s) across ${files.length} file(s): ` +
      `${(before / 1024 / 1024).toFixed(1)} MB -> ${(after / 1024 / 1024).toFixed(1)} MB (-${pct}%)`,
  );

  if (!report.length) {
    console.log('nothing met the compression threshold - is build/client present?');
  }
}

await main();
