import argparse
import json
import math
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple

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


def deg_window_from_radius(lat: float, radius_m: float) -> Tuple[float, float]:
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


def snap_one_top_k(
    ds: rasterio.io.DatasetReader,
    lon: float,
    lat: float,
    radius_m: float,
    top_k: int,
    min_separation_m: float,
    to_wgs84: Optional[Transformer],
    from_wgs84: Optional[Transformer],
) -> List[Dict[str, Any]]:
    """
    Find the top K highest points within radius_m of (lat, lon), 
    where each candidate is at least min_separation_m away from all higher candidates.
    Returns a list of candidates sorted by elevation (highest first).
    """
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
        return []

    window = rasterio.windows.Window.from_slices((row0, row1 + 1), (col0, col1 + 1))
    arr = ds.read(1, window=window, masked=True)
    if arr.size == 0:
        return []

    if np.ma.is_masked(arr):
        if arr.mask.all():
            return []

    # Get all valid cell values with their indices
    if np.ma.is_masked(arr):
        valid_mask = ~arr.mask
    else:
        valid_mask = np.ones(arr.shape, dtype=bool)
    
    # Flatten and get sorted indices by elevation (descending)
    flat_arr = arr.ravel()
    flat_valid = valid_mask.ravel()
    
    # Get indices of valid cells sorted by elevation descending
    valid_indices = np.where(flat_valid)[0]
    if len(valid_indices) == 0:
        return []
    
    sorted_order = np.argsort(-flat_arr[valid_indices])  # descending
    sorted_indices = valid_indices[sorted_order]
    
    candidates: List[Dict[str, Any]] = []
    
    for flat_idx in sorted_indices:
        if len(candidates) >= top_k:
            break
            
        r_off, c_off = np.unravel_index(flat_idx, arr.shape)
        r = int(row0 + r_off)
        c = int(col0 + c_off)
        
        x, y = ds.xy(r, c)
        if ds.crs.is_geographic:
            cand_lon = float(x)
            cand_lat = float(y)
        else:
            if to_wgs84 is None:
                raise RuntimeError("Missing to_wgs84 transformer for projected dataset")
            cand_lon, cand_lat = to_wgs84.transform(x, y)
            cand_lon = float(cand_lon)
            cand_lat = float(cand_lat)
        
        elev = float(flat_arr[flat_idx])
        dist_from_seed = haversine_m(lat, lon, cand_lat, cand_lon)
        
        # Check if this candidate is far enough from all existing candidates
        too_close = False
        for existing in candidates:
            sep = haversine_m(cand_lat, cand_lon, existing["snapped_lat"], existing["snapped_lon"])
            if sep < min_separation_m:
                too_close = True
                break
        
        if not too_close:
            candidates.append({
                "snapped_lat": cand_lat,
                "snapped_lon": cand_lon,
                "elevation_m": elev,
                "snapped_distance_m": dist_from_seed,
            })
    
    return candidates


# Legacy single-result function for backwards compatibility
def snap_one(
    ds: rasterio.io.DatasetReader,
    lon: float,
    lat: float,
    radius_m: float,
    to_wgs84: Optional[Transformer],
    from_wgs84: Optional[Transformer],
) -> Optional[Dict[str, Any]]:
    candidates = snap_one_top_k(ds, lon, lat, radius_m, 1, 0.0, to_wgs84, from_wgs84)
    return candidates[0] if candidates else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", required=True, help="Path to DEM GeoTIFF/COG or VRT")
    parser.add_argument("--default-radius-m", type=float, default=250.0)
    parser.add_argument("--default-top-k", type=int, default=1, help="Number of candidates to return per peak")
    parser.add_argument("--default-min-separation-m", type=float, default=30.0, help="Min distance between candidates")
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
                top_k = int(rec.get("top_k", args.default_top_k))
                min_separation_m = float(rec.get("min_separation_m", args.default_min_separation_m))

                candidates = snap_one_top_k(
                    ds, lon=lon, lat=lat, radius_m=radius_m,
                    top_k=top_k, min_separation_m=min_separation_m,
                    to_wgs84=to_wgs84, from_wgs84=from_wgs84
                )
                
                if not candidates:
                    sys.stdout.write(json.dumps({"peak_id": peak_id, "error": "no_data"}) + "\n")
                    continue

                # Return all candidates in a list
                out = {
                    "peak_id": peak_id,
                    "candidates": candidates,
                }
                sys.stdout.write(json.dumps(out) + "\n")
            except Exception as e:
                sys.stdout.write(json.dumps({"peak_id": rec.get("peak_id"), "error": str(e)}) + "\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
