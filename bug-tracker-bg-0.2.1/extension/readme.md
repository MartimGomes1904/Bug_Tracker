# Bug Tracker (.bg)

Extensão para o VS Code que abre ficheiros `.bg` num editor visual para acompanhar os bugs de um jogo: tabela ou quadro Kanban, estados, prioridades, etiquetas, anexos de imagem e vídeo, histórico e dados de reprodutibilidade.

## Como usar

1. Cria um ficheiro com extensão `.bg` (por exemplo `bugs.bg`), ou corre **Bug Tracker: Novo ficheiro .bg** (Ctrl+Shift+P).
2. Escreve um título na caixa de cima e prime Enter para adicionar rapidamente, ou usa **+ Novo bug** para preencher tudo.
3. Clica num bug para o editar.

Tudo é guardado no próprio ficheiro `.bg` (JSON), por isso Ctrl+Z, Guardar e Git funcionam como em qualquer ficheiro. Para ver o JSON em bruto: **Bug Tracker: Abrir como texto (JSON)**.

## Funcionalidades

- **Tabela e Kanban:** alterna no topo. No Kanban arrastas os cartões entre colunas de estado; se tiveres vários selecionados, movem-se todos. Cada coluna tem uma caixa para adicionar bugs diretamente.
- **Etiquetas:** escreve e prime Enter (ou vírgula). Filtro por etiqueta na barra de ferramentas.
- **Edição em massa:** marca bugs com as caixas (na tabela ou nos cartões). Aparece uma barra para mudar estado e prioridade, adicionar ou remover etiquetas e apagar. Esc limpa a seleção.
- **Reprodutibilidade:** frequência, plataforma, versão/build, passos, comportamento esperado e observado.
- **Anexos de imagem e vídeo:** botão **Anexar…**, colar uma captura de ecrã (Ctrl+V) ou arrastar ficheiros para o diálogo. Os ficheiros são copiados para uma pasta ao lado do `.bg` (`bugs.bg` → `bugs.anexos/`). Clica numa miniatura para ver em ponto grande. Se o vídeo não reproduzir no VS Code, usa **Abrir no sistema**. Remover um anexo ou apagar um bug não apaga o ficheiro da pasta `.anexos`.
- **Histórico:** cada bug regista quando mudou o estado, a prioridade, as etiquetas, os anexos e os outros campos (separador **Histórico**). Guarda as últimas 200 alterações por bug.
- **Barra de estado:** mostra quantos bugs estão por resolver (aberto, em progresso ou em teste) em todos os `.bg` do workspace. Clica para abrir a lista; se houver vários ficheiros, escolhes qual. Fica com fundo de aviso quando há bugs críticos por resolver.

## Formato do ficheiro

```json
{
  "version": 1,
  "nextId": 2,
  "bugs": [
    {
      "id": 1,
      "title": "Personagem atravessa a parede",
      "description": "",
      "steps": "1. …",
      "expected": "",
      "actual": "",
      "area": "Física",
      "version": "0.3.1",
      "platform": "Windows",
      "frequency": "frequente",
      "labels": ["colisões"],
      "attachments": [{ "name": "captura.png", "path": "bugs.anexos/xyz_captura.png", "kind": "image" }],
      "status": "aberto",
      "priority": "alta",
      "createdAt": "2026-10-26T10:00:00.000Z",
      "updatedAt": "2026-10-26T10:00:00.000Z",
      "history": [{ "at": "2026-10-26T10:00:00.000Z", "field": "created", "note": "Bug criado" }]
    }
  ]
}
```

Estados: `aberto`, `progresso`, `teste`, `resolvido`, `nao-corrigir`.
Prioridades: `critica`, `alta`, `media`, `baixa`.
Frequências: `sempre`, `frequente`, `as-vezes`, `raro`, `uma-vez`.

Ficheiros `.bg` da versão anterior continuam a abrir: os campos novos ficam vazios até os preencheres.

## Desenvolvimento

Abre esta pasta no VS Code e prime F5 para testar numa janela nova. Para gerar o instalador: `npx @vscode/vsce package --allow-missing-repository --skip-license`.
