import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createTestHarness } from "./helpers/nvr-card-harness.js";

const camera = { name: "Logical", entity: "camera.logical", live: {
  substream: "camera.onvif_sub1", mainstream: "camera.onvif_main"
} };
function setup(t, cameras = [camera], diagnostics = false) {
  const h = createTestHarness({ liveTransitionDiagnostics: diagnostics });
  t.after(() => h.close());
  const card = h.createCard({ cameras });
  return { h, card };
}

test("camera live YAML: normalization accepts, trims, and copies explicit mapping", t => {
  const { card } = setup(t);
  const raw = { ...camera, live: { substream: " camera.sub ", mainstream: " camera.main " } };
  const normalized = card.normalizeCameras([raw])[0];
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
    name: "Logical", entity: "camera.logical", active: true,
    live: { substream: "camera.sub", mainstream: "camera.main" }
  });
  raw.live.substream = "camera.changed";
  assert.equal(normalized.live.substream, "camera.sub");
});

for (const value of [null, undefined, [], "bad", 1, true]) test(`camera live YAML: rejects non-object ${JSON.stringify(value)}`, t => {
  const { card } = setup(t);
  assert.throws(() => card.normalizeCameras([{ ...camera, live: value }]), /live must be an object/);
});

for (const field of ["substream", "mainstream"]) test(`camera live YAML: rejects missing, empty, or invalid ${field}`, t => {
  const { card } = setup(t);
  for (const value of [undefined, null, "", "  ", 1, false]) {
    assert.throws(() => card.normalizeCameras([{ ...camera, live: { ...camera.live, [field]: value } }]),
      new RegExp(`live.${field} must be a nonempty string`));
  }
  const live = { ...camera.live }; delete live[field];
  assert.throws(() => card.normalizeCameras([{ ...camera, live }]), /nonempty string/);
});

test("camera live YAML: rejects unsupported nested and top-level properties", t => {
  const { card } = setup(t);
  assert.throws(() => card.normalizeCameras([{ ...camera, live: { ...camera.live, transport: "webrtc" } }]), /unsupported field "transport"/);
  assert.throws(() => card.normalizeCameras([{ ...camera, extra: true }]), /unsupported field "extra"/);
});

test("camera live YAML: absent block preserves generic fallback even for formerly mapped logical entity", t => {
  const { h, card } = setup(t, [{ name: "Garage", entity: "camera.garage" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(card._cameras[0])), { name: "Garage", entity: "camera.garage", active: true });
  card.assignCamera("Garage"); const image = h.getPlayer(card, "Garage");
  assert.equal(image.cameraImage, "camera.garage");
  card.maximizeCameraSlot(0); assert.equal(image.cameraImage, "camera.garage");
  card.restoreMaximizedCamera(); assert.equal(image.cameraImage, "camera.garage");
  assert.equal(h.getPlayer(card, "Garage"), image);
});

test("camera live YAML: grid/maximize/restore share selection and preserve logical identity and nodes", t => {
  const { h, card } = setup(t);
  card.assignCamera("Logical");
  const before = h.capturePlayerIdentity(card, "Logical");
  const image = before.player, frame = image.parentElement;
  card.renderSlot = () => assert.fail("source switch must not rebuild a slot");
  assert.equal(image.cameraImage, camera.live.substream);
  card.maximizeCameraSlot(0); assert.equal(image.cameraImage, camera.live.mainstream);
  card.restoreMaximizedCamera(); assert.equal(image.cameraImage, camera.live.substream);
  assert.equal(image.dataset.entity, camera.entity);
  assert.equal(card.getCameraByName("Logical").entity, camera.entity);
  assert.equal(card._assignedCameras[0], "Logical");
  assert.deepEqual(h.capturePlayerIdentity(card, "Logical"), before);
  assert.equal(image.parentElement, frame);
});

test("camera live YAML: transition and reconnect diagnostics agree with production sources", t => {
  const { h, card } = setup(t, [camera], true);
  card.assignCamera("Logical"); const image = h.getPlayer(card, "Logical");
  const snapshots = [];
  card.logReconnect = (event, payload) => { if (event === "reconnect-snapshot") snapshots.push(payload); };
  const check = expected => {
    card.captureReconnectSnapshot("test");
    const cell = snapshots.at(-1).cells[0];
    assert.equal(cell.expectedLiveSourceEntity, expected);
    assert.equal(cell.sourceMatchesExpected, true);
    assert.equal(cell.logicalEntity, camera.entity);
  };
  check(camera.live.substream);
  assert.equal(card.beginMaximizeLiveTransition(0, image).toEntity, camera.live.mainstream);
  card.maximizeCameraSlot(0); check(camera.live.mainstream);
  assert.equal(card.beginRestoreLiveTransition(0, image).toEntity, camera.live.substream);
  card.restoreMaximizedCamera(); check(camera.live.substream);
});

test("camera live YAML: workspace and Saved Views persist logical entities across remapping", t => {
  const { h, card } = setup(t);
  card.assignCamera("Logical"); card.maximizeCameraSlot(0);
  const saved = card.saveCurrentViewAs("Main");
  const workspace = h.userStateBackend.get(card.getWorkspacePersistenceKey());
  assert.equal(workspace.viewState.assignedCameras[0], camera.entity);
  assert.equal(workspace.savedViews.views[0].state.assignedCameras[0], camera.entity);
  assert.equal(JSON.stringify(workspace).includes(camera.live.substream), false);
  assert.equal(JSON.stringify(workspace).includes(camera.live.mainstream), false);
  const remapped = { ...camera, live: { substream: "camera.new_sub", mainstream: "camera.new_main" } };
  const next = h.createCard({ cameras: [remapped] });
  assert.equal(next._maximizedSlot, 0);
  assert.equal(h.getPlayer(next, "Logical").cameraImage, remapped.live.mainstream);
  assert.equal(next.loadSavedView(saved.id), true);
  assert.equal(next.captureViewState().assignedCameras[0], camera.entity);
});

test("camera live YAML: equivalent normalized mappings and auto-dim-only updates preserve media", t => {
  const { h, card } = setup(t);
  card.assignCamera("Logical"); const before = h.capturePlayerIdentity(card, "Logical");
  const key = card._normalizedConfigKey;
  card.render = () => assert.fail("equivalent mapping or auto_dim must not render");
  card.setConfig({ cameras: [{ ...camera, active: true, live: {
    mainstream: " camera.onvif_main ", substream: "camera.onvif_sub1 "
  } }], auto_dim: { enabled: true, notify_service: "notify.tablet" } });
  assert.equal(card._normalizedConfigKey, key);
  assert.deepEqual(h.capturePlayerIdentity(card, "Logical"), before);
  const a = card.normalizeConfig({ cameras: [camera] });
  const b = card.normalizeConfig({ cameras: [{ ...camera, live: { ...camera.live, mainstream: "camera.other" } }] });
  assert.notEqual(JSON.stringify(a.cameras), JSON.stringify(b.cameras));
});

test("camera live YAML: source tables and installation-specific entities are absent from implementation", () => {
  const source = readFileSync(new URL("../nvr-card.js", import.meta.url), "utf8");
  for (const kind of ["SUBSTREAM", "MAINSTREAM"]) {
    assert.equal(source.includes("HA_HUI_IMAGE_" + kind + "_ENTITIES"), false);
  }
  assert.equal(source.includes("lorex_mediaprofile"), false);
});
