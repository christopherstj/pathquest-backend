import argparse
import json
import math
import sys
from typing import Any, Dict, Iterable, Optional

import numpy as np
import rasterio
from pyproj import Transformer


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2.0) ** 2
    return 2.0 * r * math.asin(math.sqrt(a))


def deg_window_from_radius(lat: float, radius_m: float) -> (float, float):
    # Approx conversions; good enough for <= few km windows.
    deg_lat = radius_m / 111320.0
    deg_lon = radius_m / (111320.0 * max(0.1, math.cos(math.radians(lat))))
    return deg_lat, deg_lon


def iter_jsonl(f) -> Iterable[Dict[str, Any]]:
    for line in f:
        line = line.strip()
        if not line:
            continue
        yield json.loads(line)


def snap_one(
    ds: rasterio.io.DatasetReader,
    lon: float,
    lat: float,
    radius_m: float,
    to_wgs84: Optional[Transformer],
    from_wgs84: Optional[Transformer],
) -> Optional[Dict[str, Any]]:
    if ds.crs is None:
        raise RuntimeError("DEM dataset has no CRS")

    if ds.crs.is_geographic:
        deg_lat, deg_lon = deg_window_from_radius(lat, radius_m)
        min_lon = lon - deg_lon
        max_lon = lon + deg_lon
        min_lat = lat - deg_lat
        max_lat = lat + deg_lat
        row_min, col_min = ds.index(min_lon, max_lat)  # top-left
        row_max, col_max = ds.index(max_lon, min_lat)  # bottom-right
    else:
        if from_wgs84 is None:
            raise RuntimeError("Missing from_wgs84 transformer for projected dataset")
        x, y = from_wgs84.transform(lon, lat)
        min_x = x - radius_m
        max_x = x + radius_m
        min_y = y - radius_m
        max_y = y + radius_m
        row_min, col_min = ds.index(min_x, max_y)  # top-left
        row_max, col_max = ds.index(max_x, min_y)  # bottom-right

    # Normalize window bounds
    row0 = max(0, min(row_min, row_max))
    row1 = min(ds.height - 1, max(row_min, row_max))
    col0 = max(0, min(col_min, col_max))
    col1 = min(ds.width - 1, max(col_min, col_max))

    if row1 <= row0 or col1 <= col0:
        return None

    window = rasterio.windows.Window.from_slices((row0, row1 + 1), (col0, col1 + 1))
    arr = ds.read(1, window=window, masked=True)
    if arr.size == 0:
        return None

    if np.ma.is_masked(arr):
        if arr.mask.all():
            return None

    # Find max elevation value
    max_val = float(arr.max())
    # Find first occurrence of max
    flat_idx = int(arr.argmax())
    r_off, c_off = np.unravel_index(flat_idx, arr.shape)
    r = int(row0 + r_off)
    c = int(col0 + c_off)

    x, y = ds.xy(r, c)
    if ds.crs.is_geographic:
        snapped_lon = float(x)
        snapped_lat = float(y)
    else:
        if to_wgs84 is None:
            raise RuntimeError("Missing to_wgs84 transformer for projected dataset")
        snapped_lon, snapped_lat = to_wgs84.transform(x, y)
        snapped_lon = float(snapped_lon)
        snapped_lat = float(snapped_lat)

    dist_m = haversine_m(lat, lon, snapped_lat, snapped_lon)

    return {
        "snapped_lat": snapped_lat,
        "snapped_lon": snapped_lon,
        "elevation_m": max_val,
        "snapped_distance_m": dist_m,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", required=True, help="Path to DEM GeoTIFF/COG or VRT")
    parser.add_argument("--default-radius-m", type=float, default=250.0)
    args = parser.parse_args()

    with rasterio.open(args.dem) as ds:
        to_wgs84 = None
        from_wgs84 = None

        if ds.crs is not None and not ds.crs.is_geographic:
            to_wgs84 = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True)
            from_wgs84 = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True)

        for rec in iter_jsonl(sys.stdin):
            try:
                peak_id = rec.get("peak_id")
                lat = float(rec["lat"])
                lon = float(rec["lon"])
                radius_m = float(rec.get("radius_m", args.default_radius_m))

                out = snap_one(ds, lon=lon, lat=lat, radius_m=radius_m, to_wgs84=to_wgs84, from_wgs84=from_wgs84)
                if out is None:
                    sys.stdout.write(json.dumps({"peak_id": peak_id, "error": "no_data"}) + "\n")
                    continue

                out["peak_id"] = peak_id
                sys.stdout.write(json.dumps(out) + "\n")
            except Exception as e:
                sys.stdout.write(json.dumps({"peak_id": rec.get("peak_id"), "error": str(e)}) + "\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


