const { app, Tray, Menu, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let tray = null;
let nodeApp = null;

app.whenReady().then(() => {
    createTray();
    startNodeApp();

    if (process.platform === 'darwin') {
        app.dock.hide();
    }
});

// Correctly reference the project directory for app.js
function startNodeApp() {
    const appPath = path.join(__dirname, 'app.js');  // Path to app.js
    const userDataPath = app.getPath('userData');    // Electron's userData path

    // Spawn the Node.js process, passing userDataPath as an environment variable
    nodeApp = spawn('node', [appPath], {
        env: {
            ...process.env,  // Pass existing environment variables
            USER_DATA_PATH: userDataPath  // Add userDataPath as an environment variable
        },
        stdio: 'inherit'
    });

    nodeApp.on('close', (code) => {
        console.log(`Node.js app exited with code ${code}`);
    });
}

// Create tray icon and context menu
function createTray() {
    const iconPath = path.join(__dirname, 'icon2.png');  // Replace with your own icon file or blank one
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Launch Browser',
            click: () => {
                require('electron').shell.openExternal('http://localhost:4400');
            },
        },
        {
            label: 'Quit',
            click: () => {
                showQuitConfirmation();
            },
        },
    ]);

    tray.setToolTip('Your App');
    tray.setContextMenu(contextMenu);
}

// Handle quitting confirmation
function showQuitConfirmation() {
    const options = {
        type: 'question',
        buttons: ['Cancel', 'Quit'],
        defaultId: 1,
        title: 'Confirm Quit',
        message: 'Are you sure you want to quit?',
        detail: 'This will stop the Node.js server running in the background.',
    };

    const response = dialog.showMessageBoxSync(null, options);
    if (response === 1) {
        if (nodeApp) nodeApp.kill();  // Ensure the Node.js server is stopped
        app.quit();
    }
}
