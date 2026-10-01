#!/usr/bin/env bash
# Preflight. Run from worker/ :   bash check.sh
#
# Catches the failures that stay invisible until several stages later:
# a second config file silently winning, a database_id pointing at nothing,
# secrets on the wrong Worker, API_BASE set in two of the three places.

set -uo pipefail

# Run from anywhere: every path below is relative to this script's own folder.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
ok=0; bad=0; warn=0
pass(){ printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
fail(){ printf '  \033[31m✗\033[0m %s\n' "$1"; bad=$((bad+1)); }
note(){ printf '  \033[33m○\033[0m %s\n' "$1"; warn=$((warn+1)); }
info(){ printf '    %s\n' "$1"; }

ROOT=..

echo
echo "── config resolution ───────────────────────────────"

# Exactly one config here. Wrangler prefers jsonc > json > toml, silently.
here=$(ls wrangler.jsonc wrangler.json wrangler.toml 2>/dev/null | tr '\n' ' ')
n=$(echo "$here" | wc -w | tr -d ' ')
if [ "$n" -eq 1 ] && [ -f wrangler.jsonc ]; then
  pass "worker/: one config (wrangler.jsonc)"
else
  fail "worker/: expected only wrangler.jsonc, found: ${here:-none}"
fi

# And none above — a config in a parent directory is what broke this before.
strays=$(ls "$ROOT"/wrangler.* "$ROOT"/../wrangler.* 2>/dev/null | tr '\n' ' ')
if [ -n "$strays" ]; then
  fail "config in a parent directory: $strays"
  info "wrangler searches upward — delete these"
else
  pass "no config in parent directories"
fi

if sed 's|//.*||' wrangler.jsonc 2>/dev/null | grep -q '"assets"'; then
  fail "\"assets\" block present — remove it; this Worker is code only"
  info "an assets Worker silently cannot hold secrets or be tailed"
else
  pass "no assets block"
fi

resolved=$(wrangler deploy --dry-run 2>&1 | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -z "$resolved" ] && resolved=$(sed 's|//.*||' wrangler.jsonc | grep -oE '"name"[^,]*' | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$resolved" = "oqotd-api" ]; then
  pass "resolves to oqotd-api"
else
  fail "resolves to \"${resolved:-unknown}\", expected oqotd-api"
fi

echo
echo "── database ────────────────────────────────────────"

if grep -q 'PASTE_DATABASE_ID_HERE' wrangler.jsonc 2>/dev/null; then
  fail "database_id is still the placeholder"
  info "wrangler d1 create oqotd   then paste the UUID"
else
  cfg=$(sed 's|//.*||' wrangler.jsonc | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)
  dupes=$(sed 's|//.*||' wrangler.jsonc | grep -cE '"database_id"')
  live=$(wrangler d1 list 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)
  if [ "$dupes" -gt 1 ]; then
    fail "wrangler.jsonc has $dupes database_id lines — delete all but one"
  fi
  if [ -n "$cfg" ] && [ "$cfg" = "$live" ]; then
    pass "database_id matches the live oqotd database"
  elif [ -z "$live" ]; then
    fail "no D1 database in this account — wrangler d1 create oqotd"
  else
    fail "database_id MISMATCH  (config $cfg / account $live)"
  fi
fi

# Look for the table NAMES in the output rather than parsing a count — wrangler's
# output format varies between versions and the timing line contains digits too.
tbl_out=$(wrangler d1 execute oqotd --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" 2>/dev/null)
missing=""
for t in country_tallies events push_subs questions room_tallies rooms schedule tallies votes; do
  echo "$tbl_out" | grep -q "\b$t\b" || missing="$missing $t"
done
if [ -z "$missing" ]; then
  pass "schema applied (all 9 tables present)"
else
  fail "missing tables:$missing"
  info "wrangler d1 execute oqotd --remote --file=./schema.sql"
fi

q_out=$(wrangler d1 execute oqotd --remote --command \
  "SELECT genre, COUNT(*) AS n FROM questions GROUP BY genre" 2>/dev/null)
if echo "$q_out" | grep -q universal && echo "$q_out" | grep -q workplace; then
  pass "questions seeded (both genres present)"
else
  fail "questions not seeded"
  info "wrangler d1 execute oqotd --remote --file=./seed.sql"
fi

echo
echo "── secrets ─────────────────────────────────────────"

secrets=$(wrangler secret list --name oqotd-api 2>/dev/null)
echo "$secrets" | grep -q ADMIN_TOKEN \
  && pass "ADMIN_TOKEN set" \
  || fail "ADMIN_TOKEN not set — wrangler secret put ADMIN_TOKEN"
echo "$secrets" | grep -q ANTHROPIC_API_KEY \
  && pass "ANTHROPIC_API_KEY set" \
  || note "ANTHROPIC_API_KEY not set (only needed for question generation)"
echo "$secrets" | grep -q VAPID_PRIVATE_JWK \
  && pass "VAPID_PRIVATE_JWK set" \
  || note "VAPID_PRIVATE_JWK not set (only needed for notifications)"

if grep -q 'PASTE_PUBLIC_KEY_FROM_keys.mjs' wrangler.jsonc 2>/dev/null; then
  note "VAPID_PUBLIC_KEY still a placeholder (notifications off)"
else
  pass "VAPID_PUBLIC_KEY filled in"
fi

echo
echo "── API_BASE, all three places ──────────────────────"

# Three separate files point at the API. Two-out-of-three is the classic
# half-broken deploy: the site works, admin or notifications silently do not.
base=""; mismatch=0
for f in "$ROOT/docs/index.html" "$ROOT/docs/sw.js" "$ROOT/admin/index.html"; do
  short="$(basename "$(dirname "$f")")/$(basename "$f")"
  v=$(grep -oE "API_BASE *= *'[^']*'" "$f" 2>/dev/null | head -1 | sed "s/.*'\(.*\)'/\1/")
  if [ -z "$v" ]; then fail "$short: no API_BASE found"; mismatch=1; continue; fi
  if echo "$v" | grep -q 'YOUR-SUBDOMAIN'; then fail "$short: still the placeholder"; mismatch=1; continue; fi
  [ -z "$base" ] && base="$v"
  if [ "$v" != "$base" ]; then
    fail "$short: $v"; info "differs from $base"; mismatch=1
  else
    pass "$short"
  fi
done
[ "$mismatch" -eq 0 ] && [ -n "$base" ] && pass "all three agree: $base"

echo
echo "── image worker ────────────────────────────────────"

if [ -d "$ROOT/og-worker" ]; then
  [ -d "$ROOT/og-worker/node_modules" ] \
    && pass "og-worker dependencies installed" \
    || note "og-worker: run npm install before deploying it"

  ogb=$(sed 's|//.*||' wrangler.jsonc | grep -oE '"OG_BASE"[^,}]*' | sed 's/.*: *"\(.*\)"$/\1/')
  if [ -n "$ogb" ] && ! echo "$ogb" | grep -q 'YOUR-SUBDOMAIN'; then
    pass "OG_BASE set — previews use generated images"
  else
    note "OG_BASE empty — previews fall back to the static og.png"
  fi
fi

echo
if [ "$bad" -eq 0 ]; then
  printf '\033[32mReady to deploy.\033[0m %s passed, %s optional not yet set\n\n' "$ok" "$warn"
else
  printf '\033[31m%s problem(s).\033[0m Fix before deploying.\n\n' "$bad"
fi
