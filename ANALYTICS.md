# Website traffic

Uses the shared Websites PostHog project (572099). Set `VITE_POSTHOG_KEY` to its public ingestion token in the Vercel production environment.

Only `ai-task-agent-sepia.vercel.app` collects pageviews and page leaves. Preview/local hosts and Do Not Track visitors are excluded. Events carry `app_id=ai-task-agent` and `environment=production`; anonymous IDs and persistence are site-specific. No session replay, autocapture, form values, wallet IDs, or chat content are collected. URL queries and fragments are removed; standard campaign attribution remains available.

To disable, remove the production token and redeploy. Existing PostHog history is unaffected.
