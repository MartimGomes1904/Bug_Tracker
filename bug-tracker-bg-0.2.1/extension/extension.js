const vscode = require('vscode');

const VIEW_TYPE = 'bugTracker.editor';
const CLOSED_STATUS = ['resolvido', 'nao-corrigir'];
const STATUS_LABEL = {
  aberto: 'Aberto',
  progresso: 'Em progresso',
  teste: 'Em teste',
  resolvido: 'Resolvido',
  'nao-corrigir': 'Não corrigir',
};
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'ogv'];
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function emptyData() {
  return { version: 1, nextId: 1, bugs: [] };
}

// Lê o texto do ficheiro .bg e devolve { data } ou { error }
function parseDocument(text) {
  if (!text || !text.trim()) {
    return { data: emptyData() };
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'O ficheiro .bg tem de ser um objeto JSON.' };
    }
    const bugs = Array.isArray(raw.bugs) ? raw.bugs : [];
    let maxId = 0;
    for (const b of bugs) {
      if (b && typeof b.id === 'number' && b.id > maxId) maxId = b.id;
    }
    const nextId = Math.max(Number(raw.nextId) || 1, maxId + 1);
    return { data: { version: 1, nextId, bugs: bugs.filter((b) => b && typeof b === 'object') } };
  } catch (e) {
    return { error: 'JSON inválido: ' + e.message };
  }
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function kindOf(name) {
  const e = extOf(name);
  if (IMAGE_EXT.includes(e)) return 'image';
  if (VIDEO_EXT.includes(e)) return 'video';
  return null;
}

function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'ficheiro';
}

function baseName(uri) {
  const p = uri.path;
  return p.slice(p.lastIndexOf('/') + 1);
}

class BugEditorProvider {
  constructor(context) {
    this.context = context;
  }

  static register(context) {
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new BugEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  async resolveCustomTextEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const docBase = baseName(document.uri).replace(/\.bg$/i, '');
    const attachDirName = docBase + '.anexos';
    const attachDir = vscode.Uri.joinPath(docDir, attachDirName);

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), docDir],
    };
    webview.html = this.getHtml(webview);

    let lastWritten = null;
    let counter = 0;

    const sendDocument = () => {
      const result = parseDocument(document.getText());
      webview.postMessage({
        type: 'load',
        baseUri: webview.asWebviewUri(docDir).toString(),
        attachDirName,
        ...result,
      });
    };

    // Guarda um ficheiro de anexo e devolve { name, path, kind }
    const storeAttachment = async (displayName, writeFn) => {
      const kind = kindOf(displayName);
      if (!kind) return null;
      await vscode.workspace.fs.createDirectory(attachDir);
      counter += 1;
      const stored = `${Date.now().toString(36)}${counter}_${sanitizeName(displayName)}`;
      const target = vscode.Uri.joinPath(attachDir, stored);
      await writeFn(target);
      return { name: displayName, path: `${attachDirName}/${stored}`, kind };
    };

    const resolveAttachmentUri = (rel) => {
      if (typeof rel !== 'string' || rel.split('/').some((s) => s === '..')) return null;
      return vscode.Uri.joinPath(docDir, ...rel.split('/'));
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      // Ignora as alterações que nós próprios acabámos de escrever
      if (lastWritten !== null && document.getText() === lastWritten) return;
      sendDocument();
    });

    webviewPanel.onDidDispose(() => changeSub.dispose());

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          sendDocument();
          break;

        case 'update': {
          const text = JSON.stringify(msg.data, null, 2) + '\n';
          if (text === document.getText()) return;
          lastWritten = text;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
          await vscode.workspace.applyEdit(edit);
          break;
        }

        case 'openText':
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;

        case 'pickAttachments': {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Anexar',
            filters: { 'Imagens e vídeos': [...IMAGE_EXT, ...VIDEO_EXT] },
          });
          const items = [];
          for (const src of picked || []) {
            try {
              const item = await storeAttachment(baseName(src), (target) =>
                vscode.workspace.fs.copy(src, target, { overwrite: false })
              );
              if (item) items.push(item);
            } catch (e) {
              vscode.window.showErrorMessage('Não foi possível anexar ' + baseName(src) + ': ' + e.message);
            }
          }
          webview.postMessage({ type: 'attachmentsAdded', reqId: msg.reqId, items });
          break;
        }

        case 'saveAttachmentData': {
          const items = [];
          try {
            const buf = Buffer.from(String(msg.data || ''), 'base64');
            if (buf.length > MAX_UPLOAD_BYTES) {
              vscode.window.showWarningMessage('O ficheiro é demasiado grande (máx. 100 MB). Usa o botão "Anexar…".');
            } else {
              const item = await storeAttachment(String(msg.name || 'imagem.png'), (target) =>
                vscode.workspace.fs.writeFile(target, buf)
              );
              if (item) items.push(item);
              else vscode.window.showWarningMessage('Só são aceites imagens e vídeos.');
            }
          } catch (e) {
            vscode.window.showErrorMessage('Não foi possível guardar o anexo: ' + e.message);
          }
          webview.postMessage({ type: 'attachmentsAdded', reqId: msg.reqId, items });
          break;
        }

        case 'openAttachment': {
          const uri = resolveAttachmentUri(msg.path);
          if (uri) await vscode.env.openExternal(uri);
          break;
        }

        case 'revealAttachment': {
          const uri = resolveAttachmentUri(msg.path);
          if (uri) await vscode.commands.executeCommand('revealFileInOS', uri);
          break;
        }
      }
    });
  }

  getHtml(webview) {
    const mediaUri = (file) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
      `media-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${mediaUri('editor.css')}">
  <title>Bug Tracker</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${mediaUri('editor.js')}"></script>
</body>
</html>`;
  }
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

// ---------- Barra de estado ----------

let statusItem = null;
let statusTimer = null;
let lastFiles = []; // [{ uri, pending, total }]

async function collectFiles() {
  const uris = await vscode.workspace.findFiles('**/*.bg', '**/node_modules/**', 50);
  const out = [];
  for (const uri of uris) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    let text;
    if (open) {
      text = open.getText();
    } else {
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch {
        continue;
      }
    }
    const parsed = parseDocument(text);
    if (parsed.error) continue;
    out.push({ uri, bugs: parsed.data.bugs });
  }
  return out;
}

async function refreshStatusBar() {
  if (!statusItem) return;
  const files = await collectFiles();
  if (files.length === 0) {
    lastFiles = [];
    statusItem.hide();
    return;
  }

  const byStatus = {};
  let pending = 0;
  let critical = 0;
  lastFiles = [];
  for (const f of files) {
    let filePending = 0;
    for (const b of f.bugs) {
      const status = STATUS_LABEL[b.status] ? b.status : 'aberto';
      if (CLOSED_STATUS.includes(status)) continue;
      pending += 1;
      filePending += 1;
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (b.priority === 'critica') critical += 1;
    }
    lastFiles.push({ uri: f.uri, pending: filePending, total: f.bugs.length });
  }

  statusItem.text = `$(bug) ${pending} ${pending === 1 ? 'aberto' : 'abertos'}`;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Bugs por resolver: ${pending}**\n\n`);
  for (const key of ['aberto', 'progresso', 'teste']) {
    if (byStatus[key]) md.appendMarkdown(`- ${STATUS_LABEL[key]}: ${byStatus[key]}\n`);
  }
  if (critical) md.appendMarkdown(`\n⚠ Críticos: ${critical}\n`);
  md.appendMarkdown('\n_Clica para abrir_');
  statusItem.tooltip = md;
  statusItem.backgroundColor = critical
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  statusItem.show();
}

function scheduleStatusRefresh() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    refreshStatusBar().catch(() => {});
  }, 400);
}

async function openMain() {
  if (lastFiles.length === 0) {
    await refreshStatusBar();
  }
  if (lastFiles.length === 0) {
    vscode.window.showInformationMessage('Não há ficheiros .bg neste workspace. Usa "Bug Tracker: Novo ficheiro .bg".');
    return;
  }
  let target = lastFiles[0].uri;
  if (lastFiles.length > 1) {
    const pick = await vscode.window.showQuickPick(
      lastFiles.map((f) => ({
        label: vscode.workspace.asRelativePath(f.uri),
        description: `${f.pending} por resolver · ${f.total} no total`,
        uri: f.uri,
      })),
      { placeHolder: 'Que lista de bugs queres abrir?' }
    );
    if (!pick) return;
    target = pick.uri;
  }
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
}

// ---------- Comandos ----------

async function newFile() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) {
    vscode.window.showWarningMessage('Abre primeiro uma pasta no VS Code.');
    return;
  }
  let name = await vscode.window.showInputBox({
    prompt: 'Nome do ficheiro de bugs',
    value: 'bugs.bg',
  });
  if (!name) return;
  if (!name.endsWith('.bg')) name += '.bg';
  const uri = vscode.Uri.joinPath(folder.uri, name);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const content = Buffer.from(JSON.stringify(emptyData(), null, 2) + '\n', 'utf8');
    await vscode.workspace.fs.writeFile(uri, content);
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

async function openAsText() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (input && input.uri) {
    await vscode.commands.executeCommand('vscode.openWith', input.uri, 'default');
  }
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusItem.command = 'bugTracker.openMain';
  statusItem.name = 'Bug Tracker';

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.bg');

  context.subscriptions.push(
    statusItem,
    watcher,
    watcher.onDidCreate(scheduleStatusRefresh),
    watcher.onDidChange(scheduleStatusRefresh),
    watcher.onDidDelete(scheduleStatusRefresh),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.path.toLowerCase().endsWith('.bg')) scheduleStatusRefresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleStatusRefresh),
    BugEditorProvider.register(context),
    vscode.commands.registerCommand('bugTracker.newFile', newFile),
    vscode.commands.registerCommand('bugTracker.openAsText', openAsText),
    vscode.commands.registerCommand('bugTracker.openMain', openMain)
  );

  scheduleStatusRefresh();
}

function deactivate() {
  clearTimeout(statusTimer);
}

module.exports = { activate, deactivate };
