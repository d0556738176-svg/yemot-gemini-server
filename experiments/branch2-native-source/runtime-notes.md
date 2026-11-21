# Isolated runtime prerequisites

Install requirements.txt plus yt-dlp-ejs==0.8.0; provide Node.js, FFmpeg and ffprobe on PATH. No model API keys required.

In a network with an installed inspection CA, set SSL_CERT_FILE to the system CA bundle containing that trusted CA. The prototype then uses no-certifi compatibility mode to honor configured trust; it never disables TLS verification. Do not download or trust arbitrary CA files.

Real trial: video jNQXAC9IVRw. Initial attempt failed with CERTIFICATE_VERIFY_FAILED. System trust bundle resolved that stage; metadata extraction and Node JS challenge processing succeeded. Metadata alone is not proof of downloaded audio. Yemot upload is still unverified; this local runtime has no YEMOT_POC_TOKEN configured. Production Render secrets were not read or copied.
