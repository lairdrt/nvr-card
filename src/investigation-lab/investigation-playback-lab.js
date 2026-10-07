import {
  describeInvestigationLocalTime,
  formatInvestigationLocalCivil,
  loadInvestigationHls,
  parseInvestigationEpoch
} from "./single-camera-engine.js?v=__LAB_BUILD__";
import {
  LongVodTwoPeerExperiment
} from "./long-vod-two-peer-experiment.js?v=__LAB_BUILD__";

const LAB_BUILD = "__LAB_BUILD__";
const SAFE_CAMERA_ID = /^[A-Za-z0-9_-]+$/;
const formatEpoch = value => Number.isFinite(Number(value))
  ? `${Number(value).toFixed(3)}\n${formatInvestigationLocalCivil(value).replace("T", " ")} local\n${new Date(Number(value) * 1000).toISOString()} UTC`
  : "--";
const formatNumber = (value, digits = 3) => Number.isFinite(Number(value))
  ? Number(value).toFixed(digits) : "--";

class InvestigationPlaybackLab extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._coordinator = null;
    this._selectionGeneration = 0;
    this._rendered = false;
    this._copyFeedbackTimer = null;
    this._lastTimeConversion = null;
  }

  setConfig(config) {
    const cameras = config?.cameras;
    if (!Array.isArray(cameras) || cameras.length < 1 || cameras.length > 2 ||
        new Set(cameras).size !== cameras.length ||
        cameras.some(camera => typeof camera !== "string" || !SAFE_CAMERA_ID.test(camera))) {
      throw new Error("Investigation Playback Lab requires one or two distinct safe `cameras` IDs.");
    }
    const changed = this._config?.cameras?.join("|") !== cameras.join("|");
    if (changed) {
      this._teardownExperiment();
      this.shadowRoot?.querySelector(".peers")?.replaceChildren();
    }
    this._config = { cameras: [...cameras], title: config.title ?? "Investigation Playback Lab" };
    this._ensureRendered();
    this._renderPeerCells();
    this._ensureExperiment();
  }

  set hass(value) { this._hass = value; this._ensureRendered(); this._ensureExperiment(); }
  connectedCallback() { this._ensureRendered(); this._ensureExperiment(); }
  disconnectedCallback() {
    if (this._copyFeedbackTimer) clearTimeout(this._copyFeedbackTimer);
    this._teardownExperiment();
  }
  getCardSize() { return 12; }

  getDiagnosticReport() {
    return {
      schema: 2,
      labBuild: LAB_BUILD,
      cameras: [...(this._config?.cameras ?? [])],
      selectionGeneration: this._selectionGeneration,
      timeEditor: this._timeEditorDiagnostic(),
      coordinator: this._coordinator?.getDiagnosticReport() ?? null
    };
  }

  _ensureRendered() {
    if (this._rendered || !this.shadowRoot) return;
    this._rendered = true;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; --lab-control-surface:var(--input-fill-color,var(--secondary-background-color,#f5f5f5)); --lab-control-text:var(--primary-text-color,#212121); --lab-border:var(--divider-color,#9e9e9e); background:#080b10; color:#f5f7fa; }
        ha-card { display:block; padding:12px; background:#080b10; color:#f5f7fa; }
        h2 { margin:0 0 10px; font-size:18px; color:#fff; } .lab-build { margin:-6px 0 10px; color:#fff; font:12px monospace; }
        .entry,.transport { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
        [hidden] { display:none!important; }
        input,button,select { color:var(--lab-control-text); background:var(--lab-control-surface); border:1px solid var(--lab-border); }
        input { flex:1 1 280px; min-width:0; padding:8px; } button,select { min-height:36px; padding:4px 10px; }
        .peers { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
        .peer { min-width:0; border:1px solid #3d4856; background:#10151d; }
        .peer-header { display:flex; justify-content:space-between; gap:8px; padding:6px 8px; font:12px monospace; color:#f5f7fa; }
        .peer-role { color:#cbd5e1; }
        .viewport { position:relative; min-height:240px; background:#000; overflow:hidden; }
        .viewport video,.viewport canvas { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000; }
        .viewport video.lab-staging { visibility:hidden; } .viewport video.lab-active { visibility:visible; } .viewport canvas.lab-hold { z-index:3; }
        .peer-times { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:4px; padding:6px; }
        .time { min-width:0; padding:5px; background:#1a212b; border:1px solid #3d4856; color:#f5f7fa; }
        .time b { display:block; font-size:11px; color:#cbd5e1; } .time output { white-space:pre-wrap; overflow-wrap:anywhere; font:10px monospace; }
        .peer-sync { padding:0 8px 8px; font:11px monospace; color:#cbd5e1; }
        .scene-state,.status { margin:8px 0; font:12px monospace; color:#f5f7fa; }
        .diagnostics-toolbar { display:flex; align-items:center; gap:8px; margin:8px 0; }
        .diagnostics { box-sizing:border-box; width:100%; min-height:200px; max-height:320px; overflow:auto; resize:vertical; white-space:pre; font:11px monospace; background:#111820; color:#f5f7fa; user-select:text; cursor:text; }
        @media(max-width:800px){ .peers{grid-template-columns:1fr;} .peer-times{grid-template-columns:1fr;} }
      </style>
      <ha-card>
        <h2></h2><div class="lab-build">${LAB_BUILD}</div>
        <div class="peers" aria-label="Historical camera peers"></div>
        <div class="entry"><label>Local investigation time <input class="ti" type="datetime-local" step="1" aria-label="Local investigation time"></label><button class="place">Place</button></div>
        <div class="entry range-entry" hidden><label>Lab range start <input class="range-start" type="datetime-local" step="1"></label><label>Lab range end <input class="range-end" type="datetime-local" step="1"></label><button class="count-range">Count range</button><button class="place-range">Prepare/place range</button><button class="probe-manifest">Probe manifest</button></div>
        <div class="entry"><label>Absolute seek time <input class="seek-time" type="datetime-local" step="1"></label><button class="seek">Seek within presentation</button></div>
        <div class="transport"><button class="reset">Reset</button><button class="play">Play 1x</button><button class="pause">Pause</button><button class="resume">Resume 1x</button></div>
        <div class="scene-state">Playback epoch: -- | follower error: --</div>
        <div class="status" role="status">Configure one or two test cameras</div>
        <details><summary>Sanitized diagnostics</summary><div class="diagnostics-toolbar"><button class="copy-diagnostics" type="button">Copy diagnostics</button></div><textarea class="diagnostics" readonly aria-label="Sanitized diagnostics">Full diagnostics are generated only when Copy diagnostics is pressed.</textarea></details>
      </ha-card>`;
    this._bind(".place", () => this._run(() => this._placeFromEditor()));
    this._bind(".place-range", () => this._run(() => this._placeRangeFromEditor()));
    this._bind(".count-range", () => this._run(() => this._countRangeFromEditor()));
    this._bind(".probe-manifest", () => this._run(() => this._coordinator?.probeManifest()));
    this._bind(".seek", () => this._run(() => this._seekFromEditor()));
    this._bind(".play", () => this._run(() => this._coordinator?.play()));
    this._bind(".pause", () => this._run(() => this._coordinator?.pause()));
    this._bind(".resume", () => this._run(() => this._coordinator?.resume()));
    this._bind(".reset", () => this._run(() => this._coordinator?.reset()));
    this._bind(".copy-diagnostics", () => this._copyDiagnostics());
  }

  _bind(selector, listener) { this.shadowRoot.querySelector(selector).addEventListener("click", listener); }

  _renderPeerCells() {
    const host = this.shadowRoot?.querySelector(".peers");
    if (!host || !this._config || host.children.length) return;
    host.replaceChildren(...this._config.cameras.map((camera, index) => {
      const peer = this.ownerDocument.createElement("section");
      peer.className = "peer";
      peer.dataset.camera = camera;
      peer.innerHTML = `
        <div class="peer-header"><span class="peer-camera"></span><span class="peer-role">${index === 0 ? "Observation reference" : "Follower observation"}</span></div>
        <div class="viewport" aria-label="${camera} historical media"></div>
        <div class="peer-times"><div class="time"><b>Requested</b><output class="requested">--</output></div><div class="time"><b>Resolved</b><output class="resolved">--</output></div><div class="time"><b>Represented</b><output class="represented">--</output></div></div>
        <div class="peer-sync">nominal 1x | actual -- | error -- | long VOD --</div>`;
      peer.querySelector(".peer-camera").textContent = camera;
      return peer;
    }));
    this.shadowRoot.querySelector("h2").textContent = this._config.title;
    this.shadowRoot.querySelector(".range-entry").hidden = this._config.cameras.length !== 1;
  }

  _cell(camera) {
    return [...(this.shadowRoot?.querySelectorAll(".peer") ?? [])]
      .find(element => element.dataset.camera === camera) ?? null;
  }

  _placeFromEditor() {
    const editorValue = this.shadowRoot.querySelector(".ti").value;
    const epoch = parseInvestigationEpoch(editorValue);
    this._lastTimeConversion = describeInvestigationLocalTime(editorValue, epoch);
    return this._coordinator?.place(epoch);
  }

  _placeRangeFromEditor() {
    const start = parseInvestigationEpoch(this.shadowRoot.querySelector(".range-start").value);
    const end = parseInvestigationEpoch(this.shadowRoot.querySelector(".range-end").value);
    return this._coordinator?.placeRange(start, end);
  }

  _countRangeFromEditor() {
    const start = parseInvestigationEpoch(this.shadowRoot.querySelector(".range-start").value);
    const end = parseInvestigationEpoch(this.shadowRoot.querySelector(".range-end").value);
    return this._coordinator?.countRange(start, end);
  }

  _seekFromEditor() {
    const epoch = parseInvestigationEpoch(this.shadowRoot.querySelector(".seek-time").value);
    return this._coordinator?.seekAbsolute(epoch);
  }

  _timeEditorDiagnostic() {
    if (this._lastTimeConversion) return { ...this._lastTimeConversion };
    const editorValue = this.shadowRoot?.querySelector(".ti")?.value ?? "";
    if (!editorValue) return {
      localEditorValue: "", absoluteEpoch: null, utcIso: null,
      runtimeTimeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null; } catch { return null; } })(),
      utcOffsetMinutes: null
    };
    try { return { ...describeInvestigationLocalTime(editorValue) }; }
    catch { return { localEditorValue: editorValue, absoluteEpoch: null, utcIso: null, runtimeTimeZone: null, utcOffsetMinutes: null }; }
  }

  _teardownExperiment() {
    this._selectionGeneration += 1;
    if (this._coordinator) this._coordinator.destroy();
    this._coordinator = null;
    for (const viewport of this.shadowRoot?.querySelectorAll(".viewport") ?? []) viewport.replaceChildren();
  }

  _ensureExperiment() {
    if (this._coordinator || !this.isConnected || !this._config || !this._hass ||
        typeof this._hass.callWS !== "function") return;
    this._renderPeerCells();
    const generation = this._selectionGeneration;
    this._coordinator = new LongVodTwoPeerExperiment({
      cameras: this._config.cameras,
      callWS: message => this._hass.callWS(message),
      getAuth: () => this._hass?.auth,
      createVideo: () => this.ownerDocument.createElement("video"),
      loadHls: () => loadInvestigationHls(this.ownerDocument),
      onVideoCreated: session => {
        if (generation !== this._selectionGeneration) return;
        session.video.className = "lab-active";
        session.video.controls = false;
        this._cell(session.camera)?.querySelector(".viewport")?.appendChild(session.video);
      },
      onVideoDestroyed: session => session.video.remove(),
      onStateChange: state => {
        if (generation === this._selectionGeneration) this._update(state);
      }
    });
    this._update(this._coordinator.state);
  }

  async _run(action) {
    try { await action(); }
    catch (error) { this.shadowRoot.querySelector(".status").textContent = error?.message ?? "Lab operation failed."; }
    this._update(this._coordinator?.state);
  }

  _update(state) {
    if (!this.shadowRoot) return;
    for (const peer of state?.peers ?? []) {
      const cell = this._cell(peer.camera);
      if (!cell) continue;
      cell.querySelector(".requested").textContent = formatEpoch(peer.requestedEpoch);
      cell.querySelector(".resolved").textContent = formatEpoch(peer.resolvedEpoch);
      cell.querySelector(".represented").textContent = formatEpoch(peer.representedEpoch);
      cell.querySelector(".peer-sync").textContent =
        `nominal 1x | actual ${formatNumber(peer.actualPlaybackRate, 2)}x | error ${peer.errorSeconds === null ? "n/a" : `${peer.errorSeconds >= 0 ? "+" : ""}${formatNumber(peer.errorSeconds)}s`} | ${peer.lifecycle}`;
    }
    this.shadowRoot.querySelector(".scene-state").textContent = state
      ? `Playback epoch: ${formatNumber(state.playbackEpoch)} | follower error: ${state.followerErrorSeconds === null ? "--" : `${state.followerErrorSeconds >= 0 ? "+" : ""}${formatNumber(state.followerErrorSeconds)}s`} | authority: ${state.authorityStatus}`
      : "Playback epoch: -- | follower error: --";
    this.shadowRoot.querySelector(".status").textContent = state
      ? `#${state.operationId ?? "--"} ${state.operationIntent ?? "idle"}: ${state.operationDisposition ?? state.status} - ${state.playing ? "playing" : "paused"}`
      : "Configure one or two test cameras";
    const editor = this.shadowRoot.querySelector(".ti");
    if (editor && state?.operationIntent === "place" && Number.isFinite(Number(state.requestedEpoch))) {
      editor.value = formatInvestigationLocalCivil(state.requestedEpoch);
    }
  }

  _generateDiagnosticText() {
    const windowRef = this.ownerDocument?.defaultView;
    const now = () => windowRef?.performance?.now?.() ?? performance.now();
    const startedAtMs = now();
    const report = this.getDiagnosticReport();
    let text = JSON.stringify(report, null, 2);
    const serializedAtMs = now();
    report.diagnosticGeneration = {
      mode: "copy-time",
      startedAtMs,
      serializedAtMs,
      reportGenerationDurationMs: serializedAtMs - startedAtMs,
      serializedCharacterCount: 0,
      serializedByteCount: 0
    };
    for (let pass = 0; pass < 8; pass += 1) {
      text = JSON.stringify(report, null, 2);
      const characters = text.length;
      const bytes = new TextEncoder().encode(text).byteLength;
      if (report.diagnosticGeneration.serializedCharacterCount === characters &&
          report.diagnosticGeneration.serializedByteCount === bytes) return text;
      report.diagnosticGeneration.serializedCharacterCount = characters;
      report.diagnosticGeneration.serializedByteCount = bytes;
    }
    return JSON.stringify(report, null, 2);
  }

  async _copyDiagnostics() {
    const button = this.shadowRoot.querySelector(".copy-diagnostics");
    const diagnostics = this.shadowRoot.querySelector(".diagnostics");
    try {
      diagnostics.value = this._generateDiagnosticText();
      const clipboard = this.ownerDocument?.defaultView?.navigator?.clipboard;
      if (clipboard && typeof clipboard.writeText === "function") {
        try { await clipboard.writeText(diagnostics.value); this._showCopyFeedback(button, "Copied"); return; }
        catch {}
      }
      if (!this._copyDisplayedDiagnostics(diagnostics)) throw new Error("Copy failed.");
      this._showCopyFeedback(button, "Copied");
    } catch { this._showCopyFeedback(button, "Copy failed"); }
  }

  _copyDisplayedDiagnostics(diagnostics) {
    const documentRef = diagnostics?.ownerDocument;
    if (!documentRef || typeof documentRef.execCommand !== "function") return false;
    const active = documentRef.activeElement;
    const start = diagnostics.selectionStart;
    const end = diagnostics.selectionEnd;
    const direction = diagnostics.selectionDirection;
    try { diagnostics.focus(); diagnostics.select(); return documentRef.execCommand("copy") === true; }
    finally {
      if (active === diagnostics) diagnostics.setSelectionRange(start, end, direction);
      else active?.focus?.();
    }
  }

  _showCopyFeedback(button, label) {
    if (this._copyFeedbackTimer) clearTimeout(this._copyFeedbackTimer);
    button.textContent = label;
    this._copyFeedbackTimer = setTimeout(() => {
      button.textContent = "Copy diagnostics";
      this._copyFeedbackTimer = null;
    }, 1500);
  }
}

if (!customElements.get("investigation-playback-lab")) {
  customElements.define("investigation-playback-lab", InvestigationPlaybackLab);
}
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === "investigation-playback-lab")) {
  window.customCards.push({
    type: "investigation-playback-lab",
    name: "Investigation Playback Lab",
    description: "Experimental two-peer RVFC historical playback synchronization lab",
    preview: false
  });
}
export { InvestigationPlaybackLab };
