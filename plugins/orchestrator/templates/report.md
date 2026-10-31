<!-- Final report, Polish, hard cap 35 lines (enforced by `run.mjs report`). One line per list item; fields come from the report JSON. -->
## {{icon}} {{title}}
**Wynik:** {{label}}. {{summary}}
### Co zrobiono i jak
{{#done}}- {{.}}
### Testy
{{#tests}}- {{.}}
{{^tests}}- nie uruchamiano (brak testów w repo)
### Nie zrobiono
{{#not_done}}- {{.}}
{{^not_done}}- nic
### Decyzje podjęte za Ciebie
{{#decisions}}- {{.}}
{{^decisions}}- brak
### Review innych modeli
{{#reviews}}- {{.}}
{{^reviews}}- nie dotyczy
### Fallbacki i pule
- **Fallbacki:** {{fallbacks}}
- **Pule:** {{pool}}
### Commity
{{#commits}}- `{{.}}`
{{^commits}}- brak
