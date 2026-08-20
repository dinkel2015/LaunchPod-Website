#!/usr/bin/env bash
# =====================================================================
# Pushes the portal's environment variables into the Vercel project.
#
#   export VERCEL_TOKEN=…            # vercel.com/account/tokens
#   ./scripts/set-vercel-env.sh production
#   ./scripts/set-vercel-env.sh preview
#
# Reads values from .env (gitignored). Nothing secret is written here or
# to git — this script only forwards what is already in .env.
# =====================================================================
set -euo pipefail

TARGET="${1:-production}"
if [[ "$TARGET" != "production" && "$TARGET" != "preview" && "$TARGET" != "development" ]]; then
  echo "usage: $0 [production|preview|development]" >&2
  exit 1
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "VERCEL_TOKEN is not set. Create one at https://vercel.com/account/tokens" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo ".env not found" >&2; exit 1; }
set -a; source .env; set +a

VARS=(
  SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY
  SQUARE_ENV SQUARE_APPLICATION_ID SQUARE_ACCESS_TOKEN SQUARE_LOCATION_ID
  CLICKUP_API_TOKEN CLICKUP_TEAM_ID CLICKUP_DELIVERY_SPACE_ID
  CRON_SECRET
)
# Only set if present — provisioning falls back cleanly without it.
[[ -n "${CLICKUP_FOLDER_TEMPLATE_ID:-}" ]] && VARS+=(CLICKUP_FOLDER_TEMPLATE_ID)

for name in "${VARS[@]}"; do
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "  SKIP  $name (empty in .env)"
    continue
  fi
  # Remove first so a re-run updates rather than erroring on a duplicate.
  npx --yes vercel env rm "$name" "$TARGET" --yes --token "$VERCEL_TOKEN" >/dev/null 2>&1 || true
  printf '%s' "$value" | npx --yes vercel env add "$name" "$TARGET" --token "$VERCEL_TOKEN" >/dev/null
  echo "  set   $name -> $TARGET"
done

echo
echo "Done. Verify with:  npx vercel env ls $TARGET --token \$VERCEL_TOKEN"
