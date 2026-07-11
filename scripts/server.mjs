// ヒダマリ 建物データ API。
// GET /buildings?lat=&lng=&radius=  →  { center, city, count, buildings:[{id,heightM,footprint:[{lat,lng}]}] }
// 位置から該当 Flateau 都市を判定し、リモート parquet を httpfs の range リクエストで部分読みする。
// (旧方式のファイル全体ダウンロードは横浜級 245MB で 512MB 無料枠が OOM し 502 になるため廃止)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import duckdb from 'duckdb';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DATA_DIR || `${HERE}/..`; // cities-index.json はパッケージ直下（コンテナでも解決）
const INDEX = `${ROOT}/cities-index.json`;
const PORT = process.env.PORT || 8787;

const db = new duckdb.Database(':memory:');
const con = db.connect();
const exec = (s) => new Promise((r, j) => con.exec(s, (e) => (e ? j(e) : r())));
const all = (s) => new Promise((r, j) => con.all(s, (e, x) => (e ? j(e) : r(x))));
await exec('INSTALL spatial'); await exec('LOAD spatial');
await exec('INSTALL httpfs'); await exec('LOAD httpfs');
await exec("SET memory_limit='256MB'"); // 無料枠 512MB の半分で頭打ちにする

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
      const rows = await all(
        `SELECT CAST(gml_id AS VARCHAR) AS id, measured_height AS h, ST_AsGeoJSON(GEOM) AS gj
         FROM read_parquet('${city.url.replace(/'/g, "''")}')
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
