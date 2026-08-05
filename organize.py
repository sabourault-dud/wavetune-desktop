import re
import os

def réorganiser_projet():
    if not os.path.exists('app.html'):
        print("Erreur : Mettez ce script dans le même dossier que votre fichier 'app.html'.")
        return
        
    with open('app.html', 'r', encoding='utf-8') as f:
        content = f.read()

    # Création du dossier src s'il n'existe pas
    os.makedirs('src', exist_ok=True)

    # 1. Extraction de la police Inter (Base64)
    font_pattern = r'(@font-face\s*\{[^}]*font-family:\s*\'Inter\'[^}]*src:\s*url\(\'data:font/woff2;base64,[^\']+\'\)[^}]*\})'
    fonts_found = re.findall(font_pattern, content)
    
    if fonts_found:
        with open('src/fonts.css', 'w', encoding='utf-8') as f:
            f.write("/* ── POLICES INTER EMBARQUÉES ── */\n\n" + fonts_found[0])
        content = content.replace(fonts_found[0], "/* Base64 Font déplacée dans src/fonts.css */")
        print("✔ Fichier src/fonts.css créé.")

    # 2. Extraction du reste du CSS
    style_pattern = r'<style>(.*?)</style>'
    styles = re.findall(style_pattern, content, re.DOTALL)
    if styles:
        full_css = "\n\n".join(styles)
        with open('src/style.css', 'w', encoding='utf-8') as f:
            f.write("/* ── STYLES DE L'APPLICATION ── */\n" + full_css)
        content = re.sub(style_pattern, "", content, flags=re.DOTALL)
        print("✔ Fichier src/style.css créé.")

    # 3. Extraction du JavaScript Inline (Recherche, filtres, UI)
    script_pattern = r'<script>(.*?)</script>'
    scripts = re.findall(script_pattern, content, re.DOTALL)
    if scripts:
        full_js = "\n\n".join(scripts)
        with open('src/app-logic.js', 'w', encoding='utf-8') as f:
            f.write("// ── LOGIQUE DE L'APPLICATION ──\n" + full_js)
        content = re.sub(script_pattern, "", content, flags=re.DOTALL)
        print("✔ Fichier src/app-logic.js créé.")

    # 4. Injection des nouveaux liens propres dans le HTML
    link_tags = '\n<link rel="stylesheet" href="./src/fonts.css">\n<link rel="stylesheet" href="./src/style.css">'
    content = content.replace('</head>', f'{link_tags}\n</head>')
    
    js_tags = '\n<script src="./src/app-logic.js"></script>'
    if '</body>' in content:
        content = content.replace('</body>', f'{js_tags}\n</body>')
    else:
        content += js_tags

    with open('app_clean.html', 'w', encoding='utf-8') as f:
        f.write(content)
    print("✔ Terminé ! Votre nouveau fichier propre est 'app_clean.html'.")

if __name__ == '__main__':
    réorganiser_projet()