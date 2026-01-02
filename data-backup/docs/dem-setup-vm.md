## 3DEP / LiDAR DEM setup on a us-central VM (for snap-to-highest)

This project’s snap-to-highest workflow assumes you run the bulk raster sampling **on a VM in us-central** (close to Cloud SQL) and keep the DEM tiles **as local files** on that VM for fast reads.

### Prereqs on the VM
- **GDAL** (for `gdalbuildvrt`)
- **Python 3.11+**
- **Python deps**: `rasterio`, `numpy`, `pyproj`

### DEM data source
- Baseline (recommended): **USGS 3DEP 1/3 arc-second (~10m)** for Colorado.
- Highest-quality (selective): **LiDAR-derived DEM (often 1m / 3m)** where available.
  - This can be dramatically more accurate for summit placement *when the LiDAR DEM actually exists for the area*.
  - It also massively increases data size; consider using it only for priority regions or peak lists.

### Local tiles vs remote files
- **Local tiles (recommended)**: fastest + simplest (random access reads are cheap, no HTTP/egress, no throttling).
- **Remote COGs** (possible, not recommended initially): GDAL/Rasterio can read Cloud-Optimized GeoTIFFs over HTTP using range requests, but performance and reliability can vary and you’ll pay latency/egress. If we go this route later, we’ll likely still add a local cache layer.

### Suggested directory layout (VM)
- `~/pathquest/pathquest-backend/data-backup/` (repo clone)
- `~/dem/3dep_co/tiles/` (GeoTIFF/COG tiles)
- `~/dem/3dep_co/co_3dep.vrt` (VRT mosaic)

### Build a VRT mosaic
From your DEM tiles directory:

```bash
gdalbuildvrt -resolution highest ~/dem/3dep_co/co_3dep.vrt *.tif
```

### Environment variables used by snapping scripts
- `DEM_VRT_PATH`: absolute path to the VRT (e.g. `~/dem/3dep_co/co_3dep.vrt`)
- `PYTHON_BIN`: python executable (default `python3`)

### Notes
- You can start with **Colorado-only tiles** to keep this small and fast.
- The snapping scripts are designed to be **batchable and restartable** (process N peaks at a time).


