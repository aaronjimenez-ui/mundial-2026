/**
 * Build script — ejecutado por Vercel antes de cada deploy.
 * 1. Reemplaza APP_VERSION en index.html con el commit SHA corto
 * 2. Actualiza mundial_config.app_version en Supabase con el mismo valor
 *
 * Vercel provee VERCEL_GIT_COMMIT_SHA automáticamente.
 * Usa SUPABASE_SERVICE_ROLE_KEY si está disponible; si no, cae a la anon key
 * (con policy RLS anon_update_app_version en mundial_config).
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
// Usa service_role_key si está disponible, si no cae a anon key (policy RLS permite UPDATE en key='app_version')
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rcXdnc2pob3NmY2RwdXRweGx3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNzI2MTcsImV4cCI6MjA5MDY0ODYxN30.pZGeFbydGY6ilUhwNX77ax5HEmed0gSBUIoNOvW1kPE';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ANON_KEY;
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log('[build] Usando SUPABASE_SERVICE_ROLE_KEY');
} else {
  console.log('[build] SUPABASE_SERVICE_ROLE_KEY no configurada — usando anon key (RLS policy activa)');
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
