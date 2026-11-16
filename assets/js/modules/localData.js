// "Move my saved data to the cloud": the one-time move of what an older version of GymPulse
// kept only in this browser (settings, the expiry reminder message, "Reminded" marks, check-ins,
// gym phone and address). Only values the gym has not saved yet are filled in. Afterwards the
// browser's copy is deleted and the app never reads it again.
import { savedBrowserWorkspace, forgetSavedBrowserWorkspace } from "../state.js";
import { readLegacyLanguage } from "../storage.js";
import { apiClient } from "../api/apiClient.js";
import { openModal, closeModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { downloadCSV, escapeHTML } from "../utils.js";
import { collectLocalData } from "../localDataMove.js";
import { importLegacyCheckIns } from "./attendance.js";
import { gymSettings } from "./upiPayments.js";

let moving = false;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What this browser still holds from an older version, or null when there is nothing saved. */
export function localDataToMove() {
    return collectLocalData(savedBrowserWorkspace(), { legacyLanguage: readLegacyLanguage() });
}

/** Deletes a browser copy that holds nothing worth moving (for example old copies of members). */
export function forgetEmptyLocalData() {
    const data = localDataToMove();
    if (savedBrowserWorkspace() && !data?.any) forgetSavedBrowserWorkspace();
}

function itemList(data) {
    const items = [];
    const preferenceNames = { language: "language", date_format: "date format", expiry_reminder_days: "reminder window", payment_reminders: "payment reminder previews", inactivity_reminders: "inactive-member previews" };
    const preferences = Object.keys(data.preferences).map((key) => preferenceNames[key]);
    if (preferences.length) items.push(`Settings: ${preferences.join(", ")}`);
    if (data.contact.phone || data.contact.address) items.push("Gym phone and address");
    if (data.reminderTemplate) items.push("Your expiry reminder message");
    if (data.reminders.length) items.push(`${plural(data.reminders.length, "“Reminded” mark")} on Expiring soon`);
    if (data.checkIns) items.push(plural(data.checkIns, "check-in"));
    return items;
}

/** The Settings card, shown while this browser still has something to move. */
export function renderLocalDataSettings() {
    const data = localDataToMove();
    if (!data?.any) return "";
    return `<section class="card settings-section note-card" id="local-data-settings"><h2>Saved only in this browser</h2><p class="helper-text">An older version of GymPulse kept some of your data only on this device. Move it to your gym's database so every phone sees the same.</p><button class="button button-secondary" type="button" data-action="open-local-data">Move my saved data to the cloud</button></section>`;
}

export function openLocalDataDialog() {
    const data = localDataToMove();
    if (!data?.any) return false;
    const items = itemList(data);
    const old = data.oldRecords.length
        ? `<div class="note-box" style="margin-top:12px"><p><strong>${plural(data.oldRecords.length, "old record")}</strong> (members, payments or renewals) from a version before the database can't be matched to your members. Download them to check by hand; they are deleted with the rest of this browser's copy.</p><button class="button button-secondary button-small" type="button" data-action="download-local-records">Download old records (CSV)</button></div>`
        : "";
    openModal({
        title: "Move my saved data to the cloud",
        subtitle: "One time only. Nothing you have already saved in GymPulse is overwritten.",
        body: `<p>An older version of GymPulse saved these only in this browser:</p>
            ${items.length ? `<ul class="local-data-list">${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : ""}
            ${old}
            <p class="helper-text" style="margin-top:12px">Settings you have already chosen for your gym are kept. "Reminded" marks are moved only for members who agreed to WhatsApp updates and whose plan still ends on the same day. After the move, this browser's copy is deleted.</p>
            <p class="helper-text" id="local-data-progress" role="status" aria-live="polite"></p>`,
        footer: `<button class="button button-secondary" type="button" data-action="close-modal">Not now</button><button class="button button-primary" type="button" data-action="move-local-data">Move to the cloud</button>`
    });
    return true;
}

async function moveLocalData(onDone) {
    const data = localDataToMove();
    if (!data?.any || moving) return;
    moving = true;
    const progress = document.querySelector("#local-data-progress");
    const buttons = document.querySelectorAll('#modal-root [data-action="move-local-data"], #modal-root [data-action="close-modal"]');
    buttons.forEach((button) => { button.disabled = true; });
    const say = (text) => { if (progress?.isConnected) progress.textContent = text; };
    try {
        say("Moving settings and reminders…");
        const response = await apiClient.post("/api/gym-settings/import-local", {
            ...(Object.keys(data.preferences).length ? { preferences: data.preferences } : {}),
            ...(data.reminderTemplate ? { expiry_reminder_template: data.reminderTemplate } : {}),
            ...(data.reminders.length ? { expiry_reminders: data.reminders } : {})
        });
        // Gym phone and address: only when the gym has not saved its own yet.
        const saved = gymSettings.data || {};
        const contact = {
            ...(data.contact.phone && !saved.phone ? { phone: data.contact.phone } : {}),
            ...(data.contact.address && !saved.address ? { address: data.contact.address.slice(0, 300) } : {})
        };
        if (Object.keys(contact).length) {
            await apiClient.put("/api/gym-settings", contact).catch((error) => {
                throw new Error(`The gym phone or address could not be moved: ${error.message}`);
            });
        }
        let checkIns = null;
        if (data.checkIns) {
            say("Moving check-ins…");
            checkIns = await importLegacyCheckIns();
        }
        forgetSavedBrowserWorkspace();
        const result = response?.data || {};
        const parts = [
            result.preferences_filled?.length ? plural(result.preferences_filled.length, "setting") : "",
            result.reminder_message_saved ? "the reminder message" : "",
            result.reminders?.moved ? plural(result.reminders.moved, "reminder mark") : "",
            checkIns?.imported ? plural(checkIns.imported, "check-in") : ""
        ].filter(Boolean);
        closeModal();
        toast(parts.length ? `Moved to the cloud: ${parts.join(", ")}. This browser's copy was deleted.` : "Everything was already saved in the cloud. This browser's copy was deleted.");
        onDone();
    } catch (error) {
        say("");
        buttons.forEach((button) => { if (button.isConnected) button.disabled = false; });
        toast(`${error.message || "The move did not finish."} Nothing was deleted from this browser; try again.`, "error");
    } finally {
        moving = false;
    }
}

/** Buttons of the move dialog and the Settings card. Returns true when handled. */
export function handleLocalDataAction(action, onDone) {
    if (action === "open-local-data") { openLocalDataDialog(); return true; }
    if (action === "move-local-data") { moveLocalData(onDone); return true; }
    if (action === "download-local-records") {
        const data = localDataToMove();
        try {
            downloadCSV("gympulse-old-browser-records.csv", data?.oldRecords || []);
        } catch (error) {
            toast(error.message || "The old records could not be downloaded.", "error");
        }
        return true;
    }
    return false;
}
