import assert from "node:assert/strict";
import test from "node:test";

import {
  createTestHarness
} from "./helpers/nvr-card-harness.js";

function setup(t) {
  const harness = createTestHarness();
  t.after(() => harness.close());
  return harness;
}

function assignments(card) {
  return Array.from(card._assignedCameras);
}

function assertIdentityUnchanged(harness, card, cameraName, before) {
  const after =
    harness.capturePlayerIdentity(card, cameraName);

  assert.strictEqual(after.player, before.player);
  assert.strictEqual(after.cell, before.cell);
  assert.equal(after.player.isConnected, true);
  assert.equal(after.player.connectedCount, 1);
  assert.equal(after.player.disconnectedCount, 0);
  return after;
}

test("initial render creates 16 persistent cells with unique logical slots", t => {
  const harness = setup(t);

  assert.ok(
    harness.window.customElements.get("nvr-card")
  );

  const card = harness.createCard();
  const cells = harness.getPhysicalCells(card);
  const slots = cells.map(cell => Number(cell.dataset.slot));

  assert.equal(cells.length, 16);
  assert.equal(new Set(cells).size, 16);
  assert.deepEqual(slots, Array.from({ length: 16 }, (_, slot) => slot));
});

test("initial camera assignment uses the first available visible slots", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  card.assignCamera("Garage");
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    "Garage",
    null,
    null
  ]);

  const frontPlayer = harness.getPlayer(card, "Front");
  const garagePlayer = harness.getPlayer(card, "Garage");

  assert.ok(frontPlayer);
  assert.ok(garagePlayer);
  assert.strictEqual(
    frontPlayer.closest(".video-cell"),
    harness.getLogicalCell(card, 0)
  );
  assert.strictEqual(
    garagePlayer.closest(".video-cell"),
    harness.getLogicalCell(card, 1)
  );
  assert.equal(frontPlayer.cameraImage, "camera.front");
  assert.equal(frontPlayer.cameraView, "live");
});

test("removal leaves a hole without compacting unaffected cameras", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  card.assignCamera("Garage");
  card.assignCamera("Patio");
  harness.flushAnimationFrames();

  const frontBefore =
    harness.capturePlayerIdentity(card, "Front");
  const patioBefore =
    harness.capturePlayerIdentity(card, "Patio");

  card.removeCameraFromSlot(1);

  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    null,
    "Patio",
    null
  ]);
  assert.equal(harness.getPlayer(card, "Garage"), null);
  assertIdentityUnchanged(harness, card, "Front", frontBefore);
  assertIdentityUnchanged(harness, card, "Patio", patioBefore);
  assert.strictEqual(
    harness.getLogicalCell(card, 2),
    patioBefore.cell
  );
});

test("camera cell-to-cell move preserves player and physical-cell identity", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  harness.flushAnimationFrames();

  const before =
    harness.capturePlayerIdentity(card, "Front");

  assert.ok(before.player);
  assert.ok(before.cell);
  assert.equal(before.connectedCount, 1);

  card.moveCameraBetweenSlots(0, 2);
  harness.flushAnimationFrames();

  const after =
    harness.capturePlayerIdentity(card, "Front");

  assert.strictEqual(after.player, before.player);
  assert.strictEqual(after.cell, before.cell);
  assert.strictEqual(harness.getLogicalCell(card, 2), before.cell);
  assert.equal(after.player.isConnected, true);
  assert.equal(after.player.connectedCount, 1);
  assert.equal(after.player.disconnectedCount, 0);
});

test("moving onto an occupied target replaces it and preserves unaffected players", t => {
  const harness = setup(t);
  const card = harness.createCard();

  card.assignCamera("Front");
  card.assignCamera("Garage");
  card.assignCamera("Patio");
  harness.flushAnimationFrames();

  const frontBefore =
    harness.capturePlayerIdentity(card, "Front");
  const garageBefore =
    harness.capturePlayerIdentity(card, "Garage");
  const patioBefore =
    harness.capturePlayerIdentity(card, "Patio");

  card.moveCameraBetweenSlots(0, 1);
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card).slice(0, 4), [
    null,
    "Front",
    "Patio",
    null
  ]);

  const frontAfter = assertIdentityUnchanged(
    harness,
    card,
    "Front",
    frontBefore
  );
  assert.strictEqual(frontAfter.cell, harness.getLogicalCell(card, 1));

  assert.equal(harness.getPlayer(card, "Garage"), null);
  assert.equal(garageBefore.player.isConnected, false);
  assert.equal(garageBefore.player.connectedCount, 1);
  assert.equal(garageBefore.player.disconnectedCount, 1);

  assertIdentityUnchanged(harness, card, "Patio", patioBefore);
  assert.strictEqual(
    harness.getLogicalCell(card, 2),
    patioBefore.cell
  );
});

test("layout repacking across holes preserves every surviving player and cell", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio", "Hall"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  card.removeCameraFromSlot(1);

  const survivors = ["Front", "Patio", "Hall"];
  const before = new Map(
    survivors.map(cameraName => [
      cameraName,
      harness.capturePlayerIdentity(card, cameraName)
    ])
  );

  card.repackAssignedCameras();
  card.applyLayout();
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    "Patio",
    "Hall",
    null
  ]);

  survivors.forEach((cameraName, logicalSlot) => {
    const identity = assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      before.get(cameraName)
    );
    assert.strictEqual(
      identity.cell,
      harness.getLogicalCell(card, logicalSlot)
    );
  });
});

test("maximize then restore preserves assignments, layout, players, and cells", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const cameraNames = ["Front", "Garage", "Patio"];
  const identityBefore = new Map(
    cameraNames.map(cameraName => [
      cameraName,
      harness.capturePlayerIdentity(card, cameraName)
    ])
  );
  const assignmentsBefore = assignments(card);
  const physicalCellsBefore = harness.getPhysicalCells(card);
  const logicalSlotsBefore = physicalCellsBefore.map(
    cell => cell.dataset.slot
  );
  const grid = card.querySelector(".video-grid");
  const gridColumnsBefore = grid.style.gridTemplateColumns;
  const gridRowsBefore = grid.style.gridTemplateRows;

  card.maximizeCameraSlot(1);
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, 1);
  assert.equal(grid.classList.contains("camera-maximized"), true);
  assert.equal(
    harness.getLogicalCell(card, 1).classList.contains(
      "maximized-camera"
    ),
    true
  );

  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, null);
  assert.equal(grid.classList.contains("camera-maximized"), false);
  assert.equal(
    card.querySelectorAll(".video-cell.maximized-camera").length,
    0
  );
  assert.deepEqual(assignments(card), assignmentsBefore);
  assert.equal(card._layout, "2x2");
  assert.equal(grid.style.gridTemplateColumns, gridColumnsBefore);
  assert.equal(grid.style.gridTemplateRows, gridRowsBefore);

  const physicalCellsAfter = harness.getPhysicalCells(card);
  physicalCellsBefore.forEach((cell, index) => {
    assert.strictEqual(physicalCellsAfter[index], cell);
    assert.equal(cell.dataset.slot, logicalSlotsBefore[index]);
  });

  cameraNames.forEach(cameraName => {
    assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      identityBefore.get(cameraName)
    );
  });
});
