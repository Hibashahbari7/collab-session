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
type MsgSessionClosed  = { type: 'sessionClosed' };
type MsgError          = { type: 'error'; message?: string };
type MsgAnswerReceived = { type: 'answerReceived'; name: string; code: string; filename?: string };
type MsgFeedback = { type: 'feedback'; from?: string; text?: string };

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
  | MsgFeedback
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
let pendingInitialQuestion: string | undefined; // temp storage for the question typed before creating session

// one stable id per VS Code install (good enough for “one client per machine” guard)
const MACHINE_ID = vscode.env.machineId;

// choose the sync mode (true = send only on Ctrl+S, false = live while typing)
const SYNC_ON_SAVE_ONLY = false;

// prevent double-click create
let isCreating = false;
let isJoining = false; // prevent double-join clicks

// --- Question editor tracking ---
let questionDoc: vscode.TextDocument | undefined;
let questionChangeSub: vscode.Disposable | undefined;
let questionSaveSub: vscode.Disposable | undefined;
let questionDebounce: NodeJS.Timeout | undefined;

// --- student answer tab tracking ---
let myAnswerUri: vscode.Uri | undefined;
let myAnswerEditor: vscode.TextEditor | undefined;

let blockQuestionEditsSub: vscode.Disposable | undefined;
let suppressRevertLoop = false;   // prevents infinite onDidChangeTextDocument loop
let warnedReadOnlyOnce = false;   // show warning once per session


// ---------- status bar button (student only) ----------
let sendAnswerStatus: vscode.StatusBarItem | undefined;

function ensureSendAnswerStatus() {
  if (!sendAnswerStatus) {
    sendAnswerStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    sendAnswerStatus.command = 'collab-session.sendAnswer';
    sendAnswerStatus.text = '$(paper-airplane) Send My Answer';
    sendAnswerStatus.tooltip = 'Send your current answer to the host';
    sendAnswerStatus.show(); // show it immediately when created
  }

  // show or hide based on role/session
  if (myRole === 'student' && sessionId) {
    sendAnswerStatus.show();
  } else {
    sendAnswerStatus.hide();
  }
}

function enableStudentReadOnlyGuard() {
  try { blockQuestionEditsSub?.dispose(); } catch {}
  warnedReadOnlyOnce = false;

  blockQuestionEditsSub = vscode.workspace.onDidChangeTextDocument(async (e) => {
    // only guard when I'm a student and this is the question editor
    if (myRole !== 'student') return;
    if (!questionEditor) return;
    if (e.document.uri.toString() !== questionEditor.document.uri.toString()) return;

    // ignore our own programmatic updates
    if (suppressRevertLoop) return;
    // only react to actual user edits
    if (e.contentChanges.length === 0) return;

    const ed = vscode.window.visibleTextEditors.find(x => x.document === e.document);
    if (!ed) return;

    // Revert the change to keep it read-only
    const desired = `# Session question\n\n${latestQuestionText ?? ''}\n`;
    const full = new vscode.Range(
      e.document.positionAt(0),
      e.document.positionAt(e.document.getText().length)
    );

    suppressRevertLoop = true;
    try {
      await ed.edit(
        b => b.replace(full, desired),
        { undoStopBefore: false, undoStopAfter: false } // no undo spam
      );
    } finally {
      suppressRevertLoop = false;
    }

    if (!warnedReadOnlyOnce) {
      warnedReadOnlyOnce = true;
      void vscode.window.showWarningMessage(
        'This question tab is read-only. Use "Collab Session: Open My Answer" to write your solution.'
      );
    }
  });
}


function answerUriForMe(): vscode.Uri {
  // one untitled buffer per student, nice readable tab title
  return vscode.Uri.parse(`untitled:answer-${nickname ?? 'student'}.md`);
}

async function openOrFocusMyAnswer() {
  const uri = answerUriForMe();
  myAnswerUri = uri;

  // try reuse
  let doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (!doc) {
    const template = `# My answer (${nickname ?? 'student'})\n\n`;
    doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: template });
  }
  myAnswerEditor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

// read current config
function readSyncMode(): boolean {
  return vscode.workspace.getConfiguration('collab').get<boolean>('syncOnSaveOnly', true);
}

// this var changes at runtime when user toggles or updates settings
let syncOnSaveOnly = readSyncMode();

// build question file path
function getQuestionFileUri(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return undefined;
  return vscode.Uri.joinPath(root, '.vscode', 'collab-question.md');
}
async function ensureQuestionDir() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;
  const dir = vscode.Uri.joinPath(root, '.vscode');
  try { await vscode.workspace.fs.createDirectory(dir); } catch {}
}

function extractQuestionFrom(doc: vscode.TextDocument): string {
  return doc.getText().replace(/^#\s*Session question\s*/i, '').trim();
}

// (re)wire listeners according to current sync mode
function wireQuestionSyncListeners() {
  try { questionChangeSub?.dispose(); } catch {}
  try { questionSaveSub?.dispose(); } catch {}

  if (syncOnSaveOnly) {
    // send only on save
    questionSaveSub = vscode.workspace.onDidSaveTextDocument(async (saved) => {
      if (saved !== questionEditor?.document) return;
      if (myRole !== 'host' || !sessionId) return;
      const updated = extractQuestionFrom(saved);
      latestQuestionText = updated;
      await ensureSocket();
      send({ type: 'setQuestion', text: updated });
      console.log('[Host] Sent (on save):', updated);
      void vscode.window.showInformationMessage('Question updated & sent to students (on save).');
    });
  } else {
    // live with debounce
    vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (myRole !== 'student') return;
      if (!questionEditor || e.document !== questionEditor.document) return;

      // revert any edits instantly
      const ed = vscode.window.visibleTextEditors.find(x => x.document === e.document);
      if (!ed) return;
      const desired = `# Session question\n\n${latestQuestionText ?? ''}\n`;
      const full = new vscode.Range(e.document.positionAt(0), e.document.positionAt(e.document.getText().length));
      await ed.edit(b => b.replace(full, desired));
      vscode.window.showWarningMessage('This tab is read-only. Please use the "My answer" tab to write.');
    });
  }
}

function hasActiveHostSession() {
  return myRole === 'host' && typeof sessionId === 'string' && !!sessionId.trim();
}


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


function safeAnswerFilename(doc: vscode.TextDocument, fallbackBase: string): string {
  // If the document is saved, prefer basename of the file
  if (doc.uri.scheme === 'file') {
    const p = doc.fileName.replace(/\\/g, '/');
    return p.split('/').pop() || `${fallbackBase}.txt`;
  }
  // If it's an untitled answer buffer, use a nice title
  // Example: "answer-HIBA.md"
  return `${fallbackBase}.md`;
}

// -----------------------------------------------------------------------------
// 🧠 Dynamic Host Input
// Ask once for the host IPv4 and save it in settings.
// -----------------------------------------------------------------------------
let HOST: string | undefined;

// -----------------------------------------------------------------------------
// 🧠 Dynamic Host Input
// This function gets the Host IPv4 (server address) from VS Code settings.
// If it's not saved yet, it asks the user once and saves it globally.
// -----------------------------------------------------------------------------
async function getHostIP(): Promise<string> {
  // ✅ Try to read the saved host IP from settings (e.g. collab.hostIP)
  const saved = vscode.workspace.getConfiguration().get<string>('collab.hostIP');
  if (saved) return saved; // If exists → use it

  // 🧾 Ask the user to input the host IP the first time
  const input = await vscode.window.showInputBox({
    prompt: 'Enter host IPv4 (e.g. 192.168.1.187)',
    placeHolder: '192.168.x.x',
    value: 'localhost'
  });

  // 🚫 Stop if no input was provided
  if (!input) throw new Error('Host IP not provided');

  // 💾 Save the IP to VS Code settings (so next time it will be remembered)
  await vscode.workspace.getConfiguration()
    .update('collab.hostIP', input, vscode.ConfigurationTarget.Global);

  return input;
}


async function openMyAnswerTab() {
  const name = nickname ?? 'student';
  const uri = vscode.Uri.parse(`untitled:answer-${name}.md`);
  myAnswerUri = uri;

  // Try to reuse if already open
  let doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (!doc) {
    const template = `# My answer (${name})\n\n`;
    doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: template
    });
  }

  // Show it beside the question
  myAnswerEditor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}

// -----------------------------------------------------------------------------
// 🌐 Build a proper WebSocket endpoint from user-provided "host".
// - If the user enters a full URL that starts with ws:// or wss:// → use it as-is
// - If the user enters a domain name (e.g. ngrok host) → use secure WSS without port
// - If the user enters a local IPv4 (e.g. 192.168.x.x) → use WS with :port
// Why? ngrok/public internet requires TLS (wss) and no :3000 on the public URL,
// while LAN connections typically use ws://<ip>:<port>.
// -----------------------------------------------------------------------------
function buildWsEndpoint(host: string, port: number): string {
  // 1) Full URL already provided by the user? (e.g. "wss://xyz.ngrok.app")
  if (/^wss?:\/\//i.test(host)) {
    return host; // Use exactly what the user typed
  }

  // 2) Looks like a domain (has letters). Treat as public internet host → WSS (TLS) and no explicit port.
  //    Examples: "abcd1234.ngrok-free.app", "my-school.example.com"
  if (/[a-zA-Z]/.test(host)) {
    return `wss://${host}`; // Secure WebSocket for internet
  }

  // 3) Otherwise assume it's a local IPv4 → plain WS with explicit port.
  //    Example: "192.168.1.50" → "ws://192.168.1.50:3000"
  return `ws://${host}:${port}`;
}

// ---------- socket lifecycle --------------------------------------------------
async function ensureSocket(): Promise<WebSocket> {
  // Reuse the existing socket if it's already open
  if (ws && ws.readyState === WebSocket.OPEN) return ws;

  // The default port for our local WS server (when using LAN)
  const PORT = Number(process.env.COLLAB_PORT || 3000);

  // Ask/read the host the user configured via "Collab Session: Set Host IP"
  // This may be:
  //   - local IPv4 like "192.168.1.187"
  //   - an ngrok domain like "e07913d4ffbf.ngrok-free.app"
  //   - or even a full URL like "wss://e07913d4ffbf.ngrok-free.app"
  const host = await getHostIP();

  // Build the final endpoint correctly based on the input above
  const endpoint = buildWsEndpoint(host, PORT);

  // Create the WebSocket to the resolved endpoint
  ws = new WebSocket(endpoint);

  // Helpful log for debugging which endpoint was actually used
  ws.once('open', () => console.log(`connected to ${endpoint}`));

// --- handle all server messages (host & student) -----------------------------
ws.on('message', async (raw: WebSocket.RawData) => {
  let msg: ServerMessage;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  const s = (x: unknown) => (typeof x === 'string' ? x : undefined);
  const asUsers = (x: unknown) =>
    Array.isArray(x) && x.every(o => typeof (o as any)?.name === 'string')
      ? (x as Array<{ name: string }>) : undefined;

  switch (msg.type) {
    // session was created (host)
    case 'created': {
      const sid = asString((msg as MsgCreated).sessionId);
      if (!sid) return;
      sessionId = sid;
      await vscode.env.clipboard.writeText(sid);
      vscode.window.showInformationMessage(`🟢 Session "${sid}" created & copied to clipboard.`);
      if (!usersBySession.has(sid)) usersBySession.set(sid, new Set());
      treeDataProvider?.refresh();

      // open the question editor immediately (even if empty)
      await showOrUpdateQuestionEditor(latestQuestionText ?? '');

      // if the user clicked "Set question" before creating, push that text now
      if (pendingInitialQuestion && pendingInitialQuestion.length > 0) {
        latestQuestionText = pendingInitialQuestion;
        await showOrUpdateQuestionEditor(pendingInitialQuestion); // reflect locally
        await ensureSocket();
        send({ type: 'setQuestion', text: pendingInitialQuestion }); // broadcast + DB
      }
      pendingInitialQuestion = undefined; // clear temp
      break;
    }

    // you joined (student)
    case 'joined': {
      const m = msg as MsgJoined;
      const sid  = asString(m.sessionId);
      const name = asString(m.name);
      if (!sid || !name) return;

      sessionId = sid;
      nickname  = name;

      const set = usersBySession.get(sid) ?? new Set<string>();
      set.add(name);
      usersBySession.set(sid, set);
      treeDataProvider?.refresh();

      vscode.window.showInformationMessage(`✅ Joined ${sid} as ${name}`);

      // Open question tab immediately (use server question if provided)
      latestQuestionText = typeof m.question === 'string' ? m.question : (latestQuestionText ?? '');
      await showOrUpdateQuestionEditor(latestQuestionText);
      // keep the question tab read-only for students + open "My answer" tab
      if (myRole === 'student') {
        enableStudentReadOnlyGuard();
        await openMyAnswerTab();
      }
      break;
    }


    // full users list
    case 'users': {
      const sid  = s((msg as any).sessionId);
      const list = asUsers((msg as any).users);
      if (!sid || !list) return;
      usersBySession.set(sid, new Set(list.map(u => u.name)));
      treeDataProvider?.refresh();
      break;
    }

    // someone joined
    case 'userJoined': {
      const m = msg as MsgUserJoined;
      if (m.sessionId === sessionId && m.name !== nickname) {
        vscode.window.showInformationMessage(`👋 ${m.name} joined`);
      }
      break;
    }

    // someone left
    case 'userLeft': {
      const m = msg as MsgUserLeft;
      if (m.sessionId === sessionId) {
        const set = usersBySession.get(m.sessionId) ?? new Set<string>();
        set.delete(m.name);
        usersBySession.set(m.sessionId, set);

        latestAnswers.delete(m.name);
        answersProvider?.refresh();
        treeDataProvider?.refresh();

        vscode.window.showInformationMessage(`👋 ${m.name} left`);
      }
      break;
    }

    // question changed
    case 'question': {
      const m = msg as MsgQuestion;
      const incoming = asString(m.text) ?? '';

      if (myRole === 'host' && questionEditor && !questionEditor.document.isClosed) {
        latestQuestionText = incoming;
        break;
      }

      latestQuestionText = incoming;
      await showOrUpdateQuestionEditor(incoming);
      // ensure guard is active for students
      if (myRole === 'student') enableStudentReadOnlyGuard();      
      break;
    }


    // host closed session
    case 'sessionClosed': {
      sessionId = undefined;
      nickname = undefined;
      usersBySession.clear();
      treeDataProvider?.refresh();
      vscode.window.showWarningMessage('🔴 Session closed by host');
      if (sendAnswerStatus) sendAnswerStatus.hide();
      goHome();
      try { blockQuestionEditsSub?.dispose(); } catch {}
      break;
    }

    // server error
    case 'error': {
      const text = s((msg as MsgError).message) ?? 'Server error';
      vscode.window.showErrorMessage(`❌ ${text}`);
      break;
    }

    // host received an answer (host only)
    case 'answerReceived': {
      const m = msg as MsgAnswerReceived;
      const name = asString(m.name);
      const code = asString(m.code);
      const filename = asString(m.filename) ?? `Answer_from_${name ?? 'student'}.txt`;

      if (myRole === 'host' && name && typeof code === 'string') {
        latestAnswers.set(name, code);
        answersProvider?.refresh();

        const choice = await vscode.window.showInformationMessage(
          `📥 Answer from ${name} • ${filename}`, 'Open'
        );
        if (choice === 'Open') {
          // Open a tab titled with the filename (untitled so we don't touch disk)
          const uri = vscode.Uri.parse(`untitled:${filename}`);
          const doc = await vscode.workspace.openTextDocument({
            language: guessLanguage(code) ?? 'plaintext',
            content: code
          });
          await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        }
      }
      break;
    }


    // student got feedback from host
    case 'feedback': {
      const m = msg as MsgFeedback;
      const text = m.text ?? '';
      const doc = await vscode.workspace.openTextDocument({
        content: `# Feedback from host\n\n${text}\n`,
        language: 'markdown'
      });
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      break;
    }

    default:
      // ignore unknown / forward-compatible
      break;
  }
});


  // Wait for initial open/error once before returning
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
    {
      enableScripts: true,
      retainContextWhenHidden: true // keep my inputs/state when I switch tabs
    }
  );

  panel.webview.html = getHomeHtml();
  panel.webview.onDidReceiveMessage(async (m) => {
    try {
      // -------------------- Create (Host) --------------------
      if (m?.cmd === 'create') {
        // prevent creating another session if one is already active
        if (hasActiveHostSession()) {
          void vscode.window.showWarningMessage(
            `A session is already active (ID: ${sessionId}). Close it first (Collab Session: Close Session).`
          );
          return;
        }
        if (isCreating) return; // avoid double-click spam
        isCreating = true;

        myRole = 'host';
        await ensureSocket();
        const sid = randomId();

        // store the initial question text typed in the Home view (if any)
        pendingInitialQuestion = typeof m.initialQuestion === 'string' ? m.initialQuestion.trim() : '';

        // send create request to server
        send({ type: 'create', sessionId: sid, machineId: MACHINE_ID });

        // small debounce window to prevent double create
        setTimeout(() => (isCreating = false), 500);
      }


      // -------------------- Join (Student) --------------------
      else if (m?.cmd === 'join') {
        // already joining? ignore second click
        if (isJoining) return;
        isJoining = true;

        // if already in a student session, require leaving first
        if (sessionId && myRole === 'student') {
          isJoining = false;
          void vscode.window.showWarningMessage(
            `Already in session ${sessionId}. Leave it first before joining another.`
          );
          return;
        }

        myRole = 'student';
        const sid  = String(m.sessionId || '').toUpperCase().trim();
        const name = String(m.name || '').trim();
        if (!sid || !name) {
          isJoining = false;
          void vscode.window.showWarningMessage('Session ID and Name are required');
          return;
        }

        await ensureSocket();
        send({ type: 'join', sessionId: sid, name, machineId: MACHINE_ID });

        // light debounce so double-clicks don’t send twice
        setTimeout(() => { isJoining = false; }, 800);
      }

      // -------------------- Set Question (Host) --------------------
      else if (m?.cmd === 'setQuestion') {
        // normalize the text coming from Home input
        const text = String(m.text ?? '').trim();
        if (!text) {
          void vscode.window.showWarningMessage('Type a question first.');
          return;
        }

        // ------------------------------------------------------------
        // Case A: no active host session → auto-create, then apply question
        // ------------------------------------------------------------
        if (!hasActiveHostSession()) {
          // avoid double-click race
          if (isCreating) return;
          isCreating = true;

          // become host and connect
          myRole = 'host';
          await ensureSocket();

          // stash the text so the 'created' handler will push it to the editor + server
          pendingInitialQuestion = text;

          // create a brand new session; 'case created' will open the editor and send pendingInitialQuestion
          const sid = randomId();
          send({ type: 'create', sessionId: sid, machineId: MACHINE_ID });

          // small debounce window
          setTimeout(() => (isCreating = false), 500);
          return; // we're done; the created handler will finish the flow
        }

        // ------------------------------------------------------------
        // Case B: already hosting an active session → update immediately
        // ------------------------------------------------------------
        latestQuestionText = text;                      // cache locally
        await showOrUpdateQuestionEditor(text);         // update/open the question editor right away
        await ensureSocket();
        send({ type: 'setQuestion', text });            // broadcast to students + store in DB
      }


    } catch (e) {
      // reset guards on error
      isJoining = false;
      isCreating = false;
      void vscode.window.showErrorMessage(`Failed: ${String(e)}`);
    }
  });

});

// Collab Session: Create Session (host)
const cmdCreateSession = vscode.commands.registerCommand('collab-session.createSession', async () => {
  if (hasActiveHostSession()) {
    void vscode.window.showWarningMessage(
      `A session is already active (ID: ${sessionId}). Close it first (Collab Session: Close Session).`
    );
    return;
  }
  if (isCreating) return;
  isCreating = true;

  myRole = 'host';
  await ensureSocket();
  send({ type: 'create', sessionId: randomId() });

  setTimeout(() => (isCreating = false), 500);
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

const cmdOpenMyAnswer = vscode.commands.registerCommand(
  'collab-session.openMyAnswer',
  openOrFocusMyAnswer
);


// Collab Session: Leave Session (student)
const cmdLeaveSession = vscode.commands.registerCommand('collab-session.leaveSession', async () => {
  if (!sessionId || !nickname || myRole !== 'student') {
    void vscode.window.showWarningMessage('You are not in a student session.');
    return;
  }
  try { blockQuestionEditsSub?.dispose(); } catch {}
  await ensureSocket();
  send({ type: 'leave' }); // server reads sid/name from socketMeta
  sessionId = undefined;
  nickname = undefined;
  usersBySession.clear();
  treeDataProvider?.refresh();
  void vscode.window.showInformationMessage('You left the session.');
  if (sendAnswerStatus) sendAnswerStatus.hide();
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
  myRole = undefined;
});

// Send the student's answer to the host (with filename)
const cmdSendAnswer = vscode.commands.registerCommand('collab-session.sendAnswer', async () => {
  if (!sessionId || !nickname || myRole !== 'student') {
    void vscode.window.showWarningMessage('Join a session as student first.');
    return;
  }

  // Prefer the dedicated "My answer" tab if we opened it
  let doc: vscode.TextDocument | undefined;
  if (myAnswerUri) {
    doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === myAnswerUri!.toString());
  }
  // Fallback: the active editor
  if (!doc) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      await openMyAnswerTab();
      void vscode.window.showInformationMessage('Opened "My answer" tab. Write your solution there and send again.');
      return;
    }
    doc = ed.document;
  }

  const code = doc.getText();
  const filename = safeAnswerFilename(doc, `answer-${nickname ?? 'student'}`);

  if (!code.trim()) {
    void vscode.window.showWarningMessage('Answer is empty.');
    return;
  }

  await ensureSocket();
  send({ type: 'answer', sessionId, name: nickname, code, filename }); // 👈 include filename
  void vscode.window.showInformationMessage(`✅ Answer sent to host (${filename}).`);
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

function getQuestionTargetUri(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    return vscode.Uri.joinPath(root, '.vscode', 'collab-question.md'); // real file
  }
  return vscode.Uri.parse('untitled:collab-question.md'); // single untitled tab
}

async function ensureQuestionFileExists(target: vscode.Uri, initial: string) {
  if (target.scheme === 'untitled') return; // nothing to create on disk
  // ensure .vscode folder
  try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..')); } catch {}
  // create file once if missing
  try { await vscode.workspace.fs.stat(target); }
  catch { await vscode.workspace.fs.writeFile(target, Buffer.from(initial, 'utf8')); }
}



async function showOrUpdateQuestionEditor(text: string) {
  try {
    const target = getQuestionTargetUri();
    const desired = `# Session question\n\n${text}\n`;

    // Try to reuse an already-open doc with the same URI
    let doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString());

    if (!doc) {
      // Ensure file exists (workspace) or just open the untitled doc (no workspace)
      await ensureQuestionFileExists(target, desired);
      doc = await vscode.workspace.openTextDocument(target);
    }

    // Show the doc (this focuses existing tab instead of opening a new one)
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    questionEditor = editor;

    // Replace content only if different (prevents extra edits/loops)
    if (doc.getText() !== desired) {
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      await editor.edit(ed => ed.replace(full, desired));
      if (doc.uri.scheme !== 'untitled') { try { await doc.save(); } catch {} }
    }

    // (Re)wire listeners according to your current mode
    wireQuestionSyncListeners(); // uses questionEditor internally

  } catch (err) {
    console.error('Error updating question editor', err);
  }
}


// Collab Session: Show Question (host or student)
const cmdShowQuestion = vscode.commands.registerCommand('collab-session.showQuestion', async () => {
  if (!sessionId) {
    void vscode.window.showWarningMessage('No active session. Create or join a session first.');
    return;
  }
  await showOrUpdateQuestionEditor(latestQuestionText ?? '');
});

// ---------- Connected Users tree -----------------------------------
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

    // when lecturer clicks "Create session" → also send any question typed in the input
    q('btnCreate').onclick = () => {
      const initialQ = q('question').value || '';
      vscode.postMessage({ cmd:'create', initialQuestion: initialQ });
    };

    // when lecturer manually clicks "Set question"
    q('btnSetQ').onclick = () => {
      vscode.postMessage({ cmd:'setQuestion', text: q('question').value });
    };

    // when student clicks "Join"
    q('btnJoin').onclick = () => {
      vscode.postMessage({ cmd:'join', sessionId: q('sid').value, name: q('nick').value });
    };
  </script>

</body>
</html>`;
}

// ---------- extension lifecycle ----------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  // --- register tree views (only show if contributed in package.json)
  treeDataProvider = new SessionTreeProvider();
  vscode.window.registerTreeDataProvider('collabSessionUsers', treeDataProvider);

  answersProvider = new AnswersTreeProvider();
  vscode.window.registerTreeDataProvider('collabSessionAnswers', answersProvider);

  // --- core commands
  context.subscriptions.push(
    cmdShowHome,
    cmdCreateSession,
    cmdJoinSession,
    cmdCopySessionId,
    cmdLeaveSession,
    cmdCloseSession,
    cmdSendAnswer,
    cmdOpenStudentAnswer,
    cmdSendFeedback,
    cmdShowQuestion,
    cmdOpenMyAnswer
  );

  // ---------------------------------------------------------------------------
  // ⚙️ Set Host IP (manual override stored in settings)
  // ---------------------------------------------------------------------------
  const cmdSetHostIP = vscode.commands.registerCommand('collab-session.setHostIP', async () => {
    // read current value (default to localhost)
    const current = vscode.workspace.getConfiguration().get<string>('collab.hostIP') || 'localhost';

    // ask user for a new value
    const input = await vscode.window.showInputBox({
      prompt: 'Enter new Host IPv4 or ws(s) URL (e.g. 192.168.1.187 or wss://xxxx.ngrok-free.app)',
      value: current
    });

    // cancelled → do nothing
    if (!input) return;

    // persist globally
    await vscode.workspace.getConfiguration().update('collab.hostIP', input, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`✅ Host IP updated to: ${input}`);
  });
  context.subscriptions.push(cmdSetHostIP);

  // ---------------------------------------------------------------------------
  // 🔁 Toggle Question Sync Mode (Live vs On Save)
  // - Updates the setting collab.syncOnSaveOnly
  // - Re-wires listeners on the open question editor (if any)
  // ---------------------------------------------------------------------------
  const cmdToggleSync = vscode.commands.registerCommand('collab-session.toggleQuestionSyncMode', async () => {
    // flip in-memory flag and persist to settings
    syncOnSaveOnly = !syncOnSaveOnly;
    await vscode.workspace.getConfiguration('collab').update('syncOnSaveOnly', syncOnSaveOnly, vscode.ConfigurationTarget.Global);

    // if question editor is open, re-wire listeners immediately
    if (questionEditor && !questionEditor.document.isClosed) {
      wireQuestionSyncListeners();
    }

    vscode.window.showInformationMessage(
      `Question sync mode: ${syncOnSaveOnly ? 'On Save (Ctrl+S)' : 'Live (debounced)'}`
    );
  });
  context.subscriptions.push(cmdToggleSync);

  // ---------------------------------------------------------------------------
  // 🔧 React when user changes the setting from UI (Settings)
  // ---------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('collab.syncOnSaveOnly')) {
        // refresh runtime flag from settings
        syncOnSaveOnly = readSyncMode();
        // rewire listeners if the question editor is open
        if (questionEditor && !questionEditor.document.isClosed) {
          wireQuestionSyncListeners();
        }
        vscode.window.showInformationMessage(
          `Question sync mode updated: ${syncOnSaveOnly ? 'On Save' : 'Live'}`
        );
      }
    })
  );

  // ---------------------------------------------------------------------------
  // 🚀 Auto-open Home on activation (nice first-run experience)
  // ---------------------------------------------------------------------------
  void vscode.commands.executeCommand('collab-session.showHome');
  console.log('Collab Session activated → Home opened automatically.');
}

export function deactivate() {
  try { blockQuestionEditsSub?.dispose(); } catch {}
  try { ws?.close(); } catch {}
}



