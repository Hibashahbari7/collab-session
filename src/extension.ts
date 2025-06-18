import * as vscode from 'vscode';

let sessionId: string | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
    
    const openSession = vscode.commands.registerCommand('collab-session.openSession', async () => {
        sessionId = Math.random().toString(36).substr(2, 6).toUpperCase(); // Generate a random 6-character session code
        await vscode.env.clipboard.writeText(sessionId);
        vscode.window.showInformationMessage(`🟢 Session "${sessionId}" created and copied to clipboard.`);
    });

    const joinSession = vscode.commands.registerCommand('collab-session.joinSession', async () => {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter session ID to join',
            placeHolder: 'ABC123'
        });

        if (!input) {
            vscode.window.showWarningMessage('❗ No session ID entered.');
            return;
        }

        sessionId = input;
        vscode.window.showInformationMessage(`🔗 Joined session "${sessionId}"`);
    });

    context.subscriptions.push(openSession, joinSession);
}
