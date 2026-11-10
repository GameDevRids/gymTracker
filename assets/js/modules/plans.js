import { fetchPlans } from "../api/plansApi.js";
import { apiClient } from "../api/apiClient.js";
import { openModal, closeModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { escapeHTML, formatINR } from "../utils.js";

const pageSize = 12;
let plans = [];
let pagination = { page: 1, total: 0, totalPages: 0 };
let search = "";
let status = "all";
let loading = false;
let errorMessage = "";
let requestVersion = 0;
let searchTimer;
let saving = false;

const heading = `<div class="page-heading"><div><h1>Membership plans</h1><p>Manage the membership packages offered by your gym.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="refresh-plans">↻ Refresh</button><button class="button button-primary" data-action="add-plan">＋ Create plan</button></div></div>`;

export function renderPlansPage() {
    const toolbar = `<div class="toolbar"><input class="search-field" id="plan-search" type="search" placeholder="Search plan names…" aria-label="Search plans" value="${escapeHTML(search)}"><select id="plan-status-filter" class="field-control" aria-label="Filter plans by status"><option value="all" ${status === "all" ? "selected" : ""}>All plans</option><option value="active" ${status === "active" ? "selected" : ""}>Active</option><option value="inactive" ${status === "inactive" ? "selected" : ""}>Inactive</option></select><span class="toolbar-spacer"></span><span class="helper-text">${pagination.total} plan${pagination.total === 1 ? "" : "s"}</span></div>`;
    if (loading) {
        return `${heading}${toolbar}<section class="card"><div class="empty-state" role="status">Loading membership plans…</div></section>`;
    }
    if (errorMessage) {
        return `${heading}${toolbar}<section class="card"><div class="empty-state"><p>${escapeHTML(errorMessage)}</p><button class="button button-secondary" data-action="refresh-plans">Try again</button></div></section>`;
    }

    const cards = plans.map((plan) => `<article class="card plan-card">
        <div class="plan-card-heading"><h3>${escapeHTML(plan.name)}</h3><span class="status status-${plan.is_active ? "active" : "inactive"}">${plan.is_active ? "Active" : "Inactive"}</span></div>
        <div class="plan-price">${formatINR(plan.price)}<small> / ${plan.duration_days} days</small></div>
        <p>${escapeHTML(plan.description || "No description provided.")}</p>
        <div class="plan-card-footer"><span class="helper-text">Updated ${plan.updated_at ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(plan.updated_at)) : "—"}</span>
            <span class="inline-actions"><button class="text-button" data-action="edit-plan" data-id="${escapeHTML(plan.id)}">Edit</button><button class="text-button" data-action="toggle-plan" data-id="${escapeHTML(plan.id)}">${plan.is_active ? "Deactivate" : "Activate"}</button><button class="text-button" data-action="delete-plan" data-id="${escapeHTML(plan.id)}">Delete</button></span>
        </div>
    </article>`).join("");
    const empty = `<section class="card"><div class="empty-state">${search || status !== "all" ? "No plans match your search or filter." : "No membership plans yet. Create a plan to get started."}</div></section>`;
    const paginationControls = pagination.totalPages > 1
        ? `<div class="toolbar" aria-label="Plan pagination"><span class="toolbar-spacer"></span><button class="button button-secondary" data-action="previous-plans-page" ${pagination.page <= 1 ? "disabled" : ""}>Previous</button><span class="helper-text">Page ${pagination.page} of ${pagination.totalPages}</span><button class="button button-secondary" data-action="next-plans-page" ${pagination.page >= pagination.totalPages ? "disabled" : ""}>Next</button></div>`
        : "";
    return `${heading}${toolbar}<div class="summary-row"><span class="summary-chip"><strong>${pagination.total}</strong> plans</span><span class="summary-chip"><strong>${plans.filter((plan) => plan.is_active).length}</strong> active on this page</span></div>${cards ? `<div class="grid plan-grid">${cards}</div>` : empty}${paginationControls}`;
}

export async function loadPlans(onRender = () => {}) {
    const version = ++requestVersion;
    loading = true;
    errorMessage = "";
    onRender();
    try {
        const response = await fetchPlans({
            page: pagination.page,
            limit: pageSize,
            ...(status === "all" ? {} : { status }),
            ...(search ? { search } : {})
        });
        if (version !== requestVersion) return;
        plans = Array.isArray(response?.data?.plans) ? response.data.plans : [];
        const page = response?.page ?? response?.data?.pagination?.page ?? 1;
        const total = response?.total ?? response?.data?.pagination?.total ?? plans.length;
        pagination = {
            page,
            total,
            totalPages: response?.data?.pagination?.totalPages ?? Math.ceil(total / pageSize)
        };
        loading = false;
        onRender();
    } catch (error) {
        if (version !== requestVersion) return;
        loading = false;
        errorMessage = error.message || "Unable to load membership plans.";
        onRender();
    }
}

export function setPlanSearch(value, onRender) {
    search = value.trim();
    pagination.page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPlans(onRender), 250);
}

export function setPlanStatus(value, onRender) {
    status = value;
    pagination.page = 1;
    loadPlans(onRender);
}

export function openPlanForm(planId = "") {
    const plan = plans.find((item) => item.id === planId);
    if (planId && !plan) {
        toast("Plan was not found. Refresh the list and try again.", "error");
        return;
    }
    const editing = Boolean(plan);
    openModal({
        title: editing ? "Edit membership plan" : "Create membership plan",
        body: `<form id="plan-form" data-id="${escapeHTML(plan?.id || "")}" class="form-grid" novalidate>
            <div class="field"><label for="form-name">Plan name *</label><input id="form-name" name="name" value="${escapeHTML(plan?.name || "")}" required maxlength="120" aria-describedby="plan-name-error"><span id="plan-name-error" class="helper-text plan-error" role="alert" hidden>Plan name is required and cannot contain only spaces.</span></div>
            <div class="field"><label for="form-duration_days">Duration (days) *</label><input id="form-duration_days" name="duration_days" type="number" value="${escapeHTML(plan?.duration_days ?? "")}" required min="1" step="1" aria-describedby="plan-duration-error"><span id="plan-duration-error" class="helper-text plan-error" role="alert" hidden>Duration must be a positive whole number of days.</span></div>
            <div class="field"><label for="form-price">Price (₹) *</label><input id="form-price" name="price" type="number" value="${escapeHTML(plan?.price ?? "")}" required min="0" step="0.01" aria-describedby="plan-price-error"><span id="plan-price-error" class="helper-text plan-error" role="alert" hidden>Price must be a valid non-negative number.</span></div>
            <div class="field"><label for="form-is_active">Availability</label><select id="form-is_active" name="is_active"><option value="true" ${plan?.is_active !== false ? "selected" : ""}>Active</option><option value="false" ${plan?.is_active === false ? "selected" : ""}>Inactive</option></select></div>
            <div class="field full"><label for="form-description">Description</label><textarea id="form-description" name="description" maxlength="2000">${escapeHTML(plan?.description || "")}</textarea></div>
        </form>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-primary" type="submit" form="plan-form">Save plan</button>`
    });
}

function showDeleteConfirmation(plan) {
    openModal({
        title: "Delete membership plan?",
        body: `<p class="confirm-copy">Delete <strong>${escapeHTML(plan.name)}</strong>? Plans with related membership or payment records cannot be deleted; deactivate those plans instead.</p>`,
        footer: `<button class="button button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button button-danger" data-action="confirm-delete-plan" data-id="${escapeHTML(plan.id)}">Delete plan</button>`
    });
}

function renderAfterMutation(onRender) {
    closeModal();
    loadPlans(onRender);
}

export function handlePlanAction(action, target, onRender) {
    const id = target.dataset.id || "";
    if (action === "add-plan") openPlanForm();
    else if (action === "edit-plan") openPlanForm(id);
    else if (action === "delete-plan") {
        const plan = plans.find((item) => item.id === id);
        if (plan) showDeleteConfirmation(plan);
        else toast("Plan was not found. Refresh the list and try again.", "error");
    } else if (action === "refresh-plans") {
        loadPlans(onRender);
    } else if (action === "previous-plans-page" || action === "next-plans-page") {
        pagination.page += action === "next-plans-page" ? 1 : -1;
        loadPlans(onRender);
    } else if (action === "toggle-plan") {
        const plan = plans.find((item) => item.id === id);
        if (!plan) {
            toast("Plan was not found. Refresh the list and try again.", "error");
        } else {
            apiClient.put(`/api/plans/${id}`, { is_active: !plan.is_active })
                .then((response) => {
                    plans = plans.map((item) => item.id === id ? response.data : item);
                    toast(`Plan ${response.data.is_active ? "activated" : "deactivated"}.`);
                    onRender();
                })
                .catch((error) => toast(error.message || "Unable to update plan status.", "error"));
        }
    } else if (action === "confirm-delete-plan") {
        apiClient.delete(`/api/plans/${id}`)
            .then(() => {
                toast("Membership plan deleted.");
                renderAfterMutation(onRender);
            })
            .catch((error) => toast(error.message || "Unable to delete plan.", "error"));
    } else {
        return false;
    }
    return true;
}

function setFieldError(form, field, invalid) {
    const error = form.querySelector(`#plan-${field}-error`);
    if (error) error.hidden = !invalid;
}

export async function handlePlanSubmit(form, onRender) {
    if (saving) return;
    const values = new FormData(form);
    const name = String(values.get("name") || "").trim();
    const duration = Number(values.get("duration_days"));
    const priceValue = String(values.get("price") || "").trim();
    const price = Number(priceValue);
    const nameInvalid = !name;
    const durationInvalid = !Number.isInteger(duration) || duration <= 0;
    const priceInvalid = !priceValue || !Number.isFinite(price) || price < 0;
    setFieldError(form, "name", nameInvalid);
    setFieldError(form, "duration", durationInvalid);
    setFieldError(form, "price", priceInvalid);
    if (nameInvalid || durationInvalid || priceInvalid) return;

    const payload = {
        name,
        description: String(values.get("description") || "").trim() || null,
        duration_days: duration,
        price,
        is_active: values.get("is_active") === "true"
    };
    const id = form.dataset.id;
    saving = true;
    const submitButton = document.querySelector('[type="submit"][form="plan-form"]');
    if (submitButton) submitButton.disabled = true;
    try {
        const response = id
            ? await apiClient.put(`/api/plans/${id}`, payload)
            : await apiClient.post("/api/plans", payload);
        const updated = response?.data;
        if (!updated) throw new Error("The server did not return the saved plan.");
        plans = id ? plans.map((plan) => plan.id === id ? updated : plan) : [updated, ...plans];
        toast(id ? "Membership plan updated." : "Membership plan created.");
        await loadPlans(onRender);
        closeModal();
    } catch (error) {
        toast(error.message || "Unable to save membership plan.", "error");
    } finally {
        saving = false;
        if (submitButton?.isConnected) submitButton.disabled = false;
    }
}
