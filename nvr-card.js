/*
 For Home Assisstant
*/

const NVR_BUILD = "__NVR_BUILD__";

// Internal camera-inventory safety limit; not a viewer slot limit.
const MAX_CAMERAS = 256;
const NVR_LAYOUT_DRAG_TYPE =
  "application/x-nvr-layout";
const NVR_CAMERA_DRAG_TYPE =
  "application/x-nvr-camera";

class NVRCard extends HTMLElement {
  constructor() {
    super();

    this._layout = "2x2";
    this._hass = null;
    this._selectedCamera = null;
    this._selectedLayout = null;
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
    this.updateLiveStreams();
  }


  connectedCallback() {
    if (
      this.isConnected &&
      this._resizeObserver === null &&
      this.querySelector(".video-grid")
    ) {
      this.installResizeObserver();
    }
  }


  disconnectedCallback() {
    this.closeCameraContextMenu();

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

    this.innerHTML = `
      <ha-card>
        <div class="nvr-shell">

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
                <span>CAMERAS</span>
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
                <span>LAYOUTS</span>
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
                <span>VIEWS</span>
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
                  -
                </div>
              </div>

            </section>


            <div class="sidebar-utility">

              <button
                type="button"
                class="clear-button"
              >
                Clear Grid
              </button>

              <span class="build-identifier">
                ${NVR_BUILD}
              </span>

            </div>


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
        height: 700px;

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
          minmax(0, 1fr);

        grid-template-areas:
          "cameras video";
      }


      /* ================================================
         CAMERA LIST
         ================================================ */

      .camera-list {
        grid-area: cameras;

        min-width: 0;

        display: flex;
        flex-direction: column;

        background: #111;

        border-right: 1px solid #555;

        padding: 14px;

        overflow: hidden;
      }


      .sidebar-section {
        flex: 0 0 auto;

        min-width: 0;
        min-height: 0;
      }


      .camera-section.expanded {
        flex: 1 1 auto;

        display: flex;
        flex-direction: column;
      }


      .sidebar-section-header {
        width: 100%;
        min-height: 30px;

        display: flex;
        align-items: center;
        justify-content: space-between;

        padding: 0;

        background: transparent;

        border: 0;
        border-bottom: 1px solid #555;

        color: #ddd;

        font-family: inherit;
        font-size: 13px;
        font-weight: 700;

        letter-spacing: 0.08em;

        text-align: left;

        cursor: pointer;
      }


      .sidebar-section-header:hover {
        color: #fff;
      }


      .section-indicator {
        width: 0;
        height: 0;

        border-top: 4.375px solid transparent;
        border-bottom: 4.375px solid transparent;
        border-left: 7.5px solid #888;

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
        flex: 1 1 auto;

        min-height: 0;

        display: flex;
        flex-direction: column;

        padding-top: 8px;
      }


      .sidebar-utility {
        flex: 0 0 auto;

        display: flex;
        align-items: center;

        gap: 8px;

        margin-top: 8px;
        padding-top: 8px;

        border-top: 1px solid #555;
      }


      .sidebar-placeholder {
        padding: 7px 4px 8px;

        color: #555;

        font-size: 10px;
      }


      .sidebar-layout-body {
        max-height: 220px;

        overflow-y: auto;

        padding-right: 6px;
      }


      .sidebar-scroll-region {
        margin-right: -2px;

        scrollbar-color: #666 #181818;
        scrollbar-width: thin;
      }


      .sidebar-scroll-region::-webkit-scrollbar {
        width: 6px;
      }


      .sidebar-scroll-region::-webkit-scrollbar-track {
        background: #181818;
      }


      .sidebar-scroll-region::-webkit-scrollbar-thumb {
        background: #666;

        border-radius: 0;
      }


      .sidebar-scroll-region::-webkit-scrollbar-thumb:hover {
        background: #888;
      }


      .sidebar-scroll-region::-webkit-scrollbar-button {
        width: 0 !important;
        height: 0 !important;
        min-width: 0 !important;
        min-height: 0 !important;

        display: none !important;

        -webkit-appearance: none !important;
        appearance: none !important;

        background: transparent !important;

        border: 0 !important;
      }


      .sidebar-scroll-region::-webkit-scrollbar-button:vertical {
        width: 0 !important;
        height: 0 !important;
        min-width: 0 !important;
        min-height: 0 !important;

        display: none !important;

        -webkit-appearance: none !important;
        appearance: none !important;

        background: transparent !important;

        border: 0 !important;
      }


      .sidebar-layout-grid {
        display: grid;
        grid-template-columns:
          repeat(2, minmax(0, 1fr));

        gap: 6px;

        padding: 8px 0;
      }


      .sidebar-layout-item {
        min-width: 0;

        padding: 5px 3px;

        background: #181818;

        color: #aaa;

        border: 1px solid #444;
        border-radius: 0;

        font-family: inherit;

        cursor: pointer;
      }


      .sidebar-layout-item:hover {
        color: #fff;
        border-color: #888;
      }


      .sidebar-layout-item.selected {
        color: #ddd;
        border-color: #777;
      }


      .sidebar-layout-item.target-selected {
        color: #fff;
        border-color: #fff;
      }


      .sidebar-layout-item.dragging {
        opacity: 0.65;
      }


      .sidebar-layout-label {
        margin-top: 4px;

        overflow: hidden;

        font-size: 9px;

        text-overflow: ellipsis;
        white-space: nowrap;
      }


      .camera-items {
        flex: 1 1 auto;

        min-height: 0;

        overflow-y: auto;
      }


      .camera-item {
        width: 100%;

        display: flex;
        align-items: center;

        padding: 7px 8px;
        margin-bottom: 3px;

        box-sizing: border-box;

        background: transparent;

        color: #ccc;

        border: 1px solid transparent;
        border-radius: 3px;

        font-size: 14px;
        text-align: left;

        cursor: pointer;
      }


      .camera-item:hover {
        background: #222;
        color: #fff;
        border-color: #444;
      }


      .camera-item.assigned {
        background: #1e1e1e;
        color: #ddd;
        border-color: transparent;
      }


      .camera-item.target-selected {
        background: #181818;
        color: #fff;
        border-color: #aaa;
      }


      .camera-item.dragging {
        opacity: 0.65;
      }


      .camera-item.live-capable::after {
        content: "";

        width: 6px;
        height: 6px;

        margin-left: auto;

        border-radius: 50%;

        background: #aaa;
      }


      .camera-index {
        width: 22px;

        flex: 0 0 22px;

        color: #777;

        font-size: 11px;
      }


      .camera-name {
        overflow: hidden;

        text-overflow: ellipsis;

        white-space: nowrap;
      }


      .clear-button {
        flex: 0 0 auto;

        padding: 4px 6px;

        background: #181818;

        color: #bbb;

        border: 1px solid #555;
        border-radius: 3px;

        font-size: 10px;

        cursor: pointer;
      }


      .clear-button:hover {
        background: #222;
        color: #fff;
        border-color: #888;
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

        margin-left: auto;

        color: #666;

        font-size: 9px;

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
        width: 52px;
        height: 36px;

        margin: auto;

        display: grid;

        gap: 1px;

        box-sizing: border-box;

        background: #777;

        border: 1px solid #888;
      }


      .layout-icon-cell {
        min-width: 0;
        min-height: 0;

        box-sizing: border-box;

        background: #050505;
      }
    `;


    this.appendChild(style);


    this.attachCameraHandlers();
    this.attachCameraDragHandlers();
    this.attachSidebarHandlers();
    this.attachLayoutHandlers();
    this.attachLayoutDragHandlers();
    this.attachClearHandler();
    this.attachSlotHandlers();
    this.attachCameraContextMenuHandlers();

    /*
     * Persistent grid already exists.
     * Just apply the current layout.
     */
    this.applyLayout();

    this.updateSelectedButton();
    this.updateCameraListState();

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
      .map((camera, index) => {

        const liveClass =
          camera.entity
            ? "live-capable"
            : "";

        return `
          <button
            type="button"
            class="camera-item ${liveClass}"
            data-camera="${camera.name}"
            draggable="true"
          >

            <span class="camera-index">
              ${index + 1}
            </span>

            <span class="camera-name">
              ${camera.name}
            </span>

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


  assignCamera(cameraName) {
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


  removeCameraFromSlot(slot) {
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
    const occupied =
      this._assignedCameras
        .map((cameraName, sourceSlot) => {
          return {
            cameraName,
            sourceSlot
          };
        })
        .filter(entry => {
          return entry.cameraName !== null;
        });

    const cells =
      Array.from(
        { length: this._assignedCameras.length },
        (_, slot) => {
          return this.querySelector(
            `.video-cell[data-slot="${slot}"]`
          );
        }
      );

    if (cells.some(cell => !cell)) {
      return;
    }

    occupied.forEach(
      (entry, targetSlot) => {
        if (entry.sourceSlot === targetSlot) {
          return;
        }

        const sourceCell =
          cells[entry.sourceSlot];

        const targetCell =
          cells[targetSlot];

        targetCell.innerHTML = "";

        while (sourceCell.firstChild) {
          targetCell.appendChild(
            sourceCell.firstChild
          );
        }

        const number =
          targetCell.querySelector(
            ".cell-number"
          );

        if (number) {
          number.textContent =
            String(targetSlot + 1);
        }
      }
    );

    this._assignedCameras.fill(null);

    occupied.forEach(
      (entry, targetSlot) => {
        this._assignedCameras[targetSlot] =
          entry.cameraName;
      }
    );

    for (
      let slot = occupied.length;
      slot < cells.length;
      slot++
    ) {
      const cell = cells[slot];

      if (cell.children.length > 0) {
        continue;
      }

      const empty =
        document.createElement("div");

      empty.className =
        "empty-cell-center";

      empty.textContent =
        String(slot + 1);

      cell.appendChild(empty);
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
        "live";


      if (this._hass) {
        image.hass =
          this._hass;
      }


      frame.appendChild(image);

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
  }


  /* ================================================
     16:9 LETTERBOX ENGINE
     ================================================ */

  fitLiveCameras() {
    const CAMERA_RATIO =
      this._cameraAspectRatio;


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


        const width =
          frame.clientWidth;


        const height =
          frame.clientHeight;


        if (
          width <= 0 ||
          height <= 0
        ) {
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


        image.style.width =
          `${Math.floor(
            targetWidth
          )}px`;


        image.style.height =
          `${Math.floor(
            targetHeight
          )}px`;
      });
  }


  scheduleCameraFit() {
    if (this._cameraFitFrame !== null) {
      return;
    }

    this._cameraFitFrame =
      requestAnimationFrame(() => {
        this._cameraFitFrame = null;
        this.fitLiveCameras();
      });
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
          "dragenter",
          event => {
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

            const targetSlot =
              Number(cell.dataset.slot);

            this.assignCameraToSlot(
              cameraName,
              targetSlot
            );

            this.clearCameraTargetSelection();
          }
        );
      });
  }


  isCameraDrag(event) {
    if (!event.dataTransfer) {
      return false;
    }

    return Array
      .from(event.dataTransfer.types)
      .includes(NVR_CAMERA_DRAG_TYPE);
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


  attachCameraContextMenuHandlers() {
    this
      .querySelectorAll(".video-cell")
      .forEach(cell => {
        cell.addEventListener(
          "contextmenu",
          event => {
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


  attachClearHandler() {
    const button =
      this.querySelector(
        ".clear-button"
      );


    if (!button) {
      return;
    }


    button.addEventListener(
      "click",
      () => {

        this._assignedCameras
          .forEach(
            (cameraName, slot) => {

              if (
                cameraName !== null
              ) {

                this._assignedCameras[
                  slot
                ] = null;


                this.renderSlot(
                  slot
                );
              }
            }
          );


        this.updateCameraListState();
      }
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
        "hui-image.nvr-live-camera"
      )
      .forEach(image => {

        image.hass =
          this._hass;
      });
  }


  /* ================================================
     RESIZE HANDLING
     ================================================ */

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


    if (!grid) {
      return;
    }

    this._resizeObserver =
      new ResizeObserver(() => {
        this.scheduleCameraFit();
      });

    this._resizeObserver.observe(
      grid
    );
  }


  /* ================================================
     UI STATE
     ================================================ */

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
