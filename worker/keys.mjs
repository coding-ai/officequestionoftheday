/**
 * Generate the VAPID key pair for web push. Run once:
 *
 *   node keys.mjs
 *
 * It prints two things:
 *   1. VAPID_PUBLIC_KEY  — not secret. Paste into "vars" in wrangler.jsonc.
 *   2. VAPID_PRIVATE_JWK — secret. Pipe into: wrangler secret put VAPID_PRIVATE_JWK
 *
 * Generate this ONCE and keep it. Replacing the key pair invalidates every
 * existing subscription — everyone silently stops receiving notifications and
 * has to re-grant permission, which most never will.
 */

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
);

const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
const publicKey = b64url(publicRaw);

console.log('\n── VAPID_PUBLIC_KEY ─────────────────────────────────────');
console.log('Paste into "vars" in wrangler.jsonc (this one is public):\n');
console.log(publicKey);

console.log('\n── VAPID_PRIVATE_JWK ────────────────────────────────────');
console.log('Store as a secret — never commit it:\n');
console.log('  wrangler secret put VAPID_PRIVATE_JWK\n');
console.log('and paste this single line at the prompt:\n');
console.log(JSON.stringify(privateJwk));
console.log('\n─────────────────────────────────────────────────────────');
console.log('Save both somewhere safe. Losing the private key means every');
console.log('existing subscriber silently stops receiving notifications.\n');
