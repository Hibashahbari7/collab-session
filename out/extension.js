"use strict";
// src/extension.ts
// -----------------------------------------------------------------------------
// Collab Session - VS Code client
// - Host creates session
// - Students join
// - Host sets question (from Home); students send answer manually
// - Users list updates; notifications for join/leave/close
// - Works with server.js you have
// -----------------------------------------------------------------------------
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const ws_1 = __importDefault(require("ws"));
// ---------- globals -----------------------------------------------------------
let ws; // single socket
let sessionId; // current session id
let nickname; // my name
let myRole; // chosen role (Home or commands)
const usersBySession = new Map(); // sid -> users
let treeDataProvider; // users view (if contributed)
let questionEditor; // one shared question tab
let latestQuestionText; // cached question
// keep latest answers per student (host only)
const latestAnswers = new Map();
let answersProvider; // tree view for answers
// one stable id per VS Code install (good enough for “one client per machine” guard)
const MACHINE_ID = vscode.env.machineId;
// choose the sync mode (true = send only on Ctrl+S, false = live while typing)
const SYNC_ON_SAVE_ONLY = true;
// prevent double-click create
let isCreating = false;
// --- Question editor tracking ---
let questionDoc;
let questionChangeSub;
let questionSaveSub;
let questionDebounce;
// read current config
function readSyncMode() {
    return vscode.workspace.getConfiguration('collab').get('syncOnSaveOnly', true);
}
// this var changes at runtime when user toggles or updates settings
let syncOnSaveOnly = readSyncMode();
// build question file path so Ctrl+S لا يفتح Save As
function getQuestionFileUri() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root)
        return undefined;
    return vscode.Uri.joinPath(root, '.vscode', 'collab-question.md');
}
async function ensureQuestionDir() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root)
        return;
    const dir = vscode.Uri.joinPath(root, '.vscode');
    try {
        await vscode.workspace.fs.createDirectory(dir);
    }
    catch { }
}
function extractQuestionFrom(doc) {
    return doc.getText().replace(/^#\s*Session question\s*/i, '').trim();
}
// (re)wire listeners according to current sync mode
function wireQuestionSyncListeners() {
    try {
        questionChangeSub?.dispose();
    }
    catch { }
    try {
        questionSaveSub?.dispose();
    }
    catch { }
    if (syncOnSaveOnly) {
        // send only on save
        questionSaveSub = vscode.workspace.onDidSaveTextDocument(async (saved) => {
            if (saved !== questionEditor?.document)
                return;
            if (myRole !== 'host' || !sessionId)
                return;
            const updated = extractQuestionFrom(saved);
            latestQuestionText = updated;
            await ensureSocket();
            send({ type: 'setQuestion', text: updated });
            console.log('[Host] Sent (on save):', updated);
            void vscode.window.showInformationMessage('Question updated & sent to students (on save).');
        });
    }
    else {
        // live with debounce
        questionChangeSub = vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.document !== questionEditor?.document)
                return;
            if (myRole !== 'host' || !sessionId)
                return;
            if (questionDebounce)
                clearTimeout(questionDebounce);
            questionDebounce = setTimeout(async () => {
                const updated = extractQuestionFrom(e.document);
                latestQuestionText = updated;
                await ensureSocket();
                send({ type: 'setQuestion', text: updated });
                console.log('[Host] Sent (live, debounced):', updated);
            }, 500);
        });
    }
}
function hasActiveHostSession() {
    return myRole === 'host' && typeof sessionId === 'string' && !!sessionId.trim();
}
// ---------- tiny helpers ------------------------------------------------------
const asString = (x) => (typeof x === 'string' ? x : undefined);
const asUserList = (x) => Array.isArray(x) && x.every(o => typeof o?.name === 'string')
    ? x
    : undefined;
function send(payload) {
    // JSON send with guard
    if (!ws || ws.readyState !== ws_1.default.OPEN)
        return;
    try {
        ws.send(JSON.stringify(payload));
    }
    catch { }
}
function randomId() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function guessLanguage(code) {
    // tiny heuristic only
    if (/^\s*#include\s+<.+?>/m.test(code))
        return 'cpp';
    if (/^\s*def\s+\w+\(/m.test(code))
        return 'python';
    if (/^\s*(import|export)\s+/m.test(code))
        return 'typescript';
    return undefined;
}
// keep one tab per student answer
const answerUris = new Map();
function answerUriFor(student) {
    let uri = answerUris.get(student);
    if (!uri) {
        // untitled uri with a nice name -> tab caption looks like "answer: hiba.txt"
        uri = vscode.Uri.parse(`untitled:answer-${student}.txt`);
        answerUris.set(student, uri);
    }
    return uri;
}
async function openOrUpdateAnswerTab(student, code) {
    const uri = answerUriFor(student);
    let doc;
    // try find already-open doc by URI
    doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (!doc) {
        // open new untitled doc with initial content
        doc = await vscode.workspace.openTextDocument({ language: guessLanguage(code) ?? 'plaintext', content: code });
    }
    else {
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
        .then(undefined, () => { });
}
// -----------------------------------------------------------------------------
// 🧠 Dynamic Host Input
// Ask once for the host IPv4 and save it in settings.
// -----------------------------------------------------------------------------
let HOST;
// -----------------------------------------------------------------------------
// 🧠 Dynamic Host Input
// This function gets the Host IPv4 (server address) from VS Code settings.
// If it's not saved yet, it asks the user once and saves it globally.
// -----------------------------------------------------------------------------
async function getHostIP() {
    // ✅ Try to read the saved host IP from settings (e.g. collab.hostIP)
    const saved = vscode.workspace.getConfiguration().get('collab.hostIP');
    if (saved)
        return saved; // If exists → use it
    // 🧾 Ask the user to input the host IP the first time
    const input = await vscode.window.showInputBox({
        prompt: 'Enter host IPv4 (e.g. 192.168.1.187)',
        placeHolder: '192.168.x.x',
        value: 'localhost'
    });
    // 🚫 Stop if no input was provided
    if (!input)
        throw new Error('Host IP not provided');
    // 💾 Save the IP to VS Code settings (so next time it will be remembered)
    await vscode.workspace.getConfiguration()
        .update('collab.hostIP', input, vscode.ConfigurationTarget.Global);
    return input;
}
// -----------------------------------------------------------------------------
// 🌐 Build a proper WebSocket endpoint from user-provided "host".
// - If the user enters a full URL that starts with ws:// or wss:// → use it as-is
// - If the user enters a domain name (e.g. ngrok host) → use secure WSS without port
// - If the user enters a local IPv4 (e.g. 192.168.x.x) → use WS with :port
// Why? ngrok/public internet requires TLS (wss) and no :3000 on the public URL,
// while LAN connections typically use ws://<ip>:<port>.
// -----------------------------------------------------------------------------
function buildWsEndpoint(host, port) {
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
async function ensureSocket() {
    // Reuse the existing socket if it's already open
    if (ws && ws.readyState === ws_1.default.OPEN)
        return ws;
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
    ws = new ws_1.default(endpoint);
    // Helpful log for debugging which endpoint was actually used
    ws.once('open', () => console.log(`connected to ${endpoint}`));
    // --- handle all server messages (host & student) -----------------------------
    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        const s = (x) => (typeof x === 'string' ? x : undefined);
        const asUsers = (x) => Array.isArray(x) && x.every(o => typeof o?.name === 'string')
            ? x : undefined;
        switch (msg.type) {
            // session was created (host)
            case 'created': {
                const sid = s(msg.sessionId);
                if (!sid)
                    return;
                sessionId = sid;
                await vscode.env.clipboard.writeText(sid);
                vscode.window.showInformationMessage(`🟢 Session "${sid}" created & copied to clipboard.`);
                if (!usersBySession.has(sid))
                    usersBySession.set(sid, new Set());
                treeDataProvider?.refresh();
                latestQuestionText = latestQuestionText ?? '';
                await showOrUpdateQuestionEditor(latestQuestionText);
                break;
            }
            // you joined (student)
            case 'joined': {
                const m = msg;
                const sid = s(m.sessionId);
                const name = s(m.name);
                if (!sid || !name)
                    return;
                sessionId = sid;
                nickname = name;
                const set = usersBySession.get(sid) ?? new Set();
                set.add(name);
                usersBySession.set(sid, set);
                treeDataProvider?.refresh();
                vscode.window.showInformationMessage(`✅ Joined ${sid} as ${name}`);
                if (typeof m.question === 'string') {
                    latestQuestionText = m.question;
                    await showOrUpdateQuestionEditor(latestQuestionText);
                }
                break;
            }
            // full users list
            case 'users': {
                const sid = s(msg.sessionId);
                const list = asUsers(msg.users);
                if (!sid || !list)
                    return;
                usersBySession.set(sid, new Set(list.map(u => u.name)));
                treeDataProvider?.refresh();
                break;
            }
            // someone joined
            case 'userJoined': {
                const m = msg;
                if (m.sessionId === sessionId && m.name !== nickname) {
                    vscode.window.showInformationMessage(`👋 ${m.name} joined`);
                }
                break;
            }
            // someone left
            case 'userLeft': {
                const m = msg;
                if (m.sessionId === sessionId) {
                    const set = usersBySession.get(m.sessionId) ?? new Set();
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
                const m = msg;
                latestQuestionText = s(m.text) ?? '';
                await showOrUpdateQuestionEditor(latestQuestionText);
                break;
            }
            // host closed session
            case 'sessionClosed': {
                sessionId = undefined;
                nickname = undefined;
                usersBySession.clear();
                treeDataProvider?.refresh();
                vscode.window.showWarningMessage('🔴 Session closed by host');
                goHome();
                break;
            }
            // server error
            case 'error': {
                const text = s(msg.message) ?? 'Server error';
                vscode.window.showErrorMessage(`❌ ${text}`);
                break;
            }
            // host received an answer (host only)
            case 'answerReceived': {
                const m = msg;
                const name = s(m.name);
                const code = s(m.code);
                if (myRole === 'host' && name && typeof code === 'string') {
                    latestAnswers.set(name, code);
                    answersProvider?.refresh();
                    const choice = await vscode.window.showInformationMessage(`📥 Answer from ${name}`, 'Open');
                    if (choice === 'Open') {
                        vscode.commands.executeCommand('collab-session.openStudentAnswer', name);
                    }
                }
                break;
            }
            // student got feedback from host
            case 'feedback': {
                const m = msg;
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
    await new Promise((resolve, reject) => {
        const onOpen = () => { cleanup(); resolve(); };
        const onErr = (e) => { cleanup(); reject(e); };
        const cleanup = () => {
            ws?.off('open', onOpen);
            ws?.off('error', onErr);
        };
        ws?.once('open', onOpen);
        ws?.once('error', onErr);
    });
    return ws;
}
// ---------- commands ----------------------------------------------------------
const cmdOpenStudentAnswer = vscode.commands.registerCommand('collab-session.openStudentAnswer', async (arg) => {
    let student = typeof arg === 'string' ? arg :
        typeof arg?.student === 'string' ? arg.student : undefined;
    if (!student) {
        const names = [...latestAnswers.keys()];
        if (names.length === 0) {
            void vscode.window.showInformationMessage('No answers yet.');
            return;
        }
        student = await vscode.window.showQuickPick(names, { placeHolder: 'Select a student' });
    }
    if (!student)
        return;
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
        await vscode.workspace.fs.rename(doc.uri, doc.uri.with({ path: `/Answer_from_${student}.txt` }), { overwrite: true });
    }
    catch { /* ignore */ }
});
// Collab Session: Show Home (webview UI)
const cmdShowHome = vscode.commands.registerCommand('collab-session.showHome', async () => {
    const panel = vscode.window.createWebviewPanel('collabHome', 'Collab Session – Home', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true // keep my inputs/state when I switch tabs
    });
    panel.webview.html = getHomeHtml();
    panel.webview.onDidReceiveMessage(async (m) => {
        try {
            if (m?.cmd === 'create') {
                // don't allow creating while a host session is already active
                if (hasActiveHostSession()) {
                    void vscode.window.showWarningMessage(`A session is already active (ID: ${sessionId}). Close it first (Collab Session: Close Session).`);
                    return;
                }
                if (isCreating)
                    return; // debounce double click
                isCreating = true;
                myRole = 'host';
                await ensureSocket();
                const sid = randomId();
                send({ type: 'create', sessionId: sid, machineId: MACHINE_ID });
                // small debounce window
                setTimeout(() => (isCreating = false), 500);
            }
            else if (m?.cmd === 'join') {
                myRole = 'student';
                const sid = String(m.sessionId || '').toUpperCase().trim();
                const name = String(m.name || '').trim();
                if (!sid || !name) {
                    void vscode.window.showWarningMessage('Session ID and Name are required');
                    return;
                }
                await ensureSocket();
                send({ type: 'join', sessionId: sid, name, machineId: MACHINE_ID });
            }
            else if (m?.cmd === 'setQuestion') {
                // only host with an active session may set question
                if (!hasActiveHostSession()) {
                    void vscode.window.showWarningMessage('Only host with an active session can set question.');
                    return;
                }
                await ensureSocket();
                const text = String(m.text || '');
                latestQuestionText = text;
                send({ type: 'setQuestion', text });
                // open/update the question editor immediately (don't wait for server echo)
                await showOrUpdateQuestionEditor(text);
            }
        }
        catch (e) {
            void vscode.window.showErrorMessage(`Failed: ${String(e)}`);
        }
    });
});
// Collab Session: Create Session (host)
const cmdCreateSession = vscode.commands.registerCommand('collab-session.createSession', async () => {
    if (hasActiveHostSession()) {
        void vscode.window.showWarningMessage(`A session is already active (ID: ${sessionId}). Close it first (Collab Session: Close Session).`);
        return;
    }
    if (isCreating)
        return;
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
    if (!inputId)
        return;
    const name = await vscode.window.showInputBox({
        prompt: 'Enter your name / nickname',
        placeHolder: 'student123',
        validateInput: v => v.trim() ? undefined : 'Name is required'
    });
    if (!name)
        return;
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
    myRole = undefined;
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
const cmdSendFeedback = vscode.commands.registerCommand('collab-session.sendFeedback', async () => {
    if (myRole !== 'host' || !sessionId) {
        void vscode.window.showWarningMessage('Only host can send feedback during an active session.');
        return;
    }
    // prefer students that already sent answers, fallback to all connected users
    const answered = [...latestAnswers.keys()];
    const connected = usersBySession.get(sessionId) ? [...usersBySession.get(sessionId)] : [];
    const candidates = answered.length ? answered : connected;
    if (!candidates.length) {
        void vscode.window.showInformationMessage('No students available to send feedback to.');
        return;
    }
    const to = await vscode.window.showQuickPick(candidates, { placeHolder: 'Select a student' });
    if (!to)
        return;
    const text = await vscode.window.showInputBox({
        prompt: `Write feedback for ${to}`,
        placeHolder: 'Your feedback...',
        validateInput: v => v.trim() ? undefined : 'Feedback cannot be empty'
    });
    if (!text)
        return;
    await ensureSocket();
    send({ type: 'feedback', sessionId, to, text });
    void vscode.window.showInformationMessage(`Feedback sent to ${to}.`);
});
async function showOrUpdateQuestionEditor(text) {
    try {
        // open/create real file so Ctrl+S works without “Save As”
        const target = getQuestionFileUri();
        let doc;
        if (target) {
            await ensureQuestionDir();
            const initial = `# Session question\n\n${text}\n`;
            try {
                await vscode.workspace.fs.stat(target);
            }
            catch {
                await vscode.workspace.fs.writeFile(target, Buffer.from(initial, 'utf8'));
            }
            doc = await vscode.workspace.openTextDocument(target);
        }
        else {
            // fallback if no workspace
            doc = await vscode.workspace.openTextDocument({ content: `# Session question\n\n${text}\n`, language: 'markdown' });
        }
        // show + adjust content if changed
        const shown = await vscode.window.showTextDocument(doc, { preview: false });
        questionEditor = shown;
        questionDoc = doc;
        const desired = `# Session question\n\n${text}\n`;
        if (doc.getText() !== desired) {
            const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            await shown.edit(ed => ed.replace(full, desired));
            // silent save for real files
            if (doc.uri.scheme !== 'untitled') {
                try {
                    await doc.save();
                }
                catch { }
            }
        }
        // (re)wire sync listeners based on current mode
        wireQuestionSyncListeners();
    }
    catch (err) {
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
class SessionTreeProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh() { this._onDidChangeTreeData.fire(undefined); }
    getTreeItem(element) { return element; }
    getChildren() {
        if (!sessionId)
            return Promise.resolve([]);
        const set = usersBySession.get(sessionId);
        const users = set ? Array.from(set) : [];
        // pass hasAnswer so we can color + enable click
        return Promise.resolve(users.map(u => new UserItem(u, latestAnswers.has(u))));
    }
}
class UserItem extends vscode.TreeItem {
    student;
    constructor(student, hasAnswer) {
        super(student, vscode.TreeItemCollapsibleState.None);
        this.student = student;
        // always attach the command; the command will validate if answer exists
        this.command = {
            command: 'collab-session.openStudentAnswer',
            title: 'Open',
            arguments: [{ student }],
        };
        if (hasAnswer) {
            this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
            this.tooltip = `${student} • has an answer (click to open)`;
        }
        else {
            this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
            this.tooltip = `${student} • no answer yet (click to see a hint)`;
        }
    }
}
class AnswerItem extends vscode.TreeItem {
    student;
    constructor(student) {
        super(student, vscode.TreeItemCollapsibleState.None);
        this.student = student;
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
class AnswersTreeProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }
    getTreeItem(el) {
        return el;
    }
    getChildren() {
        // only the host needs this view
        if (myRole !== 'host')
            return Promise.resolve([]);
        const items = [...latestAnswers.keys()].sort().map(name => new AnswerItem(name));
        return Promise.resolve(items);
    }
}
// ---------- webview html (Home) ----------------------------------------------
function getHomeHtml() {
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
function activate(context) {
    // --- register tree views (only show if contributed in package.json)
    treeDataProvider = new SessionTreeProvider();
    vscode.window.registerTreeDataProvider('collabSessionUsers', treeDataProvider);
    answersProvider = new AnswersTreeProvider();
    vscode.window.registerTreeDataProvider('collabSessionAnswers', answersProvider);
    // --- core commands
    context.subscriptions.push(cmdShowHome, cmdCreateSession, cmdJoinSession, cmdCopySessionId, cmdLeaveSession, cmdCloseSession, cmdSendAnswer, cmdOpenStudentAnswer, cmdSendFeedback, cmdShowQuestion);
    // ---------------------------------------------------------------------------
    // ⚙️ Set Host IP (manual override stored in settings)
    // ---------------------------------------------------------------------------
    const cmdSetHostIP = vscode.commands.registerCommand('collab-session.setHostIP', async () => {
        // read current value (default to localhost)
        const current = vscode.workspace.getConfiguration().get('collab.hostIP') || 'localhost';
        // ask user for a new value
        const input = await vscode.window.showInputBox({
            prompt: 'Enter new Host IPv4 or ws(s) URL (e.g. 192.168.1.187 or wss://xxxx.ngrok-free.app)',
            value: current
        });
        // cancelled → do nothing
        if (!input)
            return;
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
        vscode.window.showInformationMessage(`Question sync mode: ${syncOnSaveOnly ? 'On Save (Ctrl+S)' : 'Live (debounced)'}`);
    });
    context.subscriptions.push(cmdToggleSync);
    // ---------------------------------------------------------------------------
    // 🔧 React when user changes the setting from UI (Settings)
    // ---------------------------------------------------------------------------
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('collab.syncOnSaveOnly')) {
            // refresh runtime flag from settings
            syncOnSaveOnly = readSyncMode();
            // rewire listeners if the question editor is open
            if (questionEditor && !questionEditor.document.isClosed) {
                wireQuestionSyncListeners();
            }
            vscode.window.showInformationMessage(`Question sync mode updated: ${syncOnSaveOnly ? 'On Save' : 'Live'}`);
        }
    }));
    // ---------------------------------------------------------------------------
    // 🚀 Auto-open Home on activation (nice first-run experience)
    // ---------------------------------------------------------------------------
    void vscode.commands.executeCommand('collab-session.showHome');
    console.log('Collab Session activated → Home opened automatically.');
}
function deactivate() {
    try {
        ws?.close();
    }
    catch { }
}
//# sourceMappingURL=extension.js.map