#!/usr/bin/env bash
# Local map of Israel for extensions 1 and 3 (19.11): every named place and
# every synagogue, pharmacy, shop, beach... from OpenStreetMap, kept on this
# server and refreshed weekly. The public map servers (Overpass) were busy or
# refused this server; a local copy answers "the nearest X to Y" every time.
set -eu
D=/var/lib/yemot-data/osm
mkdir -p $D
command -v osmium >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq osmium-tool; }
curl -fsSL --retry 3 -o $D/israel.pbf.new https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf
mv -f $D/israel.pbf.new $D/israel.pbf
osmium tags-filter --overwrite -o $D/pois.pbf $D/israel.pbf \
  nwr/name nwr/amenity nwr/shop nwr/leisure nwr/tourism nwr/natural=beach n/highway=bus_stop nwr/railway=station
osmium export --overwrite -f geojsonseq -o $D/pois.geojsonseq --geometry-types=point,linestring,polygon \
  -x print_record_separator=false $D/pois.pbf
node /opt/yemot/main/deploy/vps/osm-build.mjs $D/pois.geojsonseq $D
rm -f $D/pois.pbf $D/pois.geojsonseq
logger -t yemot-osm "local map built: $(ls $D/tiles | wc -l) tiles"
