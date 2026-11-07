// Tabellen des Arztgespraech-Moduls. Idempotent, laufen bei jedem Start mit
// den uebrigen Migrationen (db.ts). Eigene Datei, damit der Fork beim
// Uebernehmen von Updates aus dem Original moeglichst wenig Konflikte hat.

export const CONSULTATION_MIGRATIONS: string[] = [
    `CREATE TABLE IF NOT EXISTS consultations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
        doctor_name VARCHAR(200),
        specialty VARCHAR(120),
        scheduled_at TIMESTAMP,
        location VARCHAR(255),
        reason TEXT,
        event_id UUID REFERENCES events(id) ON DELETE SET NULL,
        notes TEXT,
        summary JSONB,
        summary_status VARCHAR(20) NOT NULL DEFAULT 'none'
            CHECK (summary_status IN ('none', 'draft', 'approved')),
        approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMP,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_by_device UUID REFERENCES kiosk_devices(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_consultations_circle ON consultations(circle_id, scheduled_at DESC NULLS LAST);`,
    `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_consultations_updated_at') THEN
            CREATE TRIGGER update_consultations_updated_at BEFORE UPDATE ON consultations
                FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
    END $$;`,

    `CREATE TABLE IF NOT EXISTS consultation_questions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
        circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        answer TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_consultation_questions_c ON consultation_questions(consultation_id, position);`,

    // Eine Aufnahme kommt in Stuecken an. client_id wird auf dem Geraet erzeugt:
    // Wiederholte Uploads nach Netzabbruch legen so keine Doppel an.
    // Die Einwilligung des Arztes ist Pflicht (NOT NULL), ohne sie gibt es keine Aufnahme.
    `CREATE TABLE IF NOT EXISTS consultation_recordings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
        circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
        client_id UUID NOT NULL UNIQUE,
        mime_type VARCHAR(80) NOT NULL,
        consent_at TIMESTAMP NOT NULL,
        consent_by_user UUID REFERENCES users(id) ON DELETE SET NULL,
        consent_by_device UUID REFERENCES kiosk_devices(id) ON DELETE SET NULL,
        started_at TIMESTAMP,
        duration_seconds INTEGER,
        total_chunks INTEGER,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'uploading'
            CHECK (status IN ('uploading', 'queued', 'transcribing', 'summarizing', 'done', 'failed')),
        error_code VARCHAR(60),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMP,
        transcript TEXT,
        audio_deleted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        uploaded_at TIMESTAMP,
        processed_at TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_consultation_recordings_c ON consultation_recordings(consultation_id);`,
    `CREATE INDEX IF NOT EXISTS idx_consultation_recordings_queue ON consultation_recordings(status, next_attempt_at);`,

    // Audio liegt in der Datenbank: Ein Datenbank-Backup sichert damit alles,
    // ohne zusaetzliches Dateiverzeichnis.
    `CREATE TABLE IF NOT EXISTS consultation_recording_chunks (
        recording_id UUID NOT NULL REFERENCES consultation_recordings(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (recording_id, chunk_index)
    );`,

    // Eigene Fachwoerter des Kreises fuer die Spracherkennung (Whisper-Kontext).
    `CREATE TABLE IF NOT EXISTS consultation_vocabulary (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        circle_id UUID NOT NULL REFERENCES care_circles(id) ON DELETE CASCADE,
        term VARCHAR(80) NOT NULL,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_consultation_vocabulary_term ON consultation_vocabulary(circle_id, lower(term));`,

    // Welche Vorschlaege (Aufgaben, Termine, Notizen) schon uebernommen wurden:
    // { "task:0": "<task id>", "event:1": "<event id>", "note:0": "<note id>" }
    `ALTER TABLE consultations ADD COLUMN IF NOT EXISTS applied JSONB NOT NULL DEFAULT '{}'::jsonb;`,
];
