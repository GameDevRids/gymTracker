// The photo row at the top of the edit-member form (assets/js/modules/memberPhotos.js):
// Add when there is no photo, Change when there is, never Remove, and the member agrees first.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeContainer, installPhotoDom } from "./helpers/fakeDom.js";

const memberId = "00000000-0000-4000-8000-000000000011";
let dom;

beforeEach(() => { dom = installPhotoDom(); });
afterEach(() => dom.restore());

// Imported with the DOM globals in place: the modal module reads document when it loads.
const boot = installPhotoDom();
const { editPhotoField, mountEditPhoto } = await import("../../assets/js/modules/memberPhotos.js");
const { state } = await import("../../assets/js/state.js");
boot.restore();

function setMember(values = {}) {
    const member = { id: memberId, memberCode: "GP-0001", name: "Riya Shah", photoStatus: "none", photoConsent: false, ...values };
    state.members = [member];
    return member;
}

/** The form's photo row, mounted and ready to tap. */
function mountField(member, onChange = () => {}) {
    const slot = new FakeContainer("div", { "data-photo-slot": "" });
    const field = new FakeContainer("div", { class: "field full photo-field member-photo-field", "data-member-id": member.id });
    field.querySelectorAll = (selector) => (selector === "[data-photo-slot]" ? [slot] : []);
    const html = editPhotoField(member);
    slot.innerHTML = html.slice(html.indexOf("data-photo-slot>") + "data-photo-slot>".length);
    let onClick;
    field.addEventListener = (type, handler) => { if (type === "click") onClick = handler; };
    mountEditPhoto({ querySelector: (selector) => (selector === ".member-photo-field" ? field : null) }, onChange);
    return { slot, tap: async (step) => { await onClick({ target: slot.button(`[data-edit-photo="${step}"]`) }); await new Promise((resolve) => setTimeout(resolve, 0)); } };
}

test("a member with no photo gets Take photo and Choose from gallery, and no Remove", () => {
    const html = editPhotoField(setMember());
    assert.match(html, /Take photo/);
    assert.match(html, /Choose from gallery/);
    assert.doesNotMatch(html, /Change photo/);
    assert.doesNotMatch(html, /Remove/i);
    assert.doesNotMatch(html, /photo-remove/);
});

test("a member with a photo gets Change photo only, and no Remove", () => {
    const html = editPhotoField(setMember({ photoStatus: "approved", photoConsent: true }));
    assert.match(html, /Change photo/);
    assert.doesNotMatch(html, /Take photo/);
    assert.doesNotMatch(html, /Remove/i);
    assert.match(html, /data-photo-member="00000000-0000-4000-8000-000000000011"/, "the photo itself is shown");
});

test("a photo waiting for approval is not the member's photo here; the profile reviews it", () => {
    const html = editPhotoField(setMember({ photoStatus: "pending", photoConsent: true }));
    assert.match(html, /Take photo/);
    assert.doesNotMatch(html, /Approve|Reject/i);
});

test("the row is left out for a member who is not saved yet", () => {
    assert.equal(editPhotoField({ id: memberId, name: "Riya Shah" }), "");
});

test("the member agrees before the first photo: Take photo shows the consent step, not the camera", async () => {
    const field = mountField(setMember());
    await field.tap("camera");
    assert.deepEqual(field.slot.buttonValues("photo"), ["agree", "cancel"]);
    assert.deepEqual(dom.opened, [], "no picker opens before the member agrees");
    assert.match(field.slot.elements.map((element) => element.textContent).join(" "), /kept only inside this gym/i);
});

test("once the member has agreed, Take photo opens the back camera from that tap", async () => {
    const field = mountField(setMember({ photoConsent: true }));
    await field.tap("camera");
    assert.deepEqual(dom.opened, [{ accept: "image/*", capture: "environment" }]);
});

test("Choose from gallery opens the picker without the camera", async () => {
    const field = mountField(setMember({ photoConsent: true }));
    await field.tap("gallery");
    assert.deepEqual(dom.opened, [{ accept: "image/*", capture: null }]);
});

test("Change photo offers the camera and the gallery, and never a Remove", async () => {
    const field = mountField(setMember({ photoStatus: "approved", photoConsent: true }));
    await field.tap("change");
    assert.deepEqual(field.slot.buttonValues("photo"), ["camera", "gallery", "cancel"]);
    assert.deepEqual(dom.opened, [], "it asks which one first");
});
