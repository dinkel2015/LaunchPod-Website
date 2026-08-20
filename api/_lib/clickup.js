/* =====================================================================
   ClickUp provisioning

   Creates the client's delivery folder in ClickUp after a successful
   checkout and stores the resulting URL on the subscription.

   TWO CLICKUP API LIMITS SHAPE THIS FILE — both verified against the
   current public API, both flagged in the handoff notes:

   1. There is no "duplicate this folder" endpoint. The public API can
      only create a folder from a *saved Folder Template*
      (POST /v2/space/{space_id}/folder_template/{template_id}, where the
      id is `t-`-prefixed and comes from GET /v2/team/{team_id}/folder_template).
      "Client Template Folder" (901318206130) is a plain folder, not a
      saved template, so it cannot be used as a duplication source as-is.
      Set CLICKUP_FOLDER_TEMPLATE_ID once it has been saved as a template
      in the ClickUp UI; until then this falls back to building the
      folder and lists explicitly, which also lets us create only the
      lists a given package path actually needs — matching how the real
      client folders (Doba, SubBase, Crucial Learning) are laid out.

   2. Dashboards are not exposed by the public API at all — they cannot
      be created, duplicated, or queried. So `clickup_dashboard_url` is
      populated with the client's FOLDER url, which is shareable with a
      guest and is the closest equivalent available. A real Dashboard,
      if one is wanted, has to be created once in the UI per client and
      pasted in, or replaced by a shared Folder/List view.
   ===================================================================== */

import { requireEnv } from "./http.js";

const CLICKUP_API = "https://api.clickup.com/api/v2";

const LISTS_BY_PATH = {
  launch:   ["Onboarding", "Podcast"],
  postcast: ["Onboarding", "PostCast"],
  webicast: ["Onboarding", "WebiCast"],
  audit:    ["8-Point Audit"],
};

/* Pods that have a recognizable list of their own in existing client
   folders. Social/Production/Boost have no established list convention,
   so they are intentionally not provisioned here. */
const POD_LISTS = { web: "SEO Optimization" };

async function clickup(path, options = {}) {
  const res = await fetch(`${CLICKUP_API}${path}`, {
    ...options,
    headers: {
      Authorization: requireEnv("CLICKUP_API_TOKEN"),
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`ClickUp ${options.method || "GET"} ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* Creates the client's delivery folder and records it on the
   subscription. Idempotent: a subscription that already carries a
   clickup_folder_id is returned untouched, so a retry after a partial
   failure never leaves a second folder behind. */
export async function provisionClient(db, subscriptionId) {
  const { data: sub, error: subErr } = await db
    .from("subscriptions")
    .select("id, path, selection, clickup_folder_id, clients(company, name, email)")
    .eq("id", subscriptionId)
    .single();
  if (subErr) throw subErr;

  if (sub.clickup_folder_id) {
    return { alreadyProvisioned: true, folderId: sub.clickup_folder_id };
  }

  const spaceId = requireEnv("CLICKUP_DELIVERY_SPACE_ID");
  const clientName = sub.clients?.company || sub.clients?.name || `Client ${sub.id.slice(0, 8)}`;

  let folder;
  const templateId = process.env.CLICKUP_FOLDER_TEMPLATE_ID;

  if (templateId) {
    // Preferred path: "Client Template Folder" saved as a Folder Template
    // in ClickUp. Brings the whole structure across in one call.
    const created = await clickup(`/space/${spaceId}/folder_template/${templateId}`, {
      method: "POST",
      body: JSON.stringify({
        name: clientName,
        options: {
          /* Defaults to true, which returns a folder id before the nested
             lists and tasks exist — we would then hand the client a link
             to an empty folder. Wait for the structure to be built. */
          return_immediately: false,
          include_views: true,
          content: true,
          subtasks: true,
          old_statuses: true,
          automation: true,
          /* Template tasks carry the dates and assignees of whoever built
             the template; those are meaningless on a new client and would
             show up as overdue on day one. */
          old_due_date: false,
          old_start_date: false,
          old_assignees: false,
          old_followers: false,
        },
      }),
    });
    // The response carries both a top-level `id` and a `folder` object.
    folder = created.folder ?? created;
  } else {
    // Fallback: build the folder and only the lists this path needs.
    folder = await clickup(`/space/${spaceId}/folder`, {
      method: "POST",
      body: JSON.stringify({ name: clientName }),
    });

    const listNames = [...(LISTS_BY_PATH[sub.path] ?? ["Onboarding"])];
    for (const [pod, listName] of Object.entries(POD_LISTS)) {
      if (sub.selection?.pods?.[pod]?.enabled) listNames.push(listName);
    }

    for (const listName of listNames) {
      await clickup(`/folder/${folder.id}/list`, {
        method: "POST",
        body: JSON.stringify({ name: `${clientName}: ${listName}` }),
      });
    }
  }

  // See note (2) above: this is a Folder url, not a Dashboard url.
  const folderUrl = `https://app.clickup.com/${requireEnv("CLICKUP_TEAM_ID")}/v/f/${folder.id}`;

  const { error: updateErr } = await db
    .from("subscriptions")
    .update({ clickup_folder_id: String(folder.id), clickup_dashboard_url: folderUrl })
    .eq("id", sub.id);
  if (updateErr) throw updateErr;

  return { folderId: folder.id, folderUrl, usedTemplate: Boolean(templateId) };
}
