#!/usr/bin/env bash
# Smoke test de l'API OpenCare: parcours bout en bout contre une instance lancee
# (docker compose en CI). Cree un compte, un cercle de soin, ecrit dans les
# modules cles puis les nouveautes (canicule, foyer), et nettoie en supprimant
# les cercles (cascade). Echoue (exit 1) au premier appel non 2xx.
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3001}"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
# Benutzername = Vorname Nachname (E18). Das erste Konto geht nur auf einem leeren Server.
PASSWORD="${SMOKE_PASSWORD:-SmokeTest123!}"
FIRST_NAME="Smoke"
LAST_NAME="${RUN_ID}"
TOKEN=""
CIRCLE_ID=""

# Appel HTTP: ajoute le Bearer et l'en-tete de cercle quand ils sont definis.
request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  local tmp
  tmp="$(mktemp)"

  if [[ -n "$body" ]]; then
    code=$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$API_BASE$path" \
      -H "Content-Type: application/json" \
      ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
      ${CIRCLE_ID:+-H "X-Circle-Id: $CIRCLE_ID"} \
      -d "$body")
  else
    code=$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$API_BASE$path" \
      -H "Content-Type: application/json" \
      ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
      ${CIRCLE_ID:+-H "X-Circle-Id: $CIRCLE_ID"})
  fi

  BODY="$(cat "$tmp")"
  rm -f "$tmp"

  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    echo "[FAIL] $method $path -> HTTP $code"
    echo "$BODY"
    exit 1
  fi

  echo "$BODY"
}

assert_success() {
  echo "$1" | jq -e '.success == true' >/dev/null
}

echo "[1/14] Health"
health=$(request GET "/health")
echo "$health" | jq -e '.status == "ok"' >/dev/null

echo "[2/14] Register (first account on an empty server)"
reg=$(request POST "/api/auth/register" "{\"firstName\":\"$FIRST_NAME\",\"lastName\":\"$LAST_NAME\",\"password\":\"$PASSWORD\"}")
assert_success "$reg"
TOKEN=$(echo "$reg" | jq -r '.data.token')
if [[ "$TOKEN" == "null" || -z "$TOKEN" ]]; then
  echo "[FAIL] Missing auth token"
  exit 1
fi
# Langue du compte : l'espagnol etait refuse en 400, si bien qu'un membre
# hispanophone recevait tout en francais. Une langue non livree reste refusee.
lang_es=$(request PUT "/api/auth/language" '{"language":"es"}')
echo "$lang_es" | jq -e '.data.user.language == "es"' >/dev/null
bad_lang=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/auth/language" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"language":"de"}')
[[ "$bad_lang" == "400" ]]
request PUT "/api/auth/language" '{"language":"fr"}' >/dev/null

echo "[3/14] Care circle"
circle=$(request POST "/api/circles" '{"recipient_first_name":"Jeanne","recipient_last_name":"Martin"}')
assert_success "$circle"
CIRCLE_ID=$(echo "$circle" | jq -r '.data.circle.id')
if [[ "$CIRCLE_ID" == "null" || -z "$CIRCLE_ID" ]]; then
  echo "[FAIL] Missing circle id"
  exit 1
fi
request GET "/api/circles" >/dev/null

echo "[4/14] Journal"
entry=$(request POST "/api/journal" '{"type":"note","content":"Passage du matin, tout va bien."}')
assert_success "$entry"

echo "[5/14] Calendar"
event=$(request POST "/api/events" '{"title":"Visite","category":"visit","start_time":"2026-03-10T09:00:00"}')
assert_success "$event"
request GET "/api/events?from=2026-03-01T00:00:00&to=2026-03-31T23:59:59" >/dev/null

echo "[6/14] Tasks"
task=$(request POST "/api/tasks" '{"title":"Passer a la pharmacie"}')
assert_success "$task"

echo "[7/14] Shopping"
item=$(request POST "/api/shopping" '{"name":"Lait","category":"Alimentation"}')
assert_success "$item"

echo "[8/14] Dashboard"
request GET "/api/dashboard" >/dev/null

echo "[9/14] Heat-wave watch"
request PUT "/api/heatwave" '{"enabled":true,"reminder_times":["10:00","14:00"]}' >/dev/null
toggle=$(request POST "/api/heatwave/toggle" '{"active":true,"level":"orange"}')
assert_success "$toggle"
request GET "/api/heatwave" >/dev/null

echo "[10/14] Household (couple)"
circle2=$(request POST "/api/circles" '{"recipient_first_name":"Robert","recipient_last_name":"Martin"}')
assert_success "$circle2"
CIRCLE2_ID=$(echo "$circle2" | jq -r '.data.circle.id')
link=$(request POST "/api/circles/$CIRCLE_ID/link" "{\"target_circle_id\":\"$CIRCLE2_ID\"}")
assert_success "$link"
request GET "/api/dashboard/household" >/dev/null

echo "[11/14] Password reset (link created by an admin)"
# Ohne Einladung gibt es kein zweites Konto.
open_reg=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"firstName\":\"Fremd\",\"lastName\":\"$RUN_ID\",\"password\":\"$PASSWORD\"}")
[[ "$open_reg" == "403" ]] || { echo "[FAIL] registration without invite must be refused (got $open_reg)"; exit 1; }
check=$(request GET "/api/auth/reset-password/0000000000000000000000000000000000000000000000000000000000000000")
echo "$check" | jq -e '.data.valid == false' >/dev/null
request GET "/api/auth/password-resets" >/dev/null

echo "[12/14] Medications (quantity per dose, confirm several, as-needed dose)"
med=$(request POST "/api/medications" '{"name":"Metformine","dosage":"500 mg","form":"tablet","with_food":"with","reason":"Diabete","schedules":[{"time_of_day":"08:00","quantity":2},{"time_of_day":"20:00","quantity":1}]}')
assert_success "$med"
echo "$med" | jq -e '.data.schedules | length == 2 and (.[0].quantity | tonumber) == 2' >/dev/null
intakes=$(request GET "/api/medications/intakes")
echo "$intakes" | jq -e '.data | length == 2 and all(.[]; has("quantity") and has("photo_url") and has("confirmed_source"))' >/dev/null
first_id=$(echo "$intakes" | jq -r '.data[0].id')
confirm=$(request POST "/api/medications/intakes/confirm" "{\"intake_ids\":[\"$first_id\"]}")
echo "$confirm" | jq -e '.data.confirmed == 1' >/dev/null
request GET "/api/medications/intakes" | jq -e '.data | any(.[]; .status == "taken" and .confirmed_source == "caregiver")' >/dev/null
prn=$(request POST "/api/medications" '{"name":"Doliprane","dosage":"1000 mg","prn":true}')
assert_success "$prn"
prn_id=$(echo "$prn" | jq -r '.data.id')
dose=$(request POST "/api/medications/$prn_id/intakes" '{}')
echo "$dose" | jq -e '.data.status == "taken" and .data.confirmed_source == "caregiver"' >/dev/null

echo "[13/14] Kiosk removed, care plan, escalation rules, Ask me (fixed questions)"
# Launch Block C: kein Kiosk mehr, weder mit Geraete-Token noch mit Sitzung.
gone=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/api/kiosk/today" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID")
[[ "$gone" != "200" ]] || { echo "[FAIL] /api/kiosk/today still answers"; exit 1; }
gone=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/kiosk/pair" -H "Content-Type: application/json" -d '{"code":"ABCDEF"}')
[[ "$gone" != "200" ]] || { echo "[FAIL] /api/kiosk/pair still answers"; exit 1; }
request GET "/api/visits" | jq -e '.data | type == "array"' >/dev/null
occ_event=$(request POST "/api/events" '{"title":"Passage infirmier","category":"nurse","start_time":"2026-01-05T09:00:00","rrule":"FREQ=WEEKLY;BYDAY=MO"}')
occ_id=$(echo "$occ_event" | jq -r '.data.id')
skipped=$(request PUT "/api/events/$occ_id/occurrences/2026-01-12" '{"action":"skip"}')
echo "$skipped" | jq -e '.data.exceptions | length == 1 and .[0].action == "skip"' >/dev/null
moved=$(request PUT "/api/events/$occ_id/occurrences/2026-01-19" '{"action":"move","start_time":"2026-01-20T14:00:00"}')
echo "$moved" | jq -e '.data.exceptions | length == 2 and (map(select(.action == "move")) | length == 1)' >/dev/null
bad_occ=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/events/$occ_id/occurrences/2026-01-13" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"action":"skip"}')
[[ "$bad_occ" == "400" ]]
restored=$(request DELETE "/api/events/$occ_id/occurrences/2026-01-12")
echo "$restored" | jq -e '.data.exceptions | length == 1' >/dev/null
request DELETE "/api/events/$occ_id" >/dev/null

med_id=$(echo "$med" | jq -r '.data.id')
second_id=$(echo "$intakes" | jq -r '.data[1].id')
second_qty=$(echo "$intakes" | jq -r '.data[1].quantity')
stock=$(request PUT "/api/medications/$med_id/stock" '{"stock_quantity":10,"stock_alert_threshold":4}')
echo "$stock" | jq -e '(.data.stock_quantity | tonumber) == 10 and (.data.stock_alert_threshold | tonumber) == 4' >/dev/null
bad_stock=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/medications/$med_id/stock" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"stock_quantity":-2}')
[[ "$bad_stock" == "400" ]]
request POST "/api/medications/intakes/confirm" "{\"intake_ids\":[\"$second_id\"]}" >/dev/null
after_stock=$(request GET "/api/medications" | jq -r --arg id "$med_id" '.data[] | select(.id == $id) | .stock_quantity')
awk -v a="$after_stock" -v q="$second_qty" 'BEGIN { exit !(a + 0 == 10 - q) }'

thr=$(request PUT "/api/vitals/thresholds" '{"type":"bp","min_value":90,"max_value":140,"min_value2":50,"max_value2":90}')
echo "$thr" | jq -e '.data.type == "bp"' >/dev/null
bad_thr=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/vitals/thresholds" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"type":"bp","min_value":150,"max_value":100}')
[[ "$bad_thr" == "400" ]]
request POST "/api/vitals" '{"type":"bp","value":175,"value2":105}' >/dev/null
dash_vitals=$(request GET "/api/dashboard")
echo "$dash_vitals" | jq -e '.data.attention | map(.kind) | index("vitals_out_of_range") != null' >/dev/null
request GET "/api/vitals/thresholds" | jq -e '. | .data | length == 1' >/dev/null

unread=$(request GET "/api/messages/unread")
echo "$unread" | jq -e '.data.total == 0 and (.data.dms | type == "array")' >/dev/null
read_ack=$(request POST "/api/messages/read" '{"channel":"circle"}')
echo "$read_ack" | jq -e '.data.total == 0' >/dev/null

circle_list=$(request GET "/api/circles")
echo "$circle_list" | jq -e 'all(.data[]; .settings | has("kiosk_pin_hash") | not)' >/dev/null
echo "$circle_list" | jq -e '.data[0].settings.unit_system == "metric" and .data[0].settings.week_start == "monday"' >/dev/null
units=$(request PUT "/api/circles/$CIRCLE_ID" '{"settings":{"unit_system":"imperial"}}')
echo "$units" | jq -e '.data.settings.unit_system == "imperial" and (.data.settings | has("kiosk_pin_hash") | not)' >/dev/null
# Une seconde cle publique, ecrite seule : la fusion garde la premiere.
week=$(request PUT "/api/circles/$CIRCLE_ID" '{"settings":{"week_start":"sunday"}}')
echo "$week" | jq -e '.data.settings.week_start == "sunday" and .data.settings.unit_system == "imperial" and (.data.settings | has("kiosk_pin_hash") | not)' >/dev/null
bad_week=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/circles/$CIRCLE_ID" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"settings":{"week_start":"mardi"}}')
[[ "$bad_week" == "400" ]]
# Numeros d'urgence de l'affiche : texte libre nettoye, efface par null.
echo "$circle_list" | jq -e '.data[0].settings.emergency_numbers == null' >/dev/null
numbers=$(request PUT "/api/circles/$CIRCLE_ID" '{"settings":{"emergency_numbers":"  911  "}}')
echo "$numbers" | jq -e '.data.settings.emergency_numbers == "911" and .data.settings.week_start == "sunday"' >/dev/null
bad_numbers=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/circles/$CIRCLE_ID" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"settings":{"emergency_numbers":"911\n112"}}')
[[ "$bad_numbers" == "400" ]]
cleared=$(request PUT "/api/circles/$CIRCLE_ID" '{"settings":{"emergency_numbers":null}}')
echo "$cleared" | jq -e '.data.settings.emergency_numbers == null' >/dev/null
bad_setting=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/circles/$CIRCLE_ID" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"settings":{"kiosk_pin_hash":"a-moi"}}')
[[ "$bad_setting" == "400" ]]
request PUT "/api/circles/$CIRCLE_ID" '{"settings":{"unit_system":"metric","week_start":"monday"}}' >/dev/null

esc=$(request GET "/api/escalation/rules")
echo "$esc" | jq -e '.data.rules.enabled == false and .data.rules.med_primary_min == 30' >/dev/null
rejected=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/escalation/rules" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"med_primary_min":-1}')
[[ "$rejected" == "400" ]]
esc=$(request PUT "/api/escalation/rules" '{"enabled":true,"med_patient_min":15,"med_primary_min":30,"help_ack_min":5}')
echo "$esc" | jq -e '.data.rules.enabled == true and .data.rules.help_ack_min == 5' >/dev/null
help_before=$(request GET "/api/escalation/help")
echo "$help_before" | jq -e '. | .data | length == 0' >/dev/null
request PUT "/api/escalation/rules" '{"enabled":false}' | jq -e '.data.rules.enabled == false' >/dev/null
plan=$(request PUT "/api/care-plan" '{"sections":{"morning":"Lever vers 7 h 30","emergency":"Appeler Alice en premier","bogus":"ignore"}}')
echo "$plan" | jq -e '.success == true and .data.sections.morning == "Lever vers 7 h 30" and (.data.sections | has("bogus") | not)' >/dev/null
plan=$(request GET "/api/care-plan")
echo "$plan" | jq -e '.data.sections.emergency == "Appeler Alice en premier" and (.data.week.days | length == 7) and (.data.medications | type == "array") and (.data.professionals | type == "array")' >/dev/null
ask=$(request GET "/api/companion/answer/medications")
echo "$ask" | jq -e '.success == true and .data.intent == "medications" and (.data.reply | type == "string")' >/dev/null
ask=$(request GET "/api/companion/answer/week")
echo "$ask" | jq -e '.data.intent == "appointments_week"' >/dev/null
bad_ask=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/api/companion/answer/Wie%20geht%20es%20mir" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID")
[[ "$bad_ask" == "400" ]] || { echo "[FAIL] free question must be refused (got $bad_ask)"; exit 1; }
ask=$(request POST "/api/companion/message" '{"messages":[{"role":"user","content":"Raconte moi un souvenir"}]}')
echo "$ask" | jq -e '.data.source == "fallback" and .data.flagged == false' >/dev/null

# Role neighbor : aucune donnee de sante, sur aucune route (synthese, journal,
# tableau de bord), et pas le jeton de la fiche urgence en direct. L'admin, lui,
# voit les entrees de sante : sans elles, le filtre ne prouverait rien.
NUSER="Voisin ${RUN_ID}"
invite=$(request POST "/api/invites" "{\"role\":\"neighbor\",\"first_name\":\"Voisin\",\"last_name\":\"$RUN_ID\"}")
invite_token=$(echo "$invite" | jq -r '.data.token')
# Gleicher Name ein zweites Mal: einfache Meldung statt zweiter Einladung.
dup=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/invites" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d "{\"role\":\"family\",\"first_name\":\"voisin\",\"last_name\":\"$RUN_ID\"}")
[[ "$dup" == "409" ]] || { echo "[FAIL] duplicate username must be refused (got $dup)"; exit 1; }
# Registrieren ueber den Einladungslink: nur das Passwort, Benutzername und Rolle kommen aus der Einladung.
nreg=$(curl -sS -X POST "$API_BASE/api/auth/register" -H "Content-Type: application/json" -d "{\"password\":\"$PASSWORD\",\"inviteToken\":\"$invite_token\"}")
NTOKEN=$(echo "$nreg" | jq -r '.data.token')
NUSER_ID=$(echo "$nreg" | jq -r '.data.user.id')
echo "$nreg" | jq -e --arg u "$NUSER" '.data.user.username == $u' >/dev/null
[[ -n "$NTOKEN" && "$NTOKEN" != "null" ]] || { echo "[FAIL] neighbor registration"; exit 1; }
as_neighbor() { curl -sS "$API_BASE$1" -H "Authorization: Bearer $NTOKEN" -H "X-Circle-Id: $CIRCLE_ID"; }
n_digests=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/api/digests" -H "Authorization: Bearer $NTOKEN" -H "X-Circle-Id: $CIRCLE_ID")
[[ "$n_digests" == "403" ]] || { echo "[FAIL] neighbor read the weekly digests (got $n_digests)"; exit 1; }
request GET "/api/digests" >/dev/null
request GET "/api/journal" | jq -e 'any(.data[]; .type == "incident" or .type == "medication")' >/dev/null
as_neighbor "/api/journal" | jq -e '(.data | length > 0) and all(.data[]; .type != "vital" and .type != "medication" and .type != "incident")' >/dev/null
as_neighbor "/api/dashboard" | jq -e '(.data.last_journal_entries | all(.[]; .type != "vital" and .type != "medication" and .type != "incident")) and .data.latest_vitals == null' >/dev/null
as_neighbor "/api/emergency/sheet" | jq -e '.success == true and (.data | has("public_token") | not) and (.data | has("url") | not)' >/dev/null
request GET "/api/emergency/sheet" | jq -e '.data.public_token | length == 64' >/dev/null

# Passwort vergessen: der Link oeffnet das ganze Konto, daher erzeugt oder loescht ihn
# nur ein Admin ALLER Kreise der Person. Hat der Nachbar einen eigenen Kreis, darf
# der Admin des gemeinsamen Kreises keinen Link erzeugen.
neighbor_circle() {
  curl -sS -X POST "$API_BASE/api/circles" -H "Content-Type: application/json" -H "Authorization: Bearer $NTOKEN" -d '{"recipient_first_name":"Paul"}' | jq -r '.data.circle.id'
}
drop_neighbor_circle() {
  curl -sS -X DELETE "$API_BASE/api/circles/$1" -H "Authorization: Bearer $NTOKEN" -H "X-Circle-Id: $1" | jq -e '.success == true' >/dev/null
}
NCIRCLE_ID=$(neighbor_circle)
[[ -n "$NCIRCLE_ID" && "$NCIRCLE_ID" != "null" ]] || { echo "[FAIL] neighbor circle"; exit 1; }
denied=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API_BASE/api/auth/password-resets" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"user_id\":\"$NUSER_ID\"}")
[[ "$denied" == "403" ]] || { echo "[FAIL] admin of one shared circle created a reset link (got $denied)"; exit 1; }
# Ohne seinen anderen Kreis hat der Nachbar nur noch den des Admins: der Link geht.
drop_neighbor_circle "$NCIRCLE_ID"
request POST "/api/auth/password-resets" "{\"user_id\":\"$NUSER_ID\"}" | jq -e '.data.url | startswith("/reset-password?token=")' >/dev/null
resets=$(request GET "/api/auth/password-resets")
reset_id=$(echo "$resets" | jq -r --arg u "$NUSER" '[.data[] | select(.username == $u)][0].id')
reset_url=$(echo "$resets" | jq -r --arg u "$NUSER" '[.data[] | select(.username == $u)][0].url')
[[ "$reset_id" != "null" && "$reset_url" == /reset-password\?token=* ]] || { echo "[FAIL] reset link not relayed to the admin of every circle"; exit 1; }
# Un nouveau cercle a lui : l'admin ne peut plus annuler sa demande.
NCIRCLE_ID=$(neighbor_circle)
cancel=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE "$API_BASE/api/auth/password-resets/$reset_id" -H "Authorization: Bearer $TOKEN")
[[ "$cancel" == "404" ]] || { echo "[FAIL] admin of one shared circle cancelled a reset (got $cancel)"; exit 1; }
drop_neighbor_circle "$NCIRCLE_ID"
# Reinitialisation par le lien relaye : le titulaire en est prevenu.
reset_token="${reset_url#*token=}"
curl -sS -X POST "$API_BASE/api/auth/reset-password" -H "Content-Type: application/json" -d "{\"token\":\"$reset_token\",\"password\":\"Smoke-Nouveau-456!\"}" | jq -e '.success == true' >/dev/null
NTOKEN=$(curl -sS -X POST "$API_BASE/api/auth/login" -H "Content-Type: application/json" -d "{\"username\":\"$NUSER\",\"password\":\"Smoke-Nouveau-456!\"}" | jq -r '.data.token')
curl -sS "$API_BASE/api/notifications" -H "Authorization: Bearer $NTOKEN" | jq -e 'any(.data[]; .type == "password_changed")' >/dev/null

echo "[14/14] Cleanup"
request DELETE "/api/circles/$CIRCLE_ID" >/dev/null
request DELETE "/api/circles/$CIRCLE2_ID" >/dev/null

echo "[OK] OpenCare API smoke test complete"
