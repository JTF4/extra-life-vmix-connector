const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const expressApp = require('./app');  // Import your Express app (we will pass userDataPath here)

let mainWindow;
let server;
const port = process.env.PORT || 4400;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    const userDataPath = app.getPath('userData');  // Get userData path here

    // Pass the userDataPath to the Express app by passing it to the server creation
    expressApp.init({ userDataPath });

    server = http.createServer(expressApp);

    server.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        createWindow();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
