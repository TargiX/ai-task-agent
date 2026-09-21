/* Website traffic only. No identities, form values, recordings or custom events. */
(() => {
  "use strict";
  const site = {"id": "d8639c04-1589-4193-8b7d-b66704a94cf2", "name": "AI Task Agent", "hosts": ["ai-task-agent-sepia.vercel.app"], "paths": ["/"]};
  if (!site.hosts.includes(location.hostname) || navigator.doNotTrack === "1" ||
      navigator.doNotTrack === "yes" || navigator.globalPrivacyControl === true ||
      document.getElementById("site-traffic")) return;
  // Fail closed: authentication/recovery links do not load third-party code.
  if (/[?&#](?:token|code|reset-password|access_token|id_token|email)=?/i.test(location.search + location.hash)) return;
  window.siteTrafficBeforeSend = (type, payload) => {
    if (type !== "event" || !payload || payload.name || navigator.doNotTrack === "1" ||
        navigator.globalPrivacyControl === true) return null;
    if (/[?&#](?:token|code|reset-password|access_token|id_token|email)=?/i.test(location.search + location.hash)) return null;
    let path = "/other";
    let referrer = "";
    try {
      const url = new URL(payload.url || location.href, location.origin);
      if (url.origin !== location.origin) return null;
      if (/[?&#](?:token|code|reset-password|access_token|id_token|email)=?/i.test(url.search + url.hash)) return null;
      path = site.paths.includes(url.pathname) ? url.pathname : "/other";
    } catch { return null; }
    try {
      const ref = new URL(payload.referrer);
      if (["https:", "http:"].includes(ref.protocol) && ref.hostname !== location.hostname) referrer = ref.origin;
    } catch { /* Internal and malformed referrers are omitted. */ }
    return {
      website: site.id,
      hostname: location.hostname,
      url: path,
      title: site.name,
      referrer,
      language: navigator.language,
      screen: `${screen.width}x${screen.height}`,
    };
  };
  const script = document.createElement("script");
  script.id = "site-traffic";
  script.defer = true;
  script.src = "https://stats.phosphene.cc/script.js";
  script.referrerPolicy = "no-referrer";
  const options = {
    "website-id": site.id,
    "domains": site.hosts.join(","),
    "before-send": "siteTrafficBeforeSend",
    "exclude-search": "true",
    "exclude-hash": "true",
    "do-not-track": "true",
    "performance": "false",
  };
  for (const [key, value] of Object.entries(options)) script.setAttribute(`data-${key}`, value);
  document.head.appendChild(script);
})();
