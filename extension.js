import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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

        // Background clones inserted under windows
        this._windowBackgroundClones = new Map();

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
        // 8x4 Grid calculation
        let monitor = Main.layoutManager.primaryMonitor; // Simplification: mostly checking primary monitor
        if (!monitor) return false;

        let gridW = 8;
        let gridH = 4;
        let cellW = monitor.width / gridW;
        let cellH = monitor.height / gridH;

        let coveredCells = 0;
        let totalCells = gridW * gridH;

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

        // Also fade out/in the window background clones
        // If the screen IS covered, the user doesn't want the desktop to bleed through windows
        // Wait, the user wants the desktop background ALWAYS under the window, no matter what?
        // "solo mostrare sempre lo sfondo del desktop sotto di lei"
        // Yes, always show the normal desktop under the window so it hides other windows.
        // Wait, if the background actors (which are the BLURRED wallpaper) are active, does the clone show the blurred wallpaper or the normal one?
        // The clone is of `Main.layoutManager._backgroundGroup`, which *contains* our blurred actors!
        // So the clone naturally inherits whatever the desktop currently looks like, which is exactly correct!
    }

    _addWindowBackgroundClone(window) {
        if (!window || this._windowBackgroundClones.has(window)) return;

        let windowActor = window.get_compositor_private();
        if (!windowActor) return;

        // Blur-my-shell uses a Clutter.Clone of the background group cropped to the window.
        // We will create a clone of the system background.
        let bgGroup = Main.layoutManager._backgroundGroup;
        if (!bgGroup) return;

        let clone = new Clutter.Clone({
            source: bgGroup,
            opacity: 255
        });

        // The clone needs to be shifted so that it displays the correct part of the desktop
        // underneath the window. However, a simpler approach is placing a solid black or dark actor
        // with the background wallpaper, or just letting the clone sit mapped.
        // We can simply bind it to the window actor and use a Clutter.Actor to clip it.
        let clipActor = new Clutter.Actor({
            clip_to_allocation: true,
        });

        clipActor.add_child(clone);

        // Inject exactly like blur-my-shell to avoid compositor breaking:
        // as the first child of the window actor.
        windowActor.insert_child_at_index(clipActor, 0);

        // Since clipActor is a child of windowActor, its coordinate space is relative to the window.
        // We just bind its size to the window actor. We do NOT bind position, as that would shift it
        // outside the bounds.
        clipActor.add_constraint(new Clutter.BindConstraint({ source: windowActor, coordinate: Clutter.BindCoordinate.SIZE }));
        clipActor.set_position(0, 0);

        // We must translate the clone backwards by the window's absolute position on screen
        // so the desktop clone aligns perfectly with the real desktop.
        // We use the buffer_rect to better align with the bounds used by the compositor for the windowActor.
        let updateCloneOffset = () => {
            let rect = window.get_buffer_rect();
            clone.set_position(-rect.x, -rect.y);
        };

        updateCloneOffset();

        this._windowBackgroundClones.set(window, { clipActor, updateCloneOffset });
    }

    _removeWindowBackgroundClone(window) {
        let data = this._windowBackgroundClones.get(window);
        if (data) {
            data.clipActor.destroy();
            this._windowBackgroundClones.delete(window);
        }
    }

    _onWindowAdded(ws, window) {
        this._addWindowBackgroundClone(window);

        let signals = [];
        signals.push(window.connect('notify::minimized', () => {
            this._updateState();
        }));
        signals.push(window.connect('size-changed', () => {
            let data = this._windowBackgroundClones.get(window);
            if (data) data.updateCloneOffset();
            this._updateState();
        }));
        signals.push(window.connect('position-changed', () => {
            let data = this._windowBackgroundClones.get(window);
            if (data) data.updateCloneOffset();
            this._updateState();
        }));
        this._windowSignals.set(window, signals);

        this._updateState();
    }

    _onWindowRemoved(ws, window) {
        this._removeWindowBackgroundClone(window);

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
            this._removeWindowBackgroundClone(w);
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
