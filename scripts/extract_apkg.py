from __future__ import annotations

import html
import json
import re
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APKG_PATH = ROOT / "Exam 7 RF Flashcards 041026.apkg"
DATA_DIR = ROOT / "data"
MEDIA_DIR = ROOT / "media"


def main() -> None:
    if not APKG_PATH.exists():
        raise SystemExit(f"Missing APKG file: {APKG_PATH}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(APKG_PATH) as archive:
        media_map = json.loads(archive.read("media").decode("utf-8"))
        media_blob_by_name = {original_name: blob_name for blob_name, original_name in media_map.items()}

        with tempfile.TemporaryDirectory() as tmpdir:
            collection_path = Path(tmpdir) / "collection.anki21"
            collection_path.write_bytes(archive.read("collection.anki21"))

            conn = sqlite3.connect(collection_path)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            col_row = cur.execute("SELECT models, decks FROM col").fetchone()
            models = json.loads(col_row["models"])
            decks = json.loads(col_row["decks"])

            deck_id = pick_primary_deck(cur)
            deck = decks[str(deck_id)]
            model = models[str(pick_primary_model(cur))]

            cards = cur.execute(
                """
                SELECT
                    n.id AS note_id,
                    n.guid AS guid,
                    n.mid AS model_id,
                    n.tags AS tags,
                    n.flds AS fields,
                    n.sfld AS sort_field,
                    c.id AS card_id,
                    c.did AS deck_id,
                    c.ord AS card_ord,
                    c.type AS card_type,
                    c.queue AS queue,
                    c.due AS due
                FROM notes n
                JOIN cards c ON c.nid = n.id
                ORDER BY n.id ASC, c.ord ASC
                """
            ).fetchall()

            deck_cards = []
            for order_index, row in enumerate(cards):
                fields = row["fields"].split("\x1f")
                front = fields[0] if fields else ""
                back = fields[1] if len(fields) > 1 else ""
                deck_cards.append(
                    {
                        "orderIndex": order_index,
                        "noteId": row["note_id"],
                        "cardId": row["card_id"],
                        "guid": row["guid"],
                        "modelId": row["model_id"],
                        "deckId": row["deck_id"],
                        "cardOrd": row["card_ord"],
                        "queue": row["queue"],
                        "type": row["card_type"],
                        "due": row["due"],
                        "tags": parse_tags(row["tags"]),
                        "frontHtml": front,
                        "backHtml": back,
                        "frontText": text_only(front),
                        "backText": text_only(back),
                    }
                )

            ordered_media_names = ordered_media_names_from_cards(deck_cards)
            media_name_map = {original_name: f"{index + 1}.png" for index, original_name in enumerate(ordered_media_names)}

            if MEDIA_DIR.exists():
                shutil.rmtree(MEDIA_DIR)
            MEDIA_DIR.mkdir(parents=True, exist_ok=True)

            for original_name in ordered_media_names:
                blob_name = media_blob_by_name.get(original_name)
                if blob_name is None:
                    raise SystemExit(f"Missing media blob for: {original_name}")

                target = MEDIA_DIR / media_name_map[original_name]
                with archive.open(blob_name) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)

            for card in deck_cards:
                card["frontHtml"] = rewrite_media_refs(card["frontHtml"], media_name_map)
                card["backHtml"] = rewrite_media_refs(card["backHtml"], media_name_map)

            output = {
                "meta": {
                    "apkgFile": APKG_PATH.name,
                    "deckId": deck_id,
                    "deckName": deck.get("name"),
                    "modelId": pick_primary_model(cur),
                    "modelName": model.get("name"),
                    "cardCount": len(deck_cards),
                    "extractedAt": current_timestamp(),
                },
                "cards": deck_cards,
            }

            deck_json = json.dumps(output, ensure_ascii=False, indent=2)
            with open(DATA_DIR / "deck.json", "w", encoding="utf-8") as fh:
                fh.write(deck_json)

            with open(DATA_DIR / "deck-data.js", "w", encoding="utf-8") as fh:
                fh.write("window.__DECK_DATA__ = ")
                fh.write(js_safe_json(deck_json))
                fh.write(";\n")

            conn.close()


def pick_primary_deck(cur: sqlite3.Cursor) -> int:
    rows = cur.execute("SELECT did, COUNT(*) AS count FROM cards GROUP BY did ORDER BY count DESC, did ASC").fetchall()
    return int(rows[0]["did"])


def pick_primary_model(cur: sqlite3.Cursor) -> int:
    rows = cur.execute("SELECT mid, COUNT(*) AS count FROM notes GROUP BY mid ORDER BY count DESC, mid ASC").fetchall()
    return int(rows[0]["mid"])


def parse_tags(raw: str) -> list[str]:
    return [tag for tag in raw.split() if tag.strip()]


def ordered_media_names_from_cards(cards: list[dict]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for card in cards:
        for field_name in ("frontHtml", "backHtml"):
            for filename in extract_media_filenames(card.get(field_name, "")):
                media_name = normalize_media_name(filename)
                if media_name not in seen:
                    seen.add(media_name)
                    ordered.append(media_name)
    return ordered


def extract_media_filenames(html_text: str) -> list[str]:
    return re.findall(r'src="([^"]+)"', html_text)


def normalize_media_name(filename: str) -> str:
    filename = html.unescape(filename)
    if filename.startswith("media/"):
        return filename[len("media/") :]
    return filename


def rewrite_media_refs(html_text: str, media_name_map: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        src = normalize_media_name(match.group(1))
        if src.startswith(("http://", "https://", "data:")):
            return match.group(0)
        target_name = media_name_map.get(src)
        if target_name is None:
            return match.group(0)
        return f'src="media/{target_name}"'

    return re.sub(r'src="([^"]+)"', replace, html_text)


def text_only(html_text: str) -> str:
    stripped = re.sub(r"<[^>]+>", " ", html_text)
    stripped = html.unescape(stripped)
    return re.sub(r"\s+", " ", stripped).strip()


def current_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def js_safe_json(json_text: str) -> str:
    return (
        json_text
        .replace("</", "<\\/")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
        .replace("<", "\\u003c")
    )


if __name__ == "__main__":
    main()
