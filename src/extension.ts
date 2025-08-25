// extension.ts
import * as vscode from 'vscode';
import WebSocket from 'ws';

/* ---------- Message shapes we expect from the server ---------- */
type ServerMessage =
  | { type: 'created'; sessionId: string }
  | { type: 'joined'; sessionId: string; name: string }
  | { type: 'users'; sessionId: string; users: Array<{ name: string }> }
  | { type: 'code'; sessionId: string; name: string; code: string }
  | { type: 'error'; message?: string }
  | Record<string, unknown>;

/* ---------- Runtime state ---------- */
let ws: WebSocket | undefined;
let sessionId: string | undefined;
let nickname: string | undefined;

const usersBySession = new Map<string, Set<string>>();
let treeDataProvider: SessionTreeProvider | undefined;

/* ---------- Small runtime type guards ---------- */
function asString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}
function asUserList(x: unknown): Array<{ name: string }> | undefined {
  if (!Array.isArray(x)) return undefined;
  const ok = x.every(u => u && typeof u === 'object' && typeof (u as any).name === 'string');
  return ok ? (x as Array<{ name: string }>) : undefined;
}

/* ---------- WebSocket lifecycle (single shared socket) ---------- */
async function ensureSocket(): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;

  ws = new WebSocket('ws://localhost:3000');

  // Handle all server messages in one place
  ws.on('message', (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString()) as ServerMessage;

      // Debug logs (helpful during development)
      console.log('[MSG]', msg);
      console.log('[STATE before]', { sessionId, nickname });

      switch (msg.type) {
        case 'created': {
          const sid = asString((msg as any).sessionId);
          if (!sid) return;
          sessionId = sid;
          void vscode.env.clipboard.writeText(sid);
          void vscode.window.showInformationMessage(`🟢 Session "${sid}" created and copied to clipboard.`);
          if (!usersBySession.has(sid)) usersBySession.set(sid, new Set());
          treeDataProvider?.refresh();
          break;
        }

        case 'joined': {
          const sid = asString((msg as any).sessionId);
          const name = asString((msg as any).name);
          if (!sid || !name) return;

          sessionId = sid;
          nickname = name;

          void vscode.window.showInformationMessage(`✅ Connected to session ${sid} as ${name}`);

          const set = usersBySession.get(sid) ?? new Set<string>();
          set.add(name);
          usersBySession.set(sid, set);
          treeDataProvider?.refresh();
          break;
        }

        case 'users': {
          const sid = asString((msg as any).sessionId);
          const list = asUserList((msg as any).users);
          if (!sid || !list) return;

          const names = list.map(u => u.name);
          usersBySession.set(sid, new Set(names));
          treeDataProvider?.refresh();
          break;
        }

        case 'code': {
          const sid = asString((msg as any).sessionId);
          const name = asString((msg as any).name);
          const code = asString((msg as any).code);
          if (!sid || !name || typeof code !== 'string') return;

          // Only open if message is for my current session and not from me
          if (sid === sessionId && name !== nickname) {
            void vscode.window.showInformationMessage(`📥 Received code from ${name}`);
            vscode.workspace.openTextDocument({ content: code }).then(doc => {
              void vscode.window.showTextDocument(doc, { preview: false });
            });
          }
          break;
        }

        case 'error': {
          const message = asString((msg as any).message) ?? 'Unknown error from server';
          void vscode.window.showErrorMessage(`❌ ${message}`);
          break;
        }

        default:
          // Ignore unknown message types
          break;
      }
    } catch (err) {
      console.error('Invalid message from server:', err);
    }
  });

  // Wait until socket is open or fails
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws?.off('open', onOpen);
      ws?.off('error', onError);
      resolve();
    };
    const onError = (e: unknown) => {
      ws?.off('open', onOpen);
      ws?.off('error', onError);
      reject(e);
    };
    ws?.on('open', onOpen);
    ws?.once('error', onError);
  });

  return ws!;
}

/* ---------- Safe send helper ---------- */
function send(payload: unknown) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    console.error('Failed to send payload:', e);
  }
}

/* ---------- Commands ---------- */

/** Host: open a session (asks for host nickname) */
const openSessionCmd = vscode.commands.registerCommand('collab-session.openSession', async () => {
  try {
    const hostNick = await vscode.window.showInputBox({
      prompt: 'Enter your display name (host)',
      placeHolder: 'e.g. Hiba',
      value: nickname ?? 'host'
    });
    if (!hostNick) {
      void vscode.window.showWarningMessage('⚠️ No name entered.');
      return;
    }

    await ensureSocket();

    const proposedId = Math.random().toString(36).slice(2, 8).toUpperCase();
    nickname = hostNick.trim();

    // Server will reply with {type:'created', sessionId}
    send({ type: 'create', sessionId: proposedId, nickname });
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to open session: ${String(err)}`);
  }
});

/** Guest: join an existing session (asks for nickname) */
const joinSessionCmd = vscode.commands.registerCommand('collab-session.joinSession', async () => {
  const inputId = await vscode.window.showInputBox({
    prompt: 'Enter session ID to join',
    placeHolder: 'ABC123'
  });
  if (!inputId) {
    void vscode.window.showWarningMessage('⚠️ No session ID entered.');
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Enter your name or nickname',
    placeHolder: 'student123'
  });
  if (!name) {
    void vscode.window.showWarningMessage('⚠️ No name entered.');
    return;
  }

  try {
    await ensureSocket();

    nickname = name.trim();
    const sid = inputId.trim().toUpperCase();

    // Server will reply with {type:'joined', sessionId, name}
    send({ type: 'join', sessionId: sid, nickname });

    // After join, send current document and changes
    setTimeout(() => {
      const editor = vscode.window.activeTextEditor;
      if (editor && sessionId && nickname && ws?.readyState === WebSocket.OPEN) {
        const code = editor.document.getText();
        send({ type: 'code', sessionId, name: nickname, code });
      }

      vscode.workspace.onDidChangeTextDocument(event => {
        const editorNow = vscode.window.activeTextEditor;
        if (
          editorNow &&
          event.document === editorNow.document &&
          sessionId &&
          nickname &&
          ws?.readyState === WebSocket.OPEN
        ) {
          const updatedCode = event.document.getText();
          send({ type: 'code', sessionId, name: nickname, code: updatedCode });
        }
      });
    }, 200);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to join: ${String(err)}`);
  }
});

/** Manual: send current editor content to the session */
const sendCodeCmd = vscode.commands.registerCommand('collab-session.sendCode', () => {
  const editor = vscode.window.activeTextEditor;
  if (editor && ws?.readyState === WebSocket.OPEN && sessionId && nickname) {
    const code = editor.document.getText();
    send({ type: 'code', sessionId, name: nickname, code });
    void vscode.window.showInformationMessage('📤 Code sent to session.');
  } else {
    void vscode.window.showWarningMessage('⚠️ Cannot send code. Not connected or no editor open.');
  }
});

/** Show the connected users list from memory */
const printUsersCmd = vscode.commands.registerCommand('collab-session.printUsers', () => {
  if (!sessionId) {
    void vscode.window.showWarningMessage('👤 Not connected to any session.');
    return;
  }
  const set = usersBySession.get(sessionId);
  const list = set ? Array.from(set) : [];
  void vscode.window.showInformationMessage(`👥 Connected users: ${list.join(', ') || '(none)'}`);
});

/* ---------- Side tree view (Connected Users) ---------- */

class SessionTreeProvider implements vscode.TreeDataProvider<UserItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<UserItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: UserItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<UserItem[]> {
    if (!sessionId) return Promise.resolve([]);
    const set = usersBySession.get(sessionId);
    const users = set ? Array.from(set) : [];
    return Promise.resolve(users.map(u => new UserItem(u)));
  }
}

class UserItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

/* ---------- Extension entry points ---------- */

export function activate(context: vscode.ExtensionContext) {
  treeDataProvider = new SessionTreeProvider();
  vscode.window.registerTreeDataProvider('collabSessionUsers', treeDataProvider);

  context.subscriptions.push(
    openSessionCmd,
    joinSessionCmd,
    sendCodeCmd,
    printUsersCmd
  );
}

export function deactivate() {
  try { ws?.close(); } catch { /* ignore */ }
}
