import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestHarness } from './helpers/nvr-card-harness.js';
const cameras = ['A','Disabled','B','C'].map(name => ({name, entity:`camera.${name.toLowerCase()}`, active:name !== 'Disabled', live:{substream:`camera.${name}_sub`, mainstream:`camera.${name}_main`}}));
function setup(t, list = cameras) {
  const h = createTestHarness(); t.after(() => h.close());
  const card = h.createCard({cameras:list});
  card.assignCamera(list[0].name);
  const cell = h.getLogicalCell(card,0);
  const fire = (type, options = {}) => cell.dispatchEvent(new h.window.PointerEvent(type, {bubbles:true, composed:true, cancelable:true, pointerId:1, isPrimary:true, pointerType:'touch', clientX:100, clientY:100, ...options}));
  const swipe = (dx=100, options={}) => {fire('pointerdown',options); fire('pointerup',{...options,clientX:100+dx});};
  return {h,card,cell,fire,swipe};
}
for (const type of ['touch','pen']) test(`swipe ${type}: next, previous, wrap and skip disabled in menu order`, t => {
  const x=setup(t); x.card.maximizeCameraSlot(0);
  assert.deepEqual(Array.from(x.card.getEnabledCameras(),c=>c.name),['A','B','C']);
  for (const [dx,name] of [[100,'B'],[100,'C'],[100,'A'],[-100,'C'],[-100,'B']]) {
    x.swipe(dx,{pointerType:type});
    assert.equal(x.card.getPresentationCameraName(0),name);
    assert.equal(x.cell.querySelector('hui-image').dataset.entity,`camera.${name.toLowerCase()}`);
    assert.equal(x.cell.querySelector('hui-image').cameraImage,`camera.${name}_main`);
    assert.equal(x.cell.querySelector('.cell-camera-name').textContent,name);
    assert.equal(x.card._maximizedSlot,0);
  }
});
for (const [name, options, dx, dy, maximize] of [
  ['grid',{},100,0,false],['mouse',{pointerType:'mouse'},100,0,true],
  ['short',{},59,0,true],['vertical',{},100,100,true],['secondary',{isPrimary:false},100,0,true]
]) test(`swipe ignores ${name}`,t=>{
  const x=setup(t); if(maximize)x.card.maximizeCameraSlot(0);
  x.fire('pointerdown',options); x.fire('pointerup',{...options,clientX:100+dx,clientY:100+dy});
  assert.equal(x.card.getPresentationCameraName(0),'A');
});
test('swipe one camera is a no-op',t=>{const x=setup(t,[cameras[0]]);x.card.maximizeCameraSlot(0);const image=x.cell.querySelector('hui-image');x.swipe();assert.equal(x.cell.querySelector('hui-image'),image);});
test('swipe cancellation and stale pointer IDs',t=>{
 const x=setup(t);x.card.maximizeCameraSlot(0);x.fire('pointerdown');x.fire('pointerup',{pointerId:2,clientX:200});
 assert.equal(x.card.getPresentationCameraName(0),'A');assert.ok(x.card._maximizedSwipe);
 x.fire('pointercancel');assert.equal(x.card._maximizedSwipe,null);x.fire('pointerup',{clientX:200});assert.equal(x.card.getPresentationCameraName(0),'A');
});
test('swipe preserves original grid, workspace and Saved Views through double click restore',t=>{
 const x=setup(t);x.card.assignCameraToSlot('C',2); const before=JSON.stringify(x.card.captureViewState());
 x.card.saveCurrentViewAs('Original');x.card.maximizeCameraSlot(0);
 const persisted=JSON.stringify(x.h.userStateBackend.get(x.card.getWorkspacePersistenceKey()));
 const assignments=Array.from(x.card._assignedCameras);const other=x.h.getLogicalCell(x.card,2).querySelector('hui-image');
 x.card.render=()=>assert.fail('full render');x.card.maximizeCameraSlot=()=>assert.fail('remaximize');
 for(let i=0;i<7;i++)x.swipe();
 assert.deepEqual(Array.from(x.card._assignedCameras),assignments);
 assert.equal(JSON.stringify(x.h.userStateBackend.get(x.card.getWorkspacePersistenceKey())),persisted);
 assert.equal(x.h.getLogicalCell(x.card,2).querySelector('hui-image'),other);
 // A new ordinary tap sequence is independent of the preceding swipe click.
 x.fire('pointerdown');x.fire('pointerup');
 x.cell.dispatchEvent(new x.h.window.MouseEvent('dblclick',{bubbles:true,cancelable:true}));
 assert.equal(JSON.stringify(x.card.captureViewState()),before);
 assert.equal(x.cell.querySelector('hui-image').cameraImage,cameras[0].live.substream);
});
test('swipe suppresses compatibility click/double click but preserves non-swipe double click',t=>{
 const x=setup(t);x.card.maximizeCameraSlot(0);x.swipe();
 x.cell.dispatchEvent(new x.h.window.MouseEvent('dblclick',{bubbles:true,cancelable:true}));assert.equal(x.card._maximizedSlot,0);
 x.fire('pointerdown');x.fire('pointerup');x.cell.dispatchEvent(new x.h.window.MouseEvent('dblclick',{bubbles:true,cancelable:true}));assert.equal(x.card._maximizedSlot,null);
});
test('swipe tracking clears on detach, restore and reconstruction',t=>{
 const x=setup(t);x.card.maximizeCameraSlot(0);x.fire('pointerdown');x.card.remove();assert.equal(x.card._maximizedSwipe,null);
 x.h.window.document.body.appendChild(x.card);x.fire('pointerdown');x.card.restoreMaximizedCamera();assert.equal(x.card._maximizedSwipe,null);
 x.card.maximizeCameraSlot(0);x.fire('pointerdown');x.card.render();assert.equal(x.card._maximizedSwipe,null);assert.equal(x.card._maximizedCameraOverride,null);
});
test('swipe liveness and one-shot recovery follow new Main presentation and reject old frames',t=>{
 const x=setup(t);x.card.setConfig({...x.card.config,live_recovery:{enabled:true,reconnect_after:60}});x.card.maximizeCameraSlot(0);
 const old=x.cell.querySelector('hui-image');const state=x.card._reconnectPresentationDiagnostics.get(old);
 const root=old.attachShadow({mode:'open'});const video=x.h.window.document.createElement('video');let callback;
 video.requestVideoFrameCallback=cb=>{callback=cb;return 1;};video.cancelVideoFrameCallback=()=>{};root.appendChild(video);x.card.inspectReconnectPresentation(state);
 x.swipe();const image=x.cell.querySelector('hui-image');const next=x.card._reconnectPresentationDiagnostics.get(image);
 callback();assert.equal(state.active,false);assert.equal(next.logicalCamera,'B');assert.equal(next.cameraImage,'camera.B_main');
 x.h.advanceTime(10000);assert.equal(next.visualState,'stalled');x.h.advanceTime(60000);
 const replacement=x.cell.querySelector('hui-image');assert.notEqual(replacement,image);assert.equal(replacement.dataset.entity,'camera.b');assert.equal(replacement.cameraImage,'camera.B_main');
 x.h.advanceTime(100000);assert.equal(x.cell.querySelector('hui-image'),replacement);
 const snapshots=[];x.card.logReconnect=(event,data)=>{if(event==='reconnect-snapshot')snapshots.push(data);};x.card.captureReconnectSnapshot('test');assert.equal(snapshots.at(-1).cells[0].expectedLiveSourceEntity,'camera.B_main');
});
test('auto-dim consumed wake touch cannot swipe',t=>{
 const x=setup(t);x.card.setConfig({...x.card.config,auto_dim:{enabled:true,notify_service:'notify.tablet',timeout:5,fade_duration:0}});
 x.card.hass = {states:{},callService:()=>({then(resolve){resolve();}})};x.card.maximizeCameraSlot(0);x.h.advanceTime(5000);
 assert.equal(x.card._autoDimState,'dimmed');x.swipe();assert.equal(x.card.getPresentationCameraName(0),'A');assert.equal(x.card._maximizedSwipe,null);
});

test('swipe ignores sidebar gestures and never navigates during movement', t => {
 const x=setup(t);x.card.maximizeCameraSlot(0);
 const sidebar=x.card.querySelector('.nvr-sidebar');
 for(const [type,clientX] of [['pointerdown',100],['pointerup',200]])sidebar.dispatchEvent(new x.h.window.PointerEvent(type,{bubbles:true,composed:true,pointerType:'touch',pointerId:1,isPrimary:true,clientX,clientY:100}));
 assert.equal(x.card.getPresentationCameraName(0),'A');
 x.fire('pointerdown');x.fire('pointermove',{clientX:200});assert.equal(x.card.getPresentationCameraName(0),'A');x.fire('pointerup',{clientX:200});assert.equal(x.card.getPresentationCameraName(0),'B');
});
test('swipe abandons long gestures, leaving grid, and retired presentations',t=>{
 const x=setup(t);x.card.maximizeCameraSlot(0);x.fire('pointerdown');x.h.advanceTime(3001);x.fire('pointerup',{clientX:200});assert.equal(x.card.getPresentationCameraName(0),'A');
 x.fire('pointerdown');x.card.querySelector('.video-grid').dispatchEvent(new x.h.window.PointerEvent('pointerleave'));assert.equal(x.card._maximizedSwipe,null);
 x.fire('pointerdown');x.card.renderSlot(0);assert.equal(x.card._maximizedSwipe,null);
});
test('swipe keeps one presentation per existing cell and survives reattach with correct logical camera',t=>{
 const x=setup(t);x.card.assignCameraToSlot('B',1);x.card.maximizeCameraSlot(0);const count=x.card.querySelectorAll('hui-image').length;
 x.swipe();assert.equal(x.card.querySelectorAll('hui-image').length,count);assert.equal(x.cell.querySelectorAll('hui-image').length,1);
 x.card.remove();x.h.window.document.body.appendChild(x.card);
 const image=x.cell.querySelector('hui-image');assert.equal(x.card._reconnectPresentationDiagnostics.get(image).logicalCamera,'B');assert.equal(image.cameraImage,'camera.B_main');
 x.card.restoreMaximizedCamera();assert.equal(x.cell.querySelector('hui-image').cameraImage,'camera.A_sub');
});
