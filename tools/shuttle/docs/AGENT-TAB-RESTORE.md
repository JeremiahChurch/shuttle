# Restoring agent tabs after restart

Agent tab restore needs a separate persistence path. Reusing Chromium's restore
unchanged can reopen a lane's page in the person's storage. No restore behavior
is changed by this design.

The current lifetime rules explain why an agent identity and its cookies can
survive while its tabs disappear:

- `chrome/browser/shuttle/profile_registry.cc` persists identities and configures
  fixed storage partitions. It does not persist sessions or tabs.
- `chrome/browser/shuttle/session_manager.cc` keeps sessions and group ownership
  in memory. `Close` discards every tab in the session, including idle cleanup.
- `chrome/browser/shuttle/session_cdp_filter.cc` closes a connection's
  `Target.createTarget` tabs when that connection ends. A restart normally ends
  the agent client's connection before the browser exits.
- `chrome/browser/ui/browser_tabrestore.cc` creates restored WebContents with
  `CreateParams(browser->GetProfile())`, not an agent's fixed partition.
  `chrome/browser/sessions/session_restore.cc` restores groups visually, but
  does not recreate Shuttle's session leases or its group-to-agent mapping.

Changing the startup preference to restore the last session does not repair
these missing ownership and partition links. A saved group name is display
text, not a stable agent ID.

## Proposed implementation

- Store each persistent agent's open tab URLs, titles, ordering and stable tab
  IDs in its registry entry. Keep a bounded snapshot, such as 200 tabs per
  agent and 2,000 per profile. Do not store form bodies, credentials, DevTools
  session IDs or throwaway-agent tabs.
- Update the snapshot after a committed main-frame navigation, insertion,
  reorder and explicit close. Debounce writes. Distinguish a browser shutdown
  or transport loss from an explicit user close, session close or idle expiry.
  Snapshot before shutdown starts closing windows. Avoid writing an empty
  snapshot as shutdown destroys tabs.
- Keep connection-owned tab cleanup for normal disconnects. Before cleanup,
  mark eligible persistent tabs as resumable. Explicit close and release
  remove the saved entry, so a later restart cannot resurrect completed work.
  Define a reconnect operation that claims the dormant tabs without duplicating
  them. Do not restore live CDP connections or assume their old IDs remain valid.
- At startup, read only current registry entries after pending deletions have
  been processed. Deleting an agent removes its saved tabs atomically with its
  identity. A newly created agent with the same name must not inherit the old
  entry. Throwaway agents remain absent after restart.
- Create each restored tab through the agent partition factory, attach a new
  session lease and group mapping before navigation, and apply extension
  policy from the current agent settings. Never navigate a default-profile
  placeholder to an agent URL.
- Restore dormant navigation entries with no renderer process. Load a tab on
  selection or when a client claims it. Keep the home tab selected on startup.
  The identity keeper must configure the target before its first request.
- Exclude these tabs from Chromium's ordinary session restore, or teach both
  paths to recognize the stable agent/tab IDs. This prevents duplicate tabs
  and prevents a second copy loading in the person's storage. Normal user tab
  restore should retain its current behavior.

## Size and required proof

Estimate: 350 to 600 production lines across 8 to 12 files, plus 200 to 350 lines
of restart tests. The lifetime decision about disconnected CDP tabs is part of
the feature, not just a serialization field. This exceeds the small repair
appropriate for a combined extension and new-tab change.

Use a disposable profile and local HTTP server to verify a clean restart and
an abrupt exit. Cover MCP-allocated tabs, connection-created tabs, popups,
multiple windows, reorder, explicit release and close, idle expiry, deletion
and recreation of an agent ID, and throwaway agents. Keep different cookies in
two agents and the person's tab; verify the first restored request sends the
right cookies and browser identity. Verify no restored dormant tab contacts the
server before selection or a client claim. Verify no duplicates when ordinary
Chromium restore is also enabled. Repeat the existing connection-lifetime and
hidden-tab passkey tests.
