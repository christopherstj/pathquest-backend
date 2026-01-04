import argparse
import json
import math
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import rasterio
from pyproj import Transformer
from scipy.ndimage import maximum_filter, gaussian_filter


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


def find_local_maxima_scipy(
    arr: np.ndarray,
    valid_mask: np.ndarray,
    neighborhood_size: int = 5,
    gaussian_sigma: float = 0.0,
) -> np.ndarray:
    """
    Find local maxima using scipy's maximum_filter.
    
    Args:
        arr: 2D elevation array
        valid_mask: Boolean mask of valid (non-nodata) cells
        neighborhood_size: Size of neighborhood for local max detection (5 = 5x5)
        gaussian_sigma: If > 0, apply Gaussian smoothing first to reduce noise
    
    Returns:
        Boolean mask where True = local maximum
    """
    # Work with a copy to avoid modifying original
    work_arr = arr.copy()
    
    # Handle masked arrays
    if np.ma.is_masked(work_arr):
        work_arr = work_arr.filled(np.nan)
    
    # Replace invalid cells with -inf so they can't be maxima
    work_arr[~valid_mask] = -np.inf
    
    # Optional Gaussian smoothing to reduce noise
    if gaussian_sigma > 0:
        # Only smooth valid areas - preserve edges
        smoothed = gaussian_filter(np.where(valid_mask, work_arr, 0), sigma=gaussian_sigma)
        # Normalize by the smoothed mask to handle edges properly
        mask_smoothed = gaussian_filter(valid_mask.astype(float), sigma=gaussian_sigma)
        mask_smoothed = np.maximum(mask_smoothed, 1e-10)  # Avoid division by zero
        work_arr = np.where(valid_mask, smoothed / mask_smoothed, -np.inf)
    
    # Find local maxima using scipy's maximum_filter
    # A cell is a local max if it equals the maximum in its neighborhood
    local_max_vals = maximum_filter(work_arr, size=neighborhood_size, mode='constant', cval=-np.inf)
    
    # Local maxima are cells that equal the neighborhood maximum AND are valid
    is_local_max = (work_arr == local_max_vals) & valid_mask & (work_arr > -np.inf)
    
    return is_local_max


def snap_one_top_k(
    ds: rasterio.io.DatasetReader,
    lon: float,
    lat: float,
    radius_m: float,
    top_k: int,
    min_separation_m: float,
    to_wgs84: Optional[Transformer],
    from_wgs84: Optional[Transformer],
    require_local_max: bool = True,
    neighborhood_size: int = 5,
    gaussian_sigma: float = 0.0,
    prefer_nearest: bool = True,
) -> List[Dict[str, Any]]:
    """
    Find the top K highest points within radius_m of (lat, lon), 
    where each candidate is at least min_separation_m away from all higher candidates.
    
    Uses scipy's maximum_filter for robust local maximum detection.
    
    Args:
        ds: Rasterio dataset
        lon, lat: Seed coordinates
        radius_m: Search radius in meters
        top_k: Number of candidates to return
        min_separation_m: Minimum distance between candidates
        to_wgs84, from_wgs84: Coordinate transformers
        require_local_max: If True, only consider local maxima
        neighborhood_size: Size of neighborhood for local max (e.g., 5 = 5x5 window)
        gaussian_sigma: Gaussian smoothing sigma (0 = no smoothing)
        prefer_nearest: If True, among candidates with similar elevation, prefer nearest to seed
        
    Returns:
        List of candidate dicts sorted by elevation (highest first), then by distance if prefer_nearest
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

    # Build valid mask
    if np.ma.is_masked(arr):
        valid_mask = ~arr.mask
    else:
        valid_mask = np.ones(arr.shape, dtype=bool)
    
    # Find local maxima using scipy
    if require_local_max:
        local_max_mask = find_local_maxima_scipy(arr, valid_mask, neighborhood_size, gaussian_sigma)
        candidate_mask = local_max_mask
    else:
        candidate_mask = valid_mask
    
    # Get candidate indices
    candidate_indices = np.where(candidate_mask)
    if len(candidate_indices[0]) == 0:
        return []
    
    # Get elevations and distances for all candidates
    candidates_data = []
    for r_off, c_off in zip(candidate_indices[0], candidate_indices[1]):
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
        
        elev = float(arr[r_off, c_off])
        dist_from_seed = haversine_m(lat, lon, cand_lat, cand_lon)
        
        candidates_data.append({
            "snapped_lat": cand_lat,
            "snapped_lon": cand_lon,
            "elevation_m": elev,
            "snapped_distance_m": dist_from_seed,
        })
    
    # Sort candidates:
    # Primary: elevation descending
    # Secondary (if prefer_nearest): distance ascending (for candidates within 2m elevation)
    if prefer_nearest:
        # Group by elevation bins (within 2m = same bin), then sort by distance within bin
        def sort_key(c):
            # Negative elevation for descending, distance for ascending within similar elevations
            elev_bin = -int(c["elevation_m"] / 2.0)  # 2m bins
            return (elev_bin, c["snapped_distance_m"])
        candidates_data.sort(key=sort_key)
    else:
        candidates_data.sort(key=lambda c: -c["elevation_m"])
    
    # Select top K with minimum separation
    selected: List[Dict[str, Any]] = []
    
    for cand in candidates_data:
        if len(selected) >= top_k:
            break
        
        # Check separation from already selected candidates
        too_close = False
        for existing in selected:
            sep = haversine_m(cand["snapped_lat"], cand["snapped_lon"], 
                            existing["snapped_lat"], existing["snapped_lon"])
            if sep < min_separation_m:
                too_close = True
                break
        
        if not too_close:
            selected.append(cand)
    
    return selected


# Legacy single-result function for backwards compatibility
def snap_one(
    ds: rasterio.io.DatasetReader,
    lon: float,
    lat: float,
    radius_m: float,
    to_wgs84: Optional[Transformer],
    from_wgs84: Optional[Transformer],
    require_local_max: bool = True,
) -> Optional[Dict[str, Any]]:
    candidates = snap_one_top_k(ds, lon, lat, radius_m, 1, 0.0, to_wgs84, from_wgs84, require_local_max)
    return candidates[0] if candidates else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dem", required=True, help="Path to DEM GeoTIFF/COG or VRT")
    parser.add_argument("--default-radius-m", type=float, default=250.0)
    parser.add_argument("--default-top-k", type=int, default=1, help="Number of candidates to return per peak")
    parser.add_argument("--default-min-separation-m", type=float, default=30.0, help="Min distance between candidates")
    parser.add_argument("--no-require-local-max", action="store_true", help="Disable local maximum requirement")
    parser.add_argument("--neighborhood-size", type=int, default=5, help="Neighborhood size for local max (e.g., 5 = 5x5)")
    parser.add_argument("--gaussian-sigma", type=float, default=1.0, help="Gaussian smoothing sigma (0 = disabled)")
    parser.add_argument("--no-prefer-nearest", action="store_true", help="Disable preferring nearest candidate among similar elevations")
    args = parser.parse_args()
    
    default_require_local_max = not args.no_require_local_max
    default_prefer_nearest = not args.no_prefer_nearest

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
                require_local_max = rec.get("require_local_max", default_require_local_max)
                neighborhood_size = int(rec.get("neighborhood_size", args.neighborhood_size))
                gaussian_sigma = float(rec.get("gaussian_sigma", args.gaussian_sigma))
                prefer_nearest = rec.get("prefer_nearest", default_prefer_nearest)

                candidates = snap_one_top_k(
                    ds, lon=lon, lat=lat, radius_m=radius_m,
                    top_k=top_k, min_separation_m=min_separation_m,
                    to_wgs84=to_wgs84, from_wgs84=from_wgs84,
                    require_local_max=require_local_max,
                    neighborhood_size=neighborhood_size,
                    gaussian_sigma=gaussian_sigma,
                    prefer_nearest=prefer_nearest,
                )
                
                if not candidates:
                    sys.stdout.write(json.dumps({"peak_id": peak_id, "error": "no_local_max"}) + "\n")
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
