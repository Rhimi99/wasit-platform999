#!/usr/bin/env python3
"""Build print-ready HTML from the partnership Markdown sources.

Renders Arabic + Latin with the project's bundled Noto Sans Arabic font, so the
PDF has real glyphs (no tofu) without depending on system fonts.
"""
import base64
import pathlib
import re
import sys

import markdown

ROOT = pathlib.Path('/workspace/project')
DOCS = ROOT / '.partner-docs'
FONT = ROOT / 'packages/server/assets/fonts/NotoSansArabic-Regular.ttf'

font_b64 = base64.b64encode(FONT.read_bytes()).decode()

CSS = """
@font-face {
  font-family: 'NotoArabic';
  src: url(data:font/ttf;base64,__FONT__) format('truetype');
  font-weight: normal;
}
@page { size: A4; margin: 18mm 16mm 16mm 16mm; }
* { box-sizing: border-box; }
body {
  font-family: 'NotoArabic', 'DejaVu Sans', sans-serif;
  direction: rtl; text-align: right;
  font-size: 10.5pt; line-height: 1.75; color: #1e293b;
  margin: 0;
}
h1 { font-size: 21pt; color: #0f3d5c; border-bottom: 3px solid #0f3d5c;
     padding-bottom: .3rem; margin: 0 0 1rem; text-align: center; }
h2 { font-size: 15pt; color: #0f3d5c; margin: 1.6rem 0 .7rem;
     border-bottom: 1px solid #cbd5e1; padding-bottom: .25rem; page-break-after: avoid; }
h3 { font-size: 12.5pt; color: #14532d; margin: 1.2rem 0 .5rem; page-break-after: avoid; }
h4 { font-size: 11pt; color: #334155; margin: 1rem 0 .4rem; page-break-after: avoid; }
p, li { text-align: right; }
table { border-collapse: collapse; width: 100%; margin: .8rem 0 1.2rem;
        font-size: 9.3pt; page-break-inside: avoid; }
th { background: #0f3d5c; color: #fff; padding: .45rem .5rem; text-align: right;
     border: 1px solid #0f3d5c; }
td { padding: .4rem .5rem; border: 1px solid #cbd5e1; text-align: right; vertical-align: top; }
tbody tr:nth-child(even) { background: #f1f5f9; }
code { font-family: 'DejaVu Sans Mono', monospace; direction: ltr; unicode-bidi: embed;
       background: #f1f5f9; padding: .1rem .3rem; border-radius: 3px; font-size: 8.8pt; }
pre { direction: ltr; text-align: left; background: #f8fafc; border: 1px solid #cbd5e1;
      border-left: 4px solid #0f3d5c; border-radius: 4px; padding: .7rem .8rem;
      overflow-x: auto; page-break-inside: avoid; margin: .8rem 0 1.2rem; }
pre code { background: none; padding: 0; font-size: 8.2pt; line-height: 1.5; white-space: pre; }
blockquote { margin: .9rem 0; padding: .6rem .9rem; background: #fffbeb;
             border-right: 4px solid #d97706; border-radius: 4px; font-size: 9.8pt; }
blockquote p { margin: .3rem 0; }
hr { border: none; border-top: 1px solid #cbd5e1; margin: 1.6rem 0; }
a { color: #0f3d5c; text-decoration: none; }
strong { color: #0f172a; }
ul, ol { padding-right: 1.4rem; padding-left: 0; }
li { margin: .25rem 0; }
.cover { page-break-after: always; text-align: center; padding-top: 5rem; }
.cover h1 { font-size: 30pt; border: none; margin-bottom: .6rem; }
.cover .sub { font-size: 15pt; color: #14532d; margin: .4rem 0; }
.cover .en { font-size: 12pt; color: #64748b; letter-spacing: .05em; }
.cover .meta { margin-top: 3rem; font-size: 9.5pt; color: #64748b; }
.cover .rule { width: 90px; height: 4px; background: #0f3d5c; margin: 1.4rem auto; }
.section-break { page-break-before: always; }
"""


def build(src_name: str, out_name: str, cover: str, title: str) -> None:
    text = (DOCS / src_name).read_text(encoding='utf-8')
    body = markdown.markdown(
        text, extensions=['tables', 'fenced_code', 'sane_lists', 'attr_list']
    )
    # Start each numbered top-level section on a fresh page for a clean read.
    body = body.replace('<h2>', '<h2 class="section-break">', 1)
    html = f"""<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>{title}</title>
<style>{CSS.replace('__FONT__', font_b64)}</style></head><body>
<div class="cover">
  <h1>WASIT BUSINESS GLOBAL</h1>
  <div class="rule"></div>
  <div class="sub">{cover}</div>
  <div class="en">Global Digital Trade Intermediary</div>
  <div class="rule"></div>
  <div class="meta">الإصدار الموثّق: b03d17b · التاريخ: 2026-10-04<br>
  وثيقة شراكة — توثيق وتحليل فقط</div>
</div>
{body}
</body></html>"""
    (DOCS / out_name).write_text(html, encoding='utf-8')
    print('wrote', out_name, len(html), 'bytes')


if __name__ == '__main__':
    build(
        'WASIT-BUSINESS-GLOBAL-PARTNERSHIP-DOSSIER.md',
        'dossier.html',
        'PARTNERSHIP PRESENTATION &amp; PLATFORM DOSSIER<br>الوسيط للتجارة الرقمية',
        'WASIT BUSINESS GLOBAL — Partnership Dossier',
    )
    build(
        'WASIT-BUSINESS-GLOBAL-PARTNER-PRESENTATION.md',
        'presentation.html',
        'PARTNER PRESENTATION<br>الوسيط للتجارة الرقمية',
        'WASIT BUSINESS GLOBAL — Partner Presentation',
    )
