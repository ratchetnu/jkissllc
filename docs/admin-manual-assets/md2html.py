#!/usr/bin/env python3
"""Minimal, dependency-free Markdown -> print-ready HTML (for LibreOffice -> PDF).
Usage: md2html.py <in.md> <out.html> <BrandName> <accent#hex> <domain> [subtitle]
Handles: headings, tables, ul/ol lists, fenced code + ```mermaid, blockquote
callouts (Warning/Note/Tip/Important), --- rules, [SCREENSHOT: x], inline
**bold** `code` [text](url). Conservative CSS so LibreOffice renders it faithfully.
"""
import sys, re, html

src, out, brand, accent, domain = sys.argv[1:6]
subtitle = sys.argv[6] if len(sys.argv) > 6 else "Administrator Guide"

def esc(s): return html.escape(s, quote=False)

def inline(s):
    s = esc(s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'<a href="\2">\1</a>', s)
    return s

lines = open(src, encoding='utf-8').read().split('\n')
# Drop HTML comments-only lines and the mermaid-heavy TOC anchors stay as text.
out_html, i, n = [], 0, len(lines)

def slug(t): return re.sub(r'[^a-z0-9]+', '-', t.lower()).strip('-')

while i < n:
    ln = lines[i]
    # fenced code / mermaid
    m = re.match(r'^```(\w*)', ln)
    if m:
        lang = m.group(1); i += 1; buf = []
        while i < n and not lines[i].startswith('```'):
            buf.append(lines[i]); i += 1
        i += 1  # closing fence
        body = esc('\n'.join(buf))
        if lang == 'mermaid':
            out_html.append(f'<div class="diagram"><div class="diagram-tag">Diagram</div><pre>{body}</pre></div>')
        else:
            out_html.append(f'<pre class="code">{body}</pre>')
        continue
    # heading
    m = re.match(r'^(#{1,6})\s+(.*)$', ln)
    if m:
        lvl = len(m.group(1)); txt = m.group(2)
        out_html.append(f'<h{lvl} id="{slug(txt)}">{inline(txt)}</h{lvl}>')
        i += 1; continue
    # horizontal rule
    if re.match(r'^---+\s*$', ln):
        out_html.append('<hr>'); i += 1; continue
    # screenshot placeholder
    m = re.match(r'^\[SCREENSHOT:\s*(.*?)\]\s*$', ln)
    if m:
        out_html.append(f'<div class="shot">📷 Screenshot placeholder — {esc(m.group(1))}</div>')
        i += 1; continue
    # table (header row followed by |---| separator)
    if ln.lstrip().startswith('|') and i + 1 < n and re.match(r'^\s*\|[\s:|-]+\|\s*$', lines[i+1]):
        def cells(r): return [c.strip() for c in r.strip().strip('|').split('|')]
        hdr = cells(ln); i += 2; rows = []
        while i < n and lines[i].lstrip().startswith('|'):
            rows.append(cells(lines[i])); i += 1
        t = ['<table><thead><tr>'] + [f'<th>{inline(c)}</th>' for c in hdr] + ['</tr></thead><tbody>']
        for r in rows:
            t.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>')
        t.append('</tbody></table>')
        out_html.append(''.join(t)); continue
    # unordered list
    if re.match(r'^\s*[-*]\s+', ln):
        items = []
        while i < n and re.match(r'^\s*[-*]\s+', lines[i]):
            items.append(f'<li>{inline(re.sub(r"^\s*[-*]\s+", "", lines[i]))}</li>'); i += 1
        out_html.append('<ul>' + ''.join(items) + '</ul>'); continue
    # ordered list
    if re.match(r'^\s*\d+\.\s+', ln):
        items = []
        while i < n and re.match(r'^\s*\d+\.\s+', lines[i]):
            items.append(f'<li>{inline(re.sub(r"^\s*\d+\.\s+", "", lines[i]))}</li>'); i += 1
        out_html.append('<ol>' + ''.join(items) + '</ol>'); continue
    # blockquote (grouped) -> callout
    if ln.startswith('>'):
        buf = []
        while i < n and lines[i].startswith('>'):
            buf.append(re.sub(r'^>\s?', '', lines[i])); i += 1
        text = '\n'.join(buf).strip()
        kind = 'note'
        low = text.lower()
        if low.startswith('**warning'): kind = 'warn'
        elif low.startswith('**important'): kind = 'imp'
        elif low.startswith('**tip'): kind = 'tip'
        out_html.append(f'<div class="callout {kind}">{inline(text).replace(chr(10), "<br>")}</div>')
        continue
    # blank
    if ln.strip() == '':
        i += 1; continue
    # skip pure HTML comment lines
    if ln.strip().startswith('<!--'):
        i += 1; continue
    # paragraph (gather until blank)
    buf = [ln]; i += 1
    while i < n and lines[i].strip() and not re.match(r'^(#{1,6}\s|[-*]\s|\d+\.\s|\||>|```|---)', lines[i]) and not lines[i].lstrip().startswith('|'):
        buf.append(lines[i]); i += 1
    out_html.append('<p>' + inline(' '.join(buf)) + '</p>')

body = '\n'.join(out_html)
CSS = f"""
@page {{ margin: 20mm 18mm; }}
* {{ box-sizing: border-box; }}
body {{ font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 10.5pt; line-height: 1.5; }}
h1 {{ font-size: 20pt; color: {accent}; border-bottom: 2px solid {accent}; padding-bottom: 5px; margin-top: 26px; page-break-after: avoid; }}
h2 {{ font-size: 14pt; color: #111; margin-top: 20px; page-break-after: avoid; }}
h3 {{ font-size: 12pt; color: #333; margin-top: 15px; page-break-after: avoid; }}
p {{ margin: 7px 0; }}
a {{ color: {accent}; text-decoration: none; }}
code {{ font-family: 'SFMono-Regular', Menlo, monospace; font-size: 9pt; background: #f2f3f5; padding: 1px 4px; border-radius: 3px; }}
pre.code {{ background: #f6f7f9; border: 1px solid #e3e6ea; border-radius: 5px; padding: 10px; font-size: 8.5pt; white-space: pre-wrap; overflow-wrap: anywhere; }}
table {{ border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9pt; page-break-inside: avoid; }}
th {{ background: {accent}; color: #fff; text-align: left; padding: 6px 8px; font-weight: 600; }}
td {{ border: 1px solid #dfe3e8; padding: 5px 8px; vertical-align: top; }}
tr:nth-child(even) td {{ background: #f7f8fa; }}
ul, ol {{ margin: 7px 0 7px 20px; }}
li {{ margin: 3px 0; }}
hr {{ border: none; border-top: 1px solid #e3e6ea; margin: 18px 0; }}
.callout {{ border-left: 4px solid #999; background: #f6f7f9; padding: 9px 12px; margin: 11px 0; border-radius: 0 5px 5px 0; page-break-inside: avoid; }}
.callout.warn {{ border-color: #d9534f; background: #fdf3f2; }}
.callout.imp {{ border-color: {accent}; background: #f3f7ff; }}
.callout.tip {{ border-color: #2e8b57; background: #f1faf4; }}
.diagram {{ border: 1px dashed {accent}; border-radius: 6px; padding: 10px; margin: 12px 0; background: #fbfcfe; page-break-inside: avoid; }}
.diagram-tag {{ font-size: 7.5pt; text-transform: uppercase; letter-spacing: .08em; color: {accent}; font-weight: 700; margin-bottom: 5px; }}
.diagram pre {{ font-family: monospace; font-size: 8pt; white-space: pre-wrap; margin: 0; }}
.shot {{ border: 1px dashed #b8c0cc; background: #f4f6f9; color: #6a7280; text-align: center; padding: 14px; margin: 10px 0; border-radius: 6px; font-size: 9pt; }}
.cover {{ text-align: center; padding-top: 150px; page-break-after: always; }}
.cover .brand {{ font-size: 40pt; font-weight: 800; color: {accent}; letter-spacing: -0.02em; }}
.cover .title {{ font-size: 22pt; margin-top: 8px; color: #111; }}
.cover .sub {{ color: #667; margin-top: 26px; font-size: 11pt; }}
"""
cover = f"""<div class="cover">
  <div class="brand">{esc(brand)}</div>
  <div class="title">{esc(subtitle)}</div>
  <div class="sub">{esc(domain)}<br>Generated 2026-07-20</div>
</div>"""
open(out, 'w', encoding='utf-8').write(
    f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>{cover}{body}</body></html>")
print(f"wrote {out}")
