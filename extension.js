import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class TwoWallpapersExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._settings = null;
        this._wm = global.workspace_manager;

        // Background actors for each monitor
        this._bgActors = [];

        // Keep track of all window added/removed connections globally
        this._workspaceSignals = new Map();

        // Track window visibility changes
        this._windowSignals = new Map();

        this._bgChangedId = null;
    }

    _createBgActor(monitorIndex, uri) {
        let monitor = Main.layoutManager.monitors[monitorIndex];
        let actor = new St.Widget({
            style: `background-image: url("${uri}"); background-size: cover; background-position: center;`,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            opacity: 0 // Start hidden
        });
        return actor;
    }

    _setupBackgroundActors() {
        this._removeBackgroundActors();

        let uri = this._settings.get_string('wallpaper-with-windows');
        if (!uri) return;

        // Handle file:// prefix if needed or standard path
        let formattedUri = uri.startsWith('file://') ? uri : `file://${uri}`;

        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            let actor = this._createBgActor(i, formattedUri);
            // Add to background group so it's behind everything
            Main.layoutManager._backgroundGroup.add_child(actor);
            this._bgActors.push(actor);
        }
    }

    _removeBackgroundActors() {
        for (let actor of this._bgActors) {
            actor.destroy();
        }
        this._bgActors = [];
    }

    _isWorkspaceCovered(workspace) {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return false;

        let gridW = this._settings ? this._settings.get_int('grid-width') : 8;
        let gridH = this._settings ? this._settings.get_int('grid-height') : 4;

        // Safety bounds
        if (gridW <= 0) gridW = 8;
        if (gridH <= 0) gridH = 4;

        let cellW = monitor.width / gridW;
        let cellH = monitor.height / gridH;

        let coveredCells = 0;
        let totalCells = gridW * gridH;

        // Filter out minimized, utility, desktop, dock, or hidden windows
        const windows = workspace.list_windows().filter(w => {
            return w.showing_on_its_workspace() &&
                   !w.minimized &&
                   !w.skip_taskbar &&
                   w.window_type === Meta.WindowType.NORMAL;
        });

        if (windows.length === 0) return false;

        for (let x = 0; x < gridW; x++) {
            for (let y = 0; y < gridH; y++) {
                let cx = monitor.x + (x * cellW) + (cellW / 2);
                let cy = monitor.y + (y * cellH) + (cellH / 2);

                // Check if any visible window covers this center point
                let isCovered = windows.some(w => {
                    let frameRect = w.get_frame_rect();
                    let bufferRect = w.get_buffer_rect();

                    // XWayland apps like Microsoft Edge sometimes have weird frame rects vs buffer rects
                    // We check if the point falls inside the buffer rect OR the frame rect
                    let inFrame = cx >= frameRect.x && cx <= (frameRect.x + frameRect.width) &&
                                  cy >= frameRect.y && cy <= (frameRect.y + frameRect.height);

                    let inBuffer = cx >= bufferRect.x && cx <= (bufferRect.x + bufferRect.width) &&
                                   cy >= bufferRect.y && cy <= (bufferRect.y + bufferRect.height);

                    return inFrame || inBuffer;
                });

                if (isCovered) coveredCells++;
            }
        }

        // 60% coverage threshold
        return (coveredCells / totalCells) >= 0.6;
    }

    _updateState() {
        let activeWs = this._wm.get_active_workspace();

        // Update background actors opacity based on active workspace coverage
        let isActiveCovered = this._isWorkspaceCovered(activeWs);
        let bgTargetOpacity = isActiveCovered ? 255 : 0;

        for (let bgActor of this._bgActors) {
            bgActor.ease({
                opacity: bgTargetOpacity,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        }
    }

    _onWindowAdded(ws, window) {
        let signals = [];
        signals.push(window.connect('notify::minimized', () => this._updateState()));
        signals.push(window.connect('size-changed', () => this._updateState()));
        signals.push(window.connect('position-changed', () => this._updateState()));
        this._windowSignals.set(window, signals);

        this._updateState();
    }

    _onWindowRemoved(ws, window) {
        let signals = this._windowSignals.get(window);
        if (signals && window) {
            signals.forEach(id => window.disconnect(id));
        }
        this._windowSignals.delete(window);

        this._updateState();
    }

    _setupWorkspaceSignals() {
        for (let i = 0; i < this._wm.n_workspaces; i++) {
            let ws = this._wm.get_workspace_by_index(i);
            if (!this._workspaceSignals.has(ws)) {
                let addedId = ws.connect('window-added', this._onWindowAdded.bind(this));
                let removedId = ws.connect('window-removed', this._onWindowRemoved.bind(this));
                this._workspaceSignals.set(ws, {addedId, removedId});

                // Add existing windows
                for (let w of ws.list_windows()) {
                    this._onWindowAdded(ws, w);
                }
            }
        }
    }

    _cleanupWorkspaceSignals() {
        for (let [ws, signals] of this._workspaceSignals.entries()) {
            if (ws) {
                ws.disconnect(signals.addedId);
                ws.disconnect(signals.removedId);
            }
        }
        this._workspaceSignals.clear();

        for (let [w, signals] of this._windowSignals.entries()) {
            if (w) {
                signals.forEach(id => w.disconnect(id));
            }
        }
        this._windowSignals.clear();
    }

    _onMonitorsChanged() {
        // When screen wakes up from sleep/lock, monitors can be rebuilt
        this._setupBackgroundActors();
        this._updateState();
    }

    enable() {
        this._startupTimeoutId = setTimeout(() => {
            this._settings = this.getSettings();

            // Set basic wallpaper immediately using settings so it's loaded by gnome
            let noWinUri = this._settings.get_string('wallpaper-no-windows');
            if (noWinUri) {
                let bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
                bgSettings.set_string('picture-uri', noWinUri);
                bgSettings.set_string('picture-uri-dark', noWinUri);
            }

            this._setupBackgroundActors();
            this._setupWorkspaceSignals();

            this._wsSwitchedId = this._wm.connect('workspace-switched', () => this._updateState());
            this._wsAddedId = this._wm.connect('workspace-added', () => this._setupWorkspaceSignals());

            this._bgChangedId = this._settings.connect('changed::wallpaper-with-windows', () => {
                this._setupBackgroundActors();
                this._updateState();
            });

            this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', this._onMonitorsChanged.bind(this));

            this._updateState();
        }, 500);
    }

    disable() {
        if (this._startupTimeoutId) {
            clearTimeout(this._startupTimeoutId);
            this._startupTimeoutId = null;
        }

        if (this._wsSwitchedId) {
            this._wm.disconnect(this._wsSwitchedId);
            this._wsSwitchedId = null;
        }
        if (this._wsAddedId) {
            this._wm.disconnect(this._wsAddedId);
            this._wsAddedId = null;
        }
        if (this._bgChangedId && this._settings) {
            this._settings.disconnect(this._bgChangedId);
            this._bgChangedId = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        this._cleanupWorkspaceSignals();
        this._removeBackgroundActors();
        this._settings = null;
    }
}
