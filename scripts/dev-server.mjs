// Static dev server for the viewer.
// Files missing from this repo (site-nav.js, images/logo.png, the other site pages) are looked up in the
// website folder, so the page shows the real BVKsound header, logo and menu while developing.
//   node scripts/dev-server.mjs [port]        SITE_DIR=/path/to/website to override the default location
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = resolve(process.env.SITE_DIR ?? join(root, '..', 'DecibelMeter', 'website'));
const port = Number(process.argv[2] ?? process.env.PORT ?? 8000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function find(pathname) {
  for (const base of [root, siteDir]) {
    const file = normalize(join(base, pathname));
    if (file !== base && !file.startsWith(base + sep)) continue; // no path traversal
    try {
      return { file, body: await readFile(file) };
    } catch {
      /* try the next folder */
    }
  }
  return null;
}

createServer(async (req, res) => {
  let { pathname } = new URL(req.url, 'http://localhost');
  pathname = decodeURIComponent(pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const hit = await find(pathname);
  if (!hit) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(hit.file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(hit.body);
}).listen(port, () => console.log(`http://localhost:${port}  (site files from ${siteDir})`));
