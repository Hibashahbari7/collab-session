import * as vscode from 'vscode';
const sessions: Record<string, string[]> = {};
let sessionId: string | undefined = undefined;
let nickname: string | undefined = undefined;
let treeDataProvider: SessionTreeProvider | undefined;
let ws: WebSocket | undefined;

// ✅ Open session
const openSession = vscode.commands.registerCommand('collab-session.openSession', async () => {
    sessionId = Math.random().toString(36).substr(2, 6).toUpperCase();
    sessions[sessionId] = ['host'];
    await vscode.env.clipboard.writeText(sessionId);
    vscode.window.showInformationMessage(`🟢 Session "${sessionId}" created and copied to clipboard.`);
    treeDataProvider?.refresh();
});

// ✅ Join session
const joinSession = vscode.commands.registerCommand('collab-session.joinSession', async () => {
    const input = await vscode.window.showInputBox({
        prompt: 'Enter session ID to join',
        placeHolder: 'ABC123'
    });

    if (!input) {
        vscode.window.showWarningMessage('⚠️ No session ID entered.');
        return;
    }

    if (!sessions[input]) {
        vscode.window.showErrorMessage('❌ Invalid session ID.');
        return;
    }

    const name = await vscode.window.showInputBox({
        prompt: 'Enter your name or nickname',
        placeHolder: 'student123'
    });

    if (!name) {
        vscode.window.showWarningMessage('⚠️ No name entered.');
        return;
    }

    if (sessions[input].includes(name)) {
        vscode.window.showWarningMessage(`⚠️ A user with the name "${name}" is already connected.`);
        return;
    }

    sessions[input].push(name);
    sessionId = input;
    nickname = name;
    treeDataProvider?.refresh();

    // 🌐 Connect to WebSocket
    ws = new WebSocket('ws://localhost:3000');

    ws.onopen = () => {
        vscode.window.showInformationMessage(`✅ Connected to session ${sessionId}`);
    };

    ws.onmessage = (event: MessageEvent) => {
        try {
            const msg = JSON.parse(event.data.toString());

            if (msg.sessionId === sessionId && msg.name !== nickname) {
                // ✅ Show sender name before opening the code
                vscode.window.showInformationMessage(`📥 Received code from ${msg.name}`);

                // Open the received code in a new document
                vscode.workspace.openTextDocument({ content: msg.code }).then(doc => {
                    vscode.window.showTextDocument(doc, { preview: false });
                });
            }

        } catch (err) {
            console.error('Invalid message format:', err);
        }
    };


});

// ✅ Print connected users
const printUsers = vscode.commands.registerCommand('collab-session.printUsers', () => {
    if (!sessionId || !sessions[sessionId]) {
        vscode.window.showWarningMessage('👤 No users connected yet.');
        return;
    }

    const users = sessions[sessionId].join(', ');
    vscode.window.showInformationMessage(`👥 Connected users: ${users}`);
});

// ✅ Send code
const sendCodeCmd = vscode.commands.registerCommand('collab-session.sendCode', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && ws && ws.readyState === WebSocket.OPEN && sessionId && nickname) {
        const code = editor.document.getText();
        const message = JSON.stringify({ sessionId, name: nickname, code });
        ws.send(message);
        vscode.window.showInformationMessage('📤 Code sent to session.');
    } else {
        vscode.window.showWarningMessage('⚠️ Cannot send code. Not connected or no editor open.');
    }
});

// ✅ Tree view logic
class SessionTreeProvider implements vscode.TreeDataProvider<UserItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<UserItem | undefined> = new vscode.EventEmitter<UserItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<UserItem | undefined> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: UserItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<UserItem[]> {
        if (!sessionId || !sessions[sessionId]) {
            return Promise.resolve([]);
        }
        const users = sessions[sessionId];
        return Promise.resolve(users.map(name => new UserItem(name)));
    }
}

class UserItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
    }
}

// ✅ Entry point
export function activate(context: vscode.ExtensionContext) {
    treeDataProvider = new SessionTreeProvider();
    vscode.window.registerTreeDataProvider('collabSessionUsers', treeDataProvider);

    context.subscriptions.push(openSession, joinSession, printUsers, sendCodeCmd);
}

export function deactivate() {
    if (ws) {
        ws.close();
    }
}
