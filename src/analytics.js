// Page traffic only: no forms, clicks, recordings, or user identification.
const appId = 'ai-task-agent';
const hosts = ['ai-task-agent-sepia.vercel.app'];
async function startAnalytics() {
  if (typeof window === "undefined" || !hosts.includes(window.location.hostname) || navigator.doNotTrack === "1") return;
  const key = import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return;
  let distinctID = `${appId}:${crypto.randomUUID()}`;
  try {
    const storageKey = `${appId}:analytics-id`;
    distinctID = localStorage.getItem(storageKey) || distinctID;
    localStorage.setItem(storageKey, distinctID);
  } catch { /* Storage can be unavailable in private browsing. */ }
  const { default: posthog } = await import("posthog-js");
  posthog.init(key, {
    api_host: "https://us.i.posthog.com",
    ui_host: "https://us.posthog.com",
    persistence_name: `${appId}_analytics`,
    cross_subdomain_cookie: false,
    bootstrap: { distinctID, isIdentifiedID: false },
    person_profiles: "never",
    autocapture: false,
    capture_pageview: "history_change",
    capture_pageleave: true,
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    enable_heatmaps: false,
    before_send: (event) => {
      if (!event || !["$pageview", "$pageleave"].includes(event.event)) return null;
      event.properties.app_id = appId;
      event.properties.environment = "production";
      // Keep campaign properties, but omit arbitrary URL query/hash values.
      for (const property of ["$current_url", "$referrer", "$initial_current_url", "$initial_referrer"]) {
        const value = event.properties[property];
        if (typeof value === "string") {
          try { const url = new URL(value); url.search = ""; url.hash = ""; event.properties[property] = url.href; } catch { event.properties[property] = ""; }
        }
      }
      return event;
    },
  });
}
void startAnalytics().catch(() => { console.warn("Website analytics could not initialize."); });
