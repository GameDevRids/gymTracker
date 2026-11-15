// The member photo flow (assets/js/photoCapture.js): after "I agree", and after a photo is
// picked, the next step's buttons must respond. Regression test for the live bug where
// "Take photo", "Choose from gallery" and "Skip" did nothing after consent.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeContainer, installPhotoDom } from "./helpers/fakeDom.js";

let dom;
beforeEach(() => { dom = installPhotoDom(); });
afterEach(() => dom.restore());

const boot = installPhotoDom();
const { mountPhotoFlow } = await import("../../assets/js/photoCapture.js");
boot.restore();

const tap = (container, step) => container.tap(`[data-photo="${step}"]`);

test("after I agree, Take photo opens the back camera from the tap", async () => {
    const container = new FakeContainer();
    let consented = 0;
    mountPhotoFlow(container, { onConsent: async () => { consented += 1; }, onPhoto() {} });
    await tap(container, "agree");
    assert.equal(consented, 1);
    await tap(container, "camera");
    assert.deepEqual(dom.opened, [{ accept: "image/*", capture: "environment" }]);
});

test("after I agree, Choose from gallery opens the picker without the camera", async () => {
    const container = new FakeContainer();
    mountPhotoFlow(container, { onConsent: async () => {}, onPhoto() {} });
    await tap(container, "agree");
    await tap(container, "gallery");
    assert.deepEqual(dom.opened, [{ accept: "image/*", capture: null }]);
});

test("after I agree, Skip closes the flow", async () => {
    const container = new FakeContainer();
    let cancelled = 0;
    mountPhotoFlow(container, { onConsent: async () => {}, onPhoto() {}, onCancel: () => { cancelled += 1; }, cancelLabel: "Skip" });
    await tap(container, "agree");
    await tap(container, "cancel");
    assert.equal(cancelled, 1);
});

test("after a photo is picked, Choose again and Skip on the crop step respond", async () => {
    const container = new FakeContainer();
    let cancelled = 0;
    mountPhotoFlow(container, { needsConsent: false, onPhoto() {}, onCancel: () => { cancelled += 1; } });
    dom.pick();
    await tap(container, "gallery");
    container.button('[data-photo="use"]');
    await tap(container, "retake");
    container.button('[data-photo="camera"]');
    dom.pick();
    await tap(container, "camera");
    await tap(container, "cancel");
    assert.equal(cancelled, 1);
    assert.equal(dom.opened.length, 2);
});

test("a failed consent save keeps the consent buttons usable", async () => {
    const container = new FakeContainer();
    let attempts = 0;
    mountPhotoFlow(container, { onConsent: async () => { attempts += 1; if (attempts === 1) throw new Error("offline"); }, onPhoto() {} });
    await tap(container, "agree");
    assert.equal(container.querySelector("[data-photo-error]").textContent, "offline");
    await tap(container, "agree");
    await tap(container, "camera");
    assert.equal(dom.opened.length, 1);
});

test("startWith opens that picker at once, but never instead of the consent step", async () => {
    const straight = new FakeContainer();
    mountPhotoFlow(straight, { needsConsent: false, startWith: "camera", onPhoto() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(dom.opened, [{ accept: "image/*", capture: "environment" }]);
    assert.deepEqual(straight.buttonValues("photo"), ["camera", "gallery", "cancel"], "the choice stays on screen behind the picker");

    dom.opened.length = 0;
    const asks = new FakeContainer();
    mountPhotoFlow(asks, { needsConsent: true, startWith: "camera", onConsent: async () => {}, onPhoto() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(dom.opened, []);
    assert.deepEqual(asks.buttonValues("photo"), ["agree", "cancel"]);
});
