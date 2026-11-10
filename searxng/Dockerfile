# Free meta-search engine for extension 3 (owner, 10.11.2026).
# One query is sent to many public search engines at once and the results
# are merged; the main server reads them as JSON.
FROM searxng/searxng:latest
COPY settings.yml /etc/searxng/settings.yml
ENV SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
