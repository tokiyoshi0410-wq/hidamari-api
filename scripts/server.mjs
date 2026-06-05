// ヒダマリ 建物データ API（デモ用・LAN 公開）。
// GET /buildings?lat=&lng=&radius=  →  { center, city, count, buildings:[{id,heightM,footprint:[{lat,lng}]}] }
// 位置から該当 Flateau 都市を判定し、初回はその都市 parquet をローカルキャッシュ、以後はローカル即時 bbox クエリ。
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import duckdb from 'duckdb';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DATA_DIR || `${HERE}/..`; // cities-index.json はパッケージ直下（コンテナでも解決）
const INDEX = `${ROOT}/cities-index.json`;
const CACHE = process.env.CACHE_DIR || `${ROOT}/.cache`;
const PORT = process.env.PORT || 8787;
mkdirSync(CACHE, { recursive: true });

const db = new duckdb.Database(':memory:');
const con = db.connect();
const exec = (s) => new Promise((r, j) => con.exec(s, (e) => (e ? j(e) : r())));
const all = (s) => new Promise((r, j) => con.all(s, (e, x) => (e ? j(e) : r(x))));
await exec('INSTALL spatial'); await exec('LOAD spatial');

function loadIndex() {
  try { return JSON.parse(readFileSync(INDEX, 'utf8')); } catch { return null; }
}
// bbox に含む都市を「中心が近い順」で全部返す（区の bbox は重なるため単一選択は誤ルートする）。
function pickCandidates(index, lat, lng) {
  return index
    .filter((c) => lng >= c.minLng && lng <= c.maxLng && lat >= c.minLat && lat <= c.maxLat)
    .map((c) => ({ c, d: ((c.minLng + c.maxLng) / 2 - lng) ** 2 + ((c.minLat + c.maxLat) / 2 - lat) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.c);
}
const inflight = new Map(); // code -> Promise<localPath>（同一都市の同時DLを1本化）
async function ensureCached(city) {
  const local = `${CACHE}/${city.code}.parquet`;
  if (existsSync(local)) return local;
  if (inflight.has(city.code)) return inflight.get(city.code);
  const p = (async () => {
    const resp = await fetch(city.url);
    if (!resp.ok) throw new Error(`download ${city.code} failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const tmp = `${local}.tmp.${process.pid}`;
    writeFileSync(tmp, buf);
    renameSync(tmp, local); // 原子的に差し替え（破損キャッシュ防止）
    return local;
  })().finally(() => inflight.delete(city.code));
  inflight.set(city.code, p);
  return p;
}
function exteriorRing(geojson) {
  const g = JSON.parse(geojson);
  let ring;
  if (g.type === 'Polygon') ring = g.coordinates[0];
  else if (g.type === 'MultiPolygon') ring = g.coordinates[0][0];
  else return null;
  return ring.map(([lng, lat]) => ({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }));
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/buildings') { res.writeHead(404).end('{}'); return; }
  const index = loadIndex();
  if (!index) { res.writeHead(503).end(JSON.stringify({ error: 'index building, retry shortly' })); return; }
  const lat = +u.searchParams.get('lat'), lng = +u.searchParams.get('lng');
  const radius = Math.min(2000, +u.searchParams.get('radius') || 1200);
  if (!isFinite(lat) || !isFinite(lng)) { res.writeHead(400).end(JSON.stringify({ error: 'lat/lng required' })); return; }
  const candidates = pickCandidates(index, lat, lng);
  if (candidates.length === 0) { res.end(JSON.stringify({ center: { lat, lng }, city: null, count: 0, buildings: [], note: 'PLATEAU未収録エリア' })); return; }
  const dLat = radius / 111320, dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  try {
    let used = candidates[0], buildings = [];
    for (const city of candidates.slice(0, 4)) {
      const local = await ensureCached(city);
      const rows = await all(
        `SELECT CAST(gml_id AS VARCHAR) AS id, measured_height AS h, ST_AsGeoJSON(GEOM) AS gj
         FROM read_parquet('${local.replace(/'/g, "''")}')
         WHERE measured_height >= 5
           AND cal_xmax >= ${lng - dLng} AND cal_xmin <= ${lng + dLng}
           AND cal_ymax >= ${lat - dLat} AND cal_ymin <= ${lat + dLat}
         ORDER BY measured_height DESC
         LIMIT 600`,
      );
      const bs = [];
      for (const r of rows) {
        const fp = exteriorRing(r.gj);
        if (fp && fp.length >= 3) bs.push({ id: r.id, heightM: Math.round(Number(r.h) * 10) / 10, footprint: fp });
      }
      if (bs.length > 0) { used = city; buildings = bs; break; } // 建物が取れた都市を採用（誤ルート対策）
    }
    res.end(JSON.stringify({ center: { lat, lng }, city: used.slug, count: buildings.length, buildings }));
  } catch (e) {
    res.writeHead(500).end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
  }
}).listen(PORT, () => console.log(`hidamari building API on http://0.0.0.0:${PORT}`));
