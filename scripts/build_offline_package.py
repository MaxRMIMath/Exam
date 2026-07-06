from __future__ import annotations

import base64
import html
import json
import mimetypes
import re
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "deck.json"
MEDIA_DIR = ROOT / "media"
CSS_PATH = ROOT / "styles.css"
JS_PATH = ROOT / "app.js"
OUTPUT_DIR = ROOT / "dist"
HTML_NAME = "Exam 7 Flashcards Offline.html"
ZIP_NAME = "Exam 7 Flashcards Offline.zip"


def main() -> None:
    if not DATA_PATH.exists():
        raise SystemExit(f"Missing deck data: {DATA_PATH}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    deck = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    media_cache = load_media_cache(deck)
    embed_media(deck, media_cache)

    html = render_html(deck)
    html_path = OUTPUT_DIR / HTML_NAME
    html_path.write_text(html, encoding="utf-8")

    zip_path = OUTPUT_DIR / ZIP_NAME
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(html_path, arcname=HTML_NAME)

    print(f"Wrote {html_path}")
    print(f"Wrote {zip_path}")


def load_media_cache(deck: dict) -> dict[str, str]:
    media_cache: dict[str, str] = {}
    for card in deck.get("cards", []):
        for field_name in ("frontHtml", "backHtml"):
            html = card.get(field_name, "")
            for filename in extract_media_filenames(html):
                media_name = normalize_media_name(filename)
                if media_name in media_cache:
                    continue
                media_cache[media_name] = media_file_to_data_url(media_name)
    return media_cache


def extract_media_filenames(html: str) -> list[str]:
    return re.findall(r'src="([^"]+)"', html)


def normalize_media_name(filename: str) -> str:
    filename = html.unescape(filename)
    if filename.startswith("media/"):
      return filename[len("media/") :]
    return filename


def media_file_to_data_url(filename: str) -> str:
    path = MEDIA_DIR / filename
    if not path.exists():
        raise SystemExit(f"Missing media file: {path}")

    mime, _ = mimetypes.guess_type(path.name)
    mime = mime or "application/octet-stream"
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{payload}"


def embed_media(deck: dict, media_cache: dict[str, str]) -> None:
    for card in deck.get("cards", []):
        for field_name in ("frontHtml", "backHtml"):
            html = card.get(field_name, "")
            if not html:
                continue
            for filename, data_url in media_cache.items():
                html = html.replace(f'src="media/{filename}"', f'src="{data_url}"')
                html = html.replace(f'src="{filename}"', f'src="{data_url}"')
            card[field_name] = html


def render_html(deck: dict) -> str:
    css = CSS_PATH.read_text(encoding="utf-8")
    js = JS_PATH.read_text(encoding="utf-8")
    deck_json = json.dumps(deck, ensure_ascii=False, separators=(",", ":"))
    deck_json = js_safe_json(deck_json)

    return f"""<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#081018" />
    <meta name="color-scheme" content="dark light" />
    <title>Exam 7 Flashcards</title>
    <style>{css}</style>
  </head>
  <body>
    <div id="app" class="app-shell">
      <div class="loading-state">
        <div class="loading-kicker">Exam 7 Flashcards</div>
        <div class="loading-title">Preparing your deck…</div>
        <div class="loading-subtitle">Loading the embedded offline deck.</div>
      </div>
    </div>
    <script>window.__DECK_DATA__ = {deck_json};</script>
    <script>{js}</script>
  </body>
</html>
"""


def js_safe_json(json_text: str) -> str:
    return (
        json_text
        .replace("</", "<\\/")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


if __name__ == "__main__":
    main()
