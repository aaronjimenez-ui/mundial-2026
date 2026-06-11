/**
 * Build script — ejecutado por Vercel antes de cada deploy.
 * 1. Reemplaza APP_VERSION en index.html con el commit SHA corto
 * 2. Actualiza mundial_config.app_version en Supabase con el mismo valor
 *
 * Requiere env var: SUPABASE_SERVICE_ROLE_KEY (configurar en Vercel dashboard)
 * Vercel provee VERCEL_GIT_COMMIT_SHA automáticamente.
 */

const fs = require('fs');
const https = require('https');

const sha = process.env.VERCEL_GIT_COMMIT_SHA;
if (!sha) {
  console.log('[build] No VERCEL_GIT_COMMIT_SHA — skipping version bump (local build)');
  process.exit(0);
}

const version = sha.slice(0, 8);
console.log(`[build] APP_VERSION → ${version}`);

// 1. Parchear index.html
const html = fs.readFileSync('index.html', 'utf8');
const patched = html.replace(/const APP_VERSION = '[^']*'/, `const APP_VERSION = '${version}'`);
if (patched === html) {
  console.error('[build] ERROR: patrón APP_VERSION no encontrado en index.html');
  process.exit(1);
}
fs.writeFileSync('index.html', patched);
console.log('[build] index.html parchado');

// 2. Actualizar Supabase — si falla, abortar deploy (evita infinite reload loop)
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) {
  console.error('[build] ERROR: SUPABASE_SERVICE_ROLE_KEY no configurada — abortando deploy');
  console.error('[build] Sin esto, APP_VERSION en código ≠ DB → infinite reload loop para todos los usuarios');
  process.exit(1);
}

const payload = JSON.stringify({ value: version });

function patchSupabase() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'okqwgsjhosfcdputpxlw.supabase.co',
      path: '/rest/v1/mundial_config?key=eq.app_version',
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Length': Buffer.byteLength(payload),
        'Prefer': 'return=minimal'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

patchSupabase()
  .then(() => console.log(`[build] ✓ mundial_config.app_version = ${version}`))
  .catch(e => {
    console.error(`[build] ✗ Supabase PATCH falló: ${e.message}`);
    process.exit(1);
  });
