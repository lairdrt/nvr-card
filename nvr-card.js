/*
 For Home Assisstant
*/

const NVR_BUILD = "__NVR_BUILD__";
const NVR_MAXIMIZE_DIAGNOSTICS = false;
const NVR_MAXIMIZE_FLIGHT_RECORDER = true;
const NVR_DIAGNOSTIC_LIVE_SLOT_LIMIT = 4;
const NVR_FLIGHT_RECORDER_SIZE = 256;
const NVR_MEDIA_SNAPSHOT_EVENTS = new Set([
  "maximize-start",
  "maximize-classes-applied",
  "fit-end",
  "restore-start",
  "layout-end"
]);
const NVR_MAXIMIZE_MEDIA_SAMPLE_INTERVAL = 250;
const NVR_MAXIMIZE_MEDIA_SAMPLE_DURATION = 8000;
const NVR_MAXIMIZE_MEDIA_SESSION_LIMIT = 10;
const NVR_FLIGHT_RECORDER_STATE_KEY =
  Symbol.for("nvr.maximizeFlightRecorder");
const NVR_FLIGHT_RECORDER_STATE =
  window[NVR_FLIGHT_RECORDER_STATE_KEY] ?? {
    records: new Array(NVR_FLIGHT_RECORDER_SIZE),
    index: 0,
    count: 0,
    fitRequestCount: 0,
    nextInstanceId: 1,
    mediaSessions: [],
    nextMediaSessionId: 1
  };

NVR_FLIGHT_RECORDER_STATE.mediaSessions ??= [];
NVR_FLIGHT_RECORDER_STATE.nextMediaSessionId ??= 1;

window[NVR_FLIGHT_RECORDER_STATE_KEY] =
  NVR_FLIGHT_RECORDER_STATE;

window.dumpNvrFlightRecorder = () => {
  if (!NVR_MAXIMIZE_FLIGHT_RECORDER) {
    return [];
  }

  const state = NVR_FLIGHT_RECORDER_STATE;
  const start =
    (state.index -
      state.count +
      NVR_FLIGHT_RECORDER_SIZE) %
    NVR_FLIGHT_RECORDER_SIZE;

  return Array.from(
    { length: state.count },
    (_, offset) => {
      const record = state.records[
        (start + offset) %
          NVR_FLIGHT_RECORDER_SIZE
      ];

      return {
        ...record,
        ...(record.media
          ? {
              media: record.media.map(
                snapshot => ({ ...snapshot })
              )
            }
          : {})
      };
    }
  );
};

window.dumpNvrMaximizeMediaSessions = () => {
  return NVR_FLIGHT_RECORDER_STATE.mediaSessions.map(
    session => ({
      ...session,
      samples: session.samples.map(sample => ({ ...sample })),
      events: {
        waiting: [...session.events.waiting],
        stalled: [...session.events.stalled],
        playing: [...session.events.playing]
      },
      visibility: session.visibility.map(
        entry => ({ ...entry })
      )
    })
  );
};

// Internal camera-inventory safety limit; not a viewer slot limit.
const MAX_CAMERAS = 256;
const NVR_LAYOUT_DRAG_TYPE =
  "application/x-nvr-layout";
const NVR_CAMERA_DRAG_TYPE =
  "application/x-nvr-camera";
const NVR_GRID_CAMERA_DRAG_TYPE =
  "application/x-nvr-grid-camera";

class NVRCard extends HTMLElement {
  constructor() {
    super();

    this._layout = "2x2";
    this._hass = null;
    this._selectedCamera = null;
    this._selectedLayout = null;
    this._maximizedSlot = null;
    this._placementClickPending = false;
    this._cameraContextSlot = null;

    this._cameraContextPointerHandler =
      event => {
        const menu =
          this.querySelector(
            ".camera-context-menu"
          );

        if (
          !menu ||
          !event.composedPath().includes(menu)
        ) {
          this.closeCameraContextMenu();
        }
      };

    this._cameraContextKeyHandler =
      event => {
        if (event.key === "Escape") {
          this.closeCameraContextMenu();
        }
      };

    this._sidebarSections = {
      cameras: false,
      layouts: false,
      views: false
    };

    this._sidebarCollapsed = null;
    this._viewportListenersInstalled = false;

    this._viewportResizeHandler = event => {
      const source =
        event?.currentTarget === window.visualViewport
          ? "visual-viewport-resize"
          : event
            ? "window-resize"
            : "viewport-initial";

      this.logMaximizeDiagnostic(
        source,
        this.getMaximizeDiagnosticSnapshot()
      );

      this.recordNvrFlight(source);

      this.updateAvailableHeight();
      this.updateResponsiveShell();
    };

    this._diagnosticMediaChecked =
      NVR_MAXIMIZE_DIAGNOSTICS
        ? new WeakSet()
        : null;

    this._cameras = [];

    this._cameraAspectRatio =
      16 / 9;

    /*
     * Fixed 16-slot assignment array.
     *
     * Layout switching does NOT recreate the slot DOM.
     */
    this._assignedCameras =
      new Array(16).fill(null);

    this._resizeObserver = null;
    this._cameraFitFrame = null;
    this._maximizedPlayerFit = null;
    this._mediaDiagnosticStates = new WeakMap();
    this._activeMaximizeMediaSession = null;
    this._nvrInstanceId =
      NVR_FLIGHT_RECORDER_STATE.nextInstanceId++;
    this._nvrVisibilityHandler = () => {
      this.recordNvrFlight("visibility-change");
      this.recordMaximizeMediaVisibility();
    };

    this.layouts = {
      "1x1": {
        label: "1x1",
        columns: "1fr",
        rows: "1fr",
        cells: [
          { slot: 0 }
        ]
      },

      "2x2": {
        label: "2x2",
        columns: "repeat(2, 1fr)",
        rows: "repeat(2, 1fr)",
        cells: [
          { slot: 0 },
          { slot: 1 },
          { slot: 2 },
          { slot: 3 }
        ]
      },

      "3x3": {
        label: "3x3",
        columns: "repeat(3, 1fr)",
        rows: "repeat(3, 1fr)",
        cells: Array.from(
          { length: 9 },
          (_, i) => ({ slot: i })
        )
      },

      "4x4": {
        label: "4x4",
        columns: "repeat(4, 1fr)",
        rows: "repeat(4, 1fr)",
        cells: Array.from(
          { length: 16 },
          (_, i) => ({ slot: i })
        )
      },

      "large3": {
        label: "Large+3",
        columns: "repeat(2, 1fr)",
        rows: "repeat(3, 1fr)",
        cells: [
          {
            slot: 0,
            column: "1",
            row: "1 / span 2"
          },
          {
            slot: 1,
            column: "2",
            row: "1"
          },
          {
            slot: 2,
            column: "2",
            row: "2"
          },
          {
            slot: 3,
            column: "1 / span 2",
            row: "3"
          }
        ]
      },

      "large5": {
        label: "Large+5",
        columns: "repeat(3, 1fr)",
        rows: "repeat(3, 1fr)",
        cells: [
          {
            slot: 0,
            column: "1 / span 2",
            row: "1 / span 2"
          },
          {
            slot: 1,
            column: "3",
            row: "1"
          },
          {
            slot: 2,
            column: "3",
            row: "2"
          },
          {
            slot: 3,
            column: "1",
            row: "3"
          },
          {
            slot: 4,
            column: "2",
            row: "3"
          },
          {
            slot: 5,
            column: "3",
            row: "3"
          }
        ]
      },

      "large7": {
        label: "Large+7",
        columns: "repeat(4, 1fr)",
        rows: "repeat(4, 1fr)",
        cells: [
          {
            slot: 0,
            column: "1 / span 3",
            row: "1 / span 3"
          },
          {
            slot: 1,
            column: "4",
            row: "1"
          },
          {
            slot: 2,
            column: "4",
            row: "2"
          },
          {
            slot: 3,
            column: "4",
            row: "3"
          },
          {
            slot: 4,
            column: "1",
            row: "4"
          },
          {
            slot: 5,
            column: "2",
            row: "4"
          },
          {
            slot: 6,
            column: "3",
            row: "4"
          },
          {
            slot: 7,
            column: "4",
            row: "4"
          }
        ]
      },

      "topwide": {
        label: "Top Wide",
        columns: "repeat(3, 1fr)",
        rows: "repeat(3, 1fr)",
        cells: [
          {
            slot: 0,
            column: "1 / span 3",
            row: "1 / span 2"
          },
          {
            slot: 1,
            column: "1",
            row: "3"
          },
          {
            slot: 2,
            column: "2",
            row: "3"
          },
          {
            slot: 3,
            column: "3",
            row: "3"
          }
        ]
      },

      "leftwide": {
        label: "Left Wide",
        columns: "repeat(3, 1fr)",
        rows: "repeat(3, 1fr)",
        cells: [
          {
            slot: 0,
            column: "1 / span 2",
            row: "1 / span 3"
          },
          {
            slot: 1,
            column: "3",
            row: "1"
          },
          {
            slot: 2,
            column: "3",
            row: "2"
          },
          {
            slot: 3,
            column: "3",
            row: "3"
          }
        ]
      }
    };
  }


  setConfig(config) {
    const normalized =
      this.normalizeConfig(config);

    this.config = config;
    this._cameras = normalized.cameras;
    this._cameraAspectRatio =
      normalized.cameraAspectRatio;

    this.render();
  }


  normalizeConfig(config) {
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config)
    ) {
      throw new Error(
        "NVR card configuration must be an object."
      );
    }

    const hasCameras =
      Object.prototype.hasOwnProperty.call(
        config,
        "cameras"
      );

    if (!hasCameras) {
      throw new Error(
        "NVR card configuration requires a cameras array."
      );
    }

    const hasAspectRatio =
      Object.prototype.hasOwnProperty.call(
        config,
        "camera_aspect_ratio"
      );

    const cameras =
      this.normalizeCameras(config.cameras);

    const cameraAspectRatio =
      this.parseAspectRatio(
        hasAspectRatio
          ? config.camera_aspect_ratio
          : "16:9"
      );

    return {
      cameras,
      cameraAspectRatio
    };
  }


  normalizeCameras(cameras) {
    if (!Array.isArray(cameras)) {
      throw new Error(
        "cameras must be an array."
      );
    }

    if (cameras.length > MAX_CAMERAS) {
      throw new Error(
        `cameras cannot contain more than ${MAX_CAMERAS} entries.`
      );
    }

    const names = new Set();
    const allowedFields =
      new Set(["name", "entity", "active"]);

    return cameras.map((camera, index) => {
      const number = index + 1;

      if (
        !camera ||
        typeof camera !== "object" ||
        Array.isArray(camera)
      ) {
        throw new Error(
          `Camera ${number} must be an object.`
        );
      }

      const unsupportedField =
        Object.keys(camera).find(
          field => !allowedFields.has(field)
        );

      if (unsupportedField) {
        throw new Error(
          `Camera ${number} has unsupported field "${unsupportedField}".`
        );
      }

      if (
        typeof camera.name !== "string" ||
        camera.name.trim().length === 0
      ) {
        throw new Error(
          `Camera ${number} name must be a nonempty string.`
        );
      }

      if (
        typeof camera.entity !== "string" ||
        camera.entity.trim().length === 0
      ) {
        throw new Error(
          `Camera ${number} entity must be a nonempty string.`
        );
      }

      if (names.has(camera.name)) {
        throw new Error(
          `Camera names must be unique: "${camera.name}".`
        );
      }

      names.add(camera.name);

      const hasActive =
        Object.prototype.hasOwnProperty.call(
          camera,
          "active"
        );

      if (
        hasActive &&
        typeof camera.active !== "boolean"
      ) {
        throw new Error(
          `Camera ${number} active must be a boolean.`
        );
      }

      return {
        name: camera.name,
        entity: camera.entity,
        active: hasActive
          ? camera.active
          : true
      };
    });
  }


  parseAspectRatio(value) {
    if (typeof value !== "string") {
      throw new Error(
        "camera_aspect_ratio must be a string such as \"16:9\"."
      );
    }

    const parts = value.split(":");

    if (parts.length !== 2) {
      throw new Error(
        "camera_aspect_ratio must contain exactly one colon."
      );
    }

    const width = Number(parts[0]);
    const height = Number(parts[1]);

    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error(
        "camera_aspect_ratio values must be positive finite numbers."
      );
    }

    return width / height;
  }


  set hass(hass) {
    if (hass === this._hass) {
      return;
    }

    this._hass = hass;
    this.promoteEligibleLegacyCameras();
    this.updateLiveStreams();
    this.updateCameraStatuses();
  }


  promoteEligibleLegacyCameras() {
    this
      .querySelectorAll("hui-image.nvr-live-camera")
      .forEach(image => {
        const slot = Number(
          image.closest(".video-cell")?.dataset.slot
        );
        const camera = this.getCameraByName(
          this._assignedCameras[slot]
        );
        const runtimeCameraName =
          this._hass?.states?.[camera?.entity]
            ?.attributes?.camera_name;

        if (
          Number.isInteger(slot) &&
          typeof runtimeCameraName === "string" &&
          runtimeCameraName.trim().length > 0
        ) {
          this.renderSlot(slot);
        }
      });
  }


  connectedCallback() {
    this.recordNvrFlight("card-connected");
    this.installViewportListeners();

    if (
      this.isConnected &&
      this._resizeObserver === null &&
      this.querySelector(".video-grid")
    ) {
      this.installResizeObserver();
    }
  }


  disconnectedCallback() {
    this.recordNvrFlight("card-disconnected");
    this.completeMaximizeMediaSession("disconnected");
    this.closeCameraContextMenu();
    this.removeViewportListeners();

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this._cameraFitFrame !== null) {
      cancelAnimationFrame(
        this._cameraFitFrame
      );

      this._cameraFitFrame = null;
    }
  }


  render() {
    this.closeCameraContextMenu();
    this._maximizedSlot = null;
    this._placementClickPending = false;

    this.innerHTML = `
      <ha-card>
        <div class="nvr-shell">

          <header class="card-title-bar">
            <button
              type="button"
              class="sidebar-toggle"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              aria-expanded="true"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <rect
                  x="3.5"
                  y="4.5"
                  width="17"
                  height="15"
                  rx="2"
                ></rect>
                <path d="M9 5v14"></path>
              </svg>
            </button>

            <div class="card-title">NVR Card</div>
            <span class="build-identifier">
              ${NVR_BUILD}
            </span>
          </header>

          <aside class="camera-list nvr-sidebar">

            <section
              class="sidebar-section camera-section ${this._sidebarSections.cameras ? "expanded" : ""}"
              data-section="cameras"
            >

              <button
                type="button"
                class="sidebar-section-header"
                data-section="cameras"
                aria-expanded="${this._sidebarSections.cameras}"
              >
                <span class="section-title">
                  <ha-icon icon="mdi:video-outline"></ha-icon>
                  <span>CAMERAS</span>
                </span>
                <span
                  class="section-indicator"
                  aria-hidden="true"
                ></span>
              </button>

              <div
                class="sidebar-section-body camera-section-body"
                ${this._sidebarSections.cameras ? "" : "hidden"}
              >

                <div class="camera-items sidebar-scroll-region">
                  ${this.buildCameraList()}
                </div>

              </div>

            </section>


            <section
              class="sidebar-section ${this._sidebarSections.layouts ? "expanded" : ""}"
              data-section="layouts"
            >

              <button
                type="button"
                class="sidebar-section-header"
                data-section="layouts"
                aria-expanded="${this._sidebarSections.layouts}"
              >
                <span class="section-title">
                  <ha-icon icon="mdi:view-grid-outline"></ha-icon>
                  <span>LAYOUTS</span>
                </span>
                <span
                  class="section-indicator"
                  aria-hidden="true"
                ></span>
              </button>

              <div
                class="sidebar-section-body sidebar-layout-body sidebar-scroll-region"
                ${this._sidebarSections.layouts ? "" : "hidden"}
              >
                <div class="sidebar-layout-grid">
                  ${this.buildSidebarLayouts()}
                </div>
              </div>

            </section>


            <section
              class="sidebar-section ${this._sidebarSections.views ? "expanded" : ""}"
              data-section="views"
            >

              <button
                type="button"
                class="sidebar-section-header"
                data-section="views"
                aria-expanded="${this._sidebarSections.views}"
              >
                <span class="section-title">
                  <ha-icon icon="mdi:view-dashboard-outline"></ha-icon>
                  <span>VIEWS</span>
                </span>
                <span
                  class="section-indicator"
                  aria-hidden="true"
                ></span>
              </button>

              <div
                class="sidebar-section-body sidebar-scroll-region"
                ${this._sidebarSections.views ? "" : "hidden"}
              >
                <div class="sidebar-placeholder">
                  <ha-icon icon="mdi:view-dashboard-outline"></ha-icon>
                  <span>No saved views</span>
                </div>
              </div>

            </section>


          </aside>


          <main class="main-area">

            <div class="video-grid">
              ${this.buildPersistentSlots()}
            </div>

          </main>


          <div
            class="camera-context-menu"
            hidden
          >
            <button
              type="button"
              class="camera-context-command"
            >
              Close Camera
            </button>
          </div>

        </div>
      </ha-card>
    `;


    const style =
      document.createElement("style");


    style.textContent = `
      ha-card {
        height: calc(
          100vh - var(--nvr-card-top, 0px)
        );
        height: calc(
          100dvh - var(--nvr-card-top, 0px)
        );
        height: var(
          --nvr-card-available-height,
          calc(100dvh - var(--nvr-card-top, 0px))
        );

        position: relative;

        background: #000;
        color: #fff;

        overflow: hidden;

        border-radius: 0;
      }


      .nvr-shell {
        width: 100%;
        height: 100%;

        display: grid;

        grid-template-columns:
          190px
          minmax(0, 1fr);

        grid-template-rows:
          44px
          minmax(0, 1fr);

        grid-template-areas:
          "title title"
          "cameras video";

        position: relative;
      }


      .nvr-shell.sidebar-collapsed {
        grid-template-columns:
          0
          minmax(0, 1fr);
      }


      .card-title-bar {
        grid-area: title;

        min-width: 0;

        display: flex;
        align-items: center;

        padding: 0 12px 0 4px;

        background: #12171d;

        border-bottom: 1px solid #26313b;

        box-sizing: border-box;
      }


      .card-title {
        margin-left: 4px;

        overflow: hidden;

        color: #e4e9ed;

        font-size: 15px;
        font-weight: 600;

        text-overflow: ellipsis;
        white-space: nowrap;
      }


      /* ================================================
         CAMERA LIST
         ================================================ */

      .camera-list {
        grid-area: cameras;

        min-width: 0;

        display: flex;
        flex-direction: column;

        background: #11161c;

        border-right: 1px solid #26313b;

        padding: 14px;

        overflow-x: hidden;
        overflow-y: auto;

        scrollbar-width: none;

        touch-action: pan-y;
        overscroll-behavior-y: contain;
        -webkit-overflow-scrolling: touch;

        transition: transform 160ms ease;
      }


      .nvr-shell.sidebar-collapsed
      > .camera-list {
        visibility: hidden;
        pointer-events: none;

        transform: translateX(-100%);
      }


      .sidebar-toggle {
        width: 42px;
        height: 42px;

        flex: 0 0 42px;

        padding: 0;

        display: grid;
        place-items: center;

        background: transparent;
        color: #aab8c2;

        border: 0;
        border-radius: 4px;

        cursor: pointer;
      }


      .sidebar-toggle:hover,
      .sidebar-toggle:focus-visible {
        background: #202a33;
        color: #e5f2fa;

        outline: none;
      }


      .sidebar-toggle svg {
        width: 22px;
        height: 22px;

        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;

        pointer-events: none;
      }


      .nvr-shell.phone-layout {
        grid-template-columns:
          minmax(0, 1fr);
        grid-template-areas:
          "title"
          "video";

        isolation: isolate;
      }


      .nvr-shell.phone-layout
      > .camera-list {
        width: 190px;
        height: calc(100% - 44px);

        position: absolute;
        top: 44px;
        left: 0;
        z-index: 100;

        box-sizing: border-box;
      }


      .nvr-shell.phone-layout
      > .main-area {
        position: relative;
        z-index: 0;
      }


      .nvr-shell.phone-layout:not(.sidebar-collapsed)
      > .main-area {
        pointer-events: none;
        touch-action: none;
      }


      .nvr-shell.phone-layout:not(.sidebar-collapsed)
      > .camera-context-menu {
        pointer-events: none;
      }


      .nvr-shell.phone-layout:not(.sidebar-collapsed)
      > .camera-list {
        pointer-events: auto;
      }


      .sidebar-section {
        flex: 0 0 auto;

        min-width: 0;
        min-height: 0;
      }


      .sidebar-section-header {
        width: 100%;
        min-height: 42px;

        display: flex;
        align-items: center;
        justify-content: space-between;

        padding: 0;

        background: transparent;

        border: 0;
        border-bottom: 1px solid #26313b;

        color: #6faed9;

        font-family: inherit;
        font-size: 13px;
        font-weight: 700;

        letter-spacing: 0.08em;

        text-align: left;

        cursor: pointer;
      }


      .sidebar-section-header:hover {
        background: #172029;
        color: #91c8ed;
      }


      .sidebar-section-header:focus-visible {
        background: #172029;
        color: #91c8ed;

        outline: 1px solid #477a9e;
        outline-offset: -1px;
      }


      .section-title {
        min-width: 0;

        display: flex;
        align-items: center;

        gap: 8px;
      }


      .section-title ha-icon {
        --mdc-icon-size: 17px;

        flex: 0 0 auto;
      }


      .section-indicator {
        width: 0;
        height: 0;

        border-top: 4.375px solid transparent;
        border-bottom: 4.375px solid transparent;
        border-left: 7.5px solid #6f8798;

        transform-origin: center;
      }


      .sidebar-section.expanded
      > .sidebar-section-header
      > .section-indicator {
        transform: rotate(90deg);
      }


      .sidebar-section-body {
        min-width: 0;
        min-height: 0;
      }


      .sidebar-section-body[hidden] {
        display: none;
      }


      .camera-section-body {
        padding-top: 8px;
      }


      .sidebar-placeholder {
        min-height: 38px;

        display: flex;
        align-items: center;

        gap: 8px;

        padding: 4px 8px;

        color: #70808c;

        font-size: 12px;
      }


      .sidebar-placeholder ha-icon {
        --mdc-icon-size: 17px;
      }


      .sidebar-layout-body {
        padding-right: 6px;
      }


      .sidebar-scroll-region {
        margin-right: -2px;
      }


      .camera-list::-webkit-scrollbar {
        display: none;

        width: 0;
        height: 0;
      }


      .sidebar-layout-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);

        gap: 2px;

        padding: 8px 0;
      }


      .sidebar-layout-item {
        min-width: 0;
        min-height: 40px;

        display: flex;
        align-items: center;

        gap: 10px;

        padding: 5px 8px;

        background: transparent;

        color: #c4ccd2;

        border: 1px solid transparent;
        border-radius: 4px;

        font-family: inherit;

        cursor: pointer;
      }


      .sidebar-layout-item:hover {
        background: #1b242c;
        color: #fff;
        border-color: #2c3b46;
      }


      .sidebar-layout-item.selected {
        background: #182630;
        color: #dbeaf4;
        border-color: transparent;
      }


      .sidebar-layout-item.target-selected {
        background: #1c303e;
        color: #fff;
        border-color: #568db3;
      }


      .sidebar-layout-item.dragging {
        opacity: 0.65;
      }


      .sidebar-layout-label {
        overflow: hidden;

        font-size: 13px;

        text-overflow: ellipsis;
        white-space: nowrap;
      }


      .camera-item {
        width: 100%;

        display: flex;
        align-items: center;

        gap: 9px;

        min-height: 40px;

        padding: 5px 8px;
        margin-bottom: 2px;

        box-sizing: border-box;

        background: transparent;

        color: #cbd2d7;

        border: 1px solid transparent;
        border-radius: 3px;

        font-size: 14px;
        text-align: left;

        cursor: pointer;
      }


      .camera-item:hover {
        background: #1b242c;
        color: #fff;
        border-color: #2c3b46;
      }


      .camera-item.assigned {
        background: #18232b;
        color: #dce3e8;
        border-color: transparent;
      }


      .camera-item.target-selected {
        background: #1c303e;
        color: #fff;
        border-color: #568db3;
      }


      .camera-item.dragging {
        opacity: 0.65;
      }


      .camera-row-icon {
        --mdc-icon-size: 18px;

        flex: 0 0 18px;

        color: #9caab4;

        pointer-events: none;
      }


      .camera-name {
        min-width: 0;

        flex: 1 1 auto;

        overflow: hidden;

        text-overflow: ellipsis;

        white-space: nowrap;
      }


      .camera-status {
        width: 7px;
        height: 7px;

        flex: 0 0 7px;

        margin-left: auto;

        border: 1.5px solid #d45b5b;
        border-radius: 50%;

        box-sizing: border-box;

        pointer-events: none;
      }


      .camera-status.online {
        background: #4caf70;
        border-color: #4caf70;
      }


      /* ================================================
         VIDEO GRID
         ================================================ */

      .main-area {
        grid-area: video;

        min-width: 0;
        min-height: 0;

        background: #000;

        padding: 4px;
      }


      .video-grid {
        width: 100%;
        height: 100%;

        display: grid;

        box-sizing: border-box;

        gap: 1px;

        background: #fff;

        border: 1px solid #fff;
      }


      .video-grid.layout-drop-target {
        border-color: #888;
      }


      /*
       * All 16 slots permanently exist.
       * Layout changes only hide/reposition them.
       */
      .video-cell {
        min-width: 0;
        min-height: 0;

        position: relative;

        background: #000;

        color: #555;

        overflow: hidden;

        cursor: pointer;
      }


      .video-cell.hidden-slot {
        display: none;
      }


      .video-grid.camera-maximized
        .video-cell:not(.maximized-camera) {
        visibility: hidden;
        pointer-events: none;
      }


      .video-grid.camera-maximized
        .video-cell.maximized-camera {
        display: block;

        grid-column: 1 / -1 !important;
        grid-row: 1 / -1 !important;
        order: 0 !important;
      }


      .video-cell.camera-drop-target {
        outline: 1px solid #aaa;
        outline-offset: -2px;
      }


      .camera-frame {
        position: absolute;

        inset: 0;

        display: flex;

        align-items: center;
        justify-content: center;

        background: #000;

        overflow: hidden;
      }


      hui-image.nvr-live-camera {
        display: block;

        flex: 0 0 auto;

        background: #000;

        overflow: hidden;

        --ha-card-border-width: 0;
        --ha-card-border-radius: 0;
      }


      nvr-live-presentation.nvr-live-camera {
        pointer-events: none;
      }


      .empty-cell-center {
        position: absolute;

        inset: 0;

        display: flex;

        align-items: center;
        justify-content: center;

        color: #444;

        font-size: 18px;

        pointer-events: none;
      }


      .placeholder-camera-name {
        position: absolute;

        inset: 0;

        display: flex;

        align-items: center;
        justify-content: center;

        color: #888;

        font-size: 16px;

        pointer-events: none;
      }


      .cell-camera-name {
        position: absolute;

        top: 6px;
        left: 7px;

        z-index: 5;

        padding: 3px 6px;

        background:
          rgba(0, 0, 0, 0.68);

        color: #fff;

        font-size: 12px;
        font-weight: 500;

        line-height: 1.2;

        pointer-events: none;
      }


      .cell-number {
        position: absolute;

        right: 7px;
        bottom: 5px;

        z-index: 5;

        color:
          rgba(255,255,255,0.45);

        font-size: 9px;

        pointer-events: none;
      }


      /* ================================================
         CAMERA CONTEXT MENU
         ================================================ */

      .build-identifier {
        flex: 0 0 auto;

        margin-left: 8px;

        color: #808080;

        font-size: 11.25px;

        white-space: nowrap;

        pointer-events: none;
      }


      .camera-context-menu {
        position: absolute;

        z-index: 20;

        min-width: 104px;

        padding: 2px;

        background: #111;

        border: 1px solid #777;
      }


      .camera-context-menu[hidden] {
        display: none;
      }


      .camera-context-command {
        width: 100%;

        padding: 5px 7px;

        background: transparent;

        color: #ccc;

        border: 0;
        border-radius: 0;

        font-family: inherit;
        font-size: 11px;
        text-align: left;

        cursor: pointer;
      }


      .camera-context-command:hover {
        background: #222;
        color: #fff;
      }


      /* ================================================
         MINIATURE LAYOUTS
         ================================================ */

      .layout-icon {
        width: 30px;
        height: 22px;

        flex: 0 0 30px;

        display: grid;

        gap: 1px;

        box-sizing: border-box;

        background: #687b89;

        border: 1px solid #687b89;
      }


      .layout-icon-cell {
        min-width: 0;
        min-height: 0;

        box-sizing: border-box;

        background: #11161c;
      }
    `;


    this.appendChild(style);


    this.attachCameraHandlers();
    this.attachCameraDragHandlers();
    this.attachSidebarHandlers();
    this.attachSidebarToggleHandler();
    this.attachLayoutHandlers();
    this.attachLayoutDragHandlers();
    this.attachSlotHandlers();
    this.attachCameraMaximizeHandlers();
    this.attachCameraContextMenuHandlers();

    /*
     * Persistent grid already exists.
     * Just apply the current layout.
     */
    this.applyLayout();

    this.updateSelectedButton();
    this.updateCameraListState();

    this.updateAvailableHeight();
    this.updateResponsiveShell();

    this.installResizeObserver();
  }


  /* ================================================
     BUILD PERMANENT 16-SLOT GRID
     ================================================ */

  buildPersistentSlots() {
    return Array.from(
      { length: 16 },
      (_, slot) => {

        return `
          <div
            class="video-cell"
            data-slot="${slot}"
          >

            <div
              class="empty-cell-center"
            >
              ${slot + 1}
            </div>

          </div>
        `;
      }
    ).join("");
  }


  buildCameraList() {
    return this._cameras
      .filter(camera => {
        return camera.active === true;
      })
      .map(camera => {

        const liveClass =
          camera.entity
            ? "live-capable"
            : "";

        const online =
          this.isCameraOnline(camera);

        const statusLabel =
          online ? "Online" : "Offline";

        return `
          <button
            type="button"
            class="camera-item ${liveClass}"
            data-camera="${camera.name}"
            draggable="true"
          >

            <ha-icon
              class="camera-row-icon"
              icon="mdi:cctv"
              aria-hidden="true"
            ></ha-icon>

            <span class="camera-name">
              ${camera.name}
            </span>

            <span
              class="camera-status ${online ? "online" : "offline"}"
              role="img"
              aria-label="${statusLabel}"
              title="${statusLabel}"
            ></span>

          </button>
        `;
      })
      .join("");
  }


  buildSidebarLayouts() {
    return Object
      .entries(this.layouts)
      .map(([key, layout]) => {

        return `
          <button
            type="button"
            class="sidebar-layout-item"
            data-layout="${key}"
            aria-label="${layout.label} layout"
            draggable="true"
          >

            ${this.buildMiniature(layout)}

            <div class="sidebar-layout-label">
              ${layout.label}
            </div>

          </button>
        `;
      })
      .join("");
  }


  buildMiniature(layout) {
    const cells =
      layout.cells
        .map(cell => {

          const column =
            cell.column
              ? `grid-column:${cell.column};`
              : "";

          const row =
            cell.row
              ? `grid-row:${cell.row};`
              : "";

          return `
            <span
              class="layout-icon-cell"
              style="${column}${row}"
            ></span>
          `;
        })
        .join("");


    return `
      <div
        class="layout-icon"
        style="
          grid-template-columns:${layout.columns};
          grid-template-rows:${layout.rows};
        "
      >
        ${cells}
      </div>
    `;
  }


  /* ================================================
     CAMERA ASSIGNMENT
     ================================================ */

  getCameraByName(cameraName) {
    return this._cameras.find(
      camera =>
        camera.name === cameraName
    );
  }


  isCameraOnline(camera) {
    if (
      !camera ||
      !camera.entity ||
      !this._hass ||
      !this._hass.states
    ) {
      return false;
    }

    const entityState =
      this._hass.states[camera.entity];

    if (!entityState) {
      return false;
    }

    return ![
      "unavailable",
      "unknown"
    ].includes(entityState.state);
  }


  assignCamera(cameraName) {
    if (this._maximizedSlot !== null) {
      return;
    }

    const layout =
      this.layouts[this._layout];


    if (!layout) {
      return;
    }


    const existingSlot =
      this._assignedCameras.indexOf(
        cameraName
      );


    /*
     * Clicking an assigned camera removes it.
     */
    if (existingSlot !== -1) {

      this.removeCameraFromSlot(
        existingSlot
      );

      return;
    }


    /*
     * Find first empty VISIBLE slot.
     */
    const targetCell =
      layout.cells.find(cell => {

        return (
          this._assignedCameras[
            cell.slot
          ] === null
        );
      });


    if (!targetCell) {
      return;
    }

    const slot =
      targetCell.slot;

    this._assignedCameras[slot] =
      cameraName;

    /*
     * Only modify this slot.
     */
    this.renderSlot(slot);

    this.updateCameraListState();
    this.scheduleCameraFit();
  }


  assignCameraToSlot(cameraName, targetSlot) {
    if (this._maximizedSlot !== null) {
      return;
    }

    const camera =
      this.getCameraByName(cameraName);

    const targetCell =
      this.querySelector(
        `.video-cell[data-slot="${targetSlot}"]`
      );

    if (
      !camera ||
      camera.active !== true ||
      !Number.isInteger(targetSlot) ||
      targetSlot < 0 ||
      targetSlot >= this._assignedCameras.length ||
      !targetCell ||
      targetCell.classList.contains(
        "hidden-slot"
      )
    ) {
      return;
    }

    const sourceSlot =
      this._assignedCameras.indexOf(
        cameraName
      );

    if (sourceSlot === targetSlot) {
      return;
    }

    if (sourceSlot !== -1) {
      this._assignedCameras[sourceSlot] =
        null;
    }

    this._assignedCameras[targetSlot] =
      cameraName;

    /*
     * Targeted placement never compacts other slots.
     * Re-render only the moved camera's source and
     * the exact replacement target.
     */
    if (sourceSlot !== -1) {
      this.renderSlot(sourceSlot);
    }

    this.renderSlot(targetSlot);
    this.updateCameraListState();
    this.scheduleCameraFit();
  }


  moveCameraBetweenSlots(sourceSlot, targetSlot) {
    const sourceCell =
      this.querySelector(
        `.video-cell[data-slot="${sourceSlot}"]`
      );

    const targetCell =
      this.querySelector(
        `.video-cell[data-slot="${targetSlot}"]`
      );

    if (
      !Number.isInteger(sourceSlot) ||
      !Number.isInteger(targetSlot) ||
      sourceSlot < 0 ||
      targetSlot < 0 ||
      sourceSlot >= this._assignedCameras.length ||
      targetSlot >= this._assignedCameras.length ||
      sourceSlot === targetSlot ||
      !sourceCell ||
      !targetCell ||
      targetCell.classList.contains("hidden-slot")
    ) {
      return;
    }

    const cameraName =
      this._assignedCameras[sourceSlot];

    const camera =
      this.getCameraByName(cameraName);

    if (!camera || camera.active !== true) {
      return;
    }

    this._assignedCameras[sourceSlot] = null;
    this._assignedCameras[targetSlot] = cameraName;

    targetCell.innerHTML = "";

    sourceCell.dataset.slot =
      String(targetSlot);

    targetCell.dataset.slot =
      String(sourceSlot);

    this.updateCameraViewForCell(sourceCell);

    const number =
      sourceCell.querySelector(
        ".cell-number"
      );

    if (number) {
      number.textContent =
        String(targetSlot + 1);
    }

    this.renderSlot(sourceSlot);
    this.applyLayout();

    this.updateCameraListState();
    this.scheduleCameraFit();
  }


  removeCameraFromSlot(slot) {
    if (this._maximizedSlot !== null) {
      return;
    }

    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= this._assignedCameras.length
    ) {
      return;
    }

    if (
      this._assignedCameras[slot] === null
    ) {
      return;
    }

    this._assignedCameras[slot] = null;

    /*
     * Targeted removal intentionally leaves a hole.
     * Only the removed camera's slot is rebuilt.
     */
    this.renderSlot(slot);

    this.updateCameraListState();
  }


  repackAssignedCameras() {
    const cells =
      Array.from(
        { length: this._assignedCameras.length },
        (_, slot) => {
          return this.querySelector(
            `.video-cell[data-slot="${slot}"]`
          );
        }
      );

    if (
      cells.some(cell => !cell) ||
      new Set(cells).size !== cells.length
    ) {
      return;
    }

    const occupied = [];
    const emptyCells = [];

    this._assignedCameras.forEach(
      (cameraName, sourceSlot) => {
        const cell = cells[sourceSlot];

        if (cameraName === null) {
          emptyCells.push(cell);
          return;
        }

        occupied.push({
          cameraName,
          cell
        });
      }
    );

    const desiredMapping = [
      ...occupied.map(
        (entry, logicalSlot) => {
          return {
            cell: entry.cell,
            logicalSlot,
            cameraName: entry.cameraName
          };
        }
      ),
      ...emptyCells.map(
        (cell, emptyIndex) => {
          return {
            cell,
            logicalSlot:
              occupied.length + emptyIndex,
            cameraName: null
          };
        }
      )
    ];

    /*
     * Keep every occupied physical cell and its live
     * camera subtree connected. Only logical slot
     * identities change during compaction.
     */
    this._assignedCameras.fill(null);

    desiredMapping.forEach(entry => {
      const {
        cell,
        logicalSlot,
        cameraName
      } = entry;

      cell.dataset.slot = String(logicalSlot);
      cell.draggable = cameraName !== null;

      if (cameraName !== null) {
        this._assignedCameras[logicalSlot] =
          cameraName;

        this.updateCameraViewForCell(cell);

        const number =
          cell.querySelector(".cell-number");

        if (number) {
          number.textContent =
            String(logicalSlot + 1);
        }

        return;
      }

      let empty =
        cell.querySelector(
          ".empty-cell-center"
        );

      if (!empty) {
        empty = document.createElement("div");
        empty.className =
          "empty-cell-center";
        cell.appendChild(empty);
      }

      empty.textContent =
        String(logicalSlot + 1);
    });

  }

  
  updateCameraViewForCell(cell) {
    const image =
      cell?.querySelector("hui-image.nvr-live-camera");
    const slot = Number(cell?.dataset.slot);

    if (image && Number.isInteger(slot)) {
      image.cameraView =
        slot < NVR_DIAGNOSTIC_LIVE_SLOT_LIMIT
          ? "live"
          : "auto";
    }
  }


  renderSlot(slot) {
    const cell =
      this.querySelector(
        `.video-cell[data-slot="${slot}"]`
      );


    if (!cell) {
      return;
    }


    /*
     * Destroy ONLY this slot's contents.
     *
     * Layout changes never call this function.
     */
    cell.innerHTML = "";


    const cameraName =
      this._assignedCameras[slot];


    cell.draggable =
      Boolean(cameraName);


    /*
     * EMPTY SLOT
     */
    if (!cameraName) {

      const empty =
        document.createElement("div");


      empty.className =
        "empty-cell-center";


      empty.textContent =
        String(slot + 1);


      cell.appendChild(empty);

      return;
    }


    const camera =
      this.getCameraByName(
        cameraName
      );

    /*
     * LIVE CAMERA
     */
    if (
      camera &&
      camera.entity
    ) {

      const frame =
        document.createElement("div");


      frame.className =
        "camera-frame";


      const runtimeCameraName =
        this._hass?.states?.[camera.entity]
          ?.attributes?.camera_name;
      const stage2aStreamId =
        typeof runtimeCameraName === "string" &&
        runtimeCameraName.trim().length > 0
          ? runtimeCameraName
          : null;

      if (stage2aStreamId) {
        const presentation = document.createElement(
          "nvr-live-presentation"
        );

        presentation.className = "nvr-live-camera";
        presentation.liveConfig = {
          cameraId: camera.name,
          variantId: `${camera.name}-stage2a`,
          role: "custom",
          sourceId: stage2aStreamId
        };

        if (this._hass) {
          presentation.hass = this._hass;
        }

        frame.appendChild(presentation);
      }
      else {
        const image =
          document.createElement(
            "hui-image"
          );


        image.className =
          "nvr-live-camera";


        image.dataset.entity =
          camera.entity;


        image.cameraImage =
          camera.entity;


        image.cameraView =
          slot < NVR_DIAGNOSTIC_LIVE_SLOT_LIMIT
            ? "live"
            : "auto";


        if (this._hass) {
          image.hass =
            this._hass;
        }


        frame.appendChild(image);
      }

      cell.appendChild(frame);
    }


    /*
     * PLACEHOLDER CAMERA
     */
    else {

      const placeholder =
        document.createElement(
          "div"
        );


      placeholder.className =
        "placeholder-camera-name";


      placeholder.textContent =
        cameraName;


      cell.appendChild(
        placeholder
      );
    }


    /*
     * CAMERA NAME
     */
    const label =
      document.createElement("div");


    label.className =
      "cell-camera-name";


    label.textContent =
      cameraName;


    cell.appendChild(label);


    /*
     * SLOT NUMBER
     */
    const number =
      document.createElement("div");


    number.className =
      "cell-number";


    number.textContent =
      String(slot + 1);


    cell.appendChild(number);
  }


  /* ================================================
     FAST LAYOUT SWITCHING
     ================================================ */

  applyLayout() {
    const grid =
      this.querySelector(
        ".video-grid"
      );


    const layout =
      this.layouts[
        this._layout
      ];


    if (
      !grid ||
      !layout
    ) {
      return;
    }

    this.recordNvrFlight("layout-start");


    grid.style.gridTemplateColumns =
      layout.columns;


    grid.style.gridTemplateRows =
      layout.rows;


    /*
     * Hide every persistent slot.
     * Nothing is destroyed.
     */
    this
      .querySelectorAll(
        ".video-cell"
      )
      .forEach(cell => {

        cell.classList.add(
          "hidden-slot"
        );


        cell.style.gridColumn = "";
        cell.style.gridRow = "";
        cell.style.order =
          cell.dataset.slot;
      });


    /*
     * Reveal/reposition slots used by this layout.
     */
    layout.cells.forEach(
      cellConfig => {

        const cell =
          this.querySelector(
            `.video-cell[data-slot="${cellConfig.slot}"]`
          );


        if (!cell) {
          return;
        }


        cell.classList.remove(
          "hidden-slot"
        );


        if (cellConfig.column) {
          cell.style.gridColumn =
            cellConfig.column;
        }


        if (cellConfig.row) {
          cell.style.gridRow =
            cellConfig.row;
        }
      }
    );

    this.fitLiveCameras();
    this.recordNvrFlight("layout-end");
  }


  /* ================================================
     16:9 LETTERBOX ENGINE
     ================================================ */

  recordNvrFlight(
    event,
    slot = -1,
    cell = null,
    image = null,
    frameWidth = -1,
    frameHeight = -1,
    oldWidth = "",
    oldHeight = "",
    newWidth = "",
    newHeight = ""
  ) {
    if (!NVR_MAXIMIZE_FLIGHT_RECORDER) {
      return;
    }

    const state = NVR_FLIGHT_RECORDER_STATE;

    state.fitRequestCount +=
      event === "fit-request" ? 1 : 0;

    const media =
      NVR_MEDIA_SNAPSHOT_EVENTS.has(event)
        ? this.captureAnonymousMediaSnapshot()
        : null;

    state.records[state.index] = {
      time: performance.now(),
      event,
      instanceId: this._nvrInstanceId,
      slot,
      maximizedSlot:
        this._maximizedSlot ?? -1,
      visibility: document.visibilityState,
      cellConnected:
        cell ? cell.isConnected : null,
      imageConnected:
        image ? image.isConnected : null,
      maximizedClass:
        cell
          ? cell.classList.contains(
              "maximized-camera"
            )
          : null,
      frameWidth,
      frameHeight,
      oldWidth,
      oldHeight,
      newWidth,
      newHeight,
      fitPending: this._cameraFitFrame !== null,
      fitRequestCount: state.fitRequestCount,
      ...(media ? { media } : {})
    };

    state.index =
      (state.index + 1) %
      NVR_FLIGHT_RECORDER_SIZE;
    state.count = Math.min(
      state.count + 1,
      NVR_FLIGHT_RECORDER_SIZE
    );
  }


  getOpenMediaElements(image) {
    const elements = [image];
    const roots = [image];

    if (image.shadowRoot) {
      roots.push(image.shadowRoot);
    }

    while (roots.length > 0) {
      const root = roots.shift();

      root.querySelectorAll("*").forEach(element => {
        elements.push(element);

        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
        }
      });
    }

    return elements;
  }


  getAnonymousMediaEventState(video) {
    let state = this._mediaDiagnosticStates.get(video);

    if (state) {
      return state;
    }

    state = {
      lastWaitingTime: null,
      lastStalledTime: null,
      lastPlayingTime: null,
      latestSnapshot: null,
      activeSession: null
    };

    const update = (field, eventName) => {
      const time = performance.now();
      state[field] = time;

      if (state.latestSnapshot) {
        state.latestSnapshot[field] = time;
      }

      if (state.activeSession) {
        state.activeSession.events[eventName].push(
          time - state.activeSession.startTime
        );
      }
    };

    video.addEventListener(
      "waiting",
      () => update("lastWaitingTime", "waiting"),
      { passive: true }
    );
    video.addEventListener(
      "stalled",
      () => update("lastStalledTime", "stalled"),
      { passive: true }
    );
    video.addEventListener(
      "playing",
      () => update("lastPlayingTime", "playing"),
      { passive: true }
    );

    this._mediaDiagnosticStates.set(video, state);
    return state;
  }


  captureSafeVideoState(video) {
    let totalFrames = null;
    let droppedFrames = null;

    if (
      typeof video.getVideoPlaybackQuality ===
        "function"
    ) {
      try {
        const quality = video.getVideoPlaybackQuality();

        totalFrames = Number.isFinite(
          quality?.totalVideoFrames
        )
          ? quality.totalVideoFrames
          : null;
        droppedFrames = Number.isFinite(
          quality?.droppedVideoFrames
        )
          ? quality.droppedVideoFrames
          : null;
      } catch {
        totalFrames = null;
        droppedFrames = null;
      }
    }

    return {
      currentTime: Number.isFinite(video.currentTime)
        ? video.currentTime
        : null,
      readyState: video.readyState,
      paused: video.paused,
      ended: video.ended,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      totalFrames,
      droppedFrames
    };
  }


  recordMaximizeMediaVisibility() {
    const session = this._activeMaximizeMediaSession;

    if (!session) {
      return;
    }

    const visibility =
      document.visibilityState === "hidden"
        ? "hidden"
        : "visible";
    const previous = session.visibility.at(-1);

    if (previous?.state !== visibility) {
      session.visibility.push({
        elapsed: performance.now() - session.startTime,
        state: visibility
      });
    }
  }


  sampleMaximizeMediaSession() {
    const session = this._activeMaximizeMediaSession;

    if (!session) {
      return;
    }

    if (!session.video.isConnected) {
      this.completeMaximizeMediaSession("disconnected");
      return;
    }

    const elapsed = performance.now() - session.startTime;

    if (elapsed >= NVR_MAXIMIZE_MEDIA_SAMPLE_DURATION) {
      this.completeMaximizeMediaSession("duration");
      return;
    }

    session.samples.push({
      elapsed,
      ...this.captureSafeVideoState(session.video)
    });
  }


  completeMaximizeMediaSession(reason) {
    const session = this._activeMaximizeMediaSession;

    if (!session) {
      return;
    }

    window.clearInterval(session.intervalId);
    session.eventState.activeSession = null;
    this._activeMaximizeMediaSession = null;

    const completed = {
      sessionId: session.sessionId,
      slot: session.slot,
      startTime: session.startTime,
      completionReason: reason,
      completionTime: performance.now(),
      samples: session.samples,
      events: session.events,
      visibility: session.visibility
    };
    const history =
      NVR_FLIGHT_RECORDER_STATE.mediaSessions;

    history.push(completed);

    if (history.length > NVR_MAXIMIZE_MEDIA_SESSION_LIMIT) {
      history.splice(
        0,
        history.length - NVR_MAXIMIZE_MEDIA_SESSION_LIMIT
      );
    }
  }


  startMaximizeMediaSession(slot, image) {
    this.completeMaximizeMediaSession("replaced");

    const video = this.getOpenMediaElements(image)
      .find(element => element.localName === "video");

    if (!video) {
      return;
    }

    const startTime = performance.now();
    const eventState =
      this.getAnonymousMediaEventState(video);
    const session = {
      sessionId:
        NVR_FLIGHT_RECORDER_STATE.nextMediaSessionId++,
      slot,
      startTime,
      video,
      eventState,
      intervalId: null,
      samples: [],
      events: {
        waiting: [],
        stalled: [],
        playing: []
      },
      visibility: [{
        elapsed: 0,
        state:
          document.visibilityState === "hidden"
            ? "hidden"
            : "visible"
      }]
    };

    this._activeMaximizeMediaSession = session;
    eventState.activeSession = session;
    this.sampleMaximizeMediaSession();

    if (this._activeMaximizeMediaSession !== session) {
      return;
    }

    session.intervalId = window.setInterval(
      () => this.sampleMaximizeMediaSession(),
      NVR_MAXIMIZE_MEDIA_SAMPLE_INTERVAL
    );
  }


  captureAnonymousMediaSnapshot() {
    return Array.from(
      this.querySelectorAll(".video-cell"),
      cell => {
        const slot = Number(cell.dataset.slot);
        const image = cell.querySelector(
          "hui-image.nvr-live-camera, nvr-live-presentation.nvr-live-camera"
        );

        if (!Number.isInteger(slot) || !image) {
          return null;
        }

        const elements = this.getOpenMediaElements(image);
        const tags = new Set(
          elements.map(element => element.localName)
        );
        const hasCameraStream =
          tags.has("ha-camera-stream");
        const video = elements.find(
          element => element.localName === "video"
        );
        let transport = "none";

        if (hasCameraStream) {
          if (tags.has("ha-hls-player")) {
            transport = "hls";
          } else if (tags.has("ha-web-rtc-player")) {
            transport = "webrtc";
          } else if (
            tags.has("ha-camera-image") ||
            tags.has("img")
          ) {
            transport = "mjpeg";
          } else {
            transport = "unknown";
          }
        }

        const snapshot = {
          slot,
          transport,
          hasVideo: Boolean(video)
        };

        if (video) {
          const eventState =
            this.getAnonymousMediaEventState(video);

          Object.assign(snapshot, {
            ...this.captureSafeVideoState(video),
            lastWaitingTime: eventState.lastWaitingTime,
            lastStalledTime: eventState.lastStalledTime,
            lastPlayingTime: eventState.lastPlayingTime
          });

          eventState.latestSnapshot = snapshot;
        }

        return snapshot;
      }
    )
      .filter(Boolean)
      .sort((left, right) => left.slot - right.slot);
  }


  dumpNvrFlightRecorder() {
    return window.dumpNvrFlightRecorder();
  }


  clearNvrFlightRecorder() {
    if (!NVR_MAXIMIZE_FLIGHT_RECORDER) {
      return;
    }

    NVR_FLIGHT_RECORDER_STATE.records.fill(undefined);
    NVR_FLIGHT_RECORDER_STATE.index = 0;
    NVR_FLIGHT_RECORDER_STATE.count = 0;
    NVR_FLIGHT_RECORDER_STATE.fitRequestCount = 0;
  }


  logMaximizeDiagnostic(eventName, details = {}) {
    if (!NVR_MAXIMIZE_DIAGNOSTICS) {
      return;
    }

    console.debug(
      "[NVR maximize diagnostic]",
      {
        timestamp: new Date().toISOString(),
        timeMs: Number(performance.now().toFixed(1)),
        event: eventName,
        ...details
      }
    );
  }


  getDiagnosticDimensions(element) {
    if (!NVR_MAXIMIZE_DIAGNOSTICS || !element) {
      return null;
    }

    const rect = element.getBoundingClientRect();

    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }


  getMaximizeDiagnosticSnapshot(
    slot = this._maximizedSlot
  ) {
    if (!NVR_MAXIMIZE_DIAGNOSTICS) {
      return {};
    }

    const grid = this.querySelector(".video-grid");
    const shell = this.querySelector(".nvr-shell");
    const cell = Number.isInteger(slot)
      ? this.querySelector(
          `.video-cell[data-slot="${slot}"]`
        )
      : null;
    const frame =
      cell?.querySelector(".camera-frame") ?? null;
    const image =
      frame?.querySelector(
        "hui-image.nvr-live-camera"
      ) ?? null;

    const hiddenSiblingCount = cell
      ? [...this.querySelectorAll(".video-cell")]
          .filter(candidate => {
            return (
              candidate !== cell &&
              !candidate.classList.contains(
                "hidden-slot"
              )
            );
          })
          .length
      : 0;

    return {
      slot: Number.isInteger(slot) ? slot : null,
      grid: this.getDiagnosticDimensions(grid),
      cell: this.getDiagnosticDimensions(cell),
      frame: this.getDiagnosticDimensions(frame),
      image: this.getDiagnosticDimensions(image),
      imageInlineWidth: image?.style.width || "",
      imageInlineHeight: image?.style.height || "",
      imageConnected: image?.isConnected ?? false,
      hiddenSiblingCount,
      phoneLayout:
        shell?.classList.contains("phone-layout") ?? false,
      sidebarCollapsed:
        shell?.classList.contains(
          "sidebar-collapsed"
        ) ?? false,
      gridMaximized:
        grid?.classList.contains(
          "camera-maximized"
        ) ?? false
    };
  }


  findAccessibleVideoElement(image) {
    if (!NVR_MAXIMIZE_DIAGNOSTICS || !image) {
      return null;
    }

    const roots = [];

    if (image.shadowRoot) {
      roots.push(image.shadowRoot);
    }

    while (roots.length > 0) {
      const root = roots.shift();
      const video = root.querySelector("video");

      if (video) {
        return video;
      }

      root.querySelectorAll("*").forEach(element => {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
        }
      });
    }

    return null;
  }


  observeAccessibleMedia(image, slot) {
    if (
      !NVR_MAXIMIZE_DIAGNOSTICS ||
      !image ||
      this._diagnosticMediaChecked.has(image)
    ) {
      return;
    }

    this._diagnosticMediaChecked.add(image);

    const video = this.findAccessibleVideoElement(image);

    if (!video) {
      this.logMaximizeDiagnostic(
        "media-unavailable",
        { slot }
      );
      return;
    }

    const logMediaState = eventName => {
      this.logMaximizeDiagnostic(
        `media-${eventName}`,
        {
          slot,
          currentTime: Number(
            video.currentTime.toFixed(3)
          ),
          readyState: video.readyState,
          paused: video.paused
        }
      );
    };

    [
      "waiting",
      "stalled",
      "playing",
      "timeupdate"
    ].forEach(eventName => {
      video.addEventListener(
        eventName,
        () => logMediaState(eventName)
      );
    });

    logMediaState("attached");
  }


  fitLiveCameras(diagnosticSource = "synchronous") {
    const CAMERA_RATIO =
      this._cameraAspectRatio;

    this.recordNvrFlight("fit-start");

    this.logMaximizeDiagnostic(
      "fit-start",
      {
        source: diagnosticSource,
        ...this.getMaximizeDiagnosticSnapshot()
      }
    );


    this
      .querySelectorAll(
        ".video-cell:not(.hidden-slot) .camera-frame"
      )
      .forEach(frame => {

        const image =
          frame.querySelector(
            "hui-image.nvr-live-camera"
          );


        if (!image) {
          return;
        }

        const flightSlot =
          NVR_MAXIMIZE_FLIGHT_RECORDER
            ? Number(frame.parentElement?.dataset.slot)
            : -1;
        const flightOldWidth =
          NVR_MAXIMIZE_FLIGHT_RECORDER
            ? image.style.width
            : "";
        const flightOldHeight =
          NVR_MAXIMIZE_FLIGHT_RECORDER
            ? image.style.height
            : "";

        const diagnostic = NVR_MAXIMIZE_DIAGNOSTICS
          ? {
              slot: Number(
                frame.closest(".video-cell")
                  ?.dataset.slot
              ),
              oldWidth: image.style.width,
              oldHeight: image.style.height
            }
          : null;

        if (diagnostic) {
          this.observeAccessibleMedia(
            image,
            diagnostic.slot
          );
        }


        const width =
          frame.clientWidth;


        const height =
          frame.clientHeight;


        if (
          width <= 0 ||
          height <= 0
        ) {
          this.recordNvrFlight(
            "fit-skip",
            flightSlot,
            frame.parentElement,
            image,
            width,
            height,
            flightOldWidth,
            flightOldHeight
          );
          return;
        }


        const cellRatio =
          width / height;


        let targetWidth;
        let targetHeight;


        /*
         * Cell too wide:
         * pillarbox left/right.
         */
        if (
          cellRatio >
          CAMERA_RATIO
        ) {

          targetHeight =
            height;


          targetWidth =
            height *
            CAMERA_RATIO;
        }


        /*
         * Cell too tall:
         * letterbox top/bottom.
         */
        else {

          targetWidth =
            width;


          targetHeight =
            width /
            CAMERA_RATIO;
        }


        const maximizedFit =
          this._maximizedPlayerFit;
        const maximizeScale =
          maximizedFit?.image === image &&
          frame.parentElement?.classList.contains(
            "maximized-camera"
          )
            ? Math.min(
                targetWidth / maximizedFit.width,
                targetHeight / maximizedFit.height
              )
            : null;

        if (
          Number.isFinite(maximizeScale) &&
          maximizeScale > 0
        ) {
          image.style.transform =
            `scale(${maximizeScale})`;
          image.style.transformOrigin = "center";
        } else {
          image.style.width =
            `${Math.floor(
              targetWidth
            )}px`;


          image.style.height =
            `${Math.floor(
              targetHeight
            )}px`;
        }

        this.recordNvrFlight(
          "fit-image",
          flightSlot,
          frame.parentElement,
          image,
          width,
          height,
          flightOldWidth,
          flightOldHeight,
          image.style.width,
          image.style.height
        );

        if (diagnostic) {
          this.logMaximizeDiagnostic(
            "fit-image",
            {
              source: diagnosticSource,
              slot: Number.isInteger(diagnostic.slot)
                ? diagnostic.slot
                : null,
              frame: {
                width: Math.round(width),
                height: Math.round(height)
              },
              image: this.getDiagnosticDimensions(image),
              oldInlineWidth: diagnostic.oldWidth,
              oldInlineHeight: diagnostic.oldHeight,
              newInlineWidth: image.style.width,
              newInlineHeight: image.style.height,
              imageConnected: image.isConnected
            }
          );
        }
      });

    this.recordNvrFlight("fit-end");

    this.logMaximizeDiagnostic(
      "fit-end",
      {
        source: diagnosticSource,
        ...this.getMaximizeDiagnosticSnapshot()
      }
    );
  }


  scheduleCameraFit() {
    this.recordNvrFlight("fit-request");

    this.logMaximizeDiagnostic(
      "schedule-fit-request",
      {
        coalesced: this._cameraFitFrame !== null,
        ...this.getMaximizeDiagnosticSnapshot()
      }
    );

    if (this._cameraFitFrame !== null) {
      return;
    }

    this._cameraFitFrame =
      requestAnimationFrame(() => {
        this._cameraFitFrame = null;
        this.recordNvrFlight("fit-execution");
        this.logMaximizeDiagnostic(
          "schedule-fit-execution",
          this.getMaximizeDiagnosticSnapshot()
        );
        this.fitLiveCameras("scheduled");
      });
  }


  maximizeCameraSlot(slot) {
    if (
      this._maximizedSlot !== null ||
      !Number.isInteger(slot) ||
      this._assignedCameras[slot] === null
    ) {
      return;
    }

    const grid =
      this.querySelector(".video-grid");

    const cell =
      this.querySelector(
        `.video-cell[data-slot="${slot}"]`
      );

    if (
      !grid ||
      !cell ||
      cell.classList.contains("hidden-slot")
    ) {
      return;
    }

    this.recordNvrFlight(
      "maximize-start",
      slot,
      cell
    );

    this.logMaximizeDiagnostic(
      "maximize-handler-start",
      this.getMaximizeDiagnosticSnapshot(slot)
    );

    this.closeCameraContextMenu();
    this.setCameraDropTarget(null);
    this.setLayoutDropFeedback(false);

    const presentation = cell.querySelector(
      "hui-image.nvr-live-camera, nvr-live-presentation.nvr-live-camera"
    );
    const image = cell.querySelector(
      "hui-image.nvr-live-camera"
    );
    const fittedWidth = Number.parseFloat(
      image?.style.width ?? ""
    );
    const fittedHeight = Number.parseFloat(
      image?.style.height ?? ""
    );

    this._maximizedPlayerFit =
      image &&
      Number.isFinite(fittedWidth) &&
      fittedWidth > 0 &&
      Number.isFinite(fittedHeight) &&
      fittedHeight > 0
        ? {
            image,
            width: fittedWidth,
            height: fittedHeight
          }
        : null;

    this._maximizedSlot = slot;
    grid.classList.add("camera-maximized");
    cell.classList.add("maximized-camera");

    this.recordNvrFlight(
      "maximize-classes-applied",
      slot,
      cell
    );

    if (
      presentation?.localName === "nvr-live-presentation" ||
      presentation?.cameraView === "live"
    ) {
      this.startMaximizeMediaSession(slot, presentation);
    }

    this.scheduleCameraFit();
    this.logMaximizeDiagnostic(
      "maximize-handler-end",
      this.getMaximizeDiagnosticSnapshot(slot)
    );
  }


  replaceMaximizedCamera(cameraName) {
    const slot = this._maximizedSlot;
    const camera = this.getCameraByName(cameraName);

    const cell =
      this.querySelector(
        `.video-cell[data-slot="${slot}"]`
      );

    if (
      slot === null ||
      !camera ||
      camera.active !== true ||
      !cell ||
      !cell.classList.contains(
        "maximized-camera"
      )
    ) {
      return;
    }

    const existingSlot =
      this._assignedCameras.indexOf(cameraName);

    if (existingSlot === slot) {
      return;
    }

    if (existingSlot !== -1) {
      this.moveCameraBetweenSlots(
        existingSlot,
        slot
      );

      const movedCell =
        this.querySelector(
          `.video-cell[data-slot="${slot}"]`
        );

      if (
        this._assignedCameras[slot] !== cameraName ||
        !movedCell
      ) {
        return;
      }

      movedCell.classList.add(
        "maximized-camera"
      );

      cell.classList.remove(
        "maximized-camera"
      );

      this.fitLiveCameras(
        "maximize-replacement-synchronous"
      );
      this.scheduleCameraFit();
      return;
    }

    this._assignedCameras[slot] = cameraName;
    this.renderSlot(slot);
    this.updateCameraListState();
    this.fitLiveCameras(
      "maximize-replacement-synchronous"
    );
    this.scheduleCameraFit();
  }


  restoreMaximizedCamera() {
    if (this._maximizedSlot === null) {
      return;
    }

    const maximizedSlot = this._maximizedSlot;

    if (this._maximizedPlayerFit) {
      this._maximizedPlayerFit.image.style.transform = "";
      this._maximizedPlayerFit.image.style.transformOrigin = "";
      this._maximizedPlayerFit = null;
    }

    this.recordNvrFlight(
      "restore-start",
      maximizedSlot
    );

    this.logMaximizeDiagnostic(
      "restore-handler-start",
      this.getMaximizeDiagnosticSnapshot(
        maximizedSlot
      )
    );

    const grid =
      this.querySelector(".video-grid");

    if (grid) {
      grid.classList.remove("camera-maximized");
    }

    this
      .querySelectorAll(
        ".video-cell.maximized-camera"
      )
      .forEach(cell => {
        cell.classList.remove(
          "maximized-camera"
        );
        this.recordNvrFlight(
          "restore-classes-removed",
          Number(cell.dataset.slot),
          cell
        );
      });

    this._maximizedSlot = null;
    this.applyLayout();
    this.scheduleCameraFit();
    this.logMaximizeDiagnostic(
      "restore-handler-end",
      this.getMaximizeDiagnosticSnapshot(
        maximizedSlot
      )
    );
  }


  /* ================================================
     EVENT HANDLERS
     ================================================ */

  attachCameraHandlers() {
    this
      .querySelectorAll(
        ".camera-item"
      )
      .forEach(button => {

        button.addEventListener(
          "click",
          () => {
            this.toggleCameraTargetSelection(
              button.dataset.camera
            );
          }
        );
      });
  }


  toggleCameraTargetSelection(cameraName) {
    const camera =
      this.getCameraByName(cameraName);

    if (
      !camera ||
      camera.active !== true
    ) {
      return;
    }

    this.clearLayoutTargetSelection();

    this._selectedCamera =
      this._selectedCamera === cameraName
        ? null
        : cameraName;

    this.updateCameraListState();
  }


  clearCameraTargetSelection() {
    if (this._selectedCamera === null) {
      return;
    }

    this._selectedCamera = null;
    this.updateCameraListState();
  }


  toggleLayoutTargetSelection(layoutKey) {
    if (!this.layouts[layoutKey]) {
      return;
    }

    this.clearCameraTargetSelection();

    this._selectedLayout =
      this._selectedLayout === layoutKey
        ? null
        : layoutKey;

    this.updateSelectedButton();
  }


  clearLayoutTargetSelection() {
    if (this._selectedLayout === null) {
      return;
    }

    this._selectedLayout = null;
    this.updateSelectedButton();
  }


  attachCameraDragHandlers() {
    this
      .querySelectorAll(".camera-item")
      .forEach(item => {
        item.addEventListener(
          "dragstart",
          event => {
            const cameraName =
              item.dataset.camera;

            const camera =
              this.getCameraByName(cameraName);

            if (
              !event.dataTransfer ||
              !camera ||
              camera.active !== true
            ) {
              event.preventDefault();
              return;
            }

            this.closeCameraContextMenu();
            this.clearLayoutTargetSelection();

            event.dataTransfer.effectAllowed =
              "move";

            event.dataTransfer.setData(
              NVR_CAMERA_DRAG_TYPE,
              cameraName
            );

            item.classList.add("dragging");
          }
        );

        item.addEventListener(
          "dragend",
          () => {
            item.classList.remove("dragging");
            this.setCameraDropTarget(null);
          }
        );
      });

    this
      .querySelectorAll(".video-cell")
      .forEach(cell => {
        cell.addEventListener(
          "dragstart",
          event => {
            if (this._maximizedSlot !== null) {
              event.preventDefault();
              return;
            }

            const sourceSlot =
              Number(cell.dataset.slot);

            const cameraName =
              this._assignedCameras[sourceSlot];

            if (
              !event.dataTransfer ||
              !Number.isInteger(sourceSlot) ||
              !cameraName
            ) {
              event.preventDefault();
              return;
            }

            this.closeCameraContextMenu();
            this.clearLayoutTargetSelection();

            event.dataTransfer.effectAllowed =
              "move";

            event.dataTransfer.setData(
              NVR_GRID_CAMERA_DRAG_TYPE,
              String(sourceSlot)
            );
          }
        );

        cell.addEventListener(
          "dragend",
          () => {
            this.setCameraDropTarget(null);
          }
        );

        cell.addEventListener(
          "dragenter",
          event => {
            if (this._maximizedSlot !== null) {
              if (
                this.isCameraListDrag(event) &&
                cell.classList.contains(
                  "maximized-camera"
                )
              ) {
                event.preventDefault();
                this.setCameraDropTarget(cell);
              }

              return;
            }

            if (
              !this.isCameraDrag(event) ||
              cell.classList.contains(
                "hidden-slot"
              )
            ) {
              return;
            }

            event.preventDefault();
            this.setCameraDropTarget(cell);
          }
        );

        cell.addEventListener(
          "dragover",
          event => {
            if (this._maximizedSlot !== null) {
              if (
                this.isCameraListDrag(event) &&
                cell.classList.contains(
                  "maximized-camera"
                )
              ) {
                event.preventDefault();
                event.dataTransfer.dropEffect =
                  "move";
                this.setCameraDropTarget(cell);
              }

              return;
            }

            if (
              !this.isCameraDrag(event) ||
              cell.classList.contains(
                "hidden-slot"
              )
            ) {
              return;
            }

            event.preventDefault();
            event.dataTransfer.dropEffect =
              "move";

            this.setCameraDropTarget(cell);
          }
        );

        cell.addEventListener(
          "dragleave",
          event => {
            if (
              event.relatedTarget &&
              cell.contains(event.relatedTarget)
            ) {
              return;
            }

            cell.classList.remove(
              "camera-drop-target"
            );
          }
        );

        cell.addEventListener(
          "drop",
          event => {
            if (this._maximizedSlot !== null) {
              if (
                this.isCameraListDrag(event) &&
                cell.classList.contains(
                  "maximized-camera"
                )
              ) {
                event.preventDefault();

                const cameraName =
                  event.dataTransfer.getData(
                    NVR_CAMERA_DRAG_TYPE
                  );

                this.replaceMaximizedCamera(
                  cameraName
                );
              }

              this.setCameraDropTarget(null);
              return;
            }

            if (
              !this.isCameraDrag(event) ||
              cell.classList.contains(
                "hidden-slot"
              )
            ) {
              return;
            }

            event.preventDefault();
            this.setCameraDropTarget(null);

            const cameraName =
              event.dataTransfer.getData(
                NVR_CAMERA_DRAG_TYPE
              );

            const sourceSlotValue =
              event.dataTransfer.getData(
                NVR_GRID_CAMERA_DRAG_TYPE
              );

            const targetSlot =
              Number(cell.dataset.slot);

            if (sourceSlotValue !== "") {
              this.moveCameraBetweenSlots(
                Number(sourceSlotValue),
                targetSlot
              );
            }
            else {
              this.assignCameraToSlot(
                cameraName,
                targetSlot
              );
            }

            this.clearCameraTargetSelection();
          }
        );
      });
  }


  isCameraDrag(event) {
    if (!event.dataTransfer) {
      return false;
    }

    const types =
      Array.from(event.dataTransfer.types);

    return (
      types.includes(NVR_CAMERA_DRAG_TYPE) ||
      types.includes(NVR_GRID_CAMERA_DRAG_TYPE)
    );
  }


  setCameraDropTarget(targetCell) {
    this
      .querySelectorAll(
        ".video-cell.camera-drop-target"
      )
      .forEach(cell => {
        cell.classList.remove(
          "camera-drop-target"
        );
      });

    if (targetCell) {
      targetCell.classList.add(
        "camera-drop-target"
      );
    }
  }


  attachSidebarHandlers() {
    const sidebar =
      this.querySelector(".nvr-sidebar");

    if (!sidebar) {
      return;
    }

    sidebar.addEventListener(
      "click",
      event => {
        const header =
          event.target.closest(
            ".sidebar-section-header"
          );

        if (!header) {
          return;
        }

        this.toggleSidebarSection(
          header.dataset.section
        );
      }
    );
  }


  attachSidebarToggleHandler() {
    const button =
      this.querySelector(".sidebar-toggle");

    if (!button) {
      return;
    }

    button.addEventListener("click", () => {
      const shell =
        this.querySelector(".nvr-shell");

      if (!shell) {
        return;
      }

      this._sidebarCollapsed =
        !shell.classList.contains(
          "sidebar-collapsed"
        );

      this.updateResponsiveShell();
      this.scheduleCameraFit();
    });
  }


  updateResponsiveShell() {
    const shell =
      this.querySelector(".nvr-shell");

    const sidebar =
      this.querySelector(".nvr-sidebar");

    const button =
      this.querySelector(".sidebar-toggle");

    if (!shell || !sidebar || !button) {
      return;
    }

    const phoneLayout =
      shell.clientWidth <= 600;

    const collapsed =
      this._sidebarCollapsed === null
        ? phoneLayout
        : this._sidebarCollapsed;

    shell.classList.toggle(
      "phone-layout",
      phoneLayout
    );

    shell.classList.toggle(
      "sidebar-collapsed",
      collapsed
    );

    sidebar.setAttribute(
      "aria-hidden",
      String(collapsed)
    );

    button.setAttribute(
      "aria-expanded",
      String(!collapsed)
    );

    button.setAttribute(
      "aria-label",
      collapsed
        ? "Expand sidebar"
        : "Collapse sidebar"
    );

    button.setAttribute(
      "title",
      collapsed
        ? "Expand sidebar"
        : "Collapse sidebar"
    );
  }


  toggleSidebarSection(sectionName) {
    if (
      !Object.prototype.hasOwnProperty.call(
        this._sidebarSections,
        sectionName
      )
    ) {
      return;
    }

    const expanded =
      !this._sidebarSections[sectionName];

    this._sidebarSections[sectionName] =
      expanded;

    const section =
      this.querySelector(
        `.sidebar-section[data-section="${sectionName}"]`
      );

    if (!section) {
      return;
    }

    const header =
      section.querySelector(
        ".sidebar-section-header"
      );

    const body =
      section.querySelector(
        ".sidebar-section-body"
      );

    section.classList.toggle(
      "expanded",
      expanded
    );

    if (header) {
      header.setAttribute(
        "aria-expanded",
        String(expanded)
      );
    }

    if (body) {
      body.hidden = !expanded;
    }

  }


  attachLayoutHandlers() {
    this
      .querySelectorAll(
        ".sidebar-layout-item"
      )
      .forEach(button => {

        button.addEventListener(
          "click",
          () => {
            this.toggleLayoutTargetSelection(
              button.dataset.layout
            );
          }
        );
      });
  }


  selectLayout(layoutKey) {
    if (this._maximizedSlot !== null) {
      return;
    }

    if (!this.layouts[layoutKey]) {
      return;
    }

    this.closeCameraContextMenu();
    this.clearCameraTargetSelection();
    this.repackAssignedCameras();

    this._layout = layoutKey;
    this._selectedLayout = null;

    /*
     * No grid rebuild.
     * No stream recreation.
     */
    this.applyLayout();
    this.updateCameraListState();
    this.updateSelectedButton();
  }


  attachLayoutDragHandlers() {
    this
      .querySelectorAll(
        ".sidebar-layout-item"
      )
      .forEach(item => {
        item.addEventListener(
          "dragstart",
          event => {
            const layoutKey =
              item.dataset.layout;

            if (
              !event.dataTransfer ||
              !this.layouts[layoutKey]
            ) {
              event.preventDefault();
              return;
            }

            this.closeCameraContextMenu();
            this.clearCameraTargetSelection();

            event.dataTransfer.effectAllowed =
              "copy";

            event.dataTransfer.setData(
              NVR_LAYOUT_DRAG_TYPE,
              layoutKey
            );

            item.classList.add("dragging");
          }
        );

        item.addEventListener(
          "dragend",
          () => {
            item.classList.remove("dragging");
            this.setLayoutDropFeedback(false);
          }
        );
      });

    const grid =
      this.querySelector(".video-grid");

    if (!grid) {
      return;
    }

    grid.addEventListener(
      "dragenter",
      event => {
        if (!this.isLayoutDrag(event)) {
          return;
        }

        event.preventDefault();
        this.setLayoutDropFeedback(true);
      }
    );

    grid.addEventListener(
      "dragover",
      event => {
        if (!this.isLayoutDrag(event)) {
          return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        this.setLayoutDropFeedback(true);
      }
    );

    grid.addEventListener(
      "dragleave",
      event => {
        if (
          event.relatedTarget &&
          grid.contains(event.relatedTarget)
        ) {
          return;
        }

        this.setLayoutDropFeedback(false);
      }
    );

    grid.addEventListener(
      "drop",
      event => {
        if (this._maximizedSlot !== null) {
          if (!this.isLayoutDrag(event)) {
            return;
          }

          event.preventDefault();
          this.setLayoutDropFeedback(false);

          const layoutKey =
            event.dataTransfer.getData(
              NVR_LAYOUT_DRAG_TYPE
            );

          if (!this.layouts[layoutKey]) {
            return;
          }

          this.restoreMaximizedCamera();
          this.selectLayout(layoutKey);
          return;
        }

        if (!this.isLayoutDrag(event)) {
          return;
        }

        event.preventDefault();
        this.setLayoutDropFeedback(false);

        const layoutKey =
          event.dataTransfer.getData(
            NVR_LAYOUT_DRAG_TYPE
          );

        if (!this.layouts[layoutKey]) {
          return;
        }

        this.selectLayout(layoutKey);
      }
    );
  }


  isLayoutDrag(event) {
    if (!event.dataTransfer) {
      return false;
    }

    return Array
      .from(event.dataTransfer.types)
      .includes(NVR_LAYOUT_DRAG_TYPE);
  }


  setLayoutDropFeedback(active) {
    const grid =
      this.querySelector(".video-grid");

    if (grid) {
      grid.classList.toggle(
        "layout-drop-target",
        active
      );
    }
  }


  attachSlotHandlers() {
    const grid =
      this.querySelector(".video-grid");

    if (!grid) {
      return;
    }

    grid.addEventListener(
      "click",
      event => {
        if (this._maximizedSlot !== null) {
          event.preventDefault();
          return;
        }

        if (this._selectedLayout !== null) {
          this.selectLayout(
            this._selectedLayout
          );
          return;
        }

        if (this._selectedCamera === null) {
          return;
        }

        const cell =
          event.target.closest(".video-cell");

        if (
          !cell ||
          cell.classList.contains(
            "hidden-slot"
          )
        ) {
          return;
        }

        const slot =
          Number(cell.dataset.slot);

        this.assignCameraToSlot(
          this._selectedCamera,
          slot
        );

        this.clearCameraTargetSelection();
      }
    );
  }


  isCameraListDrag(event) {
    if (!event.dataTransfer) {
      return false;
    }

    const types =
      Array.from(event.dataTransfer.types);

    return (
      types.includes(NVR_CAMERA_DRAG_TYPE) &&
      !types.includes(NVR_GRID_CAMERA_DRAG_TYPE)
    );
  }


  attachCameraMaximizeHandlers() {
    const grid =
      this.querySelector(".video-grid");

    if (!grid) {
      return;
    }

    grid.addEventListener(
      "click",
      event => {
        if (
          this._maximizedSlot === null &&
          event.detail === 1
        ) {
          this._placementClickPending =
            this._selectedCamera !== null ||
            this._selectedLayout !== null;
        }
      },
      true
    );

    grid.addEventListener(
      "dblclick",
      event => {
        const cell =
          event.composedPath().find(node => {
            return (
              node instanceof Element &&
              node.classList.contains(
                "video-cell"
              )
            );
          });

        if (!cell) {
          return;
        }

        const slot = Number(cell.dataset.slot);

        if (this._maximizedSlot !== null) {
          event.preventDefault();

          if (
            slot === this._maximizedSlot &&
            cell.classList.contains(
              "maximized-camera"
            )
          ) {
            this.restoreMaximizedCamera();
          }

          return;
        }

        if (
          this._placementClickPending ||
          this._selectedCamera !== null ||
          this._selectedLayout !== null ||
          !Number.isInteger(slot) ||
          this._assignedCameras[slot] === null
        ) {
          this._placementClickPending = false;
          return;
        }

        this._placementClickPending = false;
        event.preventDefault();
        this.maximizeCameraSlot(slot);
      }
    );
  }


  attachCameraContextMenuHandlers() {
    this
      .querySelectorAll(".video-cell")
      .forEach(cell => {
        cell.addEventListener(
          "contextmenu",
          event => {
            if (this._maximizedSlot !== null) {
              event.preventDefault();
              this.closeCameraContextMenu();
              return;
            }

            const slot =
              Number(cell.dataset.slot);

            if (
              !Number.isInteger(slot) ||
              this._assignedCameras[slot] === null
            ) {
              this.closeCameraContextMenu();
              return;
            }

            event.preventDefault();

            this.openCameraContextMenu(
              slot,
              event.clientX,
              event.clientY
            );
          }
        );
      });

    const command =
      this.querySelector(
        ".camera-context-command"
      );

    if (command) {
      command.addEventListener(
        "click",
        () => {
          if (this._maximizedSlot !== null) {
            this.closeCameraContextMenu();
            return;
          }

          const slot =
            this._cameraContextSlot;

          this.closeCameraContextMenu();

          if (slot !== null) {
            this.removeCameraFromSlot(slot);
          }
        }
      );
    }
  }


  openCameraContextMenu(
    slot,
    clientX,
    clientY
  ) {
    const card =
      this.querySelector("ha-card");

    const menu =
      this.querySelector(
        ".camera-context-menu"
      );

    if (!card || !menu) {
      return;
    }

    this.closeCameraContextMenu();
    this.clearCameraTargetSelection();
    this.clearLayoutTargetSelection();

    this._cameraContextSlot = slot;
    menu.hidden = false;

    const cardRect =
      card.getBoundingClientRect();

    const margin = 4;

    const left = Math.max(
      margin,
      Math.min(
        clientX - cardRect.left,
        cardRect.width - menu.offsetWidth - margin
      )
    );

    const top = Math.max(
      margin,
      Math.min(
        clientY - cardRect.top,
        cardRect.height - menu.offsetHeight - margin
      )
    );

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    document.addEventListener(
      "pointerdown",
      this._cameraContextPointerHandler,
      true
    );

    document.addEventListener(
      "keydown",
      this._cameraContextKeyHandler
    );
  }


  closeCameraContextMenu() {
    const menu =
      this.querySelector(
        ".camera-context-menu"
      );

    if (menu) {
      menu.hidden = true;
    }

    this._cameraContextSlot = null;

    document.removeEventListener(
      "pointerdown",
      this._cameraContextPointerHandler,
      true
    );

    document.removeEventListener(
      "keydown",
      this._cameraContextKeyHandler
    );
  }


  /* ================================================
     HA STREAM UPDATES
     ================================================ */

  updateLiveStreams() {
    if (!this._hass) {
      return;
    }


    this
      .querySelectorAll(
        "hui-image.nvr-live-camera, nvr-live-presentation.nvr-live-camera"
      )
      .forEach(presentation => {

        presentation.hass =
          this._hass;
      });
  }


  /* ================================================
     RESIZE HANDLING
     ================================================ */

  installViewportListeners() {
    if (this._viewportListenersInstalled) {
      return;
    }

    window.addEventListener(
      "resize",
      this._viewportResizeHandler
    );

    if (NVR_MAXIMIZE_FLIGHT_RECORDER) {
      document.addEventListener(
        "visibilitychange",
        this._nvrVisibilityHandler
      );
    }

    if (window.visualViewport) {
      window.visualViewport.addEventListener(
        "resize",
        this._viewportResizeHandler
      );
    }

    this._viewportListenersInstalled = true;
    this._viewportResizeHandler();
  }


  removeViewportListeners() {
    if (!this._viewportListenersInstalled) {
      return;
    }

    window.removeEventListener(
      "resize",
      this._viewportResizeHandler
    );

    if (NVR_MAXIMIZE_FLIGHT_RECORDER) {
      document.removeEventListener(
        "visibilitychange",
        this._nvrVisibilityHandler
      );
    }

    if (window.visualViewport) {
      window.visualViewport.removeEventListener(
        "resize",
        this._viewportResizeHandler
      );
    }

    this._viewportListenersInstalled = false;
  }


  updateAvailableHeight() {
    const card = this.querySelector("ha-card");

    if (!card) {
      return;
    }

    const viewport = window.visualViewport;
    const viewportHeight =
      viewport
        ? viewport.height
        : window.innerHeight;

    const viewportTop =
      viewport ? viewport.offsetTop : 0;

    const cardTop =
      card.getBoundingClientRect().top;

    const availableHeight = Math.max(
      0,
      viewportHeight -
        Math.max(0, cardTop - viewportTop)
    );

    card.style.setProperty(
      "--nvr-card-top",
      `${Math.max(0, cardTop)}px`
    );

    card.style.setProperty(
      "--nvr-card-available-height",
      `${Math.floor(availableHeight)}px`
    );
  }

  installResizeObserver() {
    if (
      this._resizeObserver
    ) {

      this._resizeObserver.disconnect();
    }


    const grid =
      this.querySelector(
        ".video-grid"
      );

    const card = this.querySelector("ha-card");


    if (!grid) {
      return;
    }

    this._resizeObserver =
      new ResizeObserver(entries => {
        this.recordNvrFlight("resize-observer");
        this.logMaximizeDiagnostic(
          "card-resize-observer",
          {
            entryCount: entries.length,
            ...this.getMaximizeDiagnosticSnapshot()
          }
        );
        this.updateResponsiveShell();
        this.scheduleCameraFit();
      });

    this._resizeObserver.observe(
      grid
    );

    if (card) {
      this._resizeObserver.observe(card);
    }
  }


  /* ================================================
     UI STATE
     ================================================ */

  updateCameraStatuses() {
    this
      .querySelectorAll(".camera-item")
      .forEach(button => {
        const camera =
          this.getCameraByName(
            button.dataset.camera
          );

        const status =
          button.querySelector(
            ".camera-status"
          );

        if (!status) {
          return;
        }

        const online =
          this.isCameraOnline(camera);

        const statusLabel =
          online ? "Online" : "Offline";

        status.classList.toggle(
          "online",
          online
        );

        status.classList.toggle(
          "offline",
          !online
        );

        status.setAttribute(
          "aria-label",
          statusLabel
        );

        status.setAttribute(
          "title",
          statusLabel
        );
      });
  }


  updateCameraListState() {
    this
      .querySelectorAll(
        ".camera-item"
      )
      .forEach(button => {

        const cameraName =
          button.dataset.camera;


        button.classList.toggle(
          "assigned",

          this._assignedCameras.includes(
            cameraName
          )
        );

        button.classList.toggle(
          "target-selected",

          cameraName ===
            this._selectedCamera
        );
      });
  }


  updateSelectedButton() {
    this
      .querySelectorAll(
        ".sidebar-layout-item"
      )
      .forEach(button => {

        button.classList.toggle(
          "selected",

          button.dataset.layout ===
            this._layout
        );

        button.classList.toggle(
          "target-selected",

          button.dataset.layout ===
            this._selectedLayout
        );
      });
  }


  getCardSize() {
    return 10;
  }
}


customElements.define(
  "nvr-card",
  NVRCard
);


window.customCards =
  window.customCards || [];


window.customCards.push({
  type: "nvr-card",

  name: "NVR Camera Card",

  description:
    "Custom NVR camera display"
});
