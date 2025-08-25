// src/extension.ts
// -----------------------------------------------------------------------------
// Collab Session - VS Code client
// - Host creates session
// - Students join
// - Host sets question (from Home); students send answer manually
// - Users list updates; notifications for join/leave/close
// - Works with server.js you have
// -----------------------------------------------------------------------------

import * as vscode from 'vscode';
import WebSocket from 'ws';

// ---------- server message types (simple + safe) ------------------------------
type MsgCreated        = { type: 'created'; sessionId: string };
type MsgJoined         = { type: 'joined'; sessionId: string; name: string; question?: string };
type MsgUsers          = { type: 'users'; sessionId: string; users: Array<{ name: string }> };
type MsgUserJoined     = { type: 'userJoined'; sessionId: string; name: string };
type MsgUserLeft       = { type: 'userLeft'; sessionId: string; name: string };
type MsgQuestion       = { type: 'question'; text: string };
type MsgAnswerReceived = { type: 'answerReceived'; name: string; code: string };
type MsgSessionClosed  = { type: 'sessionClosed' };
type MsgError          = { type: 'error'; message?: string };

type ServerMessage =
  | MsgCreated
  | MsgJoined
  | MsgUsers
  | MsgUserJoined
  | MsgUserLeft
  | MsgQuestion
  | MsgAnswerReceived
  | MsgSessionClosed
  | MsgError
  | Record<string, unknown>; // forward compatible

// ---------- globals -----------------------------------------------------------
let ws: WebSocket | undefined;                   // single socket
let sessionId: string | undefined;               // current session id
let nickname: string | undefined;                // my name
let myRole: 'host' | 'student' | undefined;      // chosen role (Home or commands)

const usersBySession = new Map<string, Set<string>>(); // sid -> users
let treeDataProvider: SessionTreeProvider | undefined; // users view (if contributed)
let questionEditor: vscode.TextEditor | undefined;     // one shared question tab
let latestQuestionText: string | undefined;            // cached question

// keep latest answers per student (host only)
const latestAnswers = new Map<string, string>();

let answersProvider: AnswersTreeProvider | undefined; // tree view for answers

// one stable id per VS Code install (good enough for “one client per machine” guard)
const MACHINE_ID = vscode.env.machineId;


// ---------- tiny helpers ------------------------------------------------------
const asString = (x: unknown) => (typeof x === 'string' ? x : undefined);
const asUserList = (x: unknown) =>
  Array.isArray(x) && x.every(o => typeof o?.name === 'string')
    ? (x as Array<{ name: string }>)
    : undefined;

function send(payload: unknown) {
  // JSON send with guard
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch {}
}

function randomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function guessLanguage(code: string): string | undefined {
  // tiny heuristic only
  if (/^\s*#include\s+<.+?>/m.test(code)) return 'cpp';
  if (/^\s*def\s+\w+\(/m.test(code)) return 'python';
  if (/^\s*(import|export)\s+/m.test(code)) return 'typescript';
  return undefined;
}

// keep one tab per student answer
const answerUris = new Map<string, vscode.Uri>();

function answerUriFor(student: string) {
  let uri = answerUris.get(student);
  if (!uri) {
    // untitled uri with a nice name -> tab caption looks like "answer: hiba.txt"
    uri = vscode.Uri.parse(`untitled:answer-${student}.txt`);
    answerUris.set(student, uri);
  }
  return uri;
}

async function openOrUpdateAnswerTab(student: string, code: string) {
  const uri = answerUriFor(student);
  let doc: vscode.TextDocument | undefined;

  // try find already-open doc by URI
  doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (!doc) {
    // open new untitled doc with initial content
    doc = await vscode.workspace.openTextDocument({ language: guessLanguage(code) ?? 'plaintext', content: code });
  } else {
    // update existing
    const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
    if (editor) {
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      await editor.edit(ed => ed.replace(full, code));
    }
  }

  // show beside the question, not preview
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

function goHome() {
  void vscode.commands.executeCommand('collab-session.showHome')
    .then(undefined, () => { /* ignore */ });
}



// ---------- socket lifecycle --------------------------------------------------
async function ensureSocket(): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;

  ws = new WebSocket('ws://192.168.1.187:3000');

  ws.on('message', async (raw: WebSocket.RawData) => {
    let msg: ServerMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'created': {
        const sid = asString((msg as MsgCreated).sessionId);
        if (!sid) return;
        sessionId = sid;
        void vscode.env.clipboard.writeText(sid);
        void vscode.window.showInformationMessage(`🟢 Session "${sid}" created & copied to clipboard.`);
        if (!usersBySession.has(sid)) usersBySession.set(sid, new Set());
        treeDataProvider?.refresh();
        break;
      }

      case 'joined': {
        const m = msg as MsgJoined;
        const sid = asString(m.sessionId);
        const name = asString(m.name);
        if (!sid || !name) return;
        sessionId = sid;
        nickname = name;

        // update users map (will also come via 'users', but this is immediate)
        const set = usersBySession.get(sid) ?? new Set<string>();
        set.add(name);
        usersBySession.set(sid, set);
        treeDataProvider?.refresh();

        void vscode.window.showInformationMessage(`✅ Joined ${sid} as ${name}`);

        // show question if provided
        if (typeof m.question === 'string') {
          latestQuestionText = m.question;
          void showOrUpdateQuestionEditor(latestQuestionText);
        }
        break;
      }

      case 'users': {
        const sid  = asString((msg as any).sessionId);
        const list = asUserList((msg as any).users);
        if (!sid || !list) return;
        const names = list.map(u => u.name);
        usersBySession.set(sid, new Set(names));
        treeDataProvider?.refresh();
        break;
      }

      case 'userJoined': {
        const m = msg as MsgUserJoined;
        if (m.sessionId === sessionId && m.name !== nickname) {
          void vscode.window.showInformationMessage(`👋 ${m.name} joined`);
        }
        break;
      }

      case 'userLeft': {
        const m = msg as MsgUserLeft;
        if (m.sessionId === sessionId) {
          const set = usersBySession.get(m.sessionId) ?? new Set<string>();
          set.delete(m.name);
          usersBySession.set(m.sessionId, set);

          latestAnswers.delete(m.name);
          answersProvider?.refresh();
          treeDataProvider?.refresh();

          void vscode.window.showInformationMessage(`👋 ${m.name} left`);
        }
        break;
      }


      case 'question': {
        const m = msg as MsgQuestion;
        latestQuestionText = asString(m.text) ?? '';
        void showOrUpdateQuestionEditor(latestQuestionText);
        break;
      }

      case 'sessionClosed': {
        // reset local state
        sessionId = undefined;
        nickname = undefined;
        usersBySession.clear();
        treeDataProvider?.refresh();
        void vscode.window.showWarningMessage('🔴 Session closed by host');
        goHome();
        break;
      }

      case 'error': {
        const text = asString((msg as MsgError).message) ?? 'Server error';
        void vscode.window.showErrorMessage(`❌ ${text}`);
        break;
      }

      case 'answerReceived': {
        const m = msg as { type: 'answerReceived'; name?: string; code?: string };
        const name = asString(m.name);
        const code = asString(m.code);

        if (myRole === 'host' && name && typeof code === 'string') {
          latestAnswers.set(name, code);      // store/update student's latest code
          answersProvider?.refresh();         // refresh the "ANSWERS" tree view

          // show a notification with action button
          const choice = await vscode.window.showInformationMessage(
            `📥 Answer from ${name}`,
            'Open'
          );
          if (choice === 'Open') {
            vscode.commands.executeCommand('collab-session.openStudentAnswer', name);
          }
        }
        break;
      }

      case 'feedback': {
        // student sees feedback from host
        const m = msg as { type: 'feedback'; from?: string; text?: string };
        const text = m.text ?? '';

        // open a feedback tab for the student
        vscode.workspace.openTextDocument({
          content: `# Feedback from host\n\n${text}`,
          language: 'markdown'
        }).then(doc => {
          vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        });

        break;
      }


      default:
        // ignore unknown
        break;
    }
  });

  // wait open/error once
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onErr  = (e: unknown) => { cleanup(); reject(e); };
    const cleanup = () => {
      ws?.off('open', onOpen);
      ws?.off('error', onErr);
    };
    ws?.once('open', onOpen);
    ws?.once('error', onErr);
  });

  return ws!;
}

// ---------- commands ----------------------------------------------------------

const cmdOpenStudentAnswer = vscode.commands.registerCommand(
  'collab-session.openStudentAnswer',
  async (arg?: { student?: string } | string) => {
    let student =
      typeof arg === 'string' ? arg :
      typeof arg?.student === 'string' ? arg.student : undefined;

    if (!student) {
      const names = [...latestAnswers.keys()];
      if (names.length === 0) {
        void vscode.window.showInformationMessage('No answers yet.');
        return;
      }
      student = await vscode.window.showQuickPick(names, { placeHolder: 'Select a student' });
    }
    if (!student) return;

    const code = latestAnswers.get(student);
    if (typeof code !== 'string') {
      void vscode.window.showWarningMessage(`${student} has not submitted an answer yet.`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument({
      language: guessLanguage(code) ?? 'plaintext',
      content: code
    });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });

    try {
      await vscode.workspace.fs.rename(
        doc.uri,
        doc.uri.with({ path: `/Answer_from_${student}.txt` }),
        { overwrite: true }
      );
    } catch { /* ignore */ }
  }
);




// Collab Session: Show Home (webview UI)
const cmdShowHome = vscode.commands.registerCommand('collab-session.showHome', async () => {
  const panel = vscode.window.createWebviewPanel(
    'collabHome',
    'Collab Session – Home',
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  panel.webview.html = getHomeHtml();
  panel.webview.onDidReceiveMessage(async (m) => {
    try {
      if (m?.cmd === 'create') {
        myRole = 'host';
        await ensureSocket();
        send({ type: 'create', sessionId: randomId(), machineId: MACHINE_ID });
      } else if (m?.cmd === 'join') {
        myRole = 'student';
        const sid = String(m.sessionId || '').toUpperCase().trim();
        const name = String(m.name || '').trim();
        if (!sid || !name) {
          void vscode.window.showWarningMessage('Session ID and Name are required');
          return;
        }
        await ensureSocket();
        send({ type: 'join', sessionId: sid, name, machineId: MACHINE_ID });
      } else if (m?.cmd === 'setQuestion') {
        if (myRole !== 'host') {
          void vscode.window.showWarningMessage('Only host can set question');
          return;
        }
        await ensureSocket();
        const text = String(m.text || '');
        latestQuestionText = text;
        send({ type: 'setQuestion', text });
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Failed: ${String(e)}`);
    }
  });
});

// Collab Session: Create Session (host)
const cmdCreateSession = vscode.commands.registerCommand('collab-session.createSession', async () => {
  myRole = 'host';
  await ensureSocket();
  send({ type: 'create', sessionId: randomId() });
});

// Collab Session: Join Session (student)
const cmdJoinSession = vscode.commands.registerCommand('collab-session.joinSession', async () => {
  myRole = 'student';
  const inputId = await vscode.window.showInputBox({
    prompt: 'Enter session ID',
    placeHolder: 'ABC123',
    validateInput: v => v.trim() ? undefined : 'Session ID is required'
  });
  if (!inputId) return;

  const name = await vscode.window.showInputBox({
    prompt: 'Enter your name / nickname',
    placeHolder: 'student123',
    validateInput: v => v.trim() ? undefined : 'Name is required'
  });
  if (!name) return;

  await ensureSocket();
  send({ type: 'join', sessionId: inputId.trim().toUpperCase(), name: name.trim() });
});

// Collab Session: Copy Session ID
const cmdCopySessionId = vscode.commands.registerCommand('collab-session.copySessionId', async () => {
  if (!sessionId) {
    void vscode.window.showWarningMessage('No active session.');
    return;
  }
  await vscode.env.clipboard.writeText(sessionId);
  void vscode.window.showInformationMessage(`Copied: ${sessionId}`);
});

// Collab Session: Leave Session (student)
const cmdLeaveSession = vscode.commands.registerCommand('collab-session.leaveSession', async () => {
  if (!sessionId || !nickname || myRole !== 'student') {
    void vscode.window.showWarningMessage('You are not in a student session.');
    return;
  }
  await ensureSocket();
  send({ type: 'leave' }); // server reads sid/name from socketMeta
  sessionId = undefined;
  nickname = undefined;
  usersBySession.clear();
  treeDataProvider?.refresh();
  void vscode.window.showInformationMessage('You left the session.');
  goHome();
});

// Collab Session: Close Session (host)
const cmdCloseSession = vscode.commands.registerCommand('collab-session.closeSession', async () => {
  if (!sessionId || myRole !== 'host') {
    void vscode.window.showWarningMessage('Only host can close an active session.');
    return;
  }
  await ensureSocket();
  send({ type: 'close' }); // server gets sid from socketMeta
  sessionId = undefined;
  usersBySession.clear();
  treeDataProvider?.refresh();
  void vscode.window.showInformationMessage('Session closed.');
  goHome();
});

// Collab Session: Send My Answer (student -> host)
const cmdSendAnswer = vscode.commands.registerCommand('collab-session.sendAnswer', async () => {
  if (!sessionId || !nickname || myRole !== 'student') {
    void vscode.window.showWarningMessage('Join a session as student first.');
    return;
  }
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    void vscode.window.showWarningMessage('Open a file to send.');
    return;
  }
  const code = ed.document.getText();
  await ensureSocket();
  send({ type: 'answer', sessionId, name: nickname, code });
  void vscode.window.showInformationMessage('Answer sent to host.');
});

// Collab Session: Send Feedback (host → one student)
const cmdSendFeedback = vscode.commands.registerCommand(
  'collab-session.sendFeedback',
  async () => {
    if (myRole !== 'host' || !sessionId) {
      void vscode.window.showWarningMessage('Only host can send feedback during an active session.');
      return;
    }

    // prefer students that already sent answers, fallback to all connected users
    const answered = [...latestAnswers.keys()];
    const connected = usersBySession.get(sessionId) ? [...usersBySession.get(sessionId)!] : [];
    const candidates = answered.length ? answered : connected;

    if (!candidates.length) {
      void vscode.window.showInformationMessage('No students available to send feedback to.');
      return;
    }

    const to = await vscode.window.showQuickPick(candidates, { placeHolder: 'Select a student' });
    if (!to) return;

    const text = await vscode.window.showInputBox({
      prompt: `Write feedback for ${to}`,
      placeHolder: 'Your feedback...',
      validateInput: v => v.trim() ? undefined : 'Feedback cannot be empty'
    });
    if (!text) return;

    await ensureSocket();
    send({ type: 'feedback', sessionId, to, text });
    void vscode.window.showInformationMessage(`Feedback sent to ${to}.`);
  }
);

// ---------- question view (single tab) ---------------------------------------
async function showOrUpdateQuestionEditor(text: string) {
  // open or update a single "question" editor
  try {
    if (!questionEditor || questionEditor.document.isClosed) {
      const doc = await vscode.workspace.openTextDocument({
        content: `# Session question\n\n${text}\n`,
        language: 'markdown'
      });
      questionEditor = await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }

    const full = new vscode.Range(
      questionEditor.document.positionAt(0),
      questionEditor.document.positionAt(questionEditor.document.getText().length)
    );
    await questionEditor.edit(edit => edit.replace(full, `# Session question\n\n${text}\n`));
  } catch {
    // keep quiet
  }
}

// ---------- optional: Connected Users tree -----------------------------------
class SessionTreeProvider implements vscode.TreeDataProvider<UserItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<UserItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(element: UserItem): vscode.TreeItem { return element; }

  getChildren(): Thenable<UserItem[]> {
    if (!sessionId) return Promise.resolve([]);
    const set = usersBySession.get(sessionId);
    const users = set ? Array.from(set) : [];
    // pass hasAnswer so we can color + enable click
    return Promise.resolve(users.map(u => new UserItem(u, latestAnswers.has(u))));
  }
}

class UserItem extends vscode.TreeItem {
  constructor(public readonly student: string, hasAnswer: boolean) {
    super(student, vscode.TreeItemCollapsibleState.None);

    // always attach the command; the command will validate if answer exists
    this.command = {
      command: 'collab-session.openStudentAnswer',
      title: 'Open',
      arguments: [{ student }],
    };

    if (hasAnswer) {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      this.tooltip = `${student} • has an answer (click to open)`;
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
      this.tooltip = `${student} • no answer yet (click to see a hint)`;
    }
  }
}




class AnswerItem extends vscode.TreeItem {
  constructor(public readonly student: string) {
    super(student, vscode.TreeItemCollapsibleState.None);
    // open the student's answer on click
    this.command = {
      command: 'collab-session.openStudentAnswer',
      title: 'Open',
      arguments: [{ student: this.student }],
    };
    this.tooltip = `Open ${student}'s latest answer`;
    this.description = '';
    this.iconPath = new vscode.ThemeIcon('file-code');
  }
}

class AnswersTreeProvider implements vscode.TreeDataProvider<AnswerItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AnswerItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(el: AnswerItem): vscode.TreeItem {
    return el;
  }

  getChildren(): Thenable<AnswerItem[]> {
    // only the host needs this view
    if (myRole !== 'host') return Promise.resolve([]);
    const items = [...latestAnswers.keys()].sort().map(name => new AnswerItem(name));
    return Promise.resolve(items);
  }
}


// ---------- webview html (Home) ----------------------------------------------
function getHomeHtml(): string {
  // tiny UI, simple and clear
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; }
  .row { margin: 10px 0; }
  input[type=text] { width: 260px; padding: 6px; }
  button { padding: 6px 12px; margin-right: 8px; }
  .muted { color:#666; font-size:12px }
  .card { border:1px solid #ddd; border-radius:8px; padding:12px; }
  .grid { display:grid; gap:12px; grid-template-columns: 1fr 1fr; }
</style>
</head>
<body>
  <h2>Collab Session · Home</h2>

  <div class="grid">
    <div class="card">
      <h3>Lecturer</h3>
      <div class="row"><button id="btnCreate">Create session</button></div>
      <div class="row">
        <input type="text" id="question" placeholder="Type question..." />
        <button id="btnSetQ">Set question</button>
      </div>
      <div class="row muted">Create first, then set question. Students will see it instantly.</div>
    </div>

    <div class="card">
      <h3>Student</h3>
      <div class="row"><input id="sid" type="text" placeholder="Session ID (e.g. ABC123)"/></div>
      <div class="row"><input id="nick" type="text" placeholder="Your name"/></div>
      <div class="row"><button id="btnJoin">Join</button></div>
      <div class="row muted">Open your answer file and use the command: “Collab Session: Send My Answer”.</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const q = (id) => document.getElementById(id);

    q('btnCreate').onclick = () => vscode.postMessage({ cmd:'create' });
    q('btnSetQ').onclick   = () => vscode.postMessage({ cmd:'setQuestion', text: q('question').value });
    q('btnJoin').onclick   = () =>
      vscode.postMessage({ cmd:'join', sessionId: q('sid').value, name: q('nick').value });
  </script>
</body>
</html>`;
}

// ---------- extension lifecycle ----------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  // users tree (only visible if contributed in package.json)
  treeDataProvider = new SessionTreeProvider();
  vscode.window.registerTreeDataProvider('collabSessionUsers', treeDataProvider);

  answersProvider = new AnswersTreeProvider();
  vscode.window.registerTreeDataProvider('collabSessionAnswers', answersProvider);

  // register commands
  context.subscriptions.push(
    cmdShowHome,
    cmdCreateSession,
    cmdJoinSession,
    cmdCopySessionId,
    cmdLeaveSession,
    cmdCloseSession,
    cmdSendAnswer,
    cmdOpenStudentAnswer,
    cmdSendFeedback
  );
}

export function deactivate() {
  try { ws?.close(); } catch {}
}

