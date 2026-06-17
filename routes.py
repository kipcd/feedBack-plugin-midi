"""MIDI Amp Control plugin — store tone-to-preset mappings per song."""

import json
import sqlite3
import threading
from pathlib import Path

_db_path = None
_conn = None
_lock = threading.Lock()


def _get_conn():
    global _conn
    if _conn is not None:
        return _conn
    # Double-checked locking: open + migrate against a local
    # variable, publish to the global only after migration commits.
    # Without this, a second request can observe a half-initialized
    # _conn (assigned but pre-migration) and SELECT against the
    # un-migrated v1.0.0 schema, raising
    # `no such column: bank_number`.
    with _lock:
        if _conn is not None:
            return _conn
        conn = sqlite3.connect(_db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS midi_mappings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                tone_key TEXT NOT NULL,
                tone_name TEXT,
                midi_channel INTEGER DEFAULT 0,
                msg_type TEXT DEFAULT 'cc',
                cc_number INTEGER DEFAULT 0,
                bank_number INTEGER DEFAULT 0,
                value INTEGER DEFAULT 0,
                cc2_number INTEGER,
                cc2_value INTEGER DEFAULT 0,
                UNIQUE(filename, tone_key)
            )
        """)
        _migrate_schema(conn)
        conn.commit()
        _conn = conn
        return _conn


def _migrate_schema(conn):
    """Additive ALTER TABLE for users upgrading from v1.0.0.

    CREATE TABLE IF NOT EXISTS is a no-op when the table already
    exists, so installs that ran any pre-1.1.0 version still have
    the original 7-column schema. Without this, the very first
    GET /mappings request after upgrade 500s with
    `no such column: bank_number`.
    """
    existing = {row[1] for row in conn.execute("PRAGMA table_info(midi_mappings)")}
    additions = (
        ("bank_number", "INTEGER DEFAULT 0"),
        ("cc2_number", "INTEGER"),
        ("cc2_value", "INTEGER DEFAULT 0"),
    )
    for name, defn in additions:
        if name not in existing:
            conn.execute(f"ALTER TABLE midi_mappings ADD COLUMN {name} {defn}")


def setup(app, context):
    global _db_path
    _db_path = str(context["config_dir"] / "midi_mappings.db")

    @app.get("/api/plugins/midi_amp/mappings/{filename:path}")
    def get_mappings(filename: str):
        conn = _get_conn()
        rows = conn.execute(
            "SELECT id, tone_key, tone_name, midi_channel, msg_type, "
            "cc_number, bank_number, value, cc2_number, cc2_value "
            "FROM midi_mappings WHERE filename = ? ORDER BY tone_key",
            (filename,)
        ).fetchall()
        return [
            {"id": r[0], "tone_key": r[1], "tone_name": r[2],
             "channel": r[3], "msg_type": r[4],
             "cc_number": r[5], "bank_number": r[6], "value": r[7],
             "cc2_number": r[8], "cc2_value": r[9]}
            for r in rows
        ]

    @app.post("/api/plugins/midi_amp/mappings/{filename:path}")
    def save_mapping(filename: str, data: dict):
        conn = _get_conn()
        # cc2_number is nullable — None means "no second CC, skip".
        # Storing 0 instead would silently send CC#0 (Bank Select MSB)
        # which is the opposite of what the user wanted.
        cc2_number = data.get("cc2_number")
        if cc2_number is not None:
            try:
                cc2_number = int(cc2_number)
            except (TypeError, ValueError):
                cc2_number = None
        with _lock:
            conn.execute(
                "INSERT OR REPLACE INTO midi_mappings "
                "(filename, tone_key, tone_name, midi_channel, msg_type, "
                "cc_number, bank_number, value, cc2_number, cc2_value) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (filename, data.get("tone_key", ""), data.get("tone_name", ""),
                 data.get("channel", 0), data.get("msg_type", "cc"),
                 data.get("cc_number", 0), data.get("bank_number", 0),
                 data.get("value", 0), cc2_number, data.get("cc2_value", 0))
            )
            conn.commit()
        return {"ok": True}

    @app.delete("/api/plugins/midi_amp/mappings/{mapping_id}")
    def delete_mapping(mapping_id: int):
        conn = _get_conn()
        with _lock:
            conn.execute("DELETE FROM midi_mappings WHERE id = ?", (mapping_id,))
            conn.commit()
        return {"ok": True}

    @app.get("/api/plugins/midi_amp/song-tones/{filename:path}")
    def get_song_tones(filename: str):
        """Auto-extraction of tone keys from a song has been removed
        (it read the encrypted CDLC container). Map tones manually;
        returns an empty list so the UI degrades gracefully."""
        return {"tones": []}
