FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv chromium xvfb ffmpeg ca-certificates git tini && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/audio-env
ENV PATH="/opt/audio-env/bin:${PATH}"
RUN pip install --no-cache-dir yt-dlp==2026.10.26 yt-dlp-ejs==0.8.0
WORKDIR /opt/experiment
COPY experiments/branch2-native-source/ /opt/experiment/
# Fixed reviewed revision. Build downloads source; it does not run the extension.
RUN git clone https://github.com/tsoolgee/youtube-premium.git /opt/youtube-premium && cd /opt/youtube-premium && git checkout 0302bbd0d1e9b65df4c99baa086eea6ca45834ed
RUN useradd --create-home experiment && mkdir /data && chown experiment:experiment /data
USER experiment
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "unittest", "discover", "-s", "/opt/experiment", "-v"]
