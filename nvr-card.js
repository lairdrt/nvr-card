/*
 For Home Assisstant
*/

const NVR_BUILD = "__NVR_BUILD__";

class NVRCard extends HTMLElement {
  constructor() {
    super();

    this._layout = "2x2";
    this._hass = null;

    this._cameras = [
      { name: "Garage",     entity: "camera.garage" },
      { name: "Front Door", entity: "camera.front_door" },
      { name: "Drive Down", entity: "camera.drive_down" },
      { name: "Drive Up",   entity: "camera.drive_up" },

      { name: "Side Gate",   entity: null },
      { name: "Fireplace",   entity: null },
      { name: "Front Entry", entity: null },
      { name: "AC",          entity: null },
      { name: "Patio Roof",  entity: null },
      { name: "Patio",       entity: null },
      { name: "Backyard",    entity: null }
    ];

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
        label: "1×1",
        columns: "1fr",
        rows: "1fr",
        cells: [
          { slot: 0 }
        ]
      },

      "2x2": {
        label: "2×2",
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
        label: "3×3",
        columns: "repeat(3, 1fr)",
        rows: "repeat(3, 1fr)",
        cells: Array.from(
          { length: 9 },
          (_, i) => ({ slot: i })
        )
      },

      "4x4": {
        label: "4×4",
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
    this.config = config;
    this.render();
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
    this.innerHTML = `
      <ha-card>
        <div class="nvr-shell">

          <aside class="camera-list">

            <div class="camera-title">
              CAMERAS
            </div>

            <div class="camera-items">
              ${this.buildCameraList()}
            </div>

            <button
              type="button"
              class="clear-button"
            >
              Clear Grid
            </button>

          </aside>


          <main class="main-area">

            <div class="video-grid">
              ${this.buildPersistentSlots()}
            </div>

          </main>


          <footer class="layout-bar">

            <div class="layout-label">
              LAYOUT
            </div>

            <div class="layout-buttons">
              ${this.buildLayoutButtons()}
            </div>

            <span class="build-identifier">
              ${NVR_BUILD}
            </span>

          </footer>

        </div>
      </ha-card>
    `;


    const style =
      document.createElement("style");


    style.textContent = `
      ha-card {
        height: 700px;

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
          minmax(0, 1fr)
          105px;

        grid-template-areas:
          "cameras video"
          "cameras layouts";
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


      .camera-title {
        padding-bottom: 8px;
        margin-bottom: 8px;

        border-bottom: 1px solid #555;

        font-size: 13px;
        font-weight: 700;

        letter-spacing: 0.08em;

        color: #ddd;
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
        color: #fff;
        border-color: #777;
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

        margin-top: 10px;

        padding: 7px 8px;

        background: #181818;

        color: #bbb;

        border: 1px solid #555;
        border-radius: 3px;

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
         LAYOUT BAR
         ================================================ */

      .layout-bar {
        grid-area: layouts;

        min-width: 0;

        display: flex;
        align-items: center;

        gap: 14px;

        padding: 8px 14px;

        background: #111;

        border-top: 1px solid #555;
      }


      .layout-label {
        flex: 0 0 auto;

        color: #999;

        font-size: 11px;
        font-weight: 600;

        letter-spacing: 0.08em;
      }


      .layout-buttons {
        min-width: 0;

        display: flex;
        align-items: center;

        gap: 8px;

        overflow-x: auto;

        padding-bottom: 2px;
      }


      .build-identifier {
        flex: 0 0 auto;

        margin-left: auto;

        color: #666;

        font-size: 9px;

        white-space: nowrap;

        pointer-events: none;
      }


      .layout-button {
        flex: 0 0 auto;

        min-width: 68px;

        padding: 5px 7px;

        background: #181818;

        color: #ccc;

        border: 1px solid #555;
        border-radius: 3px;

        cursor: pointer;
      }


      .layout-button:hover {
        background: #222;
        border-color: #999;
        color: #fff;
      }


      .layout-button.selected {
        border-color: #fff;

        box-shadow:
          0 0 0 1px #fff inset;
      }


      .button-label {
        margin-top: 4px;

        font-size: 9px;

        white-space: nowrap;
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
    this.attachLayoutHandlers();
    this.attachClearHandler();
    this.attachSlotHandlers();

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


  buildLayoutButtons() {
    return Object
      .entries(this.layouts)
      .map(([key, layout]) => {

        return `
          <button
            type="button"
            class="layout-button"
            data-layout="${key}"
          >

            ${this.buildMiniature(layout)}

            <div class="button-label">
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


  /*
   * THIS IS THE ORIGINAL KNOWN-GOOD REMOVAL BEHAVIOR.
   *
   * It does NOT compact cameras.
   *
   * That means the previously discovered 1x1 edge case
   * still exists, intentionally, until we fix it safely.
   */
    
  removeCameraFromSlot(slot) {
    if (
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

    /*
    * Remove ONLY the selected camera.
    * This intentionally destroys that one stream.
    */
    const removedCell =
      this.querySelector(
        `.video-cell[data-slot="${slot}"]`
      );

    if (removedCell) {
      removedCell.innerHTML = "";
    }

    this._assignedCameras[slot] = null;

    /*
    * Compact later cameras toward the front.
    *
    * IMPORTANT:
    * We MOVE their existing DOM nodes rather than
    * calling renderSlot(), so surviving hui-image
    * streams should remain alive.
    */
    for (
      let targetSlot = slot;
      targetSlot < this._assignedCameras.length - 1;
      targetSlot++
    ) {

      /*
      * Find the next occupied slot after targetSlot.
      */
      let sourceSlot = -1;

      for (
        let searchSlot = targetSlot + 1;
        searchSlot < this._assignedCameras.length;
        searchSlot++
      ) {
        if (
          this._assignedCameras[searchSlot] !== null
        ) {
          sourceSlot = searchSlot;
          break;
        }
      }

      /*
      * No more cameras exist after this point.
      */
      if (sourceSlot === -1) {
        break;
      }

      const targetCell =
        this.querySelector(
          `.video-cell[data-slot="${targetSlot}"]`
        );

      const sourceCell =
        this.querySelector(
          `.video-cell[data-slot="${sourceSlot}"]`
        );

      if (
        !targetCell ||
        !sourceCell
      ) {
        continue;
      }

      /*
      * Update the assignment array.
      */
      this._assignedCameras[targetSlot] =
        this._assignedCameras[sourceSlot];

      this._assignedCameras[sourceSlot] =
        null;

      /*
      * Clear only the target's old contents.
      * The removed camera is already gone.
      */
      targetCell.innerHTML = "";

      /*
      * MOVE every existing node from source to target.
      *
      * appendChild() moves nodes; it does not clone them.
      * Thus the surviving hui-image object remains the
      * exact same DOM object.
      */
      while (sourceCell.firstChild) {
        targetCell.appendChild(
          sourceCell.firstChild
        );
      }

      /*
      * Camera has moved, so update its displayed
      * slot number if that overlay exists.
      */
      const number =
        targetCell.querySelector(
          ".cell-number"
        );

      if (number) {
        number.textContent =
          String(targetSlot + 1);
      }
    }

    /*
    * Restore empty-slot markers wherever necessary.
    */
    for (
      let i = 0;
      i < this._assignedCameras.length;
      i++
    ) {

      if (
        this._assignedCameras[i] !== null
      ) {
        continue;
      }

      const cell =
        this.querySelector(
          `.video-cell[data-slot="${i}"]`
        );

      if (
        !cell ||
        cell.children.length > 0
      ) {
        continue;
      }

      const empty =
        document.createElement("div");

      empty.className =
        "empty-cell-center";

      empty.textContent =
        String(i + 1);

      cell.appendChild(empty);
    }

    this.updateCameraListState();

    /*
    * Geometry may have changed slightly after the moves.
    * Do NOT rebuild any streams.
    */
    this.scheduleCameraFit();
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
      16 / 9;


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

            this.assignCamera(
              button.dataset.camera
            );
          }
        );
      });
  }


  attachLayoutHandlers() {
    this
      .querySelectorAll(
        ".layout-button"
      )
      .forEach(button => {

        button.addEventListener(
          "click",
          () => {

            this._layout =
              button.dataset.layout;


            /*
             * No grid rebuild.
             * No stream recreation.
             */
            this.applyLayout();


            this.updateSelectedButton();
          }
        );
      });
  }


  attachSlotHandlers() {
    this
      .querySelectorAll(
        ".video-cell"
      )
      .forEach(cell => {

        cell.addEventListener(
          "click",
          () => {

            const slot =
              Number(
                cell.dataset.slot
              );


            this.removeCameraFromSlot(
              slot
            );
          }
        );
      });
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
      });
  }


  updateSelectedButton() {
    this
      .querySelectorAll(
        ".layout-button"
      )
      .forEach(button => {

        button.classList.toggle(
          "selected",

          button.dataset.layout ===
            this._layout
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