#!/usr/bin/env bash
# Durchlauftest Arztgespraech-Modul gegen echten Server + Postgres + Mocks.
set -u
A=http://localhost:3001
ok(){ echo "OK   $1"; }; bad(){ echo "FAIL $1"; FAILS=$((FAILS+1)); }; FAILS=0
EMAIL="e2e$RANDOM@example.org"
TOKEN=$(curl -s -X POST $A/api/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"Sehr-sicher-123!\",\"name\":\"Thomas Muster\"}" | jq -r '.data.token')
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept-Language: de')
CID=$(curl -s -X POST $A/api/circles "${H[@]}" -d '{"recipient_first_name":"Erika","recipient_last_name":"Muster"}' | jq -r '.data.circle.id')
sudo -n -u postgres psql -q opencare -c "update users set language='de' where email='$EMAIL'"
H+=(-H "X-Circle-Id: $CID")
[ "$CID" != null ] && ok "Kreis angelegt" || bad "Kreis"
curl -s -X POST $A/api/medications "${H[@]}" -d '{"name":"Ramipril","dosage":"5 mg","prescriber":"Dr. Özdemir"}' >/dev/null
curl -s -X POST $A/api/integrations "${H[@]}" -d '{"type":"whisper","base_url":"http://127.0.0.1:9100","display_name":"Whisper"}' | jq -c '.success,.error'
curl -s -X PUT $A/api/ai/settings "${H[@]}" -d '{"provider":"ollama","base_url":"http://127.0.0.1:9101","model":"qwen-test","enabled":true}' | jq -c '.success,.error'

# Fachwoerter
r=$(curl -s -X POST $A/api/consultations/vocabulary "${H[@]}" -d '{"term":"Eliquis"}'); [ "$(echo $r | jq -r .success)" = true ] && ok "Fachwort" || bad "Fachwort $r"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $A/api/consultations/vocabulary "${H[@]}" -d '{"term":"eliquis"}'); [ "$c" = 409 ] && ok "Fachwort-Duplikat 409" || bad "Duplikat $c"
v=$(curl -s $A/api/consultations/vocabulary "${H[@]}"); echo "$v" | jq -e '.data.automatic | index("Ramipril") and index("Dr. Özdemir")' >/dev/null && ok "automatische Fachwörter" || bad "auto $v"

# Gespraech + Fragen
CON=$(curl -s -X POST $A/api/consultations "${H[@]}" -d '{"doctor_name":"Dr. Weber","specialty":"Kardiologie","scheduled_at":"2026-11-10T09:30","reason":"Kontrolle","create_event":true}')
ID=$(echo $CON | jq -r .data.id); [ "$(echo $CON | jq -r .data.event_id)" != null ] && ok "Gespräch mit Termin" || bad "Gespräch $CON"
curl -s "$A/api/events?from=2026-11-01T00:00:00&to=2026-11-30T23:59:59" "${H[@]}" | jq -e '.data | any(.[]; .title == "Arztgespräch: Dr. Weber, Kardiologie")' >/dev/null && ok "Kalendertermin" || bad "Kalender"
EV=$(echo $CON | jq -r .data.event_id)
curl -s -X PUT $A/api/consultations/$ID "${H[@]}" -d '{"scheduled_at":"2026-11-11T10:15","location":"Praxis Süd"}' >/dev/null
curl -s "$A/api/events?from=2026-11-01T00:00:00&to=2026-11-30T23:59:59" "${H[@]}" | jq -e --arg ev "$EV" '.data | any(.[]; .id==$ev and .start_time=="2026-11-11T10:15:00" and .location=="Praxis Süd")' >/dev/null && ok "Kalendertermin mitgeändert" || bad "Kalender-Sync"
Q1=$(curl -s -X POST $A/api/consultations/$ID/questions "${H[@]}" -d '{"text":"Woher kommt der Schwindel?"}' | jq -r .data.id)
curl -s -X POST $A/api/consultations/$ID/questions "${H[@]}" -d '{"text":"Darf sie weiter Rad fahren?"}' >/dev/null
c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $A/api/consultations/$ID "${H[@]}" -d '{"scheduled_at":"10.11.2026"}'); [ "$c" = 400 ] && ok "ungültiges Datum 400" || bad "Datum $c"

# Aufnahme ohne Einwilligung
CL=$(cat /proc/sys/kernel/random/uuid)
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $A/api/consultations/recordings "${H[@]}" -d "{\"client_id\":\"$CL\",\"consultation_id\":\"$ID\",\"mime_type\":\"audio/webm;codecs=opus\"}"); [ "$c" = 400 ] && ok "ohne Einwilligung 400" || bad "consent $c"
r=$(curl -s -X POST $A/api/consultations/recordings "${H[@]}" -d "{\"client_id\":\"$CL\",\"consultation_id\":\"$ID\",\"consent_confirmed\":true,\"consent_at\":\"$(date -d '-2 hours' +%Y-%m-%dT%H:%M:%S)\",\"mime_type\":\"audio/webm;codecs=opus\",\"started_at\":\"2026-11-10T09:31:00\"}")
RID=$(echo $r | jq -r .data.id); [ "$RID" != null ] && ok "Aufnahme angemeldet" || bad "anmelden $r"
ca=$(sudo -n -u postgres psql -tA opencare -c "select (now()::timestamp - consent_at) > interval '1 hour' from consultation_recordings where id='$RID'"); [ "$ca" = t ] && ok "Einwilligungszeit vom Gerät" || bad "consent_at $ca"
r2=$(curl -s -X POST $A/api/consultations/recordings "${H[@]}" -d "{\"client_id\":\"$CL\",\"consultation_id\":\"$ID\",\"consent_confirmed\":true,\"mime_type\":\"audio/webm\"}"); [ "$(echo $r2 | jq -r .data.id)" = "$RID" ] && ok "idempotent" || bad "idem"
B=(-H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CID" -H 'Content-Type: application/octet-stream')
printf 'FAKEAUDIO-0' | curl -s -X PUT $A/api/consultations/recordings/$CL/chunks/0 "${B[@]}" --data-binary @- >/dev/null
printf 'FAKEAUDIO-2' | curl -s -X PUT $A/api/consultations/recordings/$CL/chunks/2 "${B[@]}" --data-binary @- >/dev/null
printf 'FAKEAUDIO-2' | curl -s -X PUT $A/api/consultations/recordings/$CL/chunks/2 "${B[@]}" --data-binary @- >/dev/null
m=$(curl -s -X POST $A/api/consultations/recordings/$CL/complete "${H[@]}" -d '{"total_chunks":3,"duration_seconds":95}'); echo $m | jq -e '.error=="MISSING_CHUNKS" and .missing==[1]' >/dev/null && ok "fehlendes Stück erkannt" || bad "missing $m"
printf 'FAKEAUDIO-1' | curl -s -X PUT $A/api/consultations/recordings/$CL/chunks/1 "${B[@]}" --data-binary @- >/dev/null
st=$(curl -s $A/api/consultations/recordings/$CL "${H[@]}"); echo $st | jq -e '.data.received==[0,1,2] and .data.size_bytes=="33"' >/dev/null && ok "Stücke und Größe (doppelt gezählt? nein)" || bad "status $st"
big=$(head -c 2200000 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -X PUT $A/api/consultations/recordings/$CL/chunks/5 "${B[@]}" --data-binary @-); [ "$big" = 413 ] && ok "zu großes Stück 413" || bad "groß $big"
curl -s -X POST $A/api/consultations/recordings/$CL/complete "${H[@]}" -d '{"total_chunks":3,"duration_seconds":95}' | jq -e '.data.status=="queued"' >/dev/null && ok "eingereiht" || bad "complete"

for i in $(seq 1 30); do s=$(curl -s $A/api/consultations/$ID "${H[@]}" | jq -r '.data.recordings[0].status'); [ "$s" = done ] || [ "$s" = failed ] && break; sleep 1; done
D=$(curl -s $A/api/consultations/$ID "${H[@]}")
[ "$s" = done ] && ok "verarbeitet" || bad "Status $s $(echo $D | jq -c .data.recordings)"
echo $D | jq -e '.data.consultation.summary_status=="draft" and .data.consultation.summary.medication_changes[0].name=="Ramipril"' >/dev/null && ok "Entwurf gespeichert" || bad "Entwurf $(echo $D | jq -c .data.consultation)"
echo $D | jq -e '.data.transcript | contains("Ramipril")' >/dev/null && ok "Mitschrift" || bad "Mitschrift"
grep -q '"hasAudio":true' /home/claude/e2e/mocks.log && ok "Whisper bekam alle Stücke in Reihenfolge" || bad "Audio"
grep '"whisper"' /home/claude/e2e/mocks.log | tail -1 | jq -e '.prompt | startswith("Arztgespräch. Fachbegriffe: Eliquis, Ramipril") and (.|length) <= 600' >/dev/null && ok "Whisper-Prompt mit Fachwörtern" || bad "Prompt $(tail -2 /home/claude/e2e/mocks.log)"
grep '"ollama"' /home/claude/e2e/mocks.log | tail -1 | jq -e '.user | contains("0. Woher kommt der Schwindel?")' >/dev/null && ok "Ollama bekam Fragen" || bad "ollama prompt"
n=$(curl -s $A/api/notifications "${H[@]}" | jq '[.data[]? | select(.type=="consultation")] | length'); [ "${n:-0}" -ge 1 ] && ok "Benachrichtigung" || bad "Benachrichtigung $n"

# Freigabe
curl -s -X POST $A/api/consultations/$ID/summary/approve "${H[@]}" -d '{}' | jq -e '.data.summary_status=="approved" and .data.approved_by_name=="Thomas Muster"' >/dev/null && ok "freigegeben" || bad "Freigabe"
curl -s $A/api/consultations/$ID "${H[@]}" | jq -e '.data.questions[0].answer=="Vermutlich vom Blutdruck." and .data.questions[1].answer==null' >/dev/null && ok "Antwort übernommen" || bad "Antwort"
echo $D | jq -e '.data.consultation.summary.appointments[0].date=="2026-11-24" and .data.consultation.summary.appointments[0].time==null and .data.consultation.summary.family_notes[0]=="Ramipril jetzt 2,5 mg statt 5 mg."' >/dev/null && ok "Vorschläge Termin/Notiz" || bad "Vorschläge"
nt=$(curl -s "$A/api/tasks" "${H[@]}" | jq '.data|length'); [ "$nt" = 0 ] && ok "nichts automatisch angelegt" || bad "auto-Aufgaben $nt"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $A/api/consultations/$ID/apply "${H[@]}" -d '{"appointments":[{"title":"Kontrolle Kardiologie","date":"2026-11-24","time":"","location":""}]}'); [ "$c" = 400 ] && ok "Termin ohne Uhrzeit abgelehnt" || bad "ohne Uhrzeit $c"
ap=$(curl -s -X POST $A/api/consultations/$ID/apply "${H[@]}" -d '{"tasks":[{"text":"Kontrolle beim Hausarzt","due":"2026-11-21"}],"appointments":[{"title":"Kontrolle Kardiologie","date":"2026-11-24","time":"09:30","location":"Praxis Weber"}],"notes":[{"content":"Ramipril jetzt 2,5 mg statt 5 mg."}]}')
echo $ap | jq -e '.data.tasks==1 and .data.appointments==1 and .data.notes==1 and .data.skipped==0' >/dev/null && ok "Vorschläge übernommen" || bad "apply $ap"
ap2=$(curl -s -X POST $A/api/consultations/$ID/apply "${H[@]}" -d '{"tasks":[{"text":"  kontrolle   beim Hausarzt ","due":null}]}'); echo $ap2 | jq -e '.data.tasks==0 and .data.skipped==1' >/dev/null && ok "kein Doppel" || bad "doppelt $ap2"
curl -s $A/api/tasks "${H[@]}" | jq -e '.data | any(.[]; .title=="Kontrolle beim Hausarzt" and (.due_date|startswith("2026-11-21")))' >/dev/null && ok "Aufgabe mit Datum" || bad "Aufgabe Datum"
curl -s "$A/api/events?from=2026-11-01T00:00:00&to=2026-11-30T23:59:59" "${H[@]}" | jq -e '.data | any(.[]; .title=="Kontrolle Kardiologie" and .start_time=="2026-11-24T09:30:00" and .category=="medical")' >/dev/null && ok "Termin im Kalender" || bad "Termin"
curl -s $A/api/notes "${H[@]}" | jq -e '.data | any(.[]; .content=="Ramipril jetzt 2,5 mg statt 5 mg.")' >/dev/null && ok "Notiz an Pinnwand" || bad "Notiz $(curl -s $A/api/notes "${H[@]}" | head -c 200)"
curl -s $A/api/consultations/$ID "${H[@]}" | jq -e '.data.consultation.applied | has("task:kontrolle beim hausarzt")' >/dev/null && ok "applied-Schlüssel" || bad "applied"

# Neu erzeugen, Audio loeschen
curl -s -X POST $A/api/consultations/$ID/summary/regenerate "${H[@]}" | jq -e '.data.status=="queued"' >/dev/null && ok "neu erzeugen eingereiht" || bad "regenerate"
sleep 3
W=$(grep -c '"whisper"' /home/claude/e2e/mocks.log); [ "$W" = 1 ] && ok "beim Neuerzeugen keine zweite Texterkennung" || bad "whisper count $W"
curl -s $A/api/consultations/$ID "${H[@]}" | jq -e '.data.consultation.summary_status=="draft"' >/dev/null && ok "wieder Entwurf" || bad "draft again"
curl -s -X DELETE $A/api/consultations/recordings/$RID/audio "${H[@]}" | jq -e .success >/dev/null && ok "Audio gelöscht" || bad "Audio löschen"
n=$(sudo -n -u postgres psql -tA opencare -c "select count(*) from consultation_recording_chunks where recording_id='$RID'"); [ "$n" = 0 ] && ok "Stücke weg" || bad "Stücke $n"

# Cloud-KI wird abgelehnt
curl -s -X PUT $A/api/ai/settings "${H[@]}" -d '{"provider":"anthropic","model":"claude","api_key":"sk-test","enabled":true}' >/dev/null
curl -s -X POST $A/api/consultations/$ID/summary/regenerate "${H[@]}" >/dev/null; sleep 3
curl -s $A/api/consultations/$ID "${H[@]}" | jq -e '.data.recordings[0].error_code=="LOCAL_AI_REQUIRED"' >/dev/null && ok "Cloud-KI abgelehnt" || bad "cloud $(curl -s $A/api/consultations/$ID "${H[@]}" | jq -c .data.recordings)"
O=$(grep -c '"ollama"' /home/claude/e2e/mocks.log); [ "$O" = 2 ] && ok "keine Daten an Cloud" || bad "ollama count $O"

# Rollen: Nachbar
E2="n$RANDOM@example.org"; T2=$(curl -s -X POST $A/api/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$E2\",\"password\":\"Sehr-sicher-123!\",\"name\":\"Nachbar\"}" | jq -r .data.token)
UID2=$(sudo -n -u postgres psql -tA opencare -c "select id from users where email='$E2'")
sudo -n -u postgres psql -q opencare -c "insert into circle_members(circle_id,user_id,role) values ('$CID','$UID2','neighbor')"
c=$(curl -s -o /dev/null -w '%{http_code}' $A/api/consultations -H "Authorization: Bearer $T2" -H "X-Circle-Id: $CID"); [ "$c" = 403 ] && ok "Nachbar gesperrt" || bad "Nachbar $c"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $A/api/consultations/recordings -H "Authorization: Bearer $T2" -H "X-Circle-Id: $CID" -H 'Content-Type: application/json' -d '{}'); [ "$c" = 403 ] && ok "Nachbar keine Aufnahme" || bad "Nachbar rec $c"
# Fremder Kreis
CID3=$(curl -s -X POST $A/api/circles -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -d '{"recipient_first_name":"X"}' | jq -r .data.circle.id)
c=$(curl -s -o /dev/null -w '%{http_code}' $A/api/consultations/$ID -H "Authorization: Bearer $T2" -H "X-Circle-Id: $CID3"); [ "$c" = 404 ] && ok "fremder Kreis 404" || bad "fremd $c"

# Kein gekoppeltes Tablet mehr (Launch Block C): ein Geraete-Token oeffnet nichts.
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST $A/api/consultations/recordings -H "X-Kiosk-Token: $(printf 'a%.0s' $(seq 64))" -H 'Content-Type: application/json' -d '{}'); [ "$c" = 401 ] && ok "Geraete-Token abgelehnt" || bad "Geraete-Token $c"
curl -s -X DELETE $A/api/consultations/$ID "${H[@]}" | jq -e .success >/dev/null && ok "Gespräch gelöscht" || bad "delete"
n=$(sudo -n -u postgres psql -tA opencare -c "select count(*) from events where id='$EV'"); [ "$n" = 0 ] && ok "Termin mitgelöscht" || bad "Termin bleibt $n"

echo "Fehler: $FAILS"
