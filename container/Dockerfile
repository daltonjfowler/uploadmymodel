# uploadmymodel slicer: CuraEngine from the official Cura LulzBot Edition 4.13.2 AppImage (the
# version the school uses), Cura's own 4.13.2 resource files from the same AppImage, and the
# resolver in engine/ that does Cura's setting formulas. See docs/ENGINE_OPTIONS.md.
#
# Build from the repo root:  docker build -f container/Dockerfile -t uploadmymodel-slicer .
# Run locally:               docker run --rm -p 8090:8080 uploadmymodel-slicer
#
# CuraEngine is AGPLv3 and is used unmodified; its source is at
# https://gitlab.com/lulzbot3d/cura-le/cura-engine-le . The resource files are LGPLv3.

# ---- Stage 1: take CuraEngine and the resources out of the AppImage ---------------------------
FROM debian:bookworm-slim AS appimage
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG APPIMAGE_URL=https://software.lulzbot.com/Cura_LulzBot_Edition/Linux/4.13.2/Cura_LulzBot_Edition-4.13.2.AppImage
# sha256 of the file as downloaded on 2026-09-26 (193,339,368 bytes, dated 2023-12-15).
ARG APPIMAGE_SHA256=5bd642079462d8ef5b8e23c4e769da0a92b99288ed19b554e94fd05305a4856b
WORKDIR /tmp
RUN curl -fsSL -o cura.AppImage "$APPIMAGE_URL" \
    && echo "$APPIMAGE_SHA256  cura.AppImage" | sha256sum -c - \
    && chmod +x cura.AppImage && ./cura.AppImage --appimage-extract > /dev/null \
    && R=squashfs-root/usr/bin \
    && mkdir -p /out/bin /out/resources/quality \
    && cp $R/CuraEngine $R/libgomp.so.1 /out/bin/ \
    && cp -r $R/resources/definitions $R/resources/extruders $R/resources/gcodes $R/resources/materials /out/resources/ \
    && (cp -r $R/resources/intent $R/resources/variants /out/resources/ 2>/dev/null || true) \
    && cp -r $R/resources/quality/taz_workhorse /out/resources/quality/ \
    && test -x /out/bin/CuraEngine && test -f /out/resources/definitions/fdmprinter.def.json \
    && chmod -R a+rX /out \
    && rm -rf squashfs-root cura.AppImage

# ---- Stage 2: the slicer service ----------------------------------------------------------------
FROM python:3.12-slim-bookworm
COPY --from=appimage /out/bin /opt/curaengine
COPY --from=appimage /out/resources /opt/cura/resources
# OMP_NUM_THREADS=1: the container has 1 vCPU, but the engine sees the host's cores and starts a
# thread per core, which fight over it. Benchy with tree supports: 16.0 s instead of 17.3 s, same G-code.
ENV LD_LIBRARY_PATH=/opt/curaengine \
    CURA_ENGINE=/opt/curaengine/CuraEngine \
    CURA_RESOURCES=/opt/cura/resources \
    RES_OVERLAY= \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1
# The engine must answer, or the image is broken.
RUN /opt/curaengine/CuraEngine help 2>&1 | grep -q "Cura_SteamEngine version 4.13.2"
WORKDIR /app
COPY engine/resolve.py engine/run.py engine/test_resolve.py /app/engine/
COPY engine/reference /app/engine/reference
COPY container/server.py container/pause.py container/arm_values.json /app/
# The AppImage's own 4.13.2 files must resolve to exactly the checked reference, or stop here.
RUN python /app/engine/test_resolve.py
# A non-root user for the service (the AppImage's folders were root-only; made readable above).
RUN useradd --system --no-create-home slicer
USER slicer
EXPOSE 8080
CMD ["python", "/app/server.py"]
