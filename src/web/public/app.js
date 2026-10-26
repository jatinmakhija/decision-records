const main = document.querySelector("#main");
const statusFilter = document.querySelector("#status-filter");
const queryInput = document.querySelector("#q");

const hints = {
  Context: "The situation at the time. Not the reasoning.",
  Rationale: "Why this option won.",
  Alternatives: "Options you seriously considered.",
  Consequences: "What follows, including downsides.",
};

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options && options.headers) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function escape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function showList() {
  const params = new URLSearchParams();
  if (queryInput.value) params.set("q", queryInput.value);
  if (statusFilter.value) params.set("status", statusFilter.value);
  const records = await api(`/api/records?${params}`);
  const rows = records.length
    ? records.map((record) => {
        const tags = (record.tags || []).join(", ");
        return `<a class="row" href="#record/${record.id}">
          <span class="id">${escape(record.id.slice(0, 8))}</span>
          <span>${escape(record.createdAt.slice(0, 10))}</span>
          <span class="badge">${escape(record.status)}</span>
          <span>${escape(record.decision)}${tags ? ` <span class="meta">${escape(tags)}</span>` : ""}</span>
        </a>`;
      }).join("")
    : `<p class="empty">No decisions yet.</p>`;
  main.innerHTML = `<section class="capture">
      <form id="capture">
        <input id="sentence" placeholder="The decision, in one sentence" required />
        <div class="actions">
          <button type="submit" data-enriched="false">Save</button>
          <button type="submit" class="secondary" data-enriched="true">Save with sections</button>
        </div>
      </form>
    </section>
    <section class="list">${rows}</section>`;
  document.querySelector("#capture").addEventListener("submit", async (event) => {
    event.preventDefault();
    const enriched = event.submitter?.dataset.enriched === "true";
    const sentence = document.querySelector("#sentence").value;
    const saved = await api("/api/records", {
      method: "POST",
      body: JSON.stringify({ decision: sentence, enriched }),
    });
    if (saved.confluence) {
      const yes = window.confirm("Publish to Confluence?");
      if (yes) await api(`/api/records/${saved.record.id}/publish`, { method: "POST", body: "{}" });
    }
    if (enriched) location.hash = `#edit/${saved.record.id}`;
    else await showList();
  });
}

function sectionHtml(record) {
  return ["Context", "Rationale", "Alternatives", "Consequences"]
    .map((name) => {
      const text = record.sections?.[name];
      if (!text) return "";
      return `<h2>${name}</h2><p>${escape(text).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function moves(status) {
  if (status === "proposed") return ["decided", "rejected"];
  if (status === "decided") return ["superseded", "revoked"];
  return [];
}

async function showRecord(id) {
  const record = await api(`/api/records/${id}`);
  const when = record.decidedAt ? `Decided ${record.decidedAt}` : `Recorded ${record.createdAt}`;
  const people = [
    record.deciders?.length ? `Deciders: ${record.deciders.join(", ")}` : "",
    record.participants?.length ? `Participants: ${record.participants.join(", ")}` : "",
    record.recordedBy ? `Recorded by ${record.recordedBy}` : "",
    record.tags?.length ? record.tags.join(", ") : "",
  ].filter(Boolean).join(" · ");
  const buttons = moves(record.status).map((status) => `<button data-status="${status}">${status}</button>`).join("");
  main.innerHTML = `<article class="doc">
      <h1>${escape(record.decision)}</h1>
      <p class="meta">${escape(record.status)} · ${escape(when)}${people ? ` · ${escape(people)}` : ""}</p>
      ${sectionHtml(record) || `<p class="empty">No further detail yet.</p>`}
      <div class="actions">
        <a href="#edit/${record.id}"><button type="button">Edit</button></a>
        <button type="button" id="open-file">Open file</button>
        ${buttons}
      </div>
      <p class="meta" id="path"></p>
    </article>`;
  document.querySelector("#open-file").addEventListener("click", async () => {
    const opened = await api(`/api/records/${id}/open`, { method: "POST", body: "{}" });
    document.querySelector("#path").textContent = opened.path;
  });
  for (const button of main.querySelectorAll("[data-status]")) {
    button.addEventListener("click", async () => {
      if (button.dataset.status === "superseded") {
        const sentence = window.prompt("What replaces this decision?");
        if (!sentence) return;
        const saved = await api(`/api/records/${id}/transition`, {
          method: "POST",
          body: JSON.stringify({ status: "superseded", decision: sentence }),
        });
        location.hash = `#record/${saved.record.id}`;
        return;
      }
      const saved = await api(`/api/records/${id}/transition`, {
        method: "POST",
        body: JSON.stringify({ status: button.dataset.status }),
      });
      if (saved.confluence) {
        const yes = window.confirm("Publish to Confluence?");
        if (yes) await api(`/api/records/${id}/publish`, { method: "POST", body: "{}" });
      }
      await showRecord(id);
    });
  }
}

async function showEditor(id) {
  const record = await api(`/api/records/${id}`);
  const fields = ["Context", "Rationale", "Alternatives", "Consequences"].map((name) => {
    const value = record.sections?.[name] || "";
    return `<label><strong>${name}</strong><span>${hints[name]}</span>
      <textarea name="${name}">${escape(value)}</textarea></label>`;
  }).join("");
  main.innerHTML = `<form class="editor" id="editor">
      <h1>Edit decision</h1>
      <p class="meta id">${escape(record.id)}</p>
      <label><strong>Decision</strong><span>The choice, in one sentence.</span>
        <input name="decision" value="${escape(record.decision)}" required />
      </label>
      <div class="pair">
        <label><strong>Deciders</strong><span>People accountable for the choice.</span>
          <input name="deciders" value="${escape((record.deciders || []).join(", "))}" />
        </label>
        <label><strong>Participants</strong><span>People present who did not decide.</span>
          <input name="participants" value="${escape((record.participants || []).join(", "))}" />
        </label>
      </div>
      <label><strong>Tags</strong><span>Comma-separated labels.</span>
        <input name="tags" value="${escape((record.tags || []).join(", "))}" />
      </label>
      ${fields}
      <p class="warn" id="warn"></p>
      <div class="actions">
        <button type="submit">Save</button>
        <a class="secondary" href="#record/${record.id}">Cancel</a>
      </div>
    </form>`;
  document.querySelector("#editor").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const list = (name) => String(data.get(name) || "").split(",").map((item) => item.trim()).filter(Boolean);
    const saved = await api(`/api/records/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        decision: data.get("decision"),
        deciders: list("deciders"),
        participants: list("participants"),
        tags: list("tags"),
        mtimeMs: record.mtimeMs,
        sections: {
          Context: data.get("Context"),
          Rationale: data.get("Rationale"),
          Alternatives: data.get("Alternatives"),
          Consequences: data.get("Consequences"),
        },
      }),
    });
    if (saved.warned) document.querySelector("#warn").textContent = "The decision sentence changed on a decided record. A substantive change should supersede it.";
    if (saved.confluence) {
      const yes = window.confirm("Publish to Confluence?");
      if (yes) await api(`/api/records/${id}/publish`, { method: "POST", body: "{}" });
    }
    location.hash = `#record/${id}`;
  });
}

async function route() {
  const [kind, id] = location.hash.replace("#", "").split("/");
  try {
    if (kind === "record" && id) await showRecord(id);
    else if (kind === "edit" && id) await showEditor(id);
    else await showList();
  } catch (error) {
    main.innerHTML = `<p class="warn">${escape(error.message)}</p>`;
  }
}

function showAll() {
  if (location.hash) location.hash = "";
  void showList();
}

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  showAll();
});
queryInput.addEventListener("search", () => {
  if (!queryInput.value) statusFilter.value = "";
  showAll();
});
statusFilter.addEventListener("change", () => showAll());
document.querySelector("#home").addEventListener("click", () => {
  queryInput.value = "";
  statusFilter.value = "";
  showAll();
});
window.addEventListener("hashchange", () => void route());
void route();
