const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const expressApp = require('./app');  // Import the configured Express app

let mainWindow;
let serverPort;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.loadURL(`http://localhost:${serverPort}/`);
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });
}

app.whenReady().then(async () => {
    try {
        const userDataPath = app.getPath('userData');
        serverPort = process.env.PORT || 4400;

        serverPort = await expressApp.init({ userDataPath, port: serverPort });

        ipcMain.handle('select-directory', async () => {
            const result = await dialog.showOpenDialog({
                properties: ['openDirectory', 'createDirectory']
            });
            if (result.canceled || !result.filePaths.length) return null;
            return result.filePaths[0];
        });

        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    } catch (error) {
        console.error('Failed to initialise application:', error);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    const server = expressApp.getServer && expressApp.getServer();
    if (server && server.listening) {
        server.close();
    }
});
