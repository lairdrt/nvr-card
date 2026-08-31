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

function captureIdentities(harness, card, cameraNames) {
  return new Map(
    cameraNames.map(cameraName => [
      cameraName,
      harness.capturePlayerIdentity(card, cameraName)
    ])
  );
}

function assertIdentitiesUnchanged(
  harness,
  card,
  cameraNames,
  before
) {
  cameraNames.forEach(cameraName => {
    assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      before.get(cameraName)
    );
  });
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

test("overflow cameras survive smaller layouts and reappear with identity intact", t => {
  const harness = setup(t);
  const cameras = [
    { name: "Front", entity: "camera.front", active: true },
    { name: "Garage", entity: "camera.garage", active: true },
    { name: "Patio", entity: "camera.patio", active: true },
    { name: "Hall", entity: "camera.hall", active: true },
    { name: "Drive", entity: "camera.drive", active: true },
    { name: "Yard", entity: "camera.yard", active: true }
  ];
  const cameraNames = cameras.map(camera => camera.name);
  const card = harness.createCard({ cameras });

  card.selectLayout("3x3");
  cameraNames.forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const before = captureIdentities(
    harness,
    card,
    cameraNames
  );

  card.selectLayout("2x2");
  harness.flushAnimationFrames();

  assert.equal(card._layout, "2x2");
  assert.deepEqual(assignments(card).slice(0, 6), cameraNames);
  assert.equal(
    harness.getLogicalCell(card, 4).classList.contains("hidden-slot"),
    true
  );
  assert.equal(
    harness.getLogicalCell(card, 5).classList.contains("hidden-slot"),
    true
  );
  assertIdentitiesUnchanged(
    harness,
    card,
    cameraNames,
    before
  );

  card.selectLayout("3x3");
  harness.flushAnimationFrames();

  assert.equal(card._layout, "3x3");
  assert.deepEqual(assignments(card).slice(0, 6), cameraNames);
  assert.equal(
    harness.getLogicalCell(card, 4).classList.contains("hidden-slot"),
    false
  );
  assert.equal(
    harness.getLogicalCell(card, 5).classList.contains("hidden-slot"),
    false
  );
  assertIdentitiesUnchanged(
    harness,
    card,
    cameraNames,
    before
  );
});

test("unassigned camera replacement keeps the maximized slot and unaffected players", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const unaffectedNames = ["Front", "Patio"];
  const unaffectedBefore = captureIdentities(
    harness,
    card,
    unaffectedNames
  );
  const garageBefore =
    harness.capturePlayerIdentity(card, "Garage");
  const maximizedCell = harness.getLogicalCell(card, 1);

  card.maximizeCameraSlot(1);
  card.replaceMaximizedCamera("Hall");
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, 1);
  assert.equal(card._assignedCameras[1], "Hall");
  assert.strictEqual(harness.getLogicalCell(card, 1), maximizedCell);
  assert.equal(maximizedCell.classList.contains("maximized-camera"), true);
  assert.equal(
    card.querySelector(".video-grid").classList.contains(
      "camera-maximized"
    ),
    true
  );
  assert.equal(garageBefore.player.isConnected, false);
  assert.equal(garageBefore.player.disconnectedCount, 1);
  assert.equal(harness.getPlayer(card, "Garage"), null);
  assert.ok(harness.getPlayer(card, "Hall"));
  assertIdentitiesUnchanged(
    harness,
    card,
    unaffectedNames,
    unaffectedBefore
  );

  card.restoreMaximizedCamera();
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, null);
  assert.equal(card._layout, "2x2");
  assert.equal(card._assignedCameras[1], "Hall");
  assert.strictEqual(
    harness.getPlayer(card, "Hall").closest(".video-cell"),
    maximizedCell
  );
  assertIdentitiesUnchanged(
    harness,
    card,
    unaffectedNames,
    unaffectedBefore
  );
});

test("assigned camera replacement transfers maximize state and self replacement is a no-op", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio", "Hall"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const patioBefore =
    harness.capturePlayerIdentity(card, "Patio");
  const garageBefore =
    harness.capturePlayerIdentity(card, "Garage");
  const unaffectedNames = ["Front", "Hall"];
  const unaffectedBefore = captureIdentities(
    harness,
    card,
    unaffectedNames
  );

  card.maximizeCameraSlot(1);
  card.replaceMaximizedCamera("Patio");
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    "Patio",
    null,
    "Hall"
  ]);
  assert.equal(card._maximizedSlot, 1);
  assert.strictEqual(harness.getLogicalCell(card, 1), patioBefore.cell);
  assert.strictEqual(harness.getPlayer(card, "Patio"), patioBefore.player);
  assert.equal(patioBefore.cell.classList.contains("maximized-camera"), true);
  assert.equal(garageBefore.player.isConnected, false);
  assert.equal(garageBefore.player.disconnectedCount, 1);
  assert.equal(harness.getPlayer(card, "Garage"), null);
  assertIdentityUnchanged(harness, card, "Patio", patioBefore);
  assertIdentitiesUnchanged(
    harness,
    card,
    unaffectedNames,
    unaffectedBefore
  );

  const assignmentsBeforeNoOp = assignments(card);
  const patioBeforeNoOp =
    harness.capturePlayerIdentity(card, "Patio");
  const maximizedCellsBefore = [
    ...card.querySelectorAll(".video-cell.maximized-camera")
  ];

  card.replaceMaximizedCamera("Patio");
  harness.flushAnimationFrames();

  assert.deepEqual(assignments(card), assignmentsBeforeNoOp);
  assert.equal(card._maximizedSlot, 1);
  assert.deepEqual(
    [...card.querySelectorAll(".video-cell.maximized-camera")],
    maximizedCellsBefore
  );
  assertIdentityUnchanged(
    harness,
    card,
    "Patio",
    patioBeforeNoOp
  );
  assertIdentitiesUnchanged(
    harness,
    card,
    unaffectedNames,
    unaffectedBefore
  );
});

test("layout change while maximized restores first and then repacks", t => {
  const harness = setup(t);
  const card = harness.createCard();

  ["Front", "Garage", "Patio", "Hall"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();
  card.removeCameraFromSlot(1);

  const survivorNames = ["Front", "Patio", "Hall"];
  const survivorBefore = captureIdentities(
    harness,
    card,
    survivorNames
  );

  card.maximizeCameraSlot(2);
  card.restoreMaximizedCamera();
  card.selectLayout("3x3");
  harness.flushAnimationFrames();

  assert.equal(card._maximizedSlot, null);
  assert.equal(
    card.querySelector(".video-grid").classList.contains(
      "camera-maximized"
    ),
    false
  );
  assert.equal(
    card.querySelectorAll(".video-cell.maximized-camera").length,
    0
  );
  assert.equal(card._layout, "3x3");
  assert.deepEqual(assignments(card).slice(0, 4), [
    "Front",
    "Patio",
    "Hall",
    null
  ]);

  survivorNames.forEach((cameraName, logicalSlot) => {
    const identity = assertIdentityUnchanged(
      harness,
      card,
      cameraName,
      survivorBefore.get(cameraName)
    );
    assert.strictEqual(
      identity.cell,
      harness.getLogicalCell(card, logicalSlot)
    );
  });
});

test("sidebar and 600px responsive transitions preserve every player and cell", t => {
  const harness = setup(t);
  const card = harness.createCard({ shellWidth: 601 });

  ["Front", "Garage", "Patio"].forEach(cameraName => {
    card.assignCamera(cameraName);
  });
  harness.flushAnimationFrames();

  const cameraNames = ["Front", "Garage", "Patio"];
  const before = captureIdentities(
    harness,
    card,
    cameraNames
  );
  const shell = card.querySelector(".nvr-shell");
  const sidebar = card.querySelector(".nvr-sidebar");
  const toggle = card.querySelector(".sidebar-toggle");

  assert.equal(shell.classList.contains("phone-layout"), false);
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(sidebar.getAttribute("aria-hidden"), "false");

  harness.setShellWidth(card, 600);
  harness.flushAnimationFrames();

  assert.equal(shell.classList.contains("phone-layout"), true);
  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(sidebar.getAttribute("aria-hidden"), "true");
  assertIdentitiesUnchanged(harness, card, cameraNames, before);

  harness.setShellWidth(card, 601);
  harness.flushAnimationFrames();

  assert.equal(shell.classList.contains("phone-layout"), false);
  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(sidebar.getAttribute("aria-hidden"), "false");

  toggle.click();
  harness.flushAnimationFrames();

  assert.equal(shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(sidebar.getAttribute("aria-hidden"), "true");
  assertIdentitiesUnchanged(harness, card, cameraNames, before);

  toggle.click();
  harness.flushAnimationFrames();

  assert.equal(shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(sidebar.getAttribute("aria-hidden"), "false");
  assertIdentitiesUnchanged(harness, card, cameraNames, before);
});
